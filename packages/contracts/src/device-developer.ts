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
  readonly targetBinding?: {
    readonly profileRevision: string;
    readonly connectionRevision: string;
  };
  readonly protocolReplay?: {
    readonly profileId: string;
    readonly profileVersion: string;
    readonly codecId: string;
    readonly codecVersion: string;
    readonly liveTransport?: {
      readonly transportId: string;
      readonly targetProfileRevision: string;
      readonly connectionRevision: string;
    };
  };
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

export interface DeviceArtifactChunkReceiptV1 {
  readonly transferId: string;
  readonly proposalId: string;
  readonly targetDeviceId: string;
  readonly verifiedChunkIndexes: readonly number[];
  readonly status: "receiving" | "verified";
  readonly artifactDigest?: string;
}
