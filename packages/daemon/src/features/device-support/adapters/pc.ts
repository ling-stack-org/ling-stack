import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  JsonValue,
  DeviceProfileV1,
  DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import type {
  DeviceAdapter,
  DeviceAdapterDiscoveryInput,
  DeviceAdapterExecutionResult,
  DeviceAdapterVerificationInput,
  DeviceAdapterVerificationResult,
} from "@ling-stack/core";

export interface PcNetworkStatus {
  readonly connected: boolean;
  readonly interfaceName?: string;
  readonly address?: string;
  readonly gatewayReachable?: boolean;
  readonly dnsReachable?: boolean;
  readonly proxyEnabled?: boolean;
}

export interface PcServiceStatus {
  readonly name: string;
  readonly state: "running" | "stopped" | "failed" | "unknown";
}

export interface PcTargetExecutor {
  inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly os: string; readonly version?: string }>;
  readNetwork(signal?: AbortSignal): Promise<PcNetworkStatus>;
  readServices(signal?: AbortSignal): Promise<readonly PcServiceStatus[]>;
  repairNetwork(input: { readonly mode: "refresh_dhcp" | "restart_network"; readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean; readonly changed: boolean }>;
}

export interface PcAdapterOptions {
  readonly executor: PcTargetExecutor;
  readonly now?: () => string;
}

const pcManifest: AdapterManifestV1 = {
  adapterId: "pc-target-executor",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["pc"],
  supportedTransports: ["local_process", "ssh", "winrm"],
  transportDeployments: [
    { transport: "local_process", mode: "target_executor", pairing: "os_permission", removal: "remove_target_executor" },
    { transport: "ssh", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" },
    { transport: "winrm", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" },
  ],
  requiredRuntime: "pc",
  authenticationMethods: ["local_os_permission", "ssh_key", "winrm_credential"],
  capabilities: [
    {
      id: "pc.inspect.network",
      schemaVersion: "1.0",
      semanticVerb: "inspect.network",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["pc.network.read"],
      prerequisites: [],
      timeoutMs: 10_000,
      responseBytesLimit: 128 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["pc"],
      supportedTransports: ["local_process", "ssh", "winrm"],
      displayMetadata: { label: "Inspect network", category: "diagnostics" },
    },
    {
      id: "pc.inspect.services",
      schemaVersion: "1.0",
      semanticVerb: "inspect.services",
      inputSchema: { type: "object" },
      outputSchema: { type: "array" },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["pc.services.read"],
      prerequisites: [],
      timeoutMs: 10_000,
      responseBytesLimit: 256 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["pc"],
      supportedTransports: ["local_process", "ssh", "winrm"],
      displayMetadata: { label: "Inspect services", category: "diagnostics" },
    },
    {
      id: "pc.repair.network",
      schemaVersion: "1.0",
      semanticVerb: "repair.network",
      inputSchema: { type: "object", required: ["mode"] },
      outputSchema: { type: "object" },
      sideEffect: "reversible",
      approvalClass: "ask",
      requiredPermissions: ["pc.network.write"],
      prerequisites: ["pc.inspect.network"],
      timeoutMs: 30_000,
      responseBytesLimit: 64 * 1024,
      idempotency: "target_revision",
      verificationCapabilityId: "pc.inspect.network",
      supportedDeviceKinds: ["pc"],
      supportedTransports: ["local_process", "ssh", "winrm"],
      displayMetadata: { label: "Repair network", category: "repair" },
    },
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "PC target executor", category: "computer" },
};

export class PcAdapter implements DeviceAdapter {
  readonly manifest = pcManifest;
  readonly #executor: PcTargetExecutor;
  readonly #now: () => string;

  constructor(options: PcAdapterOptions) {
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const inventory = await this.#executor.inventory(input.signal);
    return {
      device: {
        id: `pc:${input.ownerId}:${inventory.hostname}`,
        ownerScope: input.ownerId,
        displayName: inventory.hostname,
        kind: "pc",
        model: inventory.os,
        firmwareVersion: inventory.version,
        lifecycleStatus: "healthy",
        profileRevision: `${inventory.hostname}:${inventory.version ?? "unknown"}`,
        runtimeOwnerId: input.ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["local_process"],
      connectionRefs: [`local:${inventory.hostname}`],
      transportDeployments: [this.manifest.transportDeployments[0]!],
      profileRevision: `${inventory.hostname}:${inventory.version ?? "unknown"}`,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string }): Promise<DeviceCapabilitySnapshotV1> {
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

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    if (input.capability.id === "pc.inspect.network") {
      const value = await this.#executor.readNetwork(input.signal);
      return completedObservation(input, startedAt, networkObservationValue(value), "pc.network");
    }
    if (input.capability.id === "pc.inspect.services") {
      const value = await this.#executor.readServices(input.signal);
      return completedObservation(input, startedAt, { services: value } as unknown as JsonValue, "pc.services");
    }
    if (input.capability.id === "pc.repair.network") {
      const mode = isNetworkRepairMode(input.request.normalizedInput);
      const result = await this.#executor.repairNetwork({ mode, signal: input.signal });
      if (!result.accepted) return { actionId: input.request.actionId, status: "rejected", errorCode: "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    } else return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
    return { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify(input: DeviceAdapterVerificationInput): Promise<DeviceAdapterVerificationResult> {
    const { request } = input;
    const rule = request.expectedVerification ?? { connected: true, gatewayReachable: true, dnsReachable: true };
    if (request.capabilityId !== "pc.inspect.network" && request.capabilityId !== "pc.repair.network") {
      return { verification: {
        actionId: request.actionId, status: "not_evaluable", rule, observationIds: [],
        checkedAt: this.#now(), reason: "network verification is unavailable for this capability",
      } };
    }
    const network = await this.#executor.readNetwork(input.signal);
    const checkedAt = this.#now();
    const observation = pcObservation(input.profile, input.evidenceId, checkedAt, networkObservationValue(network), "pc.network");
    return {
      verification: {
        actionId: request.actionId, status: evaluateNetworkRule(rule, network), rule,
        observationIds: [observation.id], checkedAt,
      },
      observations: [observation],
    };
  }
}

function completedObservation(
  input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1 },
  startedAt: string,
  value: JsonValue,
  source: string,
): DeviceAdapterExecutionResult {
  const observationId = `${input.request.actionId}:result`;
  const observation = pcObservation(input.profile, observationId, startedAt, value, source);
  return { action: { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [observationId] }, observations: [observation] };
}

function pcObservation(profile: DeviceProfileV1, id: string, observedAt: string, value: JsonValue, source: string): DeviceObservationV1 {
  return {
    id,
    subjectId: profile.device.id,
    source,
    value,
    observedAt,
    receivedAt: observedAt,
    freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
    quality: "good",
    provenance: [source, profile.device.id],
    redactionClass: "public",
  };
}

function networkObservationValue(network: PcNetworkStatus): JsonValue {
  return Object.fromEntries(Object.entries(network).filter(([, value]) => value !== undefined));
}

function evaluateNetworkRule(rule: JsonValue, network: PcNetworkStatus): DeviceVerificationResultV1["status"] {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "not_evaluable";
  const fields = Object.entries(rule);
  const checks = { connected: network.connected, gatewayReachable: network.gatewayReachable, dnsReachable: network.dnsReachable };
  if (!fields.length || fields.some(([key, expected]) => !Object.hasOwn(checks, key) || typeof expected !== "boolean"
    || checks[key as keyof typeof checks] === undefined)) return "not_evaluable";
  return fields.every(([key, expected]) => checks[key as keyof typeof checks] === expected) ? "verified" : "failed";
}

export function pcAdapterManifest(): AdapterManifestV1 {
  return pcManifest;
}

function isNetworkRepairMode(value: unknown): "refresh_dhcp" | "restart_network" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Network repair input must be an object");
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== "refresh_dhcp" && mode !== "restart_network") throw new Error("Unsupported network repair mode");
  return mode;
}
