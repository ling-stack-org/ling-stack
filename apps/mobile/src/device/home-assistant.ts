import type {
  CapabilityDescriptorV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceErrorCodeV1,
  DeviceObservationV1,
  DeviceProfileV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";

import type { MobileDeviceExecutionResult, MobileDeviceTransport } from "./execution.ts";

const adapterId = "home-assistant-mobile-https";
const adapterVersion = "1.1.0";
const readEntityCapability: CapabilityDescriptorV1 = {
  id: "home_assistant.read_entity",
  schemaVersion: "1.0",
  semanticVerb: "read.entity_state",
  inputSchema: { type: "object", required: ["entityId"] },
  outputSchema: { type: "object", required: ["availability"] },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["home_assistant.read"],
  prerequisites: [],
  timeoutMs: 8_000,
  responseBytesLimit: 256 * 1024,
  idempotency: "request",
  supportedDeviceKinds: ["home_assistant"],
  supportedTransports: ["https"],
};
const enableAutomationCapability: CapabilityDescriptorV1 = {
  ...readEntityCapability,
  id: "home_assistant.enable_automation",
  semanticVerb: "configure.automation",
  inputSchema: { type: "object", required: ["entityId", "automationIdentity"] },
  outputSchema: { type: "object" },
  sideEffect: "reversible",
  approvalClass: "ask",
  requiredPermissions: ["home_assistant.automation.write"],
  timeoutMs: 20_000,
  idempotency: "target_revision",
  verificationCapabilityId: readEntityCapability.id,
};
const automationEnabledRule = { automationEnabled: true } as const;

export type HomeAssistantAvailability = "available" | "unavailable" | "absent";
type HomeAssistantEntityState = {
  readonly availability: HomeAssistantAvailability;
  readonly automationEnabled?: boolean;
  readonly automationIdentity?: string;
};

export class HomeAssistantInputError extends Error {}

export type HomeAssistantFetch = (
  url: string,
  init: {
    method: "GET" | "POST"; headers: Record<string, string>; body?: string;
    redirect: "error"; credentials: "omit"; signal?: AbortSignal;
  },
) => Promise<Pick<Response, "status" | "ok" | "headers" | "body" | "redirected">>;

export interface HomeAssistantDeviceInput {
  readonly origin: string;
  readonly token: string;
  readonly entityId: string;
}

export function prepareHomeAssistantDevice(input: HomeAssistantDeviceInput & {
  readonly ownerId: string;
  readonly connectionRevision: string;
  readonly fetch: HomeAssistantFetch;
  readonly now: () => string;
  readonly automationIdentity?: string;
}) {
  const origin = parseOrigin(input.origin);
  const token = input.token.trim();
  const entityId = input.entityId.trim();
  if (entityId.length > 160 || !/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(entityId)) {
    throw new HomeAssistantInputError("填写 Home Assistant 实体 ID，例如 light.living_room。");
  }
  if (token.length > 8_192 || !/^[\x21-\x7e]+$/u.test(token)) throw new HomeAssistantInputError("填写有效的 Home Assistant 访问令牌。");
  const targetId = `home-assistant:${digestIdentity(origin).slice(0, 32)}`;
  const observedAt = input.now();
  const automationIdentity = input.automationIdentity;
  const capabilities = automationIdentity ? [readEntityCapability, enableAutomationCapability] : [readEntityCapability];
  const profile: DeviceProfileV1 = {
    device: {
      id: targetId, ownerScope: input.ownerId, runtimeOwnerId: input.ownerId, displayName: "Home Assistant",
      kind: "home_assistant", lifecycleStatus: "identified", profileRevision: adapterVersion, lastSeenAt: observedAt,
    },
    adapterId, adapterVersion, transports: ["https"], connectionRefs: [origin],
    transportDeployments: [{ transport: "https", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" }],
    profileRevision: adapterVersion, source: "adapter",
  };
  const snapshot: DeviceCapabilitySnapshotV1 = {
    snapshotId: `${targetId}:${input.connectionRevision}:${adapterVersion}`,
    deviceId: targetId, adapterId, adapterVersion, contractMajor: 1, connectionRevision: input.connectionRevision,
    capabilities, observedAt, freshnessUntil: freshUntil(observedAt),
  };
  const headers = { accept: "application/json", authorization: `Bearer ${token}` };
  const auth = { redirect: "error", credentials: "omit" } as const;
  const readEntity = async (signal?: AbortSignal): Promise<
    { readonly state: HomeAssistantEntityState } | { readonly error: DeviceErrorCodeV1 }
  > => {
    try {
      const response = await input.fetch(`${origin}/api/states/${encodeURIComponent(entityId)}`, {
        method: "GET", headers: { ...headers, "cache-control": "no-cache" }, ...auth, signal,
      });
      if (response.redirected || !response.ok) {
        await response.body?.cancel();
        if (response.redirected) return { error: "service_unavailable" };
        if (response.status === 404) return { state: { availability: "absent" } };
        return { error: response.status === 401 || response.status === 403 ? "permission_denied" : "service_unavailable" };
      }
      const body = await readEntityResponse(response);
      if (body.entity_id !== entityId || typeof body.state !== "string") return { error: "service_unavailable" };
      const availability = !body.state || body.state === "unknown" || body.state === "unavailable" ? "unavailable" : "available";
      if (entityId.startsWith("automation.") && (body.state === "on" || body.state === "off")) {
        const attributes = record(body.attributes);
        const id = attributes?.id;
        return { state: {
          availability, automationEnabled: body.state === "on",
          ...(typeof id === "string" && id.trim() && id.length <= 256
            ? { automationIdentity: digestIdentity([targetId, entityId, id]) } : {}),
        } };
      }
      return { state: { availability } };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { error: "service_unavailable" };
    }
  };
  const makeObservation = (request: DeviceActionRequestV1, state: HomeAssistantEntityState, readAt: string, verify: boolean): DeviceObservationV1 => ({
    id: `${request.taskId}:${request.actionId}:${verify ? "readback" : "entity"}`,
    subjectId: verify ? targetId : entityId,
    source: "home_assistant",
    value: { entityId, ...state },
    observedAt: readAt,
    receivedAt: readAt,
    freshnessUntil: freshUntil(readAt),
    quality: state.availability === "unavailable" ? "degraded" : "good",
    provenance: [targetId, entityId],
    redactionClass: "public",
  });
  function matchesRequest(request: DeviceActionRequestV1, capability: CapabilityDescriptorV1): boolean {
    return request.targetDeviceId === targetId && request.capabilitySnapshotId === snapshot.snapshotId
      && request.capabilityId === capability.id && request.capabilitySchemaVersion === capability.schemaVersion
      && entityIdFromRequest(request) === entityId;
  }
  function matchesRecovery(request: DeviceActionRequestV1): boolean {
    const args = record(request.normalizedInput);
    return !!automationIdentity && entityId.startsWith("automation.") && matchesRequest(request, enableAutomationCapability)
      && args?.automationIdentity === automationIdentity && Object.keys(args).length === 2;
  }
  const transport: MobileDeviceTransport = {
    deviceId: targetId,
    connectionRevision: input.connectionRevision,
    permissions: capabilities.flatMap(capability => capability.requiredPermissions),
    async execute({ request, signal }) {
      const startedAt = input.now();
      const receipt = (status: "completed" | "rejected" | "uncertain", errorCode?: DeviceErrorCodeV1): MobileDeviceExecutionResult => ({
        action: { actionId: request.actionId, status, errorCode, startedAt, finishedAt: input.now(), observationIds: [] },
      });
      if (matchesRecovery(request)) {
        const current = await readEntity(signal);
        if ("error" in current) return receipt("rejected", current.error);
        if (current.state.automationIdentity !== automationIdentity || current.state.automationEnabled === undefined) {
          return receipt("rejected", "target_changed");
        }
        if (current.state.automationEnabled) return receipt("completed");
        if (signal?.aborted || !request.approval || Date.parse(request.approval.expiresAt) <= Date.parse(input.now())) {
          return receipt("rejected", "permission_denied");
        }
        const response = await input.fetch(`${origin}/api/services/automation/turn_on`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ entity_id: entityId }), ...auth, signal,
        });
        await response.body?.cancel();
        if (!response.redirected && response.ok) return receipt("completed");
        if (!response.redirected && (response.status === 401 || response.status === 403)) return receipt("rejected", "permission_denied");
        return receipt("uncertain", "unknown_outcome");
      }
      if (!matchesRequest(request, readEntityCapability)) return receipt("rejected", "invalid_request");
      const result = await readEntity(signal);
      if ("error" in result) return receipt("rejected", result.error);
      const readAt = input.now();
      const observation = makeObservation(request, result.state, readAt, false);
      return {
        action: { actionId: request.actionId, status: "completed", startedAt, finishedAt: readAt, observationIds: [observation.id] },
        observations: [observation],
      };
    },
    async verify({ request, signal }) {
      const rule = automationEnabledRule;
      const result = matchesRecovery(request) ? await readEntity(signal) : undefined;
      const checkedAt = input.now();
      if (!result || "error" in result || result.state.automationIdentity !== automationIdentity
        || result.state.automationEnabled === undefined) {
        return { actionId: request.actionId, status: "not_evaluable", rule, observationIds: [], checkedAt };
      }
      const observation = makeObservation(request, result.state, checkedAt, true);
      return {
        verification: {
          actionId: request.actionId, status: result.state.automationEnabled ? "verified" : "failed",
          rule, observationIds: [observation.id], checkedAt,
        },
        observations: [observation],
      };
    },
  };
  return {
    profile, snapshot, transport,
    entityId,
    step: { stepId: "read-entity", capabilityId: readEntityCapability.id, capabilitySchemaVersion: readEntityCapability.schemaVersion, normalizedInput: { entityId } },
    ...(automationIdentity ? { recoveryStep: {
      stepId: "enable-automation", capabilityId: enableAutomationCapability.id, capabilitySchemaVersion: enableAutomationCapability.schemaVersion,
      normalizedInput: { entityId, automationIdentity }, sideEffect: "reversible" as const, expectedVerification: automationEnabledRule,
    } } : {}),
  };
}

export function entityIdFromRequest(request: DeviceActionRequestV1): string | undefined {
  const entityId = record(request.normalizedInput)?.entityId;
  return typeof entityId === "string" ? entityId : undefined;
}

export function homeAssistantEntityState(observation: DeviceObservationV1): HomeAssistantEntityState | undefined {
  const value = record(observation.value);
  const availability = value?.availability;
  if (observation.source !== "home_assistant" || (availability !== "available" && availability !== "unavailable" && availability !== "absent")) {
    return undefined;
  }
  return {
    availability,
    ...(typeof value?.automationEnabled === "boolean" ? { automationEnabled: value.automationEnabled } : {}),
    ...(typeof value?.automationIdentity === "string" ? { automationIdentity: value.automationIdentity } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function digestIdentity(value: string | readonly string[]): string {
  return encodeBase64Url(sha256(canonicalJsonBytes(value)));
}

function freshUntil(observedAt: string): string {
  return new Date(Date.parse(observedAt) + 30_000).toISOString();
}

function parseOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") {
      return url.origin;
    }
  } catch {
    // The address is validated before the credential is used.
  }
  throw new HomeAssistantInputError("填写 Home Assistant 的 HTTPS 地址，地址中只包含主机和端口。");
}

async function readEntityResponse(response: Awaited<ReturnType<HomeAssistantFetch>>): Promise<Record<string, unknown>> {
  const limit = readEntityCapability.responseBytesLimit;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Home Assistant response exceeds its size limit");
  }
  if (!response.body) throw new Error("Home Assistant response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("Home Assistant response exceeds its size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const parsed: unknown = JSON.parse(text + decoder.decode());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Home Assistant entity response");
  return parsed as Record<string, unknown>;
}
