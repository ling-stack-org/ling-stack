import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  permissionPresets,
  sessionPermissionModes,
  type ApprovalRequest,
  type CreateLingTurnInput,
  type LingThread,
  type LingThreadKind,
  type LingThreadStatus,
  type LingTurnCreatedByActor,
  type LingTurnKind,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalBoolean, readOptionalString } from "../../shared/validation.js";
import { listExecutionActions } from "./execution-actions.js";
import type { RunRequest } from "./schemas.js";

export type LingThreadRoute =
  | { readonly kind: "detail"; readonly threadId: string }
  | { readonly kind: "turns"; readonly threadId: string }
  | { readonly kind: "evidence"; readonly threadId: string }
  | { readonly kind: "resume"; readonly threadId: string }
  | { readonly kind: "resume-preview"; readonly threadId: string };

export type StartLingThreadResumeRun = (runRequest: RunRequest) => Promise<string | undefined>;

export interface HandleLingThreadRouteOptions {
  readonly maxBodyBytes: number;
  readonly startResumeRun?: StartLingThreadResumeRun;
}

interface ResumeContextPreview {
  readonly title: string;
  readonly instruction: string;
  readonly sourceRunId: string;
  readonly priorRunIds: readonly string[];
  readonly includedEventCount: number;
  readonly includedApprovalCount: number;
  readonly includedArtifactIds: readonly string[];
  readonly pendingActionIds: readonly string[];
  readonly contextText: string;
  readonly redactionNotes: readonly string[];
  readonly warnings: readonly string[];
}

export function handleLingThreadsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /threads` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      threads: store.listLingThreads({
        kind: readOptionalLingThreadKindQuery(url),
        channelId: url.searchParams.get("channelId") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
        teammateId: url.searchParams.get("teammateId") ?? undefined,
        workflowStepId: url.searchParams.get("workflowStepId") ?? undefined,
        externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
        status: readOptionalLingThreadStatusQuery(url),
        includeArchived: url.searchParams.get("includeArchived") === "true",
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleLingThreadItem(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: LingThreadRoute,
  options?: HandleLingThreadRouteOptions,
): void | Promise<void> {
  if (route.kind === "resume") {
    return handleLingThreadResume(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "resume-preview") {
    return handleLingThreadResumePreview(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "turns") {
    return handleLingThreadTurns(request, response, url, storeRegistry, route.threadId, options);
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread items` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const thread = store.getLingThread(route.threadId);
  if (!thread) {
    writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${route.threadId}` });
    return;
  }

  if (route.kind === "evidence") {
    writeJson(response, 200, buildLingThreadEvidence(store, cwd, thread));
    return;
  }

  writeJson(response, 200, { cwd, thread });
}

async function handleLingThreadTurns(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread turns` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    if (request.method === "POST") {
      const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
      const turn = store.createLingTurn(parseCreateLingTurnBody(body, thread), new Date().toISOString());
      writeJson(response, 201, {
        cwd,
        threadId,
        turn,
        runLinks: store.listLingTurnRuns(turn.id),
      });
      return;
    }

    const turns = store.listLingTurns({
      threadId,
      limit: readOptionalIntegerQuery(url, "limit", 1),
      beforeUpdatedAt: url.searchParams.get("beforeUpdatedAt") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      threadId,
      turns,
      runLinks: turns.flatMap((turn) => store.listLingTurnRuns(turn.id)),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleLingThreadResumePreview(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread resume preview` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
    const resume = buildLingThreadResumeContext({ store, thread, body, mode: "preview" });
    writeJson(response, 200, {
      cwd,
      thread,
      sourceRun: resume.sourceRun,
      context: resume.context,
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleLingThreadResume(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread resume` });
    return;
  }
  if (!options?.startResumeRun) {
    writeJson(response, 501, { error: "resume_unavailable", message: "Thread resume execution is not configured." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options.maxBodyBytes);
    const resume = buildLingThreadResumeContext({ store, thread, body, mode: "execute" });
    const runId = await options.startResumeRun(resume.runRequest);
    if (!runId) {
      writeJson(response, 500, { error: "resume_start_failed", message: "Thread resume run failed to start." });
      return;
    }
    writeJson(response, 202, {
      cwd,
      thread: store.getLingThread(thread.id) ?? thread,
      sourceRun: resume.sourceRun,
      runId,
      continuationReason: "manual_resume",
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function buildLingThreadEvidence(store: RunStore, cwd: string, thread: LingThread): {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly generatedAt: string;
  readonly runs: readonly {
    readonly run: RunSession;
    readonly events: readonly RunEventEnvelope[];
    readonly approvals: readonly ApprovalRequest[];
    readonly artifacts: ReturnType<RunStore["listArtifacts"]>;
    readonly runtimeEvents: ReturnType<RunStore["listRuntimeEvents"]>;
  }[];
  readonly actions: ReturnType<typeof listExecutionActions>;
  readonly transitions: ReturnType<RunStore["listStateTransitionEvents"]>;
} {
  const runs = [...store.listRuns({ threadId: thread.id, limit: 100 })]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const runIds = new Set(runs.map((run) => run.id));
  const threadWorkflowStepApprovals = thread.workflowStepId
    ? store.listApprovalRequests({ workflowStepId: thread.workflowStepId, limit: 500 })
    : [];
  const threadActions = listExecutionActions(store, { threadId: thread.id, limit: 500 });
  const ownerActions = listExecutionActions(store, { limit: 500 })
    .filter((action) => isActionLinkedToThread(action, thread, runIds));
  const actions = uniqueById([...threadActions, ...ownerActions]);
  const approvalIds = new Set<string>();
  const evidenceRuns = runs.map((run) => {
    const approvals = uniqueById([
      ...store.listApprovalRequests({ runId: run.id, limit: 500 }),
      ...threadWorkflowStepApprovals,
    ]);
    for (const approval of approvals) {
      approvalIds.add(approval.id);
    }
    return {
      run,
      events: store.listEvents(run.id, { limit: 1000 }),
      approvals,
      artifacts: store.listArtifacts(run.id),
      runtimeEvents: run.workUnitId ? store.listRuntimeEvents(run.workUnitId, { limit: 1000 }) : [],
    };
  });
  const transitions = collectThreadStateTransitions(store, thread, runs, approvalIds);
  return {
    cwd,
    thread,
    generatedAt: new Date().toISOString(),
    runs: evidenceRuns,
    actions,
    transitions,
  };
}

const lingTurnKinds: readonly LingTurnKind[] = [
  "initial_request",
  "manual_followup",
  "queued_followup",
  "interrupt_redirect",
  "workflow_step",
  "external_work_update",
  "automation_tick",
  "review_queue_action",
];

const lingTurnActors: readonly LingTurnCreatedByActor[] = ["local-user", "system", "teammate", "automation"];

function parseCreateLingTurnBody(body: unknown, thread: LingThread): CreateLingTurnInput {
  if (!isRecord(body)) {
    throw new Error("Turn request must be a JSON object");
  }
  const kind = readLingTurnKind(body, "kind");
  return {
    id: readOptionalString(body, "id"),
    threadId: thread.id,
    kind,
    title: readRequiredString(body, "title"),
    userInstruction: readRequiredString(body, "userInstruction"),
    channelId: readOptionalString(body, "channelId") ?? thread.channelId,
    taskId: readOptionalString(body, "taskId") ?? thread.taskId,
    teammateId: readOptionalString(body, "teammateId") ?? thread.teammateId,
    workflowStepId: readOptionalString(body, "workflowStepId") ?? thread.workflowStepId,
    externalWorkId: readOptionalString(body, "externalWorkId") ?? thread.externalWorkId,
    automationId: readOptionalString(body, "automationId"),
    sourceMessageId: readOptionalString(body, "sourceMessageId"),
    sourceTurnId: readOptionalString(body, "sourceTurnId"),
    interventionId: readOptionalString(body, "interventionId"),
    createdByActor: readOptionalLingTurnActor(body, "createdByActor"),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readLingTurnKind(record: Record<string, unknown>, key: string): LingTurnKind {
  const value = readRequiredString(record, key);
  if (!lingTurnKinds.includes(value as LingTurnKind)) {
    throw new Error(`${key} is not a valid Ling turn kind`);
  }
  return value as LingTurnKind;
}

function readOptionalLingTurnActor(record: Record<string, unknown>, key: string): LingTurnCreatedByActor | undefined {
  const value = readOptionalString(record, key);
  if (!value) {
    return undefined;
  }
  if (!lingTurnActors.includes(value as LingTurnCreatedByActor)) {
    throw new Error(`${key} is not a valid Ling turn actor`);
  }
  return value as LingTurnCreatedByActor;
}

function buildLingThreadResumeContext(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly body: unknown;
  readonly mode: "preview" | "execute";
}): { readonly sourceRun: RunSession; readonly context: ResumeContextPreview; readonly runRequest: RunRequest } {
  const { store, thread, body } = input;
  const warnings: string[] = [];
  const activeRun = thread.activeRunId ? store.getRun(thread.activeRunId) : undefined;
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    const message = `Thread already has an active run: ${activeRun.id}`;
    if (input.mode === "execute") {
      throw new Error(message);
    }
    warnings.push(message);
  }
  const sourceRun = resolveThreadResumeSourceRun(store, thread, body);
  const requestSnapshot = isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {};
  const taskSnapshot = isRecord(sourceRun.taskSnapshot) ? sourceRun.taskSnapshot : {};
  const instruction = isRecord(body)
    ? readOptionalString(body, "instruction")?.trim() || "Resume this Ling thread from durable evidence."
    : "Resume this Ling thread from durable evidence.";
  const idempotencyKey = isRecord(body)
    ? readOptionalString(body, "idempotencyKey") ?? `thread_resume:${thread.id}:${randomUUID()}`
    : `thread_resume:${thread.id}:${randomUUID()}`;
  const originalTitle =
    readSnapshotString(taskSnapshot, "title") ??
    readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "title") ??
    sourceRun.taskId;
  const originalPrompt =
    readSnapshotString(taskSnapshot, "prompt") ??
    readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "prompt") ??
    "";
  const providerPresetId = readSnapshotString(requestSnapshot, "providerPresetId") ?? sourceRun.providerPresetId;
  const inlineProvider = providerPresetId
    ? undefined
    : isRecord(requestSnapshot.provider) ? requestSnapshot.provider as unknown as PiRunnerProviderConfig : undefined;
  if (!providerPresetId && !inlineProvider) {
    throw new Error("Cannot resume thread because the source run has no reusable provider snapshot.");
  }
  const context = buildResumeContextPreview({
    store,
    thread,
    sourceRun,
    originalTitle,
    originalPrompt,
    instruction,
    includeArtifacts: isRecord(body) ? readOptionalBoolean(body, "includeArtifacts") ?? false : false,
    warnings,
  });
  return {
    sourceRun,
    context,
    runRequest: {
      workspaceCwd: readSnapshotString(requestSnapshot, "workspaceCwd") ?? sourceRun.cwd,
      cwd: readSnapshotString(requestSnapshot, "cwd") ?? sourceRun.cwd,
      providerPresetId,
      provider: inlineProvider,
      teammateId: readSnapshotString(requestSnapshot, "teammateId") ?? sourceRun.teammateId,
      runnerId: readSnapshotString(requestSnapshot, "runnerId"),
      requestedSkillId: readSnapshotString(requestSnapshot, "requestedSkillId") ?? sourceRun.selectedSkillId,
      skipProviderPreflight: readSnapshotBoolean(requestSnapshot, "skipProviderPreflight") ?? false,
      idempotencyKey,
      task: {
        id: `manual_resume_${randomUUID()}`,
        title: `Resume: ${thread.title}`,
        prompt: context.contextText,
        channelId:
          thread.channelId ??
          readSnapshotString(taskSnapshot, "channelId") ??
          readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "channelId") ??
          sourceRun.channelId,
      },
      tools: readSnapshotRunTools(requestSnapshot, "tools"),
      approvalProfile: isRecord(requestSnapshot.approvalProfile) ? requestSnapshot.approvalProfile as unknown as SkillApprovalProfile : undefined,
      permissionPreset: readSnapshotPermissionPreset(requestSnapshot, "permissionPreset"),
      permissionMode: readSnapshotSessionPermissionMode(requestSnapshot, "permissionMode"),
      permissionConfirmation: readSnapshotPermissionConfirmation(requestSnapshot, "permissionConfirmation"),
      thinkingLevel: readSnapshotThinkingLevel(requestSnapshot, "thinkingLevel"),
      systemPrompt: readSnapshotString(requestSnapshot, "systemPrompt"),
      appendSystemPrompt: readSnapshotStringArray(requestSnapshot, "appendSystemPrompt"),
      agentDir: readSnapshotString(requestSnapshot, "agentDir"),
      parentRunId: sourceRun.id,
      continuationReason: "manual_resume",
    },
  };
}

function resolveThreadResumeSourceRun(store: RunStore, thread: LingThread, body: unknown): RunSession {
  const requestedRunId = isRecord(body) ? readOptionalString(body, "sourceRunId") : undefined;
  const sourceRunId = requestedRunId ?? thread.lastRunId;
  if (!sourceRunId) {
    throw new Error("Thread has no source run to resume.");
  }
  const sourceRun = store.getRun(sourceRunId);
  if (!sourceRun) {
    throw new Error(`Thread source run was not found: ${sourceRunId}`);
  }
  if (sourceRun.threadId !== thread.id) {
    throw new Error(`Source run does not belong to thread: ${sourceRunId}`);
  }
  return sourceRun;
}

function buildResumeContextPreview(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly instruction: string;
  readonly includeArtifacts: boolean;
  readonly warnings: readonly string[];
}): ResumeContextPreview {
  const runs = [...input.store.listRuns({ threadId: input.thread.id, limit: 100 })]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const events = runs.flatMap((run) => input.store.listEvents(run.id, { limit: 1000 }));
  const approvals = uniqueById(runs.flatMap((run) => input.store.listApprovalRequests({ runId: run.id, limit: 500 })));
  const artifacts = input.includeArtifacts ? runs.flatMap((run) => input.store.listArtifacts(run.id)) : [];
  const actions = listExecutionActions(input.store, { threadId: input.thread.id, limit: 500 });
  const pendingActionIds = actions
    .filter((action) => action.status === "proposed" || action.status === "waiting_for_approval" || action.status === "executing")
    .map((action) => action.id);
  const redactionNotes = input.includeArtifacts && artifacts.length > 0
    ? ["Artifact contents are omitted; preview includes artifact ids only."]
    : [];
  const context: Omit<ResumeContextPreview, "contextText"> = {
    title: `Resume: ${input.thread.title}`,
    instruction: input.instruction,
    sourceRunId: input.sourceRun.id,
    priorRunIds: runs.map((run) => run.id),
    includedEventCount: events.length,
    includedApprovalCount: approvals.length,
    includedArtifactIds: artifacts.map((artifact) => artifact.id),
    pendingActionIds,
    redactionNotes,
    warnings: input.warnings,
  };
  return {
    ...context,
    contextText: renderResumeContextText({
      ...context,
      thread: input.thread,
      sourceRun: input.sourceRun,
      originalTitle: input.originalTitle,
      originalPrompt: input.originalPrompt,
      runs,
      approvals,
      actions,
    }),
  };
}

function renderResumeContextText(input: Omit<ResumeContextPreview, "contextText"> & {
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly actions: ReturnType<typeof listExecutionActions>;
}): string {
  return [
    "Resume a Ling Stack thread from durable Ling state.",
    "",
    "Thread:",
    `Thread id: ${input.thread.id}`,
    `Kind: ${input.thread.kind}`,
    `Status: ${input.thread.status}`,
    `Title: ${input.thread.title}`,
    `Objective: ${input.thread.objective}`,
    "",
    "Resume instruction:",
    input.instruction,
    "",
    "Prior runs:",
    ...input.runs.map((run) =>
      `- ${run.id}: ${run.status}, ${run.startedAt ?? run.createdAt} -> ${run.endedAt ?? "open"}, runner ${runnerAuditLine(run)}`),
    "",
    "Source run:",
    `Run id: ${input.sourceRun.id}`,
    `Status: ${input.sourceRun.status}`,
    `Provider: ${input.sourceRun.providerName}/${input.sourceRun.providerModel}`,
    input.sourceRun.selectedSkillId ? `Selected skill: ${input.sourceRun.selectedSkillId}` : undefined,
    input.sourceRun.startedAt ? `Started at: ${input.sourceRun.startedAt}` : undefined,
    input.sourceRun.endedAt ? `Ended at: ${input.sourceRun.endedAt}` : undefined,
    "",
    "Original task:",
    `Title: ${input.originalTitle}`,
    input.originalPrompt,
    "",
    "Recent terminal evidence:",
    `Included events: ${input.includedEventCount}`,
    `Included approvals: ${input.includedApprovalCount}`,
    `Included artifact ids: ${input.includedArtifactIds.length > 0 ? input.includedArtifactIds.join(", ") : "none"}`,
    "",
    "Pending actions:",
    ...(input.pendingActionIds.length > 0 ? input.pendingActionIds.map((id) => `- ${id}`) : ["- none"]),
    "",
    "Warnings:",
    ...(input.warnings.length > 0 ? input.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Redaction notes:",
    ...(input.redactionNotes.length > 0 ? input.redactionNotes.map((note) => `- ${note}`) : ["- none"]),
    "",
    "Constraints:",
    "- Treat this as a new Ling-supervised continuation, not a native runner session resume.",
    "- Use durable thread/run evidence as hints only; re-check files or external state before side effects.",
    "- The resume instruction does not grant extra tools, approvals, secrets, MCP access, or external-send rights.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function runnerAuditLine(run: RunSession): string {
  const requestSnapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : {};
  const resolution = isRecord(requestSnapshot.runnerResolution) ? requestSnapshot.runnerResolution : {};
  const requested = readSnapshotString(resolution, "requestedRunnerId") ?? "unknown";
  const effective = readSnapshotString(resolution, "effectiveRunnerId") ?? requested;
  const source = readSnapshotString(resolution, "requestSource") ?? "legacy";
  return requested === effective ? `${effective} (${source})` : `${requested} -> ${effective} (${source})`;
}

function collectThreadStateTransitions(
  store: RunStore,
  thread: LingThread,
  runs: readonly RunSession[],
  approvalIds: ReadonlySet<string>,
): ReturnType<RunStore["listStateTransitionEvents"]> {
  const refs = new Map<string, { readonly entityType: "task" | "run" | "approval" | "workflow" | "workflow_step" | "work_unit"; readonly entityId: string }>();
  const addRef = (entityType: "task" | "run" | "approval" | "workflow" | "workflow_step" | "work_unit", entityId: string | undefined): void => {
    if (entityId) {
      refs.set(`${entityType}:${entityId}`, { entityType, entityId });
    }
  };
  addRef("task", thread.taskId);
  addRef("workflow", thread.workflowId);
  addRef("workflow_step", thread.workflowStepId);
  for (const run of runs) {
    addRef("run", run.id);
    addRef("task", run.taskId);
    addRef("work_unit", run.workUnitId);
  }
  for (const approvalId of approvalIds) {
    addRef("approval", approvalId);
  }
  return uniqueById(
    [...refs.values()].flatMap((ref) =>
      store.listStateTransitionEvents({ entityType: ref.entityType, entityId: ref.entityId, limit: 200 })),
  ).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function isActionLinkedToThread(
  action: ReturnType<typeof listExecutionActions>[number],
  thread: LingThread,
  runIds: ReadonlySet<string>,
): boolean {
  if (action.threadId === thread.id || (action.runId && runIds.has(action.runId))) {
    return true;
  }
  return action.targetRefs.some((ref) =>
    (ref.type === "task" && ref.id === thread.taskId) ||
    (ref.type === "channel" && ref.id === thread.channelId) ||
    (ref.type === "workflow" && ref.id === thread.workflowId) ||
    (ref.type === "workflow_step" && ref.id === thread.workflowStepId));
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
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
    value.mode === "full_access" &&
    value.confirmed === true &&
    typeof value.confirmedAt === "string" &&
    typeof value.reason === "string"
  ) {
    return value as unknown as PermissionConfirmation;
  }
  return undefined;
}

function readSnapshotThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  const value = record[key];
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? value as RunRequest["thinkingLevel"]
    : undefined;
}

function isRunTool(value: unknown): value is RunTool {
  return typeof value === "string" && ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(value);
}

function readOptionalLingThreadKindQuery(url: URL): LingThreadKind | undefined {
  const value = url.searchParams.get("kind");
  if (value === null) {
    return undefined;
  }
  if (!["task", "channel_discussion", "teammate_direct", "workflow_step", "external_work"].includes(value)) {
    throw new Error("kind must be one of: task, channel_discussion, teammate_direct, workflow_step, external_work");
  }
  return value as LingThreadKind;
}

function readOptionalLingThreadStatusQuery(url: URL): LingThreadStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["open", "running", "waiting_for_approval", "blocked", "succeeded", "failed", "cancelled", "archived"].includes(value)) {
    throw new Error("status must be one of: open, running, waiting_for_approval, blocked, succeeded, failed, cancelled, archived");
  }
  return value as LingThreadStatus;
}
