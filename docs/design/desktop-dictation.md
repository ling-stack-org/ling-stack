# Desktop dictation design

Ling Desktop provides speech-to-text as an input method for the existing conversation composers. It is an input transformation, not a voice conversation mode: the microphone stream is recorded locally, sent to a separately configured ASR provider, and the returned text is inserted into the composer at the current caret.

## Scope and target

The MVP target is a usable Desktop flow for both normal conversations and channel conversations:

- a microphone button is present in the Desktop composer;
- holding the button records until release, while keyboard activation supports the same flow;
- recording, transcription, failure, and cancellation have visible state;
- the transcript is inserted into the current draft and is never sent automatically;
- the same path works for normal conversations and channels;
- the mobile client and real-time bidirectional voice are outside this target.

The completion target is the code path, provider contract, focused tests, and package validation. Real microphone permission and provider acceptance remain a Desktop field check because CI has no microphone or user-configured ASR credential.

## Runtime flow

```text
Desktop composer
  -> navigator.mediaDevices.getUserMedia({ audio: true })
  -> MediaRecorder (short local Blob)
  -> POST /transcribe?cwd=... (multipart/form-data)
  -> daemon resolves enabled provider with capability asr
  -> provider /audio/transcriptions
  -> { text }
  -> insert text at the composer caret
```

The Web UI does not call a ChatGPT private endpoint and does not pass the current chat model to the ASR request. Any downstream chat model can consume the resulting text: GPT, Claude, Gemini, domestic compatible models, or a local model. The ASR provider is configured independently in Model Workbench by selecting the OpenAI Whisper template or a compatible preset and retaining the `asr` capability.

## Provider contract

The daemon selects an explicitly requested provider preset when supplied; otherwise it uses the most recently updated enabled preset whose capabilities include `asr`. The MVP adapter accepts the existing `openai-completions` provider protocol and sends:

- `file`: the recorded audio Blob and its filename;
- `model`: the provider preset model;
- `language` and `prompt`: optional form fields;
- `Authorization` and configured provider headers: materialized by the existing secret resolver.

The provider base URL is normalized before appending `/audio/transcriptions`. The response must contain a non-empty string `text`. Provider errors are redacted before reaching the UI. Audio is bounded to 25 MiB and is held in memory only for the request.

## UI state and interaction

The Desktop button is hidden outside the Desktop shell. Pointer down or keyboard Space/Enter starts recording; pointer up, cancel, window blur, or key release stops it. The button exposes `idle`, `recording`, and `transcribing` states. A failed permission, missing ASR provider, unsupported provider protocol, or provider error is shown as retryable inline button feedback. Escape cancels an active recording without sending audio.

The transcript is inserted at the selection range. Existing mentions, slash commands, attachments, and send/stop state remain owned by the composer; dictation only calls the existing draft-change callback.

## Data and permission boundaries

Microphone permission is requested only after the deliberate button or key action. The browser never persists the recording. The daemon receives only the completed Blob and forwards it to the configured ASR provider. API keys are resolved server-side through the existing provider secret materializer and are never exposed to the Web UI.

## Acceptance

Code acceptance covers the multipart contract, provider selection, URL normalization, secret-header handling, non-empty transcript validation, API-client request construction, and TypeScript checks for the daemon, API client, and Web UI. Desktop acceptance still requires an unlocked Desktop session, microphone permission, a configured `asr` provider, and a real short recording that appears in both composer surfaces.
