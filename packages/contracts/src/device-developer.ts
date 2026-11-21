import type { DeviceKindV1, DeviceTaskStatusV1, JsonValue } from "./device.js";

export type DeviceSessionModeV1 = "standard" | "developer";

export interface DeviceDeveloperSessionV1 {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly ownerKind: "daemon" | "mobile";
  readonly ownerId: string;
  readonly targetDeviceId: string;
  readonly targetKind: DeviceKindV1;
  readonly mode: DeviceSessionModeV1;
  readonly authorizationRevision: string;
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
  readonly targetDeviceId: string;
  readonly taskStatus: DeviceTaskStatusV1;
  readonly outputRef?: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface DeviceDeveloperArtifactV1 {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly targetDeviceId: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly packageId?: string;
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
