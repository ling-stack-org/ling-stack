import type { Channel, ChannelMention, RunStore } from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { teammateCanWorkInEffectiveChannel } from "./channel-teammate-availability.js";

export interface CanonicalMentionMaterialization {
  readonly mentions: readonly ChannelMention[];
  readonly materializedFromTextIds: readonly string[];
  readonly unavailableTeammateIds: readonly string[];
}

export function materializeCanonicalChannelMentions(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly body: string;
  readonly submittedMentions: readonly ChannelMention[];
}): CanonicalMentionMaterialization {
  const selected = new Map<string, ChannelMention>();
  const unavailableTeammateIds: string[] = [];
  for (const mention of input.submittedMentions) {
    const available = validateSubmittedMention(input.store, input.channel, mention);
    const canonical = canonicalMention(input.store, mention);
    selected.set(mentionKey(canonical), canonical);
    if (!available && canonical.kind === "ai-teammate") unavailableTeammateIds.push(canonical.id);
  }

  const materializedFromTextIds: string[] = [];
  for (const teammate of listAllKnownTeammates(input.store)) {
    const mention: ChannelMention = { id: teammate.id, label: teammate.displayName, kind: "ai-teammate" };
    const key = mentionKey(mention);
    if (selected.has(key) || !mentionTokenExistsInText(input.body, teammate.id, teammate.displayName)) continue;
    selected.set(key, mention);
    materializedFromTextIds.push(teammate.id);
    if (teammate.status !== "active"
      || teammate.hidden
      || !teammateCanWorkInEffectiveChannel(input.store, input.channel, teammate.id)) {
      unavailableTeammateIds.push(teammate.id);
    }
  }
  return { mentions: [...selected.values()], materializedFromTextIds, unavailableTeammateIds: [...new Set(unavailableTeammateIds)] };
}

function listAllKnownTeammates(store: RunStore): ReturnType<RunStore["listAiTeammates"]> {
  const pageSize = 500;
  const teammates: ReturnType<RunStore["listAiTeammates"]> = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = store.listAiTeammates({
      includeHidden: true,
      includeDisabled: true,
      limit: pageSize,
      offset,
    });
    teammates.push(...page);
    if (page.length < pageSize) return teammates;
  }
}

export function mentionTokenExistsInText(body: string, id: string, label: string): boolean {
  return mentionAliases(id, label).some((token) => {
    const escaped = escapeRegExp(token);
    return escaped.length > 0 && new RegExp(
      `(^|[\\s,.;:!?，。！？；：、（）()【】\\[\\]])@${escaped}(?=$|[\\s,.;:!?，。！？；：、（）()【】\\[\\]])`,
      "iu",
    ).test(body);
  });
}

function validateSubmittedMention(store: RunStore, channel: Channel, mention: ChannelMention): boolean {
  if (mention.kind !== "ai-teammate") return true;
  const teammate = resolveAiTeammateReference(store, mention.id);
  if (!teammate) {
    throw new Error(`mention_materialization_incomplete: unknown teammate ${mention.id}`);
  }
  return teammate.status === "active"
    && !teammate.hidden
    && teammateCanWorkInEffectiveChannel(store, channel, teammate.id);
}

function canonicalMention(store: RunStore, mention: ChannelMention): ChannelMention {
  if (mention.kind !== "ai-teammate") return mention;
  const teammate = resolveAiTeammateReference(store, mention.id);
  return { id: teammate?.id ?? mention.id, label: teammate?.displayName ?? mention.label, kind: mention.kind };
}

function mentionAliases(id: string, label: string): readonly string[] {
  return [...new Set([label.trim(), id.trim(), normalizeComposerToken(label), normalizeComposerToken(id)])].filter(Boolean);
}

function normalizeComposerToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function mentionKey(mention: ChannelMention): string {
  return `${mention.kind}:${mention.id}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
