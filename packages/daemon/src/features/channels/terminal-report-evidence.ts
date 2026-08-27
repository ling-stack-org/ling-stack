import {
  computeTerminalReportEvidenceFingerprint,
  createTerminalReportSnapshotId,
  validateTerminalReportEvidenceSnapshot,
  type ApprovalRequest,
  type ChannelWorkflowStep,
  type ExecutionAction,
  type LingTurn,
  type RunArtifact,
  type RunSession,
  type RunStore,
  type TerminalReportArtifactKind,
  type TerminalReportEvidenceApproval,
  type TerminalReportEvidenceArtifact,
  type TerminalReportEvidenceCheck,
  type TerminalReportEvidenceOperation,
  type TerminalReportEvidenceParticipant,
  type TerminalReportEvidenceRisk,
  type TerminalReportEvidenceSnapshot,
  type TerminalReportEvidenceStep,
  type TerminalReportLanguage,
  type TerminalReportOutcomeStatus,
  type TerminalReportParticipantStatus,
  type TerminalReportSourceRef,
  type TerminalReportSurface,
} from "@ling-stack/core";
import { listAllExecutionActionsForRun } from "../runs/execution-actions.js";
import { redactEvidenceText } from "./context-processing/evidence.js";
import { inferUserLanguage } from "./response-language.js";
import { buildWorkflowEvidence } from "./workflow-evidence.js";
import { extractWorkflowStepChangedPaths } from "./workflow-step-packets.js";

export interface TerminalReportEvidenceBudgets {
  readonly steps: number;
  readonly operations: number;
  readonly checks: number;
  readonly artifacts: number;
  readonly participants: number;
  readonly approvals: number;
  readonly risks: number;
  readonly summaryCharacters: number;
}

export interface TerminalReportEvidenceCollectionOptions {
  readonly generatedAt?: string;
  readonly language?: TerminalReportLanguage;
  readonly budgets?: Partial<TerminalReportEvidenceBudgets>;
}

const DEFAULT_BUDGETS: TerminalReportEvidenceBudgets = {
  steps: 100,
  operations: 200,
  checks: 100,
  artifacts: 100,
  participants: 20,
  approvals: 100,
  risks: 50,
  summaryCharacters: 2_000,
};

type WorkflowEvidence = ReturnType<typeof buildWorkflowEvidence>;

export function collectWorkflowTerminalReportEvidence(
  store: RunStore,
  workflowId: string,
  options: TerminalReportEvidenceCollectionOptions = {},
): TerminalReportEvidenceSnapshot {
  const evidence = buildWorkflowEvidence(store, workflowId);
  const terminalState = workflowTerminalState(evidence.workflow.status);
  const language = options.language ?? evidence.workflow.metadata?.responseLanguage ?? "en-US";
  const budgets = resolveBudgets(options.budgets);
  const sourceRef = sourceRefFor("workflow", evidence.workflow.id, evidence.workflow.title);
  const packetArtifactIds = new Set(evidence.steps.flatMap((item) => item.packetArtifacts.map((artifact) => artifact.id)));
  const runCwds = new Map(evidence.steps.flatMap((item) => item.linkedRun ? [[item.linkedRun.id, item.linkedRun.cwd] as const] : []));
  const workspaceFileRefsByArtifactId = collectWorkspaceFileRefsByArtifactId(evidence.actions, runCwds);
  const artifacts = evidence.artifacts.map((artifact) => mapArtifact(
    artifact,
    packetArtifactIds.has(artifact.id),
    workspaceFileRefsByArtifactId.get(artifact.id) ?? [],
  ));
  const artifactsById = new Map(evidence.artifacts.map((artifact) => [artifact.id, artifact]));
  const steps = evidence.steps
    .filter((item) => workflowStepHasActivity(item))
    .map((item) => mapWorkflowStep(item, budgets.summaryCharacters));
  const operations = evidence.actions.map((action) => mapOperation(
    action,
    artifactsById,
    budgets.summaryCharacters,
    action.runId ? runCwds.get(action.runId) : undefined,
  ));
  const checks = evidence.actions
    .filter(isCheckAction)
    .map((action) => mapCheck(action, budgets.summaryCharacters));
  const approvals = evidence.approvals.map(mapApproval);
  const participants = aggregateWorkflowParticipants(store, evidence, budgets.summaryCharacters);
  const risks = collectWorkflowRisks(evidence, checks, budgets.summaryCharacters);

  return finalizeSnapshot({
    workspaceId: evidence.workflow.workspaceId,
    surface: "channel",
    channelId: evidence.workflow.channelId,
    sourceMessageId: evidence.workflow.metadata?.sourceMessageId,
    source: { kind: "workflow", id: evidence.workflow.id },
    objective: boundedText(evidence.workflow.objective || evidence.workflow.title, budgets.summaryCharacters),
    language,
    terminalState,
    terminalAt: evidence.workflow.updatedAt,
    steps,
    operations,
    checks,
    participants,
    artifacts,
    approvals,
    risks,
    references: [
      sourceRef,
      ...(evidence.workflow.metadata?.sourceMessageId
        ? [sourceRefFor("message", evidence.workflow.metadata.sourceMessageId, "Source message")]
        : []),
    ],
  }, options, budgets, sourceRef);
}

export function collectRunTerminalReportEvidence(
  store: RunStore,
  runId: string,
  options: TerminalReportEvidenceCollectionOptions = {},
): TerminalReportEvidenceSnapshot {
  const run = store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found for terminal report evidence: ${runId}`);
  }
  const terminalState = runTerminalState(run.status);
  const turn = store.getLingTurnForRun(run.id);
  const thread = turn ? store.getLingThread(turn.threadId) : run.threadId ? store.getLingThread(run.threadId) : undefined;
  const task = store.getTask(run.taskId);
  const budgets = resolveBudgets(options.budgets);
  const sourceRef = sourceRefFor("run", run.id, task?.title ?? turn?.title ?? "Run");
  const artifactsRaw = store.listArtifacts(run.id);
  const actions = listAllExecutionActionsForRun(store, run.id);
  const approvalsRaw = store.listApprovalRequests({ runId: run.id, complete: true });
  const artifactsById = new Map(artifactsRaw.map((artifact) => [artifact.id, artifact]));
  const workspaceFileRefsByArtifactId = collectWorkspaceFileRefsByArtifactId(actions, new Map([[run.id, run.cwd]]));
  const changedPaths = changedPathsFromActions(actions, run.cwd);
  const teammate = run.teammateId ? store.getAiTeammate(run.teammateId) : undefined;
  const workflowStep = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const rejectedContext = workflowStepResultContextRejected(workflowStep);
  const resultSummary = rejectedContext
    ? undefined
    : readRunAssistantSummary(store, run.id, budgets.summaryCharacters) ?? run.errorMessage;

  return finalizeSnapshot({
    workspaceId: turn?.workspaceId ?? thread?.workspaceId ?? "workspace_default",
    surface: surfaceForThread(thread?.kind, run.channelId),
    channelId: run.channelId ?? turn?.channelId ?? thread?.channelId,
    threadId: turn?.threadId ?? run.threadId,
    turnId: turn?.id,
    sourceMessageId: turn?.sourceItemId,
    source: { kind: "run", id: run.id },
    objective: boundedText(workflowStep?.prompt || task?.prompt || task?.title || turn?.userInstruction || turn?.title || "Complete the run.", budgets.summaryCharacters),
    language: options.language ?? languageForRun(run, turn?.userInstruction ?? task?.prompt ?? task?.title) ?? "en-US",
    terminalState,
    terminalAt: run.endedAt ?? run.updatedAt,
    steps: [{
      id: `run-step:${run.id}`,
      title: redactEvidenceText(task?.title ?? turn?.title ?? "Run"),
      status: runStepStatus(run.status),
      teammateId: run.teammateId,
      runId: run.id,
      resultSummary: resultSummary ? boundedText(resultSummary, budgets.summaryCharacters) : undefined,
      blocker: run.errorMessage ? boundedText(run.errorMessage, budgets.summaryCharacters) : undefined,
      changedPaths,
      artifactIds: artifactsRaw.map((artifact) => artifact.id),
      sourceRefs: uniqueRefs([sourceRef, ...artifactsRaw.map((artifact) => artifactRef(artifact))]),
    }],
    operations: actions.map((action) => mapOperation(action, artifactsById, budgets.summaryCharacters, run.cwd)),
    checks: actions.filter(isCheckAction).map((action) => mapCheck(action, budgets.summaryCharacters)),
    participants: run.teammateId && runHasAgentActivity(store, run) ? [{
      agentId: run.teammateId,
      displayName: teammate?.displayName ?? run.teammateId,
      roleKey: teammate?.roleKey,
      status: participantStatusForRun(run.status),
      workflowStepIds: run.workflowStepId ? [run.workflowStepId] : [],
      runIds: [run.id],
      contributionSummaries: resultSummary ? [boundedText(resultSummary, budgets.summaryCharacters)] : [],
      sourceRefs: [sourceRef],
    }] : [],
    artifacts: artifactsRaw.map((artifact) => mapArtifact(
      artifact,
      false,
      workspaceFileRefsByArtifactId.get(artifact.id) ?? [],
    )),
    approvals: approvalsRaw.map(mapApproval),
    risks: collectRunRisks(run, actions, approvalsRaw, sourceRef, budgets.summaryCharacters),
    references: [
      sourceRef,
      ...(turn ? [sourceRefFor("turn", turn.id, turn.title)] : []),
      ...(turn?.sourceItemId ? [sourceRefFor("conversation_item", turn.sourceItemId, "Source item")] : []),
    ],
  }, options, budgets, sourceRef);
}

export function collectTurnTerminalReportEvidence(
  store: RunStore,
  turnId: string,
  options: TerminalReportEvidenceCollectionOptions = {},
): TerminalReportEvidenceSnapshot {
  const turn = store.getLingTurn(turnId);
  if (!turn) {
    throw new Error(`Ling turn not found for terminal report evidence: ${turnId}`);
  }
  const terminalState = turnTerminalState(turn.status);
  const thread = store.getLingThread(turn.threadId);
  const budgets = resolveBudgets(options.budgets);
  const runLinks = store.listLingTurnRuns(turn.id);
  const runs = runLinks
    .map((link) => store.getRun(link.runId))
    .filter((run): run is RunSession => Boolean(run));
  const artifactsRaw = uniqueById(runs.flatMap((run) => store.listArtifacts(run.id)));
  const actions = uniqueById(runs.flatMap((run) => listAllExecutionActionsForRun(store, run.id)));
  const approvalsRaw = uniqueById(runs.flatMap((run) => store.listApprovalRequests({ runId: run.id, complete: true })));
  const artifactsById = new Map(artifactsRaw.map((artifact) => [artifact.id, artifact]));
  const runCwds = new Map(runs.map((run) => [run.id, run.cwd] as const));
  const workspaceFileRefsByArtifactId = collectWorkspaceFileRefsByArtifactId(actions, runCwds);
  const sourceRef = sourceRefFor("turn", turn.id, turn.title);
  const participants = aggregateRunParticipants(store, runs, budgets.summaryCharacters);

  return finalizeSnapshot({
    workspaceId: turn.workspaceId,
    surface: surfaceForThread(thread?.kind, turn.channelId),
    channelId: turn.channelId ?? thread?.channelId,
    threadId: turn.threadId,
    turnId: turn.id,
    sourceMessageId: turn.sourceItemId,
    source: { kind: "turn", id: turn.id },
    objective: boundedText(turn.userInstruction || turn.title, budgets.summaryCharacters),
    language: options.language ?? runs.map((run) => languageForRun(run, turn.userInstruction)).find(Boolean) ?? inferUserLanguage(turn.userInstruction),
    terminalState,
    terminalAt: turn.completedAt ?? turn.updatedAt,
    steps: runs.map((run, index) => mapTurnRunStep(
      store,
      turn,
      run,
      index,
      budgets.summaryCharacters,
      actions.filter((action) => action.runId === run.id),
    )),
    operations: actions.map((action) => mapOperation(
      action,
      artifactsById,
      budgets.summaryCharacters,
      action.runId ? runCwds.get(action.runId) : undefined,
    )),
    checks: actions.filter(isCheckAction).map((action) => mapCheck(action, budgets.summaryCharacters)),
    participants,
    artifacts: artifactsRaw.map((artifact) => mapArtifact(
      artifact,
      false,
      workspaceFileRefsByArtifactId.get(artifact.id) ?? [],
    )),
    approvals: approvalsRaw.map(mapApproval),
    risks: collectTurnRisks(turn, runs, actions, approvalsRaw, sourceRef, budgets.summaryCharacters),
    references: [
      sourceRef,
      ...(turn.sourceItemId ? [sourceRefFor("conversation_item", turn.sourceItemId, "Source item")] : []),
      ...runs.map((run) => sourceRefFor("run", run.id, store.getTask(run.taskId)?.title ?? "Run")),
    ],
  }, options, budgets, sourceRef);
}

function finalizeSnapshot(
  input: Omit<TerminalReportEvidenceSnapshot, "schemaVersion" | "id" | "evidenceFingerprint" | "generatedAt">,
  options: TerminalReportEvidenceCollectionOptions,
  budgets: TerminalReportEvidenceBudgets,
  sourceRef: TerminalReportSourceRef,
): TerminalReportEvidenceSnapshot {
  const truncationRisks: TerminalReportEvidenceRisk[] = [];
  const steps = boundedItems(input.steps, budgets.steps, "steps", truncationRisks, sourceRef, input.language);
  const operations = boundedItems(input.operations, budgets.operations, "operations", truncationRisks, sourceRef, input.language);
  const checks = boundedItems(input.checks, budgets.checks, "checks", truncationRisks, sourceRef, input.language);
  const participants = boundedItems(input.participants, budgets.participants, "participants", truncationRisks, sourceRef, input.language);
  const artifacts = boundedItems(input.artifacts, budgets.artifacts, "artifacts", truncationRisks, sourceRef, input.language);
  const approvals = boundedItems(input.approvals, budgets.approvals, "approvals", truncationRisks, sourceRef, input.language);
  const risks = [...input.risks, ...truncationRisks].slice(0, budgets.risks);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const base: Omit<TerminalReportEvidenceSnapshot, "evidenceFingerprint"> = {
    schemaVersion: 1,
    id: createTerminalReportSnapshotId(),
    workspaceId: input.workspaceId,
    surface: input.surface,
    channelId: input.channelId,
    threadId: input.threadId,
    turnId: input.turnId,
    sourceMessageId: input.sourceMessageId,
    source: input.source,
    objective: input.objective,
    language: input.language,
    terminalState: input.terminalState,
    terminalAt: input.terminalAt,
    steps,
    operations,
    checks,
    participants,
    artifacts,
    approvals,
    risks,
    references: uniqueRefs([
      ...input.references,
      ...steps.flatMap((item) => item.sourceRefs),
      ...operations.flatMap((item) => item.sourceRefs),
      ...checks.flatMap((item) => item.sourceRefs),
      ...participants.flatMap((item) => item.sourceRefs),
      ...artifacts.flatMap((item) => item.sourceRefs),
      ...approvals.flatMap((item) => item.sourceRefs),
      ...risks.flatMap((item) => item.sourceRefs),
    ]),
    generatedAt,
  };
  const snapshot: TerminalReportEvidenceSnapshot = {
    ...base,
    evidenceFingerprint: computeTerminalReportEvidenceFingerprint(base),
  };
  const validation = validateTerminalReportEvidenceSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Collected invalid terminal report evidence: ${validation.issues.map((item) => item.code).join(", ")}`);
  }
  return snapshot;
}

function mapWorkflowStep(item: WorkflowEvidence["steps"][number], maxCharacters: number): TerminalReportEvidenceStep {
  const step = item.step;
  const status = workflowStepTerminalStatus(step.status);
  if (!status) {
    throw new Error(`Workflow step is not terminal: ${step.id} (${step.status})`);
  }
  const changedPaths = uniqueStrings(item.outputPacket?.changedPaths ?? []).map((path) => redactEvidenceText(path));
  const rejectedContext = workflowStepResultContextRejected(step);
  return {
    id: step.id,
    title: boundedText(step.title, maxCharacters),
    status,
    teammateId: step.toParticipantId,
    runId: step.runId,
    resultSummary: rejectedContext ? undefined : step.resultSummary ? boundedText(step.resultSummary, maxCharacters) : item.outputPacket?.resultSummary ? boundedText(item.outputPacket.resultSummary, maxCharacters) : undefined,
    blocker: step.blocker ? boundedText(step.blocker, maxCharacters) : undefined,
    changedPaths,
    artifactIds: uniqueStrings([
      ...(item.outputPacket?.artifactIds ?? []),
      ...item.linkedArtifacts.map((artifact) => artifact.id),
    ]),
    sourceRefs: uniqueRefs([
      sourceRefFor("workflow_step", step.id, step.title),
      ...(step.runId ? [sourceRefFor("run", step.runId, step.title)] : []),
      ...item.linkedArtifacts.map((artifact) => artifactRef(artifact)),
    ]),
  };
}

function mapTurnRunStep(
  store: RunStore,
  turn: LingTurn,
  run: RunSession,
  index: number,
  maxCharacters: number,
  actions: readonly ExecutionAction[],
): TerminalReportEvidenceStep {
  const task = store.getTask(run.taskId);
  const artifacts = store.listArtifacts(run.id);
  const summary = readRunEvidenceContribution(store, run, maxCharacters)
    ?? readRunAssistantSummary(store, run.id, maxCharacters)
    ?? run.errorMessage;
  return {
    id: `turn-run:${turn.id}:${index + 1}:${run.id}`,
    title: boundedText(task?.title ?? `${turn.title} (${index + 1})`, maxCharacters),
    status: runStepStatus(run.status),
    teammateId: run.teammateId,
    runId: run.id,
    resultSummary: summary ? boundedText(summary, maxCharacters) : undefined,
    blocker: run.errorMessage ? boundedText(run.errorMessage, maxCharacters) : undefined,
    changedPaths: changedPathsFromActions(actions, run.cwd),
    artifactIds: artifacts.map((artifact) => artifact.id),
    sourceRefs: uniqueRefs([
      sourceRefFor("turn", turn.id, turn.title),
      sourceRefFor("run", run.id, task?.title ?? "Run"),
      ...artifacts.map((artifact) => artifactRef(artifact)),
    ]),
  };
}

function mapOperation(
  action: ExecutionAction,
  artifactsById: ReadonlyMap<string, RunArtifact>,
  maxCharacters: number,
  cwd?: string,
): TerminalReportEvidenceOperation {
  const changedPaths = operationKind(action) === "edit" ? changedPathsFromActions([action], cwd) : [];
  const title = action.summary && action.summary !== action.title
    ? `${action.title}: ${action.summary}`
    : action.title;
  return {
    id: action.id,
    kind: operationKind(action),
    title: boundedText(title, maxCharacters),
    status: operationStatus(action.status),
    runId: action.runId,
    changedPaths,
    sourceRefs: uniqueRefs([
      sourceRefFor("operation", action.id, action.title),
      ...(action.runId ? [sourceRefFor("run", action.runId, "Operation run")] : []),
      ...action.resultArtifactIds
        .map((id) => artifactsById.get(id))
        .filter((artifact): artifact is RunArtifact => Boolean(artifact))
        .map((artifact) => artifactRef(artifact)),
      ...action.targetRefs.map(targetRefToSourceRef).filter((ref): ref is TerminalReportSourceRef => Boolean(ref)),
    ]),
  };
}

function mapCheck(action: ExecutionAction, maxCharacters: number): TerminalReportEvidenceCheck {
  return {
    id: action.id,
    title: boundedText(action.title || "Verification", maxCharacters),
    status: action.status === "succeeded" ? "passed"
      : action.status === "failed" ? "failed"
        : action.status === "cancelled" ? "cancelled"
          : action.status === "denied" || action.status === "expired" ? "blocked"
            : "unknown",
    command: boundedText(action.summary, maxCharacters),
    summary: action.status === "succeeded" ? "Command completed successfully."
      : action.status === "failed" ? "Command failed."
        : undefined,
    runId: action.runId,
    sourceRefs: uniqueRefs([
      sourceRefFor("check", action.id, action.title),
      sourceRefFor("operation", action.id, action.title),
      ...(action.runId ? [sourceRefFor("run", action.runId, "Verification run")] : []),
    ]),
  };
}

function mapArtifact(
  artifact: RunArtifact,
  folded: boolean,
  workspaceFileRefs: readonly TerminalReportSourceRef[],
): TerminalReportEvidenceArtifact {
  const ref = artifactRef(artifact, folded || artifact.type === "log");
  return {
    id: artifact.id,
    kind: artifactKind(artifact),
    title: redactEvidenceText(artifact.title?.trim() || artifact.path),
    path: redactEvidenceText(artifact.path),
    changedPaths: workspaceFileRefs.map((ref) => redactEvidenceText(ref.id)),
    status: "created",
    sourceRefs: uniqueRefs([
      ref,
      ...(artifact.runId ? [sourceRefFor("run", artifact.runId, "Artifact run")] : []),
      ...workspaceFileRefs,
    ]),
  };
}

function collectWorkspaceFileRefsByArtifactId(
  actions: readonly ExecutionAction[],
  runCwds: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly TerminalReportSourceRef[]> {
  const refsByArtifactId = new Map<string, TerminalReportSourceRef[]>();
  for (const action of actions) {
    if (operationKind(action) !== "edit" || action.status !== "succeeded") {
      continue;
    }
    const fileRefs = changedPathsFromActions([action], action.runId ? runCwds.get(action.runId) : undefined)
      .map((path) => sourceRefFor("file", path, path));
    if (fileRefs.length === 0) {
      continue;
    }
    for (const artifactId of action.resultArtifactIds) {
      refsByArtifactId.set(artifactId, uniqueRefs([
        ...(refsByArtifactId.get(artifactId) ?? []),
        ...fileRefs,
      ]));
    }
  }
  return refsByArtifactId;
}

function mapApproval(approval: ApprovalRequest): TerminalReportEvidenceApproval {
  return {
    id: approval.id,
    title: redactEvidenceText(approval.title),
    actionType: approval.actionType,
    status: approval.status,
    sourceRefs: uniqueRefs([
      sourceRefFor("approval", approval.id, approval.title),
      ...(approval.runId ? [sourceRefFor("run", approval.runId, "Approval run")] : []),
      ...(approval.workflowStepId ? [sourceRefFor("workflow_step", approval.workflowStepId, "Approval workflow step")] : []),
    ]),
  };
}

function aggregateWorkflowParticipants(
  store: RunStore,
  evidence: WorkflowEvidence,
  maxCharacters: number,
): TerminalReportEvidenceParticipant[] {
  const rows = evidence.steps
    .filter((item) => item.linkedRun && runHasAgentActivity(store, item.linkedRun))
    .map((item) => ({
      agentId: item.step.toParticipantId,
      displayName: item.step.toParticipantLabel,
      workflowStepId: item.step.id,
      runId: item.step.runId,
      status: participantStatusForStep(item.step.status),
      summary: workflowStepResultContextRejected(item.step)
        ? undefined
        : (item.linkedRun
          ? readRunEvidenceContribution(store, item.linkedRun, maxCharacters)
          : undefined)
          ?? item.step.resultSummary
          ?? item.outputPacket?.resultSummary,
      sourceRefs: uniqueRefs([
        sourceRefFor("workflow_step", item.step.id, item.step.title),
        ...(item.step.runId ? [sourceRefFor("run", item.step.runId, item.step.title)] : []),
      ]),
    }));
  const byAgent = new Map<string, TerminalReportEvidenceParticipant>();
  for (const row of rows) {
    const teammate = store.getAiTeammate(row.agentId);
    const existing = byAgent.get(row.agentId);
    byAgent.set(row.agentId, {
      agentId: row.agentId,
      displayName: teammate?.displayName ?? row.displayName ?? row.agentId,
      roleKey: teammate?.roleKey,
      status: row.status,
      workflowStepIds: uniqueStrings([...(existing?.workflowStepIds ?? []), row.workflowStepId]),
      runIds: uniqueStrings([...(existing?.runIds ?? []), row.runId]),
      contributionSummaries: uniqueStrings([
        ...(existing?.contributionSummaries ?? []),
        row.summary ? boundedText(row.summary, maxCharacters) : undefined,
      ]),
      sourceRefs: uniqueRefs([...(existing?.sourceRefs ?? []), ...row.sourceRefs]),
    });
  }
  return [...byAgent.values()];
}

function workflowStepResultContextRejected(step: ChannelWorkflowStep | undefined): boolean {
  const status = step?.metadata?.resultContextReview?.status;
  return status === "rejected_stale" || status === "rejected_private_leak";
}

function aggregateRunParticipants(
  store: RunStore,
  runs: readonly RunSession[],
  maxCharacters: number,
): TerminalReportEvidenceParticipant[] {
  const byAgent = new Map<string, TerminalReportEvidenceParticipant>();
  for (const run of runs) {
    if (!run.teammateId || !runHasAgentActivity(store, run)) {
      continue;
    }
    const teammate = store.getAiTeammate(run.teammateId);
    const existing = byAgent.get(run.teammateId);
    const summary = readRunEvidenceContribution(store, run, maxCharacters)
      ?? readRunAssistantSummary(store, run.id, maxCharacters)
      ?? run.errorMessage;
    byAgent.set(run.teammateId, {
      agentId: run.teammateId,
      displayName: teammate?.displayName ?? run.teammateId,
      roleKey: teammate?.roleKey,
      status: participantStatusForRun(run.status),
      workflowStepIds: uniqueStrings([...(existing?.workflowStepIds ?? []), run.workflowStepId]),
      runIds: uniqueStrings([...(existing?.runIds ?? []), run.id]),
      contributionSummaries: uniqueStrings([...(existing?.contributionSummaries ?? []), summary ? boundedText(summary, maxCharacters) : undefined]),
      sourceRefs: uniqueRefs([...(existing?.sourceRefs ?? []), sourceRefFor("run", run.id, "Participant run")]),
    });
  }
  return [...byAgent.values()];
}

function collectWorkflowRisks(
  evidence: WorkflowEvidence,
  checks: readonly TerminalReportEvidenceCheck[],
  maxCharacters: number,
): TerminalReportEvidenceRisk[] {
  const risks: TerminalReportEvidenceRisk[] = [];
  for (const item of evidence.steps) {
    for (const diagnostic of item.diagnostics) {
      if (diagnostic.severity === "info") {
        continue;
      }
      risks.push({
        id: `workflow-diagnostic:${item.step.id}:${diagnostic.kind}`,
        severity: diagnostic.severity === "critical" ? "critical" : "warning",
        status: item.step.status === "failed" || item.step.status === "blocked" ? "unresolved" : "unverified",
        summary: boundedText(diagnostic.message, maxCharacters),
        sourceRefs: [sourceRefFor("workflow_step", item.step.id, item.step.title)],
      });
    }
  }
  for (const check of checks.filter((item) => item.status === "failed" || item.status === "unknown" || item.status === "not_run")) {
    risks.push({
      id: `workflow-check:${check.id}`,
      severity: check.status === "failed" ? "critical" : "warning",
      status: check.status === "failed" ? "unresolved" : "unverified",
      summary: check.summary ?? `${check.title} was not verified successfully.`,
      sourceRefs: check.sourceRefs,
    });
  }
  for (const approval of evidence.approvals.filter((item) => item.status !== "approved")) {
    risks.push(approvalRisk(approval, maxCharacters));
  }
  return uniqueById(risks);
}

function collectRunRisks(
  run: RunSession,
  actions: readonly ExecutionAction[],
  approvals: readonly ApprovalRequest[],
  sourceRef: TerminalReportSourceRef,
  maxCharacters: number,
): TerminalReportEvidenceRisk[] {
  const risks: TerminalReportEvidenceRisk[] = [];
  if (run.status === "failed" || run.errorMessage) {
    risks.push({
      id: `run-failure:${run.id}`,
      severity: "critical",
      status: "unresolved",
      summary: boundedText(run.errorMessage ?? "Run failed.", maxCharacters),
      sourceRefs: [sourceRef],
    });
  }
  for (const action of actions.filter((item) => item.status === "failed")) {
    risks.push({
      id: `action-failure:${action.id}`,
      severity: "critical",
      status: "unresolved",
      summary: boundedText(`${action.title}: ${action.summary}`, maxCharacters),
      sourceRefs: [sourceRefFor("operation", action.id, action.title)],
    });
  }
  for (const approval of approvals.filter((item) => item.status !== "approved")) {
    risks.push(approvalRisk(approval, maxCharacters));
  }
  return uniqueById(risks);
}

function collectTurnRisks(
  turn: LingTurn,
  runs: readonly RunSession[],
  actions: readonly ExecutionAction[],
  approvals: readonly ApprovalRequest[],
  sourceRef: TerminalReportSourceRef,
  maxCharacters: number,
): TerminalReportEvidenceRisk[] {
  const risks = runs.flatMap((run) => collectRunRisks(
    run,
    actions.filter((action) => action.runId === run.id),
    approvals.filter((approval) => approval.runId === run.id),
    sourceRefFor("run", run.id, turn.title),
    maxCharacters,
  ));
  if (turn.status === "blocked") {
    risks.push({
      id: `turn-blocked:${turn.id}`,
      severity: "warning",
      status: "unresolved",
      summary: "The turn is blocked.",
      sourceRefs: [sourceRef],
    });
  }
  return uniqueById(risks);
}

function approvalRisk(approval: ApprovalRequest, maxCharacters: number): TerminalReportEvidenceRisk {
  return {
    id: `approval-risk:${approval.id}`,
    severity: approval.status === "denied" ? "critical" : "warning",
    status: approval.status === "cancelled" ? "accepted" : approval.status === "pending" ? "unverified" : "unresolved",
    summary: boundedText(`${approval.title}: ${approval.status}`, maxCharacters),
    sourceRefs: [sourceRefFor("approval", approval.id, approval.title)],
  };
}

function workflowStepHasActivity(item: WorkflowEvidence["steps"][number]): boolean {
  return Boolean(
    item.step.runId ||
    item.step.resultSummary ||
    item.step.blocker ||
    item.outputPacket ||
    item.linkedArtifacts.length > 0 ||
    ["succeeded", "failed", "blocked", "cancelled"].includes(item.step.status),
  ) && item.step.status !== "skipped";
}

function runHasAgentActivity(store: RunStore, run: RunSession): boolean {
  if (run.startedAt) {
    return true;
  }
  return store.listEvents(run.id, { limit: 1_000 }).some((event) =>
    event.type === "run_start" ||
    event.type === "turn_start" ||
    event.type === "assistant_text_delta" ||
    event.type === "assistant_thinking_delta" ||
    event.type === "tool_hydration_request" ||
    event.type === "tool_hydration_end" ||
    event.type === "tool_start" ||
    event.type === "tool_update" ||
    event.type === "tool_end" ||
    event.type === "approval_requested" ||
    event.type === "artifact_created"
  );
}

function isCheckAction(action: ExecutionAction): boolean {
  if (action.actionType !== "bash") {
    return false;
  }
  const command = action.summary.trim().toLowerCase();
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build|check)(?:\s|$)/u.test(command) ||
    /(?:^|\s)(?:pytest|vitest|jest|tsc|eslint|cargo\s+test|go\s+test)(?:\s|$)/u.test(command);
}

function operationKind(action: ExecutionAction): TerminalReportEvidenceOperation["kind"] {
  if (action.actionType === "read") {
    return "read";
  }
  if (action.actionType === "grep" || action.actionType === "find" || action.actionType === "ls") {
    return "search";
  }
  if (action.actionType === "edit" || action.actionType === "write") {
    return "edit";
  }
  if (action.actionType === "bash" || action.actionType === "git_commit" || action.actionType === "git_push") {
    return isCheckAction(action) ? "check" : "command";
  }
  if (action.actionType === "runtime_permission_request") {
    return "approval";
  }
  if (action.actionType === "external_send" || action.actionType === "deploy" || action.actionType === "mcp_tool_call") {
    return "external";
  }
  return "other";
}

function operationStatus(status: ExecutionAction["status"]): TerminalReportEvidenceOperation["status"] {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "waiting_for_approval" || status === "denied" || status === "expired") {
    return "blocked";
  }
  return "unknown";
}

function workflowTerminalState(status: WorkflowEvidence["workflow"]["status"]): TerminalReportOutcomeStatus {
  if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "blocked") {
    return status;
  }
  throw new Error(`Workflow is not terminal for terminal report evidence: ${status}`);
}

function workflowStepTerminalStatus(status: WorkflowEvidence["steps"][number]["step"]["status"]): TerminalReportEvidenceStep["status"] | undefined {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled" || status === "skipped"
    ? status
    : undefined;
}

function runTerminalState(status: RunSession["status"]): TerminalReportOutcomeStatus {
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  throw new Error(`Run is not terminal for terminal report evidence: ${status}`);
}

function turnTerminalState(status: LingTurn["status"]): TerminalReportOutcomeStatus {
  if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "blocked") {
    return status;
  }
  if (status === "superseded") {
    return "cancelled";
  }
  throw new Error(`Ling turn is not terminal for terminal report evidence: ${status}`);
}

function runStepStatus(status: RunSession["status"]): TerminalReportEvidenceStep["status"] {
  return runTerminalState(status) as TerminalReportEvidenceStep["status"];
}

function participantStatusForStep(status: WorkflowEvidence["steps"][number]["step"]["status"]): TerminalReportParticipantStatus {
  if (status === "succeeded") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "skipped") {
    return "cancelled";
  }
  return "blocked";
}

function participantStatusForRun(status: RunSession["status"]): TerminalReportParticipantStatus {
  if (status === "succeeded") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "blocked";
}

function artifactKind(artifact: RunArtifact): TerminalReportArtifactKind {
  if (artifact.type === "file") {
    return "file";
  }
  if (artifact.type === "diff") {
    return "diff";
  }
  if (artifact.type === "markdown") {
    return "document";
  }
  if (artifact.type === "image") {
    return "image";
  }
  return "other";
}

function artifactRef(artifact: RunArtifact, folded = false): TerminalReportSourceRef {
  const shouldFold = folded || artifact.type === "log";
  return sourceRefFor(
    "artifact",
    artifact.id,
    artifact.title?.trim() || artifact.path,
    shouldFold ? "folded_evidence" : "conversation",
    artifact.type === "log" ? "secret_adjacent" : "normal",
  );
}

function targetRefToSourceRef(ref: ExecutionAction["targetRefs"][number]): TerminalReportSourceRef | undefined {
  if (ref.type === "file" && ref.path) {
    return sourceRefFor("file", ref.path, ref.label ?? ref.path);
  }
  if (ref.id) {
    const kind = ref.type === "run" || ref.type === "task" || ref.type === "workflow" || ref.type === "workflow_step"
      ? ref.type
      : "external";
    return sourceRefFor(kind, ref.id, ref.label ?? ref.type);
  }
  if (ref.label) {
    return sourceRefFor("external", `${ref.type}:${ref.label}`, ref.label, "folded_evidence");
  }
  return undefined;
}

function sourceRefFor(
  kind: TerminalReportSourceRef["kind"],
  id: string,
  label?: string,
  visibility: TerminalReportSourceRef["visibility"] = "conversation",
  sensitivity: NonNullable<TerminalReportSourceRef["sensitivity"]> = "normal",
): TerminalReportSourceRef {
  return {
    kind,
    id,
    label: label ? redactEvidenceText(label) : undefined,
    visibility,
    sensitivity,
  };
}

function surfaceForThread(kind: string | undefined, channelId: string | undefined): TerminalReportSurface {
  if (channelId) {
    return "channel";
  }
  return kind === "teammate_direct" ? "teammate_private_chat" : "normal_conversation";
}

function languageForRun(run: RunSession, fallbackText?: string): TerminalReportLanguage | undefined {
  if (isRecord(run.requestSnapshot)) {
    const value = run.requestSnapshot.responseLanguage;
    if (value === "zh-CN" || value === "en-US") {
      return value;
    }
  }
  return fallbackText?.trim() ? inferUserLanguage(fallbackText) : undefined;
}

function readRunAssistantSummary(store: RunStore, runId: string, maxCharacters: number): string | undefined {
  const text = store.listEvents(runId, { limit: 1000 })
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => isRecord(event.data) && typeof event.data.text === "string" ? event.data.text : "")
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? boundedText(text, maxCharacters) : undefined;
}

/**
 * Build a participant contribution from the run's typed Host actions. Model
 * narration is deliberately only a fallback: it is not allowed to make one
 * participant appear to have completed another participant's work.
 */
function readRunEvidenceContribution(
  store: RunStore,
  run: RunSession,
  maxCharacters: number,
): string | undefined {
  const actions = listAllExecutionActionsForRun(store, run.id);
  if (actions.length === 0) return undefined;
  const contributions = actions.map((action) => {
    const subject = action.summary.trim() || action.title.trim() || action.actionType;
    const label = action.actionType === "bash"
      ? "Executed command"
      : action.actionType === "write" || action.actionType === "edit"
        ? "Changed files"
        : action.title.trim() || "Completed action";
    const status = action.status === "succeeded"
      ? "completed"
      : action.status === "failed"
        ? "failed"
        : action.status === "cancelled"
          ? "cancelled"
          : action.status === "waiting_for_approval" || action.status === "denied" || action.status === "expired"
            ? "blocked"
            : action.status;
    return `${label}: ${subject} (${status})`;
  });
  return boundedText(contributions.join("; "), maxCharacters);
}

function changedPathsFromActions(actions: readonly ExecutionAction[], cwd?: string): string[] {
  return extractWorkflowStepChangedPaths({
    actions,
    cwd,
  })
    .map((path) => redactEvidenceText(path));
}

function boundedItems<T>(
  items: readonly T[],
  limit: number,
  name: string,
  risks: TerminalReportEvidenceRisk[],
  sourceRef: TerminalReportSourceRef,
  language: TerminalReportLanguage,
): readonly T[] {
  if (items.length <= limit) {
    return items;
  }
  risks.push({
    id: `terminal-report-truncated:${name}`,
    severity: "warning",
    status: "unverified",
    summary: language === "zh-CN"
      ? `${name} 证据从 ${items.length} 条截断为 ${limit} 条。`
      : `${name} evidence was truncated from ${items.length} to ${limit} items.`,
    sourceRefs: [sourceRef],
  });
  return items.slice(0, limit);
}

function resolveBudgets(overrides: Partial<TerminalReportEvidenceBudgets> | undefined): TerminalReportEvidenceBudgets {
  return {
    steps: positiveBudget(overrides?.steps, DEFAULT_BUDGETS.steps),
    operations: positiveBudget(overrides?.operations, DEFAULT_BUDGETS.operations),
    checks: positiveBudget(overrides?.checks, DEFAULT_BUDGETS.checks),
    artifacts: positiveBudget(overrides?.artifacts, DEFAULT_BUDGETS.artifacts),
    participants: positiveBudget(overrides?.participants, DEFAULT_BUDGETS.participants),
    approvals: positiveBudget(overrides?.approvals, DEFAULT_BUDGETS.approvals),
    risks: positiveBudget(overrides?.risks, DEFAULT_BUDGETS.risks),
    summaryCharacters: positiveBudget(overrides?.summaryCharacters, DEFAULT_BUDGETS.summaryCharacters),
  };
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function boundedText(value: string, maxCharacters: number): string {
  const redacted = redactEvidenceText(value).replace(/\s+/gu, " ").trim();
  return redacted.length <= maxCharacters ? redacted : `${redacted.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function uniqueRefs(refs: readonly TerminalReportSourceRef[]): TerminalReportSourceRef[] {
  const byKey = new Map<string, TerminalReportSourceRef>();
  for (const ref of refs) {
    byKey.set(`${ref.kind}:${ref.id}`, ref);
  }
  return [...byKey.values()];
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
