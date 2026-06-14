import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  permissionPresets,
  runInterventionModes,
  sessionPermissionModes,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunEventType,
  type RunIntervention,
  type RunInterventionAttachmentPayload,
  type RunInterventionLinkPreviewPayload,
  type RunInterventionMaterializationStatus,
  type RunInterventionMessagePayload,
  type RunInterventionMode,
  type RunInterventionWorkspaceFilePayload,
  type RunSession,
  type RunStatus,
  type RunStore,
  type RunTool,
  type SecretResolver,
  type SessionPermissionMode,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";
import { RunControlService } from "../../run-control.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import {
  createDetachedRunExecutionSink,
  executeRunRequest,
} from "./orchestrator.js";
import type { RunRequest } from "./schemas.js";

const runControlService = new RunControlService();

export async function handleRunInterventions(
  request: IncomingMessage,
  response: ServerResponse,
  config: { readonly maxBodyBytes: number },
  url: URL,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  controlPlaneEvents: ControlPlaneEventHub,
  startupState: StartupStateRegistry | undefined,
  sourceRunId: string,
): Promise<void> {
  const store = storeRegistry.findStoreForRun(sourceRunId, url.searchParams.get("cwd") ?? undefined);
  const sourceRun = store?.getRun(sourceRunId);
  if (!store || !sourceRun) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd: store.paths.cwd,
      interventions: store.listRunInterventions({ sourceRunId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run interventions` });
    return;
  }

  let input: {
    readonly mode: RunInterventionMode;
    readonly instruction: string;
    readonly messagePayload?: RunInterventionMessagePayload;
    readonly idempotencyKey: string;
  };
  try {
    input = parseRunInterventionCreateRequest(await readJsonBody(request, config.maxBodyBytes));
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (input.mode === "interrupt_redirect" && isTerminalRunStatus(sourceRun.status)) {
    writeJson(response, 409, { error: "run_not_cancellable", message: `Run ${sourceRun.id} is already ${sourceRun.status}.`, run: sourceRun });
    return;
  }

  const now = new Date().toISOString();
  const sourceWorkUnit = sourceRun.workUnitId ? store.getWorkUnit(sourceRun.workUnitId) : undefined;
  const intervention = store.createRunIntervention(
    {
      sourceRunId,
      sourceWorkUnitId: sourceRun.workUnitId,
      sourceAttemptId: sourceWorkUnit?.activeAttemptId ?? (sourceRun.workUnitId ? store.listWorkUnitAttempts(sourceRun.workUnitId).at(-1)?.id : undefined),
      mode: input.mode,
      instruction: input.instruction,
      messagePayload: input.messagePayload,
      requestedBy: "local-user",
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
  streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_intervention_created", {
    interventionId: intervention.id,
    mode: intervention.mode,
    status: intervention.status,
  });

  if (input.mode === "queue_followup") {
    streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_followup_queued", {
      interventionId: intervention.id,
      instruction: intervention.instruction,
    });
    if (isTerminalRunStatus(sourceRun.status)) {
      void maybeStartNextRunInterventionContinuation({
        sourceRunId,
        store,
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        controlPlaneEvents,
        startupState,
      });
    }
    writeJson(response, 201, { cwd: store.paths.cwd, intervention: store.getRunIntervention(intervention.id) ?? intervention });
    return;
  }

  const updated = store.updateRunInterventionStatus({
    interventionId: intervention.id,
    status: "cancelling_source",
    now,
  }) ?? intervention;
  streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_interrupt_requested", {
    interventionId: updated.id,
    instruction: updated.instruction,
  });

  const cancellation = runControlService.cancelRunForRedirect({
    store,
    run: sourceRun,
    activeRun: activeRuns.get(sourceRunId),
  });

  writeJson(response, 201, {
    cwd: store.paths.cwd,
    intervention: store.getRunIntervention(intervention.id) ?? updated,
    run: store.getRun(sourceRunId),
    event: cancellation.event,
  });
}

export function handleRunInterventionItem(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: { readonly kind: "detail" | "cancel"; readonly interventionId: string },
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const intervention = resolved.store.getRunIntervention(route.interventionId);
  if (!intervention) {
    writeJson(response, 404, { error: "run_intervention_not_found", message: `Run intervention not found: ${route.interventionId}` });
    return;
  }
  if (route.kind === "detail") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention detail` });
      return;
    }
    writeJson(response, 200, { cwd: resolved.cwd, intervention });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention cancel` });
    return;
  }
  const cancelled = resolved.store.cancelRunIntervention(route.interventionId, new Date().toISOString(), "cancelled_by_user");
  writeJson(response, 200, { cwd: resolved.cwd, intervention: cancelled ?? intervention });
}

export function handleRunInterventionPromote(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  controlPlaneEvents: ControlPlaneEventHub,
  startupState: StartupStateRegistry | undefined,
  interventionId: string,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const intervention = resolved.store.getRunIntervention(interventionId);
  if (!intervention) {
    writeJson(response, 404, { error: "run_intervention_not_found", message: `Run intervention not found: ${interventionId}` });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention promote` });
    return;
  }
  if (intervention.status !== "queued") {
    writeJson(response, 409, {
      error: "run_intervention_not_queued",
      message: "只有排队中的引导可以立即执行。",
      intervention,
    });
    return;
  }

  const sourceRun = resolved.store.getRun(intervention.sourceRunId);
  if (!sourceRun) {
    writeJson(response, 404, { error: "run_not_found", message: `Source run not found: ${intervention.sourceRunId}`, intervention });
    return;
  }

  const currentRun = findCurrentRunForIntervention(resolved.store, sourceRun);
  if (!currentRun || isTerminalRunStatus(currentRun.status)) {
    maybeStartNextRunInterventionContinuation({
      sourceRunId: intervention.sourceRunId,
      store: resolved.store,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      controlPlaneEvents,
      startupState,
    });
    writeJson(response, 202, {
      cwd: resolved.cwd,
      intervention: resolved.store.getRunIntervention(intervention.id) ?? intervention,
      run: resolved.store.getRun(sourceRun.id) ?? sourceRun,
      message: "当前运行已结束，这条引导会按排队顺序继续执行。",
    });
    return;
  }

  const now = new Date().toISOString();
  const promoted = resolved.store.updateRunInterventionStatus({
    interventionId: intervention.id,
    status: "cancelling_source",
    now,
  }) ?? intervention;
  streamRunEventIfPossible(resolved.store, activeRuns, intervention.sourceRunId, "run_interrupt_requested", {
    interventionId: promoted.id,
    instruction: promoted.instruction,
  });

  const cancellation = runControlService.cancelRunForRedirect({
    store: resolved.store,
    run: currentRun,
    activeRun: activeRuns.get(currentRun.id),
  });
  maybeStartNextRunInterventionContinuation({
    sourceRunId: intervention.sourceRunId,
    store: resolved.store,
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    mcpBroker,
    controlPlaneEvents,
    startupState,
  });

  writeJson(response, 200, {
    cwd: resolved.cwd,
    intervention: resolved.store.getRunIntervention(intervention.id) ?? promoted,
    run: resolved.store.getRun(currentRun.id),
    event: cancellation.event,
  });
}

export function maybeStartNextRunInterventionContinuation(input: {
  readonly sourceRunId: string;
  readonly store: RunStore;
  readonly runnerRegistry: RunnerRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly mcpBroker: McpBroker;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly startupState?: StartupStateRegistry;
}): void {
  const sourceRun = input.store.getRun(input.sourceRunId);
  if (!sourceRun || !isTerminalRunStatus(sourceRun.status)) {
    return;
  }
  const next = input.store
    .listRunInterventions({ sourceRunId: input.sourceRunId, limit: 100 })
    .find((intervention) => intervention.status === "cancelling_source" || intervention.status === "queued");
  if (!next) {
    return;
  }
  const now = new Date().toISOString();
  const starting = input.store.updateRunInterventionStatus({
    interventionId: next.id,
    status: "starting_continuation",
    startedAt: now,
    now,
  });
  if (!starting) {
    return;
  }
  streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_continuation_starting", {
    interventionId: starting.id,
    mode: starting.mode,
  });
  const continuationRequest = buildRunInterventionContinuationRequest(sourceRun, starting);
  void (async () => {
    const continuationRunId = await executeRunRequest(
      continuationRequest,
      createDetachedRunExecutionSink(),
      input.runnerRegistry,
      input.storeRegistry,
      input.activeRuns,
      input.runtimeSupervisor,
      input.secretResolver,
      input.mcpBroker,
      {
        controlPlaneEvents: input.controlPlaneEvents,
        startupState: input.startupState,
        onRunReady: (runId) => {
          const run = input.store.getRun(runId);
          input.store.updateRunInterventionStatus({
            interventionId: starting.id,
            status: "started",
            continuationRunId: runId,
            continuationWorkUnitId: run?.workUnitId ?? null,
            now: new Date().toISOString(),
          });
          streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_continuation_started", {
            interventionId: starting.id,
            continuationRunId: runId,
            continuationWorkUnitId: run?.workUnitId,
          });
        },
        afterRunTerminal: (terminalRun) => {
          const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
          maybeStartNextRunInterventionContinuation({ ...input, sourceRunId });
        },
      },
    );
    if (!continuationRunId) {
      input.store.updateRunInterventionStatus({
        interventionId: starting.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        failureReason: "Continuation run failed to start.",
        now: new Date().toISOString(),
      });
      streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_intervention_failed", {
        interventionId: starting.id,
        message: "Continuation run failed to start.",
      });
    }
  })();
}

function parseRunInterventionCreateRequest(value: unknown): {
  readonly mode: RunInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly idempotencyKey: string;
} {
  if (!isRecord(value)) {
    throw new Error("Run intervention request must be a JSON object");
  }
  const mode = readRunInterventionMode(value, "mode");
  const instruction = readString(value, "instruction").trim();
  if (!instruction) {
    throw new Error("instruction is required");
  }
  const messagePayload = parseRunInterventionMessagePayload(value.messagePayload);
  const idempotencyKey = readOptionalString(value, "idempotencyKey") ?? `run_intervention:${randomUUID()}`;
  return { mode, instruction, messagePayload, idempotencyKey };
}

function buildRunInterventionContinuationRequest(sourceRun: RunSession, intervention: RunIntervention): RunRequest {
  const snapshot = isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {};
  const taskSnapshot = isRecord(sourceRun.taskSnapshot) ? sourceRun.taskSnapshot : {};
  const originalTitle = readSnapshotString(taskSnapshot, "title") ?? readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "title") ?? sourceRun.taskId;
  const originalPrompt = readSnapshotString(taskSnapshot, "prompt") ?? readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "prompt") ?? "";
  const channelId =
    readSnapshotString(taskSnapshot, "channelId") ??
    readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "channelId") ??
    sourceRun.channelId;
  const permissionMode = readSnapshotSessionPermissionMode(snapshot, "permissionMode");
  const permissionPreset = readSnapshotPermissionPreset(snapshot, "permissionPreset");
  const permissionConfirmation = readSnapshotPermissionConfirmation(snapshot, "permissionConfirmation");
  const requestedSkillId = readSnapshotString(snapshot, "requestedSkillId") ?? sourceRun.selectedSkillId;
  const providerPresetId = readSnapshotString(snapshot, "providerPresetId") ?? sourceRun.providerPresetId;
  const inlineProvider = providerPresetId ? undefined : isRecord(snapshot.provider) ? snapshot.provider as unknown as PiRunnerProviderConfig : undefined;
  const tools = readSnapshotRunTools(snapshot, "tools");
  const appendSystemPrompt = readSnapshotStringArray(snapshot, "appendSystemPrompt");
  return {
    workspaceCwd: readSnapshotString(snapshot, "workspaceCwd") ?? sourceRun.cwd,
    cwd: readSnapshotString(snapshot, "cwd") ?? sourceRun.cwd,
    providerPresetId,
    provider: inlineProvider,
    teammateId: readSnapshotString(snapshot, "teammateId") ?? sourceRun.teammateId,
    requestedSkillId,
    skipProviderPreflight: readSnapshotBoolean(snapshot, "skipProviderPreflight") ?? false,
    idempotencyKey: `run_intervention:${intervention.id}`,
    task: {
      id: `continuation_${intervention.id}`,
      title: `继续自上次运行: ${originalTitle}`,
      prompt: renderRunInterventionContinuationPrompt({
        sourceRun,
        originalTitle,
        originalPrompt,
        sourceStatus: sourceRun.status,
        instruction: intervention.instruction,
        messagePayload: intervention.messagePayload,
        mode: intervention.mode,
      }),
      channelId,
    },
    tools,
    approvalProfile: isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile as unknown as SkillApprovalProfile : undefined,
    permissionPreset,
    permissionMode,
    permissionConfirmation,
    thinkingLevel: readSnapshotThinkingLevel(snapshot, "thinkingLevel"),
    systemPrompt: readSnapshotString(snapshot, "systemPrompt"),
    appendSystemPrompt,
    agentDir: readSnapshotString(snapshot, "agentDir"),
    parentRunId: sourceRun.id,
    interventionId: intervention.id,
    continuationReason: intervention.mode,
  };
}

function renderRunInterventionContinuationPrompt(input: {
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly sourceStatus: RunStatus;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly mode: RunInterventionMode;
}): string {
  return [
    "Continue a Ling Stack supervised run from preserved context.",
    "",
    "Original task:",
    `Title: ${input.originalTitle}`,
    input.originalPrompt,
    "",
    "Source run:",
    `Run id: ${input.sourceRun.id}`,
    `Status: ${input.sourceStatus}`,
    `Provider: ${input.sourceRun.providerName}/${input.sourceRun.providerModel}`,
    input.sourceRun.selectedSkillId ? `Selected skill: ${input.sourceRun.selectedSkillId}` : undefined,
    input.sourceRun.startedAt ? `Started at: ${input.sourceRun.startedAt}` : undefined,
    input.sourceRun.endedAt ? `Ended at: ${input.sourceRun.endedAt}` : undefined,
    "",
    input.mode === "interrupt_redirect" ? "User redirect:" : "Queued user guidance:",
    renderRunInterventionPayloadForPrompt(input.instruction, input.messagePayload),
    "",
    "Constraints:",
    "- Continue from durable source run context; do not assume unseen state.",
    "- The user guidance does not grant extra tools, approvals, secrets, MCP access, or external-send rights.",
    "- Re-check files or external state before repeating side effects that may have already happened.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function parseRunInterventionMessagePayload(value: unknown): RunInterventionMessagePayload | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("messagePayload must be an object");
  }
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const attachmentIds = readOptionalStringArray(value, "attachmentIds") ?? [];
  const linkPreviewIds = readOptionalStringArray(value, "linkPreviewIds") ?? [];
  const attachments = readOptionalRunInterventionAttachmentPayloads(value, "attachments");
  const linkPreviews = readOptionalRunInterventionLinkPreviewPayloads(value, "linkPreviews");
  const fileRefs = readOptionalRunInterventionWorkspaceFilePayloads(value, "fileRefs");
  if (!body && attachmentIds.length === 0 && linkPreviewIds.length === 0 && !attachments?.length && !linkPreviews?.length && !fileRefs?.length) {
    throw new Error("messagePayload must include body, attachments, link previews, or file refs");
  }
  return {
    body,
    attachmentIds,
    linkPreviewIds,
    ...(attachments?.length ? { attachments } : {}),
    ...(linkPreviews?.length ? { linkPreviews } : {}),
    ...(fileRefs?.length ? { fileRefs } : {}),
  };
}

function renderRunInterventionPayloadForPrompt(instruction: string, payload: RunInterventionMessagePayload | undefined): string {
  if (!payload) {
    return instruction;
  }
  const lines = [
    payload.body || instruction,
    renderRunInterventionAttachmentsForPrompt(payload),
    renderRunInterventionLinkPreviewsForPrompt(payload),
    renderRunInterventionWorkspaceFileRefsForPrompt(payload),
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function renderRunInterventionAttachmentsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (payload.attachments?.length) {
    return [
      "Attachments:",
      ...payload.attachments.map((attachment, index) => [
        `- ${index + 1}. ${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${attachment.sizeBytes} bytes, materialization=${attachment.materializationStatus}${attachment.previewStatus ? `, preview=${attachment.previewStatus}` : ""})`,
        attachment.reason ? `  statusReason: ${attachment.reason}` : undefined,
        attachment.previewText ? `  preview:\n${indentPromptBlock(attachment.previewText)}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n")),
    ].join("\n");
  }
  return payload.attachmentIds.length > 0 ? `Attachments: ${payload.attachmentIds.join(", ")}` : undefined;
}

function renderRunInterventionLinkPreviewsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (payload.linkPreviews?.length) {
    return [
      "Link previews:",
      ...payload.linkPreviews.map((preview, index) => [
        `- ${index + 1}. ${preview.title ?? preview.normalizedUrl} (${preview.status}, materialization=${preview.materializationStatus})`,
        `  url: ${preview.url}`,
        preview.siteName ? `  site: ${preview.siteName}` : undefined,
        preview.description ? `  description: ${preview.description}` : undefined,
        preview.reason ? `  statusReason: ${preview.reason}` : undefined,
        preview.previewText ? `  preview:\n${indentPromptBlock(preview.previewText)}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n")),
    ].join("\n");
  }
  return payload.linkPreviewIds.length > 0 ? `Link previews: ${payload.linkPreviewIds.join(", ")}` : undefined;
}

function renderRunInterventionWorkspaceFileRefsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (!payload.fileRefs?.length) {
    return undefined;
  }
  return [
    "Workspace file refs:",
    ...payload.fileRefs.map((ref, index) => [
      `- ${index + 1}. ${ref.label ? `${ref.label}: ` : ""}${ref.path} (${ref.kind}, ${ref.rootRelation}, materialization=${ref.materializationStatus})`,
      ref.blockedReason ? `  statusReason: ${ref.blockedReason}` : undefined,
      ref.previewText ? `  preview:\n${indentPromptBlock(ref.previewText)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function readOptionalRunInterventionAttachmentPayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionAttachmentPayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const id = readString(item, "id");
    const previewStatus = readOptionalString(item, "previewStatus");
    const previewText = readOptionalString(item, "previewText");
    const reason = readOptionalString(item, "reason");
    return {
      id,
      fileName: readOptionalString(item, "fileName") ?? id,
      kind: readRunInterventionAttachmentKind(item.kind),
      contentType: readOptionalString(item, "contentType") ?? "application/octet-stream",
      sizeBytes: readOptionalNonNegativeNumber(item, "sizeBytes"),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewStatus ? { previewStatus } : {}),
      ...(previewText ? { previewText } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

function readOptionalRunInterventionLinkPreviewPayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionLinkPreviewPayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const id = readString(item, "id");
    const url = readOptionalString(item, "url") ?? id;
    const normalizedUrl = readOptionalString(item, "normalizedUrl") ?? url;
    const title = readOptionalString(item, "title");
    const description = readOptionalString(item, "description");
    const siteName = readOptionalString(item, "siteName");
    const previewText = readOptionalString(item, "previewText");
    const reason = readOptionalString(item, "reason");
    return {
      id,
      url,
      normalizedUrl,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(siteName ? { siteName } : {}),
      status: readRunInterventionLinkPreviewStatus(item.status),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewText ? { previewText } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

function readOptionalRunInterventionWorkspaceFilePayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionWorkspaceFilePayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const label = readOptionalString(item, "label");
    const previewText = readOptionalString(item, "previewText");
    const blockedReason = readOptionalString(item, "blockedReason");
    return {
      path: readString(item, "path"),
      ...(label ? { label } : {}),
      rootRelation: readRunInterventionWorkspaceFileRootRelation(item.rootRelation),
      kind: readRunInterventionWorkspaceFileKind(item.kind),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewText ? { previewText } : {}),
      ...(blockedReason ? { blockedReason } : {}),
    };
  });
}

function readOptionalNonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function readRunInterventionMaterializationStatus(value: unknown): RunInterventionMaterializationStatus {
  if (value === "available" || value === "metadata_only" || value === "not_loaded" || value === "unsupported" || value === "blocked") {
    return value;
  }
  return "metadata_only";
}

function readRunInterventionAttachmentKind(value: unknown): RunInterventionAttachmentPayload["kind"] {
  return value === "image" || value === "pdf" || value === "office" || value === "text" || value === "other" ? value : "other";
}

function readRunInterventionLinkPreviewStatus(value: unknown): RunInterventionLinkPreviewPayload["status"] {
  return value === "ready" || value === "blocked" || value === "failed" || value === "missing" || value === "channel_mismatch" ? value : "missing";
}

function readRunInterventionWorkspaceFileRootRelation(value: unknown): RunInterventionWorkspaceFilePayload["rootRelation"] {
  return value === "inside_workspace" || value === "outside_workspace" || value === "unknown" ? value : "unknown";
}

function readRunInterventionWorkspaceFileKind(value: unknown): RunInterventionWorkspaceFilePayload["kind"] {
  return value === "file" || value === "directory" || value === "glob" || value === "unknown" ? value : "unknown";
}

function indentPromptBlock(value: string): string {
  return value.split(/\r?\n/u).map((line) => `    ${line}`).join("\n");
}

function streamRunEventIfPossible(
  store: RunStore,
  activeRuns: ActiveRunRegistry,
  runId: string,
  type: RunEventType,
  data: unknown,
): void {
  try {
    const envelope = store.appendEvent(runId, type, data);
    activeRuns.get(runId)?.streamEnvelope(envelope);
  } catch {
    // Intervention events are operational hints; the intervention row is authoritative.
  }
}

function findCurrentRunForIntervention(store: RunStore, sourceRun: RunSession): RunSession | undefined {
  const candidates = [
    sourceRun,
    ...store.listRuns({ limit: 200 }).filter((run) => run.parentRunId === sourceRun.id),
  ].filter((run) => !isTerminalRunStatus(run.status));
  return candidates.sort((left, right) => readRunSortTime(right).localeCompare(readRunSortTime(left)))[0];
}

function readRunSortTime(run: RunSession): string {
  return run.startedAt ?? run.createdAt;
}

function readRunInterventionMode(record: Record<string, unknown>, key: string): RunInterventionMode {
  const value = readString(record, key);
  if (!runInterventionModes.includes(value as RunInterventionMode)) {
    throw new Error(`${key} must be one of: ${runInterventionModes.join(", ")}`);
  }
  return value as RunInterventionMode;
}

function readSnapshotString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSnapshotBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readSnapshotStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function readSnapshotRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRunTool) : undefined;
}

function readSnapshotSessionPermissionMode(record: Record<string, unknown>, key: string): SessionPermissionMode | undefined {
  const value = record[key];
  return typeof value === "string" && sessionPermissionModes.includes(value as SessionPermissionMode)
    ? value as SessionPermissionMode
    : undefined;
}

function readSnapshotPermissionPreset(record: Record<string, unknown>, key: string): PermissionPreset | undefined {
  const value = record[key];
  return typeof value === "string" && permissionPresets.includes(value as PermissionPreset)
    ? value as PermissionPreset
    : undefined;
}

function readSnapshotPermissionConfirmation(record: Record<string, unknown>, key: string): PermissionConfirmation | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.mode !== "full_access" ||
    value.confirmed !== true ||
    typeof value.confirmedAt !== "string" ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    Number.isNaN(Date.parse(value.confirmedAt))
  ) {
    return undefined;
  }
  return {
    mode: "full_access",
    confirmed: true,
    confirmedAt: value.confirmedAt,
    reason: value.reason,
  };
}

function readSnapshotThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  const value = record[key];
  return typeof value === "string" && (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    ? value
    : undefined;
}

function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function getCwdStoreOrWriteError(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): { readonly cwd: string; readonly store: RunStore } | undefined {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return undefined;
  }
  return { cwd, store: storeRegistry.getStore(cwd) };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
