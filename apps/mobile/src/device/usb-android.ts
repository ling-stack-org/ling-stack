import {
  isAndroidPackageId, isAndroidVersionCode,
  type CapabilityDescriptorV1, type DeviceActionRequestV1, type DeviceCapabilitySnapshotV1,
  type DeviceErrorCodeV1, type DeviceObservationV1, type DeviceProfileV1, type JsonValue,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";
import type { MobileDeviceTransport } from "./execution.ts";

export interface UsbAndroidDevice {
  readonly portId: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly label: string;
  readonly permissionGranted: boolean;
}

export interface UsbAndroidIdentity {
  readonly hardwareDigest: string;
  readonly firmwareDigest: string;
  readonly model: string;
  readonly androidVersion: string;
}

export interface UsbAndroidPackage {
  readonly present: boolean;
  readonly versionCode?: string;
  readonly digest?: string;
}

export interface UsbAndroidSession {
  readonly identity: UsbAndroidIdentity;
  install(uri: string, digest: string): Promise<boolean>;
  readPackage(packageId: string): Promise<UsbAndroidPackage>;
  readLogs(tag: string): Promise<string>;
  close(): void;
}

export interface UsbAndroidBridge {
  list(): Promise<readonly UsbAndroidDevice[]>;
  authorize(target: UsbAndroidDevice): Promise<void>;
  open(target: UsbAndroidDevice, signal: AbortSignal): Promise<UsbAndroidSession>;
}

export type AndroidApkSelection =
  | { readonly source: "phone_file"; readonly fileId: string; readonly name: string }
  | { readonly source: "paired_pc"; readonly fileId: string };

export interface AndroidDeploymentInput {
  readonly packageId: string;
  readonly versionCode: string;
  readonly artifactDigest: string;
  readonly diagnosisTaskId: string;
  readonly source: AndroidApkSelection["source"];
}

export const usbAndroidIdentifyPlaybook = "android-usb-identify@1.0.0";
export const usbAndroidInstallPlaybook = "android-usb-install-apk@1.0.0";
export const usbAndroidLogsPlaybook = "android-usb-capture-logs@1.0.0";
export const usbAndroidLogCapabilityId = "android.usb.capture_logs";
const logTagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
export function isUsbAndroidLogTag(value: unknown): value is string {
  return typeof value === "string" && logTagPattern.test(value);
}
const adapterId = "android-usb-adb-mobile";
const adapterVersion = "1.0.0";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

const readCapability = {
  id: "android.usb.read_package", schemaVersion: "1.0", semanticVerb: "inspect.packages",
  inputSchema: { type: "object", required: ["packageId"], properties: { packageId: { type: "string" } }, additionalProperties: false },
  outputSchema: { type: "object" },
  sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["adb.read"], prerequisites: [],
  timeoutMs: 25_000, responseBytesLimit: 4096, idempotency: "request",
  supportedDeviceKinds: ["android"], supportedTransports: ["adb"],
} satisfies CapabilityDescriptorV1;

const identityCapability = {
  ...readCapability, id: "android.usb.identify", semanticVerb: "inspect.device",
  inputSchema: { type: "object", additionalProperties: false },
} satisfies CapabilityDescriptorV1;

const logsCapability = {
  ...readCapability, id: usbAndroidLogCapabilityId, semanticVerb: "capture.logs",
  inputSchema: {
    type: "object", required: ["tag"], additionalProperties: false, properties: { tag: { type: "string" } },
  },
  responseBytesLimit: 256 * 1024,
} satisfies CapabilityDescriptorV1;

const installCapability = {
  ...readCapability, id: "android.usb.install_apk", semanticVerb: "deploy.artifact",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["packageId", "versionCode", "artifactDigest", "diagnosisTaskId", "source"],
    properties: {
      packageId: { type: "string" }, versionCode: { type: "string" }, artifactDigest: { type: "string" },
      diagnosisTaskId: { type: "string" }, source: { enum: ["phone_file", "paired_pc"] },
    },
  },
  sideEffect: "mutating", approvalClass: "ask", requiredPermissions: ["adb.install"],
  timeoutMs: 150_000, idempotency: "target_revision", verificationCapabilityId: readCapability.id,
} satisfies CapabilityDescriptorV1;

export function readAndroidDeployment(input: unknown): AndroidDeploymentInput | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { packageId, versionCode, artifactDigest, diagnosisTaskId, source } = input as Record<string, unknown>;
  if (Object.keys(input).length !== 5 || !isAndroidPackageId(packageId) || !isAndroidVersionCode(versionCode)
    || typeof artifactDigest !== "string" || !digestPattern.test(artifactDigest)
    || typeof diagnosisTaskId !== "string" || !diagnosisTaskId.startsWith("device_task_")
    || (source !== "phone_file" && source !== "paired_pc")) return undefined;
  return { packageId, versionCode, artifactDigest, diagnosisTaskId, source };
}

export function prepareUsbAndroidDevice(input: {
  readonly session: UsbAndroidSession;
  readonly ownerId: string;
  readonly connectionRevision: string;
  readonly now: () => string;
  readonly deployment?: AndroidDeploymentInput;
  readonly apkUri?: string;
}) {
  const { session, ownerId, connectionRevision, now, deployment, apkUri } = input;
  const { hardwareDigest, firmwareDigest, model, androidVersion } = session.identity;
  const hash = /^[a-f0-9]{64}$/u;
  if (!hash.test(hardwareDigest) || !hash.test(firmwareDigest)
    || typeof model !== "string" || model.length > 120 || /[\u0000-\u001f\u007f]/u.test(model)
    || typeof androidVersion !== "string" || !/^[0-9][A-Za-z0-9.-]{0,31}$/u.test(androidVersion)) {
    throw new Error("adb_target_identity_unavailable");
  }
  const observedAt = now();
  const deviceId = "android-usb:" + digest([ownerId, hardwareDigest]);
  const profileRevision = digest([deviceId, firmwareDigest]);
  const freshUntil = (at: string) => new Date(Date.parse(at) + 30_000).toISOString();
  const profile: DeviceProfileV1 = {
    device: {
      id: deviceId, ownerScope: ownerId, runtimeOwnerId: ownerId, kind: "android",
      displayName: model || "Android USB", lifecycleStatus: "identified",
      profileRevision, lastSeenAt: observedAt, ...(model ? { model } : {}), firmwareVersion: androidVersion,
    },
    adapterId, adapterVersion, transports: ["adb"], connectionRefs: ["usb:" + hardwareDigest],
    transportDeployments: [{ transport: "adb", mode: "hardware_bridge", pairing: "os_permission", removal: "disconnect_only" }],
    profileRevision, source: "adapter",
  };
  const snapshot: DeviceCapabilitySnapshotV1 = {
    snapshotId: deviceId + ":" + connectionRevision,
    deviceId, adapterId, adapterVersion, contractMajor: 1, connectionRevision,
    capabilities: [identityCapability, readCapability, logsCapability, installCapability], observedAt, freshnessUntil: freshUntil(observedAt),
  };
  const rule = deployment && { packageId: deployment.packageId, versionCode: deployment.versionCode, artifactDigest: deployment.artifactDigest };
  const installInput = deployment && { ...deployment };
  const observation = (id: string, source: string, value: JsonValue, at: string, good = true): DeviceObservationV1 => ({
    id, subjectId: deviceId, source, value, observedAt: at, receivedAt: at, freshnessUntil: freshUntil(at),
    quality: good ? "good" : "degraded", provenance: [deviceId, source], redactionClass: "public",
  });
  const matches = (request: DeviceActionRequestV1, capability: CapabilityDescriptorV1) =>
    request.targetDeviceId === deviceId && request.capabilitySnapshotId === snapshot.snapshotId
      && request.capabilityId === capability.id && request.capabilitySchemaVersion === capability.schemaVersion;

  const transport: MobileDeviceTransport = {
    deviceId, connectionRevision, permissions: ["adb.read", "adb.install"],
    async execute({ request, signal }) {
      const startedAt = now();
      const receipt = (status: "completed" | "rejected" | "uncertain", errorCode?: DeviceErrorCodeV1, evidence?: DeviceObservationV1) => ({
        action: { actionId: request.actionId, status, ...(errorCode ? { errorCode } : {}), startedAt, finishedAt: now(),
          observationIds: evidence ? [evidence.id] : [] },
        ...(evidence ? { observations: [evidence] } : {}),
      });
      const prefix = request.taskId + ":" + request.actionId;
      if (matches(request, identityCapability)) {
        return receipt("completed", undefined, observation(prefix + ":identity", "android.usb.identity", { model, androidVersion }, now()));
      }
      if (matches(request, logsCapability)) {
        const args = request.normalizedInput;
        const tag = args && typeof args === "object" && "tag" in args ? args.tag : undefined;
        if (!isUsbAndroidLogTag(tag)) return receipt("rejected", "invalid_request");
        const logs = await whileConnected(session, signal, () => session.readLogs(tag));
        return receipt("completed", undefined, {
          ...observation(prefix + ":logs", "android.usb.logcat", { tag, text: logs }, now()), redactionClass: "sensitive",
        });
      }
      if (!apkUri || !installInput || !matches(request, installCapability)
        || digest(request.normalizedInput) !== digest(installInput)) return receipt("rejected", "invalid_request");
      let accepted: boolean;
      try {
        accepted = await whileConnected(session, signal, () => session.install(apkUri, installInput.artifactDigest));
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = usbAndroidErrorCode(error);
        if (code === "target_changed" || code === "invalid_request" || code === "permission_denied") return receipt("rejected", code);
        return receipt("uncertain", "unknown_outcome");
      }
      return receipt(accepted ? "completed" : "rejected", undefined,
        observation(prefix + ":install", "android.usb.install", { ...rule, accepted }, now(), accepted));
    },
    async verify({ request, signal, evidenceId }) {
      if (!rule || !matches(request, installCapability) || digest(request.expectedVerification ?? null) !== digest(rule)) return {
        actionId: request.actionId, status: "not_evaluable", rule: request.expectedVerification ?? null, observationIds: [], checkedAt: now(),
      };
      const installed = await whileConnected(session, signal, () => session.readPackage(rule.packageId));
      const checkedAt = now();
      const version = isAndroidVersionCode(installed.versionCode) ? installed.versionCode : undefined;
      const installedDigest = typeof installed.digest === "string" && digestPattern.test(installed.digest) ? installed.digest : undefined;
      const status = !installed.present ? "failed" : !version || !installedDigest ? "not_evaluable"
        : version === rule.versionCode && installedDigest === rule.artifactDigest ? "verified" : "failed";
      const id = evidenceId ?? request.taskId + ":" + request.actionId + ":package";
      return {
        verification: { actionId: request.actionId, status, rule, observationIds: [id], checkedAt },
        observations: [observation(id, "android.usb.package", {
          packageId: rule.packageId, present: installed.present, ...(version ? { versionCode: version } : {}),
          ...(installedDigest ? { artifactDigest: installedDigest } : {}),
        }, checkedAt, status === "verified")],
      };
    },
  };
  return {
    profile, snapshot, transport,
    identityStep: {
      stepId: "identify", capabilityId: identityCapability.id, capabilitySchemaVersion: identityCapability.schemaVersion, normalizedInput: {},
    },
    installStep: installInput && rule && {
      stepId: "install", capabilityId: installCapability.id, capabilitySchemaVersion: installCapability.schemaVersion,
      normalizedInput: installInput, expectedVerification: rule, sideEffect: installCapability.sideEffect,
    },
  };
}

function digest(value: JsonValue): string {
  return encodeBase64Url(sha256(canonicalJsonBytes(value)));
}

async function whileConnected<T>(session: UsbAndroidSession, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error("usb_connection_failed");
  const close = () => session.close();
  signal?.addEventListener("abort", close, { once: true });
  try {
    return await operation();
  } finally {
    signal?.removeEventListener("abort", close);
  }
}

export function usbAndroidErrorCode(error: unknown): DeviceErrorCodeV1 {
  const message = error instanceof Error ? error.message : "";
  if (/usb_permission_denied|adb_authorization_required/u.test(message)) return "permission_denied";
  if (/usb_target_changed|adb_target_identity_unavailable/u.test(message)) return "target_changed";
  if (/usb_target_missing/u.test(message)) return "missing_target";
  if (/usb_target_busy/u.test(message)) return "target_busy";
  if (/adb_invalid_apk|apk_archive_path_invalid/u.test(message)) return "invalid_request";
  if (/adb_timeout/u.test(message)) return "timeout";
  return "connection_failed";
}
