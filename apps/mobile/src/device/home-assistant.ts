import type {
  CapabilityDescriptorV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";

import type { MobileDeviceExecutionResult, MobileDeviceTransport } from "./execution.ts";

const adapterId = "home-assistant-mobile-https";
const adapterVersion = "1.0.0";
const capability: CapabilityDescriptorV1 = {
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

export type HomeAssistantAvailability = "available" | "unavailable" | "absent";
export class HomeAssistantInputError extends Error {}

export type HomeAssistantFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "error"; credentials: "omit"; signal?: AbortSignal },
) => Promise<Pick<Response, "status" | "ok" | "headers" | "body" | "redirected">>;

export function prepareHomeAssistantDiagnosis(input: {
  readonly origin: string;
  readonly token: string;
  readonly entityId: string;
  readonly ownerId: string;
  readonly connectionRevision: string;
  readonly fetch: HomeAssistantFetch;
  readonly now: () => string;
}) {
  const origin = parseOrigin(input.origin);
  const token = input.token.trim();
  const entityId = input.entityId.trim();
  if (entityId.length > 160 || !/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(entityId)) {
    throw new HomeAssistantInputError("填写 Home Assistant 实体 ID，例如 light.living_room。");
  }
  if (token.length > 8_192 || !/^[\x21-\x7e]+$/u.test(token)) throw new HomeAssistantInputError("填写有效的 Home Assistant 访问令牌。");
  const targetId = `home-assistant:${encodeBase64Url(sha256(canonicalJsonBytes(origin))).slice(0, 32)}`;
  const observedAt = input.now();
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
    capabilities: [capability], observedAt, freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
  };
  const transport: MobileDeviceTransport = {
    deviceId: targetId,
    connectionRevision: input.connectionRevision,
    permissions: capability.requiredPermissions,
    async execute({ request, signal }) {
      const startedAt = input.now();
      const reject = (errorCode: "permission_denied" | "invalid_request" | "service_unavailable"): MobileDeviceExecutionResult => ({
        action: { actionId: request.actionId, status: "rejected", errorCode, startedAt, finishedAt: input.now(), observationIds: [] },
      });
      if (request.targetDeviceId !== targetId || request.capabilitySnapshotId !== snapshot.snapshotId
        || request.capabilityId !== capability.id || request.capabilitySchemaVersion !== capability.schemaVersion
        || entityIdFromRequest(request) !== entityId) return reject("invalid_request");

      let availability: HomeAssistantAvailability;
      try {
        const response = await input.fetch(`${origin}/api/states/${encodeURIComponent(entityId)}`, {
          method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` },
          redirect: "error", credentials: "omit", signal,
        });
        if (response.redirected || !response.ok) {
          await response.body?.cancel();
          if (response.redirected) return reject("service_unavailable");
          if (response.status === 401 || response.status === 403) return reject("permission_denied");
          if (response.status !== 404) return reject("service_unavailable");
          availability = "absent";
        } else {
          const body = await readEntityResponse(response);
          if (body.entity_id !== entityId || typeof body.state !== "string") return reject("service_unavailable");
          availability = !body.state || body.state === "unknown" || body.state === "unavailable" ? "unavailable" : "available";
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        return reject("service_unavailable");
      }
      const readAt = input.now();
      const observation: DeviceObservationV1 = {
        id: `${request.taskId}:${request.actionId}:entity`, subjectId: entityId, source: "home_assistant",
        value: { entityId, availability }, observedAt: readAt, receivedAt: readAt,
        freshnessUntil: new Date(Date.parse(readAt) + 30_000).toISOString(),
        quality: availability === "unavailable" ? "degraded" : "good",
        provenance: [targetId, entityId], redactionClass: "public",
      };
      return {
        action: { actionId: request.actionId, status: "completed", startedAt, finishedAt: readAt, observationIds: [observation.id] },
        observations: [observation],
      };
    },
  };
  return {
    profile, snapshot, transport,
    step: { stepId: "read-entity", capabilityId: capability.id, capabilitySchemaVersion: capability.schemaVersion, normalizedInput: { entityId } },
  };
}

export function entityIdFromRequest(request: DeviceActionRequestV1): string | undefined {
  const input = request.normalizedInput;
  if (!input || typeof input !== "object" || Array.isArray(input) || !("entityId" in input)) return undefined;
  return typeof input.entityId === "string" ? input.entityId : undefined;
}

export function homeAssistantAvailability(observation: DeviceObservationV1): HomeAssistantAvailability | undefined {
  const value = observation.value;
  if (observation.source !== "home_assistant" || !value || typeof value !== "object" || Array.isArray(value) || !("availability" in value)) {
    return undefined;
  }
  return value.availability === "available" || value.availability === "unavailable" || value.availability === "absent"
    ? value.availability
    : undefined;
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
  const limit = capability.responseBytesLimit;
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
