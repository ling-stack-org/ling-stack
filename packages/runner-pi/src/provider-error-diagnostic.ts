/** Structural Runner port; the Host validates it against the RunEvent contract. */
export interface PiProviderErrorDiagnostic {
  readonly schemaVersion: 1;
  readonly category: "authentication" | "permission_denied" | "invalid_request" | "context_limit"
    | "rate_limited" | "quota_exhausted" | "provider_unavailable" | "timeout" | "network" | "cancelled" | "unknown";
  readonly basis: "structured_http_status" | "structured_error_code" | "sdk_error_marker" | "unclassified";
  readonly httpStatus?: number;
  readonly code?: string;
}

const CODE_CATEGORIES: Readonly<Record<string, PiProviderErrorDiagnostic["category"]>> = Object.freeze({
  invalid_api_key: "authentication", authentication_error: "authentication", permission_denied: "permission_denied",
  invalid_request_error: "invalid_request", context_length_exceeded: "context_limit",
  model_context_window_exceeded: "context_limit", rate_limit_exceeded: "rate_limited", insufficient_quota: "quota_exhausted",
  ETIMEDOUT: "timeout", UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout",
  ECONNRESET: "network", ECONNREFUSED: "network", ENOTFOUND: "network", EAI_AGAIN: "network", ABORT_ERR: "cancelled",
});
const UNKNOWN: PiProviderErrorDiagnostic = Object.freeze({ schemaVersion: 1, category: "unknown", basis: "unclassified" });

/**
 * Extract bounded diagnostic facts without publishing provider text, body, stack or model input.
 * Text matches are explicitly marked SDK markers, not proof of a transport HTTP response.
 * This classification is descriptive only: it must never authorize a retry or tool execution.
 */
export function classifyProviderError(value: unknown): PiProviderErrorDiagnostic {
  const error = own(value, "error");
  for (const candidate of [error, value]) {
    const code = knownCode(own(candidate, "code"));
    const httpStatus = errorStatus(own(candidate, "statusCode")) ?? errorStatus(own(candidate, "status"));
    if (code) return fromCode(code, "structured_error_code", httpStatus);
    if (httpStatus !== undefined) return fromStatus(httpStatus, "structured_http_status");
  }
  const diagnostics = own(value, "diagnostics");
  if (Array.isArray(diagnostics)) {
    for (let index = 0; index < Math.min(diagnostics.length, 16); index += 1) {
      const code = knownCode(own(own(own(diagnostics, String(index)), "error"), "code"));
      if (code) return fromCode(code, "structured_error_code");
    }
  }
  const text = own(value, "errorMessage") ?? own(value, "error_message");
  if (typeof text !== "string") return UNKNOWN;
  const prefix = text.slice(0, 128).trimStart();
  const statusMatch = /^([45]\d{2})(?:[: \t]|$)/u.exec(prefix);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  // SDK's normalized OpenAI error can contain a parsed JSON body after its status.
  // Only exact code fields are considered; free-form body text is never searched.
  const body = text.length <= 8_192 ? (statusMatch ? text.trimStart().slice(3).replace(/^[: \t]+/u, "") : text.trim()) : "";
  if (body.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      const code = knownCode(own(parsed, "code")) ?? knownCode(own(own(parsed, "error"), "code"));
      if (code) return fromCode(code, "sdk_error_marker", httpStatus);
    } catch { /* Malformed or provider-specific bodies remain unclassified. */ }
  }
  if (httpStatus !== undefined) return fromStatus(httpStatus, "sdk_error_marker");
  if (text === "Retry cancelled" || text === "Request was aborted") {
    return { schemaVersion: 1, category: "cancelled", basis: "sdk_error_marker" };
  }
  if (/^(?:Request timed out\.?|Connection timeout\.?|Connect timeout\.?)(?:$|\s)/iu.test(prefix)) {
    return { schemaVersion: 1, category: "timeout", basis: "sdk_error_marker" };
  }
  if (/^(?:Connection error\.|fetch failed|Stream ended without finish_reason)(?:$|\s)/u.test(prefix)) {
    return { schemaVersion: 1, category: "network", basis: "sdk_error_marker" };
  }
  return UNKNOWN;
}

function fromCode(code: string, basis: PiProviderErrorDiagnostic["basis"], httpStatus?: number): PiProviderErrorDiagnostic {
  return { schemaVersion: 1, category: CODE_CATEGORIES[code], basis, ...(httpStatus === undefined ? {} : { httpStatus }), code };
}

function fromStatus(httpStatus: number, basis: PiProviderErrorDiagnostic["basis"]): PiProviderErrorDiagnostic {
  const category: PiProviderErrorDiagnostic["category"] = httpStatus === 401 ? "authentication"
    : httpStatus === 403 ? "permission_denied" : httpStatus === 408 || httpStatus === 504 ? "timeout"
    : httpStatus === 429 ? "rate_limited" : httpStatus >= 500 ? "provider_unavailable"
    : [400, 404, 409, 413, 415, 422].includes(httpStatus) ? "invalid_request" : "unknown";
  return { schemaVersion: 1, category, basis, httpStatus };
}

function knownCode(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(CODE_CATEGORIES, value) ? value : undefined;
}

function errorStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

/** Read only data properties; unknown diagnostic objects must not execute accessors. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
