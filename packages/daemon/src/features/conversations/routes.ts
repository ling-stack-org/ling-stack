import type { IncomingMessage, ServerResponse } from "node:http";
import { projectConversationUserInputs } from "./user-input-transcript.js";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
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
import { parseChannelAttachmentRequest, readOptionalChannelMessageFileRefs } from "../channels/schemas.js";
import { buildEffectiveConfigResponse } from "../settings/effective-config.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import { materializeInlineConversationAttachments, type ConversationAttachmentMaterialization } from "./materialization.js";
import { projectConversationActiveReplyTarget } from "./active-reply-target.js";
import { projectNormalExecutionContextSnapshots } from "./normal-execution-context-snapshots.js";
import { ConversationNarrationAccumulator } from "./narration-segments.js";
import { createOwnedRunNarrationAccumulator } from "./narration-owner.js";
import { prepareNormalConversationInput } from "./normal-conversation-input.js";
import { normalSubmissionThreadId, readConversationSubmission } from "./submission-receipts.js";
import { saveNormalConversationPreparedRequest } from "./normal-conversation-prepared-request.js";
import { buildConversationRunRequest, resolveConversationResponseLanguage } from "./conversation-run-request.js";
export { resolveConversationResponseLanguage } from "./conversation-run-request.js";
import { resolveConversationExecutionSelection, inheritConversationExecutionSelection } from "./conversation-execution-selection.js";
import { parseExecutionBindingRequest } from "@ling-stack/contracts";
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
  projectConversationSupersessionTombstones,
  projectPendingConversationReplacement,
} from "./supersession-projection.js";
import {
  collectConversationRuntimeProjection,
  projectConversationTurnUserRuntime,
  projectUnboundConversationInterventionMessages,
} from "./runtime-projection.js";
import { projectConversationReasoningSummaries } from "./reasoning-summary-projection.js";
import { projectConversationArtifacts } from "../runs/public-artifacts.js";

type StartConversationRun = (runRequest: RunRequest, sink: RunExecutionSink) => Promise<string | undefined>;

export async function startConversationReplacementRun(input: {
  readonly store: RunStore;
  readonly workspaceCwd: string;
  readonly thread: LingThread;
  readonly message: string;
  readonly messageId: string;
  readonly revisionId: string;
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
  const previousSnapshot = readRecord(input.previousRun?.requestSnapshot);
  const revision = input.store.listConversationMessageRevisions({ surface: "normal_conversation", messageId: input.messageId })
    .find((revision) => revision.id === input.revisionId);
  if (!revision || revision.ownerId !== input.thread.id || revision.body !== input.message ||
    JSON.stringify(revision.attachmentIds) !== JSON.stringify(input.attachmentIds)) {
    throw new HttpError(409, "edit_replacement_source_mismatch", "Replacement preparation requires its committed message revision.");
  }
  const replacementKey = `message-edit:${revision.id}`;
  const existingInput = input.store.getConversationItemByIdempotencyKey(input.thread.id,
    `normal-conversation:${input.thread.id}:${replacementKey}`);
  // New replacements require a selection before creating a canonical turn.
  // Accepted replacements retain their persisted replay even after revocation.
  const selection = existingInput ? undefined
    : inheritConversationExecutionSelection(input.store, input.runnerRegistry, input.previousRun, input.providerPresetId);
  const replacementSource = input.previousRun ? input.store.getLingTurnForRun(input.previousRun.id)
    : input.store.getConversationItem(input.messageId)?.turnId;
  const prepared = prepareNormalConversationInput({ store: input.store, thread: input.thread, message: input.message,
    title: conversationTitle(input.message), attachmentIds: input.attachmentIds, fileRefs: revision.fileRefs,
    idempotencyKey: replacementKey,
    replacementSourceTurnId: typeof replacementSource === "string" ? replacementSource : replacementSource?.id, now });
  const { turn, attachments } = prepared;
  if (prepared.replayRequest) {
    return { turn, runId: await startRunAndWaitUntilReady(prepared.replayRequest, input.startRun) };
  }
  const attachmentMaterializations = await materializeInlineConversationAttachments({
    store: input.store, attachments, now, imageVisionSummarizer: input.imageVisionSummarizer,
  });
  const effectiveConfig = await buildEffectiveConfigResponse({ cwd: input.workspaceCwd, store: input.store, runnerRegistry: input.runnerRegistry });
  const inheritIndependentPermissions = input.permissionPreset === undefined || input.permissionPreset === "custom"
    || input.permissionPreset === previousSnapshot.permissionPreset;
  const streamInput: ConversationStreamRequest = {
    threadId: input.thread.id,
    message: input.message,
    attachmentIds: [...input.attachmentIds],
    fileRefs: [...revision.fileRefs],
    projectPath: readOptionalRecordString(previousSnapshot, "projectPath")
      ?? (input.previousRun?.cwd && input.previousRun.cwd !== input.workspaceCwd ? input.previousRun.cwd : undefined),
    ...(selection ?? inheritConversationExecutionSelection(input.store, input.runnerRegistry, input.previousRun, input.providerPresetId)),
    thinkingLevel: readThinkingLevel(readOptionalRecordString(previousSnapshot, "thinkingLevel")),
    reasoningSummary: readReasoningSummary(readOptionalRecordString(previousSnapshot, "reasoningSummary")),
    permissionPreset: input.permissionPreset ?? readPermissionPreset(readOptionalRecordString(previousSnapshot, "permissionPreset")),
    permissionMode: readPermissionMode(readOptionalRecordString(previousSnapshot, "permissionMode")),
    authorizationMode: inheritIndependentPermissions ? readAuthorizationMode(readOptionalRecordString(previousSnapshot, "authorizationMode")) : undefined,
    workspaceAccessMode: inheritIndependentPermissions ? readWorkspaceAccessMode(readOptionalRecordString(previousSnapshot, "workspaceAccessMode")) : undefined,
    responseLanguage: readResponseLanguagePreference(readOptionalRecordString(previousSnapshot, "responseLanguage")),
    tools: readOptionalStringArray(previousSnapshot, "tools", runTools),
    idempotencyKey: prepared.idempotencyKey,
  };
  const runRequest = saveNormalConversationPreparedRequest(input.store, {
    ...buildConversationRunRequest({
      workspaceCwd: input.workspaceCwd,
      thread: input.thread,
      turn,
      input: streamInput,
      lingConversationTone: effectiveConfig.values.lingConversationTone.value,
      defaultReasoningSummary: effectiveConfig.values.reasoningSummary.value,
      attachments,
      attachmentMaterializations,
      normalConversationContext: prepared.context,
      normalConversationAcceptedSnapshotId: prepared.acceptedSnapshotId,
    }),
    permissionConfirmation: input.permissionConfirmation,
  }, now);
  const runId = await startRunAndWaitUntilReady(runRequest, input.startRun);
  return { turn, runId };
}

const thinkingLevels: readonly RunThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const reasoningSummaryModes = ["auto", "concise", "detailed", "none"] as const;
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
    const accepted = input.idempotencyKey && readConversationSubmission(store,
      { surface: "normal", idempotencyKey: input.idempotencyKey, threadId: input.threadId });
    const selection = accepted && accepted.status === "accepted" ? undefined
      : resolveConversationExecutionSelection(store, runnerRegistry, input);
    const thread = resolveConversationThread(store, input, now);
    const prepared = prepareNormalConversationInput({ store, thread, message: input.message,
      title: conversationTitle(input.message.trim() || "User attached files."), attachmentIds: input.attachmentIds ?? [],
      fileRefs: input.fileRefs ?? [], idempotencyKey: input.idempotencyKey, now });
    const { turn, attachments: conversationAttachments } = prepared;
    const attachmentMaterializations = prepared.replayRequest ? new Map<string, ConversationAttachmentMaterialization>() : await materializeInlineConversationAttachments({
      store,
      attachments: conversationAttachments,
      now,
      imageVisionSummarizer,
    });
    const effectiveConfig = prepared.replayRequest ? undefined : await buildEffectiveConfigResponse({ cwd: workspaceCwd, store, runnerRegistry });
    const userMessage = createUserTranscriptMessage(thread, turn, conversationAttachments, input.fileRefs ?? []);
    let assistantMessage = createAssistantTranscriptMessage(thread, turn, undefined, "", "running", now);
    let narration = new ConversationNarrationAccumulator();
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
          if (runId && runId !== ready.runId) throw new Error("Conversation Run owner changed during streaming.");
          if (!runId) narration = store.readSnapshot(() => createOwnedRunNarrationAccumulator(store, ready.runId as string, {
            threadId: thread.id, turnId: turn.id, participantId: LING_AGENT_ID, kind: "conversation",
          }));
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
        if (!runId || envelope.runId !== runId) return;
        const sourceRevision = narration.sourceRevision;
        narration.append(envelope);
        const narrativeSnapshot = narration.snapshot();
        if (sourceRevision !== narration.sourceRevision) assistantMessage = {
          ...assistantMessage, ...narrativeSnapshot,
          contentSource: narrativeSnapshot.content.trim() ? "run_narration" : "host_status",
        };
        if (envelope.type === "assistant_text_delta" || (
          envelope.type === "message_end" && readEventRole(envelope) === "assistant"
        )) {
          assistantMessage = {
            ...assistantMessage,
            ...narrativeSnapshot,
            contentSource: narrativeSnapshot.content.trim() ? "run_narration" : "host_status",
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

    const runRequest = prepared.replayRequest ?? saveNormalConversationPreparedRequest(store, buildConversationRunRequest({
      workspaceCwd,
      thread,
      turn,
      input: { ...input, ...(selection ?? resolveConversationExecutionSelection(store, runnerRegistry, input)), idempotencyKey: prepared.idempotencyKey },
      lingConversationTone: effectiveConfig!.values.lingConversationTone.value,
      defaultReasoningSummary: effectiveConfig!.values.reasoningSummary.value,
      attachments: conversationAttachments,
      attachmentMaterializations,
      normalConversationContext: prepared.context,
      normalConversationAcceptedSnapshotId: prepared.acceptedSnapshotId,
    }), now);
    writeSseHead(response);
    safeWrite("ready", { thread, turn, userMessage, assistantMessage });
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
    boundInterventionIds: new Set(storedTurns.flatMap((turn) => turn.interventionId ? [turn.interventionId] : [])),
  })) {
    messageById.set(message.id, message);
  }
  const latestRun = runs[runs.length - 1];
  const latestSnapshot = readRecord(latestRun?.requestSnapshot);
  const latestProjectPath = latestRun?.cwd && latestRun.cwd !== cwd ? latestRun.cwd : undefined;
  const sourceItems = listAllConversationItems(store, thread.id, !options.includeSuperseded)
    .filter(item => options.includeSuperseded || (item.kind !== "user_input_request" && item.kind !== "user_input_answer")
      || (item.turnId && !projection.supersededTurnIds.has(item.turnId)
        && store.getLingTurn(item.turnId)?.status !== "superseded"));
  const { conversationItems, userInputs } = projectConversationUserInputs(store, thread.id, sourceItems);
  const executionActions = listExecutionActions(store, { threadId: thread.id, limit: 500 });
  return {
    cwd,
    thread,
    turns,
    conversationItems,
    userInputs,
    supersessionTombstones: projectConversationSupersessionTombstones(projection),
    runLinks,
    runs,
    reasoningSummaries: projectConversationReasoningSummaries({
      store,
      thread,
      runLinks,
      runs,
      items: conversationItems,
    }),
    executionActions,
    approvals: runtimeProjection.approvals,
    approvalCheckpoints: runtimeProjection.approvalCheckpoints,
    interventions: runtimeProjection.interventions,
    terminalReports: (options.includeSuperseded
      ? store.listTerminalReports({ threadId: thread.id, limit: 200 })
      : filterSupersededTerminalReports(store.listTerminalReports({ threadId: thread.id, limit: 200 }), projection))
      .filter((record) => Boolean(record.report) && (record.status === "committed" || record.status === "fallback"))
      .flatMap((record) => record.resultItemId
        ? [{
            ...projectTerminalReportDto(record.report!, record.evidenceSnapshot),
            generation: record.generation,
            resultItemId: record.resultItemId,
          }]
        : []),
    artifacts: projectConversationArtifacts(runs.flatMap((run) => store.listArtifacts(run.id)), executionActions),
    plans: store.listProposedPlanArtifacts({ threadId: thread.id, limit: 200 }),
    compactionCheckpoints: store.listCompactionCheckpoints({ threadId: thread.id, limit: 100 }),
    contextSnapshots: [
      ...store.listConversationContextSnapshots({ threadId: thread.id, limit: 100 }),
      ...projectNormalExecutionContextSnapshots({ store, thread, turns, runs, items: conversationItems }),
    ],
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
      reasoningSummary: readReasoningSummary(readOptionalRecordString(latestSnapshot, "reasoningSummary")),
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
  const providerPresetId = readOptionalString(value, "providerPresetId")?.trim() || undefined;
  const executionBinding = value.executionBinding === undefined ? undefined : parseExecutionBindingRequest(value.executionBinding);
  if (executionBinding && providerPresetId) throw new Error("Choose an execution binding or a provider preset.");
  return {
    threadId: readOptionalString(value, "threadId")?.trim() || undefined,
    message,
    attachmentIds: normalizeStringList(attachmentIds),
    fileRefs,
    projectPath: readOptionalString(value, "projectPath")?.trim() || undefined,
    providerPresetId,
    executionBinding,
    thinkingLevel: readThinkingLevel(readOptionalString(value, "thinkingLevel")),
    reasoningSummary: readReasoningSummary(readOptionalString(value, "reasoningSummary")),
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
  const keyedThreadId = !input.threadId && input.idempotencyKey
    ? normalSubmissionThreadId(store.paths.cwd, input.idempotencyKey)
    : undefined;
  const threadId = input.threadId ?? keyedThreadId;
  if (threadId) {
    const thread = store.getLingThread(threadId);
    if (!thread && keyedThreadId) {
      return store.createLingThread({ id: keyedThreadId, kind: "conversation", teammateId: LING_AGENT_ID,
        title: conversationTitle(input.message), objective: input.message.trim(), status: "open" }, now);
    }
    if (!thread || thread.kind !== "conversation") {
      throw new HttpError(404, "conversation_not_found", `Conversation not found: ${threadId}`);
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

function createUserTranscriptMessage(
  thread: LingThread,
  turn: LingTurn,
  attachments: readonly ConversationAttachment[] = [],
  fileRefs: readonly ChannelMessageFileRef[] = [],
  content = turn.userInstruction,
): ConversationTranscriptMessage {
  return {
    id: turn.sourceItemId?.startsWith("conversation-user:") ? turn.sourceItemId : `conversation-user:${turn.id}`,
    role: turn.createdByActor === "system" ? "system" : "user",
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

function createAssistantTranscriptMessage(
  thread: LingThread,
  turn: LingTurn,
  run: RunSession | undefined,
  content: string,
  status: ConversationTranscriptStatus,
  now: string,
  errorMessage?: string,
  contentSource: ConversationTranscriptMessage["contentSource"] = "host_status",
): ConversationTranscriptMessage {
  return {
    id: conversationAssistantMessageId(turn.id),
    role: "assistant",
    authorId: LING_AGENT_ID,
    authorLabel: "Ling Agent",
    content,
    contentSource,
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
  return store.readSnapshot(() => assistantMessageFromRunSnapshot(store, thread, turn, run));
}

function assistantMessageFromRunSnapshot(store: RunStore, thread: LingThread, turn: LingTurn, run: RunSession): ConversationTranscriptMessage {
  const published = publishedNormalConversationMessage(store, thread, turn, run);
  if (published) return published;
  const narration = createOwnedRunNarrationAccumulator(store, run.id, {
    threadId: thread.id, turnId: turn.id, participantId: LING_AGENT_ID, kind: "conversation",
  });
  let error: string | undefined;
  let afterSeq = 0;
  for (;;) {
    const events = store.listEvents(run.id, { afterSeq, limit: 1000 });
    if (events.length === 0) break;
    for (const event of events) {
      if (event.runId !== run.id) continue;
      narration.append(event);
      error = readEventError(event) || error;
    }
    const nextSequence = events.at(-1)!.seq;
    if (nextSequence <= afterSeq) break;
    afterSeq = nextSequence;
  }
  const { content, narrationSegments } = narration.snapshot();
  const status = statusFromRun(run) ?? "running";
  const hasGeneratedMedia = runHasConversationGeneratedMedia(store, run.id);
  const projectedStatus = status === "succeeded" && !content.trim() && !hasGeneratedMedia ? "failed" : status;
  const requestSnapshot = readRecord(run.requestSnapshot);
  const responseLanguage = readResponseLanguagePreference(readOptionalRecordString(requestSnapshot, "responseLanguage"));
  return { ...createAssistantTranscriptMessage(
    thread,
    turn,
    run,
    content || (status === "succeeded" && hasGeneratedMedia
      ? ""
      : fallbackAssistantContent(status, responseLanguage, turn.userInstruction)),
    projectedStatus,
    run.updatedAt,
    error,
    content.trim() ? "run_narration" : "host_status",
  ), narrationSegments };
}

function statusFromTurn(turn: LingTurn): ConversationTranscriptStatus {
  if (turn.status === "failed") {
    return "failed";
  }
  if (turn.status === "blocked") {
    return "blocked";
  }
  if (turn.status === "cancelled" || turn.status === "superseded") {
    return "cancelled";
  }
  if (turn.status === "running" || turn.status === "waiting_for_approval") {
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
  if (run.status === "cancelled") {
    return "cancelled";
  }
  if (run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval") {
    return "running";
  }
  return "succeeded";
}

function conversationTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine || "New conversation";
}

function conversationAssistantMessageId(turnId: string): string {
  return `conversation-assistant:${turnId}`;
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

function readReasoningSummary(value: string | undefined): ConversationStreamRequest["reasoningSummary"] {
  return value && (reasoningSummaryModes as readonly string[]).includes(value)
    ? value as ConversationStreamRequest["reasoningSummary"]
    : undefined;
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
import { publishedNormalConversationMessage } from "./normal-conversation-published-message.js";
