import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceCapabilitySnapshotV1,
  DeviceProfileV1,
  DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import type { DeviceAdapter, DeviceAdapterDiscoveryInput } from "@ling-stack/core";

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

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1> {
    const startedAt = this.#now();
    if (input.capability.id === "pc.inspect.network") await this.#executor.readNetwork(input.signal);
    else if (input.capability.id === "pc.inspect.services") await this.#executor.readServices(input.signal);
    else if (input.capability.id === "pc.repair.network") {
      const mode = isNetworkRepairMode(input.request.normalizedInput);
      const result = await this.#executor.repairNetwork({ mode, signal: input.signal });
      if (!result.accepted) return { actionId: input.request.actionId, status: "rejected", errorCode: "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    } else return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
    return { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: this.#now(), observationIds: [`${input.request.actionId}:result`] };
  }

  async verify(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1 }): Promise<DeviceVerificationResultV1> {
    const network = await this.#executor.readNetwork();
    const connected = network.connected && network.gatewayReachable !== false && network.dnsReachable !== false;
    return { actionId: input.request.actionId, status: connected ? "verified" : "failed", rule: input.request.expectedVerification ?? { connected: true }, observationIds: [`${input.request.actionId}:verification`], checkedAt: this.#now(), reason: connected ? undefined : "network remains unavailable" };
  }
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
