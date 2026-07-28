import type { ComputerUseRuntimeStatus } from "@ling-stack/contracts";
import type {
  DesktopRendererThemeInput,
  DesktopRendererThemeSnapshot,
} from "./renderer-theme.js";
import type { DesktopThemePackageCapabilities } from "./theme-package-capabilities.js";

export type DesktopPlatform = "macos" | "windows" | "linux";

export const COMPUTER_USE_PREVIEW_LOCALES = ["en-US", "zh-CN"] as const;

export type ComputerUsePreviewLocale = (typeof COMPUTER_USE_PREVIEW_LOCALES)[number];

export const DEFAULT_COMPUTER_USE_PREVIEW_LOCALE: ComputerUsePreviewLocale = "en-US";

export function isComputerUsePreviewLocale(value: unknown): value is ComputerUsePreviewLocale {
  return typeof value === "string" && COMPUTER_USE_PREVIEW_LOCALES.includes(
    value as ComputerUsePreviewLocale,
  );
}

export interface DesktopDaemonStatus {
  readonly state: "checking" | "starting" | "connected" | "disconnected";
  readonly baseUrl: string;
  readonly ownedByDesktop: boolean;
  readonly reason?:
    | "bridge_incompatible"
    | "start_timeout"
    | "child_exited"
    | "resource_missing"
    | "spawn_failed";
  readonly message?: string;
}

export interface DesktopRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const COMPUTER_USE_HOST_OBSTACLE_KINDS = [
  "composer",
  "approval",
  "dock",
  "terminal",
  "modal",
  "popover",
  "unknown",
  "other",
] as const;

export type ComputerUseHostObstacleKind = typeof COMPUTER_USE_HOST_OBSTACLE_KINDS[number];

export interface ComputerUseHostObstacle extends DesktopRect {
  readonly kind: ComputerUseHostObstacleKind;
}

export type ComputerUsePipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface DesktopDisplayWorkArea {
  readonly id: string;
  readonly workArea: DesktopRect;
  readonly primary?: boolean;
}

export interface ComputerUsePipNormalizedPlacement {
  readonly displayId: string;
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly width: number;
  readonly height: number;
  readonly sourceWorkArea: DesktopRect;
}

export interface ComputerUseHostLayout {
  readonly windowBounds: DesktopRect;
  readonly obstacles: readonly ComputerUseHostObstacle[];
  readonly reportedAt: string;
}

export const COMPUTER_USE_PIP_SURFACE_KINDS = [
  "channel",
  "normal_conversation",
  "teammate_direct",
] as const;

export type ComputerUsePipSurfaceKind = typeof COMPUTER_USE_PIP_SURFACE_KINDS[number];

export interface ComputerUsePipDeckOwner {
  readonly surfaceKind: ComputerUsePipSurfaceKind;
  readonly ownerId: string;
}

export type ComputerUsePipPagePresentationState = "inactive" | "activating" | "active";

export interface ComputerUsePreviewSummary {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly status: ComputerUseRuntimeStatus;
  readonly targetLabel: string;
  readonly previewAvailable: boolean;
  readonly visible: boolean;
  readonly activePageId?: string;
  readonly pageCount: number;
}

export interface DesktopCommandResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface DesktopNavigationIntent {
  readonly kind: "open_conversation";
  readonly requestId: number;
  readonly conversationId: string;
}

export function isDesktopNavigationIntent(value: unknown): value is DesktopNavigationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<DesktopNavigationIntent>;
  return candidate.kind === "open_conversation"
    && Number.isSafeInteger(candidate.requestId)
    && (candidate.requestId ?? 0) > 0
    && typeof candidate.conversationId === "string"
    && candidate.conversationId.trim().length > 0;
}

export interface ComputerUsePreviewInteraction {
  readonly kind: "hover" | "focus";
  readonly active: boolean;
}

export const COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES = [
  "released",
  "already_released",
  "identity_mismatch",
] as const;

export type ComputerUsePreviewReleaseMediaStatus =
  (typeof COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES)[number];

export interface ComputerUsePreviewReleaseMediaRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly sourceRevision: number;
  readonly sourceGeneration: number;
}

export interface ComputerUsePreviewReleaseMediaResult {
  readonly status: ComputerUsePreviewReleaseMediaStatus;
  readonly releasedTrackCount: number;
  readonly allTracksEnded: boolean;
}

export interface ComputerUsePreviewReleaseMediaAck
  extends ComputerUsePreviewReleaseMediaRequest, ComputerUsePreviewReleaseMediaResult {}

export interface ComputerUsePreviewPreferences {
  readonly previewAutoShow: boolean;
}

export interface LingDesktopCapabilities {
  readonly platform: DesktopPlatform;
  readonly daemonBaseUrl: string;
  readonly appearance: {
    reportTheme(theme: DesktopRendererThemeInput): void;
  };
  readonly themePackages: DesktopThemePackageCapabilities;
  readonly navigation: {
    acknowledgeIntent(requestId: number): Promise<DesktopCommandResult>;
    onIntent(listener: (intent: DesktopNavigationIntent) => void): () => void;
  };
  readonly daemon: {
    getStatus(): Promise<DesktopDaemonStatus>;
    restart(): Promise<DesktopDaemonStatus>;
  };
  readonly computerUse: {
    reportLocale(locale: ComputerUsePreviewLocale): void;
    reportSelectedDeckOwner(owner?: ComputerUsePipDeckOwner): void;
    /** @deprecated Use reportSelectedDeckOwner so Desktop receives the exact surface boundary. */
    reportSelectedConversation(conversationId?: string): void;
    reportHostLayout(layout: ComputerUseHostLayout): void;
    show(sessionId: string): Promise<DesktopCommandResult>;
    hide(sessionId: string): Promise<DesktopCommandResult>;
    stop(sessionId: string): Promise<DesktopCommandResult>;
    getPreferences(): Promise<ComputerUsePreviewPreferences>;
    setAutoShow(enabled: boolean): Promise<DesktopCommandResult>;
    onSummaryChanged(listener: (summary: ComputerUsePreviewSummary | undefined) => void): () => void;
  };
}

export interface ComputerUsePipRendererSnapshot {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly locale: ComputerUsePreviewLocale;
  readonly targetLabel: string;
  readonly runtimeStatus: ComputerUseRuntimeStatus;
  readonly sourceStatus: "idle" | "connecting" | "live" | "stalled" | "permission_denied" | "ended" | "failed";
  readonly sourceKind: "fake" | "display_media";
  readonly sourceRevision: number;
  /** Desktop-local identity that changes for every source activation. */
  readonly sourceGeneration: number;
  readonly visibilityIntent: "auto" | "shown" | "hidden";
  readonly frameReady: boolean;
  readonly aspectRatio: number;
  readonly statusDetail?: string;
  readonly canStop: boolean;
  readonly canOpenSettings: boolean;
  readonly deck?: {
    readonly activePageId: string;
    readonly requestedPageId?: string;
    readonly availablePageCount: number;
    readonly pages: readonly {
      readonly pageId: string;
      readonly targetLabel: string;
      readonly runtimeStatus: ComputerUseRuntimeStatus;
      readonly presentationState: ComputerUsePipPagePresentationState;
    }[];
    readonly availablePages: readonly {
      readonly pageId: string;
      readonly targetLabel: string;
      readonly runtimeStatus: ComputerUseRuntimeStatus;
      readonly resident: boolean;
    }[];
  };
}

export interface LingComputerUsePreviewCapabilities {
  getThemeSnapshot(): Promise<DesktopRendererThemeSnapshot>;
  getSnapshot(): Promise<ComputerUsePipRendererSnapshot | undefined>;
  activatePage(pageId: string): Promise<DesktopCommandResult>;
  closePage(pageId: string): Promise<DesktopCommandResult>;
  retryCapture(): Promise<DesktopCommandResult>;
  resetPosition(): Promise<DesktopCommandResult>;
  close(): Promise<DesktopCommandResult>;
  hide(): Promise<void>;
  openOwnerConversation(): Promise<DesktopCommandResult>;
  requestStop(): Promise<DesktopCommandResult>;
  openScreenPermissionSettings(): Promise<void>;
  reportFrameReady(sessionId: string, revision: number, sourceGeneration: number): void;
  reportFrameActivity(sessionId: string, revision: number, sourceGeneration: number): void;
  reportInteraction(interaction: ComputerUsePreviewInteraction): void;
  reportSourceEnded(sessionId: string, revision: number, sourceGeneration: number, reason: string): void;
  reportSourceFailure(sessionId: string, revision: number, sourceGeneration: number, reason: string): void;
  onReleaseMedia(
    listener: (
      request: ComputerUsePreviewReleaseMediaRequest,
    ) => Promise<ComputerUsePreviewReleaseMediaResult> | ComputerUsePreviewReleaseMediaResult,
  ): () => void;
  onSnapshotChanged(listener: (snapshot: ComputerUsePipRendererSnapshot | undefined) => void): () => void;
  onThemeSnapshotChanged(listener: (snapshot: DesktopRendererThemeSnapshot) => void): () => void;
}
