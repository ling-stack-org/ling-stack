import { join } from "node:path";
import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { RunnerExtensionMetadata } from "@ling-stack/plugin-sdk";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ResourceLoader,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export type PiRunnerToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
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
}

export interface PiRunnerApprovalDecision {
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly reason?: string;
}

export interface PiRunnerRunOptions {
  readonly cwd: string;
  readonly task: PiRunnerTask;
  readonly provider: PiRunnerProviderConfig;
  readonly tools?: readonly PiRunnerToolName[];
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PiRunnerEvent) => void;
  readonly onApprovalRequired?: (
    request: PiRunnerApprovalRequest,
  ) => PiRunnerApprovalDecision | Promise<PiRunnerApprovalDecision>;
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

const DEFAULT_TOOLS: readonly PiRunnerToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
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

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: [...(options.tools ?? DEFAULT_TOOLS)],
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
    extensionFactories: [createLingStackApprovalExtension(options)],
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

function isApprovalToolName(toolName: string): toolName is PiRunnerApprovalToolName {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
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
