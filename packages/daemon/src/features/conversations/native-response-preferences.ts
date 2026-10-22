import { lingConversationTones, responseLanguages } from "@ling-stack/core";
import type { LingConversationTone, ResponseLanguagePreference } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";

/** Host-owned presentation preferences. These never claim system instruction authority. */
export interface NativeResponsePreferences {
  readonly tone: LingConversationTone;
  readonly language: ResponseLanguagePreference;
}

export function readNativeResponsePreferences(value: unknown): NativeResponsePreferences | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "tone") || !Object.hasOwn(value, "language")
    || !lingConversationTones.includes(value.tone as LingConversationTone)
    || value.language !== "follow_user" && !responseLanguages.includes(value.language as typeof responseLanguages[number])) {
    throw new Error("Invalid native response preferences");
  }
  return { tone: value.tone as LingConversationTone, language: value.language as ResponseLanguagePreference };
}
