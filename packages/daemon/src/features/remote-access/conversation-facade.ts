import {
  RemoteCommandIdempotencyConflictError,
  RemoteCommandRetryWindowExpiredError,
  RemoteConversationNotFoundError,
  type RemoteProjectionOutboxRecord,
  type RunStore,
} from "@ling-stack/core";
import type {
  RemoteAccessPolicySummaryV1,
  RemoteConversationAccessV1,
  RemoteConversationDeltaV1,
  RemoteConversationListSnapshotV1,
  RemoteConversationSnapshotV1,
  RemoteMarkConversationReadCommandV1,
  RemoteProfileUpdateCommandV1,
  RemoteSendTextCommandV1,
  RemoteUserProfileV1,
  RemoteWorkspaceSummaryV1,
} from "@ling-stack/contracts";
import {
  ChannelRemoteConversationAdapter,
  NormalRemoteConversationAdapter,
  TeammateDirectRemoteConversationAdapter,
  type RemoteConversationAdapter,
} from "./conversation-adapters.js";
import { RemoteAccessError } from "./errors.js";
import { RemoteProfileService } from "./profile-service.js";

export type RemoteProjectedEvent =
  | { readonly type: "conversation.delta"; readonly payload: RemoteConversationDeltaV1 }
  | { readonly type: "profile.snapshot"; readonly payload: RemoteUserProfileV1 };

export interface RemoteConversationFacadeOptions {
  readonly store: RunStore;
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly workspaceDisplayName: string;
  readonly localUserId?: string;
  readonly conversationAccess: RemoteConversationAccessV1;
  readonly policyVersion: number;
  readonly now?: () => string;
}

/**
 * The only conversation/profile service exposed to the remote listener.
 * It deliberately has no cwd, provider, runner, tool, approval, or filesystem API.
 */
export class RemoteConversationFacade {
  private readonly store: RunStore;
  private readonly workspaceId: string;
  private readonly workspaceBindingId: string;
  private readonly workspaceDisplayName: string;
  private readonly localUserId: string;
  private readonly conversationAccess: RemoteConversationAccessV1;
  private readonly policyVersion: number;
  private readonly now: () => string;
  private readonly adapters: readonly RemoteConversationAdapter[];
  private readonly profile: RemoteProfileService;

  constructor(options: RemoteConversationFacadeOptions) {
    this.store = options.store;
    this.workspaceId = options.workspaceId;
    this.workspaceBindingId = options.workspaceBindingId;
    this.workspaceDisplayName = options.workspaceDisplayName;
    this.localUserId = options.localUserId ?? "local-user";
    this.conversationAccess = options.conversationAccess;
    this.policyVersion = options.policyVersion;
    this.now = options.now ?? (() => new Date().toISOString());
    const adapterOptions = {
      store: options.store,
      workspaceId: options.workspaceId,
      localUserId: this.localUserId,
    };
    this.adapters = [
      new ChannelRemoteConversationAdapter(adapterOptions),
      new NormalRemoteConversationAdapter(adapterOptions),
      new TeammateDirectRemoteConversationAdapter(adapterOptions),
    ];
    this.profile = new RemoteProfileService(options.store, options.workspaceId);
  }

  policySummary(capabilities: RemoteAccessPolicySummaryV1["capabilities"]): RemoteAccessPolicySummaryV1 {
    return {
      version: 1,
      workspaceId: this.workspaceId,
      workspaceBindingId: this.workspaceBindingId,
      policyVersion: this.policyVersion,
      conversationAccess: this.conversationAccess,
      capabilities,
    };
  }

  workspaceSummary(): RemoteWorkspaceSummaryV1 {
    return {
      workspaceId: this.workspaceId,
      workspaceBindingId: this.workspaceBindingId,
      displayName: this.workspaceDisplayName,
      policyVersion: this.policyVersion,
    };
  }

  listConversations(requestedWorkspaceId: string): RemoteConversationListSnapshotV1 {
    this.assertWorkspace(requestedWorkspaceId);
    const generatedAt = this.now();
    const conversations = this.adapters
      .flatMap((adapter) => adapter.list(generatedAt))
      .filter((conversation) => this.isAllowed(conversation.kind, conversation.conversationId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.conversationId.localeCompare(right.conversationId));
    return {
      workspaceId: this.workspaceId,
      workspaceBindingId: this.workspaceBindingId,
      conversations,
      generatedAt,
    };
  }

  openConversation(
    requestedWorkspaceId: string,
    conversationId: string,
    olderPageCursor?: string,
  ): RemoteConversationSnapshotV1 {
    this.assertWorkspace(requestedWorkspaceId);
    const now = this.now();
    const adapter = this.resolveAllowedAdapter(conversationId, now);
    const page = adapter.open(conversationId, olderPageCursor, now);
    const read = this.store.getConversationReadState({
      workspaceId: this.workspaceId,
      userId: this.localUserId,
      conversationKind: adapter.kind,
      conversationId,
    }, now);
    const barrierSeq = Math.max(page.summary.activitySeq, ...page.messages.map((message) => message.activitySeq));
    return {
      snapshotId: `snapshot_${this.workspaceBindingId}_${conversationId}_${barrierSeq}`,
      barrierSeq,
      workspace: this.workspaceSummary(),
      conversation: page.summary,
      readState: {
        workspaceId: this.workspaceId,
        conversationId,
        readThroughActivitySeq: read.readThroughActivitySeq,
        unreadCount: read.unreadCount,
        mentioned: read.mentioned,
        updatedAt: read.updatedAt,
      },
      messages: page.messages,
      hasMoreOlder: page.hasMoreOlder,
      ...(page.olderPageCursor ? { olderPageCursor: page.olderPageCursor } : {}),
      generatedAt: now,
    };
  }

  sendText(
    command: RemoteSendTextCommandV1,
    context: { readonly deviceId: string; readonly bodyHash: string },
  ): { readonly kind: "message_created"; readonly conversationId: string; readonly messageId: string } {
    this.assertWorkspace(command.workspaceId);
    const now = this.now();
    const adapter = this.resolveAllowedAdapter(command.conversationId, now);
    if (adapter.getSummary(command.conversationId, now)?.status === "archived") {
      throw new RemoteAccessError("conversation_not_allowed", "Archived conversations are read-only on Mobile.");
    }
    const existingReceipt = this.store.getRemoteCommandReceipt(command.commandId);
    if (!existingReceipt && this.isConversationBusy(adapter, command.conversationId)) {
      throw new RemoteAccessError("conversation_busy", "This conversation is already producing a reply. Retry after it finishes.", true);
    }
    try {
      const committed = this.store.commitRemoteConversationSend({
        workspaceId: this.workspaceId,
        deviceId: context.deviceId,
        commandId: command.commandId,
        bodyHash: context.bodyHash,
        conversationKind: adapter.kind,
        conversationId: command.conversationId,
        body: command.body,
        issuedAt: command.issuedAt,
        retryUntil: command.retryUntil,
      }, now);
      return {
        kind: "message_created",
        conversationId: command.conversationId,
        messageId: committed.messageId,
      };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  markRead(command: RemoteMarkConversationReadCommandV1): {
    readonly kind: "conversation_marked_read";
    readonly conversationId: string;
    readonly readThroughActivitySeq: number;
  } {
    this.assertWorkspace(command.workspaceId);
    const now = this.now();
    const adapter = this.resolveAllowedAdapter(command.conversationId, now);
    const read = this.store.markConversationRead({
      workspaceId: this.workspaceId,
      userId: this.localUserId,
      conversationKind: adapter.kind,
      conversationId: command.conversationId,
      throughActivitySeq: command.throughActivitySeq,
    }, now);
    return {
      kind: "conversation_marked_read",
      conversationId: command.conversationId,
      readThroughActivitySeq: read.readThroughActivitySeq,
    };
  }

  readProfile(requestedWorkspaceId: string): RemoteUserProfileV1 {
    this.assertWorkspace(requestedWorkspaceId);
    return this.profile.read(this.now());
  }

  updateProfile(command: RemoteProfileUpdateCommandV1): RemoteUserProfileV1 {
    this.assertWorkspace(command.workspaceId);
    return this.profile.update(command, this.now());
  }

  projectOutboxRecord(record: RemoteProjectionOutboxRecord): readonly RemoteProjectedEvent[] {
    if (record.workspaceId !== this.workspaceId) {
      return [];
    }
    if (record.entityType === "user_profile") {
      return [{ type: "profile.snapshot", payload: this.readProfile(this.workspaceId) }];
    }
    if (!record.conversationKind || !record.conversationId || !this.isAllowed(record.conversationKind, record.conversationId)) {
      return [];
    }
    if (record.entityType === "conversation_read_state") {
      const adapter = this.adapters.find((candidate) => candidate.kind === record.conversationKind);
      if (!adapter?.getSummary(record.conversationId, this.now())) {
        return [];
      }
      const read = this.store.getConversationReadState({
        workspaceId: this.workspaceId,
        userId: this.localUserId,
        conversationKind: record.conversationKind,
        conversationId: record.conversationId,
      }, this.now());
      return [{
        type: "conversation.delta",
        payload: {
          operation: "read_state",
          readState: {
            workspaceId: this.workspaceId,
            conversationId: record.conversationId,
            readThroughActivitySeq: read.readThroughActivitySeq,
            unreadCount: read.unreadCount,
            mentioned: read.mentioned,
            updatedAt: read.updatedAt,
          },
        },
      }];
    }
    if (record.entityType === "channel" || record.entityType === "ling_thread" || record.entityType === "teammate_direct_thread") {
      if (record.operation === "delete") {
        return [{
          type: "conversation.delta",
          payload: {
            operation: "conversation_remove",
            workspaceId: this.workspaceId,
            conversationId: record.conversationId,
            activitySeq: record.activitySeq,
          },
        }];
      }
      const summary = this.adapters
        .find((adapter) => adapter.kind === record.conversationKind)
        ?.getSummary(record.conversationId, this.now());
      return summary ? [{ type: "conversation.delta", payload: { operation: "conversation_upsert", conversation: summary } }] : [];
    }
    if (record.operation === "delete") {
      const messageId = record.entityType === "ling_turn" ? `conversation-user:${record.entityId}` : record.entityId;
      return [{
        type: "conversation.delta",
        payload: {
          operation: "message_remove",
          workspaceId: this.workspaceId,
          conversationId: record.conversationId,
          messageId,
          revision: 1,
          activitySeq: record.activitySeq,
        },
      }];
    }
    const snapshot = this.openConversation(this.workspaceId, record.conversationId);
    const message = findProjectedMessage(snapshot, record);
    const events: RemoteProjectedEvent[] = [{
      type: "conversation.delta",
      payload: { operation: "conversation_upsert", conversation: snapshot.conversation },
    }];
    if (message) {
      events.push({
        type: "conversation.delta",
        payload: {
          operation: "message_upsert",
          workspaceId: this.workspaceId,
          conversationId: record.conversationId,
          message,
        },
      });
    }
    return events;
  }

  private assertWorkspace(requestedWorkspaceId: string): void {
    if (requestedWorkspaceId !== this.workspaceId) {
      throw new RemoteAccessError("workspace_not_allowed", "The requested workspace is not bound to this device.");
    }
  }

  private resolveAllowedAdapter(conversationId: string, now: string): RemoteConversationAdapter {
    const adapter = this.adapters.find((candidate) => {
      const summary = candidate.getSummary(conversationId, now);
      return summary && this.isAllowed(candidate.kind, conversationId);
    });
    if (!adapter) {
      throw new RemoteAccessError("conversation_not_allowed", `Conversation is not available to Mobile: ${conversationId}`);
    }
    return adapter;
  }

  private isAllowed(kind: RemoteConversationAdapter["kind"], conversationId: string): boolean {
    return this.conversationAccess.mode === "selected"
      ? this.conversationAccess.conversationIds.includes(conversationId)
      : this.conversationAccess.kinds.includes(kind);
  }

  private isConversationBusy(adapter: RemoteConversationAdapter, conversationId: string): boolean {
    if (adapter.isBusy(conversationId)) {
      return true;
    }
    return this.store.listRemoteDispatchIntents({
      workspaceId: this.workspaceId,
      statuses: ["pending", "claimed", "failed"],
      limit: 500,
    }).some((intent) => intent.conversationKind === adapter.kind && intent.conversationId === conversationId);
  }
}

function findProjectedMessage(
  snapshot: RemoteConversationSnapshotV1,
  record: RemoteProjectionOutboxRecord,
): RemoteConversationSnapshotV1["messages"][number] | undefined {
  if (record.entityType === "ling_turn") {
    return snapshot.messages.find((message) => message.messageId === `conversation-user:${record.entityId}` || message.messageId === record.entityId);
  }
  if (record.entityType === "run_session" || record.entityType === "run_event") {
    return [...snapshot.messages].reverse().find((message) => message.role === "assistant");
  }
  return snapshot.messages.find((message) => message.messageId === record.entityId);
}

function mapStoreError(error: unknown): Error {
  if (error instanceof RemoteCommandIdempotencyConflictError) {
    return new RemoteAccessError("idempotency_conflict", error.message);
  }
  if (error instanceof RemoteCommandRetryWindowExpiredError) {
    return new RemoteAccessError("command_retry_window_expired", error.message);
  }
  if (error instanceof RemoteConversationNotFoundError) {
    return new RemoteAccessError("conversation_not_allowed", error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
