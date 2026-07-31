import type {
  RemoteAccessPolicySummaryV1,
  RemoteCommandFailedV1,
  RemoteConversationDeltaV1,
  RemoteConversationListSnapshotV1,
  RemoteConversationMessageV1,
  RemoteConversationReadStateV1,
  RemoteConversationSnapshotV1,
  RemoteConversationSummaryV1,
  RemoteUserProfileV1,
  RemoteWorkspaceSummaryV1,
} from "@ling-stack/contracts";

export type RemoteConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "revoked";

export interface RemotePendingSend {
  readonly commandId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly issuedAt: string;
  readonly retryUntil: string;
  readonly status: "sending" | "accepted" | "failed";
  readonly error?: RemoteCommandFailedV1["error"];
}

export interface RemoteConversationDetailState {
  readonly snapshotId?: string;
  readonly barrierSeq: number;
  readonly summary?: RemoteConversationSummaryV1;
  readonly readState?: RemoteConversationReadStateV1;
  readonly messages: readonly RemoteConversationMessageV1[];
  readonly hasMoreOlder: boolean;
  readonly olderPageCursor?: string;
}

export interface RemoteClientState {
  readonly connection: RemoteConnectionStatus;
  readonly policy?: RemoteAccessPolicySummaryV1;
  readonly workspace?: RemoteWorkspaceSummaryV1;
  readonly workspaceBindingId?: string;
  readonly conversations: Readonly<Record<string, RemoteConversationSummaryV1>>;
  readonly details: Readonly<Record<string, RemoteConversationDetailState>>;
  readonly profile?: RemoteUserProfileV1;
  readonly pendingSends: Readonly<Record<string, RemotePendingSend>>;
  readonly lastError?: string;
}

export type RemoteStateAction =
  | { readonly type: "connection"; readonly status: RemoteConnectionStatus; readonly error?: string }
  | { readonly type: "session_ready"; readonly policy: RemoteAccessPolicySummaryV1 }
  | { readonly type: "workspace"; readonly workspace: RemoteWorkspaceSummaryV1 }
  | { readonly type: "conversation_list"; readonly snapshot: RemoteConversationListSnapshotV1 }
  | { readonly type: "conversation_snapshot"; readonly snapshot: RemoteConversationSnapshotV1; readonly appendOlder: boolean }
  | { readonly type: "conversation_delta"; readonly delta: RemoteConversationDeltaV1 }
  | { readonly type: "profile"; readonly profile: RemoteUserProfileV1 }
  | { readonly type: "send_started"; readonly send: RemotePendingSend }
  | { readonly type: "send_accepted"; readonly commandId: string }
  | { readonly type: "send_completed"; readonly commandId: string }
  | { readonly type: "send_failed"; readonly commandId: string; readonly error: RemoteCommandFailedV1["error"] }
  | { readonly type: "clear_workspace"; readonly workspaceBindingId?: string };

export function createInitialRemoteClientState(): RemoteClientState {
  return {
    connection: "disconnected",
    conversations: {},
    details: {},
    pendingSends: {},
  };
}

export function reduceRemoteClientState(state: RemoteClientState, action: RemoteStateAction): RemoteClientState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.status, ...(action.error ? { lastError: action.error } : { lastError: undefined }) };
    case "session_ready":
      return {
        ...state,
        connection: "connected",
        policy: action.policy,
        workspaceBindingId: action.policy.workspaceBindingId,
        lastError: undefined,
      };
    case "workspace":
      return { ...state, workspace: action.workspace, workspaceBindingId: action.workspace.workspaceBindingId };
    case "conversation_list":
      return {
        ...state,
        workspaceBindingId: action.snapshot.workspaceBindingId,
        conversations: Object.fromEntries(action.snapshot.conversations.map((conversation) => [conversation.conversationId, conversation])),
      };
    case "conversation_snapshot":
      return applyConversationSnapshot(state, action.snapshot, action.appendOlder);
    case "conversation_delta":
      return applyConversationDelta(state, action.delta);
    case "profile":
      return { ...state, profile: action.profile };
    case "send_started":
      return { ...state, pendingSends: { ...state.pendingSends, [action.send.commandId]: action.send } };
    case "send_accepted": {
      const pending = state.pendingSends[action.commandId];
      return pending
        ? { ...state, pendingSends: { ...state.pendingSends, [action.commandId]: { ...pending, status: "accepted", error: undefined } } }
        : state;
    }
    case "send_completed":
      return { ...state, pendingSends: omitKey(state.pendingSends, action.commandId) };
    case "send_failed": {
      const pending = state.pendingSends[action.commandId];
      return pending
        ? { ...state, pendingSends: { ...state.pendingSends, [action.commandId]: { ...pending, status: "failed", error: action.error } } }
        : state;
    }
    case "clear_workspace":
      return {
        ...createInitialRemoteClientState(),
        connection: state.connection,
        workspaceBindingId: action.workspaceBindingId,
      };
  }
}

function applyConversationSnapshot(
  state: RemoteClientState,
  snapshot: RemoteConversationSnapshotV1,
  appendOlder: boolean,
): RemoteClientState {
  const existing = state.details[snapshot.conversation.conversationId];
  const messages = appendOlder && existing
    ? mergeMessages(snapshot.messages, existing.messages)
    : [...snapshot.messages].sort(compareMessages);
  return {
    ...state,
    workspace: snapshot.workspace,
    workspaceBindingId: snapshot.workspace.workspaceBindingId,
    conversations: {
      ...state.conversations,
      [snapshot.conversation.conversationId]: snapshot.conversation,
    },
    details: {
      ...state.details,
      [snapshot.conversation.conversationId]: {
        snapshotId: snapshot.snapshotId,
        barrierSeq: snapshot.barrierSeq,
        summary: snapshot.conversation,
        readState: snapshot.readState,
        messages,
        hasMoreOlder: snapshot.hasMoreOlder,
        olderPageCursor: snapshot.olderPageCursor,
      },
    },
  };
}

function applyConversationDelta(state: RemoteClientState, delta: RemoteConversationDeltaV1): RemoteClientState {
  if (delta.operation === "conversation_upsert") {
    return {
      ...state,
      conversations: { ...state.conversations, [delta.conversation.conversationId]: delta.conversation },
    };
  }
  if (delta.operation === "conversation_remove") {
    return {
      ...state,
      conversations: omitKey(state.conversations, delta.conversationId),
      details: omitKey(state.details, delta.conversationId),
    };
  }
  if (delta.operation === "read_state") {
    const detail = state.details[delta.readState.conversationId];
    const summary = state.conversations[delta.readState.conversationId];
    return {
      ...state,
      conversations: summary ? {
        ...state.conversations,
        [summary.conversationId]: { ...summary, unreadCount: delta.readState.unreadCount, mentioned: delta.readState.mentioned },
      } : state.conversations,
      details: detail ? {
        ...state.details,
        [delta.readState.conversationId]: { ...detail, readState: delta.readState },
      } : state.details,
    };
  }
  const detail = state.details[delta.conversationId];
  if (!detail) {
    return state;
  }
  if (delta.operation === "message_upsert") {
    const messages = mergeMessages(detail.messages, [delta.message]);
    return {
      ...state,
      details: {
        ...state.details,
        [delta.conversationId]: { ...detail, barrierSeq: Math.max(detail.barrierSeq, delta.message.activitySeq), messages },
      },
    };
  }
  return {
    ...state,
    details: {
      ...state.details,
      [delta.conversationId]: {
        ...detail,
        barrierSeq: Math.max(detail.barrierSeq, delta.activitySeq),
        messages: detail.messages.filter((message) => message.messageId !== delta.messageId || message.revision > delta.revision),
      },
    },
  };
}

function mergeMessages(
  left: readonly RemoteConversationMessageV1[],
  right: readonly RemoteConversationMessageV1[],
): RemoteConversationMessageV1[] {
  const byId = new Map(left.map((message) => [message.messageId, message]));
  for (const message of right) {
    const current = byId.get(message.messageId);
    if (!current || message.revision >= current.revision) {
      byId.set(message.messageId, message);
    }
  }
  return [...byId.values()].sort(compareMessages);
}

function compareMessages(left: RemoteConversationMessageV1, right: RemoteConversationMessageV1): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.activitySeq - right.activitySeq
    || left.messageId.localeCompare(right.messageId);
}

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
