import { createHash } from "node:crypto";

import type {
  AdapterManifestV1,
  CapabilityDescriptorV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceObservationQualityV1,
  DeviceProfileV1,
  DeviceActionResultV1,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError,
  type DeviceAdapter,
  type DeviceAdapterDiscoveryInput,
  type DeviceAdapterExecutionResult,
  type DeviceAdapterVerificationInput,
  type DeviceAdapterVerificationResult,
} from "@ling-stack/core";

import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";
import {
  assertHomeAssistantCatalogQuery, HOME_ASSISTANT_CATALOG_MAX_BYTES, homeAssistantCatalogCapabilities, homeAssistantEntityAvailability,
  projectHomeAssistantCatalog, readHomeAssistantDeviceRegistry, type HomeAssistantCatalogKind, type HomeAssistantCatalogQuery,
} from "./home-assistant-catalog.js";

export interface HomeAssistantEntityRead {
  readonly entityId: string;
  readonly availability: "available" | "unavailable" | "absent";
  readonly quality: DeviceObservationQualityV1;
  readonly observedAt: string;
  readonly lastReportedAt?: string;
  readonly lastUpdatedAt?: string;
  readonly lastChangedAt?: string;
  readonly reportTimestampStatus: "valid" | "missing" | "invalid" | "future";
  readonly reportFreshness: "fresh" | "stale" | "unknown";
}

export interface HomeAssistantAdapterOptions {
  readonly baseUrl: string;
  readonly token: string | (() => string | undefined);
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
    ...Object.entries(homeAssistantCatalogCapabilities).map(([kind, id]): CapabilityDescriptorV1 => ({
      id,
      schemaVersion: "1.0",
      semanticVerb: `list.${kind}`,
      inputSchema: {
        type: "object", required: ["limit"], additionalProperties: false,
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, after: { type: "string" } },
      },
      outputSchema: { type: "object", required: ["kind", "items", "observedAt"] },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["home_assistant.read"],
      prerequisites: [],
      timeoutMs: 8_000,
      responseBytesLimit: 32 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["home_assistant"],
      supportedTransports: ["https"],
      displayMetadata: { label: `List Home Assistant ${kind}`, category: "diagnostics" },
    })),
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "Home Assistant", category: "smart_home" },
};

export class HomeAssistantAdapter implements DeviceAdapter {
  readonly manifest = homeAssistantManifest;
  readonly deviceId: string;
  readonly #baseUrl: string;
  readonly #token: HomeAssistantAdapterOptions["token"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;

  constructor(options: HomeAssistantAdapterOptions) {
    this.#baseUrl = parseHomeAssistantOrigin(options.baseUrl);
    this.deviceId = `home-assistant:${createHash("sha256").update(this.#baseUrl).digest("hex").slice(0, 24)}`;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const version = await this.readVersion(input.signal);
    const profileRevision = `${this.deviceId}:${version}`;
    return {
      device: {
        id: this.deviceId,
        ownerScope: input.ownerId,
        displayName: "Home Assistant",
        kind: "home_assistant",
        vendor: "Home Assistant",
        model: "core",
        lifecycleStatus: "healthy",
        firmwareVersion: version,
        profileRevision,
        runtimeOwnerId: input.ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["https"],
      connectionRefs: [`https:${new URL(this.#baseUrl).host}`],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly signal?: AbortSignal }): Promise<DeviceCapabilitySnapshotV1> {
    this.assertTarget(input.profile);
    if (await this.readVersion(input.signal) !== input.profile.device.firmwareVersion) {
      throw new DeviceBrokerError("target_changed", "Home Assistant version changed during enrollment");
    }
    return createAdapterCapabilitySnapshot(this.manifest, input, this.#now());
  }

  private async readVersion(signal?: AbortSignal): Promise<string> {
    const body = await readJson(await this.request("/api/config", { method: "GET", signal }));
    if (typeof body.version !== "string" || !/^\d{4}\.\d{1,2}(?:\.\d+)?(?:[a-z0-9.+-]{0,24})$/iu.test(body.version)) {
      throw new DeviceBrokerError("service_unavailable", "Home Assistant did not identify its version");
    }
    return body.version;
  }

  private assertTarget(profile: DeviceProfileV1): void {
    if (profile.device.id !== this.deviceId) throw new DeviceBrokerError("target_changed", "Home Assistant instance changed");
  }

  async readEntity(entityId: string, signal?: AbortSignal, maxReportAgeMs?: number): Promise<HomeAssistantEntityRead> {
    if (!/^([a-z0-9_]+)\.([a-z0-9_]+)$/u.test(entityId)) throw new Error("Invalid Home Assistant entity id");
    const response = await this.request(`/api/states/${encodeURIComponent(entityId)}`, { method: "GET", signal, allowNotFound: true });
    if (response.status === 404) {
      await response.body?.cancel();
      return { entityId, availability: "absent", quality: "unknown", observedAt: this.#now(), reportTimestampStatus: "missing", reportFreshness: "unknown" };
    }
    const body = await readJson(response);
    if (body.entity_id !== entityId) throw new DeviceBrokerError("target_changed", "Home Assistant returned another entity");
    const observedAt = this.#now();
    const availability = homeAssistantEntityAvailability(body.state);
    const reported = normalizeHomeAssistantTimestamp(body.last_reported, observedAt);
    const updated = normalizeHomeAssistantTimestamp(body.last_updated, observedAt);
    const changed = normalizeHomeAssistantTimestamp(body.last_changed, observedAt);
    const reportTimestampStatus = reported.status;
    const reportFreshness = reportTimestampStatus === "valid" && maxReportAgeMs !== undefined
      ? Date.parse(observedAt) - Date.parse(reported.value!) > maxReportAgeMs ? "stale" : "fresh"
      : "unknown";
    return { entityId, availability, quality: availability === "available" ? "good" : "degraded", observedAt,
      ...(reported.value ? { lastReportedAt: reported.value } : {}), ...(updated.value ? { lastUpdatedAt: updated.value } : {}),
      ...(changed.value ? { lastChangedAt: changed.value } : {}), reportTimestampStatus, reportFreshness };
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    this.assertTarget(input.profile);
    const startedAt = this.#now();
    const args = asObject(input.request.normalizedInput);
    const catalogKind = (Object.keys(homeAssistantCatalogCapabilities) as HomeAssistantCatalogKind[])
      .find(kind => homeAssistantCatalogCapabilities[kind] === input.capability.id);
    if (catalogKind) {
      const actionId = input.request.actionId;
      try {
        if (Object.keys(args).some(key => key !== "after" && key !== "limit") || typeof args.limit !== "number"
          || (args.after !== undefined && typeof args.after !== "string")) {
          throw new DeviceBrokerError("invalid_request", "Home Assistant catalog query is invalid");
        }
        const query = { kind: catalogKind, after: args.after, limit: args.limit };
        const value = await this.readCatalog(query, input.profile.device.firmwareVersion, input.signal);
        const observationId = `${actionId}:catalog`;
        return {
          action: { actionId, status: "completed", startedAt, finishedAt: this.#now(), observationIds: [observationId] },
          observations: [{
            id: observationId, subjectId: this.deviceId, source: "home_assistant.catalog", value,
            observedAt: value.observedAt, receivedAt: this.#now(), freshnessUntil: new Date(Date.parse(value.observedAt) + 30_000).toISOString(),
            quality: "good", provenance: [this.deviceId], redactionClass: "public",
          }],
        };
      } catch (error) {
        return { actionId, status: "rejected", errorCode: error instanceof DeviceBrokerError ? error.code : "service_unavailable",
          startedAt, finishedAt: this.#now(), observationIds: [] };
      }
    }
    if (input.capability.id === "home_assistant.read_entity") {
      let entity: HomeAssistantEntityRead;
      try {
        entity = await this.readEntity(requireString(args.entityId, "entityId"), input.signal, readMaxReportAge(args.maxReportAgeMs));
      } catch (error) {
        if (!(error instanceof DeviceBrokerError)) throw error;
        return { actionId: input.request.actionId, status: "rejected", errorCode: error.code,
          startedAt, finishedAt: this.#now(), observationIds: [] };
      }
      const action: DeviceActionResultV1 = {
        actionId: input.request.actionId,
        status: entity.availability === "absent" ? "rejected" : "completed",
        errorCode: entity.availability === "absent" ? "missing_target" : undefined,
        startedAt,
        finishedAt: this.#now(),
        observationIds: [`${input.request.actionId}:entity`],
      };
      return {
        action,
        observations: [this.entityObservation(action.observationIds[0]!, entity)],
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
    await readBoundedText(response, 64 * 1024);
    return { actionId: input.request.actionId, status: response.ok ? "completed" : "rejected", errorCode: response.ok ? undefined : "service_unavailable", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify(input: DeviceAdapterVerificationInput): Promise<DeviceAdapterVerificationResult> {
    this.assertTarget(input.profile);
    const { request } = input;
    const args = asObject(request.normalizedInput);
    const entityId = typeof args.entityId === "string" ? args.entityId : undefined;
    const rule = request.expectedVerification ?? { availability: "available" };
    if (input.capability.id !== "home_assistant.reload_config_entry" || !entityId || !isRecord(rule)
      || Object.keys(rule).length !== 1 || !["available", "unavailable", "absent"].includes(String(rule.availability))) {
      return { verification: {
        actionId: request.actionId, status: "not_evaluable", rule, observationIds: [],
        checkedAt: this.#now(), reason: "an entity and its expected availability are required",
      } };
    }
    const entity = await this.readEntity(entityId, input.signal, readMaxReportAge(args.maxReportAgeMs));
    const observation = this.entityObservation(input.evidenceId, entity, input.profile.device.id);
    return {
      verification: {
        actionId: request.actionId, status: entity.availability === rule.availability ? "verified" : "failed",
        rule, observationIds: [observation.id], checkedAt: this.#now(),
      },
      observations: [observation],
    };
  }

  private entityObservation(id: string, entity: HomeAssistantEntityRead, subjectId = entity.entityId): DeviceObservationV1 {
    return {
      id,
      subjectId,
      source: "home_assistant",
      value: { entityId: entity.entityId, availability: entity.availability,
        ...(entity.lastReportedAt ? { lastReportedAt: entity.lastReportedAt } : {}),
        ...(entity.lastUpdatedAt ? { lastUpdatedAt: entity.lastUpdatedAt } : {}),
        ...(entity.lastChangedAt ? { lastChangedAt: entity.lastChangedAt } : {}),
        reportTimestampStatus: entity.reportTimestampStatus, reportFreshness: entity.reportFreshness },
      observedAt: entity.observedAt,
      receivedAt: this.#now(),
      freshnessUntil: new Date(Date.parse(entity.observedAt) + 30_000).toISOString(),
      quality: entity.availability === "absent" ? "good" : entity.quality,
      provenance: [this.deviceId, entity.entityId],
      redactionClass: "public",
    };
  }

  private async readCatalog(query: HomeAssistantCatalogQuery, version: string | undefined, callerSignal?: AbortSignal) {
    assertHomeAssistantCatalogQuery(query);
    const deadline = AbortSignal.timeout(8_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const source: unknown = query.kind === "devices"
      ? await readHomeAssistantDeviceRegistry({ origin: this.#baseUrl, version, token: this.requireToken(), signal })
      : JSON.parse(await readBoundedText(await this.request(query.kind === "entities" ? "/api/states" : "/api/services", { method: "GET", signal }),
        HOME_ASSISTANT_CATALOG_MAX_BYTES));
    return projectHomeAssistantCatalog(query, source, this.#now());
  }

  private requireToken(): string {
    const token = typeof this.#token === "function" ? this.#token() : this.#token;
    if (!token || token.length > 8192 || !/^[\x21-\x7e]+$/u.test(token)) {
      throw new DeviceBrokerError("authentication_required", "Home Assistant credential is unavailable");
    }
    return token;
  }

  private async request(path: string, init: RequestInit & { readonly allowNotFound?: boolean }): Promise<Response> {
    const { allowNotFound, ...requestInit } = init;
    const token = this.requireToken();
    const deadline = AbortSignal.timeout(8_000);
    const signal = requestInit.signal ? AbortSignal.any([requestInit.signal, deadline]) : deadline;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...requestInit,
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(requestInit.headers ?? {}) },
      redirect: "error",
      signal,
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      await response.body?.cancel();
      throw new DeviceBrokerError(response.status === 401 || response.status === 403 ? "permission_denied" : "service_unavailable",
        "Home Assistant request failed");
    }
    return response;
  }
}

export function homeAssistantAdapterManifest(): AdapterManifestV1 {
  return homeAssistantManifest;
}

export function parseHomeAssistantOrigin(value: string): string {
  const failure = new DeviceBrokerError("invalid_request", "Home Assistant requires an HTTPS origin or a loopback HTTP origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure;
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.origin.length > 480) throw failure;
  return url.origin;
}

function readMaxReportAge(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DeviceBrokerError("invalid_request", "Home Assistant max report age is invalid");
  }
  return value;
}

function normalizeHomeAssistantTimestamp(value: unknown, observedAt: string): {
  readonly status: HomeAssistantEntityRead["reportTimestampStatus"];
  readonly value?: string;
} {
  if (value === undefined) return { status: "missing" };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return { status: "invalid" };
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { status: "invalid" };
  if (parsed > Date.parse(observedAt)) return { status: "future" };
  return { status: "valid", value: new Date(parsed).toISOString() };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, 256 * 1024);
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Home Assistant response exceeds the adapter limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Home Assistant response exceeds the adapter limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
