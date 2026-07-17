export type ComputerUsePreviewPermissionState = "granted" | "denied" | "prompt" | "restricted";

export interface PreparedComputerUsePreviewSource {
  readonly sourceKind: "fake" | "display_media";
  readonly aspectRatio?: number;
}

export interface ComputerUsePreviewPermissionInput {
  readonly descriptorId: string;
  readonly revision: number;
}

export interface ComputerUsePreviewPlatformAdapter {
  readonly platform: "macos" | "windows" | "fake";
  getPermissionState(input: ComputerUsePreviewPermissionInput): Promise<ComputerUsePreviewPermissionState>;
  prepare(input: {
    readonly sessionId: string;
    readonly descriptorId: string;
    readonly revision: number;
    readonly requesterWebContentsId: number;
    readonly maxFrameRate: number;
    readonly maxSize: { readonly width: number; readonly height: number };
  }): Promise<PreparedComputerUsePreviewSource>;
  release(): Promise<void>;
  dispose(): Promise<void>;
  openPermissionSettings(): Promise<void>;
}
