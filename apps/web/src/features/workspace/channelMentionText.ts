import type { ChannelMention } from "../../types.js";

export function findMentionsInText(body: string, teammates: readonly ChannelMention[]): readonly ChannelMention[] {
  return teammates.filter((teammate) => mentionTokenExistsInText(body, teammate));
}

export function mergeMentions(
  current: readonly ChannelMention[],
  detected: readonly ChannelMention[],
): readonly ChannelMention[] {
  const seen = new Set<string>();
  return [...current, ...detected].filter((mention) => {
    if (seen.has(mention.id)) {
      return false;
    }
    seen.add(mention.id);
    return true;
  });
}

export function mentionTokenExistsInText(body: string, mention: ChannelMention): boolean {
  return mentionAliases(mention).some((token) => {
    const escaped = escapeRegExp(token.trim());
    if (!escaped) {
      return false;
    }
    return new RegExp(`(^|[\\s,.;:!?，。！？；：、（）()【】\\[\\]])@${escaped}(?=$|[\\s,.;:!?，。！？；：、（）()【】\\[\\]])`, "iu").test(body);
  });
}

function mentionAliases(mention: Pick<ChannelMention, "id" | "label">): readonly string[] {
  return uniqueStrings([
    mention.label.trim(),
    mention.id.trim(),
    normalizeComposerToken(mention.label),
    normalizeComposerToken(mention.id),
  ]).filter(Boolean);
}

function normalizeComposerToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
