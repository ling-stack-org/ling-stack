import type { LingExtensionManifest } from "./manifest.js";

export interface MemoryProviderExtensionMetadata {
  readonly manifest: LingExtensionManifest<"memory">;
  readonly memoryProviderId: string;
  readonly scopeKinds: readonly string[];
}
