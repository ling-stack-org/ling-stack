import {
  type ProviderPreset,
  type ProviderStoreFacet,
  type ResolvedSecret,
  type SecretResolver,
  type SecretStatus,
} from "@ling-stack/core";
import { resolveProviderSecret } from "./secrets.js";

export class ProviderSecretMaterializationError extends Error {
  readonly code: string;
  readonly status?: SecretStatus;

  constructor(code: string, message: string, status?: SecretStatus) {
    super(message);
    this.name = "ProviderSecretMaterializationError";
    this.code = code;
    this.status = status;
  }
}

export interface MaterializeProviderSecretsInput {
  readonly store: ProviderStoreFacet;
  readonly preset: ProviderPreset;
  readonly secretResolver: SecretResolver;
  readonly apiKeyOverride?: string;
  readonly baseHeaders?: Record<string, string>;
}

export interface MaterializedProviderSecrets {
  readonly apiKeySecret: ResolvedSecret;
  readonly headers: Record<string, string>;
  readonly secretHeaderStatuses: Record<string, SecretStatus>;
  readonly redactionValues: readonly string[];
}

export function materializeProviderSecrets(input: MaterializeProviderSecretsInput): MaterializedProviderSecrets {
  const apiKeySecret = materializeProviderApiKey(input);
  const secretHeaders = materializeProviderSecretHeaders(input.preset, input.secretResolver);
  return {
    apiKeySecret,
    headers: {
      ...(input.baseHeaders ?? {}),
      ...input.preset.headers,
      ...secretHeaders.headers,
    },
    secretHeaderStatuses: secretHeaders.statuses,
    redactionValues: [
      apiKeySecret.value,
      ...secretHeaders.values,
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
  };
}

export function providerSecretHeaderStatuses(
  preset: Pick<ProviderPreset, "secretHeaderRefs">,
  secretResolver: SecretResolver,
): Record<string, SecretStatus> {
  const statuses: Record<string, SecretStatus> = {};
  for (const [headerName, ref] of Object.entries(preset.secretHeaderRefs ?? {})) {
    statuses[headerName] = secretResolver.status(ref, "custom_header");
  }
  return statuses;
}

export function applyProviderAuthHeaders(
  headers: Record<string, string>,
  preset: Pick<ProviderPreset, "api" | "authHeader">,
  apiKey: string | undefined,
): Record<string, string> {
  if (preset.api === "anthropic-messages") {
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }
  if (preset.authHeader !== false && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function materializeProviderApiKey(input: MaterializeProviderSecretsInput): ResolvedSecret {
  if (input.apiKeyOverride) {
    return {
      ref: "__request_api_key__",
      configured: true,
      value: input.apiKeyOverride,
      status: {
        ref: "__request_api_key__",
        kind: "local",
        configured: true,
      },
    };
  }
  return input.preset.apiKeyRef
    ? resolveProviderSecret(input.store, input.preset, input.secretResolver)
    : { configured: false };
}

export function materializeProviderSecretHeaders(
  preset: Pick<ProviderPreset, "secretHeaderRefs">,
  secretResolver: SecretResolver,
): {
  readonly headers: Record<string, string>;
  readonly statuses: Record<string, SecretStatus>;
  readonly values: readonly string[];
} {
  const headers: Record<string, string> = {};
  const statuses: Record<string, SecretStatus> = {};
  const values: string[] = [];
  for (const [headerName, ref] of Object.entries(preset.secretHeaderRefs ?? {})) {
    const resolved = secretResolver.resolve(ref, "custom_header");
    const status = resolved.status ?? secretResolver.status(ref, "custom_header");
    statuses[headerName] = status;
    if (!resolved.configured || !resolved.value) {
      throw new ProviderSecretMaterializationError(
        status.errorCode ?? "secret_missing",
        status.message ?? `Secret header is not configured: ${headerName}.`,
        status,
      );
    }
    headers[headerName] = resolved.value;
    values.push(resolved.value);
  }
  return { headers, statuses, values };
}
