import type {
  GovernanceNotificationKind,
  GovernanceNotificationListResponse,
  GovernanceNotificationMutationResponse,
  GovernanceNotificationStatus,
  GovernanceNotificationSummaryResponse,
  GovernanceNotificationSurfaceKind,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function listGovernanceNotifications(
  cwd: string,
  options: {
    readonly surface?: GovernanceNotificationSurfaceKind;
    readonly channelId?: string;
    readonly teammateId?: string;
    readonly threadId?: string;
    readonly kind?: GovernanceNotificationKind;
    readonly status?: GovernanceNotificationStatus;
    readonly includeResolved?: boolean;
    readonly includeDismissed?: boolean;
    readonly limit?: number;
  } = {},
): Promise<GovernanceNotificationListResponse> {
  return daemonClient.listGovernanceNotifications(cwd, options);
}

export async function getGovernanceNotificationSummary(cwd: string): Promise<GovernanceNotificationSummaryResponse> {
  return daemonClient.getGovernanceNotificationSummary(cwd);
}

export async function markGovernanceNotificationSeen(
  cwd: string,
  notificationId: string,
): Promise<GovernanceNotificationMutationResponse> {
  return daemonClient.markGovernanceNotificationSeen(cwd, notificationId);
}

export async function dismissGovernanceNotification(
  cwd: string,
  notificationId: string,
): Promise<GovernanceNotificationMutationResponse> {
  return daemonClient.dismissGovernanceNotification(cwd, notificationId);
}
