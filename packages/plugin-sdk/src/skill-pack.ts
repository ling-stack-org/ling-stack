import type { LingExtensionManifest } from "./manifest.js";

export interface SkillPackExtensionMetadata {
  readonly manifest: LingExtensionManifest<"skill-pack">;
  readonly skillPackId: string;
  readonly source: string;
  readonly skillIds: readonly string[];
  readonly teammateTemplateIds: readonly string[];
  readonly workflowTemplateIds: readonly string[];
}
