import { createHash } from "node:crypto";

import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationQualityV1,
  DeviceProfileV1,
  DeviceActionResultV1,
  DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import type { DeviceAdapter, DeviceAdapterDiscoveryInput, DeviceAdapterExecutionResult } from "@ling-stack/core";
import type { JsonValue } from "@ling-stack/contracts";

export interface HomeAssistantEntityRead {
  readonly entityId: string;
  readonly state?: string;
  readonly attributes: Record<string, unknown>;
  readonly availability: "available" | "unavailable" | "absent";
  readonly quality: DeviceObservationQualityV1;
  readonly observedAt: string;
}

export interface HomeAssistantAdapterOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => string;
}

const homeAssistantManifest: AdapterManifestV1 = {
  adapterId: "home-assistant-http",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["home_assistant"],
  supportedTransports: ["https"],
  transportDeployments: [{
    transport: "https",
    mode: "none",
    pairing: "credential_reference",
    removal: "revoke_credentials",
  }],
  requiredRuntime: "pc",
  authenticationMethods: ["bearer_token"],
  capabilities: [
    {
      id: "home_assistant.read_entity",
      schemaVersion: "1.0",
      semanticVerb: "read.entity_state",
      inputSchema: { type: "object", required: ["entityId"] },
      outputSchema: { type: "object" },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["home_assistant.read"],
      prerequisites: [],
      timeoutMs: 8_000,
      responseBytesLimit: 256 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["home_assistant"],
      supportedTransports: ["https"],
      displayMetadata: { label: "Read entity state", category: "diagnostics" },
    },
    {
      id: "home_assistant.reload_config_entry",
      schemaVersion: "1.0",
      semanticVerb: "reload.integration",
      inputSchema: { type: "object", required: ["entryId"] },
      outputSchema: { type: "object" },
      sideEffect: "reversible",
      approvalClass: "ask",
      requiredPermissions: ["home_assistant.service"],
      prerequisites: [],
      timeoutMs: 8_000,
      responseBytesLimit: 64 * 1024,
      idempotency: "request",
      verificationCapabilityId: "home_assistant.read_entity",
      supportedDeviceKinds: ["home_assistant"],
      supportedTransports: ["https"],
      displayMetadata: { label: "Reload integration", category: "repair" },
    },
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "Home Assistant", category: "smart_home" },
};

export class HomeAssistantAdapter implements DeviceAdapter {
  readonly manifest = homeAssistantManifest;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;

  constructor(options: HomeAssistantAdapterOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Home Assistant base URL must not contain credentials or query data");
    }
    if (!options.token.trim()) throw new Error("Home Assistant token is required");
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    await this.request("/api/config", { method: "GET", signal: input.signal });
    const deviceId = `home-assistant:${createHash("sha256").update(this.#baseUrl).digest("hex").slice(0, 24)}`;
    return {
      device: {
        id: deviceId,
        ownerScope: input.ownerId,
        displayName: "Home Assistant",
        kind: "home_assistant",
        vendor: "Home Assistant",
        model: "core",
        lifecycleStatus: "healthy",
        profileRevision: `ha:${this.#baseUrl}`,
        runtimeOwnerId: input.ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["https"],
      connectionRefs: [`https:${new URL(this.#baseUrl).host}`],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision: `ha:${this.#baseUrl}`,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly signal?: AbortSignal }): Promise<DeviceCapabilitySnapshotV1> {
    await this.request("/api/config", { method: "GET", signal: input.signal });
    return {
      snapshotId: `${input.profile.device.id}:${input.connectionRevision}:${this.#now()}`,
      deviceId: input.profile.device.id,
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      contractMajor: 1,
      connectionRevision: input.connectionRevision,
      capabilities: this.manifest.capabilities,
      observedAt: this.#now(),
      freshnessUntil: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
    };
  }

  async readEntity(entityId: string, signal?: AbortSignal): Promise<HomeAssistantEntityRead> {
    if (!/^([a-z0-9_]+)\.([a-z0-9_]+)$/u.test(entityId)) throw new Error("Invalid Home Assistant entity id");
    const observedAt = this.#now();
    const response = await this.request(`/api/states/${encodeURIComponent(entityId)}`, { method: "GET", signal, allowNotFound: true });
    if (response.status === 404) {
      return { entityId, attributes: {}, availability: "absent", quality: "unknown", observedAt };
    }
    const body = await readJson(response);
    const state = typeof body.state === "string" ? body.state : undefined;
    const attributes = isRecord(body.attributes) ? body.attributes : {};
    if (state === "unavailable") {
      return { entityId, state, attributes, availability: "unavailable", quality: "degraded", observedAt };
    }
    return { entityId, state, attributes, availability: "available", quality: "good", observedAt };
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    const args = asObject(input.request.normalizedInput);
    if (input.capability.id === "home_assistant.read_entity") {
      const entity = await this.readEntity(requireString(args.entityId, "entityId"), input.signal);
      const action: DeviceActionResultV1 = {
        actionId: input.request.actionId,
        status: entity.availability === "absent" ? "rejected" : "completed",
        errorCode: entity.availability === "absent" ? "missing_target" : undefined,
        startedAt,
        finishedAt: this.#now(),
        observationIds: [`${input.request.actionId}:entity`],
      };
      if (entity.availability === "absent") return action;
      return {
        action,
        observations: [{
          id: `${input.request.actionId}:entity`,
          subjectId: entity.entityId,
          source: "home_assistant",
          value: { entityId: entity.entityId, state: entity.state ?? null, availability: entity.availability, attributes: entity.attributes as Record<string, JsonValue> },
          observedAt: entity.observedAt,
          receivedAt: this.#now(),
          freshnessUntil: new Date(Date.parse(entity.observedAt) + 30_000).toISOString(),
          quality: entity.quality,
          provenance: [this.#baseUrl, entity.entityId],
          redactionClass: "public",
        }],
      };
    }
    if (input.capability.id !== "home_assistant.reload_config_entry") {
      return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
    }
    const entryId = requireString(args.entryId, "entryId");
    const response = await this.request("/api/services/homeassistant/reload_config_entry", {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({ entry_id: entryId }),
    });
    await response.arrayBuffer();
    return { actionId: input.request.actionId, status: response.ok ? "completed" : "rejected", errorCode: response.ok ? undefined : "service_unavailable", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1 }): Promise<DeviceVerificationResultV1> {
    const args = asObject(input.request.normalizedInput);
    if (input.capability.id !== "home_assistant.reload_config_entry") {
      return { actionId: input.request.actionId, status: "not_evaluable", rule: input.request.expectedVerification ?? null, observationIds: input.action.observationIds, checkedAt: this.#now(), reason: "no verification rule for this action" };
    }
    const entityId = typeof args.entityId === "string" ? args.entityId : undefined;
    if (!entityId) return { actionId: input.request.actionId, status: "not_evaluable", rule: input.request.expectedVerification ?? null, observationIds: [], checkedAt: this.#now(), reason: "verification entity was not supplied" };
    const entity = await this.readEntity(entityId);
    return { actionId: input.request.actionId, status: entity.availability === "available" ? "verified" : "failed", rule: input.request.expectedVerification ?? { availability: "available" }, observationIds: [`${input.request.actionId}:verification`], checkedAt: this.#now(), reason: entity.availability === "available" ? undefined : entity.availability };
  }

  private async request(path: string, init: RequestInit & { readonly allowNotFound?: boolean }): Promise<Response> {
    const { allowNotFound, ...requestInit } = init;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...requestInit,
      headers: { accept: "application/json", authorization: `Bearer ${this.#token}`, ...(requestInit.headers ?? {}) },
      redirect: "error",
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      await response.arrayBuffer();
      throw new Error(`Home Assistant request failed: ${response.status}`);
    }
    return response;
  }
}

export function homeAssistantAdapterManifest(): AdapterManifestV1 {
  return homeAssistantManifest;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) throw new Error("Home Assistant response exceeds the adapter limit");
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
