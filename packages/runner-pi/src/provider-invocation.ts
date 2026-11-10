import { randomUUID } from "node:crypto";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { classifyProviderError } from "./provider-error-diagnostic.js";
import type {
  PiRunnerProviderInvocationAdmittedReceipt,
  PiRunnerProviderInvocationContextBudget,
  PiRunnerProviderInvocationSettledReceipt,
  PiRunnerRunOptions,
} from "./types.js";

type LocalRejection = "cancelled" | "local_rejected";
type ProviderResult = { readonly stopReason?: string; readonly errorMessage?: string };
type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

/**
 * Associate each stream by its private payload function, never a shared current
 * request pointer. This public provider port runs after SDK auth/header resolution.
 * Keep the already-composed implementation, including Host auth/fetch wrappers.
 */
export function bindPiProviderInvocationResolution(runtime: ModelRuntime, options: PiRunnerRunOptions) {
  const observations = new WeakMap<PayloadHook, ReturnType<typeof createPiProviderInvocation>>();
  const associate = (hook: PayloadHook, observation: ReturnType<typeof createPiProviderInvocation>): void => {
    observations.set(hook, observation);
  };
  if (!options.onProviderInvocationAdmitted && !options.onProviderInvocationSettled) return associate;
  try {
    // Test doubles/older ports without public resolution evidence remain unknown.
    if (typeof runtime.getProvider !== "function" || typeof runtime.registerProvider !== "function") return associate;
    const provider = runtime.getProvider(options.provider.provider);
    if (!provider) return associate;
    const streamSimple = provider.streamSimple.bind(provider);
    runtime.registerProvider(options.provider.provider, {
      api: runtime.getRegisteredProviderConfig?.(options.provider.provider)?.api
        ?? options.provider.api ?? "openai-completions",
      streamSimple: (model, context, resolvedOptions) => {
        if (resolvedOptions?.onPayload) {
          observations.get(resolvedOptions.onPayload)?.captureResolvedTuple(model, resolvedOptions);
        }
        return streamSimple(model, context, resolvedOptions);
      },
    });
  } catch {
    // Observability must never reject ordinary model execution.
  }
  return associate;
}

/**
 * Observe one logical SDK stream, not an HTTP attempt or proof of network dispatch.
 * The caller admits only after every payload/Host gate has passed. SDK preparation
 * failures and streams that never reach that point have no invocation receipt.
 * Observation failures are unknown; they never authorize, reject or stop a model.
 */
export function createPiProviderInvocation(
  options: PiRunnerRunOptions,
  readLocalRejection: () => LocalRejection | undefined,
  contextBudget?: PiRunnerProviderInvocationContextBudget,
) {
  const enabled = Boolean(options.onProviderInvocationAdmitted || options.onProviderInvocationSettled);
  let admissionAttempted = false;
  let admitted: PiRunnerProviderInvocationAdmittedReceipt | undefined;
  let locallyRejected = false;
  let observationUnknown = false;
  let settled = false;
  let verifyResolvedTuple: (() => boolean) | undefined;
  const budgetSnapshot = snapshotContextBudget(contextBudget);

  const notify = <Receipt>(callback: ((receipt: Receipt) => void) | undefined, receipt: Receipt): void => {
    if (!callback) return;
    try {
      // TypeScript's void callback accepts async functions. Such callbacks cannot
      // prove synchronous observation acceptance; drain them without blocking Pi.
      const returned: unknown = callback(receipt);
      if (returned !== null && (typeof returned === "object" || typeof returned === "function")
        && typeof Reflect.get(returned, "then") === "function") {
        observationUnknown = true;
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      observationUnknown = true;
    }
  };

  const settle = (result: ProviderResult | undefined): void => {
    if (!admitted || settled || observationUnknown) return;
    settled = true;
    const rejection = readLocalRejection() ?? (locallyRejected ? "local_rejected" : undefined);
    const outcome = rejection ?? (result?.stopReason === "aborted" ? "cancelled"
      : result?.stopReason === "error" ? "provider_error"
        : result && ["stop", "length", "toolUse", "deferred"].includes(result.stopReason ?? "") ? "succeeded"
          : undefined);
    // A rejected/malformed result Promise does not prove a Provider response.
    if (!outcome) return;
    const errorDiagnostic = outcome === "provider_error" ? Object.freeze(classifyProviderError(result)) : undefined;
    const receipt: PiRunnerProviderInvocationSettledReceipt = Object.freeze({
      ...admitted,
      // Report the sampled wall clock faithfully. Host validates reversed clocks
      // as unknown rather than manufacturing a later timestamp or stopping Pi.
      settledAt: new Date().toISOString(),
      outcome,
      ...(errorDiagnostic ? { errorDiagnostic } : {}),
    });
    notify(options.onProviderInvocationSettled, receipt);
  };

  return {
    /** Retain only live SDK references, never another credential copy or digest. */
    captureResolvedTuple(requestModel: Model<Api>, resolvedOptions: SimpleStreamOptions | undefined): void {
      if (!enabled || observationUnknown) return;
      try {
        verifyResolvedTuple = () => matchesHostProviderTuple(options, requestModel, resolvedOptions);
        if (!verifyResolvedTuple()) observationUnknown = true;
      } catch {
        observationUnknown = true;
      }
    },
    /** The provider may reapply its payload hook; one stream still admits once. */
    admit(requestModel: Model<Api>): void {
      if (!enabled || observationUnknown) return;
      try {
        // Summaries may use independent models, keys, headers or environment.
        // A different actual tuple must not borrow this Run's private scope.
        // Recheck every repeated payload hook, even after the first admission.
        if (!verifyResolvedTuple?.() || !matchesHostModel(options, requestModel)) {
          observationUnknown = true;
          return;
        }
        if (admissionAttempted) return;
        admissionAttempted = true;
        admitted = Object.freeze({
          invocationId: randomUUID(),
          taskId: options.task.id,
          ...(options.runId === undefined ? {} : { runId: options.runId }),
          ...(options.runnerAttemptId === undefined ? {} : { attemptId: options.runnerAttemptId }),
          admittedAt: new Date().toISOString(),
          ...(budgetSnapshot ? { contextBudget: budgetSnapshot } : {}),
        });
        notify(options.onProviderInvocationAdmitted, admitted);
      } catch {
        observationUnknown = true;
      }
    },
    rejectLocally(): void { locallyRejected = true; },
    /** result() observes the SDK's final Promise without consuming its iterator. */
    observe(stream: { result(): Promise<ProviderResult> }): void {
      if (!enabled) return;
      try {
        void stream.result().then(
          (result) => { try { settle(result); } catch { observationUnknown = true; } },
          () => { try { settle(undefined); } catch { observationUnknown = true; } },
        );
      } catch {
        observationUnknown = true;
      }
    },
  };
}

/** Compare only in Host memory; unknown overrides never reject ordinary execution. */
function matchesHostProviderTuple(
  options: PiRunnerRunOptions,
  requestModel: Model<Api>,
  streamOptions: SimpleStreamOptions | undefined,
): boolean {
  const provider = options.provider;
  // No nonempty Host key means the SDK can resolve ambient auth independently.
  if (!provider.apiKey || !matchesHostModel(options, requestModel)) return false;
  if (streamOptions?.apiKey !== provider.apiKey) return false;
  // PiRunnerProviderConfig has no materialized environment tuple. Independent
  // nonempty env overrides cannot be proven to resolve the same connection.
  if (streamOptions?.env !== undefined && (typeof streamOptions.env !== "object" || streamOptions.env === null
    || Array.isArray(streamOptions.env) || Object.keys(streamOptions.env).length > 0)) return false;
  const expectedHeaders = canonicalHeaders({ ...provider.headers,
    ...(provider.authHeader === true ? { Authorization: `Bearer ${provider.apiKey}` } : {}) });
  const actualHeaders = canonicalHeaders(streamOptions?.headers);
  const modelHeaders = canonicalHeaders(requestModel.headers);
  if (!expectedHeaders || !actualHeaders || !modelHeaders || expectedHeaders.size !== actualHeaders.size) return false;
  for (const [name, value] of actualHeaders) if (expectedHeaders.get(name) !== value) return false;
  for (const [name, value] of modelHeaders) if (expectedHeaders.get(name) !== value) return false;
  return true;
}

function matchesHostModel(options: PiRunnerRunOptions, requestModel: Model<Api>): boolean {
  const provider = options.provider;
  return requestModel.provider === provider.provider && requestModel.id === provider.model
    && requestModel.api === (provider.api ?? "openai-completions") && requestModel.baseUrl === provider.baseUrl
    && requestModel.contextWindow === (provider.contextWindow ?? 128_000)
    && requestModel.maxTokens === (provider.maxTokens ?? 16_384);
}

function canonicalHeaders(headers: unknown): Map<string, string> | undefined {
  if (headers === undefined) return new Map();
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const canonical = name.toLowerCase();
    if (typeof value !== "string" || (result.has(canonical) && result.get(canonical) !== value)) return undefined;
    result.set(canonical, value);
  }
  return result;
}

/** Reject malformed diagnostic data as unknown, without changing execution. */
function snapshotContextBudget(value: PiRunnerProviderInvocationContextBudget | undefined): PiRunnerProviderInvocationContextBudget | undefined {
  try {
    if (!value || Object.keys(value).sort().join(",") !== ["basis", "contextWindowTokens", "estimatedInputTokens", "inputBudgetTokens",
      "reservedOutputTokens", "reservedRuntimeOverheadTokens", "schemaVersion"].join(",")) return undefined;
    const { schemaVersion, basis, estimatedInputTokens, contextWindowTokens,
      reservedOutputTokens, reservedRuntimeOverheadTokens, inputBudgetTokens } = value;
    if (schemaVersion !== 1 || basis !== "pi_projected_context_estimate"
      || ![estimatedInputTokens, contextWindowTokens, reservedOutputTokens, reservedRuntimeOverheadTokens, inputBudgetTokens].every(Number.isSafeInteger)
      || estimatedInputTokens < 0 || contextWindowTokens < 1 || reservedOutputTokens < 1 || reservedRuntimeOverheadTokens !== 512
      || inputBudgetTokens < 1 || inputBudgetTokens !== contextWindowTokens - reservedOutputTokens - reservedRuntimeOverheadTokens
      || estimatedInputTokens > inputBudgetTokens) return undefined;
    return Object.freeze({ schemaVersion, basis, estimatedInputTokens, contextWindowTokens,
      reservedOutputTokens, reservedRuntimeOverheadTokens, inputBudgetTokens });
  } catch { return undefined; }
}
