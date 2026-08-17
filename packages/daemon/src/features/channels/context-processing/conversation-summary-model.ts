import type { Channel, RunStore, SecretResolver } from "@ling-stack/core";
import type { RunnerRegistry } from "../../../runtime/runners.js";
import { extractAssistantText } from "../../../shared/assistant-text.js";
import { resolveProviderForRun } from "../../runs/providers.js";
import { parseStrictJsonObject } from "../model-json.js";
import {
  renderSummaryItem,
  type ConversationSummaryDraft,
  type GenerateConversationSummary,
} from "./conversation-summary-coordinator.js";

export function createModelConversationSummaryGenerator(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly runnerRegistry: RunnerRegistry | undefined;
  readonly secretResolver: SecretResolver;
  readonly requestedProviderPresetId?: string;
}): GenerateConversationSummary | undefined {
  if (!input.runnerRegistry) return undefined;
  const providerPresetId = resolveSummaryProviderPresetId(input);
  if (!providerPresetId) return undefined;
  return async (request) => {
    const prompt = renderSummaryPrompt(request);
    const taskId = `${request.items[0]?.id ?? "empty"}:summary:${request.chunkIndex}`;
    const runner = input.runnerRegistry!.resolve({ tools: [], allowFallback: true }).runner;
    const provider = resolveProviderForRun(input.store, {
      cwd: input.store.paths.cwd,
      workspaceCwd: input.store.paths.cwd,
      providerPresetId,
      tools: [],
      thinkingLevel: "low",
      task: {
        id: taskId,
        title: `Conversation summary in ${input.channel.name}`,
        prompt,
        channelId: input.channel.id,
      },
    }, input.secretResolver);
    const deltas: string[] = [];
    const result = await runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      provider,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: [
        "You are Ling's conversation summary coordinator.",
        "Return one strict JSON object only.",
        "Preserve verified goals, decisions, constraints, and unresolved questions.",
        "Do not add hidden reasoning, secrets, unsupported facts, or ids not supplied in the input.",
      ].join(" "),
      task: {
        id: taskId,
        title: `Conversation summary in ${input.channel.name}`,
        prompt,
        channelId: input.channel.id,
      },
      signal: request.signal,
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") deltas.push(event.text);
      },
    });
    const text = deltas.join("").trim() || extractAssistantText(result.messages) || "";
    return parseSummaryDraft(parseStrictJsonObject(text, "Conversation summary model output"));
  };
}

function resolveSummaryProviderPresetId(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly requestedProviderPresetId?: string;
}): string | undefined {
  for (const providerPresetId of [...new Set([
    input.requestedProviderPresetId,
    input.channel.defaultProviderPresetId,
  ].filter((id): id is string => Boolean(id)))]) {
    const preset = input.store.getProviderPreset(providerPresetId);
    if (preset?.enabled && preset.capabilities.includes("chat")) return providerPresetId;
  }
  return undefined;
}

function renderSummaryPrompt(input: Parameters<GenerateConversationSummary>[0]): string {
  const perItemTokenBudget = Math.max(
    64,
    Math.floor(input.chunkTokenBudget * 0.7 / Math.max(input.items.length, 1)),
  );
  return [
    "Update the typed conversation summary with the supplied committed conversation items.",
    "The current summary may already represent older source ranges. Preserve still-current facts and apply explicit corrections from newer items.",
    `Keep the returned JSON within approximately ${input.outputTokenBudget} tokens. Order every array from most important to least important.`,
    "Return exactly this JSON shape:",
    '{"objective":"string or null","decisions":["..."],"constraints":["..."],"openQuestions":["..."]}',
    `Chunk: ${input.chunkIndex + 1}/${input.chunkCount}`,
    `Current typed summary JSON: ${JSON.stringify(input.current)}`,
    `Allowed source refs JSON: ${JSON.stringify(input.sourceRefs)}`,
    "Committed items:",
    ...input.items.map((item) => renderSummaryItem(item, perItemTokenBudget)),
  ].join("\n");
}

function parseSummaryDraft(value: Record<string, unknown>): ConversationSummaryDraft {
  const allowed = new Set(["objective", "decisions", "constraints", "openQuestions"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Conversation summary model output contains unknown field: ${key}`);
  }
  const objective = value.objective;
  if (objective !== undefined && objective !== null && typeof objective !== "string") {
    throw new Error("Conversation summary objective must be a string or null.");
  }
  return {
    ...(typeof objective === "string" && objective.trim() ? { objective: objective.trim() } : {}),
    decisions: readStringArray(value.decisions, "decisions"),
    constraints: readStringArray(value.constraints, "constraints"),
    openQuestions: readStringArray(value.openQuestions, "openQuestions"),
  };
}

function readStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Conversation summary ${key} must be a string array.`);
  }
  return value as string[];
}
