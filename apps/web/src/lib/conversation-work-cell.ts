import type { ApprovalRequest, ChannelWorkflow, ExecutionAction, LingThreadEvidenceResponse, LingTurn, LingTurnRun, RunArtifact, RunSession } from "../types.js";
import type { Translate } from "../i18n.js";
import { effectiveApprovalStatus } from "./approvals.js";
import { truncatePreview } from "./data.js";

export type ConversationWorkCellMode = "active" | "completed";
export type ConversationWorkCellStatus = RunSession["status"] | LingTurn["status"] | ChannelWorkflow["status"];
export type ConversationWorkCellGroupKind = "changed" | "checked" | "context" | "evidence" | "attention";
export type ConversationWorkCellRowTone = "neutral" | "running" | "waiting" | "success" | "failed";

export interface ConversationWorkCellStat {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversationWorkCellRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly tone?: ConversationWorkCellRowTone;
}

export interface ConversationWorkCellBranch {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly meta?: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly stateLabel?: string;
  readonly rows: readonly ConversationWorkCellRow[];
}

export interface ConversationWorkCellEvidenceLink {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly href?: string;
}

export interface ConversationWorkCellGroup {
  readonly id: ConversationWorkCellGroupKind;
  readonly label: string;
  readonly summary: string;
  readonly rows: readonly ConversationWorkCellRow[];
}

export interface ConversationWorkCellViewModel {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly anchorRunId: string;
  readonly runIds: readonly string[];
  readonly mode: ConversationWorkCellMode;
  readonly status: ConversationWorkCellStatus;
  readonly presentation?: "default" | "collaboration_task";
  readonly kicker?: string;
  readonly detailsLabel?: string;
  readonly showDiagnostics?: boolean;
  readonly title: string;
  readonly summary: string;
  readonly stats: readonly ConversationWorkCellStat[];
  readonly activeRows: readonly ConversationWorkCellRow[];
  readonly branchRows?: readonly ConversationWorkCellBranch[];
  readonly finalReportRows?: readonly ConversationWorkCellRow[];
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly updatedAt: string;
}

export interface ConversationWorkCellDetailsModel {
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
}

export interface BuildConversationWorkCellInput {
  readonly threadId: string;
  readonly runs: readonly RunSession[];
  readonly turns?: readonly LingTurn[];
  readonly turnRunLinks?: readonly LingTurnRun[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly executionActions?: readonly ExecutionAction[];
  readonly t: Translate;
  readonly artifactHref?: (artifact: RunArtifact) => string;
}

export function buildConversationWorkCellViewModel(input: BuildConversationWorkCellInput): ConversationWorkCellViewModel | undefined {
  const threadRuns = [...input.runs]
    .filter((run) => run.threadId === input.threadId)
    .sort((left, right) => compareRunActivity(left, right));
  const turnContext = buildVisibleTurnContext(input);
  const runs = turnContext?.runs ?? threadRuns;
  if (runs.length === 0) {
    return undefined;
  }

  const latestRun = runs[0];
  const runIds = runs.map((run) => run.id);
  const runIdSet = new Set(runIds);
  const status: ConversationWorkCellStatus = turnContext?.turn.status ?? latestRun.status;
  const approvals = input.approvals
    .filter((approval) => approval.runId ? runIdSet.has(approval.runId) : false)
    .sort((left, right) => (right.resolvedAt ?? right.createdAt).localeCompare(left.resolvedAt ?? left.createdAt));
  const artifacts = runIds.flatMap((runId) => input.artifactsByRun[runId] ?? []);
  const actions = (input.executionActions ?? [])
    .filter((action) => action.threadId === input.threadId || (action.runId ? runIdSet.has(action.runId) : false))
    .sort((left, right) => (right.completedAt ?? right.executedAt ?? right.resolvedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.executedAt ?? left.resolvedAt ?? left.createdAt));
  const pendingApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending");
  const failedRuns = runs.filter((run) => run.status === "failed");
  const failedActions = actions.filter((action) => action.status === "failed" || action.status === "denied" || action.status === "expired");
  const mode: ConversationWorkCellMode = isWorkCellStatusActive(status) ? "active" : "completed";
  const title = turnContext?.turn.title || readRunTitle(latestRun);
  const evidenceLinks = artifacts.slice(0, 5).map((artifact) => ({
    id: artifact.id,
    label: artifact.title || artifact.path || artifact.id,
    meta: [artifact.type, artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined].filter(Boolean).join(" · "),
    href: input.artifactHref?.(artifact),
  }));

  return {
    id: turnContext ? `work-cell:turn:${turnContext.turn.id}` : `work-cell:${input.threadId}`,
    threadId: input.threadId,
    turnId: turnContext?.turn.id,
    anchorRunId: latestRun.id,
    runIds,
    mode,
    status,
    title,
    summary: buildWorkCellSummary({
      t: input.t,
      status,
      latestRun,
      runCount: runs.length,
      artifactCount: artifacts.length,
      pendingApprovalCount: pendingApprovals.length,
    }),
    stats: [
      { id: "attempts", label: input.t("Attempts"), value: String(runs.length) },
      { id: "artifacts", label: input.t("Evidence"), value: String(artifacts.length) },
      { id: "approvals", label: input.t("Approvals"), value: String(approvals.length) },
    ],
    activeRows: buildActiveRows({ t: input.t, latestRun, runs, pendingApprovals, artifacts, actions }),
    groups: buildWorkCellGroups({ t: input.t, runs, approvals, artifacts, actions, failedRuns, failedActions, pendingApprovals }),
    evidenceLinks,
    updatedAt: turnContext?.turn.updatedAt ?? latestRun.endedAt ?? latestRun.startedAt ?? latestRun.updatedAt,
  };
}

export function groupRunsByThreadId(runs: readonly RunSession[]): ReadonlyMap<string, readonly RunSession[]> {
  const grouped = new Map<string, RunSession[]>();
  for (const run of runs) {
    if (!run.threadId) {
      continue;
    }
    grouped.set(run.threadId, [...(grouped.get(run.threadId) ?? []), run]);
  }
  return new Map([...grouped.entries()].map(([threadId, threadRuns]) => [
    threadId,
    threadRuns.sort((left, right) => compareRunActivity(left, right)),
  ]));
}

export function buildConversationWorkCellDetailsFromThreadEvidence(input: {
  readonly threadId: string;
  readonly evidence: LingThreadEvidenceResponse;
  readonly runIds?: readonly string[];
  readonly t: Translate;
  readonly artifactHref?: (artifact: RunArtifact) => string;
}): ConversationWorkCellDetailsModel {
  const filteredRuns = filterEvidenceRuns(input.evidence.runs, input.runIds);
  const artifactsByRun: Record<string, readonly RunArtifact[]> = {};
  for (const item of filteredRuns) {
    artifactsByRun[item.run.id] = item.artifacts;
  }
  const cell = buildConversationWorkCellViewModel({
    threadId: input.threadId,
    runs: filteredRuns.map((item) => item.run),
    approvals: filteredRuns.flatMap((item) => item.approvals),
    artifactsByRun,
    executionActions: filterEvidenceActions(input.evidence.actions, input.threadId, filteredRuns.map((item) => item.run.id), input.runIds),
    t: input.t,
    artifactHref: input.artifactHref,
  });
  return {
    groups: cell?.groups ?? emptyWorkCellGroups(input.t),
    evidenceLinks: cell?.evidenceLinks ?? [],
  };
}

function buildVisibleTurnContext(input: BuildConversationWorkCellInput): { readonly turn: LingTurn; readonly runs: readonly RunSession[] } | undefined {
  if (!input.turns || !input.turnRunLinks) {
    return undefined;
  }
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const turns = input.turns.filter((turn) => turn.threadId === input.threadId);
  if (turns.length === 0) {
    return undefined;
  }
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const linksByTurnId = new Map<string, LingTurnRun[]>();
  for (const link of input.turnRunLinks) {
    if (!turnById.has(link.turnId) || !runById.has(link.runId)) {
      continue;
    }
    linksByTurnId.set(link.turnId, [...(linksByTurnId.get(link.turnId) ?? []), link]);
  }
  const candidates: Array<{ readonly turn: LingTurn; readonly runs: readonly RunSession[]; readonly latestRun: RunSession }> = [];
  for (const turn of turns) {
    const links = [...(linksByTurnId.get(turn.id) ?? [])]
      .sort((left, right) => right.attemptNumber - left.attemptNumber || right.createdAt.localeCompare(left.createdAt));
    const runs = links
      .map((link) => runById.get(link.runId))
      .filter((run): run is RunSession => Boolean(run))
      .sort((left, right) => compareRunActivity(left, right));
    if (runs[0]) {
      candidates.push({ turn, runs, latestRun: runs[0] });
    }
  }
  candidates.sort((left, right) =>
    right.turn.updatedAt.localeCompare(left.turn.updatedAt) ||
    compareRunActivity(left.latestRun, right.latestRun) ||
    right.turn.id.localeCompare(left.turn.id),
  );
  const selected = candidates[0];
  return selected ? { turn: selected.turn, runs: selected.runs } : undefined;
}

function filterEvidenceRuns(
  runs: LingThreadEvidenceResponse["runs"],
  runIds: readonly string[] | undefined,
): LingThreadEvidenceResponse["runs"] {
  if (!runIds || runIds.length === 0) {
    return runs;
  }
  const runIdSet = new Set(runIds);
  const filtered = runs.filter((item) => runIdSet.has(item.run.id));
  return filtered.length > 0 ? filtered : runs;
}

function filterEvidenceActions(
  actions: readonly ExecutionAction[],
  threadId: string,
  runIds: readonly string[],
  requestedRunIds: readonly string[] | undefined,
): readonly ExecutionAction[] {
  if (!requestedRunIds || requestedRunIds.length === 0) {
    return actions;
  }
  const runIdSet = new Set(runIds);
  const filtered = actions.filter((action) =>
    action.runId ? runIdSet.has(action.runId) : action.threadId === threadId,
  );
  return filtered.length > 0 ? filtered : actions;
}

function emptyWorkCellGroups(t: Translate): readonly ConversationWorkCellGroup[] {
  return [
    { id: "changed", label: t("Changed"), summary: t("No changed files recorded"), rows: [] },
    { id: "checked", label: t("Checked work"), summary: t("No items recorded"), rows: [] },
    { id: "evidence", label: t("Evidence"), summary: t("{count} evidence items", { count: 0 }), rows: [] },
    { id: "attention", label: t("Attention"), summary: t("No attention needed"), rows: [] },
  ];
}

function buildActiveRows(input: {
  readonly t: Translate;
  readonly latestRun: RunSession;
  readonly runs: readonly RunSession[];
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly actions: readonly ExecutionAction[];
}): readonly ConversationWorkCellRow[] {
  const rows: ConversationWorkCellRow[] = [];
  rows.push({
    id: `run:${input.latestRun.id}`,
    title: input.latestRun.status === "waiting_for_approval"
      ? input.t("Waiting for approval")
      : input.latestRun.status === "queued"
        ? input.t("Queued")
        : input.t("Running attempt"),
    description: readRunTitle(input.latestRun),
    meta: input.latestRun.providerName ? `${input.latestRun.providerName} · ${input.latestRun.providerModel}` : undefined,
    tone: input.latestRun.status === "waiting_for_approval" ? "waiting" : input.latestRun.status === "queued" || input.latestRun.status === "running" ? "running" : "neutral",
  });

  for (const approval of input.pendingApprovals.slice(0, 3)) {
    rows.push({
      id: `approval:${approval.id}`,
      title: approval.title,
      description: approval.description,
      meta: input.t("Approval required"),
      tone: "waiting",
    });
  }

  for (const action of input.actions.slice(0, 4)) {
    rows.push({
      id: `action:${action.id}`,
      title: action.title,
      description: action.summary,
      meta: action.status,
      tone: action.status === "failed" || action.status === "denied" || action.status === "expired"
        ? "failed"
        : action.status === "succeeded"
          ? "success"
          : action.status === "waiting_for_approval"
            ? "waiting"
            : "running",
    });
  }

  if (input.artifacts.length > 0) {
    rows.push({
      id: "artifacts",
      title: input.t("Evidence captured"),
      description: input.t("{count} artifacts", { count: input.artifacts.length }),
      tone: "success",
    });
  }

  if (input.runs.length > 1) {
    rows.push({
      id: "attempts",
      title: input.t("Prior attempts"),
      description: input.t("{count} attempts", { count: input.runs.length - 1 }),
      tone: "neutral",
    });
  }

  return rows;
}

function buildWorkCellGroups(input: {
  readonly t: Translate;
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly actions: readonly ExecutionAction[];
  readonly failedRuns: readonly RunSession[];
  readonly failedActions: readonly ExecutionAction[];
  readonly pendingApprovals: readonly ApprovalRequest[];
}): readonly ConversationWorkCellGroup[] {
  const changedArtifacts = input.artifacts.filter((artifact) => artifact.type === "diff" || artifact.type === "file" || Boolean(artifact.path));
  const changedRows = uniqueBy(changedArtifacts, (artifact) => artifact.path || artifact.id).slice(0, 8).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral" as const,
  }));
  const checkedRows = input.runs.slice(0, 8).map((run) => ({
    id: `run:${run.id}`,
    title: readRunTitle(run),
    description: run.errorMessage ? truncatePreview(run.errorMessage, 160) : run.providerName ? `${run.providerName} · ${run.providerModel}` : undefined,
    meta: run.status,
    tone: runStatusTone(run.status),
  }));
  const evidenceRows: ConversationWorkCellRow[] = [
    ...input.artifacts.slice(0, 8).map((artifact) => ({
      id: `evidence:${artifact.id}`,
      title: artifact.title || artifact.path || artifact.id,
      description: artifact.path,
      meta: artifact.type,
      tone: "neutral" as const,
    })),
    ...input.approvals.slice(0, 5).map((approval) => ({
      id: `approval:${approval.id}`,
      title: approval.title,
      description: approval.description,
      meta: effectiveApprovalStatus(approval),
      tone: effectiveApprovalStatus(approval) === "pending" ? "waiting" as const : "neutral" as const,
    })),
  ];
  const attentionRows: ConversationWorkCellRow[] = [
    ...input.pendingApprovals.slice(0, 5).map((approval) => ({
      id: `pending:${approval.id}`,
      title: approval.title,
      description: approval.description,
      meta: input.t("Waiting for approval"),
      tone: "waiting" as const,
    })),
    ...input.failedRuns.slice(0, 5).map((run) => ({
      id: `failed-run:${run.id}`,
      title: readRunTitle(run),
      description: run.errorMessage ? truncatePreview(run.errorMessage, 180) : input.t("Run failed without a captured error message."),
      meta: run.status,
      tone: "failed" as const,
    })),
    ...input.failedActions.slice(0, 5).map((action) => ({
      id: `failed-action:${action.id}`,
      title: action.title,
      description: action.summary,
      meta: action.status,
      tone: "failed" as const,
    })),
  ];

  return [
    {
      id: "changed",
      label: input.t("Changed"),
      summary: changedRows.length > 0 ? input.t("{count} changed items", { count: changedRows.length }) : input.t("No changed files recorded"),
      rows: changedRows,
    },
    {
      id: "checked",
      label: input.t("Checked work"),
      summary: input.t("{count} attempts", { count: input.runs.length }),
      rows: checkedRows,
    },
    {
      id: "evidence",
      label: input.t("Evidence"),
      summary: input.t("{count} evidence items", { count: evidenceRows.length }),
      rows: evidenceRows,
    },
    {
      id: "attention",
      label: input.t("Attention"),
      summary: attentionRows.length > 0 ? input.t("{count} attention items", { count: attentionRows.length }) : input.t("No attention needed"),
      rows: attentionRows,
    },
  ];
}

function buildWorkCellSummary(input: {
  readonly t: Translate;
  readonly status: ConversationWorkCellStatus;
  readonly latestRun: RunSession;
  readonly runCount: number;
  readonly artifactCount: number;
  readonly pendingApprovalCount: number;
}): string {
  if (input.status === "succeeded") {
    return input.t("Completed {attempts} attempts with {artifacts} evidence items.", {
      attempts: input.runCount,
      artifacts: input.artifactCount,
    });
  }
  if (input.status === "failed") {
    const issue = input.latestRun.errorMessage ? truncatePreview(input.latestRun.errorMessage, 180) : input.t("No failure message was captured.");
    return input.t("Failed after {attempts} attempts: {issue}", {
      attempts: input.runCount,
      issue,
    });
  }
  if (input.status === "cancelled" || input.status === "superseded") {
    return input.t("Cancelled after {attempts} attempts.", { attempts: input.runCount });
  }
  if (input.status === "waiting_for_approval" || input.pendingApprovalCount > 0) {
    return input.t("Waiting for {count} approvals before continuing.", { count: Math.max(1, input.pendingApprovalCount) });
  }
  if (input.status === "queued" || input.status === "open") {
    return input.t("Queued with {attempts} attempts in this work thread.", { attempts: input.runCount });
  }
  if (input.status === "blocked") {
    return input.t("Waiting on blockers with {attempts} attempts in this work thread.", { attempts: input.runCount });
  }
  return input.t("Running with {attempts} attempts and {artifacts} evidence items.", {
    attempts: input.runCount,
    artifacts: input.artifactCount,
  });
}

function compareRunActivity(left: RunSession, right: RunSession): number {
  const leftTime = left.endedAt ?? left.startedAt ?? left.updatedAt;
  const rightTime = right.endedAt ?? right.startedAt ?? right.updatedAt;
  const timeComparison = rightTime.localeCompare(leftTime);
  return timeComparison === 0 ? right.id.localeCompare(left.id) : timeComparison;
}

function isRunActive(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function isWorkCellStatusActive(status: ConversationWorkCellStatus): boolean {
  return status === "draft" || status === "ready" || status === "open" || status === "queued" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

function readRunTitle(run: RunSession): string {
  if (typeof run.taskSnapshot === "object" && run.taskSnapshot !== null && "title" in run.taskSnapshot) {
    const title = (run.taskSnapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) {
      return title.trim();
    }
  }
  return run.taskId || run.id;
}

function runStatusTone(status: RunSession["status"]): ConversationWorkCellRowTone {
  if (status === "succeeded") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "queued" || status === "running") {
    return "running";
  }
  return "neutral";
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
