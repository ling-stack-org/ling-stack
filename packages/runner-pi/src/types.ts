import type { Api, ImageContent, Model, ModelThinkingLevel, OpenAICompletionsCompat, TextContent, Transport } from "@earendil-works/pi-ai";
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

export interface PiRunnerRunOptions {
  readonly cwd: string;
  readonly task: PiRunnerTask;
  readonly provider: PiRunnerProviderConfig;
  readonly tools?: readonly PiRunnerToolName[];
  readonly mcpTools?: readonly PiRunnerMcpToolDefinition[];
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
  readonly runtimePaths?: PiRunnerRuntimePaths;
  readonly runtimeToolFeatures?: PiRunnerRuntimeToolFeatures;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PiRunnerEvent) => void;
  readonly onApprovalRequired?: (
    request: PiRunnerApprovalRequest,
  ) => PiRunnerApprovalDecision | Promise<PiRunnerApprovalDecision>;
  readonly onPermissionRequired?: (
    request: PiRunnerPermissionRequest,
  ) => PiRunnerPermissionDecision | Promise<PiRunnerPermissionDecision>;
  readonly onMcpToolCall?: (request: PiRunnerMcpToolCallRequest) => PiRunnerMcpToolCallResult | Promise<PiRunnerMcpToolCallResult>;
}

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

export type PiRunnerEvent =
  | { readonly type: "run_start"; readonly taskId: string; readonly cwd: string; readonly provider: string; readonly model: string }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | { readonly type: "assistant_text_delta"; readonly text: string }
  | { readonly type: "assistant_thinking_delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_update"; readonly toolCallId: string; readonly toolName: string; readonly partialResult: unknown }
  | { readonly type: "tool_end"; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean }
  | { readonly type: "message_end"; readonly role: string }
  | { readonly type: "run_end"; readonly taskId: string; readonly messageCount: number }
  | { readonly type: "run_error"; readonly taskId: string; readonly message: string };

export interface PiRunnerResult {
  readonly taskId: string;
  readonly events: readonly PiRunnerEvent[];
  readonly messages: readonly unknown[];
}

export type PiModel = Model<Api>;
