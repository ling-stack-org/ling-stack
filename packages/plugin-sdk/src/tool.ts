import type { LingExtensionManifest } from "./manifest.js";

export const toolSideEffectLevels = ["none", "read", "write", "write-network", "external", "credential", "deploy"] as const;
export const toolDefaultApprovals = ["allow", "ask", "deny"] as const;

export type ToolSideEffectLevel = (typeof toolSideEffectLevels)[number];
export type ToolDefaultApproval = (typeof toolDefaultApprovals)[number];

export interface ToolExtensionMetadata {
  readonly manifest: LingExtensionManifest<"tool">;
  readonly toolName: string;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
}
