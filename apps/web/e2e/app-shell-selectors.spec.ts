import { expect, test } from "@playwright/test";
import {
  buildChannelUnreadState,
  buildSidebarChannelNotifications,
  type ChannelUnreadState,
} from "../src/app/app-shell-selectors.js";
import type { ApprovalRequest, ChannelMessage } from "../src/types.js";

function channelMessage(
  id: string,
  updatedAt: string,
  mentionKind?: "ai-teammate" | "local-user" | "channel",
): ChannelMessage {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "teammate_engineer",
    body: id,
    mentions: mentionKind ? [{ id: "mention_1", label: "User", kind: mentionKind }] : [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: updatedAt,
    updatedAt,
  };
}

test("channel unread state only records local-user mentions after the seen timestamp", () => {
  const messages = [
    channelMessage("older", "2026-07-15T00:00:00.000Z", "local-user"),
    channelMessage("new-ai-mention", "2026-07-15T00:01:00.000Z", "ai-teammate"),
    channelMessage("new-user-mention", "2026-07-15T00:02:00.000Z", "local-user"),
  ];

  expect(buildChannelUnreadState(messages, "2026-07-15T00:00:00.000Z")).toEqual({
    unread: true,
    mentioned: true,
  });
  expect(buildChannelUnreadState(messages, "2026-07-15T00:02:00.000Z")).toBeUndefined();
  expect(buildChannelUnreadState(messages.slice(0, 2), "2026-07-15T00:00:00.000Z")).toEqual({
    unread: true,
    mentioned: false,
  });
});

test("sidebar channel notifications honor all, mentions, muted, and approval blockers", () => {
  const unreadById = {
    channel_all: { unread: true, mentioned: false },
    channel_mentions: { unread: true, mentioned: true },
    channel_mentions_without_mention: { unread: true, mentioned: false },
    channel_muted: { unread: true, mentioned: true },
    channel_default: { unread: true, mentioned: true },
    channel_selected: { unread: true, mentioned: true },
  } satisfies Record<string, ChannelUnreadState>;
  const pendingApproval = {
    id: "approval_muted",
    channelId: "channel_muted",
    actionType: "bash",
    risk: "medium",
    title: "Approval required",
    description: "Confirm command execution.",
    payload: {},
    status: "pending",
    createdAt: "2026-07-15T00:00:00.000Z",
  } satisfies ApprovalRequest;

  expect(buildSidebarChannelNotifications(
    [pendingApproval],
    [],
    [],
    "channel_selected",
    unreadById,
    {
      channel_all: "all",
      channel_mentions: "mentions",
      channel_mentions_without_mention: "mentions",
      channel_muted: "muted",
      channel_selected: "all",
    },
  )).toEqual({
    channel_muted: { unread: true },
    channel_all: { unread: true },
    channel_mentions: { unread: true },
    channel_default: { unread: true },
  });
});
