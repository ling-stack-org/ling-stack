import assert from "node:assert/strict";
import test from "node:test";
import {
  TranscriptionProviderError,
  transcribeOpenAICompatibleAudio,
} from "../dist/features/providers/transcription.js";

test("transcription adapter posts the recorded file to the normalized audio endpoint", async () => {
  let request;
  const text = await transcribeOpenAICompatibleAudio({
    provider: {
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://relay.example.test/v1/",
      model: "whisper-compatible",
    },
    audio: new Blob(["audio bytes"], { type: "audio/webm" }),
    filename: "recording.webm",
    headers: { Authorization: "Bearer secret", "x-tenant": "tenant-1", "content-type": "application/json" },
    language: " zh ",
    prompt: " meeting ",
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ text: "  transcribed text  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(text, "transcribed text");
  assert.equal(request.url, "https://relay.example.test/v1/audio/transcriptions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer secret");
  assert.equal(request.init.headers["x-tenant"], "tenant-1");
  assert.equal(request.init.headers["content-type"], undefined);
  assert.ok(request.init.body instanceof FormData);
  assert.equal(request.init.body.get("model"), "whisper-compatible");
  assert.equal(request.init.body.get("language"), "zh");
  assert.equal(request.init.body.get("prompt"), "meeting");
  const file = request.init.body.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.name, "recording.webm");
});

test("transcription adapter rejects empty transcripts and unsupported protocols", async () => {
  await assert.rejects(
    transcribeOpenAICompatibleAudio({
      provider: {
        kind: "openai-compatible",
        api: "openai-completions",
        baseUrl: "https://relay.example.test/v1",
        model: "whisper-compatible",
      },
      audio: new Blob(["audio"]),
      filename: "recording.webm",
      fetch: async () => new Response(JSON.stringify({ text: "   " }), { status: 200 }),
    }),
    (error) => error instanceof TranscriptionProviderError
      && error.statusCode === 502
      && error.code === "empty_transcript",
  );

  await assert.rejects(
    transcribeOpenAICompatibleAudio({
      provider: {
        kind: "openai-compatible",
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        model: "whisper-compatible",
      },
      audio: new Blob(["audio"]),
      filename: "recording.webm",
      fetch: async () => new Response("", { status: 200 }),
    }),
    (error) => error instanceof TranscriptionProviderError
      && error.statusCode === 400
      && error.code === "unsupported_capability",
  );

  await assert.rejects(
    transcribeOpenAICompatibleAudio({
      provider: {
        kind: "openai-compatible",
        api: "openai-completions",
        baseUrl: "https://relay.example.test/v1",
        model: "whisper-compatible",
      },
      audio: new Blob(["audio"]),
      filename: "recording.webm",
      redactionValues: ["provider-secret"],
      fetch: async () => new Response(JSON.stringify({ error: "provider-secret was rejected" }), { status: 500 }),
    }),
    (error) => error instanceof TranscriptionProviderError
      && error.code === "provider_error"
      && !error.message.includes("provider-secret")
      && error.message.includes("[REDACTED]"),
  );
});
