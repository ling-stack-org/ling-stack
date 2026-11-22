import type { DeviceTaskAttemptV1, DeviceTaskStatusV1, DeviceVerificationResultV1 } from "./device.js";
import type { LinuxNetworkFacts } from "./device-linux-ssh.js";

export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6 = "ling.device-tasks.v6";
export const REMOTE_DEVICE_COLLABORATION_MAX_MS = 60 * 60_000;
export const REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS = 12;
export const REMOTE_DEVICE_COLLABORATION_MAX_SHARES = 12;
export const REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES = 2 * 1024;

export interface RemotePhoneTaskProjectionV1 {
  readonly taskId: string;
  readonly ownerId: string;
  readonly targetDeviceId: string;
  readonly status: DeviceTaskStatusV1;
  readonly updatedAt: string;
  readonly attempt: {
    readonly attemptId: string;
    readonly capabilityId: string;
    readonly connectionRevision: string;
    readonly status: DeviceTaskAttemptV1["status"];
    readonly verification?: {
      readonly evidenceId: string;
      readonly connectionRevision: string;
      readonly status: DeviceVerificationResultV1["status"];
    };
  };
  readonly facts?:
    | { readonly kind: "linux_network"; readonly network: LinuxNetworkFacts }
    | { readonly kind: "home_assistant"; readonly availability: "available" | "unavailable" | "absent"; readonly automationEnabled?: boolean };
}

export type RemoteDeviceCollaborationActionV1 =
  | { readonly kind: "publish"; readonly expectedRevision: number; readonly expiresAt: string; readonly projection: RemotePhoneTaskProjectionV1 }
  | { readonly kind: "read" }
  | { readonly kind: "decide"; readonly expectedRevision: number; readonly proposalId: string; readonly decision: "accepted" | "rejected" }
  | { readonly kind: "revoke" };

export interface RemoteDeviceCollaborationCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly action: RemoteDeviceCollaborationActionV1;
}

export interface RemoteDeviceAnalysisProposalV1 {
  readonly proposalId: string;
  readonly status: "proposed" | "accepted" | "rejected";
  readonly text: string;
  readonly createdAt: string;
}

export type RemoteDeviceCollaborationViewV1 = {
  readonly workspaceId: string;
  readonly shareId: string;
  readonly revision: number;
  readonly expiresAt: string;
} & (
  | {
      readonly state: "active";
      readonly projection: RemotePhoneTaskProjectionV1;
      readonly proposals: readonly RemoteDeviceAnalysisProposalV1[];
    }
  | { readonly state: "expired" | "revoked" }
);

export interface RemoteDeviceCollaborationResultV1 {
  readonly kind: "device_collaboration_state";
  readonly share: RemoteDeviceCollaborationViewV1;
}

export interface RemoteDeviceAnalysisInputV1 {
  readonly shareId: string;
  readonly expectedRevision: number;
  readonly proposalId: string;
  readonly text: string;
}

export function isRemoteDeviceAnalysisInputV1(value: unknown): value is RemoteDeviceAnalysisInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 4) return false;
  const { shareId, expectedRevision, proposalId, text } = value as Record<string, unknown>;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  return typeof shareId === "string" && identifier.test(shareId) && typeof proposalId === "string" && identifier.test(proposalId)
    && typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1
    && typeof text === "string" && text.length <= REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES;
}
