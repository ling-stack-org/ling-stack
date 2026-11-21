import type { DesktopCommandResult, DesktopRect } from "./desktop-capabilities.js";

export type CompanionWindowBounds = DesktopRect;

export interface CompanionWindowLayoutRequest {
  readonly bounds: CompanionWindowBounds;
  /** Rectangles in window-local DIP coordinates that should receive pointer input. */
  readonly regions: readonly CompanionWindowBounds[];
  /** The character or control anchor in window-local DIP coordinates. */
  readonly anchor: CompanionWindowBounds;
  /** Whether the native window should ignore pointer input in transparent gaps. */
  readonly pointerPassthrough: boolean;
}

export interface CompanionWindowGeometry {
  readonly bounds: CompanionWindowBounds;
  readonly workArea: DesktopRect;
}

export interface CompanionNavigationRequest {
  readonly workspace: string;
  readonly kind: "conversation" | "source";
  readonly conversationId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly sourceItemId?: string;
  readonly sourceId?: string;
  readonly approvalId?: string;
  readonly runId?: string;
  readonly reportId?: string;
  readonly workflowStepId?: string;
  readonly handoffId?: string;
  readonly workUnitId?: string;
}

export interface DesktopCompanionWindowCapabilities {
  open(cwd: string): Promise<DesktopCommandResult>;
  onSettingsRequested(listener: () => void): () => void;
  onSourceRequested(listener: (request: CompanionNavigationRequest) => void): () => void;
}

export interface CompanionDesktopCapabilities {
  readonly cwd: string;
  readonly daemonBaseUrl: string;
  close(): Promise<DesktopCommandResult>;
  openSettings(): Promise<DesktopCommandResult>;
  getGeometry(): Promise<CompanionWindowGeometry | undefined>;
  onGeometryChanged(listener: (geometry: CompanionWindowGeometry) => void): () => void;
  setLayout(request: CompanionWindowLayoutRequest): Promise<DesktopCommandResult>;
  navigate(request: CompanionNavigationRequest): Promise<DesktopCommandResult>;
  onSourceRequested(listener: (request: CompanionNavigationRequest) => void): () => void;
}
