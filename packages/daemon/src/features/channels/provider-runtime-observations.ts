import type {
  CreateAvailabilityIncidentInput,
  ProviderPreset,
} from "@ling-stack/core";

export interface ProviderRuntimeAvailabilityIncidentInput {
  readonly providerPreset?: ProviderPreset;
  readonly providerPresetId?: string;
  readonly agentId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly error?: unknown;
  readonly now?: string;
  readonly observedAt?: string;
  readonly expiresAt?: string | null;
}

export interface ProviderRuntimeFailureClassification {
  readonly kind: CreateAvailabilityIncidentInput["kind"];
  readonly state: CreateAvailabilityIncidentInput["state"];
  readonly severity: CreateAvailabilityIncidentInput["severity"];
  readonly ttlMs: number;
  readonly label: string;
}

const MINUTE_MS = 60 * 1000;

export function availabilityIncidentInputForProviderRuntimeFailure(
  input: ProviderRuntimeAvailabilityIncidentInput,
): CreateAvailabilityIncidentInput | undefined {
  const code = normalizeErrorCode(input.code ?? readErrorCode(input.error));
  const message = input.message ?? readErrorMessage(input.error);
  const classification = classifyProviderRuntimeFailure(code, message);
  if (!classification) {
    return undefined;
  }

  const providerPresetId = input.providerPreset?.id ?? input.providerPresetId;
  const observedAt = input.observedAt ?? input.now ?? new Date().toISOString();
  return {
    agentId: input.agentId,
    providerPresetId,
    modelSignature: input.providerPreset ? modelSignatureForProviderPreset(input.providerPreset) : undefined,
    state: classification.state,
    kind: classification.kind,
    severity: classification.severity,
    summary: buildAvailabilityIncidentSummary(classification, code, message, input.providerPreset, providerPresetId),
    observedAt,
    expiresAt: input.expiresAt ?? addMilliseconds(observedAt, classification.ttlMs),
  };
}


export function classifyProviderRuntimeFailure(
  code: string | undefined,
  message: string | undefined,
): ProviderRuntimeFailureClassification | undefined {
  const normalized = [code, message].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (matchesAny(normalized, ["rate_limited", "quota_exceeded", "quota exceeded", "rate limit", "too many requests", "http 429", "status 429"])) {
    return {
      kind: "quota",
      state: "rate_limited",
      severity: "medium",
      ttlMs: 20 * MINUTE_MS,
      label: "provider quota or rate limit",
    };
  }
  if (matchesAny(normalized, ["context_length_error", "context length", "maximum context", "token limit", "context window"])) {
    return {
      kind: "timeout",
      state: "slow",
      severity: "low",
      ttlMs: 5 * MINUTE_MS,
      label: "provider context window retry",
    };
  }
  if (matchesAny(normalized, ["timeout", "timed out", "aborterror", "aborted", "etimedout", "deadline exceeded"])) {
    return {
      kind: "timeout",
      state: "slow",
      severity: "medium",
      ttlMs: 10 * MINUTE_MS,
      label: "provider timeout",
    };
  }
  if (matchesAny(normalized, ["network_error", "network_failed", "fetch failed", "econnreset", "econnrefused", "enotfound", "eai_again", "socket hang up"])) {
    return {
      kind: "network",
      state: "offline",
      severity: "medium",
      ttlMs: 5 * MINUTE_MS,
      label: "provider network failure",
    };
  }
  if (matchesAny(normalized, ["provider_internal_error", "overload", "overloaded", "capacity", "unavailable", "http 500", "http 502", "http 503", "http 504", "status 500", "status 502", "status 503", "status 504"])) {
    return {
      kind: "overload",
      state: "overloaded",
      severity: "medium",
      ttlMs: 10 * MINUTE_MS,
      label: "provider overload",
    };
  }
  if (matchesAny(normalized, ["auth_failed", "unauthorized", "forbidden", "invalid api key", "unsupported_capability", "model_not_found"])) {
    return {
      kind: "unknown",
      state: "offline",
      severity: "medium",
      ttlMs: 30 * MINUTE_MS,
      label: "provider readiness failure",
    };
  }
  if (matchesAny(normalized, ["provider_error", "invalid_request"])) {
    return {
      kind: "unknown",
      state: "unknown",
      severity: "low",
      ttlMs: 2 * MINUTE_MS,
      label: "provider runtime failure",
    };
  }
  return undefined;
}

function buildAvailabilityIncidentSummary(
  classification: ProviderRuntimeFailureClassification,
  code: string | undefined,
  message: string | undefined,
  providerPreset: ProviderPreset | undefined,
  providerPresetId: string | undefined,
): string {
  const providerLabel = providerPreset
    ? `${providerPreset.displayName} (${providerPreset.model})`
    : providerPresetId ?? "unknown provider";
  const details = truncateRuntimeMessage(message ?? code);
  return details
    ? `${classification.label} observed for ${providerLabel}: ${details}`
    : `${classification.label} observed for ${providerLabel}.`;
}

function modelSignatureForProviderPreset(providerPreset: ProviderPreset): CreateAvailabilityIncidentInput["modelSignature"] {
  return {
    providerPresetId: providerPreset.id,
    providerId: providerPreset.providerId,
    model: providerPreset.model,
    api: providerPreset.api,
  };
}

function readErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code ?? error.errorCode ?? error.statusCode ?? error.status ?? error.name;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.message === "string" ? error.message : undefined;
}

function normalizeErrorCode(code: string | undefined): string | undefined {
  const trimmed = code?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function matchesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function truncateRuntimeMessage(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function addMilliseconds(iso: string, ms: number): string {
  const time = Date.parse(iso);
  return new Date((Number.isFinite(time) ? time : Date.now()) + ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
