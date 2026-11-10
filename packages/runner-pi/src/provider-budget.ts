import { createHash, randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRunnerProviderBudgetIdentity, PiRunnerProviderBudgetReservation, PiRunnerRunOptions, PiRunnerTokenUsage } from "./types.js";

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;
type LocalRejection = "cancelled" | "local_rejected";
type BudgetInvocation = ReturnType<typeof createPiProviderBudgetInvocation>;

/** A separate hard gate: do not change the best-effort Provider observation contract. */
export function bindPiProviderBudgetResolution(runtime: ModelRuntime, options: PiRunnerRunOptions) {
  const invocations = new WeakMap<PayloadHook, BudgetInvocation>();
  const associate = (hook: PayloadHook, invocation: BudgetInvocation): void => { invocations.set(hook, invocation); };
  if (!options.providerBudget) return associate;
  if (typeof runtime.getProvider !== "function" || typeof runtime.registerProvider !== "function") {
    throw new Error("provider_budget_resolution_unavailable");
  }
  const provider = runtime.getProvider(options.provider.provider);
  if (!provider) throw new Error("provider_budget_resolution_unavailable");
  const streamSimple = provider.streamSimple.bind(provider);
  runtime.registerProvider(options.provider.provider, {
    api: runtime.getRegisteredProviderConfig?.(options.provider.provider)?.api ?? options.provider.api ?? "openai-completions",
    streamSimple: (model, context, resolvedOptions) => {
      const invocation = resolvedOptions?.onPayload ? invocations.get(resolvedOptions.onPayload) : undefined;
      if (!invocation) throw new Error("provider_budget_invocation_missing");
      invocation.captureResolvedTuple(model, resolvedOptions);
      return streamSimple(model, context, resolvedOptions);
    },
  });
  return associate;
}

export function createPiProviderBudgetInvocation(
  options: PiRunnerRunOptions,
  readLocalRejection: () => LocalRejection | undefined,
  rejectBoundary: (error: unknown) => void,
) {
  const port = options.providerBudget;
  const invocationId = randomUUID();
  let resolved: (() => SimpleStreamOptions) | undefined;
  let reservation: PiRunnerProviderBudgetReservation | undefined;
  let payloadSha256: string | undefined;
  let identity: PiRunnerProviderBudgetIdentity | undefined;
  let finished = false;
  let observing = false;
  if (port && (!options.runId || !options.runnerAttemptId || typeof port.requiresTokenUpperBound !== "boolean"
    || typeof port.requiresCostUpperBound !== "boolean" || typeof port.reserve !== "function"
    || typeof port.settle !== "function" || typeof port.settleUnknown !== "function")) {
    throw new Error("provider_budget_port_invalid");
  }
  // Capture capabilities and axes once. Late mutation of the caller's options cannot weaken a running gate.
  const reserve = port?.reserve.bind(port);
  const settle = port?.settle.bind(port);
  const settleUnknown = port?.settleUnknown.bind(port);
  const requiresTokens = port?.requiresTokenUpperBound;
  const requiresCost = port?.requiresCostUpperBound;
  const fail = (error: unknown): never => { rejectBoundary(error); throw error; };
  const unknown = (outcome: "unknown" | LocalRejection): void => {
    if (!identity || finished) return;
    finished = true;
    assertSynchronous(settleUnknown!({ ...identity, outcome }));
  };
  const finalize = (result: AssistantMessage): void => {
    if (!identity || finished) return;
    const local = readLocalRejection();
    if (local || result?.stopReason === "aborted") { unknown(local ?? "cancelled"); return; }
    const usage = actualUsage(result, identity);
    const outcome = result.stopReason === "error" ? "provider_error"
      : ["stop", "length", "toolUse"].includes(result.stopReason) ? "succeeded" : undefined;
    if (!usage || !outcome) { unknown("unknown"); return; }
    // Set first: a rejected commit is unresolved debt, never a second optimistic settlement.
    finished = true;
    assertSynchronous(settle!({ ...identity, outcome, usage }));
  };

  return {
    captureResolvedTuple(model: Model<Api>, streamOptions: SimpleStreamOptions | undefined): void {
      if (!port) return;
      resolved = () => {
        assertHostTuple(options, model, streamOptions);
        return streamOptions!;
      };
      try { resolved(); } catch (error) { fail(error); }
    },
    /** Returns the isolated payload whose exact contents were reserved; replay does not reserve twice. */
    authorize(payload: unknown, model: Model<Api>): unknown {
      if (!port) return payload;
      try {
        if (!resolved) throw new Error("provider_budget_resolution_unavailable");
        const streamOptions = resolved();
        assertHostModel(options, model);
        const snapshot = snapshotPayload(payload);
        const sha = createHash("sha256").update(snapshot.canonical).digest("hex");
        if (reservation) {
          if (sha !== payloadSha256) throw new Error("provider_budget_payload_changed");
          return snapshot.payload;
        }
        const maxOutputTokens = streamOptions.maxTokens ?? model.maxTokens;
        if (!positiveInteger(maxOutputTokens) || maxOutputTokens > model.maxTokens) throw new Error("provider_budget_output_bound_invalid");
        const reserved: unknown = reserve!({ invocationId, taskId: options.task.id, runId: options.runId!, attemptId: options.runnerAttemptId!,
          provider: model.provider, model: model.id, api: model.api, contextWindowTokens: model.contextWindow,
          maxOutputTokens, payloadSha256: sha, payload: snapshot.payload });
        assertSynchronous(reserved);
        if (!reserved || typeof reserved !== "object" || Array.isArray(reserved)) throw new Error("provider_budget_reservation_invalid");
        const candidate = reserved as PiRunnerProviderBudgetReservation;
        if (typeof candidate.reservationId !== "string" || !candidate.reservationId.trim() || candidate.reservationId.length > 512
          || (candidate.reservedTokens !== undefined && !nonnegativeInteger(candidate.reservedTokens))
          || (candidate.reservedCostMicros !== undefined && !nonnegativeInteger(candidate.reservedCostMicros))
          || (requiresTokens && !positiveInteger(candidate.reservedTokens))
          || (requiresCost && candidate.reservedCostMicros === undefined)) throw new Error("provider_budget_upper_bound_unavailable");
        reservation = Object.freeze({ ...candidate });
        payloadSha256 = sha;
        identity = Object.freeze({ invocationId, reservationId: candidate.reservationId, runId: options.runId!, attemptId: options.runnerAttemptId!,
          provider: model.provider, model: model.id, api: model.api });
        return snapshot.payload;
      } catch (error) { return fail(error); }
    },
    /** Wrap the SDK final Promise, not its observer-only callback. Failed commits latch future admission. */
    guardResult<T extends { result(): Promise<AssistantMessage> }>(stream: T): T {
      if (!port || observing) return stream;
      observing = true;
      const originalResult = stream.result.bind(stream);
      let result: Promise<AssistantMessage>;
      try {
        result = originalResult().then(message => {
          try { finalize(message); } catch (error) { return fail(error); }
          return message;
        }, error => {
          try { unknown(readLocalRejection() ?? "unknown"); } catch (settlementError) { return fail(settlementError); }
          return fail(error);
        });
      } catch (error) {
        try { unknown(readLocalRejection() ?? "unknown"); } catch (settlementError) { return fail(settlementError); }
        return fail(error);
      }
      // The SDK may consume the event iterator first; always own a rejection observer meanwhile.
      void result.catch(() => undefined);
      stream.result = () => result;
      return stream;
    },
  };
}

function assertSynchronous(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function") {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error("provider_budget_async_port_rejected");
  }
}

function assertHostModel(options: PiRunnerRunOptions, model: Model<Api>): void {
  const expected = options.provider;
  if (model.provider !== expected.provider || model.id !== expected.model || model.api !== (expected.api ?? "openai-completions")
    || model.baseUrl !== expected.baseUrl || model.contextWindow !== (expected.contextWindow ?? 128_000)
    || model.maxTokens !== (expected.maxTokens ?? 16_384) || !positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens)) {
    throw new Error("provider_budget_model_mismatch");
  }
}

function assertHostTuple(options: PiRunnerRunOptions, model: Model<Api>, actual: SimpleStreamOptions | undefined): void {
  assertHostModel(options, model);
  const expected = options.provider;
  if (!expected.apiKey || actual?.apiKey !== expected.apiKey
    || (actual.env !== undefined && (actual.env === null || typeof actual.env !== "object" || Array.isArray(actual.env) || Object.keys(actual.env).length))) {
    throw new Error("provider_budget_credential_mismatch");
  }
  const expectedHeaders = headers({ ...expected.headers, ...(expected.authHeader ? { Authorization: `Bearer ${expected.apiKey}` } : {}) });
  const actualHeaders = headers(actual.headers);
  const modelHeaders = headers(model.headers);
  if (expectedHeaders.size !== actualHeaders.size || [...actualHeaders].some(([key, value]) => expectedHeaders.get(key) !== value)
    || [...modelHeaders].some(([key, value]) => expectedHeaders.get(key) !== value)) throw new Error("provider_budget_headers_mismatch");
}

function headers(input: unknown): Map<string, string> {
  if (input === undefined) return new Map();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("provider_budget_headers_invalid");
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (typeof value !== "string" || (map.has(name) && map.get(name) !== value)) throw new Error("provider_budget_headers_invalid");
    map.set(name, value);
  }
  return map;
}

function snapshotPayload(input: unknown): { readonly payload: unknown; readonly canonical: string } {
  const json = JSON.stringify(input);
  if (json === undefined) throw new Error("provider_budget_payload_invalid");
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return Object.freeze(value.map(order));
    if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => [key, order(value)])));
    return value;
  };
  const payload = order(JSON.parse(json));
  return { payload, canonical: JSON.stringify(payload) };
}

function actualUsage(message: AssistantMessage, identity: PiRunnerProviderBudgetIdentity): PiRunnerTokenUsage | undefined {
  if (message?.role !== "assistant" || message.provider !== identity.provider || message.model !== identity.model || message.api !== identity.api) return undefined;
  const usage = message.usage;
  if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(nonnegativeInteger)) return undefined;
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  // SDK error/omitted-usage placeholders are initialized to zero, not evidence of zero billing.
  if (!Number.isSafeInteger(total) || total < 1 || total !== usage.totalTokens) return undefined;
  return Object.freeze({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens });
}
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positiveInteger(value: unknown): value is number { return nonnegativeInteger(value) && value > 0; }
