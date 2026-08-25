import type {
  Channel,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { RunnerRegistry } from "../../../runtime/runners.js";
import { extractAssistantText } from "../../../shared/assistant-text.js";
import { resolveProviderForRun } from "../../runs/providers.js";
import {
  parseContextSegmentProposal,
  type ContextSegmentationBootstrapView,
  type ProposeContextSegment,
} from "./context-segmentation-policy.js";

export function createModelContextSegmentProposer(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly runnerRegistry: RunnerRegistry | undefined;
  readonly secretResolver: SecretResolver;
  readonly requestedProviderPresetId?: string;
}): ProposeContextSegment | undefined {
  if (!input.runnerRegistry) return undefined;
  const providerPresetId = resolveSegmentationProviderPresetId(input);
  if (!providerPresetId) return undefined;
  return async (view, signal) => {
    const runner = input.runnerRegistry!.resolve({ tools: [], allowFallback: true }).runner;
    const provider = resolveProviderForRun(input.store, {
      cwd: input.store.paths.cwd,
      workspaceCwd: input.store.paths.cwd,
      providerPresetId,
      tools: [],
      thinkingLevel: "low",
      task: {
        id: view.sourceItemId,
        title: `Context segmentation in ${input.channel.name}`,
        prompt: renderContextSegmentationPrompt(input.channel, view),
        channelId: input.channel.id,
      },
    }, input.secretResolver);
    const deltas: string[] = [];
    const result = await runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      provider,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: "You are Ling's context segmentation policy proposer. Return strict JSON only and use only supplied ids.",
      task: {
        id: view.sourceItemId,
        title: `Context segmentation in ${input.channel.name}`,
        prompt: renderContextSegmentationPrompt(input.channel, view),
        channelId: input.channel.id,
      },
      signal,
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") deltas.push(event.text);
      },
    });
    const text = deltas.join("").trim() || extractAssistantText(result.messages) || "";
    return parseContextSegmentProposal(text);
  };
}

function resolveSegmentationProviderPresetId(input: {
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

function renderContextSegmentationPrompt(
  channel: Channel,
  view: ContextSegmentationBootstrapView,
): string {
  return [
    "Choose which context segment should govern the current turn.",
    "A segment groups prior goals, decisions, constraints, questions, and evidence that should be considered together.",
    "Create a new segment only when carrying the current segment's goal or decisions forward would mislead the next response.",
    "Return exactly one JSON object using one of these shapes:",
    '{"action":"continue","segmentId":"server-id","antecedentTurnId":"optional-server-turn-id","confidence":0.0,"evidenceItemIds":["server-item-id"]}',
    '{"action":"switch_existing","segmentId":"server-id","antecedentTurnId":"optional-server-turn-id","confidence":0.0,"evidenceItemIds":["server-item-id"]}',
    '{"action":"propose_new","confidence":0.0,"relatedSegmentIds":["server-id"],"reason":"short reason"}',
    '{"action":"uncertain","candidateSegmentIds":["server-id"]}',
    "Use only segment, turn, and item ids supplied below. Do not invent ids.",
    `Channel: ${channel.name}`,
    `Current turn: ${view.currentBody}`,
    `Explicit refs JSON: ${JSON.stringify(view.explicitRefs)}`,
    `Candidate segment cards JSON: ${JSON.stringify(view.candidates)}`,
  ].join("\n");
}
