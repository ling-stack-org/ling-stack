import type { DeviceKindV1, DeviceTaskStatusV1, JsonValue } from "./device.js";
import type { HardwareProtocolCaptureV1 } from "./device-protocol.js";

export type DeviceSessionModeV1 = "standard" | "developer";

export const DEVICE_NATIVE_WORKBENCH_TOOLS_V1 = ["ssh", "adb", "vendor"] as const;
export type DeviceNativeWorkbenchToolV1 = (typeof DEVICE_NATIVE_WORKBENCH_TOOLS_V1)[number];

export interface DeviceNativeWorkbenchRequestV1 {
  readonly tool: DeviceNativeWorkbenchToolV1;
  readonly operation: string;
  readonly evidenceDigest?: string;
}

export interface DeviceNativeWorkbenchReadbackV1 {
  readonly targetDeviceId: string;
  readonly profileRevision: string;
  readonly connectionRevision: string;
  readonly status: "verified" | "failed";
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export function isDeviceNativeWorkbenchRequestV1(value: unknown): value is DeviceNativeWorkbenchRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { tool, operation, evidenceDigest } = value as Record<string, unknown>;
  return Object.keys(value).every(key => ["tool", "operation", "evidenceDigest"].includes(key))
    && DEVICE_NATIVE_WORKBENCH_TOOLS_V1.some(candidate => candidate === tool)
    && typeof operation === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operation)
    && (evidenceDigest === undefined || isWorkbenchDigest(evidenceDigest));
}

export function isDeviceNativeWorkbenchReadbackV1(value: unknown): value is DeviceNativeWorkbenchReadbackV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { targetDeviceId, profileRevision, connectionRevision, status, observedAt, evidenceDigest } = value as Record<string, unknown>;
  return Object.keys(value).every(key => ["targetDeviceId", "profileRevision", "connectionRevision", "status", "observedAt", "evidenceDigest"].includes(key))
    && [targetDeviceId, profileRevision, connectionRevision].every(item => typeof item === "string" && item.length > 0 && item.length <= 512)
    && (status === "verified" || status === "failed")
    && typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt))
    && isWorkbenchDigest(evidenceDigest);
}

function isWorkbenchDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export interface DeviceDeveloperSessionV1 {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly ownerKind: "daemon" | "mobile";
  readonly ownerId: string;
  readonly targetDeviceId: string;
  readonly targetKind: DeviceKindV1;
  readonly mode: DeviceSessionModeV1;
  readonly authorizationRevision: string;
  readonly targetBinding?: {
    readonly profileRevision: string;
    readonly connectionRevision: string;
  };
  readonly protocolReplay?: {
    readonly profileId: string;
    readonly profileVersion: string;
    readonly codecId: string;
    readonly codecVersion: string;
    readonly profileResource?: {
      readonly digest: string;
      readonly transport: HardwareProtocolCaptureV1["transport"];
    };
    readonly liveTransport?: {
      readonly transportId: string;
      readonly targetProfileRevision: string;
      readonly connectionRevision: string;
    };
  };
  readonly artifactId?: string;
  readonly artifactDigest?: string;
  readonly status: "created" | "authorized" | "running" | "paused" | "completed" | "failed" | "revoked";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeviceDeveloperJobV1 {
  readonly jobId: string;
  readonly sessionId: string;
  readonly kind: "build" | "deploy" | "launch" | "logs" | "test" | "retest" | "workbench";
  readonly status: "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  readonly artifactDigest?: string;
  readonly buildId?: string;
  readonly nativeWorkbench?: DeviceNativeWorkbenchRequestV1;
  readonly nativeWorkbenchReadback?: DeviceNativeWorkbenchReadbackV1;
  readonly targetDeviceId: string;
  readonly authorizationRevision?: string;
  readonly taskStatus: DeviceTaskStatusV1;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface DeviceDeveloperExecutorResultV1 {
  readonly status: Extract<DeviceDeveloperJobV1["status"], "completed" | "failed" | "unknown" | "cancelled">;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly taskStatus?: DeviceTaskStatusV1;
  readonly nativeWorkbenchReadback?: DeviceNativeWorkbenchReadbackV1;
}

export type AndroidApkIdentityV1 = {
  readonly packageId: string;
  readonly versionCode: string;
  readonly legacyVersionCode?: string;
  readonly signerCertificateSha256: readonly string[];
};

export function isAndroidPackageId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/u.test(value);
}

export function isAndroidVersionCode(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)
    && (value.length < 19 || value <= "9223372036854775807");
}

export interface DeviceDeveloperArtifactV1 {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly targetDeviceId: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly packageId?: string;
  readonly androidApk?: Omit<AndroidApkIdentityV1, "packageId">;
  readonly build?: {
    readonly jobId: string;
    readonly buildId: string;
    readonly fileName: string;
    readonly configurationDigest: string;
    readonly toolchain: string;
    readonly variant: string;
    readonly sourceRevision?: string;
    readonly sourceModified?: boolean;
  };
  readonly createdAt: string;
}

export interface DeviceCollaborationProposalV1 {
  readonly proposalId: string;
  readonly taskId: string;
  readonly ownerKind: "mobile";
  readonly ownerId: string;
  readonly proposerKind: "daemon";
  readonly proposerId: string;
  readonly targetDeviceId: string;
  readonly kind: "observation" | "artifact" | "plan" | "workbench_result";
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly baseRevision: string;
  readonly status: "proposed" | "accepted" | "rejected" | "expired";
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface DeviceArtifactTransferV1 {
  readonly transferId: string;
  readonly proposalId: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly chunkSizeBytes: number;
  readonly totalChunks: number;
  readonly receivedChunks: readonly number[];
}

export interface DeviceArtifactChunkReceiptV1 {
  readonly transferId: string;
  readonly proposalId: string;
  readonly targetDeviceId: string;
  readonly verifiedChunkIndexes: readonly number[];
  readonly status: "receiving" | "verified";
  readonly artifactDigest?: string;
}
