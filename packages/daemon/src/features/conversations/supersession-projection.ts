import type {
  ChannelMessage,
  ConversationRevisionSurfaceKind,
  ConversationTurnSupersession,
  LingTerminalReportRecord,
  LingTurn,
  RunStore,
  TeammateDirectMessage,
} from "@ling-stack/core";

export interface ConversationSupersessionProjection {
  readonly supersededTurnIds: ReadonlySet<string>;
  readonly supersededRunIds: ReadonlySet<string>;
  readonly supersededResponseMessageIds: ReadonlySet<string>;
}

export function buildConversationSupersessionProjection(
  store: Partial<Pick<RunStore, "listConversationTurnSupersessions">>,
  options: {
    readonly surfaces?: readonly ConversationRevisionSurfaceKind[];
    readonly ownerId?: string;
    readonly laneId?: string;
  } = {},
): ConversationSupersessionProjection {
  if (!store.listConversationTurnSupersessions) {
    return projectionFromSupersessions([]);
  }
  const surfaces = options.surfaces ? new Set(options.surfaces) : undefined;
  const supersessions = store.listConversationTurnSupersessions({
    ownerId: options.ownerId,
    laneId: options.laneId,
    limit: 500,
  }).filter((item) => !surfaces || surfaces.has(item.surface));
  return projectionFromSupersessions(supersessions);
}

export function filterSupersededLingTurns(
  turns: readonly LingTurn[],
  projection: ConversationSupersessionProjection,
): LingTurn[] {
  return turns.filter((turn) => turn.status !== "superseded" && !projection.supersededTurnIds.has(turn.id));
}

export function filterSupersededChannelMessages(
  messages: readonly ChannelMessage[],
  projection: ConversationSupersessionProjection,
): ChannelMessage[] {
  return messages.filter((message) => !projection.supersededResponseMessageIds.has(message.id));
}

export function filterSupersededTeammateDirectMessages(
  messages: readonly TeammateDirectMessage[],
  projection: ConversationSupersessionProjection,
): TeammateDirectMessage[] {
  return messages.filter((message) => !projection.supersededResponseMessageIds.has(message.id));
}

export function filterSupersededTerminalReports(
  reports: readonly LingTerminalReportRecord[],
  projection: ConversationSupersessionProjection,
): LingTerminalReportRecord[] {
  return reports.filter((record) => {
    if (record.turnId && projection.supersededTurnIds.has(record.turnId)) {
      return false;
    }
    if (record.sourceKind === "turn" && projection.supersededTurnIds.has(record.sourceId)) {
      return false;
    }
    if (record.sourceKind === "run" && projection.supersededRunIds.has(record.sourceId)) {
      return false;
    }
    return !record.publishedMessageId || !projection.supersededResponseMessageIds.has(record.publishedMessageId);
  });
}

export function projectChannelMessageRevisionMetadata(store: RunStore, message: ChannelMessage): ChannelMessage {
  const surface = resolveStoredChannelRevisionSurface(store, message);
  if (!surface) {
    return { ...message, revision: 1 };
  }
  const revision = store.listConversationMessageRevisions({ surface, messageId: message.id }).at(-1);
  const pendingReplacement = projectPendingConversationReplacement(store, surface, message.id);
  return revision ? {
    ...message,
    body: revision.body,
    mentions: revision.mentions,
    attachmentIds: revision.attachmentIds,
    linkPreviewIds: revision.linkPreviewIds,
    fileRefs: revision.fileRefs,
    revision: revision.revision,
    editedAt: revision.revision > 1 ? revision.createdAt : undefined,
    pendingReplacement,
  } : { ...message, revision: 1 };
}

export function projectTeammateDirectMessageRevisionMetadata(store: RunStore, message: TeammateDirectMessage): TeammateDirectMessage {
  const revision = store.listConversationMessageRevisions({ surface: "teammate_direct", messageId: message.id }).at(-1);
  const pendingReplacement = projectPendingConversationReplacement(store, "teammate_direct", message.id);
  return revision ? {
    ...message,
    body: revision.body,
    attachmentIds: revision.attachmentIds,
    linkPreviewIds: revision.linkPreviewIds,
    fileRefs: revision.fileRefs,
    revision: revision.revision,
    editedAt: revision.revision > 1 ? revision.createdAt : undefined,
    pendingReplacement,
  } : { ...message, revision: 1 };
}

export function projectPendingConversationReplacement(
  store: RunStore,
  surface: ConversationRevisionSurfaceKind,
  messageId: string,
) {
  const pending = store.listConversationTurnSupersessions({
    surface,
    messageId,
    replacementStatus: "pending",
    limit: 1,
  })[0];
  return pending ? {
    supersessionId: pending.id,
    idempotencyKey: pending.idempotencyKey,
    ...(pending.failureReason ? { failureReason: pending.failureReason } : {}),
  } : undefined;
}

function projectionFromSupersessions(supersessions: readonly ConversationTurnSupersession[]): ConversationSupersessionProjection {
  return {
    supersededTurnIds: new Set(supersessions.map((item) => item.supersededTurnId).filter((id): id is string => Boolean(id))),
    supersededRunIds: new Set(supersessions.flatMap((item) => item.supersededRunIds)),
    supersededResponseMessageIds: new Set(supersessions.flatMap((item) => item.supersededResponseMessageIds)),
  };
}

function resolveStoredChannelRevisionSurface(store: RunStore, message: ChannelMessage): ConversationRevisionSurfaceKind | undefined {
  for (const surface of ["channel_root", "channel_branch", "topic_reply"] as const) {
    if (store.listConversationMessageRevisions({ surface, messageId: message.id }).length > 0) {
      return surface;
    }
  }
  return undefined;
}
