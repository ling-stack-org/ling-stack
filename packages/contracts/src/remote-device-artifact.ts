export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7 = "ling.device-tasks.v7";
export const REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES = 40 * 1024;
export const REMOTE_DEVICE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export interface RemoteDeviceArtifactOfferInputV1 {
  readonly shareId: string;
  readonly expectedRevision: number;
  readonly proposalId: string;
}

export interface RemoteDeviceArtifactManifestV1 {
  readonly version: 1;
  readonly gatewayId: string;
  readonly mobileDeviceId: string;
  readonly deviceEpoch: number;
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly policyVersion: number;
  readonly shareId: string;
  readonly revision: number;
  readonly proposalId: string;
  readonly taskId: string;
  readonly projectionDigest: string;
  readonly ownerId: string;
  readonly targetDeviceId: string;
  readonly attemptId: string;
  readonly connectionRevision: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly chunkBytes: typeof REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES;
  readonly expiresAt: string;
}

export interface RemoteDeviceArtifactReceiptV1 {
  readonly digest: string;
  readonly verifiedAt: string;
  readonly signature: string;
}

export interface RemoteDeviceArtifactOfferV1 {
  readonly manifest: RemoteDeviceArtifactManifestV1;
  readonly signature: string;
  readonly status: "proposed" | "accepted" | "rejected";
  readonly receipt?: RemoteDeviceArtifactReceiptV1;
}

export type RemoteDeviceArtifactActionV1 =
  | { readonly kind: "list" }
  | { readonly kind: "decide"; readonly proposalId: string; readonly decision: "accepted" | "rejected" }
  | { readonly kind: "chunk"; readonly proposalId: string; readonly index: number }
  | { readonly kind: "receipt"; readonly proposalId: string; readonly receipt: RemoteDeviceArtifactReceiptV1 };

export interface RemoteDeviceArtifactCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly expectedRevision: number;
  readonly action: RemoteDeviceArtifactActionV1;
}

export interface RemoteDeviceArtifactChunkV1 {
  readonly index: number;
  readonly digest: string;
  readonly bytes: string;
  readonly signature: string;
}

export type RemoteDeviceArtifactResultV1 = {
  readonly kind: "device_artifact";
  readonly shareId: string;
  readonly revision: number;
} & (
  | { readonly operation: "list"; readonly offers: readonly RemoteDeviceArtifactOfferV1[] }
  | { readonly operation: "decide" | "receipt"; readonly offer: RemoteDeviceArtifactOfferV1 }
  | { readonly operation: "chunk"; readonly proposalId: string; readonly chunk: RemoteDeviceArtifactChunkV1 }
);

export function isRemoteDeviceArtifactOfferInputV1(value: unknown): value is RemoteDeviceArtifactOfferInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const { shareId, expectedRevision, proposalId } = value as Record<string, unknown>;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  return typeof shareId === "string" && identifier.test(shareId) && typeof proposalId === "string" && identifier.test(proposalId)
    && typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1;
}

export function isRemoteDeviceArtifactName(value: string): boolean {
  return value.length > 0 && value.length <= 160 && value !== "." && value !== ".." && value.trim() === value
    && !/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
