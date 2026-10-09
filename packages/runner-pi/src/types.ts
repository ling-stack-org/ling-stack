import type { Api, ImageContent, Model, ModelThinkingLevel, OpenAICompletionsCompat, TextContent, ThinkingLevelMap, Transport } from "@earendil-works/pi-ai";
import type { PiRunnerPreparedInput } from "./prepared-input.js";
import type { PiRunnerHostCapabilityToolDefinition, PiRunnerHostCapabilityCallRequest } from "./host-capability-types.js";
import type { PiProviderErrorDiagnostic } from "./provider-error-diagnostic.js";
export type { PiProviderErrorDiagnostic } from "./provider-error-diagnostic.js";
export type * from "./host-capability-types.js";
import type { ToolDefaultApproval, ToolSideEffectLevel } from "@ling-stack/plugin-sdk";

export type PiRunnerBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export type PiRunnerToolName = PiRunnerBuiltinToolName | string;
export type PiRunnerApprovalToolName = PiRunnerToolName;

export type PiRunnerProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

export type PiRunnerProviderTransport = Transport;
export type PiRunnerReasoningSummaryMode = "auto" | "concise" | "detailed" | "none";

export interface PiRunnerProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly displayName?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly api?: PiRunnerProviderApi;
  readonly providerTransport?: PiRunnerProviderTransport;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: OpenAICompletionsCompat;
}

export interface PiRunnerTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly channelId?: string;
}

/** Host-private logical SDK request admission; not proof of HTTP/WebSocket dispatch. */
export interface PiRunnerProviderInvocationAdmittedReceipt {
  readonly invocationId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly admittedAt: string;
}

/** One admitted stream's terminal outcome, never an aggregate Run/UI failure. */
export interface PiRunnerProviderInvocationSettledReceipt extends PiRunnerProviderInvocationAdmittedReceipt {
  readonly settledAt: string;
  readonly outcome: "succeeded" | "provider_error" | "cancelled" | "local_rejected";
  /** Bounded diagnostic enum/status/code only; never raw Provider text or credentials. */
  readonly errorDiagnostic?: PiProviderErrorDiagnostic;
}

export interface PiRunnerApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: PiRunnerApprovalToolName;
  readonly input: unknown;
  readonly task: PiRunnerTask;
  readonly cwd: string;
  readonly defaultApproval?: ToolDefaultApproval;
}

export interface PiRunnerApprovalDecision {
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly handledResult?: PiRunnerToolHandledResult;
}

export interface PiRunnerToolHandledResult {
  readonly content: readonly (
    | TextContent
    | ImageContent
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/**
 * Durable Host evidence used to continue an interrupted Agent turn after one
 * approved tool call has already completed. This is transcript evidence, not
 * authority to execute the tool again.
 */
export interface PiRunnerApprovedToolContinuation {
  readonly schemaVersion: 1;
  readonly kind: "approved_tool_result";
  readonly approvalId: string;
  readonly sideEffectFingerprint: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: PiRunnerToolHandledResult;
  readonly assistantText?: string;
}

export type PiRunnerPermissionRequestKind =
  | "core_tool"
  | "write_scope"
  | "mcp_tool"
  | "runner_capability";

export type PiRunnerPermissionScope =
  | {
      readonly kind: "core_tool";
      readonly tools: readonly PiRunnerBuiltinToolName[];
    }
  | {
      readonly kind: "write_scope";
      readonly paths: readonly string[];
      readonly operation: "read_write" | "create" | "update" | "delete";
    }
  | {
      readonly kind: "mcp_tool";
      readonly serverId: string;
      readonly toolName: string;
      readonly sideEffectLevel: string;
      readonly defaultApproval: string;
    }
  | {
      readonly kind: "runner_capability";
      readonly runnerId: string;
      readonly capability: string;
    };

export interface PiRunnerPermissionRequest {
  readonly toolCallId: string;
  readonly requestKind: PiRunnerPermissionRequestKind;
  readonly reason: string;
  readonly requestedScope: PiRunnerPermissionScope;
  readonly task: PiRunnerTask;
  readonly cwd: string;
}

export interface PiRunnerPermissionGrant {
  readonly id: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly scope: PiRunnerPermissionScope;
  readonly mode: "same_run" | "continuation";
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface PiRunnerPermissionDecision {
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly grant?: PiRunnerPermissionGrant;
}

export interface PiRunnerRuntimeToolFeatures {
  readonly requestPermissions?: boolean;
  readonly unifiedExec?: boolean;
  readonly shellSnapshot?: boolean;
}

export interface PiRunnerRuntimePaths {
  readonly piDir?: string;
  readonly artifactsDir?: string;
}

export interface PiRunnerSandboxProfile {
  readonly id: string;
  readonly backendKind: string;
  readonly displayName?: string;
}

export interface PiRunnerSandboxManifest {
  readonly profileId: string;
  readonly workspaceRoot: string;
  readonly artifactImportRoots: readonly string[];
}

export interface PiRunnerSandboxSessionRef {
  readonly profileId: string;
  readonly backendKind: string;
  readonly opaqueSessionId: string;
}

export interface PiRunnerSandboxReadiness {
  readonly status: "ready" | "blocked";
  readonly blockingReasons: readonly { readonly code: string; readonly message: string }[];
}

export interface PiRunnerSandboxBinding {
  readonly profile: PiRunnerSandboxProfile;
  readonly manifest: PiRunnerSandboxManifest;
  readonly sessionRef: PiRunnerSandboxSessionRef;
  readonly readiness: PiRunnerSandboxReadiness;
}

export type PiRunnerToolHydrationScope =
  | { readonly kind: "namespace"; readonly namespaceId: string }
  | { readonly kind: "tool"; readonly toolId: string };

export interface PiRunnerToolHydrationRequest {
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly scope: PiRunnerToolHydrationScope;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly task: PiRunnerTask;
  readonly cwd: string;
}

export interface PiRunnerToolHydrationBudget {
  readonly decision: "within_budget" | "over_budget";
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

export interface PiRunnerToolMaterializationSummary {
  readonly id: string;
  readonly runId: string;
  readonly namespaceId: string;
  readonly toolIds: readonly string[];
  readonly materializedToolCount: number;
  readonly disabledToolCount: number;
  readonly executionApprovalSummary: Record<ToolDefaultApproval, number>;
  readonly budget: PiRunnerToolHydrationBudget;
  readonly generatedAt: string;
}

export interface PiRunnerHydratedToolDescriptor {
  readonly id: string;
  readonly namespaceId: string;
  readonly sourceKind: "core_tool" | "mcp_tool";
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
  readonly executionApproval: ToolDefaultApproval;
  readonly enabled: boolean;
  readonly disabledReasons: readonly { readonly code: string; readonly message: string }[];
}

export type PiRunnerToolHydrationRejectionCode =
  | "hydration_not_supported"
  | "tool_materialization_over_budget"
  | "tool_materialization_denied"
  | "tool_namespace_not_found"
  | "tool_not_found"
  | "invalid_hydration_request";

export interface PiRunnerToolHydrationObservability {
  readonly status: "accepted" | "rejected";
  readonly scopeKind: PiRunnerToolHydrationScope["kind"];
  readonly namespaceId?: string;
  readonly toolId?: string;
  readonly materializationId?: string;
  readonly descriptorIds: readonly string[];
  readonly descriptorSchemaHashes: readonly string[];
  readonly schemaReturnedToRunner: boolean;
  readonly materializedToolCount: number;
  readonly disabledToolCount: number;
  readonly budgetDecision?: PiRunnerToolHydrationBudget["decision"];
  readonly overBudgetByTokens?: number;
  readonly rejectionCode?: PiRunnerToolHydrationRejectionCode;
  readonly retryable?: boolean;
  readonly generatedAt: string;
}

export interface PiRunnerHydratedToolSurface {
  readonly ok: true;
  readonly materialization: PiRunnerToolMaterializationSummary;
  readonly tools: readonly PiRunnerHydratedToolDescriptor[];
  readonly hydration?: PiRunnerToolHydrationObservability;
  readonly generatedAt: string;
  readonly expiresAt?: string;
}

export interface PiRunnerToolHydrationRejection {
  readonly ok: false;
  readonly code: PiRunnerToolHydrationRejectionCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly budget?: PiRunnerToolHydrationBudget;
  readonly materialization?: PiRunnerToolMaterializationSummary;
  readonly hydration?: PiRunnerToolHydrationObservability;
  readonly generatedAt: string;
}

export type PiRunnerToolHydrationResponse = PiRunnerHydratedToolSurface | PiRunnerToolHydrationRejection;

/** Host asks this physical execution to stop; it does not authorize a successor. */
export interface PiRunnerUserInputYieldDirective {
  readonly kind: "user_input_required";
  readonly requestId: string;
  readonly requestVersion: number;
}

/** Host persistence receipt only; optional questions do not stop execution. */
export interface PiRunnerUserInputOptionalReceipt {
  readonly kind: "user_input_optional";
  readonly requestId: string;
  readonly requestVersion: number;
}
export type PiRunnerUserInputRequestReceipt = PiRunnerUserInputYieldDirective | PiRunnerUserInputOptionalReceipt;

/** Receiver evidence only: no model transport, completion, permission or durable ACK is implied. */
export interface PiRunnerPreparedInputReceipt {
  readonly schemaVersion: 1;
  readonly boundary: "pi-session-ready";
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly preparedInputFingerprint: string;
}

export type PiRunnerCompactionRecoveryMode = "complete" | "continue";

/** Host-verified SDK model view restored after a daemon restart. */
export interface PiRunnerCompactionRecovery {
  readonly schemaVersion: 1;
  readonly modelView: readonly unknown[];
}

export interface PiRunnerRunOptions {
  /** Initial schema capabilities; not execution handlers or authorization grants. */
  readonly initialToolSurface?: {
    readonly mediaGeneration: boolean;
    readonly toolHydration: boolean;
    /** Schema-only preparation is permitted; execution still requires the live Host handler. */
    readonly userInput?: boolean;
  };
  /** Host-owned preparation evidence; never a permission grant or a session history. */
  readonly preparedInput?: PiRunnerPreparedInput;
  /** Resume after a Host-executed approved tool result without replaying the tool call. */
  readonly approvedToolContinuation?: PiRunnerApprovedToolContinuation;
  /**
   * Restores a sealed Pi model view after daemon restart. The Runner decides
   * from the final message whether to finalize or continue a tool loop; it
   * never replays the original task prompt for this path.
   */
  readonly compactionRecovery?: PiRunnerCompactionRecovery;
  /** Host has durable compaction evidence, provider admission fence, and restart recovery for this Run. */
  readonly hostCompactionEnabled?: boolean;
  /**
   * Called once per runTask after SDK input validation, before prompting. Requires
   * preparedInput, runId and runnerAttemptId. Host must atomically verify its full
   * fence and frozen refs before persisting ACK; retries need Host idempotency.
   * Cancellation ends the Runner wait, not the Host callback's external work.
   */
  readonly onPreparedInputAccepted?: (
    receipt: PiRunnerPreparedInputReceipt, signal: AbortSignal,
  ) => void | Promise<void>;
  readonly runId?: string;
  readonly runnerAttemptId?: string;
  readonly cwd: string;
  readonly task: PiRunnerTask;
  readonly provider: PiRunnerProviderConfig;
  readonly tools?: readonly PiRunnerToolName[];
  readonly mcpTools?: readonly PiRunnerMcpToolDefinition[];
  /** Host-selected schema surface, not an authorization grant. */
  readonly hostCapabilityTools?: readonly PiRunnerHostCapabilityToolDefinition[];
  readonly onHostCapabilityCall?: (request: PiRunnerHostCapabilityCallRequest) => PiRunnerToolHandledResult | Promise<PiRunnerToolHandledResult>;
  readonly mediaGenerationTools?: readonly PiRunnerMediaGenerationToolDefinition[];
  readonly thinkingLevel?: ModelThinkingLevel;
  /** Provider-designated public reasoning summary; never raw model thinking. */
  readonly reasoningSummary?: PiRunnerReasoningSummaryMode;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
  readonly runtimePaths?: PiRunnerRuntimePaths;
  readonly runtimeToolFeatures?: PiRunnerRuntimeToolFeatures;
  readonly sandbox?: PiRunnerSandboxBinding;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PiRunnerEvent) => void;
  /**
   * Host-only synchronous observation after actual SDK auth/header resolution
   * matches the Host tuple and all model payload/authority gates have passed.
   * Not a RunEvent, permission grant, network-dispatch proof or preparation receipt.
   * Throwing or async observers become unknown without changing model execution.
   */
  readonly onProviderInvocationAdmitted?: (receipt: PiRunnerProviderInvocationAdmittedReceipt) => void;
  /** Observe the same logical stream's outcome without consuming model events. */
  readonly onProviderInvocationSettled?: (receipt: PiRunnerProviderInvocationSettledReceipt) => void;
  /** Host authority check for every tool, including tools outside the approval catalog. */
  readonly onToolBefore?: (request: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly cwd: string;
  }) => { readonly allowed: true } | { readonly allowed: false; readonly code: string; readonly reason: string }
    | Promise<{ readonly allowed: true } | { readonly allowed: false; readonly code: string; readonly reason: string }>;
  readonly onApprovalRequired?: (
    request: PiRunnerApprovalRequest,
  ) => PiRunnerApprovalDecision | Promise<PiRunnerApprovalDecision>;
  readonly onPermissionRequired?: (
    request: PiRunnerPermissionRequest,
  ) => PiRunnerPermissionDecision | Promise<PiRunnerPermissionDecision>;
  readonly onToolHydrationRequest?: (
    request: PiRunnerToolHydrationRequest,
  ) => PiRunnerToolHydrationResponse | Promise<PiRunnerToolHydrationResponse>;
  readonly onTaskContinuationBoundary?: (
    boundary: "before_agent_start" | "before_provider_request" | "tool_call",
    /** Host-only SDK view at provider admission; never serialized as a RunEvent. */
    modelView?: readonly unknown[],
  ) => Promise<void | PiRunnerUserInputYieldDirective>;
  /** Internal opt-in. Production must install the complete Host pause/answer chain first. */
  readonly onUserInputRequest?: (request: {
    readonly toolCallId: string;
    /** Untrusted questions only. Scope, identity, fence and stop proof belong to Host. */
    readonly input: unknown;
  }) => PiRunnerUserInputRequestReceipt | Promise<PiRunnerUserInputRequestReceipt>;
  readonly onMcpToolCall?: (request: PiRunnerMcpToolCallRequest) => PiRunnerMcpToolCallResult | Promise<PiRunnerMcpToolCallResult>;
  readonly onMediaGenerationToolCall?: (
    request: PiRunnerMediaGenerationToolCallRequest,
  ) => PiRunnerMediaGenerationToolCallResult | Promise<PiRunnerMediaGenerationToolCallResult>;
}

export type PiRunnerMediaGenerationToolName = "image_generate" | "video_generate";

export interface PiRunnerMediaGenerationTarget {
  readonly id: string;
  readonly displayName: string;
  readonly aspectRatios?: readonly string[];
  readonly durationsSeconds?: readonly number[];
  readonly supportsAspectRatio?: boolean;
  readonly supportsDurationSeconds?: boolean;
  readonly supportsCount?: boolean;
}

export interface PiRunnerMediaGenerationToolDefinition {
  readonly name: PiRunnerMediaGenerationToolName;
  readonly targets: readonly PiRunnerMediaGenerationTarget[];
}

export interface PiRunnerMediaGenerationToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: PiRunnerMediaGenerationToolName;
  readonly runId: string;
  readonly prompt: string;
  readonly target?: string;
  readonly aspectRatio?: string;
  readonly durationSeconds?: number;
  readonly count?: number;
  readonly task: PiRunnerTask;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface PiRunnerMediaGenerationToolCallResult extends PiRunnerToolHandledResult {}

export interface PiRunnerMcpToolDefinition {
  readonly registeredName: string;
  readonly serverId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
}

export interface PiRunnerMcpToolCallRequest {
  readonly toolCallId: string;
  readonly registeredName: string;
  readonly serverId: string;
  readonly rawName: string;
  readonly input: unknown;
  readonly task: PiRunnerTask;
  readonly cwd: string;
  readonly defaultApproval: ToolDefaultApproval;
  /** Cancelled when the runner turn or tool execution is interrupted. */
  readonly signal?: AbortSignal;
}

export interface PiRunnerMcpToolCallResult {
  readonly content: readonly (
    | TextContent
    | ImageContent
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface PiRunnerTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export type PiRunnerEvent =
  | { readonly type: "run_start"; readonly taskId: string; readonly cwd: string; readonly provider: string; readonly model: string }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | ({ readonly type: "provider_retry"; readonly policyVersion: "pi_sdk_retry_v1" } & (
      | { readonly scope: "assistant" | "summarization"; readonly phase: "scheduled";
          readonly retryAttempt: number; readonly maxRetryAttempts: number; readonly delayMs: number;
          readonly errorDiagnostic: PiProviderErrorDiagnostic }
      | { readonly scope: "assistant"; readonly phase: "settled"; readonly retryAttempt: number;
          readonly outcome: "succeeded" | "failed" | "cancelled"; readonly errorDiagnostic?: PiProviderErrorDiagnostic }
      | { readonly scope: "summarization"; readonly phase: "attempt_start";
          readonly source: "compaction" | "branch_summary"; readonly reason?: "manual" | "threshold" | "overflow" }
      | { readonly scope: "summarization"; readonly phase: "settled" }
    ))
  | {
      readonly type: "context_compaction_start";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly policyVersion: "pi_sdk_lifecycle_v1";
      /** Bounded pre-compaction SDK context, captured before the SDK mutates its session. */
      readonly contextSnapshot?: readonly unknown[];
    }
  | {
      readonly type: "context_compaction_end";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly policyVersion: "pi_sdk_lifecycle_v1";
      readonly outcome: "sdk_installed" | "aborted" | "failed";
      readonly willRetry: boolean;
      readonly tokensBefore?: number;
      readonly estimatedTokensAfter?: number;
      readonly usage?: PiRunnerTokenUsage;
      /** Host-only SDK view captured after installation; never serialize in a RunEvent. */
      readonly compactedModelView?: readonly unknown[];
      /** Host-only exact SDK summary, paired with compactedModelView. */
      readonly compactedSummary?: string;
    }
  | { readonly type: "assistant_text_delta"; readonly text: string }
  | { readonly type: "assistant_thinking_delta"; readonly text: string }
  | {
      readonly type: "assistant_reasoning_summary";
      readonly text: string;
      readonly parts: readonly string[];
      readonly semantic: "safe_summary";
      readonly source: "openai_responses";
      readonly truncated: boolean;
    }
  | {
      readonly type: "tool_hydration_request";
      readonly runId: string;
      readonly runnerAttemptId: string;
      readonly scope: PiRunnerToolHydrationScope;
      readonly idempotencyKeyProvided: boolean;
    }
  | {
      readonly type: "tool_hydration_end";
      readonly runId: string;
      readonly runnerAttemptId: string;
      readonly materializationId?: string;
      readonly toolIds?: readonly string[];
      readonly descriptorSchemaHashes?: readonly string[];
      readonly materializedToolCount?: number;
      readonly disabledToolCount?: number;
      readonly schemaReturnedToRunner?: boolean;
      readonly budgetDecision?: PiRunnerToolHydrationBudget["decision"];
      readonly overBudgetByTokens?: number;
      readonly rejected: boolean;
      readonly code?: PiRunnerToolHydrationRejectionCode;
    }
  | { readonly type: "tool_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_update"; readonly toolCallId: string; readonly toolName: string; readonly partialResult: unknown }
  | { readonly type: "tool_end"; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean }
  | {
      readonly type: "message_end";
      readonly role: string;
      readonly text?: string;
      readonly stopReason?: string;
      readonly errorMessage?: string;
      readonly errorDiagnostic?: PiProviderErrorDiagnostic;
      readonly contentKinds?: readonly string[];
      readonly usage?: PiRunnerTokenUsage;
    }
  | { readonly type: "run_end"; readonly taskId: string; readonly messageCount: number }
  | { readonly type: "run_error"; readonly taskId: string; readonly message: string; readonly errorDiagnostic?: PiProviderErrorDiagnostic };

export interface PiRunnerResult {
  readonly taskId: string;
  readonly events: readonly PiRunnerEvent[];
  readonly messages: readonly unknown[];
}

export type PiModel = Model<Api>;
