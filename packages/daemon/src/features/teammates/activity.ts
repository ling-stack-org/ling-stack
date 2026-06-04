import type { RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";

export interface TeammateActivityItem {
  readonly id: string;
  readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly createdAt: string;
  readonly sourceId: string;
}

export function buildTeammateActivityItems(
  store: RunStore,
  teammateId: string,
  limit: number,
): TeammateActivityItem[] {
  const items: TeammateActivityItem[] = [];

  const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
  for (const message of store.listTeammateDirectMessages({ teammateId, threadId: thread.id, limit })) {
    items.push({
      id: `direct-message:${message.id}`,
      kind: "direct-message",
      title: message.authorType === "ai-teammate" ? "AI teammate replied" : "Private message",
      subtitle: previewText(message.body),
      status: message.status,
      createdAt: message.createdAt,
      sourceId: message.id,
    });
  }

  for (const task of store.listTasks({ assigneeTeammateId: teammateId, limit })) {
    items.push({
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      subtitle: previewText(task.prompt),
      status: task.status,
      createdAt: task.createdAt,
      sourceId: task.id,
    });
  }

  for (const run of store.listRuns({ teammateId, limit })) {
    items.push({
      id: `run:${run.id}`,
      kind: "run",
      title: run.taskSnapshot && isRecord(run.taskSnapshot) && typeof run.taskSnapshot.title === "string"
        ? run.taskSnapshot.title
        : run.taskId,
      subtitle: run.providerModel,
      status: run.status,
      createdAt: run.createdAt,
      sourceId: run.id,
    });
  }

  const teammateRunIds = new Set(store.listRuns({ teammateId, limit: 200 }).map((run) => run.id));
  for (const approval of store.listApprovalRequests({ status: "pending", limit: 200 })) {
    if (approval.runId && teammateRunIds.has(approval.runId)) {
      items.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        title: approval.title,
        subtitle: approval.description,
        status: approval.status,
        createdAt: approval.createdAt,
        sourceId: approval.id,
      });
    }
  }

  for (const channel of store.listChannels({ limit: 200 })) {
    for (const message of store.listChannelMessages({ channelId: channel.id, limit: 200 })) {
      if (message.mentions.some((mention) => mention.kind === "ai-teammate" && mention.id === teammateId)) {
        items.push({
          id: `channel-message:${message.id}`,
          kind: "channel-message",
          title: `Mentioned in #${channel.name}`,
          subtitle: previewText(message.body),
          status: message.status,
          createdAt: message.createdAt,
          sourceId: message.id,
        });
      }
    }
  }

  return items
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

function previewText(value: string, maxLength = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}...`;
}
