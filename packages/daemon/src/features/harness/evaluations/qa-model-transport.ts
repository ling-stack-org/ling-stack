import { createHash } from "node:crypto";
import { RUN_EVALUATION_SEVERITIES, RUN_EVALUATION_VERDICTS,
  type RunEvaluationQaTransportReceiptV1, type RunEvaluationSeverity, type RunEvaluationVerdict } from "@ling-stack/contracts";
import { fetchProvider } from "@ling-stack/runner-pi";
import type { RunEvaluationQaAdmission, RunEvaluationQaMutationResult, RunEvaluationQaStore,
  RunEvaluationTaskFence, RunEvaluationTaskStore } from "@ling-stack/core";
import { copyImmutableTaskData } from "./task-worker-input.js";
import { copyQaModelJson, qaModelRecord, qaModelString } from "./qa-model-json.js";
import { preparedRunEvaluationQaModelTransportInput, type PreparedRunEvaluationQaModelRequest,
  type PreparedRunEvaluationQaModelFacts } from "./qa-model-preparation.js";

declare const transportBrand: unique symbol;
declare const successBrand: unique symbol;
export interface RunEvaluationQaModelTransport { readonly [transportBrand]: true }
export interface RunEvaluationQaModelTransportSuccess { readonly [successBrand]: true }
/** Materialized Host input, held only by a private closure; never a configuration artifact or DTO. */
export interface RunEvaluationQaMaterializedProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly api: "openai-completions";
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authHeader?: boolean;
}
export interface RunEvaluationQaGraderOutput {
  readonly schemaVersion: 1;
  readonly verdict: RunEvaluationVerdict;
  readonly score?: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rationale: string;
}
export interface RunEvaluationQaModelSuccessFacts {
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
  readonly receipt: RunEvaluationQaTransportReceiptV1;
  readonly output: RunEvaluationQaGraderOutput;
  readonly latencyMs: number;
}
interface Transport {
  readonly endpoint: string;
  readonly facts: PreparedRunEvaluationQaModelFacts;
  readonly headers: Headers;
  readonly clock: () => string;
  readonly timeoutMs: number;
  readonly store: RunEvaluationQaStore & Pick<RunEvaluationTaskStore, "getRunEvaluationTask" | "getRunEvaluationTaskAttempt">;
  readonly batchId: string;
  readonly assertGeneration?: () => void;
  admission?: { readonly requestId: string; readonly invocationId: string };
  used: boolean;
}
interface Success extends RunEvaluationQaModelSuccessFacts { readonly owner: RunEvaluationQaModelTransport }
const transports = new WeakMap<RunEvaluationQaModelTransport, Transport>();
const successes = new WeakMap<RunEvaluationQaModelTransportSuccess, Success>();
const boundPreparations = new WeakSet<PreparedRunEvaluationQaModelRequest>();
const RESPONSE_BYTE_LIMIT = 65_536;

/** Bind one frozen request to one materialized Host connection. This does not dispatch or retry. */
export function createRunEvaluationQaModelTransport(input: {
  readonly prepared: PreparedRunEvaluationQaModelRequest;
  readonly provider: RunEvaluationQaMaterializedProvider;
  readonly store: Transport["store"];
  readonly batchId: string;
  readonly assertGeneration?: () => void;
  readonly clock?: () => string;
  readonly timeoutMs?: number;
}): RunEvaluationQaModelTransport {
  const prepared = preparedRunEvaluationQaModelTransportInput(input.prepared);
  if (boundPreparations.has(input.prepared)) throw new Error("evaluation_qa_preparation_already_bound");
  const provider = qaModelRecord(input.provider, ["providerId", "modelId", "api", "baseUrl"],
    ["apiKey", "headers", "authHeader"]);
  if (provider.providerId !== prepared.provider.providerId || provider.modelId !== prepared.provider.modelId
    || provider.api !== prepared.provider.api || provider.baseUrl !== prepared.provider.baseUrl
    || (provider.authHeader !== undefined && typeof provider.authHeader !== "boolean")) {
    throw new Error("evaluation_qa_provider_changed");
  }
  const headers = materializedHeaders(provider);
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("evaluation_qa_transport_option_invalid");
  }
  const handle = Object.freeze({}) as RunEvaluationQaModelTransport;
  transports.set(handle, { endpoint: prepared.endpoint, facts: prepared.facts, headers,
    clock: input.clock ?? (() => new Date().toISOString()), timeoutMs, used: false,
    store: input.store, batchId: qaModelString(input.batchId),
    ...(input.assertGeneration ? { assertGeneration: input.assertGeneration } : {}) });
  boundPreparations.add(input.prepared);
  return handle;
}

/** Mint dispatch authority only from this private transport's own atomic Core admission, never a DTO flag. */
export function admitRunEvaluationQaModelTransport(handle: RunEvaluationQaModelTransport,
  fence: RunEvaluationTaskFence): RunEvaluationQaMutationResult<RunEvaluationQaAdmission> {
  const transport = transports.get(handle);
  if (!transport || transport.used || transport.admission) throw new Error("evaluation_qa_transport_untrusted_or_used");
  const captured = copyImmutableTaskData(fence);
  if (captured.taskId !== transport.facts.taskId || captured.attemptId !== transport.facts.attemptId) {
    throw new Error("evaluation_qa_transport_identity_invalid");
  }
  const admission = transport.store.admitRunEvaluationQaRequest({ ...captured,
    batchId: transport.batchId, configDigest: transport.facts.configDigest,
    requestDigest: transport.facts.requestDigest, executionScopeDigest: transport.facts.executionScopeDigest,
    payloadUtf8: transport.facts.payloadUtf8, estimatedInputTokens: transport.facts.estimatedInputTokens,
    outputTokenLimit: transport.facts.outputTokenLimit });
  if (admission.ok && admission.value.mayDispatch) {
    const value = copyImmutableTaskData(admission.value);
    if (!value.attempt.invocationId || value.request.taskId !== captured.taskId || value.request.attemptId !== captured.attemptId
      || value.request.invocationId !== value.attempt.invocationId || value.request.requestDigest !== transport.facts.requestDigest
      || value.request.payloadSha256 !== transport.facts.payloadSha256 || value.request.executionScopeDigest !== transport.facts.executionScopeDigest) {
      throw new Error("evaluation_qa_admission_invalid");
    }
    transport.admission = Object.freeze({ requestId: value.request.id, invocationId: value.attempt.invocationId });
  }
  return admission;
}

/** A captured or matching uncertain admission may be quarantined, but lookup never mints dispatch permission. */
export function runEvaluationQaModelTransportRequestId(handle: RunEvaluationQaModelTransport): string | undefined {
  const transport = transports.get(handle);
  if (!transport) throw new Error("evaluation_qa_transport_untrusted_or_used");
  if (transport.admission) return transport.admission.requestId;
  const scope = copyImmutableTaskData(transport.store.getRunEvaluationQaScope());
  if (!scope?.laneRequestId) return undefined;
  const request = copyImmutableTaskData(transport.store.getRunEvaluationQaRequest(scope.laneRequestId));
  return request?.taskId === transport.facts.taskId && request.attemptId === transport.facts.attemptId
    && request.requestDigest === transport.facts.requestDigest && request.payloadSha256 === transport.facts.payloadSha256
    ? request.id : undefined;
}

/** Drop materialized headers once the owned lifecycle drained; does not release quota or quarantine. */
export function disposeRunEvaluationQaModelTransport(handle: RunEvaluationQaModelTransport): void {
  const transport = transports.get(handle);
  if (!transport) return;
  for (const name of transport.headers.keys()) transport.headers.delete(name);
  transports.delete(handle);
}

/** Exactly one owned POST attempt. All exceptional/partial outcomes are uncertainty, never success. */
export async function executeRunEvaluationQaModelTransport(handle: RunEvaluationQaModelTransport, input: {
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}): Promise<RunEvaluationQaModelTransportSuccess> {
  const transport = transports.get(handle);
  if (!transport || transport.used || !transport.admission) throw new Error("evaluation_qa_transport_untrusted_or_used");
  // Consume synchronously even if Host clock or cancellation re-enters this invocation.
  transport.used = true;
  const identity = qaModelRecord({ taskId: input.taskId, attemptId: input.attemptId, invocationId: input.invocationId },
    ["taskId", "attemptId", "invocationId"]);
  if (identity.taskId !== transport.facts.taskId || identity.attemptId !== transport.facts.attemptId
    || identity.invocationId !== transport.admission.invocationId) {
    throw new Error("evaluation_qa_transport_identity_invalid");
  }
  const invocationId = qaModelString(identity.invocationId);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  input.signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, transport.timeoutMs);
  let response: Response | undefined;
  try {
    if (input.signal.aborted) stop();
    controller.signal.throwIfAborted();
    transport.assertGeneration?.();
    controller.signal.throwIfAborted();
    const dispatchedAt = canonicalClock(transport.clock);
    controller.signal.throwIfAborted();
    validateCurrentAdmission(transport, dispatchedAt);
    controller.signal.throwIfAborted();
    // No await or caller callback between the final abort check and this sole dispatch.
    response = await fetchProvider(transport.endpoint, { method: "POST", headers: transport.headers,
      body: transport.facts.payloadUtf8, signal: controller.signal, redirect: "error" });
    controller.signal.throwIfAborted();
    if (response.status !== 200 || response.redirected) throw new Error("evaluation_qa_response_invalid");
    const bytes = await completeResponseBytes(response, controller.signal);
    controller.signal.throwIfAborted();
    const receivedAt = canonicalClock(transport.clock);
    controller.signal.throwIfAborted();
    if (Date.parse(receivedAt) < Date.parse(dispatchedAt)) throw new Error("evaluation_qa_transport_clock_invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("evaluation_qa_response_invalid"); }
    const { output, usage } = parseCompletion(parsed, transport.facts);
    controller.signal.throwIfAborted();
    const receipt: RunEvaluationQaTransportReceiptV1 = Object.freeze({ transport: "owned_openai_chat_completions",
      payloadSha256: transport.facts.payloadSha256, responseSha256: createHash("sha256").update(bytes).digest("hex"),
      responseStatus: 200, modelId: transport.facts.frozenGrader.modelId, dispatchedAt, receivedAt, usage });
    const success = Object.freeze({}) as RunEvaluationQaModelTransportSuccess;
    successes.set(success, Object.freeze({ owner: handle, taskId: transport.facts.taskId,
      attemptId: transport.facts.attemptId, invocationId, requestDigest: transport.facts.requestDigest,
      executionScopeDigest: transport.facts.executionScopeDigest, receipt, output,
      latencyMs: Date.parse(receivedAt) - Date.parse(dispatchedAt) }));
    return success;
  } catch {
    throw new Error("evaluation_qa_transport_unknown");
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", stop);
    // Wait for the actual owned response/body to settle; do not manufacture callback drain.
    if (response?.body && !response.body.locked) {
      try { await response.body.cancel(); } catch { /* Preserve uncertainty, never upgrade the result. */ }
    }
  }
}

/** Original private success + original transport are required; JSON assertions cannot certify execution. */
export function runEvaluationQaModelSuccessFacts(owner: RunEvaluationQaModelTransport,
  handle: RunEvaluationQaModelTransportSuccess): RunEvaluationQaModelSuccessFacts {
  const success = successes.get(handle);
  if (!success || success.owner !== owner) throw new Error("evaluation_qa_receipt_untrusted");
  const { owner: _owner, ...facts } = success;
  return Object.freeze(facts);
}

function materializedHeaders(provider: Readonly<Record<string, unknown>>): Headers {
  const headers = new Headers();
  if (provider.headers !== undefined) {
    const values = copyQaModelJson(provider.headers, 16_384);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("evaluation_qa_auth_invalid");
    const names = new Set<string>();
    for (const [name, value] of Object.entries(values)) {
      const lower = name.toLowerCase();
      if (names.has(lower) || ["host", "content-length", "transfer-encoding", "connection", "upgrade"].includes(lower)
        || typeof value !== "string" || value.length > 8_192 || /[\r\n\0]/u.test(value)) {
        throw new Error("evaluation_qa_auth_invalid");
      }
      names.add(lower);
      try { headers.set(name, value); } catch { throw new Error("evaluation_qa_auth_invalid"); }
    }
  }
  if (provider.apiKey !== undefined) qaModelString(provider.apiKey, 8_192);
  if (provider.authHeader !== false && !headers.has("authorization")) {
    if (typeof provider.apiKey !== "string") throw new Error("evaluation_qa_auth_invalid");
    try { headers.set("Authorization", `Bearer ${provider.apiKey}`); } catch { throw new Error("evaluation_qa_auth_invalid"); }
  }
  if (headers.has("content-type") && headers.get("content-type") !== "application/json") {
    throw new Error("evaluation_qa_auth_invalid");
  }
  headers.set("content-type", "application/json");
  return headers;
}

function validateCurrentAdmission(transport: Transport, dispatchedAt: string): void {
  const admission = transport.admission;
  if (!admission) throw new Error("evaluation_qa_admission_invalid");
  const request = copyImmutableTaskData(transport.store.getRunEvaluationQaRequest(admission.requestId));
  const scope = copyImmutableTaskData(transport.store.getRunEvaluationQaScope());
  const task = copyImmutableTaskData(transport.store.getRunEvaluationTask(transport.facts.taskId));
  const attempt = copyImmutableTaskData(transport.store.getRunEvaluationTaskAttempt(transport.facts.attemptId));
  if (!request || request.state !== "admitted" || request.taskId !== transport.facts.taskId
    || request.attemptId !== transport.facts.attemptId || request.invocationId !== admission.invocationId
    || request.requestDigest !== transport.facts.requestDigest || request.payloadSha256 !== transport.facts.payloadSha256
    || request.executionScopeDigest !== transport.facts.executionScopeDigest || scope?.laneState !== "held"
    || scope.laneRequestId !== request.id || task?.state !== "active" || task.activeAttemptId !== attempt?.id
    || attempt?.state !== "dispatch_admitted" || attempt.invocationId !== admission.invocationId
    || attempt.claimExpiresAt <= dispatchedAt) {
    throw new Error("evaluation_qa_admission_invalid");
  }
}

async function completeResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > RESPONSE_BYTE_LIMIT)) {
    throw new Error("evaluation_qa_response_invalid");
  }
  if (!response.body) throw new Error("evaluation_qa_response_invalid");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) { ended = true; break; }
      total += part.value.byteLength;
      if (total > RESPONSE_BYTE_LIMIT) throw new Error("evaluation_qa_response_invalid");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } finally {
    if (!ended) { try { await reader.cancel(); } catch { /* Await the real owned cancellation. */ } }
    reader.releaseLock();
  }
}

function parseCompletion(value: unknown, facts: PreparedRunEvaluationQaModelFacts): {
  readonly output: RunEvaluationQaGraderOutput;
  readonly usage: RunEvaluationQaTransportReceiptV1["usage"];
} {
  const envelope = qaModelRecord(copyQaModelJson(value, RESPONSE_BYTE_LIMIT), ["model", "choices"],
    ["id", "object", "created", "usage", "system_fingerprint", "service_tier"]);
  if (envelope.model !== facts.frozenGrader.modelId || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
    throw new Error("evaluation_qa_response_invalid");
  }
  const choice = qaModelRecord(envelope.choices[0], ["index", "message", "finish_reason"], ["logprobs"]);
  const message = qaModelRecord(choice.message, ["role", "content"],
    ["refusal", "reasoning_content", "reasoning", "annotations", "audio", "tool_calls", "function_call"]);
  if (choice.index !== 0 || choice.finish_reason !== "stop" || message.role !== "assistant"
    || (message.refusal !== undefined && message.refusal !== null)
    || (message.audio !== undefined && message.audio !== null)
    || (message.function_call !== undefined && message.function_call !== null)
    || (message.tool_calls !== undefined && message.tool_calls !== null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
    || (message.annotations !== undefined && !Array.isArray(message.annotations))
    || [message.reasoning, message.reasoning_content].some(reasoning => reasoning !== undefined && reasoning !== null && typeof reasoning !== "string")
    || typeof message.content !== "string" || message.content.length > 16_384) throw new Error("evaluation_qa_response_invalid");
  let outputValue: unknown;
  try { outputValue = JSON.parse(message.content); } catch { throw new Error("evaluation_qa_response_invalid"); }
  const output = qaModelRecord(outputValue, ["schemaVersion", "verdict", "rationale"], ["score", "severity"]);
  if (output.schemaVersion !== 1 || !RUN_EVALUATION_VERDICTS.includes(output.verdict as RunEvaluationVerdict)
    || (output.severity !== undefined && !RUN_EVALUATION_SEVERITIES.includes(output.severity as RunEvaluationSeverity))
    || (output.score !== undefined && (typeof output.score !== "number" || !Number.isFinite(output.score)
      || output.score < 0 || output.score > 1))) throw new Error("evaluation_qa_response_invalid");
  qaModelString(output.rationale, 4_096);
  const usage = envelope.usage === undefined ? Object.freeze({ state: "unknown" as const }) : rawUsage(envelope.usage);
  if (usage.state === "measured" && usage.outputTokens > facts.outputTokenLimit) throw new Error("evaluation_qa_response_invalid");
  return Object.freeze({ output: output as unknown as RunEvaluationQaGraderOutput, usage });
}

function rawUsage(value: unknown): RunEvaluationQaTransportReceiptV1["usage"] {
  const usage = qaModelRecord(value, ["prompt_tokens", "completion_tokens", "total_tokens"],
    ["prompt_tokens_details", "completion_tokens_details"]);
  const inputTokens = tokenInteger(usage.prompt_tokens);
  const outputTokens = tokenInteger(usage.completion_tokens);
  if (tokenInteger(usage.total_tokens) !== inputTokens + outputTokens || !Number.isSafeInteger(inputTokens + outputTokens)) {
    throw new Error("evaluation_qa_usage_invalid");
  }
  for (const [key, maximum, names] of [["prompt_tokens_details", inputTokens, ["cached_tokens", "audio_tokens"]],
    ["completion_tokens_details", outputTokens, ["reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"]]] as const) {
    if (usage[key] === undefined) continue;
    const details = qaModelRecord(usage[key], [], [...names]);
    for (const amount of Object.values(details)) if (tokenInteger(amount) > maximum) throw new Error("evaluation_qa_usage_invalid");
  }
  return Object.freeze({ state: "measured", inputTokens, outputTokens });
}
function tokenInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("evaluation_qa_usage_invalid");
  return value;
}
function canonicalClock(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error("evaluation_qa_transport_clock_invalid");
  }
  return value;
}
