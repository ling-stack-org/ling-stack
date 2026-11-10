import type { ChannelSessionSummary, ListChannelSessionsOptions, ChannelSessionDiagnostic, UpdateChannelSessionRequest } from "@ling-stack/contracts";

export type { ChannelSessionSummary, ChannelSessionDiagnostic, ListChannelSessionsOptions, UpdateChannelSessionRequest };

export interface CreateChannelSessionInput {
  readonly channelId: string;
  readonly title?: string;
  readonly archived?: boolean;
  readonly idempotencyKey?: string;
  /** Legacy branch routes retain their existing name validation. */
  readonly legacy?: boolean;
}

export interface ChannelSessionPage {
  readonly defaultSession?: ChannelSessionSummary;
  readonly sessions: readonly ChannelSessionSummary[];
  readonly nextCursor?: string;
  readonly notificationWatermarks: readonly { readonly id: string; readonly latestNotificationRevision: number }[];
  readonly diagnostics: readonly ChannelSessionDiagnostic[];
  readonly aggregate: {
    readonly pendingApprovalCount: number;
    readonly runningCount: number;
    readonly waitingCount: number;
    readonly failedCount: number;
  };
}

export class ChannelSessionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: 400 | 404 | 409 = 409) {
    super(message);
    this.name = "ChannelSessionError";
  }
}
