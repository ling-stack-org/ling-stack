import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewProjection,
} from "@ling-stack/contracts";
import { isTerminalComputerUseStatus } from "@ling-stack/contracts";
import type {
  ComputerUseHostLayout,
  ComputerUsePipCorner,
  ComputerUsePipRendererSnapshot,
  ComputerUsePreviewLocale,
  ComputerUsePreviewReleaseMediaAck,
  ComputerUsePreviewSummary,
  ComputerUsePreviewPreferences,
  DesktopDisplayWorkArea,
  DesktopCommandResult,
  DesktopRect,
} from "../../shared/desktop-capabilities.js";
import { DEFAULT_COMPUTER_USE_PREVIEW_LOCALE } from "../../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { DesktopPreferenceStore, DesktopPreferences } from "../preferences.js";
import {
  chooseComputerUsePreviewBounds,
  createComputerUsePreviewCornerCandidates,
  encodeComputerUsePipNormalizedPlacement,
  generateComputerUsePreviewPlacementCandidates,
  restoreComputerUsePipNormalizedPlacement,
} from "./layout.js";
import type { ComputerUsePreviewPlatformAdapter } from "./platform-adapter.js";
import type {
  ComputerUseProjectionClient,
  ComputerUseProjectionConnectionState,
  ComputerUseProjectionSubscription,
} from "./projection-client.js";
import { ComputerUseRecoveryTimers } from "./recovery-timers.js";
import {
  compareLatestComputerUseProjection,
  type ComputerUsePipPresentationDecision,
  isSessionSuppressed,
  selectComputerUsePresentation,
  selectComputerUsePipPresentation,
} from "./selectors.js";
import {
  buildRendererSnapshot,
  ComputerUsePreviewSourceSession,
  runtimeStatusDetail,
} from "./source-session.js";
import {
  NOOP_COMPUTER_USE_PREVIEW_TELEMETRY,
  type ComputerUsePreviewTelemetry,
} from "./telemetry.js";
import type {
  ComputerUsePreviewRendererGoneDetails,
  ComputerUsePreviewWindow,
  ComputerUsePreviewWindowFactory,
} from "./window.js";

const HIDDEN_SUPPRESSION_MS = 24 * 60 * 60 * 1_000;
const PREFERENCES_NOT_PERSISTED_REASON = "desktop_preferences_not_persisted";
const PREVIEW_PLACEMENT_SNAP_DEBOUNCE_MS = 180;
const DEFAULT_PREVIEW_ASPECT_RATIO = 1.6;

interface ComputerUsePresentationLease {
  readonly window?: ComputerUsePreviewWindow;
  readonly sessionId: string;
  readonly descriptorId?: string;
  readonly revision?: number;
  readonly sourceGeneration?: number;
}

export interface ComputerUsePreviewCoordinatorOptions {
  readonly projectionClient: ComputerUseProjectionClient;
  readonly platformAdapter: ComputerUsePreviewPlatformAdapter;
  readonly preferenceStore: DesktopPreferenceStore;
  readonly previewIndexPath: string;
  readonly createWindow: ComputerUsePreviewWindowFactory;
  readonly getDisplays: () => readonly DesktopDisplayWorkArea[];
  readonly getDisplayMatching: (bounds?: DesktopRect) => DesktopDisplayWorkArea;
  readonly onDisplaysChanged?: (listener: () => void) => () => void;
  readonly openOwnerConversation?: (conversationId: string) => Promise<void> | void;
  readonly telemetry?: ComputerUsePreviewTelemetry;
  readonly now?: () => Date;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ComputerUsePreviewCoordinator {
  private readonly projections = new Map<string, ComputerUsePreviewProjection>();
  private readonly explicitShownSessions = new Set<string>();
  private readonly summaryListeners = new Set<(summary: ComputerUsePreviewSummary | undefined) => void>();
  private readonly rendererSendFailureWindows = new WeakSet<ComputerUsePreviewWindow>();
  private readonly sourceSession = new ComputerUsePreviewSourceSession();
  private readonly recoveryTimers: ComputerUseRecoveryTimers;
  private readonly telemetry: ComputerUsePreviewTelemetry;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private preferences: DesktopPreferences = {
    schemaVersion: 1,
    previewAutoShow: true,
    hiddenSessionSuppressions: {},
  };
  private rendererLocale: ComputerUsePreviewLocale = DEFAULT_COMPUTER_USE_PREVIEW_LOCALE;
  private selectedConversationId: string | undefined;
  private hostLayout: ComputerUseHostLayout | undefined;
  private subscription: ComputerUseProjectionSubscription | undefined;
  private projectionConnected = false;
  private window: ComputerUsePreviewWindow | undefined;
  private loadedRendererWindow: ComputerUsePreviewWindow | undefined;
  private currentProjection: ComputerUsePreviewProjection | undefined;
  private boundWindowCloseListener: ComputerUsePreviewWindow | undefined;
  private boundWindowCloseCallback: (() => void) | undefined;
  private boundWindowLayoutListener: ComputerUsePreviewWindow | undefined;
  private boundWindowMoveCallback: (() => void) | undefined;
  private boundWindowResizeCallback: (() => void) | undefined;
  private rendererGoneSubscription: {
    readonly window: ComputerUsePreviewWindow;
    readonly unsubscribe: () => void;
  } | undefined;
  private readonly internallyClosingWindows = new WeakSet<object>();
  private readonly rendererCrashRecoveryAttemptedSessions = new Set<string>();
  private readonly rendererCrashAutoReopenBlockedSessions = new Set<string>();
  private readonly rendererCrashCounts = new Map<string, number>();
  private readonly rendererRecreationCounts = new Map<string, number>();
  private readonly stallTimeoutBlocks = new Map<string, {
    readonly descriptorId: string;
    readonly revision: number;
  }>();
  private sourceAttemptStartedAtMs: number | undefined;
  private stallStartedAtMs: number | undefined;
  private readonly interactionState = { hover: false, focus: false };
  private displayChangeUnsubscribe: (() => void) | undefined;
  private activePlacementDisplayId: string | undefined;
  private activePlacementPreferenceKey: string | undefined;
  private programmaticBoundsGuard: { readonly bounds: DesktopRect; remainingEvents: number } | undefined;
  private lastPersistedBoundsKey: string | undefined;
  private placementSnapTimer: ReturnType<typeof setTimeout> | undefined;
  private appliedWindowAspectRatio: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private disposing = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: ComputerUsePreviewCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.telemetry = options.telemetry ?? NOOP_COMPUTER_USE_PREVIEW_TELEMETRY;
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.recoveryTimers = new ComputerUseRecoveryTimers({
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
  }

  private get snapshot(): ComputerUsePipRendererSnapshot | undefined {
    return this.sourceSession.snapshot;
  }

  private set snapshot(value: ComputerUsePipRendererSnapshot | undefined) {
    this.sourceSession.snapshot = value;
  }

  private get frameReady(): boolean {
    return this.sourceSession.frameReady;
  }

  private set frameReady(value: boolean) {
    this.sourceSession.frameReady = value;
  }

  async start(): Promise<void> {
    if (this.isQuiescing()) {
      return;
    }
    this.preferences = await this.options.preferenceStore.load();
    if (this.isQuiescing()) {
      return;
    }
    const displayChangeUnsubscribe = this.options.onDisplaysChanged?.(
      () => this.reportDisplayTopologyChanged(),
    );
    if (this.isQuiescing()) {
      displayChangeUnsubscribe?.();
      return;
    }
    this.displayChangeUnsubscribe = displayChangeUnsubscribe;
    const projections = await this.options.projectionClient.list();
    if (this.isQuiescing()) {
      return;
    }
    for (const projection of projections) {
      this.projections.set(projection.sessionId, projection);
      if (isTerminalComputerUseStatus(projection.status)) {
        await this.clearSessionLocalState(projection.sessionId);
        if (this.isQuiescing()) {
          return;
        }
      }
    }
    if (this.isQuiescing()) {
      return;
    }
    this.projectionConnected = true;
    const subscription = this.options.projectionClient.subscribe(
      (event) => this.handleProjectionEvent(event),
      (state) => this.handleProjectionConnectionState(state),
    );
    if (this.isQuiescing()) {
      this.projectionConnected = false;
      try {
        subscription.close();
      } catch {
        // Disposal is best-effort and must not let a late subscription escape.
      }
      return;
    }
    this.subscription = subscription;
    await this.enqueueReconcile();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposing = true;
      this.projectionConnected = false;
      this.disposePromise = this.disposeInternal();
    }
    return this.disposePromise;
  }

  reportLocale(locale: ComputerUsePreviewLocale): void {
    if (this.isQuiescing() || locale === this.rendererLocale) {
      return;
    }
    this.rendererLocale = locale;
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, locale };
      this.sendSnapshot();
    }
  }

  reportSelectedConversation(conversationId?: string): void {
    if (this.isQuiescing()) {
      return;
    }
    this.selectedConversationId = conversationId;
    void this.enqueueReconcile();
  }

  reportHostLayout(layout: ComputerUseHostLayout): void {
    if (this.isQuiescing()) {
      return;
    }
    this.hostLayout = layout;
    if (this.window && !this.window.isDestroyed() && !this.activePlacementDisplayId) {
      const display = this.options.getDisplayMatching(this.window.getBounds());
      const bounds = this.previewBounds(this.snapshot?.aspectRatio ?? 1.6, display);
      this.setBoundsProgrammatically(bounds, true);
    }
  }

  reportDisplayTopologyChanged(): void {
    if (this.isQuiescing()) {
      return;
    }
    void this.enqueueDisplayTopologyReconcile();
  }

  onSummaryChanged(listener: (summary: ComputerUsePreviewSummary | undefined) => void): () => void {
    try {
      listener(this.currentSummary());
    } catch {
      return () => undefined;
    }
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  getSummary(): ComputerUsePreviewSummary | undefined {
    return this.currentSummary();
  }

  getPreferences(): ComputerUsePreviewPreferences {
    return { previewAutoShow: this.preferences.previewAutoShow };
  }

  async setAutoShow(enabled: boolean): Promise<DesktopCommandResult> {
    this.preferences = { ...this.preferences, previewAutoShow: enabled };
    await this.enqueueReconcile();
    return this.persistPreferencesAfterSafety();
  }

  sessionIdForDescriptor(descriptorId: string): string | undefined {
    return [...this.projections.values()].find((projection) => projection.preview?.descriptorId === descriptorId)?.sessionId;
  }

  ownsPreviewWebContents(webContentsId: number): boolean {
    return this.window?.webContents.id === webContentsId;
  }

  getPreviewWebContentsId(): number | undefined {
    return this.window?.webContents.id;
  }

  getRendererSnapshot(): ComputerUsePipRendererSnapshot | undefined {
    return this.snapshot;
  }

  reportMediaReleased(ack: ComputerUsePreviewReleaseMediaAck, webContentsId: number): boolean {
    return this.sourceSession.acknowledgeRendererMediaRelease(ack, webContentsId);
  }

  async hideCurrent(): Promise<DesktopCommandResult> {
    return this.currentProjection
      ? this.hide(this.currentProjection.sessionId)
      : { accepted: false, reason: "computer_use_session_not_found" };
  }

  async closeCurrent(): Promise<DesktopCommandResult> {
    return this.currentProjection
      ? this.close(this.currentProjection.sessionId)
      : { accepted: false, reason: "computer_use_session_not_found" };
  }

  async stopCurrent(): Promise<DesktopCommandResult> {
    return this.currentProjection
      ? this.stop(this.currentProjection.sessionId)
      : { accepted: false, reason: "computer_use_session_not_found" };
  }

  async show(sessionId: string): Promise<DesktopCommandResult> {
    const projection = this.projections.get(sessionId);
    if (!projection || isTerminalComputerUseStatus(projection.status)) {
      return { accepted: false, reason: "computer_use_session_not_active" };
    }
    if (projection.conversationId !== this.selectedConversationId) {
      return { accepted: false, reason: "computer_use_session_not_selected" };
    }
    if (!projection.preview) {
      return { accepted: false, reason: "computer_use_preview_unavailable" };
    }
    this.explicitShownSessions.add(sessionId);
    this.stallTimeoutBlocks.delete(sessionId);
    // A second renderer crash blocks only automatic reopening. An explicit
    // Show remains the user's escape hatch, but it does not reset the session's
    // one automatic recreation budget.
    this.rendererCrashAutoReopenBlockedSessions.delete(sessionId);
    const suppressions = { ...this.preferences.hiddenSessionSuppressions };
    delete suppressions[sessionId];
    this.preferences = { ...this.preferences, hiddenSessionSuppressions: suppressions };
    await this.enqueueReconcile();
    return this.persistPreferencesAfterSafety();
  }

  async hide(sessionId: string): Promise<DesktopCommandResult> {
    if (!this.projections.has(sessionId)) {
      return { accepted: false, reason: "computer_use_session_not_found" };
    }
    if (this.currentProjection?.sessionId === sessionId) {
      // Cancel a not-yet-fired retry before persisting the suppression. The
      // in-memory suppression below also invalidates callbacks that already
      // fired or are waiting inside an async permission/source prepare.
      this.clearReconnectTimer(true);
      this.clearPlacementSnapTimer();
    }
    this.suppressSessionInMemory(sessionId);
    let actionError: unknown;
    await this.enqueueOperation(async () => {
      if (this.currentProjection?.sessionId === sessionId) {
        this.recoveryTimers.clearSourceErrorTimer();
        this.resetInteractionState();
        await this.releaseMedia();
        this.window?.hide();
        this.frameReady = false;
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, frameReady: false, sourceStatus: "idle", visibilityIntent: "hidden" };
          this.sendSnapshot();
        }
        this.emitSummary();
        this.telemetry.record({ name: "preview_hidden", reason: "user" });
      }
    }).catch((error: unknown) => {
      actionError = error;
    });
    const persistence = await this.persistPreferencesAfterSafety();
    if (actionError !== undefined) {
      throw actionError;
    }
    return persistence;
  }

  async close(sessionId: string): Promise<DesktopCommandResult> {
    if (!this.projections.has(sessionId)) {
      return { accepted: false, reason: "computer_use_session_not_found" };
    }
    if (this.currentProjection?.sessionId === sessionId) {
      this.clearReconnectTimer(true);
    }
    this.suppressSessionInMemory(sessionId);
    let actionError: unknown;
    await this.enqueueOperation(async () => {
      if (this.currentProjection?.sessionId === sessionId) {
        this.telemetry.record({ name: "preview_closed", reason: "user" });
        await this.destroyWindow(false);
      }
    }).catch((error: unknown) => {
      actionError = error;
    });
    const persistence = await this.persistPreferencesAfterSafety();
    if (actionError !== undefined) {
      throw actionError;
    }
    return persistence;
  }

  async stop(sessionId: string): Promise<DesktopCommandResult> {
    const projection = this.projections.get(sessionId);
    if (!projection || isTerminalComputerUseStatus(projection.status)) {
      return { accepted: false, reason: "computer_use_session_not_active" };
    }
    if (!this.projectionConnected) {
      return { accepted: false, reason: "computer_use_projection_disconnected" };
    }
    this.telemetry.record({ name: "preview_stop_requested" });
    try {
      const result = await this.options.projectionClient.stop(sessionId, "desktop_operator_requested");
      const acknowledged = result.accepted && result.acknowledged;
      this.telemetry.record({ name: "preview_stop_acknowledged", accepted: acknowledged });
      this.projections.set(result.projection.sessionId, result.projection);
      await this.enqueueOperation(async () => {
        if (isTerminalComputerUseStatus(result.projection.status)) {
          await this.clearSessionLocalState(result.projection.sessionId);
        }
        await this.reconcile();
      });
      return {
        accepted: acknowledged,
        reason: acknowledged ? result.reason : result.reason ?? "computer_use_stop_not_acknowledged",
      };
    } catch (error) {
      this.telemetry.record({ name: "preview_stop_failed" });
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async openOwnerConversation(): Promise<void> {
    if (this.currentProjection) {
      await this.options.openOwnerConversation?.(this.currentProjection.conversationId);
    }
  }

  async openPermissionSettings(): Promise<void> {
    // The five-second permission/source-error linger applies only when the
    // user has not acted. Opening Settings is an explicit recovery action, so
    // keep the preview available instead of closing it behind the system UI.
    this.recoveryTimers.clearSourceErrorTimer();
    await this.options.platformAdapter.openPermissionSettings();
  }

  async retryCapture(): Promise<DesktopCommandResult> {
    const projection = this.currentProjection;
    if (!projection || isTerminalComputerUseStatus(projection.status)) {
      return { accepted: false, reason: "computer_use_session_not_active" };
    }
    this.recoveryTimers.clearSourceErrorTimer();
    this.clearReconnectTimer(true);
    this.stallTimeoutBlocks.delete(projection.sessionId);
    await this.releaseMedia();
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        sourceStatus: "idle",
        frameReady: false,
        statusDetail: undefined,
      };
      this.sendSnapshot();
    }
    await this.enqueueReconcile();
    return { accepted: true };
  }

  async resetPosition(): Promise<DesktopCommandResult> {
    if (!this.window || this.window.isDestroyed()) {
      return { accepted: false, reason: "computer_use_preview_not_open" };
    }
    this.clearPlacementSnapTimer();
    const display = this.options.getDisplayMatching(this.window.getBounds());
    const placements = { ...(this.preferences.previewDisplayPlacements ?? {}) };
    for (const key of new Set([this.activePlacementPreferenceKey, this.activePlacementDisplayId, display.id])) {
      if (key) {
        delete placements[key];
      }
    }
    this.preferences = {
      ...this.preferences,
      previewDisplayPlacements: Object.keys(placements).length > 0 ? placements : undefined,
      previewBounds: undefined,
    };
    await this.options.preferenceStore.save(this.preferences);
    this.activePlacementDisplayId = undefined;
    this.activePlacementPreferenceKey = undefined;
    this.lastPersistedBoundsKey = undefined;
    const bounds = this.previewBounds(this.snapshot?.aspectRatio ?? 1.6, display);
    this.setBoundsProgrammatically(bounds, true);
    return { accepted: true };
  }

  reportFrameReady(sessionId: string, revision: number, sourceGeneration: number): void {
    if (this.isQuiescing()) {
      return;
    }
    const projection = this.currentProjection;
    if (projection?.sessionId !== sessionId || !this.window || this.window.isDestroyed()) {
      return;
    }
    if (!this.sourceSession.matchesSourceIdentity(revision, sourceGeneration)) {
      return;
    }
    if (this.frameReady) {
      return;
    }
    const presentation = this.presentationDecisionFor(sessionId, "live", true);
    if (
      !this.isSourceIdentityCurrent(projection)
      || !presentation.sourceActivationAllowed
      || !presentation.shouldRevealOrRetainWindow
    ) {
      return;
    }
    const nowMs = this.now().getTime();
    const sourceAttemptStartedAtMs = this.sourceAttemptStartedAtMs;
    const stallStartedAtMs = this.stallStartedAtMs;
    this.frameReady = true;
    this.recoveryTimers.clearFirstFrameWatchdog();
    this.clearReconnectTimer(true);
    this.sourceAttemptStartedAtMs = undefined;
    this.stallStartedAtMs = undefined;
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        frameReady: true,
        sourceStatus: "live",
        statusDetail: runtimeStatusDetail(projection),
      };
      this.sendSnapshot();
    }
    this.presentWindowIfEligible();
    this.emitSummary();
    if (sourceAttemptStartedAtMs !== undefined) {
      this.telemetry.record({
        name: "preview_opened",
        firstFrameLatencyMs: nowMs - sourceAttemptStartedAtMs,
      });
    }
    if (stallStartedAtMs !== undefined) {
      this.telemetry.record({
        name: "preview_recovered",
        recoveryLatencyMs: nowMs - stallStartedAtMs,
      });
    }
  }

  reportFrameActivity(sessionId: string, revision: number, sourceGeneration: number): void {
    if (this.isQuiescing()) {
      return;
    }
    if (
      this.currentProjection?.sessionId !== sessionId ||
      !this.sourceSession.matchesSourceIdentity(revision, sourceGeneration) ||
      !this.frameReady ||
      this.snapshot?.sourceKind !== "display_media" ||
      this.snapshot.sourceStatus !== "live"
    ) {
      return;
    }
    this.restartFrameGapWatchdog(sessionId, revision, sourceGeneration);
  }

  reportInteraction(kind: "hover" | "focus", active: boolean): void {
    if (this.isQuiescing()) {
      return;
    }
    if (
      !this.window ||
      this.window.isDestroyed() ||
      !this.currentSummary()?.visible ||
      this.interactionState[kind] === active
    ) {
      return;
    }
    this.interactionState[kind] = active;
    this.recoveryTimers.setInteractionPaused(
      this.interactionState.hover || this.interactionState.focus,
    );
  }

  reportSourceEnded(
    sessionId: string,
    revision: number,
    sourceGeneration: number,
    reason: string,
  ): void {
    if (this.isQuiescing()) {
      return;
    }
    if (this.currentProjection?.sessionId !== sessionId || isTerminalComputerUseStatus(this.currentProjection.status)) {
      return;
    }
    if (!this.sourceSession.matchesSourceIdentity(revision, sourceGeneration)) {
      return;
    }
    if (this.snapshot?.sourceStatus === "idle" || this.snapshot?.sourceStatus === "failed" || this.snapshot?.sourceStatus === "permission_denied") {
      return;
    }
    void this.startReconnect(reason, sourceGeneration);
  }

  reportSourceFailure(
    sessionId: string,
    revision: number,
    sourceGeneration: number,
    reason: string,
  ): void {
    if (this.isQuiescing()) {
      return;
    }
    const projection = this.currentProjection;
    if (
      projection?.sessionId !== sessionId
      || isTerminalComputerUseStatus(projection.status)
      || !this.isSourceIdentityCurrent(projection)
    ) {
      return;
    }
    if (!this.sourceSession.matchesSourceIdentity(revision, sourceGeneration)) {
      return;
    }
    const presentation = this.presentationDecisionFor(sessionId, "failed", false);
    if (!presentation.sourceActivationAllowed || !presentation.shouldRevealOrRetainWindow) {
      return;
    }
    this.recoveryTimers.clearFrameGapWatchdog();
    this.recoveryTimers.clearFirstFrameWatchdog();
    this.clearReconnectTimer(true);
    this.sourceAttemptStartedAtMs = undefined;
    this.stallStartedAtMs = undefined;
    this.frameReady = false;
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        sourceStatus: "failed",
        frameReady: false,
        visibilityIntent: presentation.visibilityIntent,
        statusDetail: reason,
      };
      this.sendSnapshot();
    }
    void this.releaseMedia().catch(() => undefined);
    this.presentWindowIfEligible();
    this.startSourceErrorLinger();
    this.emitSummary();
  }

  private handleProjectionEvent(event: ComputerUsePreviewEvent): void {
    if (this.isQuiescing()) {
      return;
    }
    let clearSessionState = false;
    if (event.kind === "remove") {
      this.projections.delete(event.sessionId);
      clearSessionState = true;
    } else if (event.projection) {
      const current = this.projections.get(event.sessionId);
      if (!current || Date.parse(event.projection.updatedAt) >= Date.parse(current.updatedAt)) {
        this.projections.set(event.sessionId, event.projection);
        clearSessionState = isTerminalComputerUseStatus(event.projection.status);
      }
    }
    this.pruneRendererCrashRecoveryState();
    if (clearSessionState) {
      void this.enqueueOperation(async () => {
        await this.clearSessionLocalState(event.sessionId);
        await this.reconcile();
      });
      return;
    }
    void this.enqueueReconcile();
  }

  private handleProjectionConnectionState(state: ComputerUseProjectionConnectionState): void {
    const connected = state === "connected";
    if (this.isQuiescing() || this.projectionConnected === connected) {
      return;
    }
    this.projectionConnected = connected;
    void this.enqueueOperation(async () => {
      if (connected) {
        if (this.snapshot?.sourceStatus === "stalled") {
          this.snapshot = {
            ...this.snapshot,
            sourceStatus: "idle",
            statusDetail: undefined,
          };
          this.sendSnapshot();
        }
        await this.reconcile();
        return;
      }
      this.clearReconnectTimer(true);
      this.recoveryTimers.clearSourceErrorTimer();
      try {
        await this.releaseMedia();
      } catch {
        // The source session is invalidated before cleanup can fail, so stale
        // renderer/provider callbacks cannot retain capture authority.
      }
      this.frameReady = false;
      if (this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          sourceStatus: "stalled",
          frameReady: false,
          statusDetail: "Computer Use connection lost. Reconnecting.",
        };
        this.sendSnapshot();
      }
      this.emitSummary();
    });
  }

  private enqueueReconcile(): Promise<void> {
    return this.enqueueOperation(() => this.reconcile());
  }

  private enqueueDisplayTopologyReconcile(): Promise<void> {
    return this.enqueueOperation(() => this.reconcileDisplayTopology());
  }

  private enqueueRendererCrashRecovery(
    window: ComputerUsePreviewWindow,
    details: ComputerUsePreviewRendererGoneDetails,
  ): Promise<void> {
    return this.enqueueOperation(() => this.recoverRendererAfterCrash(window, details));
  }

  private enqueueOperation(operation: () => Promise<void>, allowWhileDisposing = false): Promise<void> {
    const guardedOperation = async (): Promise<void> => {
      if (this.isQuiescing() && !allowWhileDisposing) {
        return;
      }
      await operation();
    };
    this.queue = this.queue.then(guardedOperation, guardedOperation);
    return this.queue;
  }

  private async reconcileDisplayTopology(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const displays = this.options.getDisplays();
    if (displays.length === 0) {
      return;
    }
    const currentBounds = this.window.getBounds();
    const currentDisplay = this.options.getDisplayMatching(currentBounds);
    const savedKey = this.activePlacementPreferenceKey;
    const savedPlacement = savedKey ? this.preferences.previewDisplayPlacements?.[savedKey] : undefined;
    if (savedPlacement) {
      const restored = restoreComputerUsePipNormalizedPlacement({ placement: savedPlacement, displays });
      if (restored) {
        this.activePlacementDisplayId = restored.displayId;
        this.setBoundsProgrammatically(restored.bounds, true);
        return;
      }
    }
    if (this.activePlacementDisplayId) {
      this.activePlacementDisplayId = currentDisplay.id;
      const clamped = clampBoundsToDisplay(currentBounds, currentDisplay);
      this.setBoundsProgrammatically(clamped, true);
      return;
    }
    this.setBoundsProgrammatically(
      this.previewBounds(this.snapshot?.aspectRatio ?? 1.6, currentDisplay),
      true,
    );
  }

  private async reconcile(): Promise<void> {
    this.pruneRendererCrashRecoveryState();
    const selected = selectComputerUsePresentation({
      selectedConversationId: this.selectedConversationId,
      projections: [...this.projections.values()],
    });
    const currentLatest = this.currentProjection && this.projections.get(this.currentProjection.sessionId);
    if (currentLatest && isTerminalComputerUseStatus(currentLatest.status)) {
      const selectedPreemptsTerminal = Boolean(
        selected && compareLatestComputerUseProjection(selected, currentLatest) < 0,
      );
      if (currentLatest.conversationId === this.selectedConversationId && !selectedPreemptsTerminal) {
        this.currentProjection = currentLatest;
        this.updateRuntimeSnapshot(currentLatest);
        this.startTerminalLinger(currentLatest);
        return;
      }
      this.telemetry.record({
        name: "preview_closed",
        reason: currentLatest.conversationId === this.selectedConversationId ? "session_switch" : "route_change",
      });
      await this.destroyWindow(false);
    }
    if (!selected?.preview) {
      if (this.window || this.snapshot) {
        this.telemetry.record({ name: "preview_closed", reason: "route_change" });
      }
      await this.destroyWindow(false);
      if (selected) {
        this.currentProjection = selected;
        this.emitSummary();
      }
      return;
    }
    const sameSession = this.currentProjection?.sessionId === selected.sessionId;
    const previousDescriptorId = this.currentProjection?.preview?.descriptorId;
    const previousRevision = this.currentProjection?.preview?.revision;
    const previousProjectionAspectRatio = this.currentProjection?.preview?.aspectRatio;
    const descriptorChanged = sameSession && (
      previousDescriptorId !== selected.preview.descriptorId
      || previousRevision !== selected.preview.revision
    );
    const projectionAspectRatioChanged = sameSession
      && normalizeSourceAspectRatio(previousProjectionAspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO)
        !== normalizeSourceAspectRatio(selected.preview.aspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO);
    if (!sameSession) {
      if (this.window || this.snapshot) {
        this.telemetry.record({ name: "preview_closed", reason: "session_switch" });
      }
      await this.destroyWindow(false);
      this.currentProjection = selected;
    } else {
      this.currentProjection = selected;
      this.updateRuntimeSnapshot(selected);
      if (projectionAspectRatioChanged) {
        const aspectRatio = normalizeSourceAspectRatio(
          selected.preview.aspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO,
        );
        this.applyWindowAspectRatio(aspectRatio);
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, aspectRatio };
          this.sendSnapshot();
        }
      }
      if (descriptorChanged) {
        this.stallTimeoutBlocks.delete(selected.sessionId);
        this.clearReconnectTimer(true);
        this.recoveryTimers.clearSourceErrorTimer();
        await this.releaseMedia();
        this.sourceSession.resetForRevision(selected.preview.revision);
        if (this.snapshot) {
          this.sendSnapshot();
        }
      }
    }

    const presentation = this.presentationDecisionFor(selected.sessionId);
    if (!presentation.sourceActivationAllowed) {
      if (presentation.blockReason === "auto_show_disabled") {
        await this.releaseHiddenSourceForDisabledAutoShow();
      }
      this.emitSummary();
      return;
    }
    if (descriptorChanged || !this.window || this.window.isDestroyed() || this.snapshot?.sourceStatus === "idle") {
      await this.openPreview(selected);
    }
  }

  private async openPreview(projection: ComputerUsePreviewProjection): Promise<void> {
    if (!this.projectionConnected || !projection.preview || !this.isSourceProjectionCurrent(projection)) {
      return;
    }
    const sourceGeneration = this.sourceSession.beginSourceActivation();
    this.sourceAttemptStartedAtMs = this.now().getTime();
    let permission: Awaited<ReturnType<ComputerUsePreviewPlatformAdapter["getPermissionState"]>>;
    try {
      permission = await this.options.platformAdapter.getPermissionState({
        descriptorId: projection.preview.descriptorId,
        revision: projection.preview.revision,
      });
    } catch {
      permission = "denied";
    }
    if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
      return;
    }
    if (!this.window) {
      const initialPlacement = this.initialPreviewPlacement(
        projection.preview.aspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO,
      );
      this.activePlacementDisplayId = initialPlacement.preferenceKey ? initialPlacement.displayId : undefined;
      this.activePlacementPreferenceKey = initialPlacement.preferenceKey;
      this.window = this.options.createWindow(initialPlacement.bounds);
      this.appliedWindowAspectRatio = undefined;
    }
    this.applyWindowAspectRatio(projection.preview.aspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO);
    if (this.boundWindowCloseListener !== this.window) {
      this.clearWindowEventBindings();
      const previewWindow = this.window;
      this.boundWindowCloseListener = previewWindow;
      const onClosed = (): void => {
        const shouldSuppress = !this.internallyClosingWindows.has(previewWindow);
        this.internallyClosingWindows.delete(previewWindow);
        this.sourceSession.reportRendererGone(previewWindow.webContents.id);
        this.clearLifecycleTimers();
        this.resetInteractionState();
        this.clearWindowEventBindings(previewWindow);
        this.clearRendererGoneSubscription(previewWindow);
        this.programmaticBoundsGuard = undefined;
        if (this.window === previewWindow) {
          this.window = undefined;
          this.appliedWindowAspectRatio = undefined;
        }
        this.frameReady = false;
        if (shouldSuppress && this.currentProjection) {
          this.suppressSessionInMemory(this.currentProjection.sessionId);
          void this.persistPreferencesAfterSafety();
        }
        if (shouldSuppress) {
          void this.options.platformAdapter.release();
          this.telemetry.record({ name: "preview_closed", reason: "window_close" });
        }
        this.emitSummary();
      };
      this.boundWindowCloseCallback = onClosed;
      previewWindow.on("closed", onClosed);
    }
    if (this.boundWindowLayoutListener !== this.window) {
      const previewWindow = this.window;
      this.boundWindowLayoutListener = previewWindow;
      const onMove = (): void => this.handleWindowLayoutChanged(previewWindow, "move");
      const onResize = (): void => this.handleWindowLayoutChanged(previewWindow, "resize");
      this.boundWindowMoveCallback = onMove;
      this.boundWindowResizeCallback = onResize;
      previewWindow.on("move", onMove);
      previewWindow.on("resize", onResize);
    }
    if (this.rendererGoneSubscription?.window !== this.window) {
      this.clearRendererGoneSubscription();
      const previewWindow = this.window;
      this.rendererGoneSubscription = {
        window: previewWindow,
        unsubscribe: previewWindow.onRendererProcessGone((details) => {
          // A release command can be waiting inside the serialized coordinator
          // queue. Settle it synchronously so crash recovery is not forced to
          // wait for the 500 ms privacy deadline behind that same queue.
          this.sourceSession.reportRendererGone(previewWindow.webContents.id);
          void this.enqueueRendererCrashRecovery(previewWindow, details);
        }),
      };
    }
    if (permission !== "granted") {
      this.sourceAttemptStartedAtMs = undefined;
      this.telemetry.record({ name: "preview_permission_denied" });
      this.snapshot = buildRendererSnapshot(projection, {
        sourceKind: "display_media",
        sourceStatus: "permission_denied",
        sourceGeneration,
        visibilityIntent: this.visibilityIntentFor(projection.sessionId),
        frameReady: false,
      }, this.rendererLocale);
      await this.ensureRendererLoaded(this.window);
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        return;
      }
      this.sendSnapshot();
      this.presentWindowIfEligible();
      this.startSourceErrorLinger();
      this.emitSummary();
      return;
    }
    if (this.loadedRendererWindow !== this.window) {
      this.frameReady = false;
      this.snapshot = buildRendererSnapshot(projection, {
        sourceKind: "display_media",
        sourceStatus: "idle",
        sourceGeneration,
        visibilityIntent: this.visibilityIntentFor(projection.sessionId),
        frameReady: false,
        aspectRatio: normalizeSourceAspectRatio(
          projection.preview.aspectRatio ?? DEFAULT_PREVIEW_ASPECT_RATIO,
        ),
      }, this.rendererLocale);
      await this.ensureRendererLoaded(this.window);
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        return;
      }
      this.sendSnapshot();
    }
    try {
      const prepared = await this.options.platformAdapter.prepare({
        sessionId: projection.sessionId,
        descriptorId: projection.preview.descriptorId,
        revision: projection.preview.revision,
        requesterWebContentsId: this.window.webContents.id,
        maxFrameRate: 30,
        maxSize: { width: 960, height: 600 },
      });
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        await this.options.platformAdapter.release().catch(() => undefined);
        return;
      }
      this.frameReady = false;
      const aspectRatio = normalizeSourceAspectRatio(
        prepared.aspectRatio
          ?? projection.preview.aspectRatio
          ?? DEFAULT_PREVIEW_ASPECT_RATIO,
      );
      this.applyWindowAspectRatio(aspectRatio);
      this.snapshot = buildRendererSnapshot(projection, {
        sourceKind: prepared.sourceKind,
        sourceStatus: "connecting",
        sourceGeneration,
        visibilityIntent: this.visibilityIntentFor(projection.sessionId),
        frameReady: false,
        aspectRatio,
      }, this.rendererLocale);
      await this.ensureRendererLoaded(this.window);
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        await this.options.platformAdapter.release().catch(() => undefined);
        return;
      }
      this.sendSnapshot();
      this.emitSummary();
      if (prepared.sourceKind === "display_media") {
        this.restartFirstFrameWatchdog(
          projection.sessionId,
          projection.preview.revision,
          sourceGeneration,
        );
      }
    } catch (error) {
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        return;
      }
      this.sourceAttemptStartedAtMs = undefined;
      this.snapshot = buildRendererSnapshot(projection, {
        sourceKind: "display_media",
        sourceStatus: "failed",
        sourceGeneration,
        visibilityIntent: this.visibilityIntentFor(projection.sessionId),
        frameReady: false,
        statusDetail: error instanceof Error ? error.message : String(error),
      }, this.rendererLocale);
      await this.ensureRendererLoaded(this.window);
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        return;
      }
      this.sendSnapshot();
      this.presentWindowIfEligible();
      this.startSourceErrorLinger();
      this.emitSummary();
    }
  }

  private updateRuntimeSnapshot(projection: ComputerUsePreviewProjection): void {
    if (!this.snapshot) {
      return;
    }
    const statusDetail = this.snapshot.sourceStatus === "permission_denied"
      ? undefined
      : this.snapshot.sourceStatus === "failed"
        ? this.snapshot.statusDetail
        : runtimeStatusDetail(projection);
    this.snapshot = {
      ...this.snapshot,
      runtimeStatus: projection.status,
      visibilityIntent: this.visibilityIntentFor(projection.sessionId),
      statusDetail,
      canStop: !isTerminalComputerUseStatus(projection.status) && projection.status !== "stopping",
    };
    this.sendSnapshot();
    this.emitSummary();
  }

  private startTerminalLinger(projection: ComputerUsePreviewProjection): void {
    // A terminal projection can arrive while a source reconnect or error linger
    // is pending. Cancel those callbacks before scheduling terminal close so a
    // stale retry cannot reopen media after the runtime has already ended.
    this.clearReconnectTimer(true);
    this.recoveryTimers.clearFrameGapWatchdog();
    this.recoveryTimers.clearSourceErrorTimer();
    const lease = this.capturePresentationLease() ?? this.captureProjectionLease(projection);
    this.recoveryTimers.startTerminalLinger(projection, () => {
      void this.enqueueOperation(async () => {
        if (!this.isPresentationLeaseCurrent(lease)) {
          return;
        }
        if (projection.status === "succeeded" || projection.status === "failed" || projection.status === "cancelled") {
          this.telemetry.record({ name: "preview_terminal_closed", status: projection.status });
        }
        try {
          await this.destroyWindow(false);
        } catch {
          // Window and source state are cleared before destroyWindow rethrows.
        }
        await this.reconcile();
      });
    });
  }

  private capturePresentationLease(): ComputerUsePresentationLease | undefined {
    const window = this.window;
    const projection = this.currentProjection;
    const preview = projection?.preview;
    const snapshot = this.snapshot;
    if (
      !window ||
      window.isDestroyed() ||
      !projection ||
      !preview ||
      !snapshot ||
      snapshot.sessionId !== projection.sessionId ||
      snapshot.sourceRevision !== preview.revision
    ) {
      return undefined;
    }
    return {
      window,
      sessionId: projection.sessionId,
      descriptorId: preview.descriptorId,
      revision: preview.revision,
      sourceGeneration: snapshot.sourceGeneration,
    };
  }

  private captureProjectionLease(
    projection: ComputerUsePreviewProjection,
  ): ComputerUsePresentationLease {
    const snapshot = this.snapshot;
    const preview = projection.preview;
    const snapshotMatchesProjection = Boolean(
      snapshot &&
      preview &&
      snapshot.sessionId === projection.sessionId &&
      snapshot.sourceRevision === preview.revision,
    );
    return {
      ...(this.window && !this.window.isDestroyed() ? { window: this.window } : {}),
      sessionId: projection.sessionId,
      ...(preview ? { descriptorId: preview.descriptorId, revision: preview.revision } : {}),
      ...(snapshotMatchesProjection && snapshot ? { sourceGeneration: snapshot.sourceGeneration } : {}),
    };
  }

  private isPresentationLeaseCurrent(lease: ComputerUsePresentationLease): boolean {
    const projection = this.currentProjection;
    const preview = projection?.preview;
    const snapshot = this.snapshot;
    const windowMatches = lease.window
      ? this.window === lease.window && !lease.window.isDestroyed()
      : this.window === undefined;
    const snapshotMatches = lease.sourceGeneration === undefined
      ? snapshot === undefined
      : snapshot?.sessionId === lease.sessionId &&
        snapshot.sourceRevision === lease.revision &&
        snapshot.sourceGeneration === lease.sourceGeneration;
    return windowMatches &&
      projection?.sessionId === lease.sessionId &&
      preview?.descriptorId === lease.descriptorId &&
      preview?.revision === lease.revision &&
      snapshotMatches;
  }

  private async startReconnect(reason: string, sourceGeneration: number): Promise<void> {
    const projection = this.currentProjection;
    if (
      !projection?.preview ||
      !this.isSourceActivationCurrent(projection, sourceGeneration)
    ) {
      return;
    }
    this.recoveryTimers.clearFirstFrameWatchdog();
    this.recoveryTimers.clearFrameGapWatchdog();
    if (this.stallStartedAtMs === undefined) {
      this.stallStartedAtMs = this.now().getTime();
      this.telemetry.record({ name: "preview_source_stalled" });
    }
    this.frameReady = false;
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        sourceGeneration,
        sourceStatus: "stalled",
        frameReady: false,
        statusDetail: undefined,
      };
      this.sendSnapshot();
    }
    this.presentWindowIfEligible();
    const scheduleResult = this.recoveryTimers.scheduleReconnect({
      onRetry: () => {
        void this.enqueueOperation(() => this.retryCurrentSource(projection, sourceGeneration, reason));
      },
      onTimeout: () => {
        void this.enqueueOperation(() => this.timeoutReconnect(projection));
      },
    });
    if (scheduleResult !== "timed_out") {
      return;
    }
    await this.timeoutReconnect(projection);
  }

  private async timeoutReconnect(projection: ComputerUsePreviewProjection): Promise<void> {
    if (
      !projection.preview ||
      !this.isSourceProjectionCurrent(projection) ||
      this.frameReady ||
      (this.snapshot?.sourceStatus !== "stalled" && this.snapshot?.sourceStatus !== "connecting")
    ) {
      return;
    }
    this.stallTimeoutBlocks.set(projection.sessionId, {
      descriptorId: projection.preview.descriptorId,
      revision: projection.preview.revision,
    });
    await this.releaseMedia().catch(() => undefined);
    if (!this.isSourceIdentityCurrent(projection)) {
      return;
    }
    this.frameReady = false;
    this.sourceAttemptStartedAtMs = undefined;
    this.stallStartedAtMs = undefined;
    this.window?.hide();
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        sourceStatus: "idle",
        frameReady: false,
        statusDetail: undefined,
      };
      this.sendSnapshot();
    }
    this.emitSummary();
    this.telemetry.record({ name: "preview_hidden", reason: "stall_timeout" });
  }

  private async retryCurrentSource(
    projection: ComputerUsePreviewProjection,
    previousSourceGeneration: number,
    reason: string,
  ): Promise<void> {
    if (
      !projection?.preview ||
      !this.isSourceProjectionCurrent(projection) ||
      !this.sourceSession.matchesSourceIdentity(
        projection.preview.revision,
        previousSourceGeneration,
      )
    ) {
      return;
    }
    await this.releaseMedia();
    if (!this.isSourceProjectionCurrent(projection)) {
      return;
    }
    const sourceGeneration = this.sourceSession.beginSourceActivation();
    let permission: Awaited<ReturnType<ComputerUsePreviewPlatformAdapter["getPermissionState"]>>;
    try {
      permission = await this.options.platformAdapter.getPermissionState({
        descriptorId: projection.preview.descriptorId,
        revision: projection.preview.revision,
      });
    } catch {
      permission = "denied";
    }
    if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
      return;
    }
    if (permission !== "granted") {
      this.clearReconnectTimer(true);
      this.sourceAttemptStartedAtMs = undefined;
      this.stallStartedAtMs = undefined;
      this.telemetry.record({ name: "preview_permission_denied" });
      this.frameReady = false;
      if (this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          sourceGeneration,
          sourceStatus: "permission_denied",
          frameReady: false,
          statusDetail: undefined,
          canOpenSettings: true,
        };
        this.sendSnapshot();
      }
      this.presentWindowIfEligible();
      this.startSourceErrorLinger();
      this.emitSummary();
      return;
    }
    try {
      const requesterWebContentsId = this.window?.webContents.id;
      if (requesterWebContentsId === undefined) {
        return;
      }
      const prepared = await this.options.platformAdapter.prepare({
        sessionId: projection.sessionId,
        descriptorId: projection.preview.descriptorId,
        revision: projection.preview.revision,
        requesterWebContentsId,
        maxFrameRate: 30,
        maxSize: { width: 960, height: 600 },
      });
      if (!this.isSourceActivationCurrent(projection, sourceGeneration)) {
        await this.options.platformAdapter.release().catch(() => undefined);
        return;
      }
      if (this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          sourceKind: prepared.sourceKind,
          sourceRevision: projection.preview.revision,
          sourceGeneration,
          sourceStatus: "connecting",
          frameReady: false,
          statusDetail: undefined,
        };
        this.sendSnapshot();
        if (prepared.sourceKind === "display_media") {
          this.restartFirstFrameWatchdog(
            projection.sessionId,
            projection.preview.revision,
            sourceGeneration,
          );
        }
      }
    } catch {
      if (this.isSourceActivationCurrent(projection, sourceGeneration)) {
        await this.startReconnect(reason, sourceGeneration);
      }
    }
  }

  private isSourceActivationCurrent(
    projection: ComputerUsePreviewProjection,
    sourceGeneration: number,
  ): boolean {
    return Boolean(projection.preview) &&
      this.isSourceProjectionCurrent(projection) &&
      this.sourceSession.isSourceGenerationActive(sourceGeneration);
  }

  private isSourceProjectionCurrent(projection: ComputerUsePreviewProjection): boolean {
    return this.projectionConnected
      && this.isSourceIdentityCurrent(projection)
      && this.presentationDecisionFor(projection.sessionId).sourceActivationAllowed;
  }

  private isSourceIdentityCurrent(projection: ComputerUsePreviewProjection): boolean {
    if (this.isQuiescing()) {
      return false;
    }
    const preview = projection.preview;
    const currentPreview = this.currentProjection?.preview;
    const latest = this.projections.get(projection.sessionId);
    const latestPreview = latest?.preview;
    if (!preview || !currentPreview || !latest || !latestPreview || isTerminalComputerUseStatus(latest.status)) {
      return false;
    }
    if (
      this.currentProjection?.sessionId !== projection.sessionId ||
      currentPreview.descriptorId !== preview.descriptorId ||
      currentPreview.revision !== preview.revision ||
      latestPreview.descriptorId !== preview.descriptorId ||
      latestPreview.revision !== preview.revision ||
      latest.conversationId !== this.selectedConversationId
    ) {
      return false;
    }
    return true;
  }

  private suppressSessionInMemory(sessionId: string): void {
    this.explicitShownSessions.delete(sessionId);
    this.preferences = {
      ...this.preferences,
      hiddenSessionSuppressions: {
        ...this.preferences.hiddenSessionSuppressions,
        [sessionId]: new Date(this.now().getTime() + HIDDEN_SUPPRESSION_MS).toISOString(),
      },
    };
  }

  private async persistPreferencesAfterSafety(): Promise<DesktopCommandResult> {
    try {
      await this.options.preferenceStore.save(this.preferences);
      return { accepted: true };
    } catch {
      return { accepted: true, reason: PREFERENCES_NOT_PERSISTED_REASON };
    }
  }

  private visibilityIntentFor(
    sessionId: string,
  ): ComputerUsePipRendererSnapshot["visibilityIntent"] {
    return this.presentationDecisionFor(sessionId).visibilityIntent;
  }

  private presentationDecisionFor(
    sessionId: string,
    sourceStatus = this.snapshot?.sourceStatus ?? "idle",
    frameReady = this.snapshot?.frameReady ?? false,
    windowVisible = Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()),
  ): ComputerUsePipPresentationDecision {
    const projection = this.projections.get(sessionId);
    return selectComputerUsePipPresentation({
      sessionSuppressed: isSessionSuppressed(
        this.preferences.hiddenSessionSuppressions,
        sessionId,
        this.now(),
      ),
      explicitlyShown: this.explicitShownSessions.has(sessionId),
      previewAutoShow: this.preferences.previewAutoShow,
      windowVisible,
      stallTimeoutBlocked: this.isStallTimeoutBlocked(projection),
      rendererCrashBlocked: this.rendererCrashAutoReopenBlockedSessions.has(sessionId),
      sourceStatus,
      frameReady,
    });
  }

  private async clearSessionLocalState(sessionId: string): Promise<void> {
    this.explicitShownSessions.delete(sessionId);
    this.stallTimeoutBlocks.delete(sessionId);
    this.rendererCrashRecoveryAttemptedSessions.delete(sessionId);
    this.rendererCrashAutoReopenBlockedSessions.delete(sessionId);
    this.rendererCrashCounts.delete(sessionId);
    this.rendererRecreationCounts.delete(sessionId);

    if (!(sessionId in this.preferences.hiddenSessionSuppressions)) {
      return;
    }
    const suppressions = { ...this.preferences.hiddenSessionSuppressions };
    delete suppressions[sessionId];
    this.preferences = { ...this.preferences, hiddenSessionSuppressions: suppressions };
    try {
      await this.options.preferenceStore.save(this.preferences);
    } catch {
      // Terminal cleanup is best-effort. The in-memory state is already clear,
      // and the persisted fallback expires after 24 hours if disk I/O fails.
    }
  }

  private async recoverRendererAfterCrash(
    crashedWindow: ComputerUsePreviewWindow,
    _details: ComputerUsePreviewRendererGoneDetails,
  ): Promise<void> {
    if (this.window !== crashedWindow) {
      return;
    }
    const sessionId = this.currentProjection?.sessionId;
    // Evaluate eligibility against the post-crash state. A visible preview
    // does not imply that a replacement may auto-show when the global
    // preference is off; an explicit Show remains the only override.
    const eligible = sessionId ? this.isRendererCrashRecoveryEligible(sessionId, false) : false;
    if (sessionId) {
      const crashCount = (this.rendererCrashCounts.get(sessionId) ?? 0) + 1;
      this.rendererCrashCounts.set(sessionId, crashCount);
      this.telemetry.record({ name: "preview_renderer_crashed", crashCount });
      if (eligible) {
        if (this.rendererCrashRecoveryAttemptedSessions.has(sessionId)) {
          this.rendererCrashAutoReopenBlockedSessions.add(sessionId);
        } else {
          this.rendererCrashRecoveryAttemptedSessions.add(sessionId);
        }
      }
    }

    // releaseMedia() tolerates the dead webContents, then the old BrowserWindow
    // and its render-process-gone subscription are destroyed before any new
    // source is prepared.
    try {
      await this.destroyWindow(false, false);
    } catch {
      // destroyWindow force-clears the crashed BrowserWindow and source state
      // before surfacing adapter cleanup errors. Reconcile below is the
      // recovery path and must still run.
    }
    // Always restore the structured active-session summary after clearing the
    // crashed window. Suppression, auto-show, stall, and crash policy still
    // decide whether reconcile may recreate a preview source.
    try {
      await this.reconcile();
    } catch {
      const latest = sessionId ? this.projections.get(sessionId) : undefined;
      if (
        !this.currentProjection &&
        latest &&
        !isTerminalComputerUseStatus(latest.status) &&
        latest.conversationId === this.selectedConversationId
      ) {
        this.currentProjection = latest;
      }
    }
    const recreated = Boolean(
      eligible &&
      sessionId &&
      this.window &&
      this.window !== crashedWindow &&
      !this.window.isDestroyed() &&
      this.currentProjection?.sessionId === sessionId,
    );
    if (recreated && sessionId) {
      const recreationCount = (this.rendererRecreationCounts.get(sessionId) ?? 0) + 1;
      this.rendererRecreationCounts.set(sessionId, recreationCount);
      this.telemetry.record({ name: "preview_renderer_recreated", recreationCount });
    }
    this.emitSummary();
  }

  private isRendererCrashRecoveryEligible(sessionId: string, windowVisible = false): boolean {
    const projection = this.projections.get(sessionId);
    if (!projection?.preview || isTerminalComputerUseStatus(projection.status)) {
      return false;
    }
    const selected = selectComputerUsePresentation({
      selectedConversationId: this.selectedConversationId,
      projections: [...this.projections.values()],
    });
    if (selected?.sessionId !== sessionId) {
      return false;
    }
    return this.presentationDecisionFor(
      sessionId,
      this.snapshot?.sourceStatus ?? "idle",
      this.snapshot?.frameReady ?? false,
      windowVisible,
    ).sourceActivationAllowed;
  }

  private pruneRendererCrashRecoveryState(): void {
    const activeSessionIds = new Set(
      [...this.projections.values()]
        .filter((projection) => !isTerminalComputerUseStatus(projection.status))
        .map((projection) => projection.sessionId),
    );
    for (const sessionId of this.rendererCrashRecoveryAttemptedSessions) {
      if (!activeSessionIds.has(sessionId)) {
        this.rendererCrashRecoveryAttemptedSessions.delete(sessionId);
      }
    }
    for (const sessionId of this.rendererCrashAutoReopenBlockedSessions) {
      if (!activeSessionIds.has(sessionId)) {
        this.rendererCrashAutoReopenBlockedSessions.delete(sessionId);
      }
    }
    for (const sessionId of this.rendererCrashCounts.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.rendererCrashCounts.delete(sessionId);
      }
    }
    for (const sessionId of this.rendererRecreationCounts.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.rendererRecreationCounts.delete(sessionId);
      }
    }
    for (const sessionId of this.stallTimeoutBlocks.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.stallTimeoutBlocks.delete(sessionId);
      }
    }
  }

  private isStallTimeoutBlocked(projection: ComputerUsePreviewProjection | undefined): boolean {
    const preview = projection?.preview;
    if (!projection || !preview) {
      return false;
    }
    const blocked = this.stallTimeoutBlocks.get(projection.sessionId);
    return blocked?.descriptorId === preview.descriptorId && blocked.revision === preview.revision;
  }

  private isQuiescing(): boolean {
    return this.disposing || this.disposed;
  }

  private async disposeInternal(): Promise<void> {
    let firstError: unknown;
    const captureError = (error: unknown): void => {
      firstError ??= error;
    };

    const subscription = this.subscription;
    this.subscription = undefined;
    try {
      subscription?.close();
    } catch (error) {
      captureError(error);
    }

    const unsubscribeDisplays = this.displayChangeUnsubscribe;
    this.displayChangeUnsubscribe = undefined;
    try {
      unsubscribeDisplays?.();
    } catch (error) {
      captureError(error);
    }

    this.clearLifecycleTimers();
    if (this.window || this.currentProjection) {
      try {
        this.telemetry.record({ name: "preview_closed", reason: "shutdown" });
      } catch (error) {
        captureError(error);
      }
    }

    try {
      await this.enqueueOperation(() => this.destroyWindow(false), true);
    } catch (error) {
      captureError(error);
    }

    try {
      await this.options.platformAdapter.dispose();
    } catch (error) {
      captureError(error);
    } finally {
      this.clearLifecycleTimers();
      this.clearWindowEventBindings();
      this.clearRendererGoneSubscription();
      this.rendererCrashRecoveryAttemptedSessions.clear();
      this.rendererCrashAutoReopenBlockedSessions.clear();
      this.rendererCrashCounts.clear();
      this.rendererRecreationCounts.clear();
      this.stallTimeoutBlocks.clear();
      this.disposing = false;
      this.disposed = true;
    }

    void firstError;
  }

  private async releaseMedia(notifyRenderer = true): Promise<void> {
    this.recoveryTimers.clearFirstFrameWatchdog();
    this.recoveryTimers.clearFrameGapWatchdog();
    const releaseWindow = notifyRenderer && this.snapshot?.sourceKind === "display_media"
      ? this.window
      : undefined;
    const identity = releaseWindow && this.snapshot
      ? {
          sessionId: this.snapshot.sessionId,
          sourceRevision: this.snapshot.sourceRevision,
          sourceGeneration: this.snapshot.sourceGeneration,
        }
      : undefined;
    // Reject callbacks from the source synchronously, before adapter or
    // renderer cleanup can yield and a replacement with the same revision can
    // begin activating.
    this.sourceSession.invalidateSourceActivation();
    try {
      await this.sourceSession.releaseMedia({
        window: releaseWindow,
        platformAdapter: this.options.platformAdapter,
        identity,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
        onRendererReleaseFailure: (outcome) => {
          if (outcome !== "renderer_gone" && releaseWindow) {
            this.forceDestroyRendererWindow(releaseWindow);
          }
        },
      });
    } catch (error) {
      if (releaseWindow) {
        this.forceDestroyRendererWindow(releaseWindow);
      }
      throw error;
    }
  }

  private restartFrameGapWatchdog(
    sessionId: string,
    revision: number,
    sourceGeneration: number,
  ): void {
    if (
      this.snapshot?.sourceKind !== "display_media" ||
      this.snapshot.sourceStatus !== "live"
    ) {
      return;
    }
    this.recoveryTimers.restartFrameGapWatchdog(() => {
      void this.enqueueOperation(async () => {
        if (
          this.currentProjection?.sessionId !== sessionId ||
          !this.sourceSession.matchesSourceIdentity(revision, sourceGeneration) ||
          !this.frameReady ||
          this.snapshot?.sourceKind !== "display_media" ||
          this.snapshot.sourceStatus !== "live"
        ) {
          return;
        }
        await this.startReconnect("frame_gap_timeout", sourceGeneration);
      });
    });
  }

  private restartFirstFrameWatchdog(
    sessionId: string,
    revision: number,
    sourceGeneration: number,
  ): void {
    if (
      this.frameReady ||
      this.snapshot?.sourceKind !== "display_media" ||
      this.snapshot.sourceStatus !== "connecting"
    ) {
      return;
    }
    this.recoveryTimers.restartFirstFrameWatchdog(() => {
      void this.enqueueOperation(async () => {
        if (
          this.currentProjection?.sessionId !== sessionId ||
          !this.sourceSession.matchesSourceIdentity(revision, sourceGeneration) ||
          this.frameReady ||
          this.snapshot?.sourceKind !== "display_media" ||
          this.snapshot.sourceStatus !== "connecting"
        ) {
          return;
        }
        await this.startReconnect("first_frame_timeout", sourceGeneration);
      });
    });
  }

  private async destroyWindow(suppress: boolean, notifyRenderer = true): Promise<void> {
    this.clearLifecycleTimers();
    this.resetInteractionState();
    this.sourceAttemptStartedAtMs = undefined;
    this.stallStartedAtMs = undefined;
    let firstError: unknown;
    let shouldPersistSuppression = false;
    if (suppress && this.currentProjection) {
      this.suppressSessionInMemory(this.currentProjection.sessionId);
      shouldPersistSuppression = true;
    }
    if (this.window || this.currentProjection || this.snapshot) {
      try {
        await this.releaseMedia(notifyRenderer);
      } catch (error) {
        firstError ??= error;
      }
    }
    const window = this.window;
    if (window) {
      this.forceDestroyRendererWindow(window);
    }
    this.programmaticBoundsGuard = undefined;
    this.appliedWindowAspectRatio = undefined;
    this.activePlacementDisplayId = undefined;
    this.activePlacementPreferenceKey = undefined;
    this.lastPersistedBoundsKey = undefined;
    this.currentProjection = undefined;
    this.sourceSession.clear();
    this.emitSummary();
    if (shouldPersistSuppression) {
      await this.persistPreferencesAfterSafety();
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private forceDestroyRendererWindow(window: ComputerUsePreviewWindow): void {
    if (this.window === window) {
      this.window = undefined;
      this.programmaticBoundsGuard = undefined;
      this.appliedWindowAspectRatio = undefined;
    }
    if (this.loadedRendererWindow === window) {
      this.loadedRendererWindow = undefined;
    }
    this.clearWindowEventBindings(window);
    this.clearRendererGoneSubscription(window);
    if (!window.isDestroyed()) {
      this.internallyClosingWindows.add(window);
      window.destroy();
    }
  }

  private async ensureRendererLoaded(window: ComputerUsePreviewWindow): Promise<void> {
    if (this.loadedRendererWindow === window && !window.isDestroyed()) {
      return;
    }
    await window.loadFile(this.options.previewIndexPath);
    if (this.window === window && !window.isDestroyed()) {
      this.loadedRendererWindow = window;
    }
  }

  private clearRendererGoneSubscription(window?: ComputerUsePreviewWindow): void {
    const subscription = this.rendererGoneSubscription;
    if (!subscription || (window && subscription.window !== window)) {
      return;
    }
    this.rendererGoneSubscription = undefined;
    try {
      subscription.unsubscribe();
    } catch {
      // A BrowserWindow may have torn down webContents before the disposer ran.
      // The coordinator has already dropped the callback reference, so cleanup
      // remains complete even if Electron rejects the late off() call.
    }
  }

  private clearWindowEventBindings(window?: ComputerUsePreviewWindow): void {
    const closeWindow = this.boundWindowCloseListener;
    const layoutWindow = this.boundWindowLayoutListener;
    if (window && closeWindow && closeWindow !== window && layoutWindow && layoutWindow !== window) {
      return;
    }
    if (closeWindow && this.boundWindowCloseCallback && (!window || closeWindow === window)) {
      try {
        closeWindow.off("closed", this.boundWindowCloseCallback);
      } catch {
        // The native window may already be gone; dropping the callback reference
        // below is still sufficient to prevent coordinator re-entry.
      }
      this.boundWindowCloseListener = undefined;
      this.boundWindowCloseCallback = undefined;
    }
    if (layoutWindow && (!window || layoutWindow === window)) {
      try {
        if (this.boundWindowMoveCallback) {
          layoutWindow.off("move", this.boundWindowMoveCallback);
        }
        if (this.boundWindowResizeCallback) {
          layoutWindow.off("resize", this.boundWindowResizeCallback);
        }
      } catch {
        // See the close-listener cleanup above.
      }
      this.boundWindowLayoutListener = undefined;
      this.boundWindowMoveCallback = undefined;
      this.boundWindowResizeCallback = undefined;
    }
  }

  private initialPreviewPlacement(aspectRatio: number): {
    readonly bounds: DesktopRect;
    readonly displayId: string;
    readonly preferenceKey?: string;
  } {
    const displays = this.options.getDisplays();
    const currentDisplay = this.options.getDisplayMatching(this.hostLayout?.windowBounds);
    const savedPlacements = this.preferences.previewDisplayPlacements ?? {};
    const exactPlacement = savedPlacements[currentDisplay.id];
    if (exactPlacement) {
      const restored = restoreComputerUsePipNormalizedPlacement({ placement: exactPlacement, displays });
      if (restored) {
        return {
          bounds: restored.bounds,
          displayId: restored.displayId,
          preferenceKey: currentDisplay.id,
        };
      }
    }

    const nearestSaved = Object.entries(savedPlacements)
      .filter(([, placement]) => placement && placement.sourceWorkArea)
      .sort(([, left], [, right]) =>
        displayDistance(left.sourceWorkArea, currentDisplay.workArea) -
        displayDistance(right.sourceWorkArea, currentDisplay.workArea),
      )[0];
    if (nearestSaved) {
      const restored = restoreComputerUsePipNormalizedPlacement({ placement: nearestSaved[1], displays });
      if (restored) {
        return {
          bounds: restored.bounds,
          displayId: restored.displayId,
          preferenceKey: nearestSaved[0],
        };
      }
    }

    if (this.preferences.previewBounds) {
      const legacyDisplay = this.options.getDisplayMatching(this.preferences.previewBounds);
      return {
        bounds: clampBoundsToDisplay(this.preferences.previewBounds, legacyDisplay),
        displayId: legacyDisplay.id,
        preferenceKey: legacyDisplay.id,
      };
    }

    return {
      bounds: this.previewBounds(aspectRatio, currentDisplay),
      displayId: currentDisplay.id,
    };
  }

  private previewBounds(aspectRatio: number, display: DesktopDisplayWorkArea): DesktopRect {
    const width = 420;
    const height = Math.round(width / normalizePreviewLayoutAspectRatio(aspectRatio));
    return chooseComputerUsePreviewBounds({
      workArea: display.workArea,
      size: { width, height },
      obstacles: this.hostLayout?.obstacles,
      preferredCorner: this.preferences.previewPreferredCorner,
    });
  }

  private applyWindowAspectRatio(aspectRatio: number): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const normalized = normalizeSourceAspectRatio(aspectRatio);
    if (this.appliedWindowAspectRatio === normalized) {
      return;
    }
    this.window.setAspectRatio(normalized);
    this.appliedWindowAspectRatio = normalized;
  }

  private setBoundsProgrammatically(bounds: DesktopRect, animate: boolean): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const current = this.window.getBounds();
    const changedAxes = Number(current.x !== bounds.x || current.y !== bounds.y) +
      Number(current.width !== bounds.width || current.height !== bounds.height);
    this.programmaticBoundsGuard = {
      bounds,
      remainingEvents: Math.max(changedAxes, 1),
    };
    this.window.setBounds(bounds, animate);
  }

  private handleWindowLayoutChanged(
    window: ComputerUsePreviewWindow,
    event: "move" | "resize",
  ): void {
    if (this.window !== window || window.isDestroyed()) {
      return;
    }
    const bounds = window.getBounds();
    const guard = this.programmaticBoundsGuard;
    if (guard && rectEquals(guard.bounds, bounds)) {
      this.programmaticBoundsGuard = guard.remainingEvents > 1
        ? { ...guard, remainingEvents: guard.remainingEvents - 1 }
        : undefined;
      return;
    }
    this.programmaticBoundsGuard = undefined;
    void this.enqueueUserPlacement(bounds).catch(() => undefined);
    if (event === "move") {
      this.schedulePlacementSnap(window);
    }
  }

  private schedulePlacementSnap(window: ComputerUsePreviewWindow): void {
    this.clearPlacementSnapTimer();
    this.placementSnapTimer = this.setTimer(() => {
      this.placementSnapTimer = undefined;
      void this.enqueueOperation(() => this.snapUserPlacementToCorner(window)).catch(() => undefined);
    }, PREVIEW_PLACEMENT_SNAP_DEBOUNCE_MS);
  }

  private clearPlacementSnapTimer(): void {
    if (!this.placementSnapTimer) {
      return;
    }
    this.clearTimer(this.placementSnapTimer);
    this.placementSnapTimer = undefined;
  }

  private async snapUserPlacementToCorner(window: ComputerUsePreviewWindow): Promise<void> {
    if (this.window !== window || window.isDestroyed()) {
      return;
    }
    const bounds = window.getBounds();
    const display = this.options.getDisplayMatching(bounds);
    const preferredCorner = closestComputerUsePipCorner(bounds, display.workArea);
    const candidate = generateComputerUsePreviewPlacementCandidates({
      workArea: display.workArea,
      size: { width: bounds.width, height: bounds.height },
      obstacles: this.hostLayout?.obstacles,
      preferredCorner,
      previousBounds: bounds,
    })[0];
    if (!candidate) {
      return;
    }
    if (!rectEquals(bounds, candidate.bounds)) {
      this.setBoundsProgrammatically(candidate.bounds, true);
    }
    await this.persistUserPlacement(candidate.bounds, candidate.corner);
  }

  private enqueueUserPlacement(bounds: DesktopRect): Promise<void> {
    return this.enqueueOperation(() => this.persistUserPlacement(bounds));
  }

  private async persistUserPlacement(
    bounds: DesktopRect,
    preferredCorner?: ComputerUsePipCorner,
  ): Promise<void> {
    const display = this.options.getDisplayMatching(bounds);
    const placement = encodeComputerUsePipNormalizedPlacement({ bounds, display });
    const boundsKey = `${display.id}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    if (
      this.lastPersistedBoundsKey === boundsKey
      && (preferredCorner === undefined || this.preferences.previewPreferredCorner === preferredCorner)
    ) {
      return;
    }
    this.preferences = {
      ...this.preferences,
      ...(preferredCorner ? { previewPreferredCorner: preferredCorner } : {}),
      previewDisplayPlacements: {
        ...(this.preferences.previewDisplayPlacements ?? {}),
        [display.id]: placement,
      },
      previewBounds: { displayId: display.id, ...bounds },
    };
    this.activePlacementDisplayId = display.id;
    this.activePlacementPreferenceKey = display.id;
    await this.options.preferenceStore.save(this.preferences);
    this.lastPersistedBoundsKey = boundsKey;
  }

  private sendSnapshot(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) {
      return;
    }
    try {
      window.webContents.send(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotChanged, this.snapshot);
    } catch {
      if (this.rendererSendFailureWindows.has(window)) {
        return;
      }
      this.rendererSendFailureWindows.add(window);
      this.sourceSession.reportRendererGone(window.webContents.id);
      void this.enqueueRendererCrashRecovery(window, { reason: "snapshot_send_failed" });
    }
  }

  private presentWindowIfEligible(): void {
    const window = this.window;
    const snapshot = this.snapshot;
    const projection = this.currentProjection;
    if (!window || window.isDestroyed() || window.isVisible() || !snapshot || !projection) {
      return;
    }
    if (this.presentationDecisionFor(
      projection.sessionId,
      snapshot.sourceStatus,
      snapshot.frameReady,
    ).shouldRevealOrRetainWindow) {
      window.showInactive();
    }
  }

  private async releaseHiddenSourceForDisabledAutoShow(): Promise<void> {
    const window = this.window;
    const snapshot = this.snapshot;
    if (
      !window
      || window.isDestroyed()
      || window.isVisible()
      || !snapshot
      || snapshot.sourceStatus === "idle"
    ) {
      return;
    }
    this.recoveryTimers.clearSourceErrorTimer();
    this.recoveryTimers.clearFirstFrameWatchdog();
    this.recoveryTimers.clearFrameGapWatchdog();
    this.clearReconnectTimer(true);
    this.sourceAttemptStartedAtMs = undefined;
    this.stallStartedAtMs = undefined;
    await this.releaseMedia().catch(() => undefined);
    this.frameReady = false;
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        sourceStatus: "idle",
        frameReady: false,
        visibilityIntent: this.visibilityIntentFor(this.snapshot.sessionId),
        statusDetail: undefined,
      };
      this.sendSnapshot();
    }
  }

  private currentSummary(): ComputerUsePreviewSummary | undefined {
    const projection = this.currentProjection;
    if (!projection) {
      return undefined;
    }
    return {
      sessionId: projection.sessionId,
      conversationId: projection.conversationId,
      status: projection.status,
      targetLabel: projection.target.displayName,
      previewAvailable: projection.preview !== undefined,
      visible: Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()),
    };
  }

  private emitSummary(): void {
    const summary = this.currentSummary();
    for (const listener of this.summaryListeners) {
      try {
        listener(summary);
      } catch {
        this.summaryListeners.delete(listener);
      }
    }
  }

  private startSourceErrorLinger(): void {
    const lease = this.capturePresentationLease();
    if (!lease) {
      return;
    }
    this.recoveryTimers.startSourceErrorLinger(() => {
      void this.enqueueOperation(async () => {
        if (!this.isPresentationLeaseCurrent(lease)) {
          return;
        }
        this.telemetry.record({ name: "preview_closed", reason: "source_error" });
        try {
          await this.destroyWindow(false);
        } catch {
          // Forced teardown already cleared the exact failed source.
        }
      });
    });
  }

  private clearLifecycleTimers(): void {
    this.recoveryTimers.clearAll();
    this.clearPlacementSnapTimer();
  }

  private resetInteractionState(): void {
    this.interactionState.hover = false;
    this.interactionState.focus = false;
    this.recoveryTimers.setInteractionPaused(false);
  }

  private clearReconnectTimer(resetState: boolean): void {
    this.recoveryTimers.clearReconnectTimer(resetState);
  }
}

function rectEquals(left: DesktopRect, right: DesktopRect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function normalizeSourceAspectRatio(aspectRatio: number): number {
  return Number.isFinite(aspectRatio) && aspectRatio > 0
    ? aspectRatio
    : DEFAULT_PREVIEW_ASPECT_RATIO;
}

function normalizePreviewLayoutAspectRatio(aspectRatio: number): number {
  return Math.max(1, Math.min(normalizeSourceAspectRatio(aspectRatio), 2.4));
}

function closestComputerUsePipCorner(bounds: DesktopRect, workArea: DesktopRect): ComputerUsePipCorner {
  return [...createComputerUsePreviewCornerCandidates({
    workArea,
    size: { width: bounds.width, height: bounds.height },
  })].sort((left, right) =>
    boundsDistance(left.bounds, bounds) - boundsDistance(right.bounds, bounds),
  )[0]?.corner ?? "bottom-right";
}

function boundsDistance(left: DesktopRect, right: DesktopRect): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function clampBoundsToDisplay(bounds: DesktopRect, display: DesktopDisplayWorkArea): DesktopRect {
  const width = Math.min(Math.max(bounds.width, 0), display.workArea.width);
  const height = Math.min(Math.max(bounds.height, 0), display.workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, display.workArea.x), display.workArea.x + display.workArea.width - width),
    y: Math.min(Math.max(bounds.y, display.workArea.y), display.workArea.y + display.workArea.height - height),
    width,
    height,
  };
}

function displayDistance(left: DesktopRect, right: DesktopRect): number {
  const leftX = left.x + left.width / 2;
  const leftY = left.y + left.height / 2;
  const rightX = right.x + right.width / 2;
  const rightY = right.y + right.height / 2;
  return (leftX - rightX) ** 2 + (leftY - rightY) ** 2;
}
