/** Public diagnostics contain only allow-listed facts, never provider bodies or stacks. */
export interface RunProviderErrorDiagnostic {
  readonly schemaVersion: 1;
  readonly category: "authentication" | "permission_denied" | "invalid_request" | "context_limit"
    | "rate_limited" | "quota_exhausted" | "provider_unavailable" | "timeout" | "network" | "cancelled" | "unknown";
  readonly basis: "structured_http_status" | "structured_error_code" | "sdk_error_marker" | "unclassified";
  readonly httpStatus?: number;
  readonly code?: string;
}

/** SDK retries stay within one Host Attempt and cannot authorize an execution or recovery. */
export type RunProviderRetryEvidence = { readonly policyVersion: "pi_sdk_retry_v1" } & (
  | { readonly scope: "assistant" | "summarization"; readonly phase: "scheduled";
      readonly retryAttempt: number; readonly maxRetryAttempts: number; readonly delayMs: number;
      readonly errorDiagnostic: RunProviderErrorDiagnostic }
  | { readonly scope: "assistant"; readonly phase: "settled"; readonly retryAttempt: number;
      readonly outcome: "succeeded" | "failed" | "cancelled"; readonly errorDiagnostic?: RunProviderErrorDiagnostic }
  | { readonly scope: "summarization"; readonly phase: "attempt_start";
      readonly source: "compaction" | "branch_summary"; readonly reason?: "manual" | "threshold" | "overflow" }
  | { readonly scope: "summarization"; readonly phase: "settled" }
);

const CODE_CATEGORIES: Readonly<Record<string, RunProviderErrorDiagnostic["category"]>> = Object.freeze({
  invalid_api_key: "authentication", authentication_error: "authentication", permission_denied: "permission_denied",
  invalid_request_error: "invalid_request", context_length_exceeded: "context_limit",
  model_context_window_exceeded: "context_limit", rate_limit_exceeded: "rate_limited", insufficient_quota: "quota_exhausted",
  ETIMEDOUT: "timeout", UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout",
  ECONNRESET: "network", ECONNREFUSED: "network", ENOTFOUND: "network", EAI_AGAIN: "network", ABORT_ERR: "cancelled",
});
const CATEGORIES = new Set<RunProviderErrorDiagnostic["category"]>([
  "authentication", "permission_denied", "invalid_request", "context_limit", "rate_limited", "quota_exhausted",
  "provider_unavailable", "timeout", "network", "cancelled", "unknown",
]);

export function isRunProviderErrorDiagnostic(value: unknown): value is RunProviderErrorDiagnostic {
  if (!isRecord(value) || !onlyKeys(value, ["schemaVersion", "category", "basis", "httpStatus", "code"])) return false;
  if (value.schemaVersion !== 1 || typeof value.category !== "string" || !CATEGORIES.has(value.category as RunProviderErrorDiagnostic["category"])) return false;
  if (!["structured_http_status", "structured_error_code", "sdk_error_marker", "unclassified"].some(basis => basis === value.basis)) return false;
  if (value.httpStatus !== undefined && (typeof value.httpStatus !== "number"
    || !Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599)) return false;
  if (value.code !== undefined && (typeof value.code !== "string" || !Object.hasOwn(CODE_CATEGORIES, value.code)
    || CODE_CATEGORIES[value.code] !== value.category)) return false;
  if (value.basis === "structured_http_status" && value.httpStatus === undefined) return false;
  if (value.basis === "structured_error_code" && value.code === undefined) return false;
  return value.basis !== "unclassified" || (value.category === "unknown" && value.httpStatus === undefined && value.code === undefined);
}

export function isRunProviderRetryEvidence(value: unknown): value is RunProviderRetryEvidence {
  if (!isRecord(value) || !onlyKeys(value, ["type", "attemptId", "policyVersion", "scope", "phase", "retryAttempt",
    "maxRetryAttempts", "delayMs", "errorDiagnostic", "outcome", "source", "reason"])
    || value.policyVersion !== "pi_sdk_retry_v1"
    || (value.scope !== "assistant" && value.scope !== "summarization")
    || (value.type !== undefined && value.type !== "provider_retry")
    || (value.attemptId !== undefined && (typeof value.attemptId !== "string" || !value.attemptId.trim()))) return false;
  const common = ["type", "attemptId", "policyVersion", "scope", "phase"];
  if (value.phase === "scheduled") {
    return onlyKeys(value, [...common, "retryAttempt", "maxRetryAttempts", "delayMs", "errorDiagnostic"])
      && positiveInteger(value.retryAttempt) && positiveInteger(value.maxRetryAttempts)
      && Number(value.retryAttempt) <= Number(value.maxRetryAttempts)
      && typeof value.delayMs === "number" && Number.isSafeInteger(value.delayMs) && value.delayMs >= 0
      && isRunProviderErrorDiagnostic(value.errorDiagnostic);
  }
  if (value.scope === "assistant" && value.phase === "settled") {
    return onlyKeys(value, [...common, "retryAttempt", "outcome", "errorDiagnostic"])
      && positiveInteger(value.retryAttempt)
      && (value.outcome === "succeeded" ? value.errorDiagnostic === undefined
        : (value.outcome === "failed" || value.outcome === "cancelled") && isRunProviderErrorDiagnostic(value.errorDiagnostic));
  }
  if (value.scope === "summarization" && value.phase === "attempt_start") {
    return onlyKeys(value, [...common, "source", "reason"])
      && (value.source === "branch_summary" ? value.reason === undefined
        : value.source === "compaction" && ["manual", "threshold", "overflow"].some(reason => reason === value.reason));
  }
  // Pi's summarization_retry_finished has no success/failure or attempt number.
  return value.scope === "summarization" && value.phase === "settled" && onlyKeys(value, common);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
