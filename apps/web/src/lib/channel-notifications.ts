export type ChannelNotificationLevel = "all" | "mentions" | "muted";

export type ChannelNotificationSignal =
  | "activity"
  | "approval"
  | "blocker"
  | "critical_approval"
  | "mention"
  | "message";

export function isChannelNotificationLevel(
  value: string | null | undefined,
): value is ChannelNotificationLevel {
  return value === "all" || value === "mentions" || value === "muted";
}

export function readChannelNotificationLevel(
  value: string | null | undefined,
): ChannelNotificationLevel {
  return isChannelNotificationLevel(value) ? value : "mentions";
}

export function channelNotificationAllows(
  level: ChannelNotificationLevel,
  signal: ChannelNotificationSignal,
): boolean {
  if (level === "all") return true;
  if (level === "muted") return signal === "critical_approval";
  return signal === "mention" || signal === "approval" || signal === "critical_approval" || signal === "blocker";
}
