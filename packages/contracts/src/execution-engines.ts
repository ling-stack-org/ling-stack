export const externalExecutionEngineIds = ["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"] as const;
export type ExternalExecutionEngineId = typeof externalExecutionEngineIds[number];
export type ExecutionEngineId = "pi" | ExternalExecutionEngineId;

export const kimiProviderTypes = ["kimi", "anthropic", "openai", "openai_responses", "google-genai", "vertexai"] as const;
export interface KimiApiKeyConfiguration {
  readonly providerType: typeof kimiProviderTypes[number];
  readonly baseUrl: string;
  readonly modelId: string;
  readonly maxContextSize: number;
}

export function isExternalExecutionEngineId(value: unknown): value is ExternalExecutionEngineId {
  return typeof value === "string" && externalExecutionEngineIds.some((id) => id === value);
}

export interface ExecutionEngineProfileConfiguration {
  readonly engineId: ExternalExecutionEngineId;
  readonly executablePath: string;
  readonly authProfileId: string;
  readonly secretRef?: string;
  readonly kimi?: KimiApiKeyConfiguration;
  readonly kimiLoginRegion?: "mainland-cn" | "global";
  readonly openclaw?: {
    readonly gatewayUrl: string;
    readonly agentId: string;
    readonly credentialType?: "token" | "password";
  };
}

export interface ExecutionEngineProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly status: "configured" | "disconnected";
  readonly configuration: ExecutionEngineProfileConfiguration;
  readonly configurationFingerprint: string;
  readonly updatedAt: string;
}

export interface SaveExecutionEngineProfileRequest {
  readonly expectedRevision: number;
  readonly configuration: ExecutionEngineProfileConfiguration;
}

/** Write-only management input; never part of a saved profile or response. */
export interface SaveExecutionEngineSecretRequest {
  readonly expectedRevision: number;
  readonly configuration: Omit<ExecutionEngineProfileConfiguration, "secretRef">;
  readonly secret: string;
}

export function isExecutionEngineSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) && new TextEncoder().encode(value).length <= 2048;
}

export interface ExecutionEngineProfileListResponse {
  readonly profiles: readonly ExecutionEngineProfile[];
}

export interface ExecutionEngineProfileResponse {
  readonly profile: ExecutionEngineProfile;
}

export interface ExecutionEngineManagementSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface ExecutionEngineInstallationProbe {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly configurationFingerprint: string;
  readonly checkedAt: string;
  readonly status: "installed" | "not_found" | "not_executable" | "unexpected_runtime" | "probe_failed" | "timed_out" | "cancelled" | "output_limit";
  readonly runtimeVersion?: string;
  readonly executableDigest?: string;
  readonly authentication: "not_checked";
  readonly connection: "not_checked";
}

export type ExecutionEngineProbeMode = "installation" | "connection";

export interface ExecutionEngineConnectionProbe extends Omit<ExecutionEngineInstallationProbe, "status" | "authentication" | "connection"> {
  readonly mode: "connection";
  readonly status: Exclude<ExecutionEngineInstallationProbe["status"], "installed"> | "connected" | "protocol_error"
    | "unsupported_engine" | "unsupported_platform" | "unsupported_auth" | "auth_required";
  readonly errorCode?: string;
  readonly authentication: "not_checked" | "required" | "configured_unverified" | "provider_managed";
  readonly connection: "not_checked" | "connected";
}

export type ExecutionEngineProbe = ExecutionEngineInstallationProbe | ExecutionEngineConnectionProbe;

export type ExecutionEngineLoginMethod = "chatgpt" | "chatgptDeviceCode" | "apiKey" | "terminal";
export type ExecutionEngineLoginChallenge =
  | { readonly type: "browser"; readonly url: string }
  | { readonly type: "device_code"; readonly url: string; readonly userCode: string }
  | { readonly type: "terminal"; readonly text: string };

export interface ExecutionEngineLoginOperation {
  readonly id: string;
  readonly engineId: ExternalExecutionEngineId;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly expiresAt: string;
  readonly status: "starting" | "waiting" | "cancelling" | "completed" | "cancelled" | "timed_out" | "failed";
  readonly challenge?: ExecutionEngineLoginChallenge;
  readonly authentication?: "login_completed" | "configured_unverified";
  readonly errorCode?: string;
}

export type ExecutionBindingRequest =
  | { readonly kind: "pi_provider"; readonly providerPresetId: string }
  | { readonly kind: "native_profile"; readonly engineId: ExternalExecutionEngineId;
      readonly profileId: string; readonly profileRevision: number; readonly nativeModelId?: string };

export class ExecutionBindingError extends Error {
  readonly code = "execution_binding_invalid";

  constructor() {
    super("execution_binding_invalid");
  }
}

export function parseExecutionBindingRequest(value: unknown): ExecutionBindingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutionBindingError();
  const input = value as Record<string, unknown>;
  if (input.kind === "pi_provider" && bindingKeys(input, ["kind", "providerPresetId"]) && bindingText(input.providerPresetId, 256)) {
    return { kind: "pi_provider", providerPresetId: input.providerPresetId };
  }
  if (input.kind === "native_profile" && bindingKeys(input, ["kind", "engineId", "profileId", "profileRevision", "nativeModelId"])
    && isExternalExecutionEngineId(input.engineId) && bindingText(input.profileId, 256)
    && typeof input.profileRevision === "number" && Number.isSafeInteger(input.profileRevision) && input.profileRevision > 0
    && (input.nativeModelId === undefined || bindingText(input.nativeModelId, 512))) {
    return { kind: "native_profile", engineId: input.engineId, profileId: input.profileId, profileRevision: input.profileRevision,
      ...(input.nativeModelId === undefined ? {} : { nativeModelId: input.nativeModelId }) };
  }
  // Submitted values can contain pasted credentials. Errors carry only a stable code.
  throw new ExecutionBindingError();
}

function bindingText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function bindingKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export interface ExecutionEngineProfileReference {
  readonly workspaceId: string;
  readonly referenceId: string;
}

export type ExecutionEngineProfileErrorCode = "profile_invalid" | "profile_revision_conflict" | "profile_not_found"
  | "profile_store_invalid" | "profile_in_use" | "profile_unavailable" | "profile_reference_conflict";
