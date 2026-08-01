import {
  LING_AGENT_ID,
  type Channel,
  type ChannelMessage,
  type ConversationReadState,
  type LingThread,
  type RemoteConversationKind,
  type RunStore,
  type TeammateDirectMessage,
  type TeammateDirectThread,
} from "@ling-stack/core";
import type {
  ConversationTranscriptMessage,
  RemoteConversationMessageV1,
  RemoteConversationSummaryV1,
} from "@ling-stack/contracts";
import { listChannelBranchRootThreadIds } from "../channels/conversation-surface.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededChannelMessages,
  filterSupersededTeammateDirectMessages,
  projectChannelMessageRevisionMetadata,
  projectTeammateDirectMessageRevisionMetadata,
} from "../conversations/supersession-projection.js";
import { buildConversationDetail } from "../conversations/routes.js";
import { RemoteAccessError } from "./errors.js";

export interface RemoteConversationPage {
  readonly summary: RemoteConversationSummaryV1;
  readonly messages: readonly RemoteConversationMessageV1[];
  readonly hasMoreOlder: boolean;
  readonly olderPageCursor?: string;
}

export interface RemoteConversationAdapter {
  readonly kind: RemoteConversationKind;
  list(now: string): RemoteConversationSummaryV1[];
  getSummary(conversationId: string, now: string): RemoteConversationSummaryV1 | undefined;
  open(conversationId: string, olderPageCursor: string | undefined, now: string): RemoteConversationPage;
  isBusy(conversationId: string): boolean;
}

interface AdapterOptions {
  readonly store: RunStore;
  readonly workspaceId: string;
  readonly localUserId: string;
}

abstract class BaseRemoteConversationAdapter implements RemoteConversationAdapter {
  abstract readonly kind: RemoteConversationKind;

  constructor(protected readonly options: AdapterOptions) {}

  abstract list(now: string): RemoteConversationSummaryV1[];
  abstract getSummary(conversationId: string, now: string): RemoteConversationSummaryV1 | undefined;
  abstract open(conversationId: string, olderPageCursor: string | undefined, now: string): RemoteConversationPage;
  abstract isBusy(conversationId: string): boolean;

  protected version(
    conversationId: string,
    entityType: string,
    entityId: string,
  ): { readonly revision: number; readonly activitySeq: number } {
    return this.options.store.getRemoteProjectionEntityVersion({
      workspaceId: this.options.workspaceId,
      conversationKind: this.kind,
      conversationId,
      entityType,
      entityId,
    });
  }

  protected readState(conversationId: string, now: string): ConversationReadState {
    return this.options.store.getConversationReadState({
      workspaceId: this.options.workspaceId,
      userId: this.options.localUserId,
      conversationKind: this.kind,
      conversationId,
    }, now);
  }

  protected latestActivitySeq(conversationId: string): number {
    return this.options.store.getLatestConversationActivitySeq({
      workspaceId: this.options.workspaceId,
      conversationKind: this.kind,
      conversationId,
    });
  }
}

export class ChannelRemoteConversationAdapter extends BaseRemoteConversationAdapter {
  readonly kind = "channel" as const;

  list(now: string): RemoteConversationSummaryV1[] {
    const channels = [
      ...this.options.store.listChannels({ limit: 500 }),
      ...this.options.store.listChannels({ archived: true, limit: 500 }),
    ];
    return channels
      .filter((channel) => channel.workspaceId === this.options.workspaceId)
      .map((channel) => this.projectSummary(channel, now))
      .sort(compareConversationSummary);
  }

  getSummary(conversationId: string, now: string): RemoteConversationSummaryV1 | undefined {
    const channel = this.options.store.getChannel(conversationId);
    return channel?.workspaceId === this.options.workspaceId ? this.projectSummary(channel, now) : undefined;
  }

  open(conversationId: string, olderPageCursor: string | undefined, now: string): RemoteConversationPage {
    const channel = this.requireChannel(conversationId);
    const page = this.options.store.listChannelMessagesPage({
      channelId: channel.id,
      excludeThreadIds: listChannelBranchRootThreadIds(this.options.store, channel.id),
      ...(olderPageCursor ? { beforeMessageId: olderPageCursor } : {}),
      limit: 100,
    });
    const visible = filterSupersededChannelMessages(page.messages, buildConversationSupersessionProjection(this.options.store, {
      surfaces: ["channel_root", "channel_branch", "topic_reply"],
      ownerId: channel.id,
    })).map((message) => projectChannelMessageRevisionMetadata(this.options.store, message));
    const messages = visible.map((message) => this.projectMessage(message, now));
    return {
      summary: this.projectSummary(channel, now),
      messages,
      hasMoreOlder: page.hasMore,
      ...(page.nextBeforeMessageId ? { olderPageCursor: page.nextBeforeMessageId } : {}),
    };
  }

  isBusy(conversationId: string): boolean {
    const channel = this.options.store.getChannel(conversationId);
    if (!channel || channel.workspaceId !== this.options.workspaceId) {
      return false;
    }
    return this.options.store.listChannelMessagesPage({ channelId: channel.id, limit: 100 }).messages
      .some((message) => message.authorType !== "local-user" && message.status === "pending");
  }

  private projectSummary(channel: Channel, now: string): RemoteConversationSummaryV1 {
    const readState = this.readState(channel.id, now);
    const latest = this.options.store.listChannelMessagesPage({ channelId: channel.id, limit: 1 }).messages.at(-1);
    return {
      workspaceId: this.options.workspaceId,
      conversationId: channel.id,
      kind: this.kind,
      title: channel.name,
      identity: { kind: "channel", label: channel.name },
      status: channel.status === "archived" ? "archived" : "active",
      ...(latest?.body ? { latestPreview: preview(latest.body) } : {}),
      ...(latest ? { latestMessageAt: latest.updatedAt } : {}),
      activitySeq: Math.max(readState.activitySeq, this.latestActivitySeq(channel.id)),
      unreadCount: readState.unreadCount,
      mentioned: readState.mentioned,
      updatedAt: latest?.updatedAt ?? channel.updatedAt,
    };
  }

  private projectMessage(
    message: ChannelMessage,
    now: string,
  ): RemoteConversationMessageV1 {
    const version = this.version(message.channelId, "channel_message", message.id);
    const teammate = message.authorId ? this.options.store.getAiTeammate(message.authorId) : undefined;
    const role = message.authorType === "local-user"
      ? "local_user"
      : message.authorType === "system"
        ? "system"
        : message.authorId === LING_AGENT_ID
          ? "assistant"
          : "teammate";
    return {
      messageId: message.id,
      workspaceId: this.options.workspaceId,
      conversationId: message.channelId,
      role,
      ...(message.authorId ? { authorId: message.authorId } : {}),
      authorLabel: message.authorType === "local-user"
        ? this.options.store.getUserProfile(now).displayName
        : teammate?.displayName ?? (message.authorType === "system" ? "Ling" : "AI teammate"),
      body: message.body,
      status: projectStoredMessageStatus(message.status, message.body),
      revision: Math.max(message.revision ?? 1, version.revision),
      activitySeq: version.activitySeq,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  private requireChannel(conversationId: string): Channel {
    const channel = this.options.store.getChannel(conversationId);
    if (!channel || channel.workspaceId !== this.options.workspaceId) {
      throw new RemoteAccessError("conversation_not_allowed", `Channel is not available to Mobile: ${conversationId}`);
    }
    return channel;
  }
}

export class NormalRemoteConversationAdapter extends BaseRemoteConversationAdapter {
  readonly kind = "conversation" as const;

  list(now: string): RemoteConversationSummaryV1[] {
    return this.options.store.listLingThreads({ kind: "conversation", archived: "include", limit: 500 })
      .filter((thread) => thread.workspaceId === this.options.workspaceId)
      .map((thread) => this.projectSummary(thread, now))
      .sort(compareConversationSummary);
  }

  getSummary(conversationId: string, now: string): RemoteConversationSummaryV1 | undefined {
    const thread = this.options.store.getLingThread(conversationId);
    return thread?.workspaceId === this.options.workspaceId && thread.kind === "conversation"
      ? this.projectSummary(thread, now)
      : undefined;
  }

  open(conversationId: string, olderPageCursor: string | undefined, now: string): RemoteConversationPage {
    const thread = this.requireThread(conversationId);
    const detail = buildConversationDetail(this.options.store, this.options.store.paths.cwd, thread);
    const ordered = [...detail.messages];
    const end = olderPageCursor
      ? ordered.findIndex((message) => message.id === olderPageCursor)
      : ordered.length;
    if (olderPageCursor && end < 0) {
      throw new RemoteAccessError("resync_required", `Normal conversation cursor is stale: ${olderPageCursor}`, true);
    }
    const start = Math.max(0, end - 100);
    const page = ordered.slice(start, end);
    const messages = page.map((message) => this.projectMessage(thread, message, now));
    return {
      summary: this.projectSummary(thread, now),
      messages,
      hasMoreOlder: start > 0,
      ...(start > 0 && messages[0] ? { olderPageCursor: messages[0].messageId } : {}),
    };
  }

  isBusy(conversationId: string): boolean {
    const thread = this.options.store.getLingThread(conversationId);
    return Boolean(
      thread
      && thread.workspaceId === this.options.workspaceId
      && thread.kind === "conversation"
      && (thread.activeRunId || thread.status === "running" || thread.status === "waiting_for_approval"),
    );
  }

  private projectSummary(thread: LingThread, now: string): RemoteConversationSummaryV1 {
    const readState = this.readState(thread.id, now);
    const latestTurn = this.options.store.listLingTurns({ threadId: thread.id, limit: 1 }).at(0);
    return {
      workspaceId: this.options.workspaceId,
      conversationId: thread.id,
      kind: this.kind,
      title: thread.title,
      identity: { kind: "ling", label: "Ling Agent" },
      status: thread.status === "archived" || thread.archivedAt ? "archived" : "active",
      ...(latestTurn?.userInstruction ? { latestPreview: preview(latestTurn.userInstruction) } : {}),
      ...(latestTurn ? { latestMessageAt: latestTurn.updatedAt } : {}),
      activitySeq: Math.max(readState.activitySeq, this.latestActivitySeq(thread.id)),
      unreadCount: readState.unreadCount,
      mentioned: false,
      updatedAt: latestTurn?.updatedAt ?? thread.updatedAt,
    };
  }

  private projectMessage(
    thread: LingThread,
    message: ConversationTranscriptMessage,
    now: string,
  ): RemoteConversationMessageV1 {
    const isUser = message.role === "user";
    const entityType = isUser ? "ling_turn" : "run_session";
    const entityId = isUser ? message.turnId ?? message.id : message.runId ?? message.id;
    const version = this.version(thread.id, entityType, entityId);
    return {
      messageId: message.id,
      workspaceId: this.options.workspaceId,
      conversationId: thread.id,
      role: isUser ? "local_user" : "assistant",
      ...(isUser ? {} : { authorId: message.authorId ?? LING_AGENT_ID }),
      authorLabel: isUser ? this.options.store.getUserProfile(now).displayName : message.authorLabel ?? "Ling Agent",
      body: message.content,
      status: projectTranscriptStatus(message.status, message.content),
      revision: Math.max(message.revision ?? 1, version.revision),
      activitySeq: isUser ? version.activitySeq : Math.max(version.activitySeq, this.latestActivitySeq(thread.id)),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  private requireThread(conversationId: string): LingThread {
    const thread = this.options.store.getLingThread(conversationId);
    if (!thread || thread.workspaceId !== this.options.workspaceId || thread.kind !== "conversation") {
      throw new RemoteAccessError("conversation_not_allowed", `Conversation is not available to Mobile: ${conversationId}`);
    }
    return thread;
  }
}

export class TeammateDirectRemoteConversationAdapter extends BaseRemoteConversationAdapter {
  readonly kind = "teammate_direct" as const;

  list(now: string): RemoteConversationSummaryV1[] {
    return this.options.store.listTeammateDirectThreads({ limit: 500 })
      .filter((thread) => thread.workspaceId === this.options.workspaceId)
      .map((thread) => this.projectSummary(thread, now))
      .sort(compareConversationSummary);
  }

  getSummary(conversationId: string, now: string): RemoteConversationSummaryV1 | undefined {
    const thread = this.options.store.listTeammateDirectThreads({ limit: 500 })
      .find((candidate) => candidate.id === conversationId && candidate.workspaceId === this.options.workspaceId);
    return thread ? this.projectSummary(thread, now) : undefined;
  }

  open(conversationId: string, olderPageCursor: string | undefined, now: string): RemoteConversationPage {
    const thread = this.requireThread(conversationId);
    const page = this.options.store.listTeammateDirectMessagesPage({
      teammateId: thread.teammateId,
      threadId: thread.id,
      ...(olderPageCursor ? { beforeMessageId: olderPageCursor } : {}),
      limit: 100,
    });
    const visible = filterSupersededTeammateDirectMessages(page.messages, buildConversationSupersessionProjection(this.options.store, {
      surfaces: ["teammate_direct"],
      ownerId: thread.teammateId,
      laneId: thread.id,
    })).map((message) => projectTeammateDirectMessageRevisionMetadata(this.options.store, message));
    const messages = visible.map((message) => this.projectMessage(message, now));
    return {
      summary: this.projectSummary(thread, now),
      messages,
      hasMoreOlder: page.hasMore,
      ...(page.nextBeforeMessageId ? { olderPageCursor: page.nextBeforeMessageId } : {}),
    };
  }

  isBusy(conversationId: string): boolean {
    const thread = this.options.store.listTeammateDirectThreads({ limit: 500 })
      .find((candidate) => candidate.id === conversationId && candidate.workspaceId === this.options.workspaceId);
    return Boolean(thread && this.options.store.listTeammateDirectMessagesPage({
      teammateId: thread.teammateId,
      threadId: thread.id,
      limit: 100,
    }).messages.some((message) => message.authorType !== "local-user" && message.status === "pending"));
  }

  private projectSummary(thread: TeammateDirectThread, now: string): RemoteConversationSummaryV1 {
    const teammate = this.options.store.getAiTeammate(thread.teammateId);
    const readState = this.readState(thread.id, now);
    const latest = this.options.store.listTeammateDirectMessagesPage({
      teammateId: thread.teammateId,
      threadId: thread.id,
      limit: 1,
    }).messages.at(-1);
    const label = teammate?.displayName ?? thread.title;
    return {
      workspaceId: this.options.workspaceId,
      conversationId: thread.id,
      kind: this.kind,
      title: thread.title,
      identity: { kind: "teammate", label, ...(teammate?.description ? { subtitle: teammate.description } : {}) },
      status: "active",
      ...(latest?.body ? { latestPreview: preview(latest.body) } : {}),
      ...(latest ? { latestMessageAt: latest.updatedAt } : {}),
      activitySeq: Math.max(readState.activitySeq, this.latestActivitySeq(thread.id)),
      unreadCount: readState.unreadCount,
      mentioned: false,
      updatedAt: latest?.updatedAt ?? thread.updatedAt,
    };
  }

  private projectMessage(
    message: TeammateDirectMessage,
    now: string,
  ): RemoteConversationMessageV1 {
    const version = this.version(message.threadId, "teammate_direct_message", message.id);
    const teammate = this.options.store.getAiTeammate(message.teammateId);
    const role = message.authorType === "local-user"
      ? "local_user"
      : message.authorType === "system"
        ? "system"
        : message.authorId === LING_AGENT_ID
          ? "assistant"
          : "teammate";
    return {
      messageId: message.id,
      workspaceId: this.options.workspaceId,
      conversationId: message.threadId,
      role,
      ...(message.authorId ? { authorId: message.authorId } : {}),
      authorLabel: message.authorType === "local-user"
        ? this.options.store.getUserProfile(now).displayName
        : teammate?.displayName ?? (message.authorType === "system" ? "Ling" : "AI teammate"),
      body: message.body,
      status: projectStoredMessageStatus(message.status, message.body),
      revision: Math.max(message.revision ?? 1, version.revision),
      activitySeq: version.activitySeq,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  private requireThread(conversationId: string): TeammateDirectThread {
    const thread = this.options.store.listTeammateDirectThreads({ limit: 500 })
      .find((candidate) => candidate.id === conversationId && candidate.workspaceId === this.options.workspaceId);
    if (!thread) {
      throw new RemoteAccessError("conversation_not_allowed", `Teammate conversation is not available to Mobile: ${conversationId}`);
    }
    return thread;
  }
}

function projectStoredMessageStatus(
  status: ChannelMessage["status"] | TeammateDirectMessage["status"],
  body: string,
): RemoteConversationMessageV1["status"] {
  if (status === "pending") {
    return body ? "streaming" : "pending";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  return "ready";
}

function projectTranscriptStatus(
  status: ConversationTranscriptMessage["status"],
  body: string,
): RemoteConversationMessageV1["status"] {
  if (status === "running") {
    return body ? "streaming" : "pending";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  return "ready";
}

function preview(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function compareConversationSummary(left: RemoteConversationSummaryV1, right: RemoteConversationSummaryV1): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.conversationId.localeCompare(right.conversationId);
}
