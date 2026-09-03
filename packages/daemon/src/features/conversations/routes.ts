import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  createLingTurnId,
  type ConversationAttachment,
  type LingConversationTone,
  type LingThread,
  type LingTurn,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type {
  ConversationAttachmentListResponse,
  ConversationAttachmentMutationResponse,
  ConversationDetailResponse,
  ConversationStreamRequest,
  ConversationTranscriptMessage,
  ConversationTranscriptStatus,
  ConversationWorkspaceFileRefV1,
  AuthorizationMode,
  ChannelMessageFileRef,
  PermissionPreset,
  ResponseLanguagePreference,
  RunThinkingLevel,
  RunTool,
  SessionPermissionMode,
  WorkspaceAccessMode,
} from "@ling-stack/contracts";
import { formatServerCatalogMessage, isSupportedLocale } from "@ling-stack/localization";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import { persistConversationAttachment, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES } from "../channels/attachments.js";
import { responseLanguageInstruction } from "../channels/response-language.js";
import { parseChannelAttachmentRequest, readOptionalChannelMessageFileRefs } from "../channels/schemas.js";
import { buildEffectiveConfigResponse } from "../settings/effective-config.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import { materializeInlineConversationAttachments, type ConversationAttachmentMaterialization } from "./materialization.js";
import { lingConversationToneInstruction } from "./conversation-tone.js";
import { projectConversationActiveReplyTarget } from "./active-reply-target.js";
import { projectTerminalReportDto } from "../channels/terminal-report-routes.js";
import { listExecutionActions } from "../runs/execution-actions.js";
import {
  buildConversationGeneratedMediaProjection,
  runHasConversationGeneratedMedia,
} from "../media/conversation-projection.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededLingTurns,
  filterSupersededTerminalReports,
  projectPendingConversationReplacement,
} from "./supersession-projection.js";
import {
  collectConversationRuntimeProjection,
  projectConversationTurnUserRuntime,
  projectUnboundConversationInterventionMessages,
} from "./runtime-projection.js";

type StartConversationRun = (runRequest: RunRequest, sink: RunExecutionSink) => Promise<string | undefined>;

export async function startConversationReplacementRun(input: {
  readonly store: RunStore;
  readonly workspaceCwd: string;
  readonly thread: LingThread;
  readonly message: string;
  readonly messageId: string;
  readonly attachmentIds: readonly string[];
  readonly providerPresetId?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: import("@ling-stack/core").PermissionConfirmation;
  readonly previousRun?: RunSession;
  readonly runnerRegistry: RunnerRegistry;
  readonly startRun: StartConversationRun;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}): Promise<{ readonly turn: LingTurn; readonly runId?: string }> {
  const now = new Date().toISOString();
  const attachments = input.attachmentIds
    .map((attachmentId) => input.store.getConversationAttachment(attachmentId))
    .filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
  const attachmentMaterializations = await materializeInlineConversationAttachments({
    store: input.store,
    attachments,
    now,
    imageVisionSummarizer: input.imageVisionSummarizer,
  });
  const previousSnapshot = readRecord(input.previousRun?.requestSnapshot);
  const providerPresetId = input.providerPresetId
    ?? input.previousRun?.providerPresetId
    ?? readOptionalRecordString(previousSnapshot, "providerPresetId");
  if (!providerPresetId) {
    throw new HttpError(409, "edit_replacement_start_failed", "No provider preset is available for the replacement conversation run.");
  }
  const effectiveConfig = await buildEffectiveConfigResponse({ cwd: input.workspaceCwd, store: input.store, runnerRegistry: input.runnerRegistry });
  const turn = input.store.createLingTurn({
    threadId: input.thread.id,
    kind: "manual_followup",
    title: conversationTitle(input.message),
    userInstruction: input.message,
    teammateId: LING_AGENT_ID,
    sourceItemId: input.messageId,
    createdByActor: "local-user",
  }, now);
  const streamInput: ConversationStreamRequest = {
    threadId: input.thread.id,
    message: input.message,
    attachmentIds: [...input.attachmentIds],
    projectPath: readOptionalRecordString(previousSnapshot, "projectPath")
      ?? (input.previousRun?.cwd && input.previousRun.cwd !== input.workspaceCwd ? input.previousRun.cwd : undefined),
    providerPresetId,
    thinkingLevel: readThinkingLevel(readOptionalRecordString(previousSnapshot, "thinkingLevel")),
    permissionPreset: input.permissionPreset ?? readPermissionPreset(readOptionalRecordString(previousSnapshot, "permissionPreset")),
    permissionMode: readPermissionMode(readOptionalRecordString(previousSnapshot, "permissionMode")),
    responseLanguage: readResponseLanguagePreference(readOptionalRecordString(previousSnapshot, "responseLanguage")),
    tools: readOptionalStringArray(previousSnapshot, "tools", runTools),
    idempotencyKey: `conversation-replacement:${turn.id}`,
  };
  const runRequest = {
    ...buildConversationRunRequest({
      workspaceCwd: input.workspaceCwd,
      thread: input.thread,
      turn,
      input: streamInput,
      lingConversationTone: effectiveConfig.values.lingConversationTone.value,
      attachments,
      attachmentMaterializations,
    }),
    permissionConfirmation: input.permissionConfirmation,
  };
  const runId = await startRunAndWaitUntilReady(runRequest, input.startRun);
  return { turn, runId };
}

const defaultConversationTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const thinkingLevels: readonly RunThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const runTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const permissionPresets: readonly PermissionPreset[] = ["read_only", "workspace_collaboration", "full_access", "custom"];
const permissionModes: readonly SessionPermissionMode[] = ["ask_everything", "balanced", "workspace_write", "full_access", "custom"];
const authorizationModes: readonly AuthorizationMode[] = ["ask", "smart", "always"];
const workspaceAccessModes: readonly WorkspaceAccessMode[] = ["read_only", "workspace_write", "full_access"];

export async function handleConversationStream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  startRun: StartConversationRun,
  imageVisionSummarizer?: LingImageVisionSummarizer,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for conversation stream` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const workspaceCwd = url.searchParams.get("cwd");
  if (!workspaceCwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const input = parseConversationStreamRequest(await readJsonBody(request, config.maxBodyBytes));
    const store = storeRegistry.getStore(workspaceCwd);
    const now = new Date().toISOString();
    const thread = resolveConversationThread(store, input, now);
    const turnInstruction = input.message.trim() || "User attached files.";
    const turnId = createLingTurnId();
    const userItemId = `conversation-user:${turnId}`;
    const turn = store.createLingTurn({
      id: turnId,
      threadId: thread.id,
      kind: thread.metadata?.lastTurnId ? "manual_followup" : "initial_request",
      title: conversationTitle(turnInstruction),
      userInstruction: turnInstruction,
      teammateId: LING_AGENT_ID,
      sourceItemId: userItemId,
      createdByActor: "local-user",
    }, now);
    const conversationAttachments = assignConversationAttachments(store, input.attachmentIds ?? [], thread.id, turn.id);
    persistConversationUserItem(store, thread, turn, conversationAttachments, input.fileRefs ?? [], now);
    const attachmentMaterializations = await materializeInlineConversationAttachments({
      store,
      attachments: conversationAttachments,
      now,
      imageVisionSummarizer,
    });
    const effectiveConfig = await buildEffectiveConfigResponse({ cwd: workspaceCwd, store, runnerRegistry });
    const userMessage = createUserTranscriptMessage(thread, turn, conversationAttachments, input.fileRefs ?? []);
    let assistantMessage = createAssistantTranscriptMessage(thread, turn, undefined, "", "running", now);
    let runId = "";
    let closed = false;

    response.on("close", () => {
      closed = true;
    });
    const safeWrite = (event: string, data: unknown): void => {
      if (!closed && !response.destroyed) {
        writeSse(response, event, data);
      }
    };
    const streamSink: RunExecutionSink = {
      kind: "sse",
      onClose(listener) {
        response.on("close", listener);
      },
      isClosed() {
        return closed || response.destroyed;
      },
      writeReady(data) {
        const ready = data as { readonly runId?: unknown };
        if (typeof ready.runId === "string") {
          runId = ready.runId;
          assistantMessage = { ...assistantMessage, runId };
        }
        const activeReply = projectConversationActiveReplyTarget({
          store,
          runId: runId || undefined,
          threadId: thread.id,
          teammateId: LING_AGENT_ID,
        });
        safeWrite("ready", {
          thread,
          turn,
          userMessage,
          assistantMessage,
          runId: runId || undefined,
          ...(activeReply ? { activeReply } : {}),
        });
      },
      writeEvent(_event, data) {
        const envelope = data as RunEventEnvelope;
        if (envelope.type === "assistant_text_delta") {
          assistantMessage = {
            ...assistantMessage,
            content: assistantMessage.content + readEventText(envelope),
            status: "running",
            updatedAt: envelope.ts,
          };
        } else if (
          envelope.type === "message_end" &&
          readEventRole(envelope) === "assistant" &&
          !assistantMessage.content.trim()
        ) {
          assistantMessage = {
            ...assistantMessage,
            content: readEventText(envelope),
            status: "running",
            updatedAt: envelope.ts,
          };
        } else if (envelope.type === "run_error") {
          const errorMessage = readEventError(envelope);
          assistantMessage = {
            ...assistantMessage,
            content: assistantMessage.content || conversationRunFailedContent(input.responseLanguage, input.message),
            ...(errorMessage ? { errorMessage } : {}),
            status: "failed",
            updatedAt: envelope.ts,
          };
        } else if (envelope.type === "run_cancelled") {
          assistantMessage = {
            ...assistantMessage,
            status: "cancelled",
            updatedAt: envelope.ts,
          };
        }
        safeWrite("run_event", {
          threadId: thread.id,
          turnId: turn.id,
          runId: runId || envelope.runId,
          event: envelope,
          assistantMessage,
        });
      },
      writeError(_statusCode, body) {
        const message = readErrorBodyMessage(body, input.responseLanguage, input.message);
        assistantMessage = {
          ...assistantMessage,
          content: assistantMessage.content || conversationRunFailedContent(input.responseLanguage, input.message),
          errorMessage: message,
          status: "failed",
          updatedAt: new Date().toISOString(),
        };
        safeWrite("error", { thread, turn, assistantMessage, error: message });
      },
      end() {
        const latestRun = runId ? store.getRun(runId) : undefined;
        const latestThread = store.getLingThread(thread.id) ?? thread;
        const latestTurn = store.getLingTurn(turn.id) ?? turn;
        const terminalStatus = statusFromRun(latestRun) ?? assistantMessage.status;
        const hasGeneratedMedia = runHasConversationGeneratedMedia(store, runId || undefined);
        const finalStatus = terminalStatus === "succeeded" && !assistantMessage.content.trim() && !hasGeneratedMedia
          ? "failed"
          : terminalStatus;
        const finalAssistant = {
          ...assistantMessage,
          status: finalStatus,
          content: assistantMessage.content || (terminalStatus === "succeeded" && hasGeneratedMedia
            ? ""
            : fallbackAssistantContent(terminalStatus, input.responseLanguage, input.message)),
          ...(assistantMessage.errorMessage || latestRun?.errorMessage
            ? { errorMessage: assistantMessage.errorMessage ?? latestRun?.errorMessage ?? undefined }
            : {}),
          updatedAt: latestRun?.updatedAt ?? new Date().toISOString(),
        };
        if (latestRun && (terminalStatus === "succeeded" || terminalStatus === "cancelled")) {
          safeWrite("done", { thread: latestThread, turn: latestTurn, run: latestRun, assistantMessage: finalAssistant });
        } else {
          safeWrite("blocked", {
            thread: latestThread,
            turn: latestTurn,
            run: latestRun,
            assistantMessage: finalAssistant,
            error: finalAssistant.errorMessage || latestRun?.errorMessage || finalAssistant.content,
          });
        }
        if (!closed) {
          response.end();
        }
      },
    };

    writeSseHead(response);
    safeWrite("ready", { thread, turn, userMessage, assistantMessage });
    const runRequest = buildConversationRunRequest({
      workspaceCwd,
      thread,
      turn,
      input,
      lingConversationTone: effectiveConfig.values.lingConversationTone.value,
      attachments: conversationAttachments,
      attachmentMaterializations,
    });
    await startRun(runRequest, streamSink);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleConversationAttachmentsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const threadId = url.searchParams.get("threadId")?.trim() || undefined;
    if (threadId) {
      assertConversationThread(store, threadId);
    }

    if (request.method === "GET") {
      const body: ConversationAttachmentListResponse = {
        cwd,
        threadId,
        attachments: store.listConversationAttachments({
          threadId,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      };
      writeJson(response, 200, body);
      return;
    }

    if (request.method === "POST") {
      const rawBody = await readJsonBody(request, Math.max(config.maxBodyBytes, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES));
      const input = parseChannelAttachmentRequest(rawBody);
      const requestedThreadId = readOptionalString(readRecord(rawBody), "threadId")?.trim() || threadId;
      if (requestedThreadId) {
        assertConversationThread(store, requestedThreadId);
      }
      const attachment = persistConversationAttachment(store, {
        ...input,
        threadId: requestedThreadId,
      });
      const body: ConversationAttachmentMutationResponse = { attachment };
      writeJson(response, 201, body);
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for conversation attachments` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleConversationDetail(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread || thread.kind !== "conversation") {
      writeJson(response, 404, { error: "conversation_not_found", message: `Conversation not found: ${threadId}` });
      return;
    }
    writeJson(response, 200, buildConversationDetail(store, cwd, thread, {
      includeSuperseded: url.searchParams.get("includeSuperseded") === "true",
    }));
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildConversationDetail(
  store: RunStore,
  cwd: string,
  thread: LingThread,
  options: { readonly includeSuperseded?: boolean } = {},
): ConversationDetailResponse {
  const projection = buildConversationSupersessionProjection(store, {
    surfaces: ["normal_conversation"],
    ownerId: thread.id,
  });
  const storedTurns = store.listLingTurns({ threadId: thread.id, limit: 200 });
  const turns = [...(options.includeSuperseded ? storedTurns : filterSupersededLingTurns(storedTurns, projection))]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const runLinks = turns.flatMap((turn) => store.listLingTurnRuns(turn.id));
  const runs = runLinks
    .map((link) => store.getRun(link.runId))
    .filter((run): run is RunSession => Boolean(run))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const runtimeProjection = collectConversationRuntimeProjection(store, runs);
  const runByTurnId = new Map(runLinks.map((link) => [link.turnId, store.getRun(link.runId)]));
  const messages = turns.flatMap((turn) => {
    const run = runByTurnId.get(turn.id);
    const turnRuntime = projectConversationTurnUserRuntime({
      store,
      turn,
      run,
      intervention: turn.interventionId ? runtimeProjection.interventionById.get(turn.interventionId) : undefined,
    });
    const rawUser = createUserTranscriptMessage(
      thread,
      turn,
      turnRuntime.attachments,
      turnRuntime.fileRefs,
      turnRuntime.content,
    );
    const latestRevision = store.listConversationMessageRevisions({
      surface: "normal_conversation",
      messageId: rawUser.id,
    }).at(-1);
    const user = latestRevision ? {
      ...rawUser,
      content: latestRevision.body,
      revision: latestRevision.revision,
      editedAt: latestRevision.revision > 1 ? latestRevision.createdAt : undefined,
      pendingReplacement: projectPendingConversationReplacement(store, "normal_conversation", rawUser.id),
    } : { ...rawUser, revision: 1 };
    return run ? [user, assistantMessageFromRun(store, thread, turn, run)] : [user];
  });
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const pendingSupersessionByMessage = new Map<string, ReturnType<RunStore["listConversationTurnSupersessions"]>[number]>();
  for (const supersession of store.listConversationTurnSupersessions({
    surface: "normal_conversation",
    ownerId: thread.id,
    replacementStatus: "pending",
    limit: 200,
  })) {
    if (!pendingSupersessionByMessage.has(supersession.messageId)) {
      pendingSupersessionByMessage.set(supersession.messageId, supersession);
    }
  }
  for (const supersession of pendingSupersessionByMessage.values()) {
    const sourceTurn = supersession.supersededTurnId
      ? storedTurns.find((turn) => turn.id === supersession.supersededTurnId)
      : undefined;
    const revision = store.listConversationMessageRevisions({
      surface: "normal_conversation",
      messageId: supersession.messageId,
    }).find((candidate) => candidate.id === supersession.replacementRevisionId);
    if (!sourceTurn || !revision) {
      continue;
    }
    const sourceRun = store.listLingTurnRuns(sourceTurn.id)
      .map((link) => store.getRun(link.runId))
      .filter((run): run is RunSession => Boolean(run))
      .at(-1);
    const rawUser = createUserTranscriptMessage(thread, sourceTurn, conversationAttachmentsFromRunSnapshot(store, sourceRun));
    messageById.set(rawUser.id, {
      ...rawUser,
      content: revision.body,
      status: "succeeded",
      revision: revision.revision,
      editedAt: revision.createdAt,
      pendingReplacement: projectPendingConversationReplacement(store, "normal_conversation", rawUser.id),
      updatedAt: revision.createdAt,
    });
  }
  for (const message of projectUnboundConversationInterventionMessages({
    store,
    thread,
    runs,
    interventions: runtimeProjection.interventions,
    existingMessageIds: new Set(messageById.keys()),
  })) {
    messageById.set(message.id, message);
  }
  const latestRun = runs[runs.length - 1];
  const latestSnapshot = readRecord(latestRun?.requestSnapshot);
  const latestProjectPath = latestRun?.cwd && latestRun.cwd !== cwd ? latestRun.cwd : undefined;
  const conversationItems = listAllConversationItems(store, thread.id, !options.includeSuperseded);
  return {
    cwd,
    thread,
    turns,
    conversationItems,
    runLinks,
    runs,
    executionActions: listExecutionActions(store, { threadId: thread.id, limit: 500 }),
    approvals: runtimeProjection.approvals,
    interventions: runtimeProjection.interventions,
    terminalReports: (options.includeSuperseded
      ? store.listTerminalReports({ threadId: thread.id, limit: 200 })
      : filterSupersededTerminalReports(store.listTerminalReports({ threadId: thread.id, limit: 200 }), projection))
      .filter((record) => Boolean(record.report) && (record.status === "committed" || record.status === "fallback"))
      .flatMap((record) => record.resultItemId
        ? [{
            ...projectTerminalReportDto(record.report!),
            generation: record.generation,
            resultItemId: record.resultItemId,
          }]
        : []),
    artifacts: runs.flatMap((run) => store.listArtifacts(run.id)),
    plans: store.listProposedPlanArtifacts({ threadId: thread.id, limit: 200 }),
    compactionCheckpoints: store.listCompactionCheckpoints({ threadId: thread.id, limit: 100 }),
    contextSnapshots: store.listConversationContextSnapshots({ threadId: thread.id, limit: 100 }),
    contextSummaries: store.listConversationContextSummaries({
      threadId: thread.id,
      statuses: ["active", "superseded", "invalidated"],
      limit: 200,
    }),
    messages: [...messageById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    generatedMedia: buildConversationGeneratedMediaProjection({
      store,
      runIds: runs.map((run) => run.id),
    }),
    defaults: {
      projectPath: readOptionalRecordString(latestSnapshot, "projectPath") || latestProjectPath,
      providerPresetId: latestRun?.providerPresetId ?? readOptionalRecordString(latestSnapshot, "providerPresetId"),
      thinkingLevel: readThinkingLevel(readOptionalRecordString(latestSnapshot, "thinkingLevel")),
      authorizationMode: readAuthorizationMode(readOptionalRecordString(latestSnapshot, "authorizationMode")),
      workspaceAccessMode: readWorkspaceAccessMode(readOptionalRecordString(latestSnapshot, "workspaceAccessMode")),
      permissionPreset: readPermissionPreset(readOptionalRecordString(latestSnapshot, "permissionPreset")),
      permissionMode: readPermissionMode(readOptionalRecordString(latestSnapshot, "permissionMode")),
    },
  };
}

/**
 * Read the complete canonical item line without imposing the UI's page size on
 * history. The SQLite store pages newest-first; this helper reverses each page
 * through the store contract and returns one source-ordered list. No timestamp
 * or array-arrival order is used as a fallback authority.
 */
function listAllConversationItems(
  store: RunStore,
  threadId: string,
  effectiveOnly: boolean,
): readonly import("@ling-stack/contracts").ConversationItemV1[] {
  const items: import("@ling-stack/contracts").ConversationItemV1[] = [];
  let beforeSequence = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = store.listConversationItemsPage({
      threadId,
      beforeSequence,
      effectiveOnly,
      limit: 500,
    });
    for (const item of page.items) {
      items.push(item);
    }
    const next = page.nextBeforeSequence;
    if (next === undefined || next >= beforeSequence) break;
    beforeSequence = next;
  }
  return items.sort((left, right) => left.sequence - right.sequence);
}

function parseConversationStreamRequest(value: unknown): ConversationStreamRequest {
  if (!isRecord(value)) {
    throw new Error("Conversation request must be a JSON object.");
  }
  const message = readString(value, "message").trim();
  const attachmentIds = readOptionalStringArray(value, "attachmentIds") ?? [];
  const fileRefs = readOptionalChannelMessageFileRefs(value, "fileRefs") ?? [];
  if (!message && attachmentIds.length === 0 && fileRefs.length === 0) {
    throw new Error("message, attachmentIds, or fileRefs is required.");
  }
  if (attachmentIds.length > 10) {
    throw new Error("A conversation message can reference at most 10 attachments.");
  }
  const providerPresetId = readString(value, "providerPresetId").trim();
  if (!providerPresetId) {
    throw new Error("providerPresetId is required.");
  }
  return {
    threadId: readOptionalString(value, "threadId")?.trim() || undefined,
    message,
    attachmentIds: normalizeStringList(attachmentIds),
    fileRefs,
    projectPath: readOptionalString(value, "projectPath")?.trim() || undefined,
    providerPresetId,
    thinkingLevel: readThinkingLevel(readOptionalString(value, "thinkingLevel")),
    authorizationMode: readAuthorizationMode(readOptionalString(value, "authorizationMode")),
    workspaceAccessMode: readWorkspaceAccessMode(readOptionalString(value, "workspaceAccessMode")),
    permissionPreset: readPermissionPreset(readOptionalString(value, "permissionPreset")),
    permissionMode: readPermissionMode(readOptionalString(value, "permissionMode")),
    permissionConfirmation: readPermissionConfirmation(value.permissionConfirmation),
    responseLanguage: readResponseLanguagePreference(readOptionalString(value, "responseLanguage")),
    tools: readOptionalStringArray(value, "tools", runTools),
    idempotencyKey: readOptionalString(value, "idempotencyKey")?.trim() || undefined,
  };
}

function resolveConversationThread(store: RunStore, input: ConversationStreamRequest, now: string): LingThread {
  if (input.threadId) {
    const thread = store.getLingThread(input.threadId);
    if (!thread || thread.kind !== "conversation") {
      throw new HttpError(404, "conversation_not_found", `Conversation not found: ${input.threadId}`);
    }
    if (thread.status === "archived" || thread.archivedAt) {
      throw new HttpError(409, "conversation_archived", `Conversation is archived: ${thread.id}`);
    }
    return thread;
  }
  return store.createLingThread({
    kind: "conversation",
    teammateId: LING_AGENT_ID,
    title: conversationTitle(input.message),
    objective: input.message.trim(),
    status: "open",
  }, now);
}

function buildConversationRunRequest(input: {
  readonly workspaceCwd: string;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly input: ConversationStreamRequest;
  readonly lingConversationTone: LingConversationTone;
  readonly attachments: readonly ConversationAttachment[];
  readonly attachmentMaterializations: ReadonlyMap<string, ConversationAttachmentMaterialization>;
}): RunRequest {
  const toneInstruction = lingConversationToneInstruction(input.lingConversationTone);
  const responseLanguagePreference = input.input.responseLanguage ?? "follow_user";
  const responseLanguage = resolveConversationResponseLanguage(
    responseLanguagePreference,
    input.input.message,
  );
  const appendSystemPrompt = [
    toneInstruction,
    responseLanguageInstruction(responseLanguagePreference),
  ].filter((instruction) => instruction.trim());
  return {
    workspaceCwd: input.workspaceCwd,
    cwd: input.input.projectPath || input.workspaceCwd,
    task: {
      id: conversationRunTaskId(input.turn.id),
      title: input.turn.title,
      prompt: buildConversationRunPrompt(
        input.input.message,
        input.attachments,
        input.attachmentMaterializations,
        input.input.fileRefs ?? [],
      ),
    },
    threadId: input.thread.id,
    turnId: input.turn.id,
    teammateId: LING_AGENT_ID,
    createdByActor: input.turn.createdByActor,
    providerPresetId: input.input.providerPresetId,
    tools: input.input.tools ?? defaultConversationTools,
    authorizationMode: input.input.authorizationMode,
    workspaceAccessMode: input.input.workspaceAccessMode,
    permissionPreset: input.input.permissionPreset,
    permissionMode: input.input.permissionMode,
    permissionConfirmation: input.input.permissionConfirmation,
    thinkingLevel: input.input.thinkingLevel,
    lingConversationTone: input.lingConversationTone,
    responseLanguage,
    appendSystemPrompt,
    conversationAttachmentIds: input.attachments.map((attachment) => attachment.id),
    conversationFileRefs: input.input.fileRefs ?? [],
    idempotencyKey: input.input.idempotencyKey ?? `conversation:${input.turn.id}`,
  };
}

function createUserTranscriptMessage(
  thread: LingThread,
  turn: LingTurn,
  attachments: readonly ConversationAttachment[] = [],
  fileRefs: readonly ChannelMessageFileRef[] = [],
  content = turn.userInstruction,
): ConversationTranscriptMessage {
  return {
    id: turn.sourceItemId?.startsWith("conversation-user:") ? turn.sourceItemId : `conversation-user:${turn.id}`,
    role: "user",
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(fileRefs.length > 0 ? { fileRefs } : {}),
    status: statusFromTurn(turn),
    threadId: thread.id,
    turnId: turn.id,
    revision: 1,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

/**
 * Give normal-conversation runs a durable ConversationItem anchor before the
 * first tool event is emitted. The existing transcript DTO remains unchanged
 * for this slice, but execution actions can now point back to a real SQLite
 * item instead of inventing a UI-only source reference.
 */
function persistConversationUserItem(
  store: RunStore,
  thread: LingThread,
  turn: LingTurn,
  attachments: readonly ConversationAttachment[],
  fileRefs: readonly ChannelMessageFileRef[],
  now: string,
): void {
  const itemId = turn.sourceItemId?.trim();
  if (!itemId || !itemId.startsWith("conversation-user:")) {
    return;
  }
  const existing = store.getConversationItem(itemId);
  if (existing) {
    if (existing.threadId !== thread.id || existing.turnId !== turn.id || existing.kind !== "user_message") {
      throw new Error(`Conversation user item anchor does not match turn: ${itemId}`);
    }
    return;
  }
  const canonicalFileRefs: ConversationWorkspaceFileRefV1[] = fileRefs.map((fileRef) => ({
    path: fileRef.path,
    ...(fileRef.label ? { label: fileRef.label } : {}),
    source: "explicit_text",
    ...(fileRef.line !== undefined ? { line: fileRef.line } : {}),
  }));
  store.appendConversationItem({
    id: itemId,
    threadId: thread.id,
    turnId: turn.id,
    kind: "user_message",
    status: "committed",
    actorType: "local_user",
    visibility: thread.channelId ? "channel" : "thread_participants",
    payload: {
      body: turn.userInstruction,
      format: "markdown",
      mentions: [],
      attachmentIds: attachments.map((attachment) => attachment.id),
      linkPreviewIds: [],
      fileRefs: canonicalFileRefs,
    },
    domainRefs: [{ type: "turn", id: turn.id }],
  }, now);
}

function createAssistantTranscriptMessage(
  thread: LingThread,
  turn: LingTurn,
  run: RunSession | undefined,
  content: string,
  status: ConversationTranscriptStatus,
  now: string,
  errorMessage?: string,
): ConversationTranscriptMessage {
  return {
    id: conversationAssistantMessageId(turn.id),
    role: "assistant",
    authorId: LING_AGENT_ID,
    authorLabel: "Ling Agent",
    content,
    ...(errorMessage ? { errorMessage } : {}),
    status,
    threadId: thread.id,
    turnId: turn.id,
    runId: run?.id,
    createdAt: run?.createdAt ?? now,
    updatedAt: run?.updatedAt ?? now,
  };
}

function assistantMessageFromRun(store: RunStore, thread: LingThread, turn: LingTurn, run: RunSession): ConversationTranscriptMessage {
  const events = store.listEvents(run.id, { limit: 1000 });
  const streamedContent = events.filter((event) => event.type === "assistant_text_delta").map(readEventText).join("");
  const finalContent = [...events]
    .reverse()
    .find((event) => event.type === "message_end" && readEventRole(event) === "assistant" && readEventText(event).trim());
  const content = streamedContent || (finalContent ? readEventText(finalContent) : "");
  const error = [...events].reverse().map(readEventError).find(Boolean);
  const status = statusFromRun(run) ?? "running";
  const hasGeneratedMedia = runHasConversationGeneratedMedia(store, run.id);
  const projectedStatus = status === "succeeded" && !content.trim() && !hasGeneratedMedia ? "failed" : status;
  const requestSnapshot = readRecord(run.requestSnapshot);
  const responseLanguage = readResponseLanguagePreference(readOptionalRecordString(requestSnapshot, "responseLanguage"));
  return createAssistantTranscriptMessage(
    thread,
    turn,
    run,
    content || (status === "succeeded" && hasGeneratedMedia
      ? ""
      : fallbackAssistantContent(status, responseLanguage, turn.userInstruction)),
    projectedStatus,
    run.updatedAt,
    error,
  );
}

function statusFromTurn(turn: LingTurn): ConversationTranscriptStatus {
  if (turn.status === "failed") {
    return "failed";
  }
  if (turn.status === "blocked" || turn.status === "waiting_for_approval") {
    return "blocked";
  }
  if (turn.status === "cancelled" || turn.status === "superseded") {
    return "cancelled";
  }
  if (turn.status === "running") {
    return "running";
  }
  return "succeeded";
}

function statusFromRun(run: RunSession | undefined): ConversationTranscriptStatus | undefined {
  if (!run) {
    return undefined;
  }
  if (run.status === "failed") {
    return "failed";
  }
  if (run.status === "waiting_for_approval") {
    return "blocked";
  }
  if (run.status === "cancelled") {
    return "cancelled";
  }
  if (run.status === "queued" || run.status === "running") {
    return "running";
  }
  return "succeeded";
}

function conversationTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine || "New conversation";
}

function conversationRunTaskId(turnId: string): string {
  return `conversation:${turnId}`;
}

function conversationAssistantMessageId(turnId: string): string {
  return `conversation-assistant:${turnId}`;
}

function readEventText(event: RunEventEnvelope): string {
  return readOptionalRecordString(readRecord(event.data), "text") ?? "";
}

function readEventRole(event: RunEventEnvelope): string {
  return readOptionalRecordString(readRecord(event.data), "role") ?? "";
}

function readEventError(event: RunEventEnvelope): string {
  const data = readRecord(event.data);
  return readOptionalRecordString(data, "message") || readOptionalRecordString(data, "errorMessage") || readOptionalRecordString(data, "error") || "";
}

function readErrorBodyMessage(body: unknown, responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return readOptionalRecordString(readRecord(body), "message") || conversationRunFailedBeforeStartContent(responseLanguage, message);
}

function fallbackAssistantContent(status: ConversationTranscriptStatus, responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  if (status === "running") {
    return "";
  }
  const language = resolveConversationResponseLanguage(responseLanguage, message);
  if (status === "cancelled") {
    return formatServerCatalogMessage(language, "daemon.conversation.cancelled");
  }
  if (status === "succeeded") {
    return formatServerCatalogMessage(language, "daemon.conversation.empty_result");
  }
  return conversationRunFailedContent(responseLanguage, message);
}

function conversationRunFailedContent(responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return formatServerCatalogMessage(
    resolveConversationResponseLanguage(responseLanguage, message),
    "daemon.conversation.failed",
  );
}

function conversationRunFailedBeforeStartContent(responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return formatServerCatalogMessage(
    resolveConversationResponseLanguage(responseLanguage, message),
    "daemon.conversation.failed_before_start",
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readThinkingLevel(value: string | undefined): RunThinkingLevel | undefined {
  return value && thinkingLevels.includes(value as RunThinkingLevel) ? value as RunThinkingLevel : undefined;
}

function readPermissionPreset(value: string | undefined): PermissionPreset | undefined {
  return value && permissionPresets.includes(value as PermissionPreset) ? value as PermissionPreset : undefined;
}

function readPermissionMode(value: string | undefined): SessionPermissionMode | undefined {
  return value && permissionModes.includes(value as SessionPermissionMode) ? value as SessionPermissionMode : undefined;
}

function readAuthorizationMode(value: string | undefined): AuthorizationMode | undefined {
  return value && authorizationModes.includes(value as AuthorizationMode) ? value as AuthorizationMode : undefined;
}

function readWorkspaceAccessMode(value: string | undefined): WorkspaceAccessMode | undefined {
  return value && workspaceAccessModes.includes(value as WorkspaceAccessMode) ? value as WorkspaceAccessMode : undefined;
}

function readPermissionConfirmation(value: unknown): ConversationStreamRequest["permissionConfirmation"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("permissionConfirmation must be an object");
  }
  const mode = readString(value, "mode");
  const confirmed = value.confirmed;
  const confirmedAt = readString(value, "confirmedAt");
  const reason = readString(value, "reason");
  if (mode !== "full_access" || confirmed !== true || !reason.trim() || Number.isNaN(Date.parse(confirmedAt))) {
    throw new Error("permissionConfirmation must contain a valid full access confirmation");
  }
  return { mode: "full_access", confirmed: true, confirmedAt, reason };
}

function readResponseLanguagePreference(value: string | undefined): ResponseLanguagePreference | undefined {
  return value === "follow_user" || isSupportedLocale(value) ? value : undefined;
}

function resolveConversationResponseLanguage(
  responseLanguage: ResponseLanguagePreference | undefined,
  _message: string,
): Exclude<ResponseLanguagePreference, "follow_user"> {
  return responseLanguage && responseLanguage !== "follow_user" ? responseLanguage : "en-US";
}

function buildConversationRunPrompt(
  message: string,
  attachments: readonly ConversationAttachment[],
  materializations: ReadonlyMap<string, ConversationAttachmentMaterialization>,
  fileRefs: readonly ChannelMessageFileRef[],
): string {
  const trimmedMessage = message.trim();
  const parts = [
    trimmedMessage || "User attached files.",
    renderConversationAttachmentsForPrompt(attachments, materializations),
    renderConversationFileRefsForPrompt(fileRefs),
  ].filter((part) => part.trim());
  return parts.join("\n\n");
}

function renderConversationFileRefsForPrompt(fileRefs: readonly ChannelMessageFileRef[]): string {
  if (fileRefs.length === 0) {
    return "";
  }
  return [
    "Workspace file references:",
    ...fileRefs.map((fileRef, index) => `- ${index + 1}. ${fileRef.label ? `${fileRef.label}: ` : ""}${fileRef.path}${fileRef.line ? `:${fileRef.line}` : ""}`),
    "Treat these as user-supplied references only. Existing workspace and approval policy still controls access.",
  ].join("\n");
}

function renderConversationAttachmentsForPrompt(
  attachments: readonly ConversationAttachment[],
  materializations: ReadonlyMap<string, ConversationAttachmentMaterialization>,
): string {
  if (attachments.length === 0) {
    return "";
  }
  return [
    "Attached files:",
    ...attachments.map((attachment, index) => {
      const materialization = materializations.get(attachment.id);
      const header = `- ${index + 1}. ${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${attachment.sizeBytes} bytes, materialization=${materialization?.status ?? "metadata_only"})`;
      if (materialization?.status === "available" && materialization.contentText?.trim()) {
        return `${header}\n  Content${materialization.truncated ? " (truncated)" : ""}:\n${indentAttachmentContent(materialization.contentText)}`;
      }
      return header;
    }),
    "Use only the listed attachment content. Do not infer unseen file contents.",
  ].join("\n");
}

function indentAttachmentContent(content: string): string {
  return content.trim().split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function assignConversationAttachments(
  store: RunStore,
  attachmentIds: readonly string[],
  threadId: string,
  turnId: string,
): ConversationAttachment[] {
  return normalizeStringList(attachmentIds).map((attachmentId) => {
    const existing = store.getConversationAttachment(attachmentId);
    if (!existing) {
      throw new HttpError(404, "conversation_attachment_not_found", `Conversation attachment not found: ${attachmentId}`);
    }
    if (existing.threadId && existing.threadId !== threadId) {
      throw new HttpError(409, "conversation_attachment_thread_mismatch", `Conversation attachment belongs to a different thread: ${attachmentId}`);
    }
    if (existing.turnId && existing.turnId !== turnId) {
      throw new HttpError(409, "conversation_attachment_already_used", `Conversation attachment was already used: ${attachmentId}`);
    }
    const assigned = store.assignConversationAttachment({ attachmentId, threadId, turnId });
    if (!assigned) {
      throw new HttpError(404, "conversation_attachment_not_found", `Conversation attachment not found: ${attachmentId}`);
    }
    return assigned;
  });
}

function conversationAttachmentsFromRunSnapshot(store: RunStore, run: RunSession | undefined): readonly ConversationAttachment[] {
  const snapshot = readRecord(run?.requestSnapshot);
  const attachmentIds = readOptionalStringArray(snapshot, "conversationAttachmentIds") ?? readOptionalStringArray(snapshot, "attachmentIds") ?? [];
  return normalizeStringList(attachmentIds)
    .map((attachmentId) => store.getConversationAttachment(attachmentId))
    .filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
}

function assertConversationThread(store: RunStore, threadId: string): void {
  const thread = store.getLingThread(threadId);
  if (!thread || thread.kind !== "conversation") {
    throw new HttpError(404, "conversation_not_found", `Conversation not found: ${threadId}`);
  }
}

function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function startRunAndWaitUntilReady(runRequest: RunRequest, startRun: StartConversationRun): Promise<string | undefined> {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<string | undefined>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };
    const sink: RunExecutionSink = {
      kind: "detached",
      onClose() {},
      isClosed() {
        return false;
      },
      writeReady(data) {
        const runId = isRecord(data) && typeof data.runId === "string" ? data.runId : undefined;
        finish(() => resolve(runId));
      },
      writeEvent() {},
      writeError(_statusCode, body) {
        const message = readOptionalRecordString(readRecord(body), "message") ?? "Replacement run failed before start.";
        finish(() => reject(new Error(message)));
      },
      end() {
        finish(() => reject(new Error("Replacement run ended before it became ready.")));
      },
    };
    timeout = setTimeout(() => finish(() => reject(new Error("Timed out waiting for replacement run readiness."))), 15_000);
    void startRun(runRequest, sink).catch((error) => {
      finish(() => reject(error));
    });
  });
  return await ready;
}
