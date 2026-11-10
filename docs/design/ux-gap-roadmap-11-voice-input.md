# Voice Input

## Status

Status: design approved for implementation
Owner: Web / Mobile / Conversation UI
Last verified: 2026-10-26

## Background and competitive reference

Voice input is table stakes on office/mobile assistants (WorkBuddy, mobile
agents). Ling's composer is text/attachment only; on mobile — where typing is
worst — the composer is explicitly plain-text. No cloud ASR dependency is
acceptable for this repo's provider posture, and none is needed: browsers
ship capable speech recognition.

## Goal

Hold-to-talk / click-to-talk mic button in the conversation composer on web
(desktop shell included) and mobile, producing editable transcript text in
the composer — the user reviews/edits before sending. Voice is an *input
method*, never an auto-send.

## Design

### 1. Engine selection, bounded and local-first

- **Web Speech API** (`SpeechRecognition`) where available (Chrome/Edge
  desktop, Android Chrome, Safari): zero new dependencies; note the Chrome
  implementation sends audio to Google servers — therefore it is *not* the
  default-off stealth dependency; we gate it behind an explicit "enable voice
  input" preference with a plain-language disclosure per browser engine.
- **Local Whisper (optional, later phase)**: a daemon-side `whisper.cpp`
  adapter behind the same `VoiceTranscriber` interface, for users who want
  on-device. Interface is defined now so the later addition is additive.
- No audio ever persisted: recording buffer lives in the page only; on
  cancel/abort the buffer is dropped. No microphone permission request until
  the user presses the mic button.

### 2. Contracts and UX flow

```ts
export interface VoiceTranscriber { start(locale: string): void; stop(): Promise<VoiceTranscript>; cancel(): void; }
export interface VoiceTranscript { text: string; interimSupported: boolean; engine: "web_speech" | "whisper_local"; }
```

- Composer gains a mic button (existing `ui2` icon set) → permission prompt on
  first use → recording state (timer, waveform-free, privacy-first: no
  visualization that implies server processing) → interim text renders in a
  *distinct* composable state (italic + "dictating" badge) → final transcript
  **appends to** the composer draft (multi-shot: press again to append).
- i18n: all strings through `@ling-stack/localization` (en-US + zh-CN catalogs).
- The authorization model is untouched: dictation produces text, the send
  action follows every existing rule.

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Composer attachment uploads | orthogonal | Voice writes to the draft text state only; attachment strip untouched. |
| Mobile plain-text composer | extended | Same interface behind a platform adapter; where `SpeechRecognition` is unavailable the button hides (capability probe), keeping mobile QA surface unchanged. |
| Slash commands | reused | Dictated text lands in the draft before command parsing, so "/run daily brief" by voice works with zero new code. |
| Personalization/settings | additive | One preference: `voiceInput: "off" | "web_speech" | "auto"` (default `auto` = engine present → enabled after first-use consent). |

### 4. Incompatible-case upgrade path

Browser API drift is the only real risk; the capability probe
(`typeof webkitSpeechRecognition !== "undefined" || typeof SpeechRecognition !== "undefined"`)
gates usage, and a Whisper local adapter slots behind `VoiceTranscriber`
without touching UI. If interim results deprecate, `interimSupported: false`
degrades to stop-then-transcribe.

## Implementation plan

1. Contracts: `VoiceTranscriber`/`VoiceTranscript` types + preference field.
2. Web: `use-voice-dictation.ts` hook (probe, lifecycle, interim state,
   error taxonomy: `denied` | `no_speech` | `unsupported`), mic button +
   dictating badge in `NormalConversationFeed`/channel composer.
3. Mobile: same hook behind Expo `expo-speech`-capable probe (fallback: hide).
4. Tests: hook unit tests (mocked recognizer: append semantics, cancel drops
   buffer, denied error surface), Playwright spec with a stubbed
   `SpeechRecognition`: dictate → draft text appears → send, screenshot
   evidence of dictating badge.

## Acceptance

- Mic button dictates into the draft (stubbed recognizer) and never
  auto-sends; denied permission shows the specific recovery message (tests).
- Voice hidden entirely when engine absent (unit test).
- Existing composer suites stay green.
