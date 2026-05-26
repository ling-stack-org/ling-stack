import type { LingExtensionManifest } from "./manifest.js";

export interface RunnerExtensionMetadata {
  readonly manifest: LingExtensionManifest<"runner">;
  readonly runnerId: string;
  readonly supportedTools: readonly string[];
  readonly supportedProviderApis: readonly string[];
  readonly eventTypes: readonly string[];
}
