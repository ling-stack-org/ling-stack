import type { ProviderStoreFacet } from "@ling-stack/core";
import type { PiRunnerProviderConfig, PiRunnerProviderInvocationContextBudget, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import {
  classifyProviderRuntimeFailure,
  type ProviderRuntimeFailureClassification,
} from "../channels/provider-runtime-observations.js";
import {
  providerRuntimeScopeIdentity,
  runtimeObservationScopeForProvider,
  type ProviderRuntimeObservationScope,
  type ProviderRuntimeScopeIdentity,
} from "./runtime-observation-scope.js";

declare const invocationFailureBrand: unique symbol;
/** Host-only nominal failure. JSON/reflection cannot expose the private fact. */
export interface ProviderInvocationFailure {
  readonly [invocationFailureBrand]: true;
}

export type ProviderInvocationOrigin = "task" | "reviewer" | "reply" | "route" | "intent";
export type ProviderInvocationFailureSink = (failure: ProviderInvocationFailure) => void;

export interface ProviderInvocationFailureFact {
  readonly invocationId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly origin: ProviderInvocationOrigin;
  readonly admittedAt: string;
  readonly settledAt: string;
  readonly scope: ProviderRuntimeObservationScope;
  readonly identity: ProviderRuntimeScopeIdentity;
  readonly classification: ProviderRuntimeFailureClassification;
  /** Numeric-only actual projected SDK input estimate; absence cannot learn a window. */
  readonly contextBudget?: PiRunnerProviderInvocationContextBudget;
}

type InvocationCallbacks = Pick<PiRunnerRunOptions,
  "onProviderInvocationAdmitted" | "onProviderInvocationSettled">;
type Admission = Parameters<NonNullable<PiRunnerRunOptions["onProviderInvocationAdmitted"]>>[0];
const failures = new WeakMap<ProviderInvocationFailure, ProviderInvocationFailureFact>();

/** Read only an authentic in-process fact. Never reconstruct one from a Run DTO. */
export function readProviderInvocationFailure(
  failure: ProviderInvocationFailure,
): ProviderInvocationFailureFact | undefined {
  return failures.get(failure);
}

/**
 * Bind each logical model request to the exact live resolver output. Install
 * only on adapters with the trusted Runner admission seam. This does not prove
 * HTTP bytes were sent and does not publish/cache incidents by itself.
 */
export function createProviderInvocationObserver(input: {
  readonly store: ProviderStoreFacet;
  readonly provider: PiRunnerProviderConfig;
  readonly taskId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly origin: ProviderInvocationOrigin;
  readonly signal?: AbortSignal;
  readonly onFailure?: ProviderInvocationFailureSink;
}): InvocationCallbacks {
  const pending = new Map<string, {
    readonly admission: Admission;
    readonly scope: ProviderRuntimeObservationScope;
    readonly contextBudget?: PiRunnerProviderInvocationContextBudget;
  }>();
  const seen = new Set<string>();
  return {
    onProviderInvocationAdmitted: (receipt) => {
      if (input.signal?.aborted || !validLineage(receipt, input) || !validTime(receipt.admittedAt)) return;
      // A duplicate identity is uncertain, not two facts. Bound pending state
      // defensively without adding a model-call gate.
      if (seen.has(receipt.invocationId)) { pending.delete(receipt.invocationId); return; }
      // Bound lifetime dedup, not just concurrently pending streams. Reaching
      // this diagnostic cap makes subsequent observations unknown, never bans
      // normal model calls or drops their execution results.
      if (seen.size >= 4_096 || pending.size >= 128) return;
      seen.add(receipt.invocationId);
      const scope = runtimeObservationScopeForProvider(input.store, input.provider);
      if (!scope) return;
      const contextBudget = readNumericContextBudget(receipt.contextBudget);
      pending.set(receipt.invocationId, { admission: Object.freeze({
        invocationId: receipt.invocationId, taskId: receipt.taskId,
        ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
        ...(receipt.attemptId === undefined ? {} : { attemptId: receipt.attemptId }),
        admittedAt: receipt.admittedAt,
      }), scope, ...(contextBudget ? { contextBudget } : {}) });
    },
    onProviderInvocationSettled: (receipt) => {
      const admitted = pending.get(receipt.invocationId);
      pending.delete(receipt.invocationId);
      if (!admitted || input.signal?.aborted || receipt.outcome !== "provider_error"
        || !validLineage(receipt, input) || receipt.admittedAt !== admitted.admission.admittedAt
        || !validTime(receipt.settledAt) || Date.parse(receipt.settledAt) < Date.parse(admitted.admission.admittedAt)) return;
      // The Runner emits bounded diagnostic categories, not Provider text. Do
      // not retain or publish error bodies, paths, payloads or rotated secrets.
      const category = receipt.errorDiagnostic?.category;
      const safeCode = category === "context_limit" ? "context_length_error"
        : category === "rate_limited" || category === "quota_exhausted" ? "rate_limited"
        : category === "provider_unavailable" ? "provider_internal_error"
        : category === "timeout" ? "timeout"
        : category === "network" ? "network_error"
        : category === "authentication" || category === "permission_denied" ? "auth_failed"
        : undefined;
      const classification = safeCode ? classifyProviderRuntimeFailure(safeCode, undefined) : undefined;
      const identity = providerRuntimeScopeIdentity(admitted.scope);
      if (!classification || !identity) return;
      const settledBudget = readNumericContextBudget(receipt.contextBudget);
      // A malformed/missing budget removes only window-learning evidence. The
      // original scope and independent Provider availability fact remain valid.
      const contextBudget = admitted.contextBudget && settledBudget
        && sameNumericBudget(admitted.contextBudget, settledBudget) ? admitted.contextBudget : undefined;
      const failure = Object.freeze({}) as ProviderInvocationFailure;
      failures.set(failure, Object.freeze({
        ...admitted.admission, settledAt: receipt.settledAt, origin: input.origin,
        scope: admitted.scope, identity, classification: Object.freeze({ ...classification }),
        ...(contextBudget ? { contextBudget } : {}),
      }));
      // A diagnostic observer cannot alter model authorization/settlement.
      try {
        const returned: unknown = input.onFailure?.(failure);
        if (returned !== null && (typeof returned === "object" || typeof returned === "function")
          && typeof Reflect.get(returned, "then") === "function") {
          void Promise.resolve(returned).catch(() => undefined);
        }
      } catch { /* The fact remains private; do not log exception contents. */ }
    },
  };
}

const NUMERIC_BUDGET_KEYS = [
  "schemaVersion", "basis", "estimatedInputTokens", "contextWindowTokens", "reservedOutputTokens",
  "reservedRuntimeOverheadTokens", "inputBudgetTokens",
] as const;

/** Copy only a finite versioned numeric contract, never retain an arbitrary receipt object. */
function readNumericContextBudget(value: unknown): PiRunnerProviderInvocationContextBudget | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).sort().join(",") !== [...NUMERIC_BUDGET_KEYS].sort().join(",")) return undefined;
    const input = value as Record<string, unknown>;
    const copy = Object.fromEntries(NUMERIC_BUDGET_KEYS.map(key => [key, input[key]]));
    if (copy.schemaVersion !== 1 || copy.basis !== "pi_projected_context_estimate"
      || NUMERIC_BUDGET_KEYS.slice(2).some(key => !Number.isSafeInteger(copy[key]))) return undefined;
    const budget = copy as unknown as PiRunnerProviderInvocationContextBudget;
    if (budget.estimatedInputTokens < 0 || budget.contextWindowTokens < 1 || budget.reservedOutputTokens < 1
      || budget.reservedRuntimeOverheadTokens !== 512 || budget.inputBudgetTokens < 1
      || budget.inputBudgetTokens !== budget.contextWindowTokens - budget.reservedOutputTokens - 512
      || budget.estimatedInputTokens > budget.inputBudgetTokens) return undefined;
    return Object.freeze(budget);
  } catch {
    // Invalid numeric evidence must never reject an otherwise valid Provider call.
    return undefined;
  }
}

function sameNumericBudget(
  left: PiRunnerProviderInvocationContextBudget,
  right: PiRunnerProviderInvocationContextBudget,
): boolean {
  return NUMERIC_BUDGET_KEYS.every(key => left[key] === right[key]);
}

function validLineage(
  receipt: Admission,
  input: { readonly taskId: string; readonly runId?: string; readonly attemptId?: string },
): boolean {
  return typeof receipt.invocationId === "string" && receipt.invocationId.length > 0
    && receipt.invocationId.length <= 128 && receipt.taskId === input.taskId
    && receipt.runId === input.runId && receipt.attemptId === input.attemptId;
}

function validTime(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
