import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ConversationMessageRevisionConflictError,
  type Channel,
  type ChannelMessage,
  type ConversationAttachment,
  type ConversationMessageRevision,
  type ConversationMessageRevisionContent,
  type ConversationRevisionSurfaceKind,
  type ConversationTurnSupersession,
  type LingThread,
  type LingTurn,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunSession,
  type RunStore,
  type TeammateDirectMessage,
  type TeammateDirectThread,
} from "@ling-stack/core";
import type {
  EditConversationMessageRequest,
  EditConversationMessageResponse,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import { RunControlService } from "../../run-control.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  isRecord,
  readOptionalString,
  readOptionalStringArray,
  readString,
} from "../../shared/validation.js";
import { resolveChannelConversationSurface } from "../channels/conversation-surface.js";
import {
  getChannelMessageView,
  listChannelMessageViews,
} from "../channels/conversation-item-messages.js";
import { assertDirectFileRefsWithinWorkspace } from "../teammates/direct-workspace.js";

export type EditableConversationMessage =
  | {
      readonly surface: "normal_conversation";
      readonly ownerId: string;
      readonly laneId: string;
      readonly messageId: string;
      readonly current: ConversationMessageRevisionContent;
      readonly thread: LingThread;
      readonly turn: LingTurn;
      readonly attachments: readonly ConversationAttachment[];
      readonly supersededTurnId: string;
      readonly supersededRunIds: readonly string[];
      readonly supersededResponseMessageIds: readonly string[];
    }
  | {
      readonly surface: "channel_root" | "channel_branch" | "topic_reply";
      readonly ownerId: string;
      readonly laneId: string;
      readonly messageId: string;
      readonly current: ConversationMessageRevisionContent;
      readonly channel: Channel;
      readonly message: ChannelMessage;
      readonly supersededTurnId?: string;
      readonly supersededRunIds: readonly string[];
      readonly supersededResponseMessageIds: readonly string[];
    }
  | {
      readonly surface: "teammate_direct";
      readonly ownerId: string;
      readonly laneId: string;
      readonly messageId: string;
      readonly current: ConversationMessageRevisionContent;
      readonly thread: TeammateDirectThread;
      readonly message: TeammateDirectMessage;
      readonly supersededTurnId?: string;
      readonly supersededRunIds: readonly string[];
      readonly supersededResponseMessageIds: readonly string[];
    };

export interface ConversationReplacementStartResult {
  readonly replacementTurnId?: string;
}

export interface ConversationMessageEditDependencies {
  readonly activeRuns: ActiveRunRegistry;
  readonly startReplacement: (input: {
    readonly store: RunStore;
    readonly editable: EditableConversationMessage;
    readonly request: EditConversationMessageRequest;
    readonly revision: ConversationMessageRevision;
  }) => Promise<ConversationReplacementStartResult>;
}

const runControl = new RunControlService();
const replacementStartPromises = new Map<string, Promise<ConversationTurnSupersession>>();

export async function handleConversationMessageEdit(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  dependencies: ConversationMessageEditDependencies,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for conversation message edits` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const input = parseEditConversationMessageRequest(await readJsonBody(request, config.maxBodyBytes));
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, await editConversationMessage(store, input, dependencies));
  } catch (error) {
    const resolved = mapConversationEditError(error);
    writeJson(response, resolved.statusCode, { error: resolved.code, message: resolved.message });
  }
}

export async function editConversationMessage(
  store: RunStore,
  input: EditConversationMessageRequest,
  dependencies: ConversationMessageEditDependencies,
): Promise<EditConversationMessageResponse> {
  const existing = store.getConversationTurnSupersessionByIdempotency(input.idempotencyKey);
  if (existing) {
    if (existing.surface !== input.surface || existing.ownerId !== input.ownerId || existing.messageId !== input.messageId) {
      throw new HttpError(409, "idempotency_key_conflict", "The idempotency key belongs to a different conversation edit.");
    }
    const revision = findReplacementRevision(store, existing.replacementRevisionId, existing.surface, existing.messageId);
    assertReplayPayloadMatches(input, revision);
    let replay = existing;
    if (existing.replacementStatus !== "started") {
      const editable = resolveEditableConversationMessage(store, input, { skipRevisionCheck: true, skipLatestCheck: true });
      replay = await startReplacementAndUpdate(store, editable, input, revision, existing.id, dependencies);
    }
    return buildEditResponse(revision, replay, true);
  }

  const pendingReplacement = store.listConversationTurnSupersessions({
    surface: input.surface,
    ownerId: input.ownerId,
    messageId: input.messageId,
    replacementStatus: "pending",
    limit: 1,
  })[0];
  if (pendingReplacement) {
    throw new HttpError(409, "replacement_pending", "This edited message already has a pending replacement response. Retry that response before editing again.");
  }

  const editable = resolveEditableConversationMessage(store, input);
  validateReplacementReferences(store, editable, input);
  const interruptedRunIds = interruptSupersededExecutions(store, editable.supersededRunIds, dependencies.activeRuns);
  const committed = store.commitConversationMessageEdit({
    surface: editable.surface,
    ownerId: editable.ownerId,
    laneId: editable.laneId,
    messageId: editable.messageId,
    expectedRevision: input.expectedRevision,
    current: editable.current,
    replacement: replacementContent(input),
    sourceTurnId: editable.supersededTurnId,
    supersededTurnId: editable.supersededTurnId,
    supersededRunIds: editable.supersededRunIds,
    supersededResponseMessageIds: editable.supersededResponseMessageIds,
    idempotencyKey: input.idempotencyKey,
  }, new Date().toISOString());
  const supersession = await startReplacementAndUpdate(
    store,
    editable,
    input,
    committed.revision,
    committed.supersession.id,
    dependencies,
  );
  return {
    ...buildEditResponse(committed.revision, supersession, committed.idempotentReplay),
    interruptedRunIds,
  };
}

async function startReplacementAndUpdate(
  store: RunStore,
  editable: EditableConversationMessage,
  request: EditConversationMessageRequest,
  revision: ConversationMessageRevision,
  supersessionId: string,
  dependencies: ConversationMessageEditDependencies,
): Promise<ConversationTurnSupersession> {
  const key = `${store.paths.cwd}\u0000${supersessionId}`;
  const active = replacementStartPromises.get(key);
  if (active) {
    return active;
  }
  const start = (async () => {
    try {
      const started = await dependencies.startReplacement({ store, editable, request, revision });
      return store.updateConversationTurnSupersession(supersessionId, {
        replacementTurnId: started.replacementTurnId,
        replacementStatus: "started",
        failureReason: null,
      }, new Date().toISOString()) ?? store.getConversationTurnSupersession(supersessionId)!;
    } catch (error) {
      return store.updateConversationTurnSupersession(supersessionId, {
        replacementStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      }, new Date().toISOString()) ?? store.getConversationTurnSupersession(supersessionId)!;
    }
  })();
  replacementStartPromises.set(key, start);
  try {
    return await start;
  } finally {
    if (replacementStartPromises.get(key) === start) {
      replacementStartPromises.delete(key);
    }
  }
}

function resolveEditableConversationMessage(
  store: RunStore,
  input: EditConversationMessageRequest,
  options: { readonly skipRevisionCheck?: boolean; readonly skipLatestCheck?: boolean } = {},
): EditableConversationMessage {
  const editable = input.surface === "normal_conversation"
    ? resolveNormalConversationMessage(store, input, options.skipLatestCheck === true)
    : input.surface === "teammate_direct"
      ? resolveTeammateDirectMessage(store, input, options.skipLatestCheck === true)
      : resolveChannelMessage(store, input, options.skipLatestCheck === true);
  if (!options.skipRevisionCheck) {
    const latestRevision = store.listConversationMessageRevisions({ surface: input.surface, messageId: input.messageId }).at(-1)?.revision ?? 1;
    if (latestRevision !== input.expectedRevision) {
      throw new ConversationMessageRevisionConflictError(input.expectedRevision, latestRevision);
    }
  }
  return editable;
}

function resolveNormalConversationMessage(store: RunStore, input: EditConversationMessageRequest, skipLatestCheck: boolean): EditableConversationMessage {
  const thread = store.getLingThread(input.ownerId);
  if (!thread || thread.kind !== "conversation") {
    throw new HttpError(404, "message_not_found", `Conversation not found: ${input.ownerId}`);
  }
  const turns = store.listLingTurns({ threadId: thread.id, limit: 500 });
  const matchingTurns = turns
    .filter((candidate) => normalConversationMessageId(candidate) === input.messageId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const turn = matchingTurns.find((candidate) => candidate.status !== "superseded") ?? matchingTurns[0];
  if (!turn) {
    throw new HttpError(404, "message_not_found", `Conversation message not found: ${input.messageId}`);
  }
  if (turn.createdByActor !== "local-user") {
    throw new HttpError(403, "message_not_owned_by_user", "Only local-user messages can be edited.");
  }
  const latest = [...turns]
    .filter((candidate) => candidate.createdByActor === "local-user" && candidate.status !== "superseded")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
  if (!skipLatestCheck && (!latest || latest.id !== turn.id)) {
    throw new HttpError(409, "message_not_latest", "Only the latest user message in this conversation can be edited.");
  }
  const runIds = store.listLingTurnRuns(turn.id).map((link) => link.runId);
  const latestRun = runIds.map((runId) => store.getRun(runId)).filter((run): run is RunSession => Boolean(run)).at(-1);
  const attachmentIds = readStringArrayFromRecord(latestRun?.requestSnapshot, "conversationAttachmentIds");
  return {
    surface: "normal_conversation",
    ownerId: thread.id,
    laneId: thread.id,
    messageId: input.messageId,
    current: {
      body: turn.userInstruction,
      mentions: [],
      attachmentIds,
      linkPreviewIds: [],
      fileRefs: [],
    },
    thread,
    turn,
    attachments: attachmentIds.map((id) => store.getConversationAttachment(id)).filter((item): item is ConversationAttachment => Boolean(item)),
    supersededTurnId: turn.id,
    supersededRunIds: runIds,
    supersededResponseMessageIds: [`conversation-assistant:${turn.id}`],
  };
}

function resolveChannelMessage(store: RunStore, input: EditConversationMessageRequest, skipLatestCheck: boolean): EditableConversationMessage {
  const channel = store.getChannel(input.ownerId);
  const message = getChannelMessageView(store, input.messageId);
  if (!channel || !message || message.channelId !== channel.id) {
    throw new HttpError(404, "message_not_found", `Channel message not found: ${input.messageId}`);
  }
  if (message.authorType !== "local-user") {
    throw new HttpError(403, "message_not_owned_by_user", "Only local-user messages can be edited.");
  }
  const resolvedSurface = resolveChannelConversationSurface(store, channel.id, message);
  const surface = resolvedSurface.kind === "root"
    ? "channel_root"
    : resolvedSurface.kind === "branch" || resolvedSurface.kind === "session"
      ? "channel_branch"
      : resolvedSurface.kind === "topic"
        ? "topic_reply"
        : undefined;
  if (!surface || surface !== input.surface) {
    throw new HttpError(409, "surface_owner_mismatch", "The message does not belong to the requested conversation surface.");
  }
  const laneId = message.threadId ?? channel.id;
  const latest = listChannelMessageViews({
    store,
    channelId: channel.id,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    limit: 500,
  })
    .filter((candidate) => candidate.authorType === "local-user" && (message.threadId ? candidate.threadId === message.threadId : !candidate.threadId))
    .at(-1);
  if (!skipLatestCheck && (!latest || latest.id !== message.id)) {
    throw new HttpError(409, "message_not_latest", "Only the latest user message in this channel lane can be edited.");
  }
  const dependencies = resolveMessageExecutionDependencies(store, "channel_message", message.id, message.linkedRunId);
  return {
    surface,
    ownerId: channel.id,
    laneId,
    messageId: message.id,
    current: messageContent(message),
    channel,
    message,
    supersededTurnId: dependencies.turnId,
    supersededRunIds: dependencies.runIds,
    supersededResponseMessageIds: dependencies.responseMessageIds,
  };
}

function resolveTeammateDirectMessage(store: RunStore, input: EditConversationMessageRequest, skipLatestCheck: boolean): EditableConversationMessage {
  const teammate = store.getAiTeammate(input.ownerId);
  const message = store.getTeammateDirectMessage(input.messageId);
  if (!teammate || !message || message.teammateId !== teammate.id) {
    throw new HttpError(404, "message_not_found", `Teammate direct message not found: ${input.messageId}`);
  }
  if (message.authorType !== "local-user") {
    throw new HttpError(403, "message_not_owned_by_user", "Only local-user messages can be edited.");
  }
  const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
  if (!thread || thread.teammateId !== teammate.id) {
    throw new HttpError(409, "surface_owner_mismatch", "The direct message thread does not belong to the selected teammate.");
  }
  const latest = store.listTeammateDirectMessages({ teammateId: teammate.id, threadId: thread.id, limit: 500 })
    .filter((candidate) => candidate.authorType === "local-user")
    .at(-1);
  if (!skipLatestCheck && (!latest || latest.id !== message.id)) {
    throw new HttpError(409, "message_not_latest", "Only the latest user message in this private chat can be edited.");
  }
  const dependencies = resolveMessageExecutionDependencies(store, "teammate_direct_message", message.id, message.linkedRunId);
  return {
    surface: "teammate_direct",
    ownerId: teammate.id,
    laneId: thread.id,
    messageId: message.id,
    current: messageContent(message),
    thread,
    message,
    supersededTurnId: dependencies.turnId,
    supersededRunIds: dependencies.runIds,
    supersededResponseMessageIds: dependencies.responseMessageIds,
  };
}

function resolveMessageExecutionDependencies(
  store: RunStore,
  ownerType: string,
  ownerId: string,
  linkedRunId?: string,
): { readonly runIds: string[]; readonly responseMessageIds: string[]; readonly turnId?: string } {
  const workUnits = store.listWorkUnits({ ownerType, ownerId, limit: 500 });
  const runIds = normalizeStrings([linkedRunId, ...workUnits.map((unit) => unit.linkedRunId)]);
  const responseMessageIds = normalizeStrings(workUnits.map((unit) => unit.linkedMessageId));
  const turnId = runIds.map((runId) => store.getLingTurnForRun(runId)?.id).find(Boolean);
  return { runIds, responseMessageIds, turnId };
}

function validateReplacementReferences(store: RunStore, editable: EditableConversationMessage, input: EditConversationMessageRequest): void {
  const attachmentIds = normalizeStrings(input.attachmentIds ?? []);
  const linkPreviewIds = normalizeStrings(input.linkPreviewIds ?? []);
  if (attachmentIds.length > 10) {
    throw new HttpError(400, "attachment_scope_mismatch", "A conversation message can reference at most 10 attachments.");
  }
  if (editable.surface === "normal_conversation") {
    for (const id of attachmentIds) {
      const attachment = store.getConversationAttachment(id);
      if (!attachment || (attachment.threadId && attachment.threadId !== editable.thread.id)) {
        throw new HttpError(409, "attachment_scope_mismatch", `Conversation attachment belongs to a different thread: ${id}`);
      }
    }
    if (linkPreviewIds.length > 0) {
      throw new HttpError(409, "attachment_scope_mismatch", "Normal conversation link-preview editing is not supported yet.");
    }
    return;
  }
  if (editable.surface === "teammate_direct") {
    for (const id of attachmentIds) {
      const attachment = store.getTeammatePrivateAttachment(id);
      if (!attachment || attachment.teammateId !== editable.ownerId || attachment.threadId !== editable.thread.id) {
        throw new HttpError(409, "attachment_scope_mismatch", `Private attachment belongs to a different thread: ${id}`);
      }
    }
    for (const id of linkPreviewIds) {
      const preview = store.getTeammateDirectLinkPreview(id);
      if (!preview || preview.teammateId !== editable.ownerId || preview.threadId !== editable.thread.id) {
        throw new HttpError(409, "attachment_scope_mismatch", `Private link preview belongs to a different thread: ${id}`);
      }
    }
    assertDirectFileRefsWithinWorkspace({
      thread: editable.thread,
      workspaceCwd: store.paths.cwd,
      workspacePaths: store.paths,
      fileRefs: input.fileRefs ?? [],
    });
    return;
  }
  for (const id of attachmentIds) {
    if (store.getChannelAttachment(id)?.channelId !== editable.channel.id) {
      throw new HttpError(409, "attachment_scope_mismatch", `Channel attachment belongs to a different channel: ${id}`);
    }
  }
  for (const id of linkPreviewIds) {
    if (store.getChannelLinkPreview(id)?.channelId !== editable.channel.id) {
      throw new HttpError(409, "attachment_scope_mismatch", `Channel link preview belongs to a different channel: ${id}`);
    }
  }
}

function interruptSupersededExecutions(store: RunStore, runIds: readonly string[], activeRuns: ActiveRunRegistry): string[] {
  const interrupted: string[] = [];
  for (const runId of runIds) {
    const run = store.getRun(runId);
    if (!run) {
      continue;
    }
    for (const intervention of store.listRunInterventions({ sourceRunId: runId, limit: 500 })) {
      if (intervention.status === "queued" || intervention.status === "cancelling_source" || intervention.status === "starting_continuation") {
        store.cancelRunIntervention(intervention.id, new Date().toISOString(), "source_message_superseded");
      }
      if (intervention.continuationRunId) {
        runControl.cancelRun({
          store,
          runId: intervention.continuationRunId,
          reason: "source_message_superseded",
          activeRun: activeRuns.get(intervention.continuationRunId),
        });
      }
    }
    if (run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval") {
      const cancellation = runControl.cancelRun({
        store,
        runId,
        reason: "source_message_superseded",
        activeRun: activeRuns.get(runId),
      });
      if (cancellation.cancelled) {
        interrupted.push(runId);
      }
    }
  }
  return interrupted;
}

function buildEditResponse(
  revision: ConversationMessageRevision,
  supersession: ReturnType<RunStore["getConversationTurnSupersession"]> extends infer T ? Exclude<T, undefined> : never,
  idempotentReplay: boolean,
): EditConversationMessageResponse {
  return {
    message: {
      id: revision.id,
      surface: revision.surface,
      ownerId: revision.ownerId,
      laneId: revision.laneId,
      messageId: revision.messageId,
      revision: revision.revision,
      body: revision.body,
      mentions: revision.mentions,
      attachmentIds: revision.attachmentIds,
      linkPreviewIds: revision.linkPreviewIds,
      fileRefs: revision.fileRefs,
      createdAt: revision.createdAt,
    },
    supersessionId: supersession.id,
    supersededTurnId: supersession.supersededTurnId,
    replacementTurnId: supersession.replacementTurnId,
    interruptedRunIds: supersession.supersededRunIds,
    supersededResponseMessageIds: supersession.supersededResponseMessageIds,
    preservedWorkspaceChanges: true,
    status: supersession.replacementStatus === "started" ? "replacement_started" : "replacement_pending",
    failureReason: supersession.failureReason,
    idempotentReplay,
  };
}

function findReplacementRevision(
  store: RunStore,
  revisionId: string,
  surface: ConversationRevisionSurfaceKind,
  messageId: string,
): ConversationMessageRevision {
  const revision = store.listConversationMessageRevisions({ surface, messageId }).find((item) => item.id === revisionId);
  if (!revision) {
    throw new Error(`Replacement revision not found: ${revisionId}`);
  }
  return revision;
}

function assertReplayPayloadMatches(input: EditConversationMessageRequest, revision: ConversationMessageRevision): void {
  const replacement = replacementContent(input);
  if (JSON.stringify(replacement) !== JSON.stringify({
    body: revision.body,
    mentions: revision.mentions,
    attachmentIds: revision.attachmentIds,
    linkPreviewIds: revision.linkPreviewIds,
    fileRefs: revision.fileRefs,
  })) {
    throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was replayed with different edit content.");
  }
}

function replacementContent(input: EditConversationMessageRequest): ConversationMessageRevisionContent {
  return {
    body: input.body.trim(),
    mentions: input.mentions ?? [],
    attachmentIds: normalizeStrings(input.attachmentIds ?? []),
    linkPreviewIds: normalizeStrings(input.linkPreviewIds ?? []),
    fileRefs: input.fileRefs ?? [],
  };
}

function messageContent(message: ChannelMessage | TeammateDirectMessage): ConversationMessageRevisionContent {
  return {
    body: message.body,
    mentions: "mentions" in message ? message.mentions : [],
    attachmentIds: message.attachmentIds,
    linkPreviewIds: message.linkPreviewIds,
    fileRefs: message.fileRefs,
  };
}

function parseEditConversationMessageRequest(value: unknown): EditConversationMessageRequest {
  if (!isRecord(value)) {
    throw new Error("Conversation message edit request must be a JSON object.");
  }
  const surface = readString(value, "surface") as ConversationRevisionSurfaceKind;
  if (!["normal_conversation", "channel_root", "channel_branch", "topic_reply", "teammate_direct"].includes(surface)) {
    throw new Error("surface is not supported for conversation message editing.");
  }
  const expectedRevision = value.expectedRevision;
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
    throw new Error("expectedRevision must be a positive integer.");
  }
  const body = readString(value, "body").trim();
  const attachmentIds = readOptionalStringArray(value, "attachmentIds") ?? [];
  if (!body && attachmentIds.length === 0) {
    throw new Error("body or attachmentIds is required.");
  }
  return {
    surface,
    ownerId: readString(value, "ownerId"),
    messageId: readString(value, "messageId"),
    expectedRevision: Number(expectedRevision),
    body,
    mentions: readOptionalObjectArray(value, "mentions") as EditConversationMessageRequest["mentions"],
    attachmentIds,
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds"),
    fileRefs: readOptionalObjectArray(value, "fileRefs") as EditConversationMessageRequest["fileRefs"],
    providerPresetId: readOptionalString(value, "providerPresetId"),
    permissionPreset: readOptionalString(value, "permissionPreset") as PermissionPreset | undefined,
    permissionConfirmation: readOptionalRecord(value, "permissionConfirmation") as PermissionConfirmation | undefined,
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    idempotencyKey: readString(value, "idempotencyKey"),
  };
}

function readOptionalObjectArray(record: Record<string, unknown>, key: string): readonly Record<string, unknown>[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${key} must be an array of objects.`);
  }
  return value;
}

function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value;
}

function readStringArrayFromRecord(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    return [];
  }
  return normalizeStrings(value[key].filter((item): item is string => typeof item === "string"));
}

function normalConversationMessageId(turn: LingTurn): string {
  return turn.sourceItemId?.startsWith("conversation-user:") ? turn.sourceItemId : `conversation-user:${turn.id}`;
}

function normalizeStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function mapConversationEditError(error: unknown): { readonly statusCode: number; readonly code: string; readonly message: string } {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof ConversationMessageRevisionConflictError) {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  return {
    statusCode: 400,
    code: "bad_request",
    message: error instanceof Error ? error.message : String(error),
  };
}
