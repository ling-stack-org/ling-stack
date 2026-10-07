import type { Context, Message, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  PiRunnerApprovedToolContinuation,
  PiRunnerProviderConfig,
} from "./types.js";
import { readPreparedPiInput, type PiRunnerPreparedInput } from "./prepared-input.js";
import { boundModelToolResults } from "./model-context-budget.js";
import { isRecord } from "./utils.js";

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

/** Validate Host-provided continuation evidence before it enters model context. */
export function readApprovedToolContinuation(value: unknown): PiRunnerApprovedToolContinuation {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "approved_tool_result"
    || !nonEmpty(value.approvalId)
    || !nonEmpty(value.sideEffectFingerprint)
    || !nonEmpty(value.toolCallId)
    || !nonEmpty(value.toolName)
    || !isRecord(value.args)
    || value.assistantText !== undefined && typeof value.assistantText !== "string"
    || !isRecord(value.result)
    || !Array.isArray(value.result.content)
    || value.result.content.some((block) => !validContentBlock(block))
    || value.result.isError !== undefined && typeof value.result.isError !== "boolean"
    || Object.keys(value).some((key) => ![
      "schemaVersion", "kind", "approvalId", "sideEffectFingerprint", "toolCallId", "toolName",
      "args", "result", "assistantText",
    ].includes(key))) {
    throw new Error("Invalid approved tool continuation evidence");
  }
  return deepFreeze(structuredClone(value) as unknown as PiRunnerApprovedToolContinuation);
}

/** Seed the exact interrupted turn into an empty Pi session. */
export function installApprovedToolContinuation(
  session: AgentSession,
  prepared: PiRunnerPreparedInput,
  provider: PiRunnerProviderConfig,
  continuation: PiRunnerApprovedToolContinuation,
): void {
  if (!session.isIdle || session.messages.length !== 0) {
    throw new Error("Approved tool continuation requires an idle empty Pi session");
  }
  session.state.messages = createApprovedToolContinuationMessages(prepared, provider, continuation);
}

/** Verify the first resumed provider request against the durable reconstructed transcript. */
export function assertApprovedToolContinuationModelContext(
  prepared: PiRunnerPreparedInput,
  provider: PiRunnerProviderConfig,
  continuation: PiRunnerApprovedToolContinuation,
  model: Model<any>,
  context: Context,
): void {
  const expected = boundModelToolResults(
    createApprovedToolContinuationMessages(prepared, provider, continuation),
  ).messages as Message[];
  if (context.systemPrompt !== readPreparedPiInput(prepared).systemPrompt
    || model.id !== prepared.model.id
    || model.provider !== prepared.model.provider
    || JSON.stringify(context.messages) !== JSON.stringify(expected)) {
    throw new Error("Pi approved tool continuation changed before the first model request");
  }
}

function createApprovedToolContinuationMessages(
  preparedValue: PiRunnerPreparedInput,
  provider: PiRunnerProviderConfig,
  continuationValue: PiRunnerApprovedToolContinuation,
): Message[] {
  const prepared = readPreparedPiInput(preparedValue);
  const continuation = readApprovedToolContinuation(continuationValue);
  const timestamp = 0;
  const assistantContent: Extract<Message, { role: "assistant" }>["content"] = [
    ...(continuation.assistantText
      ? [{ type: "text" as const, text: continuation.assistantText }]
      : []),
    {
      type: "toolCall" as const,
      id: continuation.toolCallId,
      name: continuation.toolName,
      arguments: structuredClone(continuation.args) as Record<string, unknown>,
    },
  ];
  return [
    { role: "user", content: [{ type: "text", text: prepared.userPrompt }], timestamp },
    {
      role: "assistant",
      content: assistantContent,
      api: provider.api ?? "openai-completions",
      provider: provider.provider,
      model: provider.model,
      usage: EMPTY_USAGE,
      stopReason: "toolUse",
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId: continuation.toolCallId,
      toolName: continuation.toolName,
      content: [...structuredClone(continuation.result.content)],
      details: structuredClone(continuation.result.details),
      isError: continuation.result.isError === true,
      timestamp,
    },
  ];
}

function validContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
