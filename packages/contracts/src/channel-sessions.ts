/** A channel conversation is identified by its canonical LingThread, including the default conversation. */
export interface ChannelSessionSummary {
  readonly id: string;
  readonly channelId: string;
  readonly legacyBranchId?: string;
  readonly title: string;
  readonly isDefault: boolean;
  readonly surfaceKind: "channel_root" | "channel_session" | "branch";
  readonly createdAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly latestNotificationRevision: number;
  readonly pendingApprovalCount: number;
  /** Exact durable ownership, including Runs executing in a separate work thread. */
  readonly activeRunIds: readonly string[];
  /** Includes preflight workflow approvals before a Run exists. */
  readonly pendingApprovalIds: readonly string[];
  readonly runtimeState: "idle" | "queued" | "running" | "waiting" | "blocked" | "failed";
}

export interface ListChannelSessionsOptions {
  readonly archived?: boolean;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ChannelSessionDiagnostic {
  readonly branchId: string;
  readonly code: string;
}

export interface ChannelSessionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly defaultSession?: ChannelSessionSummary;
  readonly sessions: readonly ChannelSessionSummary[];
  readonly nextCursor?: string;
  readonly diagnostics: readonly ChannelSessionDiagnostic[];
  /** All active sessions, including those outside the current page or title filter. */
  readonly notificationWatermarks: readonly ChannelSessionNotificationWatermark[];
  /** Covers all active conversations, regardless of paging or title search. */
  readonly aggregate: {
    readonly pendingApprovalCount: number;
    readonly runningCount: number;
    readonly waitingCount: number;
    readonly failedCount: number;
  };
}

export interface ChannelSessionNotificationWatermark {
  readonly id: string;
  readonly latestNotificationRevision: number;
}

export interface CreateChannelSessionRequest {
  readonly title?: string;
  readonly idempotencyKey: string;
}

export interface UpdateChannelSessionRequest {
  readonly title?: string;
  readonly archived?: boolean;
}

export interface ChannelSessionMutationResponse {
  readonly session: ChannelSessionSummary;
  readonly idempotentReplay?: boolean;
}
