import { expect, test } from "@playwright/test";
import {
  buildChannelUnreadState,
  selectDesktopComputerUseConversation,
  type ChannelUnreadState,
} from "../src/app/app-shell-selectors.js";
import { buildSidebarChannelNotifications } from "../src/app/sidebar-status-projections.js";
import type { ApprovalRequest, Channel, ChannelMessage } from "../src/types.js";

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

function channel(id: string): Channel {
  return {
    id,
    workspaceId: "workspace_default",
    name: id,
    status: "active",
    autoReplyMode: "mentions_only",
    allowedTools: [],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
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
    channel_muted_regular: { unread: true, mentioned: true },
    channel_muted_critical: { unread: true, mentioned: true },
    channel_default: { unread: true, mentioned: true },
    channel_selected: { unread: true, mentioned: true },
  } satisfies Record<string, ChannelUnreadState>;
  const pendingApproval = {
    id: "approval_muted_regular",
    channelId: "channel_muted_regular",
    actionType: "bash",
    risk: "medium",
    title: "Approval required",
    description: "Confirm command execution.",
    payload: {},
    status: "pending",
    createdAt: "2026-07-15T00:00:00.000Z",
  } satisfies ApprovalRequest;
  const criticalApproval = {
    ...pendingApproval,
    id: "approval_muted_critical",
    channelId: "channel_muted_critical",
    risk: "critical",
  } satisfies ApprovalRequest;

  expect(buildSidebarChannelNotifications({
    approvals: [pendingApproval, criticalApproval],
    channels: Object.keys(unreadById).map(channel),
    channelUnreadById: unreadById,
    notificationLevels: {
      channel_all: "all",
      channel_mentions: "mentions",
      channel_mentions_without_mention: "mentions",
      channel_muted_regular: "muted",
      channel_muted_critical: "muted",
      channel_selected: "all",
    },
    runs: [],
    selectedChannelId: "channel_selected",
    tasks: [],
    workUnits: [],
  })).toEqual({
    channel_muted_critical: { count: 1, primaryStatus: "waiting" },
    channel_all: { unread: true },
    channel_mentions: { unread: true },
    channel_default: { unread: true },
  });
});

test("Desktop Computer Use selection follows structured workspace and teammate thread ids", () => {
  expect(selectDesktopComputerUseConversation({
    activeView: "workspace",
    selectedChannelId: "channel-1",
    selectedChannelBranchRootThreadId: "channel-thread-1",
    selectedConversationThreadId: "normal-thread-ignored",
  })).toBe("channel-thread-1");

  expect(selectDesktopComputerUseConversation({
    activeView: "workspace",
    selectedConversationThreadId: "normal-thread-1",
  })).toBe("normal-thread-1");

  expect(selectDesktopComputerUseConversation({
    activeView: "workspace",
    selectedChannelId: "channel-without-branch",
    selectedConversationThreadId: "normal-thread-must-not-leak",
  })).toBeUndefined();

  expect(selectDesktopComputerUseConversation({
    activeView: "workspace",
    selectedChannelId: "",
    selectedConversationThreadId: "normal-thread-after-empty-channel",
  })).toBe("normal-thread-after-empty-channel");

  expect(selectDesktopComputerUseConversation({
    activeView: "teammates",
    selectedAiTeammateId: "teammate-1",
    teammateDirectThreadId: "direct-thread-1",
  })).toBe("direct-thread-1");

  expect(selectDesktopComputerUseConversation({
    activeView: "teammates",
    selectedAiTeammateId: "teammate-without-thread",
  })).toBeUndefined();

  expect(selectDesktopComputerUseConversation({
    activeView: "teammates",
    teammateDirectThreadId: "orphan-direct-thread",
  })).toBeUndefined();

  expect(selectDesktopComputerUseConversation({
    activeView: "settings",
    selectedConversationThreadId: "normal-thread-1",
    selectedAiTeammateId: "teammate-1",
    teammateDirectThreadId: "direct-thread-1",
  })).toBeUndefined();
});
