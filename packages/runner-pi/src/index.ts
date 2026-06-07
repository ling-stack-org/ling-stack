import { join } from "node:path";
import type { Api, ImageContent, Model, ModelThinkingLevel, OpenAICompletionsCompat, TextContent } from "@earendil-works/pi-ai";
import type { RunnerExtensionMetadata, ToolDefaultApproval, ToolSideEffectLevel } from "@ling-stack/plugin-sdk";
import {
  AuthStorage,
  createAgentSession,
  createEditToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type AgentToolResult,
  type ExtensionFactory,
  type ResourceLoader,
  type ToolDefinition,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export type PiRunnerBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export type PiRunnerToolName = PiRunnerBuiltinToolName | string;
export type PiRunnerApprovalToolName = PiRunnerToolName;

export type PiRunnerProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

export interface PiRunnerProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly displayName?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly api?: PiRunnerProviderApi;
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
  readonly content: readonly (TextContent | ImageContent | { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[];
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
  readonly content: readonly (TextContent | ImageContent | { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[];
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

const DEFAULT_TOOLS: readonly PiRunnerBuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SUPPORTED_PROVIDER_APIS: readonly PiRunnerProviderApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
];
const APPROVAL_REQUIRED_TOOLS = new Set<string>(DEFAULT_TOOLS);
const SIDE_EFFECT_TOOLS = new Set<string>(["bash", "edit", "write"]);

export const PI_RUNNER_EXTENSION_ID = "runner:pi";

export function getPiRunnerExtension(): RunnerExtensionMetadata {
  return {
    manifest: {
      id: PI_RUNNER_EXTENSION_ID,
      name: "Pi Runner",
      version: "0.1.0",
      kind: "runner",
      trustLevel: "internal",
      capabilities: [
        "runner:pi",
        ...DEFAULT_TOOLS.map((tool) => `tool:${tool}`),
        ...SUPPORTED_PROVIDER_APIS.map((api) => `provider-api:${api}`),
      ],
      requiredApprovals: [
        {
          decision: "ask",
          risk: "medium",
          tools: ["bash", "edit", "write"],
          reason: "Pi runner can invoke local tools; risky tools remain gated by approval policy.",
        },
      ],
    },
    runnerId: "pi",
    supportedTools: [...DEFAULT_TOOLS],
    supportedProviderApis: [...SUPPORTED_PROVIDER_APIS],
    eventTypes: [
      "run_start",
      "turn_start",
      "turn_end",
      "assistant_text_delta",
      "assistant_thinking_delta",
      "tool_start",
      "tool_update",
      "tool_end",
      "message_end",
      "run_end",
      "run_error",
    ],
  };
}

export class PiRunnerAdapter {
  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    const events: PiRunnerEvent[] = [];
    const emit = (event: PiRunnerEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    };

    throwIfAborted(options.signal);

    const authStorage = AuthStorage.inMemory();
    if (options.provider.apiKey) {
      authStorage.setRuntimeApiKey(options.provider.provider, options.provider.apiKey);
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    this.registerCustomProviderIfNeeded(modelRegistry, options.provider);

    const model = modelRegistry.find(options.provider.provider, options.provider.model);
    if (!model) {
      throw new Error(`Pi model not found: ${options.provider.provider}/${options.provider.model}`);
    }

    const cwd = options.cwd;
    const agentDir = options.agentDir ?? join(cwd, ".ling-stack", "pi");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const resourceLoader = await createLingStackResourceLoader(options, agentDir, settingsManager);
    const activeTools = [
      ...(options.tools ?? DEFAULT_TOOLS),
      ...(options.mcpTools?.map((tool) => tool.registeredName) ?? []),
    ];

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: activeTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    const onAbort = (): void => {
      void session.abort();
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const unsubscribe = session.subscribe((event) => {
      const translated = translatePiEvent(event);
      if (translated) {
        emit(translated);
      }
    });

    emit({
      type: "run_start",
      taskId: options.task.id,
      cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    try {
      throwIfAborted(options.signal);
      await session.prompt(formatTaskPrompt(options.task), { source: "rpc" });
      throwIfAborted(options.signal);
      emit({
        type: "run_end",
        taskId: options.task.id,
        messageCount: session.state.messages.length,
      });
      return {
        taskId: options.task.id,
        events,
        messages: session.state.messages as readonly unknown[],
      };
    } catch (error) {
      emit({
        type: "run_error",
        taskId: options.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      unsubscribe();
      session.dispose();
    }
  }

  private registerCustomProviderIfNeeded(modelRegistry: ModelRegistry, provider: PiRunnerProviderConfig): void {
    if (!provider.baseUrl) {
      return;
    }

    modelRegistry.registerProvider(provider.provider, {
      name: provider.displayName ?? provider.provider,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      api: provider.api ?? "openai-completions",
      headers: provider.headers,
      authHeader: provider.authHeader,
      models: [
        {
          id: provider.model,
          name: provider.model,
          api: provider.api ?? "openai-completions",
          baseUrl: provider.baseUrl,
          reasoning: provider.reasoning ?? true,
          input: [...(provider.input ?? ["text"])],
          contextWindow: provider.contextWindow ?? 128_000,
          maxTokens: provider.maxTokens ?? 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: provider.compat,
        },
      ],
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

export function createPiRunner(): PiRunnerAdapter {
  return new PiRunnerAdapter();
}

async function createLingStackResourceLoader(
  options: PiRunnerRunOptions,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: getLingStackSystemPrompt(options),
    appendSystemPrompt: [...(options.appendSystemPrompt ?? [])],
    extensionFactories: [
      createLingStackFileMutationToolExtension(options),
      createLingStackApprovalExtension(options),
      ...(options.runtimeToolFeatures?.requestPermissions ? [createLingStackPermissionRequestExtension(options)] : []),
      ...(options.mcpTools?.length ? [createLingStackMcpProxyExtension(options)] : []),
    ],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

function createLingStackApprovalExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
      if (!isApprovalToolName(event.toolName)) {
        return undefined;
      }
      if (event.toolName === "edit" || event.toolName === "write") {
        return undefined;
      }

      if (!options.onApprovalRequired) {
        if (!SIDE_EFFECT_TOOLS.has(event.toolName)) {
          return undefined;
        }
        return {
          block: true,
          reason: `Ling Stack blocked ${event.toolName}: no approval handler is configured.`,
        };
      }

      try {
        const decision = await options.onApprovalRequired({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          task: options.task,
          cwd: options.cwd,
        });

        if (decision.approved) {
          return undefined;
        }

        return {
          block: true,
          reason: decision.reason ?? `Ling Stack approval denied ${event.toolName}.`,
        };
      } catch (error) {
        return {
          block: true,
          reason: `Ling Stack approval check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  };
}

function createLingStackPermissionRequestExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "request_permission",
      label: "request_permission",
      description: "Ask Ling Stack for a narrowly scoped runtime permission grant when the current run is blocked by missing tools or scope.",
      promptSnippet: "Request a runtime permission grant from Ling Stack",
      parameters: {
        type: "object",
        properties: {
          requestKind: {
            type: "string",
            enum: ["core_tool", "write_scope", "mcp_tool", "runner_capability"],
          },
          reason: {
            type: "string",
            description: "Why this permission is needed for the current task.",
          },
          requestedScope: {
            type: "object",
            description: "Structured scope matching requestKind.",
          },
        },
        required: ["requestKind", "reason", "requestedScope"],
      } as ToolDefinition["parameters"],
      async execute(toolCallId, params) {
        if (!options.onPermissionRequired) {
          throw new Error("Ling Stack blocked request_permission: no permission request handler is configured.");
        }
        const request = parsePermissionRequestToolParams(toolCallId, params, options);
        const decision = await options.onPermissionRequired(request);
        return {
          content: [
            {
              type: "text",
              text: formatPermissionDecision(decision),
            },
          ],
          details: decision,
        };
      },
    });
  };
}

function parsePermissionRequestToolParams(
  toolCallId: string,
  params: unknown,
  options: PiRunnerRunOptions,
): PiRunnerPermissionRequest {
  if (!isRecord(params)) {
    throw new Error("request_permission parameters must be an object.");
  }
  const requestKind = readPermissionRequestKind(params.requestKind);
  const reason = readRequiredString(params, "reason");
  const requestedScope = readPermissionScope(params.requestedScope, requestKind);
  return {
    toolCallId,
    requestKind,
    reason,
    requestedScope,
    task: options.task,
    cwd: options.cwd,
  };
}

function readPermissionRequestKind(value: unknown): PiRunnerPermissionRequestKind {
  if (value === "core_tool" || value === "write_scope" || value === "mcp_tool" || value === "runner_capability") {
    return value;
  }
  throw new Error(`Unsupported permission request kind: ${String(value)}.`);
}

function readPermissionScope(value: unknown, requestKind: PiRunnerPermissionRequestKind): PiRunnerPermissionScope {
  if (!isRecord(value)) {
    throw new Error("requestedScope must be an object.");
  }
  const kind = readPermissionRequestKind(value.kind);
  if (kind !== requestKind) {
    throw new Error(`requestedScope.kind ${kind} does not match requestKind ${requestKind}.`);
  }
  if (kind === "core_tool") {
    const tools = readStringArray(value.tools).map(readBuiltinToolName);
    if (tools.length === 0) {
      throw new Error("core_tool requestedScope requires at least one tool.");
    }
    return { kind, tools };
  }
  if (kind === "write_scope") {
    const paths = readStringArray(value.paths);
    if (paths.length === 0) {
      throw new Error("write_scope requestedScope requires at least one path.");
    }
    return {
      kind,
      paths,
      operation: readWriteScopeOperation(value.operation),
    };
  }
  if (kind === "mcp_tool") {
    return {
      kind,
      serverId: readRequiredString(value, "serverId"),
      toolName: readRequiredString(value, "toolName"),
      sideEffectLevel: readRequiredString(value, "sideEffectLevel"),
      defaultApproval: readRequiredString(value, "defaultApproval"),
    };
  }
  return {
    kind,
    runnerId: readRequiredString(value, "runnerId"),
    capability: readRequiredString(value, "capability"),
  };
}

function readBuiltinToolName(value: string): PiRunnerBuiltinToolName {
  if ((DEFAULT_TOOLS as readonly string[]).includes(value)) {
    return value as PiRunnerBuiltinToolName;
  }
  throw new Error(`Unsupported core tool: ${value}.`);
}

function readWriteScopeOperation(value: unknown): "read_write" | "create" | "update" | "delete" {
  if (value === "read_write" || value === "create" || value === "update" || value === "delete") {
    return value;
  }
  throw new Error(`Unsupported write-scope operation: ${String(value)}.`);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function formatPermissionDecision(decision: PiRunnerPermissionDecision): string {
  if (!decision.approved) {
    return decision.reason ?? "Ling Stack denied the runtime permission request.";
  }
  const mode = decision.grant?.mode ?? "continuation";
  const suffix = mode === "same_run"
    ? "The grant is available to the current run."
    : "The grant is recorded for a continuation; the active tool registry was not changed.";
  return [decision.reason ?? "Ling Stack approved the runtime permission request.", suffix].join(" ");
}

function createLingStackFileMutationToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const originalEdit = createEditToolDefinition(options.cwd) as ToolDefinition;
    const originalWrite = createWriteToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "edit",
      label: "edit",
      description: `${originalEdit.description} You may also provide patchText with a Codex-compatible apply-patch envelope for multi-file edits.`,
      parameters: createPatchableEditParameters(originalEdit.parameters),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const decision = await requireFileMutationApproval(options, "edit", toolCallId, params);
        if (decision.handledResult) {
          return normalizeHandledToolResult(decision.handledResult);
        }
        return originalEdit.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: originalEdit.renderCall,
      renderResult: originalEdit.renderResult,
      renderShell: originalEdit.renderShell,
    });

    pi.registerTool({
      name: "write",
      label: "write",
      description: `${originalWrite.description} For structured multi-file changes, provide patchText with a Codex-compatible apply-patch envelope.`,
      parameters: createPatchableWriteParameters(originalWrite.parameters),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const decision = await requireFileMutationApproval(options, "write", toolCallId, params);
        if (decision.handledResult) {
          return normalizeHandledToolResult(decision.handledResult);
        }
        return originalWrite.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: originalWrite.renderCall,
      renderResult: originalWrite.renderResult,
      renderShell: originalWrite.renderShell,
    });
  };
}

async function requireFileMutationApproval(
  options: PiRunnerRunOptions,
  toolName: "edit" | "write",
  toolCallId: string,
  input: unknown,
): Promise<PiRunnerApprovalDecision> {
  if (!options.onApprovalRequired) {
    throw new Error(`Ling Stack blocked ${toolName}: no approval handler is configured.`);
  }
  const decision = await options.onApprovalRequired({
    toolCallId,
    toolName,
    input,
    task: options.task,
    cwd: options.cwd,
  });
  if (!decision.approved) {
    throw new Error(decision.reason ?? `Ling Stack approval denied ${toolName}.`);
  }
  return decision;
}

function normalizeHandledToolResult(result: PiRunnerToolHandledResult): AgentToolResult<any> {
  if (result.isError) {
    throw new Error(formatHandledToolError(result));
  }
  return {
    content: normalizeMcpToolResultContent(result.content),
    details: result.details,
  };
}

function formatHandledToolError(result: PiRunnerToolHandledResult): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Ling Stack handled tool call failed.";
}

function createPatchableEditParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  return mergePatchParameters(original, [
    { required: ["path", "edits"] },
    { required: ["patchText"] },
    { required: ["patch"] },
  ]);
}

function createPatchableWriteParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  return mergePatchParameters(original, [
    { required: ["path", "content"] },
    { required: ["patchText"] },
    { required: ["patch"] },
  ]);
}

function mergePatchParameters(
  original: ToolDefinition["parameters"],
  anyOf: readonly { readonly required: readonly string[] }[],
): ToolDefinition["parameters"] {
  const base = isRecord(original) ? original : {};
  const { required: _required, ...rest } = base;
  const properties = isRecord(base.properties) ? base.properties : {};
  return {
    ...rest,
    type: "object",
    properties: {
      ...properties,
      patchText: {
        type: "string",
        description: "Codex-compatible apply-patch text beginning with *** Begin Patch.",
      },
      patch: {
        type: "string",
        description: "Alias for patchText.",
      },
    },
    anyOf,
  } as ToolDefinition["parameters"];
}

function createLingStackMcpProxyExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    for (const tool of options.mcpTools ?? []) {
      const definition: ToolDefinition = {
        name: tool.registeredName,
        label: tool.displayName,
        description: tool.description ?? `Call MCP tool ${tool.rawName} from ${tool.serverId}.`,
        promptSnippet: `Call MCP tool ${tool.displayName}`,
        parameters: normalizeMcpToolParameters(tool.inputSchema),
        executionMode: tool.sideEffectLevel === "read" ? "parallel" : "sequential",
        execute: async (toolCallId, params, signal) => {
          if (!options.onMcpToolCall) {
            throw new Error(`MCP tool ${tool.rawName} is not connected in this runner.`);
          }
          if (options.onApprovalRequired) {
            const decision = await options.onApprovalRequired({
              toolCallId,
              toolName: tool.registeredName,
              input: params,
              task: options.task,
              cwd: options.cwd,
              defaultApproval: tool.defaultApproval,
            });
            if (!decision.approved) {
              throw new Error(decision.reason ?? `MCP tool ${tool.rawName} was denied by Ling Stack approval policy.`);
            }
          } else if (tool.defaultApproval !== "allow") {
            throw new Error(`MCP tool ${tool.rawName} requires approval but no approval handler is configured.`);
          }

          const result = await options.onMcpToolCall({
            toolCallId,
            registeredName: tool.registeredName,
            serverId: tool.serverId,
            rawName: tool.rawName,
            input: params,
            task: options.task,
            cwd: options.cwd,
            defaultApproval: tool.defaultApproval,
          });
          if (result.isError) {
            throw new Error(formatMcpToolError(result));
          }
          return {
            content: normalizeMcpToolResultContent(result.content),
            details: {
              serverId: tool.serverId,
              rawName: tool.rawName,
              result: result.details,
            },
          };
        },
      };
      pi.registerTool(definition);
    }
  };
}

function isApprovalToolName(toolName: string): toolName is PiRunnerApprovalToolName {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
}

function normalizeMcpToolParameters(inputSchema: unknown): ToolDefinition["parameters"] {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema as ToolDefinition["parameters"];
  }
  return {
    type: "object",
    properties: {},
    required: [],
  } as ToolDefinition["parameters"];
}

function normalizeMcpToolResultContent(
  content: PiRunnerMcpToolCallResult["content"],
): (TextContent | ImageContent)[] {
  const normalized: (TextContent | ImageContent)[] = [];
  for (const item of content) {
    if (item.type === "text") {
      normalized.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      normalized.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return normalized.length > 0 ? normalized : [{ type: "text", text: "MCP tool completed without textual output." }];
}

function formatMcpToolError(result: PiRunnerMcpToolCallResult): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "MCP tool returned an error.";
}

function getLingStackSystemPrompt(options: PiRunnerRunOptions): string {
  return (
    options.systemPrompt ??
    [
      "You are running inside Ling Stack as a scoped AI teammate.",
      "Work on the assigned task only.",
      "Use tools when they materially improve correctness.",
      "Keep outputs concise and leave an auditable trail through tool calls.",
    ].join("\n")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTaskPrompt(task: PiRunnerTask): string {
  const lines = [`Task: ${task.title}`, "", task.prompt];
  if (task.channelId) {
    lines.unshift(`Channel: ${task.channelId}`, "");
  }
  return lines.join("\n");
}

function translatePiEvent(event: AgentSessionEvent): PiRunnerEvent | undefined {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        return { type: "assistant_text_delta", text: event.assistantMessageEvent.delta };
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return { type: "assistant_thinking_delta", text: event.assistantMessageEvent.delta };
      }
      return undefined;
    case "message_end":
      return { type: "message_end", role: getMessageRole(event.message) };
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return undefined;
  }
}

function getMessageRole(message: unknown): string {
  if (typeof message === "object" && message !== null && "role" in message) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") {
      return role;
    }
  }
  return "unknown";
}

export type PiModel = Model<Api>;
