import type {
  ComputerUsePreviewPlatformAdapter,
  PreparedComputerUsePreviewSource,
} from "./platform-adapter.js";

export class FakeComputerUsePreviewPlatformAdapter implements ComputerUsePreviewPlatformAdapter {
  readonly platform = "fake" as const;
  prepareCount = 0;
  releaseCount = 0;
  disposeCount = 0;

  async getPermissionState(): Promise<"granted"> {
    return "granted";
  }

  async prepare(): Promise<PreparedComputerUsePreviewSource> {
    this.prepareCount += 1;
    return { sourceKind: "fake", aspectRatio: 1.6 };
  }

  async release(): Promise<void> {
    this.releaseCount += 1;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }

  async openPermissionSettings(): Promise<void> {}
}
