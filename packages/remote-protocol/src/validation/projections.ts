import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteApprovalSummaryV1,
  type RemoteChannelListSnapshotV1,
  type RemoteChannelSnapshotV1,
  type RemoteChannelSummaryV1,
  type RemoteRunSummaryV1,
  type RemoteTranscriptDeltaV1,
  type RemoteTranscriptMessageV1,
  type RemoteWorkspaceSummaryV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys,
  expectArray,
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
  expectString,
} from "./primitives.js";

const CHANNEL_STATUSES = ["active", "paused", "archived"] as const;
const MESSAGE_KINDS = ["message", "ai_reply", "system"] as const;
const MESSAGE_AUTHORS = ["local-user", "ai-teammate", "system"] as const;
const MESSAGE_STATUSES = ["pending", "ready", "blocked", "failed"] as const;
const RUN_STATUSES = ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"] as const;
const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "cancelled"] as const;
const APPROVAL_RISKS = ["low", "medium", "high", "critical"] as const;

export function validateWorkspaceSummary(value: unknown, path: string): RemoteWorkspaceSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "displayName", "policyVersion"], [], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    displayName: expectString(record.displayName, `${path}.displayName`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    policyVersion: expectSafeInteger(record.policyVersion, `${path}.policyVersion`, { minimum: 1 }),
  };
}

function validateChannelSummary(value: unknown, path: string): RemoteChannelSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "channelId", "name", "status", "updatedAt"], [], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    channelId: expectIdentifier(record.channelId, `${path}.channelId`),
    name: expectString(record.name, `${path}.name`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    status: expectEnum(record.status, CHANNEL_STATUSES, `${path}.status`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}

function validateTranscriptMessage(value: unknown, path: string): RemoteTranscriptMessageV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["messageId", "workspaceId", "channelId", "kind", "authorType", "body", "status", "revision", "createdAt", "updatedAt"],
    [],
    path,
  );
  return {
    messageId: expectIdentifier(record.messageId, `${path}.messageId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    channelId: expectIdentifier(record.channelId, `${path}.channelId`),
    kind: expectEnum(record.kind, MESSAGE_KINDS, `${path}.kind`),
    authorType: expectEnum(record.authorType, MESSAGE_AUTHORS, `${path}.authorType`),
    body: expectString(record.body, `${path}.body`, { maxBytes: REMOTE_PROTOCOL_LIMITS.maxTextBodyBytes }),
    status: expectEnum(record.status, MESSAGE_STATUSES, `${path}.status`),
    revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }),
    createdAt: expectRfc3339(record.createdAt, `${path}.createdAt`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
  };
}

export function validateChannelListSnapshot(value: unknown, path: string): RemoteChannelListSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "channels", "generatedAt"], [], path);
  const workspaceId = expectIdentifier(record.workspaceId, `${path}.workspaceId`);
  const channels = expectArray(record.channels, `${path}.channels`, validateChannelSummary, {
    maxItems: REMOTE_PROTOCOL_LIMITS.maxChannelsPerSnapshot,
  });
  const channelIds = new Set<string>();
  channels.forEach((channel, index) => {
    if (channel.workspaceId !== workspaceId) {
      throw new RemoteProtocolError("invalid_field", "Channel list item is outside the snapshot workspace", `${path}.channels[${index}]`);
    }
    if (channelIds.has(channel.channelId)) {
      throw new RemoteProtocolError("invalid_field", "Channel list contains a duplicate channel", `${path}.channels[${index}].channelId`);
    }
    channelIds.add(channel.channelId);
  });
  return {
    workspaceId,
    channels,
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
  };
}

export function validateChannelSnapshot(value: unknown, path: string): RemoteChannelSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["snapshotId", "barrierSeq", "workspace", "channel", "messages", "hasMore", "generatedAt"],
    [],
    path,
  );
  const snapshot: RemoteChannelSnapshotV1 = {
    snapshotId: expectIdentifier(record.snapshotId, `${path}.snapshotId`),
    barrierSeq: expectSafeInteger(record.barrierSeq, `${path}.barrierSeq`, { minimum: 0 }),
    workspace: validateWorkspaceSummary(record.workspace, `${path}.workspace`),
    channel: validateChannelSummary(record.channel, `${path}.channel`),
    messages: expectArray(record.messages, `${path}.messages`, validateTranscriptMessage, {
      maxItems: REMOTE_PROTOCOL_LIMITS.maxMessagesPerSnapshot,
    }),
    hasMore: expectBoolean(record.hasMore, `${path}.hasMore`),
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
  };
  if (snapshot.workspace.workspaceId !== snapshot.channel.workspaceId) {
    throw new RemoteProtocolError("invalid_field", "Snapshot workspace and channel bindings differ", path);
  }
  const messageIds = new Set<string>();
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.workspaceId !== snapshot.workspace.workspaceId || message.channelId !== snapshot.channel.channelId) {
      throw new RemoteProtocolError("invalid_field", "Snapshot message is outside the selected channel", `${path}.messages[${index}]`);
    }
    if (messageIds.has(message.messageId)) {
      throw new RemoteProtocolError("invalid_field", "Snapshot contains a duplicate message", `${path}.messages[${index}].messageId`);
    }
    messageIds.add(message.messageId);
  }
  return snapshot;
}

export function validateTranscriptDelta(value: unknown, path: string): RemoteTranscriptDeltaV1 {
  const record = expectRecord(value, path);
  const operation = expectEnum(record.operation, ["upsert", "remove"] as const, `${path}.operation`);
  if (operation === "upsert") {
    assertStrictKeys(record, ["workspaceId", "channelId", "operation", "message"], [], path);
    const workspaceId = expectIdentifier(record.workspaceId, `${path}.workspaceId`);
    const channelId = expectIdentifier(record.channelId, `${path}.channelId`);
    const message = validateTranscriptMessage(record.message, `${path}.message`);
    if (message.workspaceId !== workspaceId || message.channelId !== channelId) {
      throw new RemoteProtocolError("invalid_field", "Delta message is outside the selected channel", `${path}.message`);
    }
    return { workspaceId, channelId, operation, message };
  }
  assertStrictKeys(record, ["workspaceId", "channelId", "operation", "messageId", "revision"], [], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    channelId: expectIdentifier(record.channelId, `${path}.channelId`),
    operation,
    messageId: expectIdentifier(record.messageId, `${path}.messageId`),
    revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }),
  };
}

export function validateRunSummary(value: unknown, path: string): RemoteRunSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["workspaceId", "channelId", "runId", "status", "createdAt", "updatedAt"],
    ["operationLabel", "terminalAt", "errorCode"],
    path,
  );
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    channelId: expectIdentifier(record.channelId, `${path}.channelId`),
    runId: expectIdentifier(record.runId, `${path}.runId`),
    status: expectEnum(record.status, RUN_STATUSES, `${path}.status`),
    ...(record.operationLabel === undefined ? {} : {
      operationLabel: expectString(record.operationLabel, `${path}.operationLabel`, {
        maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
      }),
    }),
    createdAt: expectRfc3339(record.createdAt, `${path}.createdAt`),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
    ...(record.terminalAt === undefined ? {} : { terminalAt: expectRfc3339(record.terminalAt, `${path}.terminalAt`) }),
    ...(record.errorCode === undefined ? {} : { errorCode: expectIdentifier(record.errorCode, `${path}.errorCode`) }),
  };
}

export function validateApprovalSummary(value: unknown, path: string): RemoteApprovalSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["workspaceId", "channelId", "approvalId", "status", "risk", "title", "createdAt"],
    ["expiresAt"],
    path,
  );
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    channelId: expectIdentifier(record.channelId, `${path}.channelId`),
    approvalId: expectIdentifier(record.approvalId, `${path}.approvalId`),
    status: expectEnum(record.status, APPROVAL_STATUSES, `${path}.status`),
    risk: expectEnum(record.risk, APPROVAL_RISKS, `${path}.risk`),
    title: expectString(record.title, `${path}.title`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    createdAt: expectRfc3339(record.createdAt, `${path}.createdAt`),
    ...(record.expiresAt === undefined ? {} : { expiresAt: expectRfc3339(record.expiresAt, `${path}.expiresAt`) }),
  };
}
