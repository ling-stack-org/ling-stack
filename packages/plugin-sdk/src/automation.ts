import type { LingExtensionManifest } from "./manifest.js";

export interface AutomationExtensionMetadata {
  readonly manifest: LingExtensionManifest<"automation">;
  readonly automationId: string;
  readonly triggerKinds: readonly string[];
  readonly actionKinds: readonly string[];
}
