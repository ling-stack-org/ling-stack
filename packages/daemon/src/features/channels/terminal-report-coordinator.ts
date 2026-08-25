import {
  buildDeterministicTerminalReport,
  computeTerminalReportEvidenceFingerprint,
  type ChannelMessage,
  type LingTerminalReportRecord,
  type RunStore,
  type RunSession,
  type SecretResolver,
  type TerminalReport,
  type TerminalReportContent,
  type TerminalReportEvidenceRisk,
  type TerminalReportEvidenceSnapshot,
  type WorkUnit,
} from "@ling-stack/core";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { buildWorkflowEvidence } from "./workflow-evidence.js";
import { collectRunTerminalReportEvidence, collectTurnTerminalReportEvidence, collectWorkflowTerminalReportEvidence } from "./terminal-report-evidence.js";
import { publishTerminalReportPublication } from "./terminal-report-publisher.js";
import { getChannelMessageView } from "./conversation-item-messages.js";
import {
  runIsEligibleForTerminalReport,
  terminalReportIsEligibleForDisplay,
  turnIsEligibleForTerminalReport,
} from "./terminal-report-eligibility.js";
import { TERMINAL_REPORT_PROMPT_VERSION } from "./terminal-report-prompt.js";
import { synthesizeTerminalReportContent } from "./terminal-report-synthesis.js";
import { evaluateWorkflowCompletionGate } from "./workflow-completion-gate.js";
import { reconcileWorkflowFromCanonicalState } from "./workflow-reconciliation.js";

export interface TerminalReportCoordinatorSettings {
  readonly enabled: boolean;
  readonly barrierDeadlineMs?: number;
  readonly barrierPollIntervalMs?: number;
  readonly synthesisTimeoutMs?: number;
  readonly runnerRegistry?: RunnerRegistry;
  readonly secretResolver?: SecretResolver;
  readonly onPublished?: (input: {
    readonly event: import("@ling-stack/core").ControlPlaneEvent;
  }) => void;
}

export interface ProcessWorkflowTerminalReportOptions {
  readonly linkedRunId?: string;
  readonly now?: string;
  readonly barrierDeadlineMs?: number;
  readonly barrierPollIntervalMs?: number;
}

export interface ProcessWorkflowTerminalReportResult {
  readonly record: LingTerminalReportRecord;
  readonly message?: ChannelMessage;
  readonly workUnit?: WorkUnit;
}

export type ProcessTerminalReportResult = ProcessWorkflowTerminalReportResult;

interface ResolvedTerminalReportCoordinatorSettings {
  readonly enabled: boolean;
  readonly barrierDeadlineMs: number;
  readonly barrierPollIntervalMs: number;
  readonly synthesisTimeoutMs: number;
  readonly runnerRegistry?: RunnerRegistry;
  readonly secretResolver?: SecretResolver;
  readonly onPublished?: TerminalReportCoordinatorSettings["onPublished"];
}

const settingsByStore = new WeakMap<RunStore, ResolvedTerminalReportCoordinatorSettings>();
const activeByStore = new WeakMap<RunStore, Map<string, Promise<ProcessTerminalReportResult | undefined>>>();
const TERMINAL_REPORT_ROLLOUT_WATERMARK = "2026-07-11T00:00:00.000Z";

export function configureTerminalReportStore(
  store: RunStore,
  settings: TerminalReportCoordinatorSettings,
): void {
  settingsByStore.set(store, {
    enabled: settings.enabled,
    barrierDeadlineMs: settings.barrierDeadlineMs ?? 5_000,
    barrierPollIntervalMs: settings.barrierPollIntervalMs ?? 250,
    synthesisTimeoutMs: settings.synthesisTimeoutMs ?? 45_000,
    runnerRegistry: settings.runnerRegistry,
    secretResolver: settings.secretResolver,
    onPublished: settings.onPublished,
  });
}

export function terminalReportsEnabledForStore(store: RunStore): boolean {
  return settingsByStore.get(store)?.enabled === true;
}

export function maybeScheduleWorkflowTerminalReport(
  store: RunStore,
  workflowId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): ChannelMessage | undefined {
  if (!terminalReportsEnabledForStore(store)) {
    return undefined;
  }
  const published = latestCommittedReport(store, "workflow", workflowId);
  if (published?.publishedMessageId) {
    return getChannelMessageView(store, published.publishedMessageId);
  }
  const active = activeMap(store);
  const activeKey = terminalSourceKey("workflow", workflowId);
  if (!active.has(activeKey)) {
    const promise = processWorkflowTerminalReport(store, workflowId, options)
      .finally(() => active.delete(activeKey));
    active.set(activeKey, promise);
    void promise.catch(() => undefined);
  }
  return undefined;
}

export function maybeScheduleRunTerminalReport(
  store: RunStore,
  runId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): void {
  if (!terminalReportsEnabledForStore(store)) {
    return;
  }
  const run = store.getRun(runId);
  if (!run || !isTerminalRunStatus(run.status) || !runIsEligibleForTerminalReport(store, run)) {
    return;
  }
  const turn = store.getLingTurnForRun(run.id);
  const thread = turn ? store.getLingThread(turn.threadId) : undefined;
  if (turn && thread && (thread.kind === "conversation" || thread.kind === "teammate_direct")) {
    maybeScheduleTurnTerminalReport(store, turn.id, options);
    return;
  }
  scheduleTerminalReport(store, "run", run.id, () => processRunTerminalReport(store, run.id, options));
}

export function maybeScheduleTurnTerminalReport(
  store: RunStore,
  turnId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): void {
  if (!terminalReportsEnabledForStore(store)) {
    return;
  }
  const turn = store.getLingTurn(turnId);
  if (!turn || !isTerminalTurnStatus(turn.status) || !turnIsEligibleForTerminalReport(store, turn.id)) {
    return;
  }
  scheduleTerminalReport(store, "turn", turn.id, () => processTurnTerminalReport(store, turn.id, options));
}

function scheduleTerminalReport(
  store: RunStore,
  sourceKind: "run" | "turn",
  sourceId: string,
  process: () => Promise<ProcessTerminalReportResult | undefined>,
): void {
  const existing = latestCommittedReport(store, sourceKind, sourceId);
  if (existing) {
    return;
  }
  const active = activeMap(store);
  const activeKey = terminalSourceKey(sourceKind, sourceId);
  if (active.has(activeKey)) {
    return;
  }
  const promise = process().finally(() => active.delete(activeKey));
  active.set(activeKey, promise);
  void promise.catch(() => undefined);
}

export async function processWorkflowTerminalReport(
  store: RunStore,
  workflowId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): Promise<ProcessWorkflowTerminalReportResult> {
  reconcileWorkflowFromCanonicalState({
    store,
    workflowId,
    cause: "pre_publication",
    now: options.now ?? new Date().toISOString(),
  });
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  if (workflow.status === "succeeded" && workflow.metadata?.requiredParticipantManifest) {
    const steps = store.listChannelWorkflowSteps({ workflowId, limit: 500 });
    const gate = evaluateWorkflowCompletionGate({
      store,
      workflow,
      steps,
      now: options.now ?? new Date().toISOString(),
    });
    if (gate?.status !== "verified"
      || gate.basisFingerprint !== workflow.metadata.completionGate?.basisFingerprint) {
      throw new Error(`Workflow completion gate is stale or unverified: ${workflowId}`);
    }
  }
  const settings = settingsByStore.get(store);
  const deadlineMs = options.barrierDeadlineMs ?? settings?.barrierDeadlineMs ?? 5_000;
  const pollIntervalMs = options.barrierPollIntervalMs ?? settings?.barrierPollIntervalMs ?? 250;
  const barrier = await waitForWorkflowReportingBarrier(store, workflowId, deadlineMs, pollIntervalMs);
  const now = options.now ?? new Date().toISOString();
  let snapshot = collectWorkflowTerminalReportEvidence(store, workflowId, { generatedAt: now });
  if (barrier.timedOut) {
    snapshot = appendSnapshotRisk(snapshot, {
      id: `terminal-report-barrier-timeout:${workflowId}`,
      severity: "warning",
      status: "unverified",
      summary: snapshot.language === "zh-CN"
        ? "报告等待窗口已结束，部分尾部操作可能尚未形成完整证据。"
        : "The reporting barrier expired; some trailing operations may not have complete evidence.",
      sourceRefs: snapshot.references.filter((ref) => ref.kind === "workflow" && ref.id === workflowId),
    });
  }

  return processTerminalReportSnapshot(store, snapshot, options);
}

export async function processRunTerminalReport(
  store: RunStore,
  runId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): Promise<ProcessTerminalReportResult | undefined> {
  const run = store.getRun(runId);
  if (!run || !runIsEligibleForTerminalReport(store, run)) return undefined;
  const now = options.now ?? new Date().toISOString();
  const snapshot = collectRunTerminalReportEvidence(store, runId, { generatedAt: now });
  if (!terminalSnapshotHasExecutedWork(snapshot)) {
    return undefined;
  }
  return processTerminalReportSnapshot(store, snapshot, options);
}

export async function processTurnTerminalReport(
  store: RunStore,
  turnId: string,
  options: ProcessWorkflowTerminalReportOptions = {},
): Promise<ProcessTerminalReportResult | undefined> {
  if (!turnIsEligibleForTerminalReport(store, turnId)) return undefined;
  const now = options.now ?? new Date().toISOString();
  const snapshot = collectTurnTerminalReportEvidence(store, turnId, { generatedAt: now });
  if (!terminalSnapshotHasExecutedWork(snapshot)) {
    return undefined;
  }
  return processTerminalReportSnapshot(store, snapshot, options);
}

async function processTerminalReportSnapshot(
  store: RunStore,
  snapshot: TerminalReportEvidenceSnapshot,
  options: ProcessWorkflowTerminalReportOptions,
): Promise<ProcessTerminalReportResult> {
  const now = options.now ?? new Date().toISOString();
  const existing = latestCommittedReport(store, snapshot.source.kind, snapshot.source.id);
  if (existing?.report) {
    const message = publishTerminalReportWithInvalidation(store, existing.report, options.linkedRunId, now);
    return { record: store.getTerminalReport(existing.id) ?? existing, message };
  }

  const settings = settingsByStore.get(store);
  const current = latestReport(store, snapshot.source.kind, snapshot.source.id);
  const generation = current?.status === "failed" ? current.generation + 1 : current?.generation ?? 1;
  let draft = current && current.status !== "failed"
    ? current
    : store.createTerminalReportDraft({ generation, evidenceSnapshot: snapshot }, now);
  if (draft.status === "committed" || draft.status === "fallback") {
    const message = draft.report ? publishTerminalReportWithInvalidation(store, draft.report, options.linkedRunId, now) : undefined;
    return { record: store.getTerminalReport(draft.id) ?? draft, message };
  }
  if (draft.status === "failed") {
    throw new Error(`Terminal report generation is already failed: ${draft.id}`);
  }
  if (draft.evidenceFingerprint !== snapshot.evidenceFingerprint) {
    draft = store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: draft.status,
      expectedEvidenceFingerprint: draft.evidenceFingerprint,
      evidenceSnapshot: snapshot,
      status: "validating",
      promptVersion: "terminal-report-fallback-v1",
      now,
    });
  } else if (draft.status === "draft") {
    draft = store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: "draft",
      expectedEvidenceFingerprint: draft.evidenceFingerprint,
      status: "validating",
      promptVersion: "terminal-report-fallback-v1",
      now,
    });
  }

  const workUnit = startReportWorkUnit(store, snapshot, generation, now);
  try {
    const synthesis = await synthesizeTerminalReportContent({
      store,
      snapshot,
      runnerRegistry: settings?.runnerRegistry,
      secretResolver: settings?.secretResolver,
      timeoutMs: settings?.synthesisTimeoutMs,
    });
    const report = synthesis.mode === "model" && synthesis.content
      ? buildModelTerminalReport(snapshot, draft, synthesis.content, {
          providerPresetId: synthesis.providerPresetId,
          model: synthesis.providerModel,
          attemptCount: synthesis.attemptCount,
          validationCodes: synthesis.validationCodes,
          committedAt: now,
        })
      : buildDeterministicTerminalReport(snapshot, {
          id: draft.id,
          promptVersion: TERMINAL_REPORT_PROMPT_VERSION,
          validationCodes: synthesis.validationCodes,
          createdAt: draft.createdAt,
          committedAt: now,
        });
    const committed = store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
      report,
      synthesisMode: report.synthesis.mode,
      promptVersion: report.synthesis.promptVersion,
      attemptCount: report.synthesis.attemptCount,
      validationCodes: report.synthesis.validationCodes,
      now,
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      type: "work_unit_progress",
      actor: "system",
      ts: now,
      data: {
        synthesisMode: report.synthesis.mode,
        providerPresetId: synthesis.providerPresetId ?? null,
        model: synthesis.providerModel ?? null,
        requestedRunnerId: synthesis.requestedRunnerId ?? null,
        effectiveRunnerId: synthesis.effectiveRunnerId ?? null,
        attemptCount: synthesis.attemptCount,
        validationCodes: synthesis.validationCodes,
        fallbackReason: synthesis.fallbackReason ?? null,
        latencyMs: synthesis.latencyMs,
      },
    });
    const message = publishTerminalReportWithInvalidation(store, report, options.linkedRunId, now);
    succeedReportWorkUnit(store, workUnit, committed, message, now);
    return { record: store.getTerminalReport(committed.id) ?? committed, message, workUnit: store.getWorkUnit(workUnit.id) ?? workUnit };
  } catch (error) {
    const currentDraft = store.getTerminalReport(draft.id);
    if (currentDraft && (currentDraft.status === "draft" || currentDraft.status === "validating")) {
      store.failTerminalReport({
        reportId: currentDraft.id,
        errorCode: "terminal_report_fallback_failed",
        now,
      });
    }
    failReportWorkUnit(store, workUnit, error, now);
    throw error;
  }
}

function buildModelTerminalReport(
  snapshot: TerminalReportEvidenceSnapshot,
  draft: LingTerminalReportRecord,
  content: TerminalReportContent,
  metadata: {
    readonly providerPresetId?: string;
    readonly model?: string;
    readonly attemptCount: number;
    readonly validationCodes: readonly string[];
    readonly committedAt: string;
  },
): TerminalReport {
  return {
    schemaVersion: 1,
    id: draft.id,
    workspaceId: snapshot.workspaceId,
    channelId: snapshot.channelId,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    sourceMessageId: snapshot.sourceMessageId,
    source: snapshot.source,
    status: "committed",
    language: snapshot.language,
    evidenceSnapshotId: snapshot.id,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    synthesis: {
      mode: "model",
      model: metadata.model,
      providerPresetId: metadata.providerPresetId,
      promptVersion: TERMINAL_REPORT_PROMPT_VERSION,
      attemptCount: metadata.attemptCount,
      validationCodes: metadata.validationCodes,
    },
    ...content,
    createdAt: draft.createdAt,
    committedAt: metadata.committedAt,
  };
}

export async function recoverTerminalReports(store: RunStore): Promise<void> {
  if (!terminalReportsEnabledForStore(store)) {
    return;
  }
  for (const record of store.listTerminalReports({ limit: 500 })) {
    if (
      terminalReportIsEligibleForDisplay(store, record) &&
      (record.status === "committed" || record.status === "fallback") &&
      record.report
    ) {
      publishTerminalReportWithInvalidation(store, record.report, undefined, new Date().toISOString());
    }
  }
  for (const channel of store.listChannels({ limit: 500 })) {
    for (const workflow of store.listChannelWorkflows({ channelId: channel.id, limit: 500 })) {
      if (workflow.createdAt < TERMINAL_REPORT_ROLLOUT_WATERMARK) {
        continue;
      }
      if (isTerminalWorkflowStatus(workflow.status) && !latestCommittedReport(store, "workflow", workflow.id)) {
        await processWorkflowTerminalReport(store, workflow.id);
      }
    }
  }
  const recoveredTurnIds = new Set<string>();
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    for (const run of store.listRuns({ status, limit: 500 })) {
      if (
        run.createdAt < TERMINAL_REPORT_ROLLOUT_WATERMARK ||
        !runIsEligibleForTerminalReport(store, run)
      ) {
        continue;
      }
      const turn = store.getLingTurnForRun(run.id);
      const thread = turn ? store.getLingThread(turn.threadId) : undefined;
      if (turn && thread && (thread.kind === "conversation" || thread.kind === "teammate_direct")) {
        if (!recoveredTurnIds.has(turn.id) && isTerminalTurnStatus(turn.status) && !latestCommittedReport(store, "turn", turn.id)) {
          recoveredTurnIds.add(turn.id);
          await processTurnTerminalReport(store, turn.id);
        }
        continue;
      }
      if (!latestCommittedReport(store, "run", run.id)) {
        await processRunTerminalReport(store, run.id);
      }
    }
  }
}

export const recoverWorkflowTerminalReports = recoverTerminalReports;

function publishTerminalReportWithInvalidation(
  store: RunStore,
  report: TerminalReport,
  linkedRunId: string | undefined,
  now: string,
): ChannelMessage | undefined {
  const publication = publishTerminalReportPublication({ store, report, linkedRunId, now });
  if (publication?.controlPlaneEvent) {
    try {
      settingsByStore.get(store)?.onPublished?.({ event: publication.controlPlaneEvent });
    } catch {
      // Publication is already canonical. A missed live invalidation must not turn a
      // completed user task into a failure; reconnect/reload still reads durable state.
    }
  }
  return publication?.message;
}

async function waitForWorkflowReportingBarrier(
  store: RunStore,
  workflowId: string,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<{ readonly timedOut: boolean }> {
  const startedAt = Date.now();
  while (!workflowReportingBarrierSettled(store, workflowId)) {
    if (Date.now() - startedAt >= deadlineMs) {
      return { timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { timedOut: false };
}

function workflowReportingBarrierSettled(store: RunStore, workflowId: string): boolean {
  const evidence = buildWorkflowEvidence(store, workflowId);
  if (!isTerminalWorkflowStatus(evidence.workflow.status)) {
    return false;
  }
  if (evidence.steps.some((item) => ["queued", "claimed", "running", "waiting_for_approval"].includes(item.step.status))) {
    return false;
  }
  if (evidence.approvals.some((approval) => approval.status === "pending")) {
    return false;
  }
  return !evidence.actions.some((action) => action.status === "executing" || action.status === "waiting_for_approval");
}

function appendSnapshotRisk(
  snapshot: TerminalReportEvidenceSnapshot,
  risk: TerminalReportEvidenceRisk,
): TerminalReportEvidenceSnapshot {
  const base = {
    ...snapshot,
    risks: [...snapshot.risks, risk],
    evidenceFingerprint: undefined,
  };
  return {
    ...snapshot,
    risks: base.risks,
    evidenceFingerprint: computeTerminalReportEvidenceFingerprint(base),
  };
}

function latestReport(
  store: RunStore,
  sourceKind: "workflow" | "run" | "turn",
  sourceId: string,
): LingTerminalReportRecord | undefined {
  return store.listTerminalReports({ sourceKind, sourceId, limit: 500 })
    .sort((left, right) => right.generation - left.generation)[0];
}

function latestCommittedReport(
  store: RunStore,
  sourceKind: "workflow" | "run" | "turn",
  sourceId: string,
): LingTerminalReportRecord | undefined {
  return store.listTerminalReports({ sourceKind, sourceId, limit: 500 })
    .filter((record) => record.status === "committed" || record.status === "fallback")
    .sort((left, right) => right.generation - left.generation)[0];
}

function startReportWorkUnit(
  store: RunStore,
  snapshot: TerminalReportEvidenceSnapshot,
  generation: number,
  now: string,
): WorkUnit {
  const sourceKind = snapshot.source.kind;
  const sourceId = snapshot.source.id;
  const idempotencyKey = `channel_terminal_report:${sourceKind}:${sourceId}:${generation}`;
  let workUnit = store.findWorkUnitByIdempotency({
    kind: "channel_terminal_report",
    ownerType: sourceKind,
    ownerId: sourceId,
    idempotencyKey,
  });
  if (!workUnit) {
    workUnit = store.createWorkUnit({
      workspaceId: snapshot.workspaceId,
      kind: "channel_terminal_report",
      ownerType: sourceKind,
      ownerId: sourceId,
      channelId: snapshot.channelId,
      idempotencyKey,
      createdByActor: "system",
      request: { sourceKind, sourceId, generation },
      now,
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      type: "work_unit_created",
      actor: "system",
      ts: now,
      data: { kind: "channel_terminal_report", sourceKind, sourceId, generation },
    });
  }
  if (workUnit.status === "failed" || workUnit.status === "stale") {
    store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: workUnit.status,
      event: "retry",
      actor: "system",
      now,
    });
    workUnit = store.getWorkUnit(workUnit.id) ?? workUnit;
  }
  if (workUnit.status === "queued") {
    store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "queued", event: "claim", actor: "system", now });
    workUnit = store.getWorkUnit(workUnit.id) ?? workUnit;
  }
  if (workUnit.status === "claimed") {
    store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "claimed", event: "runner_started", actor: "system", now, startedAt: now });
    workUnit = store.getWorkUnit(workUnit.id) ?? workUnit;
  }
  return workUnit;
}

function succeedReportWorkUnit(
  store: RunStore,
  workUnit: WorkUnit,
  report: LingTerminalReportRecord,
  message: ChannelMessage | undefined,
  now: string,
): void {
  if (workUnit.status !== "running" && workUnit.status !== "waiting_for_approval") {
    return;
  }
  store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: workUnit.status,
    event: "runner_succeeded",
    actor: "system",
    now,
    endedAt: now,
  });
  store.appendRuntimeEvent({
    workUnitId: workUnit.id,
    type: "work_unit_succeeded",
    actor: "system",
    ts: now,
    data: { reportId: report.id, publishedMessageId: message?.id ?? null },
  });
}

function failReportWorkUnit(store: RunStore, workUnit: WorkUnit, error: unknown, now: string): void {
  if (workUnit.status !== "running" && workUnit.status !== "claimed" && workUnit.status !== "queued") {
    return;
  }
  store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: workUnit.status,
    event: "runner_failed",
    actor: "system",
    now,
    endedAt: now,
    errorCode: "terminal_report_failed",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  store.appendRuntimeEvent({
    workUnitId: workUnit.id,
    type: "work_unit_failed",
    actor: "system",
    ts: now,
    data: { error: error instanceof Error ? error.message : String(error) },
  });
}

function activeMap(store: RunStore): Map<string, Promise<ProcessTerminalReportResult | undefined>> {
  const existing = activeByStore.get(store);
  if (existing) {
    return existing;
  }
  const created = new Map<string, Promise<ProcessTerminalReportResult | undefined>>();
  activeByStore.set(store, created);
  return created;
}

function isTerminalWorkflowStatus(status: string): boolean {
  return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled";
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalTurnStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "blocked";
}

function terminalSnapshotHasExecutedWork(snapshot: TerminalReportEvidenceSnapshot): boolean {
  return snapshot.operations.length > 0 ||
    snapshot.checks.length > 0 ||
    snapshot.artifacts.length > 0 ||
    snapshot.approvals.length > 0 ||
    snapshot.steps.some((step) => step.changedPaths.length > 0 || step.artifactIds.length > 0);
}

function terminalSourceKey(sourceKind: "workflow" | "run" | "turn", sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}
