import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { fetchProvider } from "@ling-stack/runner-pi";
import type { LearningEvidenceBundle } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { LEARNING_SYSTEM_PROMPT, parseLearningDraft, type LearningDraft } from "./extractor.js";

export function prepareLearningModelRequest(evidence: LearningEvidenceBundle): { readonly prompt: string; readonly inputTokens: number } {
  const prompt = JSON.stringify(evidence);
  // UTF-8 bytes upper-bound ordinary tokenizer input. Reserve the full system+evidence request before dispatch.
  const inputTokens = Buffer.byteLength(LEARNING_SYSTEM_PROMPT) + Buffer.byteLength(prompt) + 256;
  if (inputTokens > 16_000) throw new Error("learning_input_over_budget");
  return { prompt, inputTokens };
}

/** One exact HTTP request, no agent loop, tools, sessions or hidden retries. */
export async function executeLearningModel(input: {
  readonly provider: PiRunnerProviderConfig;
  readonly evidence: LearningEvidenceBundle;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly outputTokens?: number;
}): Promise<LearningDraft> {
  const provider = input.provider;
  if (provider.api !== "openai-completions" || !provider.baseUrl || provider.reasoning) throw new Error("learning_provider_unsupported");
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = new Headers(provider.headers);
  headers.set("content-type", "application/json");
  if (provider.authHeader !== false && provider.apiKey) headers.set("authorization", `Bearer ${provider.apiKey}`);
  input.signal.throwIfAborted();
  const response = await fetchProvider(endpoint, { method: "POST", redirect: "error", headers, signal: input.signal,
    body: JSON.stringify({ model: provider.model, stream: false, max_tokens: input.outputTokens ?? 2048,
      messages: [{ role: "system", content: LEARNING_SYSTEM_PROMPT }, { role: "user", content: input.prompt }] }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`learning_provider_http_${response.status}`); }
  const value: unknown = JSON.parse(await readLearningResponse(response));
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1 || !isRecord(value.choices[0])) throw new Error("learning_provider_output_invalid");
  const choice = value.choices[0];
  if (choice.finish_reason !== "stop" || !isRecord(choice.message) || typeof choice.message.content !== "string" ||
    (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) || choice.message.function_call) throw new Error("learning_provider_output_invalid");
  input.signal.throwIfAborted();
  return parseLearningDraft(choice.message.content, input.evidence);
}

async function readLearningResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("learning_provider_output_empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) throw new Error("learning_provider_output_over_budget");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
