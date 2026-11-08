import { normalizeProviderBaseUrlForAdapter, type ProviderApi, type ProviderKind } from "@ling-stack/core";
import { readLimitedResponseText } from "../../shared/http.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export interface OpenAICompatibleTranscriptionInput {
  readonly provider: {
    readonly kind: ProviderKind;
    readonly api: ProviderApi;
    readonly baseUrl?: string;
    readonly model: string;
  };
  readonly audio: Blob;
  readonly filename: string;
  readonly headers?: Record<string, string>;
  readonly redactionValues?: readonly string[];
  readonly language?: string;
  readonly prompt?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class TranscriptionProviderError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionProviderError";
  }
}

export async function transcribeOpenAICompatibleAudio(input: OpenAICompatibleTranscriptionInput): Promise<string> {
  if (input.provider.api !== "openai-completions") {
    throw new TranscriptionProviderError(400, "unsupported_capability", "The selected ASR provider must use the OpenAI-compatible protocol.");
  }
  if (!input.provider.model.trim()) {
    throw new TranscriptionProviderError(400, "invalid_request", "The ASR provider model is empty.");
  }

  const form = new FormData();
  form.append("file", input.audio, input.filename || "recording.webm");
  form.append("model", input.provider.model);
  if (input.language?.trim()) {
    form.append("language", input.language.trim());
  }
  if (input.prompt?.trim()) {
    form.append("prompt", input.prompt.trim());
  }

  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-type"),
  );
  const fetchImpl = input.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new TranscriptionProviderError(503, "network_failed", "No fetch implementation is available for transcription.");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${normalizeProviderBaseUrlForAdapter(input.provider)}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TranscriptionProviderError(
      502,
      "network_failed",
      `ASR provider request failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), input.redactionValues)}`,
    );
  }

  const bodyText = redactTextWithSecrets(await readLimitedResponseText(response, 4_000), input.redactionValues);
  const body = parseJson(bodyText);
  if (!response.ok) {
    const statusCode = response.status === 401 || response.status === 403
      ? 401
      : response.status === 429
        ? 429
        : 502;
    throw new TranscriptionProviderError(
      statusCode,
      statusCode === 401 ? "auth_failed" : statusCode === 429 ? "rate_limited" : "provider_error",
      `ASR provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`,
    );
  }

  const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    throw new TranscriptionProviderError(502, "empty_transcript", "ASR provider returned an empty transcript.");
  }
  return text;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
