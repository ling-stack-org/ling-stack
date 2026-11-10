import { getCurrentSystemPrompt, getCurrentTools, normalizeContext, type Context, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { isRecord } from "./utils.js";

/** Public Context shorthand is normalized exactly once at our provider boundary. */
export function piTranscript(context: Context): TranscriptContext {
  return normalizeContext(context);
}

/** System authority is carried separately in Ling's version-one prepared receipt. */
export function piConversation(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role !== "system");
}

/**
 * Retain Ling's conversation-only checkpoint format, but never silently discard
 * a later prompt/tool update. Every system delta must replay to the same frozen
 * authority; unsupported dynamic authority changes fail before checkpointing.
 */
export function frozenPiConversation(messages: readonly unknown[], authority: {
  readonly systemPrompt: string;
  readonly tools: readonly unknown[];
}): readonly unknown[] {
  let sawSystem = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "system") continue;
    if (!sawSystem && index !== 0) throw new Error("Pi checkpoint has no leading system authority");
    sawSystem = true;
    const prefix = messages.slice(0, index + 1) as Message[];
    if (getCurrentSystemPrompt(prefix) !== authority.systemPrompt
      || JSON.stringify(getCurrentTools(prefix)) !== JSON.stringify(authority.tools)) {
      throw new Error("Pi checkpoint changed frozen system or tool authority");
    }
  }
  if (messages.length > 0 && !sawSystem) throw new Error("Pi checkpoint has no leading system authority");
  return messages.filter((message) => !isRecord(message) || message.role !== "system");
}
