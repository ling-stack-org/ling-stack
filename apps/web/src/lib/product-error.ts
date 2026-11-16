export type ProductErrorTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export interface ProductError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly technicalMessage?: string;
}

export interface ProductErrorOptions {
  readonly codeMessages?: Readonly<Record<string, string>>;
  readonly fallbackMessage?: string;
}

const defaultFallbackMessage = "The operation could not be completed. Try again.";

const missingCredentialCodes = new Set([
  "api_key_missing",
  "secret_missing",
  "secret_store_unavailable",
]);
const authenticationCodes = new Set([
  "auth_failed",
  "authentication_failed",
  "invalid_api_key",
  "unauthorized",
]);
const permissionCodes = new Set(["forbidden", "permission_denied"]);
const rateLimitCodes = new Set(["rate_limit", "rate_limited", "too_many_requests"]);
const timeoutCodes = new Set(["request_timeout", "timeout", "timed_out"]);
const transportCodes = new Set(["connection_failed", "network_failed", "transport_failed"]);
const conflictCodes = new Set(["conflict", "revision_conflict"]);
const notFoundCodes = new Set(["gone", "not_found"]);
const validationCodes = new Set(["bad_request", "invalid_request", "validation_failed"]);

export function toProductError(
  error: unknown,
  translate: ProductErrorTranslate,
  options: ProductErrorOptions = {},
): ProductError {
  const technicalMessage = readTechnicalMessage(error);
  const sourceCode = readStringField(error, "code") ?? readStringField(error, "error");
  const normalizedCode = sourceCode?.trim().toLowerCase() ?? "";
  const status = readNumberField(error, "status");
  const normalizedMessage = technicalMessage.toLowerCase();
  const classification = classifyProductError({ normalizedCode, normalizedMessage, status, error });
  const code = sourceCode?.trim() || classification.code;
  const messageKey = (options.codeMessages?.[normalizedCode] ?? classification.messageKey)
    || options.fallbackMessage
    || defaultFallbackMessage;

  return {
    code,
    message: translate(messageKey),
    ...(status === undefined ? {} : { status }),
    ...(technicalMessage ? { technicalMessage } : {}),
  };
}

function classifyProductError(input: {
  readonly error: unknown;
  readonly normalizedCode: string;
  readonly normalizedMessage: string;
  readonly status?: number;
}): { readonly code: string; readonly messageKey: string } {
  const codeClassification = classifyProductErrorCode(input.normalizedCode);
  if (codeClassification) return codeClassification;

  if (input.status === 401) {
    return {
      code: "auth_failed",
      messageKey: "Authentication failed. Check the API key and account permissions, then try again.",
    };
  }
  if (input.status === 403) {
    return {
      code: "permission_denied",
      messageKey: "Permission denied. Check account permissions and try again.",
    };
  }
  if (input.status === 429) {
    return { code: "rate_limited", messageKey: "Too many requests. Wait a moment and try again." };
  }
  if (input.status === 408 || input.status === 504) {
    return { code: "timeout", messageKey: "The request timed out. Try again." };
  }
  if (input.status === 409) {
    return { code: "conflict", messageKey: "This item changed elsewhere. Refresh and try again." };
  }
  if (input.status === 404 || input.status === 410) {
    return {
      code: "not_found",
      messageKey: "The requested item is no longer available. Refresh and try again.",
    };
  }
  if (input.status === 400 || input.status === 422) {
    return { code: "validation_failed", messageKey: "Some information is invalid. Check the fields and try again." };
  }
  if (input.status !== undefined && input.status >= 500) {
    return {
      code: "service_unavailable",
      messageKey: "The service is temporarily unavailable. Try again shortly.",
    };
  }
  if (readStringField(input.error, "name") === "LingDaemonTransportError") {
    return {
      code: "transport_failed",
      messageKey: "Could not connect to the local service. Check its status and try again.",
    };
  }

  return classifyProductErrorMessage(input.normalizedMessage)
    ?? { code: "unknown", messageKey: "" };
}

function classifyProductErrorCode(normalizedCode: string): { readonly code: string; readonly messageKey: string } | undefined {
  if (missingCredentialCodes.has(normalizedCode)) {
    return { code: "secret_missing", messageKey: "API key is missing. Add it and try again." };
  }
  if (authenticationCodes.has(normalizedCode)) {
    return {
      code: "auth_failed",
      messageKey: "Authentication failed. Check the API key and account permissions, then try again.",
    };
  }
  if (permissionCodes.has(normalizedCode)) {
    return {
      code: "permission_denied",
      messageKey: "Permission denied. Check account permissions and try again.",
    };
  }
  if (rateLimitCodes.has(normalizedCode)) {
    return { code: "rate_limited", messageKey: "Too many requests. Wait a moment and try again." };
  }
  if (timeoutCodes.has(normalizedCode)) {
    return { code: "timeout", messageKey: "The request timed out. Try again." };
  }
  if (transportCodes.has(normalizedCode)) {
    return {
      code: "transport_failed",
      messageKey: "Could not connect to the local service. Check its status and try again.",
    };
  }
  if (conflictCodes.has(normalizedCode)) {
    return { code: "conflict", messageKey: "This item changed elsewhere. Refresh and try again." };
  }
  if (notFoundCodes.has(normalizedCode)) {
    return {
      code: "not_found",
      messageKey: "The requested item is no longer available. Refresh and try again.",
    };
  }
  if (validationCodes.has(normalizedCode)) {
    return { code: "validation_failed", messageKey: "Some information is invalid. Check the fields and try again." };
  }
  return undefined;
}

function classifyProductErrorMessage(normalizedMessage: string): { readonly code: string; readonly messageKey: string } | undefined {
  if (includesAny(normalizedMessage, ["api key missing", "secret_missing"])) {
    return { code: "secret_missing", messageKey: "API key is missing. Add it and try again." };
  }
  if (includesAny(normalizedMessage, ["auth_failed", "invalid api key", "unauthorized"])) {
    return {
      code: "auth_failed",
      messageKey: "Authentication failed. Check the API key and account permissions, then try again.",
    };
  }
  if (includesAny(normalizedMessage, ["permission denied", "forbidden"])) {
    return {
      code: "permission_denied",
      messageKey: "Permission denied. Check account permissions and try again.",
    };
  }
  if (includesAny(normalizedMessage, ["rate limit", "too many requests"])) {
    return { code: "rate_limited", messageKey: "Too many requests. Wait a moment and try again." };
  }
  if (includesAny(normalizedMessage, ["operation was aborted", "request timed out", "timeout"])) {
    return { code: "timeout", messageKey: "The request timed out. Try again." };
  }
  if (includesAny(normalizedMessage, ["failed to fetch", "network error", "network request failed"])) {
    return {
      code: "transport_failed",
      messageKey: "Could not connect to the local service. Check its status and try again.",
    };
  }
  return undefined;
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function readTechnicalMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  const message = readStringField(error, "message");
  if (message) return message.trim();
  return typeof error === "number" || typeof error === "boolean" ? String(error) : "";
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
