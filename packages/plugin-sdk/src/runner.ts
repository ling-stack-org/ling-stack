import type { LingExtensionManifest } from "./manifest.js";

export interface RunnerResumeCapabilities<TActionType extends string = string> {
  readonly nativeResume: boolean;
  readonly hostApprovalContinuation: readonly TActionType[];
}

export interface RunnerExtensionMetadata<TActionType extends string = string> {
  readonly manifest: LingExtensionManifest<"runner">;
  readonly runnerId: string;
  readonly supportedTools: readonly string[];
  readonly supportedProviderApis: readonly string[];
  readonly eventTypes: readonly string[];
  readonly resumeCapabilities: RunnerResumeCapabilities<TActionType>;
}
