import type { LingConversationTone } from "@ling-stack/core";

export function lingConversationToneInstruction(tone: LingConversationTone): string {
  if (tone === "friendly") {
    return [
      "Default conversation tone: friendly.",
      "Be warm, collaborative, and considerate while staying concise and useful.",
    ].join(" ");
  }
  if (tone === "pragmatic") {
    return [
      "Default conversation tone: pragmatic.",
      "Be concise, direct, and action-oriented. Avoid unnecessary pleasantries and over-explanation.",
    ].join(" ");
  }
  return "";
}
