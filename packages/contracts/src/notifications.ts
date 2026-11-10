/**
 * Run notification contract (ux-gap-roadmap-03).
 *
 * The daemon owns run state transitions, so it owns *what* to notify; clients
 * own *how* (OS toast vs in-app toast). This V1 surface is poll-based with a
 * `since` cursor so thin clients stay simple; a stream can be layered later
 * without breaking this contract because every response is self-describing.
 */

export type NotificationEventKind =
  | "automation_run_finished"
  | "automation_run_failed"
  | "approval_required";

export type NotificationDeliveryTone = "all" | "failures" | "off";

export interface NotificationPreferences {
  readonly schemaVersion: 1;
  readonly globalEnabled: boolean;
  readonly events: Readonly<Record<NotificationEventKind, NotificationDeliveryTone>>;
  readonly quietHours?: Readonly<{ start: string; end: string }>;
}

export interface NotificationRecord {
  readonly id: string;
  readonly kind: NotificationEventKind;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly automationId?: string;
  readonly automationLabel?: string;
  readonly runId?: string;
  readonly cwd?: string;
}

export interface NotificationListResponse {
  readonly schemaVersion: 1;
  readonly notifications: readonly NotificationRecord[];
  readonly nextSince: string;
}

export interface NotificationPreferencesResponse {
  readonly schemaVersion: 1;
  readonly preferences: NotificationPreferences;
}

/** Loose update shape: omitted event kinds keep their current tone. */
export interface NotificationPreferencesUpdate {
  globalEnabled?: boolean;
  events?: Partial<Record<NotificationEventKind, NotificationDeliveryTone>>;
  quietHours?: { start: string; end: string } | null;
}

export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    schemaVersion: 1,
    globalEnabled: true,
    events: {
      automation_run_finished: "failures",
      automation_run_failed: "all",
      approval_required: "all",
    },
  };
}

export function isQuietHour(
  preferences: NotificationPreferences,
  at: Date = new Date(),
): boolean {
  const window = preferences.quietHours;
  if (!window) return false;
  const parse = (value: string): number | undefined => {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    if (!match) return undefined;
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
    return hours * 60 + minutes;
  };
  const start = parse(window.start);
  const end = parse(window.end);
  if (start === undefined || end === undefined || start === end) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function notificationMatchesTone(
  kind: NotificationEventKind,
  tone: NotificationDeliveryTone | undefined,
): boolean {
  if (tone === "off") return false;
  // Failed runs and approval requests are actionable; they deliver under both
  // "all" and "failures". Successful runs only deliver under "all".
  if (kind === "automation_run_failed" || kind === "approval_required") return true;
  return tone === "all";
}
