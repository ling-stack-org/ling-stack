/**
 * Voice dictation state machine (ux-gap-roadmap-11).
 *
 * Pure logic so lifecycle rules are unit-testable without a browser:
 * - dictation is an input method only: it appends to the composer draft and
 *   never sends;
 * - transcript text appends to the existing draft with a single space;
 * - recognition errors map to a closed taxonomy with distinct recovery copy.
 */

export type VoiceDictationStatus = "idle" | "recording" | "finalizing";

export type VoiceDictationError = "denied" | "no_speech" | "unsupported" | "aborted" | "network";

export const VOICE_DICTATION_ENGINE = "web_speech" as const;

export interface VoiceDictationSnapshot {
  readonly status: VoiceDictationStatus;
  readonly interim: string;
  readonly error?: VoiceDictationError;
}

export function voiceRecognitionSupported(target: {
  readonly SpeechRecognition?: unknown;
  readonly webkitSpeechRecognition?: unknown;
}): boolean {
  return target.SpeechRecognition !== undefined || target.webkitSpeechRecognition !== undefined;
}

export function appendDictation(draft: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return draft;
  if (draft.length === 0) return trimmed;
  return `${draft} ${trimmed}`;
}

export function mapRecognitionErrorCode(code: string | undefined): VoiceDictationError {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "no-speech":
      return "no_speech";
    case "aborted":
      return "aborted";
    case "network":
      return "network";
    default:
      return "unsupported";
  }
}

export function reduceVoiceDictation(
  state: VoiceDictationSnapshot,
  action:
    | { type: "start" }
    | { type: "interim"; text: string }
    | { type: "final"; text: string }
    | { type: "stop" }
    | { type: "error"; code?: string }
    | { type: "reset" },
): VoiceDictationSnapshot {
  switch (action.type) {
    case "start":
      return { status: "recording", interim: "" };
    case "interim":
      return state.status === "recording" ? { ...state, interim: action.text } : state;
    case "final":
      return { ...state, interim: "" };
    case "stop":
      return state.status === "recording" ? { ...state, status: "finalizing" } : state;
    case "error":
      return { status: "idle", interim: "", error: mapRecognitionErrorCode(action.code) };
    case "reset":
      return { status: "idle", interim: "" };
  }
}

export function voiceErrorMessage(error: VoiceDictationError, t: (key: string) => string): string {
  switch (error) {
    case "denied":
      return t("Microphone access was denied. Enable it in your browser settings to dictate.");
    case "no_speech":
      return t("No speech detected. Try again.");
    case "aborted":
      return t("Dictation stopped.");
    case "network":
      return t("Dictation service is unreachable. Check your connection.");
    case "unsupported":
      return t("Voice input is not supported in this browser.");
  }
}
