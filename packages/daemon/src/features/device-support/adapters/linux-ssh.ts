import { createHash } from "node:crypto";

import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceCapabilitySnapshotV1,
  DeviceProfileV1,
  DeviceObservationV1,
  JsonValue,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError,
  type DeviceAdapter, type DeviceAdapterDiscoveryInput, type DeviceAdapterExecutionResult,
  type DeviceAdapterVerificationInput, type DeviceAdapterVerificationResult,
} from "@ling-stack/core";

import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";

export interface LinuxNetworkObservation {
  readonly connected: boolean;
  readonly interfaceName?: string;
  readonly ipv4?: string;
  readonly routeAvailable?: boolean;
  readonly gatewayReachable?: boolean;
  readonly dnsReachable?: boolean;
  readonly dnsNameResolved?: boolean;
  readonly ssid?: string;
  readonly wifiInterfaceName?: string;
  readonly wifiAssociated?: boolean;
  readonly linkError?: string;
}

export interface LinuxSshExecutor {
  inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly kernel: string }>;
  readNetwork(signal?: AbortSignal): Promise<LinuxNetworkObservation>;
  readWifi(signal?: AbortSignal): Promise<LinuxNetworkObservation>;
  restartNetwork(input: { readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean }>;
}

export interface LinuxSshConnection {
  readonly connectionRef: string;
  readonly hostKeyFingerprint: string;
  readonly executor: LinuxSshExecutor;
}

export type LinuxSshAdapterOptions = { readonly now?: () => string } & (
  | { readonly executor: LinuxSshExecutor; readonly connections?: never }
  | { readonly connections: readonly LinuxSshConnection[]; readonly executor?: never }
);

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
  readonly manifest: AdapterManifestV1;
  readonly #executor?: LinuxSshExecutor;
  readonly #connections: ReadonlyMap<string, LinuxSshConnection>;
  readonly #now: () => string;

  constructor(options: LinuxSshAdapterOptions) {
    this.#executor = options.executor;
    this.#connections = new Map(options.connections?.map(connection => [connection.connectionRef, connection]));
    this.manifest = options.connections ? {
      ...linuxManifest,
      adapterVersion: "1.1.0",
      supportedDeviceKinds: ["linux"],
      authenticationMethods: ["ssh_key"],
      capabilities: linuxManifest.capabilities
        .filter(capability => capability.sideEffect === "read_only")
        .map(capability => ({ ...capability, supportedDeviceKinds: ["linux"] })),
    } : linuxManifest;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const connection = this.#connections.get(input.connectionRef);
    const executor = connection?.executor ?? this.#executor;
    if (!executor) throw new DeviceBrokerError("missing_target", "Linux SSH connection is unavailable");
    const inventory = await executor.inventory(input.signal);
    const profileRevision = connection
      ? createHash("sha256").update(JSON.stringify([connection.connectionRef, inventory.hostname, inventory.kernel])).digest("hex")
      : `${inventory.hostname}:${inventory.kernel}`;
    return {
      device: {
        id: linuxSshDeviceId(input.ownerId, connection?.hostKeyFingerprint ?? inventory.hostname),
        ownerScope: input.ownerId,
        displayName: inventory.hostname,
        kind: "linux",
        model: "Linux",
        firmwareVersion: inventory.kernel,
        lifecycleStatus: "healthy",
        profileRevision,
        runtimeOwnerId: connection ? `daemon:${input.ownerId}` : input.ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["ssh"],
      connectionRefs: [connection?.connectionRef ?? `ssh:${inventory.hostname}`],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string }): Promise<DeviceCapabilitySnapshotV1> {
    this.executorForProfile(input.profile);
    return createAdapterCapabilitySnapshot(this.manifest, input, this.#now());
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    const capability = this.manifest.capabilities.find(candidate => candidate.id === input.capability.id);
    if (!capability) {
      return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: startedAt, observationIds: [] };
    }
    const executor = this.executorForProfile(input.profile);
    const deadline = AbortSignal.timeout(capability.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    if (input.capability.id === "linux.inspect.network" || input.capability.id === "linux.inspect.wifi") {
      const wifi = input.capability.id === "linux.inspect.wifi";
      let reading: LinuxNetworkObservation;
      try {
        reading = wifi ? await executor.readWifi(signal) : await executor.readNetwork(signal);
      } catch (error) {
        if (!(error instanceof DeviceBrokerError) || error.code !== "connection_failed") throw error;
        return { actionId: input.request.actionId, status: "rejected", errorCode: error.code, startedAt, finishedAt: this.#now(), observationIds: [] };
      }
      const finishedAt = this.#now();
      const observation = makeObservation(
        input.profile, `${input.request.actionId}:result`, finishedAt, reading, wifi ? "linux.wifi" : "linux.network",
      );
      return {
        action: { actionId: input.request.actionId, status: "completed", startedAt, finishedAt, observationIds: [observation.id] },
        observations: [observation],
      };
    }
    if (input.capability.id === "linux.repair.network") {
      const result = await executor.restartNetwork({ signal });
      if (!result.accepted) return { actionId: input.request.actionId, status: "rejected", errorCode: "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    } else return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
    return { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify(input: DeviceAdapterVerificationInput): Promise<DeviceAdapterVerificationResult> {
    const wifi = input.capability.id === "linux.inspect.wifi";
    const rule = input.request.expectedVerification ?? (wifi ? { wifiAssociated: true } : { connected: true, routeAvailable: true });
    const executor = this.executorForProfile(input.profile);
    const deadline = AbortSignal.timeout(10_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const network = wifi ? await executor.readWifi(signal) : await executor.readNetwork(signal);
    const checkedAt = this.#now();
    const status = evaluateNetworkRule(rule, network);
    const observation = makeObservation(input.profile, input.evidenceId, checkedAt, network, wifi ? "linux.wifi" : "linux.network");
    return {
      verification: {
        actionId: input.request.actionId, status, rule, observationIds: [observation.id], checkedAt,
        ...(status === "not_evaluable" ? { reason: "required Linux readback facts are unavailable" } : {}),
      },
      observations: [observation],
    };
  }

  private executorForProfile(profile: DeviceProfileV1): LinuxSshExecutor {
    if (this.#executor) return this.#executor;
    const connection = this.#connections.get(profile.connectionRefs[0] ?? "");
    if (!connection || profile.adapterVersion !== this.manifest.adapterVersion
      || profile.device.id !== linuxSshDeviceId(profile.device.ownerScope, connection.hostKeyFingerprint)) {
      throw new DeviceBrokerError("target_changed", "Linux SSH registration no longer matches the connection");
    }
    return connection.executor;
  }
}

export function linuxSshDeviceId(ownerId: string, identity: string): string {
  return `linux:${ownerId}:${identity}`;
}

function makeObservation(profile: DeviceProfileV1, id: string, timestamp: string, reading: LinuxNetworkObservation, source: string): DeviceObservationV1 {
  return {
    id,
    subjectId: profile.device.id,
    source,
    value: Object.fromEntries(Object.entries(reading).filter(([, value]) => value !== undefined)),
    observedAt: timestamp,
    receivedAt: timestamp,
    freshnessUntil: new Date(Date.parse(timestamp) + 30_000).toISOString(),
    quality: reading.linkError ? "degraded" : "good",
    provenance: [source, profile.device.id],
    redactionClass: "public",
  };
}

function evaluateNetworkRule(rule: JsonValue, current: LinuxNetworkObservation): "verified" | "failed" | "not_evaluable" {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "not_evaluable";
  const observations = {
    connected: current.connected,
    routeAvailable: current.routeAvailable,
    gatewayReachable: current.gatewayReachable,
    dnsReachable: current.dnsReachable,
    dnsNameResolved: current.dnsNameResolved,
    wifiAssociated: current.wifiAssociated,
  };
  const expected = Object.entries(rule);
  if (expected.length === 0 || expected.some(([key, value]) => typeof value !== "boolean" || !Object.hasOwn(observations, key))) {
    return "not_evaluable";
  }
  const readings = expected.map(([key, value]) => ({ actual: observations[key as keyof typeof observations], value }));
  if (readings.some(({ actual, value }) => actual !== undefined && actual !== value)) return "failed";
  return readings.every(({ actual }) => actual !== undefined) ? "verified" : "not_evaluable";
}

export function linuxSshAdapterManifest(): AdapterManifestV1 {
  return linuxManifest;
}
