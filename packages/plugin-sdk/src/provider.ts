import type { LingExtensionManifest } from "./manifest.js";

export interface ProviderExtensionMetadata {
  readonly manifest: LingExtensionManifest<"provider">;
  readonly providerKind: string;
  readonly providerApi?: string;
  readonly providerCapabilities: readonly string[];
  readonly mediaOperations?: readonly string[];
}
