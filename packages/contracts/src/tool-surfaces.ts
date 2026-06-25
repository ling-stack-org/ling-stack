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

export type RunnerToolHydrationMode = "unsupported" | "daemon_hydrated";

export interface RunnerToolHydrationCapability {
  readonly mode: RunnerToolHydrationMode;
  readonly supportsNamespaceSearch: boolean;
  readonly supportsToolHydration: boolean;
  readonly conformance: "unverified" | "verified";
  readonly maxHydratedToolsPerRun: number;
}

export interface RunnerToolHydrationRequest {
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly scope: ToolLoadRequestScope;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RunnerHydratedToolDescriptor {
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
  readonly enabled: boolean;
  readonly disabledReasons: readonly LingToolDisabledReason[];
}

export type RunnerToolHydrationRejectionCode =
  | "hydration_not_supported"
  | "tool_materialization_over_budget"
  | "tool_materialization_denied"
  | "tool_namespace_not_found"
  | "tool_not_found"
  | "invalid_hydration_request";

export interface RunnerToolHydrationObservability {
  readonly status: "accepted" | "rejected";
  readonly scopeKind: ToolLoadRequestScope["kind"];
  readonly namespaceId?: string;
  readonly toolId?: string;
  readonly materializationId?: string;
  readonly descriptorIds: readonly string[];
  readonly descriptorSchemaHashes: readonly string[];
  readonly schemaReturnedToRunner: boolean;
  readonly materializedToolCount: number;
  readonly disabledToolCount: number;
  readonly budgetDecision?: ToolMaterializationBudgetDecision;
  readonly overBudgetByTokens?: number;
  readonly rejectionCode?: RunnerToolHydrationRejectionCode;
  readonly retryable?: boolean;
  readonly generatedAt: string;
}

export interface RunnerHydratedToolSurface {
  readonly ok: true;
  readonly materialization: ToolMaterializationSummary;
  readonly tools: readonly RunnerHydratedToolDescriptor[];
  readonly hydration?: RunnerToolHydrationObservability;
  readonly generatedAt: string;
  readonly expiresAt?: string;
}

export interface RunnerToolHydrationRejection {
  readonly ok: false;
  readonly code: RunnerToolHydrationRejectionCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly budget?: ToolMaterializationBudget;
  readonly materialization?: ToolMaterializationSummary;
  readonly hydration?: RunnerToolHydrationObservability;
  readonly generatedAt: string;
}

export type RunnerToolHydrationResponse = RunnerHydratedToolSurface | RunnerToolHydrationRejection;
