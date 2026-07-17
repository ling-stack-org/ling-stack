import type { ComputerUsePreviewProjection } from "@ling-stack/contracts";
import { isTerminalComputerUseStatus } from "@ling-stack/contracts";
import type {
  ComputerUsePreviewLocale,
  ComputerUsePreviewReleaseMediaAck,
  ComputerUsePreviewReleaseMediaRequest,
  ComputerUsePipRendererSnapshot,
} from "../../shared/desktop-capabilities.js";
import { DEFAULT_COMPUTER_USE_PREVIEW_LOCALE } from "../../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { ComputerUsePreviewPlatformAdapter } from "./platform-adapter.js";
import type { ComputerUsePreviewWindow } from "./window.js";

export const COMPUTER_USE_RENDERER_MEDIA_RELEASE_TIMEOUT_MS = 500;

export type ComputerUseRendererMediaReleaseOutcome =
  | "acknowledged"
  | "not_required"
  | "timed_out"
  | "send_failed"
  | "renderer_gone"
  | "conflict"
  | "rejected";

interface PendingRendererMediaRelease {
  readonly request: ComputerUsePreviewReleaseMediaRequest;
  readonly webContentsId: number;
  readonly completion: Promise<ComputerUseRendererMediaReleaseOutcome>;
  readonly resolve: (outcome: ComputerUseRendererMediaReleaseOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

interface PendingMediaReleaseOperation {
  readonly webContentsId?: number;
  readonly sessionId?: string;
  readonly sourceRevision?: number;
  readonly sourceGeneration?: number;
  readonly completion: Promise<ComputerUseRendererMediaReleaseOutcome>;
}

/**
 * Owns renderer-facing source state for one Desktop preview session.
 *
 * Runtime projection state remains in the coordinator. This object only tracks
 * the current source revision, first-frame readiness, and the sanitized snapshot
 * sent to the preview renderer. Native source handles never cross this boundary.
 */
export class ComputerUsePreviewSourceSession {
  private snapshotValue: ComputerUsePipRendererSnapshot | undefined;
  private frameReadyValue = false;
  private pendingRendererMediaRelease: PendingRendererMediaRelease | undefined;
  private pendingMediaReleaseOperation: PendingMediaReleaseOperation | undefined;
  private rendererMediaReleaseSequence = 0;
  private sourceGenerationSequence = 0;
  private activeSourceGeneration: number | undefined;

  get snapshot(): ComputerUsePipRendererSnapshot | undefined {
    return this.snapshotValue;
  }

  set snapshot(value: ComputerUsePipRendererSnapshot | undefined) {
    this.snapshotValue = value;
  }

  get frameReady(): boolean {
    return this.frameReadyValue;
  }

  set frameReady(value: boolean) {
    this.frameReadyValue = value;
  }

  beginSourceActivation(): number {
    if (this.sourceGenerationSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("computer_use_source_generation_exhausted");
    }
    const sourceGeneration = ++this.sourceGenerationSequence;
    this.activeSourceGeneration = sourceGeneration;
    this.frameReadyValue = false;
    return sourceGeneration;
  }

  invalidateSourceActivation(): void {
    this.activeSourceGeneration = undefined;
    this.frameReadyValue = false;
  }

  isSourceGenerationActive(sourceGeneration: number): boolean {
    return this.activeSourceGeneration === sourceGeneration;
  }

  matchesSourceIdentity(revision: number, sourceGeneration: number): boolean {
    return this.activeSourceGeneration === sourceGeneration &&
      this.snapshotValue?.sourceRevision === revision &&
      this.snapshotValue.sourceGeneration === sourceGeneration;
  }

  resetForRevision(revision: number): void {
    this.frameReadyValue = false;
    if (this.snapshotValue) {
      this.snapshotValue = {
        ...this.snapshotValue,
        sourceRevision: revision,
        sourceStatus: "idle",
        frameReady: false,
        statusDetail: undefined,
      };
    }
  }

  clear(): void {
    this.settlePendingRendererMediaRelease("renderer_gone");
    this.snapshotValue = undefined;
    this.frameReadyValue = false;
    this.activeSourceGeneration = undefined;
  }

  releaseMedia(input: {
    readonly window: ComputerUsePreviewWindow | undefined;
    readonly platformAdapter: ComputerUsePreviewPlatformAdapter;
    readonly identity: {
      readonly sessionId: string;
      readonly sourceRevision: number;
      readonly sourceGeneration: number;
    } | undefined;
    readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
    readonly onRendererReleaseFailure?: (outcome: ComputerUseRendererMediaReleaseOutcome) => void;
  }): Promise<ComputerUseRendererMediaReleaseOutcome> {
    const webContentsId = input.window && !input.window.isDestroyed()
      ? input.window.webContents.id
      : undefined;
    const existing = this.pendingMediaReleaseOperation;
    if (existing) {
      if (
        existing.webContentsId === webContentsId &&
        existing.sessionId === input.identity?.sessionId &&
        existing.sourceRevision === input.identity?.sourceRevision &&
        existing.sourceGeneration === input.identity?.sourceGeneration
      ) {
        return existing.completion;
      }
      const conflict = Promise.resolve<ComputerUseRendererMediaReleaseOutcome>("conflict");
      this.notifyRendererReleaseFailure(conflict, input.onRendererReleaseFailure);
      return conflict;
    }

    const completion = this.performMediaRelease(input);
    this.pendingMediaReleaseOperation = {
      webContentsId,
      sessionId: input.identity?.sessionId,
      sourceRevision: input.identity?.sourceRevision,
      sourceGeneration: input.identity?.sourceGeneration,
      completion,
    };
    void completion.then(
      () => this.clearPendingMediaReleaseOperation(completion),
      () => this.clearPendingMediaReleaseOperation(completion),
    );
    return completion;
  }

  private async performMediaRelease(input: {
    readonly window: ComputerUsePreviewWindow | undefined;
    readonly platformAdapter: ComputerUsePreviewPlatformAdapter;
    readonly identity: {
      readonly sessionId: string;
      readonly sourceRevision: number;
      readonly sourceGeneration: number;
    } | undefined;
    readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
    readonly onRendererReleaseFailure?: (outcome: ComputerUseRendererMediaReleaseOutcome) => void;
  }): Promise<ComputerUseRendererMediaReleaseOutcome> {
    const rendererRelease = input.window && input.identity && !input.window.isDestroyed()
      ? this.requestRendererMediaRelease({
          window: input.window,
          identity: input.identity,
          setTimer: input.setTimer,
          clearTimer: input.clearTimer,
        })
      : Promise.resolve<ComputerUseRendererMediaReleaseOutcome>("not_required");

    this.notifyRendererReleaseFailure(rendererRelease, input.onRendererReleaseFailure);

    let adapterError: unknown;
    try {
      await input.platformAdapter.release();
    } catch (error) {
      adapterError = error;
    }
    const outcome = await rendererRelease;
    if (adapterError !== undefined) {
      throw adapterError;
    }
    return outcome;
  }

  acknowledgeRendererMediaRelease(
    ack: ComputerUsePreviewReleaseMediaAck,
    webContentsId: number,
  ): boolean {
    const pending = this.pendingRendererMediaRelease;
    if (
      !pending ||
      pending.webContentsId !== webContentsId ||
      pending.request.requestId !== ack.requestId ||
      pending.request.sessionId !== ack.sessionId ||
      pending.request.sourceRevision !== ack.sourceRevision ||
      pending.request.sourceGeneration !== ack.sourceGeneration
    ) {
      return false;
    }
    const accepted = (ack.status === "released" || ack.status === "already_released") && ack.allTracksEnded;
    this.settlePendingRendererMediaRelease(accepted ? "acknowledged" : "rejected");
    return accepted;
  }

  reportRendererGone(webContentsId: number): void {
    if (this.pendingRendererMediaRelease?.webContentsId === webContentsId) {
      this.settlePendingRendererMediaRelease("renderer_gone");
    }
  }

  private requestRendererMediaRelease(input: {
    readonly window: ComputerUsePreviewWindow;
    readonly identity: {
      readonly sessionId: string;
      readonly sourceRevision: number;
      readonly sourceGeneration: number;
    };
    readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  }): Promise<ComputerUseRendererMediaReleaseOutcome> {
    const existing = this.pendingRendererMediaRelease;
    if (existing) {
      if (
        existing.webContentsId === input.window.webContents.id &&
        existing.request.sessionId === input.identity.sessionId &&
        existing.request.sourceRevision === input.identity.sourceRevision &&
        existing.request.sourceGeneration === input.identity.sourceGeneration
      ) {
        return existing.completion;
      }
      return Promise.resolve("conflict");
    }

    const request: ComputerUsePreviewReleaseMediaRequest = {
      requestId: `computer-use-media-release:${input.identity.sessionId}:${input.identity.sourceRevision}:${input.identity.sourceGeneration}:${++this.rendererMediaReleaseSequence}`,
      sessionId: input.identity.sessionId,
      sourceRevision: input.identity.sourceRevision,
      sourceGeneration: input.identity.sourceGeneration,
    };
    let resolveCompletion!: (outcome: ComputerUseRendererMediaReleaseOutcome) => void;
    const completion = new Promise<ComputerUseRendererMediaReleaseOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const timer = input.setTimer(() => {
      if (this.pendingRendererMediaRelease?.request.requestId === request.requestId) {
        this.settlePendingRendererMediaRelease("timed_out");
      }
    }, COMPUTER_USE_RENDERER_MEDIA_RELEASE_TIMEOUT_MS);
    this.pendingRendererMediaRelease = {
      request,
      webContentsId: input.window.webContents.id,
      completion,
      resolve: resolveCompletion,
      timer,
      clearTimer: input.clearTimer,
    };
    try {
      input.window.webContents.send(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMedia, request);
    } catch {
      this.settlePendingRendererMediaRelease("send_failed");
    }
    return completion;
  }

  private settlePendingRendererMediaRelease(outcome: ComputerUseRendererMediaReleaseOutcome): void {
    const pending = this.pendingRendererMediaRelease;
    if (!pending) {
      return;
    }
    this.pendingRendererMediaRelease = undefined;
    pending.clearTimer(pending.timer);
    pending.resolve(outcome);
  }

  private notifyRendererReleaseFailure(
    completion: Promise<ComputerUseRendererMediaReleaseOutcome>,
    listener: ((outcome: ComputerUseRendererMediaReleaseOutcome) => void) | undefined,
  ): void {
    void completion.then((outcome) => {
      if (outcome === "acknowledged" || outcome === "not_required") {
        return;
      }
      try {
        listener?.(outcome);
      } catch {
        // Window teardown is best-effort here; the caller still owns adapter cleanup.
      }
    });
  }

  private clearPendingMediaReleaseOperation(
    completion: Promise<ComputerUseRendererMediaReleaseOutcome>,
  ): void {
    if (this.pendingMediaReleaseOperation?.completion === completion) {
      this.pendingMediaReleaseOperation = undefined;
    }
  }
}

export interface RendererSnapshotSource {
  readonly sourceKind: "fake" | "display_media";
  readonly sourceStatus: ComputerUsePipRendererSnapshot["sourceStatus"];
  readonly sourceGeneration: number;
  readonly visibilityIntent?: ComputerUsePipRendererSnapshot["visibilityIntent"];
  readonly frameReady: boolean;
  readonly aspectRatio?: number;
  readonly statusDetail?: string;
}

export function buildRendererSnapshot(
  projection: ComputerUsePreviewProjection,
  source: RendererSnapshotSource,
  locale: ComputerUsePreviewLocale = DEFAULT_COMPUTER_USE_PREVIEW_LOCALE,
): ComputerUsePipRendererSnapshot {
  return {
    sessionId: projection.sessionId,
    conversationId: projection.conversationId,
    locale,
    targetLabel: projection.target.displayName,
    runtimeStatus: projection.status,
    sourceStatus: source.sourceStatus,
    sourceKind: source.sourceKind,
    sourceRevision: projection.preview?.revision ?? 0,
    sourceGeneration: source.sourceGeneration,
    visibilityIntent: source.visibilityIntent ?? "auto",
    frameReady: source.frameReady,
    aspectRatio: source.aspectRatio ?? projection.preview?.aspectRatio ?? 1.6,
    statusDetail: source.statusDetail ?? runtimeStatusDetail(projection),
    canStop: !isTerminalComputerUseStatus(projection.status) && projection.status !== "stopping",
    canOpenSettings: source.sourceStatus === "permission_denied",
  };
}

export function runtimeStatusDetail(projection: ComputerUsePreviewProjection): string | undefined {
  if (projection.status === "waiting_for_approval") {
    return projection.approvalRequired?.summary;
  }
  if (projection.status === "failed") {
    return projection.failure?.message;
  }
  return undefined;
}
