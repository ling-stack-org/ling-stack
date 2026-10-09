import type { ProviderStoreFacet } from "@ling-stack/core";
import type { PiRunnerProviderConfig, PiRunnerRunOptions } from "@ling-stack/runner-pi";
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
  const pending = new Map<string, { readonly admission: Admission; readonly scope: ProviderRuntimeObservationScope }>();
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
      pending.set(receipt.invocationId, { admission: Object.freeze({
        invocationId: receipt.invocationId, taskId: receipt.taskId,
        ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
        ...(receipt.attemptId === undefined ? {} : { attemptId: receipt.attemptId }),
        admittedAt: receipt.admittedAt,
      }), scope });
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
      const failure = Object.freeze({}) as ProviderInvocationFailure;
      failures.set(failure, Object.freeze({
        ...admitted.admission, settledAt: receipt.settledAt, origin: input.origin,
        scope: admitted.scope, identity, classification: Object.freeze({ ...classification }),
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
