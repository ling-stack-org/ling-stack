import {
  REMOTE_CONVERSATION_KINDS_V1,
  REMOTE_PROTOCOL_LIMITS,
  type RemoteConversationDeltaV1,
  type RemoteConversationIdentityV1,
  type RemoteConversationListSnapshotV1,
  type RemoteConversationMessageV1,
  type RemoteConversationReadStateV1,
  type RemoteConversationSnapshotV1,
  type RemoteConversationSummaryV1,
  type RemoteUserProfileV1,
  type RemoteWorkspaceSummaryV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys,
  expectArray,
  expectAvatarDataUrl,
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
  expectString,
} from "./primitives.js";

const IDENTITY_KINDS = ["channel", "ling", "teammate"] as const;
const CONVERSATION_STATUSES = ["active", "archived"] as const;
const MESSAGE_ROLES = ["local_user", "assistant", "teammate", "system"] as const;
const MESSAGE_STATUSES = ["pending", "streaming", "ready", "blocked", "failed"] as const;

export function validateWorkspaceSummary(value: unknown, path: string): RemoteWorkspaceSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "workspaceBindingId", "displayName", "policyVersion"], [], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    workspaceBindingId: expectIdentifier(record.workspaceBindingId, `${path}.workspaceBindingId`),
    displayName: expectString(record.displayName, `${path}.displayName`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    policyVersion: expectSafeInteger(record.policyVersion, `${path}.policyVersion`, { minimum: 1 }),
  };
}

function validateConversationIdentity(value: unknown, path: string): RemoteConversationIdentityV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["kind", "label"], ["subtitle", "avatarDataUrl"], path);
  return {
    kind: expectEnum(record.kind, IDENTITY_KINDS, `${path}.kind`),
    label: expectString(record.label, `${path}.label`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    ...(record.subtitle === undefined ? {} : {
      subtitle: expectString(record.subtitle, `${path}.subtitle`, {
        maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
      }),
    }),
    ...(record.avatarDataUrl === undefined ? {} : {
      avatarDataUrl: expectAvatarDataUrl(record.avatarDataUrl, `${path}.avatarDataUrl`),
    }),
  };
}

export function validateConversationSummary(value: unknown, path: string): RemoteConversationSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    [
      "workspaceId",
      "conversationId",
      "kind",
      "title",
      "identity",
      "status",
      "activitySeq",
      "unreadCount",
      "mentioned",
      "updatedAt",
    ],
    ["subtitle", "memberCount", "latestPreview", "latestMessageAt"],
    path,
  );
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
    kind: expectEnum(record.kind, REMOTE_CONVERSATION_KINDS_V1, `${path}.kind`),
    title: expectString(record.title, `${path}.title`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    ...(record.subtitle === undefined ? {} : {
      subtitle: expectString(record.subtitle, `${path}.subtitle`, {
        maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
      }),
    }),
    identity: validateConversationIdentity(record.identity, `${path}.identity`),
    status: expectEnum(record.status, CONVERSATION_STATUSES, `${path}.status`),
    ...(record.memberCount === undefined ? {} : {
      memberCount: expectSafeInteger(record.memberCount, `${path}.memberCount`, { minimum: 0 }),
    }),
    ...(record.latestPreview === undefined ? {} : {
      latestPreview: expectString(record.latestPreview, `${path}.latestPreview`, {
        maxBytes: REMOTE_PROTOCOL_LIMITS.maxSafeMessageBytes,
      }),
    }),
    ...(record.latestMessageAt === undefined ? {} : {
      latestMessageAt: expectRfc3339(record.latestMessageAt, `${path}.latestMessageAt`),
    }),
    activitySeq: expectSafeInteger(record.activitySeq, `${path}.activitySeq`, { minimum: 0 }),
    unreadCount: expectSafeInteger(record.unreadCount, `${path}.unreadCount`, { minimum: 0 }),
    mentioned: expectBoolean(record.mentioned, `${path}.mentioned`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}

export function validateConversationMessage(value: unknown, path: string): RemoteConversationMessageV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    [
      "messageId",
      "workspaceId",
      "conversationId",
      "role",
      "authorLabel",
      "body",
      "status",
      "revision",
      "activitySeq",
      "createdAt",
      "updatedAt",
    ],
    ["authorId", "authorAvatarDataUrl"],
    path,
  );
  return {
    messageId: expectIdentifier(record.messageId, `${path}.messageId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
    role: expectEnum(record.role, MESSAGE_ROLES, `${path}.role`),
    ...(record.authorId === undefined ? {} : { authorId: expectIdentifier(record.authorId, `${path}.authorId`) }),
    authorLabel: expectString(record.authorLabel, `${path}.authorLabel`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    ...(record.authorAvatarDataUrl === undefined ? {} : {
      authorAvatarDataUrl: expectAvatarDataUrl(record.authorAvatarDataUrl, `${path}.authorAvatarDataUrl`),
    }),
    body: expectString(record.body, `${path}.body`, { maxBytes: REMOTE_PROTOCOL_LIMITS.maxTextBodyBytes }),
    status: expectEnum(record.status, MESSAGE_STATUSES, `${path}.status`),
    revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }),
    activitySeq: expectSafeInteger(record.activitySeq, `${path}.activitySeq`, { minimum: 0 }),
    createdAt: expectRfc3339(record.createdAt, `${path}.createdAt`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}

export function validateConversationReadState(value: unknown, path: string): RemoteConversationReadStateV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["workspaceId", "conversationId", "readThroughActivitySeq", "unreadCount", "mentioned", "updatedAt"],
    [],
    path,
  );
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
    readThroughActivitySeq: expectSafeInteger(record.readThroughActivitySeq, `${path}.readThroughActivitySeq`, { minimum: 0 }),
    unreadCount: expectSafeInteger(record.unreadCount, `${path}.unreadCount`, { minimum: 0 }),
    mentioned: expectBoolean(record.mentioned, `${path}.mentioned`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}

export function validateConversationListSnapshot(value: unknown, path: string): RemoteConversationListSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "workspaceBindingId", "conversations", "generatedAt"], [], path);
  const workspaceId = expectIdentifier(record.workspaceId, `${path}.workspaceId`);
  const conversations = expectArray(record.conversations, `${path}.conversations`, validateConversationSummary, {
    maxItems: REMOTE_PROTOCOL_LIMITS.maxConversationsPerSnapshot,
  });
  const conversationIds = new Set<string>();
  conversations.forEach((conversation, index) => {
    if (conversation.workspaceId !== workspaceId) {
      throw new RemoteProtocolError("invalid_field", "Conversation is outside the snapshot workspace", `${path}.conversations[${index}]`);
    }
    if (conversationIds.has(conversation.conversationId)) {
      throw new RemoteProtocolError("invalid_field", "Conversation list contains a duplicate", `${path}.conversations[${index}].conversationId`);
    }
    conversationIds.add(conversation.conversationId);
  });
  return {
    workspaceId,
    workspaceBindingId: expectIdentifier(record.workspaceBindingId, `${path}.workspaceBindingId`),
    conversations,
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
  };
}

export function validateConversationSnapshot(value: unknown, path: string): RemoteConversationSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["snapshotId", "barrierSeq", "workspace", "conversation", "readState", "messages", "hasMoreOlder", "generatedAt"],
    ["olderPageCursor"],
    path,
  );
  const snapshot: RemoteConversationSnapshotV1 = {
    snapshotId: expectIdentifier(record.snapshotId, `${path}.snapshotId`),
    barrierSeq: expectSafeInteger(record.barrierSeq, `${path}.barrierSeq`, { minimum: 0 }),
    workspace: validateWorkspaceSummary(record.workspace, `${path}.workspace`),
    conversation: validateConversationSummary(record.conversation, `${path}.conversation`),
    readState: validateConversationReadState(record.readState, `${path}.readState`),
    messages: expectArray(record.messages, `${path}.messages`, validateConversationMessage, {
      maxItems: REMOTE_PROTOCOL_LIMITS.maxMessagesPerSnapshot,
    }),
    hasMoreOlder: expectBoolean(record.hasMoreOlder, `${path}.hasMoreOlder`),
    ...(record.olderPageCursor === undefined ? {} : {
      olderPageCursor: expectIdentifier(record.olderPageCursor, `${path}.olderPageCursor`),
    }),
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
  };
  const { workspaceId } = snapshot.workspace;
  const { conversationId } = snapshot.conversation;
  if (
    snapshot.conversation.workspaceId !== workspaceId
    || snapshot.readState.workspaceId !== workspaceId
    || snapshot.readState.conversationId !== conversationId
  ) {
    throw new RemoteProtocolError("invalid_field", "Snapshot workspace or conversation bindings differ", path);
  }
  const messageIds = new Set<string>();
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.workspaceId !== workspaceId || message.conversationId !== conversationId) {
      throw new RemoteProtocolError("invalid_field", "Snapshot message is outside the selected conversation", `${path}.messages[${index}]`);
    }
    if (messageIds.has(message.messageId)) {
      throw new RemoteProtocolError("invalid_field", "Snapshot contains a duplicate message", `${path}.messages[${index}].messageId`);
    }
    messageIds.add(message.messageId);
  }
  return snapshot;
}

export function validateConversationDelta(value: unknown, path: string): RemoteConversationDeltaV1 {
  const record = expectRecord(value, path);
  const operation = expectEnum(record.operation, [
    "conversation_upsert",
    "conversation_remove",
    "message_upsert",
    "message_remove",
    "read_state",
  ] as const, `${path}.operation`);
  switch (operation) {
    case "conversation_upsert":
      assertStrictKeys(record, ["operation", "conversation"], [], path);
      return { operation, conversation: validateConversationSummary(record.conversation, `${path}.conversation`) };
    case "conversation_remove":
      assertStrictKeys(record, ["operation", "workspaceId", "conversationId", "activitySeq"], [], path);
      return {
        operation,
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        activitySeq: expectSafeInteger(record.activitySeq, `${path}.activitySeq`, { minimum: 0 }),
      };
    case "message_upsert": {
      assertStrictKeys(record, ["operation", "workspaceId", "conversationId", "message"], [], path);
      const workspaceId = expectIdentifier(record.workspaceId, `${path}.workspaceId`);
      const conversationId = expectIdentifier(record.conversationId, `${path}.conversationId`);
      const message = validateConversationMessage(record.message, `${path}.message`);
      if (message.workspaceId !== workspaceId || message.conversationId !== conversationId) {
        throw new RemoteProtocolError("invalid_field", "Delta message binding differs", `${path}.message`);
      }
      return { operation, workspaceId, conversationId, message };
    }
    case "message_remove":
      assertStrictKeys(record, ["operation", "workspaceId", "conversationId", "messageId", "revision", "activitySeq"], [], path);
      return {
        operation,
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        messageId: expectIdentifier(record.messageId, `${path}.messageId`),
        revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }),
        activitySeq: expectSafeInteger(record.activitySeq, `${path}.activitySeq`, { minimum: 0 }),
      };
    case "read_state":
      assertStrictKeys(record, ["operation", "readState"], [], path);
      return { operation, readState: validateConversationReadState(record.readState, `${path}.readState`) };
  }
}

export function validateUserProfile(value: unknown, path: string): RemoteUserProfileV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "displayName", "revision", "updatedAt"], ["handle", "avatarDataUrl"], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    displayName: expectString(record.displayName, `${path}.displayName`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    ...(record.handle === undefined ? {} : {
      handle: expectString(record.handle, `${path}.handle`, { maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes }),
    }),
    ...(record.avatarDataUrl === undefined ? {} : {
      avatarDataUrl: expectAvatarDataUrl(record.avatarDataUrl, `${path}.avatarDataUrl`),
    }),
    revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}
