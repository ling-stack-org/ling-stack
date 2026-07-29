import type { Translate } from "../../i18n.js";
import type { StatusTone } from "../../shared/ui/index.js";
import type { TeammateActivityItem } from "../../types.js";

export type TeammateActivityFilter = "all" | TeammateActivityItem["kind"];

export interface TeammateActivityRowViewModel {
  readonly item: TeammateActivityItem;
  readonly title: string;
  readonly subtitle: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly runId?: string;
  readonly searchText: string;
}

export function buildTeammateActivityRows(
  items: readonly TeammateActivityItem[],
  t: Translate,
): readonly TeammateActivityRowViewModel[] {
  return [...items]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((item) => {
      const kindLabel = t(activityKindLabelKey(item.kind));
      const title = activityTitle(item, t);
      const subtitle = item.subtitle?.trim() || kindLabel;
      const statusLabel = t(activityStatusLabelKey(item.status));
      return {
        item,
        title,
        subtitle,
        kindLabel,
        statusLabel,
        statusTone: activityStatusTone(item.status),
        runId: item.kind === "run" ? item.sourceId : undefined,
        searchText: [title, subtitle, kindLabel, statusLabel]
          .join(" ")
          .toLocaleLowerCase(),
      };
    });
}

export function filterTeammateActivityRows(
  rows: readonly TeammateActivityRowViewModel[],
  query: string,
  filter: TeammateActivityFilter,
): readonly TeammateActivityRowViewModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => (
    (filter === "all" || row.item.kind === filter) &&
    (!normalizedQuery || row.searchText.includes(normalizedQuery))
  ));
}

export function activityKindLabelKey(kind: TeammateActivityItem["kind"]): string {
  if (kind === "direct-message") return "Private message";
  if (kind === "task") return "Task";
  if (kind === "run") return "Run";
  if (kind === "approval") return "Approval";
  return "Channel mention";
}

export function activityFilterLabelKey(filter: TeammateActivityFilter): string {
  if (filter === "direct-message") return "Messages";
  if (filter === "task") return "Tasks";
  if (filter === "run") return "Runs";
  if (filter === "approval") return "Approvals";
  if (filter === "channel-message") return "Channel mentions";
  return "All activity";
}

function activityTitle(item: TeammateActivityItem, t: Translate): string {
  if (item.kind === "direct-message") {
    return item.title === "AI teammate replied" ? t("AI teammate replied") : t("Private message");
  }
  if (item.kind === "channel-message") {
    const channel = /^Mentioned in #(.*)$/u.exec(item.title)?.[1]?.trim();
    return channel ? t("Mentioned in #{channel}", { channel }) : t("Channel mention");
  }
  return item.title.trim() || t(activityKindLabelKey(item.kind));
}

function activityStatusLabelKey(status: string | undefined): string {
  if (!status) return "Recorded";
  if (status === "todo") return "To do";
  if (status === "claimed") return "Claimed";
  if (status === "running") return "Running";
  if (status === "blocked") return "Blocked";
  if (status === "review") return "In review";
  if (status === "done" || status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "queued") return "Queued";
  if (status === "waiting_for_approval") return "Waiting for approval";
  if (status === "pending") return "Pending";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "ready" || status === "succeeded") return "Ready";
  return "Recorded";
}

function activityStatusTone(status: string | undefined): StatusTone {
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "blocked" || status === "pending" || status === "waiting_for_approval") return "warning";
  if (status === "running" || status === "claimed" || status === "review" || status === "queued") return "info";
  if (status === "done" || status === "completed" || status === "approved" || status === "ready" || status === "succeeded") {
    return "success";
  }
  return "neutral";
}
