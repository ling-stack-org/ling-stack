import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceCapabilitySnapshotV1,
  DeviceProfileV1,
  DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import type { DeviceAdapter, DeviceAdapterDiscoveryInput } from "@ling-stack/core";

export interface LinuxNetworkObservation {
  readonly connected: boolean;
  readonly interfaceName?: string;
  readonly ipv4?: string;
  readonly gatewayReachable?: boolean;
  readonly dnsReachable?: boolean;
  readonly ssid?: string;
  readonly linkError?: string;
}

export interface LinuxSshExecutor {
  inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly kernel: string }>;
  readNetwork(signal?: AbortSignal): Promise<LinuxNetworkObservation>;
  readWifi(signal?: AbortSignal): Promise<LinuxNetworkObservation>;
  restartNetwork(input: { readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean }>;
}

export interface LinuxSshAdapterOptions {
  readonly executor: LinuxSshExecutor;
  readonly now?: () => string;
}

const linuxManifest: AdapterManifestV1 = {
  adapterId: "linux-ssh",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["linux", "head_unit"],
  supportedTransports: ["ssh"],
  transportDeployments: [{ transport: "ssh", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" }],
  requiredRuntime: "pc",
  authenticationMethods: ["ssh_key", "password_reference"],
  capabilities: [
    {
      id: "linux.inspect.network",
      schemaVersion: "1.0",
      semanticVerb: "inspect.network",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["ssh.read"],
      prerequisites: [],
      timeoutMs: 10_000,
      responseBytesLimit: 128 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["linux", "head_unit"],
      supportedTransports: ["ssh"],
      displayMetadata: { label: "Inspect Linux network", category: "diagnostics" },
    },
    {
      id: "linux.inspect.wifi",
      schemaVersion: "1.0",
      semanticVerb: "inspect.wifi",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      sideEffect: "read_only",
      approvalClass: "allow",
      requiredPermissions: ["ssh.read"],
      prerequisites: [],
      timeoutMs: 10_000,
      responseBytesLimit: 128 * 1024,
      idempotency: "request",
      supportedDeviceKinds: ["linux", "head_unit"],
      supportedTransports: ["ssh"],
      displayMetadata: { label: "Inspect Wi-Fi", category: "diagnostics" },
    },
    {
      id: "linux.repair.network",
      schemaVersion: "1.0",
      semanticVerb: "repair.network",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      sideEffect: "reversible",
      approvalClass: "ask",
      requiredPermissions: ["ssh.write"],
      prerequisites: ["linux.inspect.network"],
      timeoutMs: 30_000,
      responseBytesLimit: 64 * 1024,
      idempotency: "target_revision",
      verificationCapabilityId: "linux.inspect.network",
      supportedDeviceKinds: ["linux", "head_unit"],
      supportedTransports: ["ssh"],
      displayMetadata: { label: "Restart Linux network", category: "repair" },
    },
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "Linux SSH", category: "computer" },
};

export class LinuxSshAdapter implements DeviceAdapter {
  readonly manifest = linuxManifest;
  readonly #executor: LinuxSshExecutor;
  readonly #now: () => string;

  constructor(options: LinuxSshAdapterOptions) {
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const inventory = await this.#executor.inventory(input.signal);
    return {
      device: {
        id: `linux:${input.ownerId}:${inventory.hostname}`,
        ownerScope: input.ownerId,
        displayName: inventory.hostname,
        kind: "linux",
        model: "Linux",
        firmwareVersion: inventory.kernel,
        lifecycleStatus: "healthy",
        profileRevision: `${inventory.hostname}:${inventory.kernel}`,
        runtimeOwnerId: input.ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["ssh"],
      connectionRefs: [`ssh:${inventory.hostname}`],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision: `${inventory.hostname}:${inventory.kernel}`,
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
    if (input.capability.id === "linux.inspect.network") await this.#executor.readNetwork(input.signal);
    else if (input.capability.id === "linux.inspect.wifi") await this.#executor.readWifi(input.signal);
    else if (input.capability.id === "linux.repair.network") {
      const result = await this.#executor.restartNetwork({ signal: input.signal });
      if (!result.accepted) return { actionId: input.request.actionId, status: "rejected", errorCode: "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    } else return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
    return { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: this.#now(), observationIds: [`${input.request.actionId}:result`] };
  }

  async verify(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1 }): Promise<DeviceVerificationResultV1> {
    const network = await this.#executor.readNetwork();
    const verified = network.connected && network.gatewayReachable !== false;
    return { actionId: input.request.actionId, status: verified ? "verified" : "failed", rule: input.request.expectedVerification ?? { connected: true }, observationIds: [`${input.request.actionId}:verification`], checkedAt: this.#now(), reason: verified ? undefined : network.linkError ?? "network is not reachable" };
  }
}

export function linuxSshAdapterManifest(): AdapterManifestV1 {
  return linuxManifest;
}
