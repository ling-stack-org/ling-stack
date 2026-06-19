import type { McpToolDefaultApproval, McpToolSideEffectLevel } from "./mcp.js";

export type ToolSurfaceSideEffectLevel = McpToolSideEffectLevel;

export type ToolSurfaceDefaultApproval = McpToolDefaultApproval;

export type LingToolNamespaceKind = "core" | "mcp";

export type LingToolDescriptorSourceKind = "core_tool" | "mcp_tool";

export type LingToolDisabledReasonCode =
  | "policy_deny"
  | "server_disabled"
  | "tool_disabled"
  | "server_enabled_tools_excludes"
  | "server_disabled_tools_includes"
  | "runner_unsupported";

export interface LingToolDisabledReason {
  readonly code: LingToolDisabledReasonCode;
  readonly message: string;
}

export interface LingToolRunnerSnapshot {
  readonly id: string;
  readonly displayName?: string;
  readonly status: "enabled" | "disabled";
  readonly supportedTools?: readonly string[];
}

export interface LingToolDescriptor {
  readonly id: string;
  readonly namespaceId: string;
  readonly sourceKind: LingToolDescriptorSourceKind;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly sideEffectLevel: ToolSurfaceSideEffectLevel;
  readonly defaultApproval: ToolSurfaceDefaultApproval;
  readonly executionApproval: ToolSurfaceDefaultApproval;
  readonly schemaAvailable: boolean;
  readonly enabled: boolean;
  readonly disabledReasons: readonly LingToolDisabledReason[];
  readonly requiredBySkillIds: readonly string[];
  readonly supportedByRunnerIds: readonly string[];
}

export interface LingToolNamespace {
  readonly id: string;
  readonly kind: LingToolNamespaceKind;
  readonly displayName: string;
  readonly ownerId?: string;
  readonly tools: readonly LingToolDescriptor[];
}

export interface LingToolNamespaceCatalog {
  readonly schemaVersion: 1;
  readonly namespaces: readonly LingToolNamespace[];
  readonly generatedAt?: string;
}

export interface ToolSurfaceResponse {
  readonly cwd: string;
  readonly runId?: string;
  readonly catalog: LingToolNamespaceCatalog;
}

export type ToolLoadRequestScope =
  | { readonly kind: "namespace"; readonly namespaceId: string }
  | { readonly kind: "tool"; readonly toolId: string };

export interface CreateToolLoadRequest {
  readonly scope: ToolLoadRequestScope;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export type ToolMaterializationBudgetDecision = "within_budget" | "over_budget";

export interface ToolMaterializationBudget {
  readonly decision: ToolMaterializationBudgetDecision;
  readonly estimatedTokens: number;
  readonly inputBudgetTokens: number;
  readonly remainingBudgetTokens: number;
  readonly overBudgetByTokens: number;
  readonly requestedToolCount: number;
  readonly maxMaterializedToolCount: number;
  readonly mode: "model_known" | "model_estimated" | "model_unknown";
  readonly tokenizer: "openai-compatible" | "anthropic-compatible" | "estimated";
  readonly capabilitySource?: string;
  readonly capabilityConfidence?: string;
}

export interface ToolMaterializationSummary {
  readonly id: string;
  readonly runId: string;
  readonly namespaceId: string;
  readonly toolIds: readonly string[];
  readonly materializedToolCount: number;
  readonly disabledToolCount: number;
  readonly executionApprovalSummary: Record<ToolSurfaceDefaultApproval, number>;
  readonly budget: ToolMaterializationBudget;
  readonly generatedAt: string;
}

export interface ToolLoadRequestResponse {
  readonly cwd: string;
  readonly runId: string;
  readonly catalog: LingToolNamespaceCatalog;
  readonly materialization: ToolMaterializationSummary;
}
