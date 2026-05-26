import type { LingExtensionManifest } from "./manifest.js";

export interface ChannelSourceExtensionMetadata {
  readonly manifest: LingExtensionManifest<"channel-source">;
  readonly sourceKind: string;
  readonly eventTypes: readonly string[];
}
