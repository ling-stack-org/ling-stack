import type {
  GovernanceNotificationKind,
  GovernanceNotificationListResponse,
  GovernanceNotificationMutationResponse,
  GovernanceNotificationStatus,
  GovernanceNotificationSummaryResponse,
  GovernanceNotificationSurfaceKind,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const governanceNotificationEndpoints = {
  async listGovernanceNotifications(
    this: LingDaemonEndpointContext,
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
    return this._get("/governance-notifications", {
      cwd,
      surface: options.surface,
      channelId: options.channelId,
      teammateId: options.teammateId,
      threadId: options.threadId,
      kind: options.kind,
      status: options.status,
      includeResolved: options.includeResolved,
      includeDismissed: options.includeDismissed,
      limit: options.limit,
    });
  },

  async getGovernanceNotificationSummary(this: LingDaemonEndpointContext, cwd: string): Promise<GovernanceNotificationSummaryResponse> {
    return this._get("/governance-notifications/summary", { cwd });
  },

  async markGovernanceNotificationSeen(
    this: LingDaemonEndpointContext,
    cwd: string,
    notificationId: string,
  ): Promise<GovernanceNotificationMutationResponse> {
    return this._post(`/governance-notifications/${encodeURIComponent(notificationId)}/seen`, { cwd }, {});
  },

  async dismissGovernanceNotification(
    this: LingDaemonEndpointContext,
    cwd: string,
    notificationId: string,
  ): Promise<GovernanceNotificationMutationResponse> {
    return this._post(`/governance-notifications/${encodeURIComponent(notificationId)}/dismiss`, { cwd }, {});
  },
};

export type GovernanceNotificationEndpoints = PublicEndpointGroup<typeof governanceNotificationEndpoints>;
