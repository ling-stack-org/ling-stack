import type {
  CapabilityDescriptorV1,
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceCapabilitySnapshotV1,
  DeviceKindV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceVerificationResultV1,
  DeviceTransportV1,
} from "@ling-stack/contracts";
import type { MobileDeviceExecutionResult, MobileDeviceTransport } from "./execution.js";

export type MobileNativePermissionState = "unknown" | "denied" | "granted";

export interface MobileNativeDeviceDescriptor {
  readonly deviceId: string;
  readonly displayName: string;
  readonly kind: DeviceKindV1;
  readonly transport: DeviceTransportV1;
  readonly connectionRef: string;
  readonly profileRevision: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly supportedPermissions: readonly string[];
  readonly permissionState: MobileNativePermissionState;
}

export interface MobileNativeDeviceSession {
  readonly deviceId: string;
  readonly connectionRevision: string;
  readonly permissions: readonly string[];
  getCapabilities(): Promise<readonly CapabilityDescriptorV1[]>;
  execute(input: { readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<MobileDeviceExecutionResult>;
  verify?(input: { readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1; readonly signal?: AbortSignal }): Promise<DeviceVerificationResultV1>;
  close?(): Promise<void>;
}

export interface MobileNativeTransportBridge {
  discover(input?: { readonly signal?: AbortSignal }): Promise<readonly MobileNativeDeviceDescriptor[]>;
  connect(input: { readonly deviceId: string; readonly requiredPermissions: readonly string[]; readonly signal?: AbortSignal }): Promise<MobileNativeDeviceSession>;
}

export class MobileNativeTransportError extends Error {
  readonly code: "permission_denied" | "target_missing" | "transport_unavailable";

  constructor(code: "permission_denied" | "target_missing" | "transport_unavailable", message: string) {
    super(message);
    this.code = code;
    this.name = "MobileNativeTransportError";
  }
}

export class MobileNativeTransportFactory {
  readonly #bridge: MobileNativeTransportBridge;
  readonly #ownerScope: string;
  readonly #ownerId: string;
  readonly #now: () => string;

  constructor(input: { readonly bridge: MobileNativeTransportBridge; readonly ownerScope: string; readonly ownerId: string; readonly now?: () => string }) {
    this.#bridge = input.bridge;
    this.#ownerScope = input.ownerScope;
    this.#ownerId = input.ownerId;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async discover(signal?: AbortSignal): Promise<readonly DeviceProfileV1[]> {
    const devices = await this.#bridge.discover({ signal });
    return devices.map(device => this.toProfile(device));
  }

  async connect(input: { readonly device: MobileNativeDeviceDescriptor; readonly requiredPermissions: readonly string[]; readonly signal?: AbortSignal }): Promise<MobileDeviceTransport & { readonly connectionRevision: string; readonly permissions: readonly string[]; readonly getCapabilities: () => Promise<readonly CapabilityDescriptorV1[]>; readonly close?: () => Promise<void> }> {
    if (input.device.permissionState !== "granted") throw new MobileNativeTransportError("permission_denied", "native device permission has not been granted");
    const unsupported = input.requiredPermissions.filter(permission => !input.device.supportedPermissions.includes(permission));
    if (unsupported.length > 0) throw new MobileNativeTransportError("permission_denied", `native device does not support required permissions: ${unsupported.join(",")}`);
    let session: MobileNativeDeviceSession;
    try {
      session = await this.#bridge.connect({ deviceId: input.device.deviceId, requiredPermissions: input.requiredPermissions, signal: input.signal });
    } catch (error) {
      if (error instanceof MobileNativeTransportError) throw error;
      throw new MobileNativeTransportError("transport_unavailable", error instanceof Error ? error.message : "native transport connection failed");
    }
    if (session.deviceId !== input.device.deviceId) throw new MobileNativeTransportError("target_missing", "native session identity does not match the selected device");
    return {
      deviceId: session.deviceId,
      connectionRevision: session.connectionRevision,
      permissions: session.permissions,
      getCapabilities: () => session.getCapabilities(),
      execute: input => session.execute(input),
      ...(session.verify ? { verify: (verifyInput: { readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1; readonly signal?: AbortSignal }) => session.verify!(verifyInput) } : {}),
      ...(session.close ? { close: () => session.close!() } : {}),
    };
  }

  async snapshot(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly capabilities: readonly CapabilityDescriptorV1[] }): Promise<DeviceCapabilitySnapshotV1> {
    return {
      snapshotId: `${input.profile.device.id}:${input.connectionRevision}:${this.#now()}`,
      deviceId: input.profile.device.id,
      adapterId: input.profile.adapterId,
      adapterVersion: input.profile.adapterVersion,
      contractMajor: 1,
      connectionRevision: input.connectionRevision,
      capabilities: input.capabilities,
      observedAt: this.#now(),
      freshnessUntil: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
    };
  }

  private toProfile(device: MobileNativeDeviceDescriptor): DeviceProfileV1 {
    return {
      device: {
        id: device.deviceId,
        ownerScope: this.#ownerScope,
        displayName: device.displayName,
        kind: device.kind,
        lifecycleStatus: "identified",
        profileRevision: device.profileRevision,
        runtimeOwnerId: this.#ownerId,
        lastSeenAt: this.#now(),
      },
      adapterId: device.adapterId,
      adapterVersion: device.adapterVersion,
      transports: [device.transport],
      connectionRefs: [device.connectionRef],
      transportDeployments: [{ transport: device.transport, mode: "none", pairing: "os_permission", removal: "disconnect_only" }],
      profileRevision: device.profileRevision,
      source: "adapter",
    };
  }
}

export function observationFromNativeResult(input: { readonly id: string; readonly subjectId: string; readonly source: string; readonly value: DeviceObservationV1["value"]; readonly observedAt: string; readonly receivedAt: string; readonly freshnessUntil: string }): DeviceObservationV1 {
  return { ...input, quality: "good", provenance: [input.source, input.subjectId], redactionClass: "public" };
}
