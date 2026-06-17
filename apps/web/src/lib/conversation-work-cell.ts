import type { ApprovalRequest, ChannelWorkflow, ExecutionAction, LingThreadEvidenceResponse, LingTurn, LingTurnRun, RunArtifact, RunSession } from "../types.js";
import type { Translate } from "../i18n.js";
import { effectiveApprovalStatus } from "./approvals.js";
import { truncatePreview } from "./data.js";

export type ConversationWorkCellMode = "active" | "completed";
export type ConversationWorkCellStatus = RunSession["status"] | LingTurn["status"] | ChannelWorkflow["status"];
export type ConversationOperationCellSourceKind = "run_thread" | "workflow" | "collaboration_task";
export type ConversationOperationKind =
  | "plan"
  | "read"
  | "edit"
  | "run_command"
  | "search"
  | "approval"
  | "verify"
  | "handoff"
  | "watch";
export type ConversationWorkCellGroupKind = "changed" | "checked" | "context" | "evidence" | "attention";
export type ConversationWorkCellRowTone = "neutral" | "running" | "waiting" | "success" | "failed";

export interface ConversationWorkCellStat {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversationWorkCellRow {
  readonly id: string;
  readonly kind?: ConversationOperationKind;
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly detailLines?: readonly ConversationWorkCellRowDetailLine[];
  readonly tone?: ConversationWorkCellRowTone;
}

export interface ConversationWorkCellRowDetailLine {
  readonly kind?: "text" | "code";
  readonly text: string;
}

export type ConversationAgentActivitySpanKind = "agent" | "overflow";

export interface ConversationAgentActivitySpan {
  readonly id: string;
  readonly participantId?: string;
  readonly kind?: ConversationAgentActivitySpanKind;
  readonly label: string;
  readonly summary?: string;
  readonly meta?: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly stateLabel?: string;
  readonly latestRow?: ConversationWorkCellRow;
  readonly rows: readonly ConversationWorkCellRow[];
}

/** @deprecated Use ConversationAgentActivitySpan. */
export type ConversationWorkCellBranch = ConversationAgentActivitySpan;

export interface ConversationWorkCellEvidenceLink {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: RunArtifact["type"];
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
}

export type ConversationArtifactStripItemKind = "artifact" | "changed" | "checked" | "attention" | "approval";

export interface ConversationArtifactStripItem {
  readonly id: string;
  readonly kind: ConversationArtifactStripItemKind;
  readonly label: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: RunArtifact["type"];
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
}

export interface ConversationWorkCellGroup {
  readonly id: ConversationWorkCellGroupKind;
  readonly label: string;
  readonly summary: string;
  readonly rows: readonly ConversationWorkCellRow[];
}

export interface ConversationOperationCellViewModel {
  readonly id: string;
  readonly sourceKind: ConversationOperationCellSourceKind;
  readonly threadId: string;
  readonly turnId?: string;
  readonly anchorRunId: string;
  readonly runIds: readonly string[];
  readonly mode: ConversationWorkCellMode;
  readonly status: ConversationWorkCellStatus;
  readonly presentation?: "default" | "collaboration_task";
  readonly kicker?: string;
  readonly showDiagnostics?: boolean;
  readonly title: string;
  readonly summary: string;
  readonly stats: readonly ConversationWorkCellStat[];
  readonly operationRows: readonly ConversationWorkCellRow[];
  readonly agentSpans: readonly ConversationAgentActivitySpan[];
  /** @deprecated Use agentSpans. Kept while call sites migrate. */
  readonly agentBranches: readonly ConversationWorkCellBranch[];
  readonly terminalReportRows: readonly ConversationWorkCellRow[];
  /** @deprecated Use operationRows. Kept while call sites migrate. */
  readonly activeRows: readonly ConversationWorkCellRow[];
  /** @deprecated Use agentSpans. Kept while call sites migrate. */
  readonly branchRows?: readonly ConversationWorkCellBranch[];
  /** @deprecated Use terminalReportRows. Kept while call sites migrate. */
  readonly finalReportRows?: readonly ConversationWorkCellRow[];
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly artifactStripItems: readonly ConversationArtifactStripItem[];
  readonly updatedAt: string;
}

export type ConversationWorkCellViewModel = ConversationOperationCellViewModel;

type ConversationOperationCellDraft =
  Omit<ConversationOperationCellViewModel, "agentSpans" | "activeRows" | "branchRows" | "finalReportRows"> &
  Partial<Pick<ConversationOperationCellViewModel, "agentSpans" | "activeRows" | "branchRows" | "finalReportRows">>;

export function normalizeConversationOperationCell(
  draft: ConversationOperationCellDraft,
): ConversationOperationCellViewModel {
  const agentSpans = draft.agentSpans ?? draft.agentBranches;
  return {
    ...draft,
    agentSpans,
    activeRows: draft.activeRows ?? draft.operationRows,
    branchRows: draft.branchRows ?? agentSpans,
    finalReportRows: draft.finalReportRows ?? draft.terminalReportRows,
  };
}

export interface ConversationWorkCellDetailsModel {
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
}

export function buildConversationArtifactStripItems(input: {
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly t: Translate;
}): readonly ConversationArtifactStripItem[] {
  const changedRows = input.groups.find((group) => group.id === "changed")?.rows ?? [];
  const checkedRows = input.groups.find((group) => group.id === "checked")?.rows ?? [];
  const attentionRows = input.groups.find((group) => group.id === "attention")?.rows ?? [];
  const items: ConversationArtifactStripItem[] = [];
  const artifactLinks = input.evidenceLinks.filter((link) => link.label.trim()).slice(0, 4);

  for (const artifactLink of artifactLinks) {
    items.push({
      id: `artifact:${artifactLink.id}`,
      kind: "artifact",
      label: artifactLink.label,
      href: artifactLink.href,
      artifactId: artifactLink.artifactId,
      artifactType: artifactLink.artifactType,
      contentType: artifactLink.contentType,
      sizeBytes: artifactLink.sizeBytes,
      previewKind: artifactLink.previewKind,
      previewable: artifactLink.previewable,
      tone: "neutral",
    });
  }

  if (changedRows.length > 0) {
    items.push({
      id: "changed",
      kind: "changed",
      label: changedRows.length === 1 ? input.t("Changed 1 file") : input.t("Changed {count} files", { count: changedRows.length }),
      tone: "neutral",
    });
  }

  if (checkedRows.length > 0) {
    const failedCount = checkedRows.filter((row) => row.tone === "failed").length;
    const passedCount = checkedRows.filter((row) => row.tone === "success").length;
    const count = failedCount > 0 ? failedCount : passedCount > 0 ? passedCount : checkedRows.length;
    items.push({
      id: "checked",
      kind: "checked",
      label: failedCount > 0
        ? count === 1 ? input.t("1 check failed") : input.t("{count} checks failed", { count })
        : count === 1 ? input.t("1 check passed") : input.t("{count} checks passed", { count }),
      tone: failedCount > 0 ? "failed" : "success",
    });
  }

  if (attentionRows.length > 0) {
    items.unshift({
      id: "attention",
      kind: "attention",
      label: input.t("{count} attention items", { count: attentionRows.length }),
      tone: attentionRows.some((row) => row.tone === "failed") ? "failed" : "waiting",
    });
  }

  return items.slice(0, 4);
}

const MAIN_FEED_GROUP_IDS = new Set<ConversationWorkCellGroupKind>(["changed", "checked", "evidence", "attention"]);

const MAIN_FEED_GROUP_LIMITS: Record<ConversationWorkCellGroupKind, number> = {
  changed: 6,
  checked: 5,
  context: 0,
  evidence: 4,
  attention: 3,
};

const MAIN_FEED_INTERNAL_PATTERNS: readonly RegExp[] = [
  /\bcontext pack\b/iu,
  /\bcontext packet\b/iu,
  /\boutput packet\b/iu,
  /\bworkflow step context\b/iu,
  /\bworkflow step output\b/iu,
  /\baction preview\b/iu,
  /\bcontent log\b/iu,
  /\braw event\b/iu,
  /\bwork[-_\s]?unit\b/iu,
  /\bpacket\b/iu,
  /\bselector\b/iu,
  /\battempt\b/iu,
  /\bprovider\s*:/iu,
  /\bmodel\s*:/iu,
  /\bbudget\s*:/iu,
  /\btokens?\b/iu,
  /\btoken budget\b/iu,
  /\bjson\s*·/iu,
  /\blog\s*·/iu,
  /\bprovider_[a-z0-9_-]+\b/iu,
  /\bworkflow_[a-z0-9_-]+\b/iu,
  /\bwfstep_[a-z0-9_-]+\b/iu,
  /\brun_[a-z0-9_-]+\b/iu,
  /\.ling-stack\//iu,
  /\bsessions\//iu,
  /\bsummaries\//iu,
  /\b(?:context|output|preview)\.json\b/iu,
  /\.jsonl?\b/iu,
  /\.log\b/iu,
  /\bworkflow_runtime_boundary\b/iu,
  /\bold_verbose_log_tail\b/iu,
  /\braw prompt text excluded\b/iu,
  /\braw logs excluded\b/iu,
  /\braw artifact bodies excluded\b/iu,
  /\bsource refs\b/iu,
  /\bcompactions\b/iu,
  /\bchannel_collaboration_protocol\b/iu,
];

export function mainFeedEvidenceGroups(
  groups: readonly ConversationWorkCellGroup[],
  t: Translate,
): readonly ConversationWorkCellGroup[] {
  return groups
    .filter((group) => MAIN_FEED_GROUP_IDS.has(group.id))
    .map((group) => {
      const rows = group.rows
        .filter((row) => isMainFeedSafeRow(row))
        .slice(0, MAIN_FEED_GROUP_LIMITS[group.id]);
      return {
        ...group,
        summary: mainFeedGroupSummary(group.id, rows.length, t),
        rows,
      };
    });
}

export function mainFeedEvidenceLinks(
  links: readonly ConversationWorkCellEvidenceLink[],
): readonly ConversationWorkCellEvidenceLink[] {
  return links
    .filter((link) => isMainFeedSafeText([link.label, link.meta].filter(Boolean).join(" ")))
    .slice(0, 4);
}

export function mainFeedArtifactEvidenceLinks(
  artifacts: readonly RunArtifact[],
  artifactHref?: (artifact: RunArtifact) => string,
  limit = 4,
): readonly ConversationWorkCellEvidenceLink[] {
  return mainFeedEvidenceLinks(artifacts.slice(0, limit).map((artifact) => ({
    id: artifact.id,
    label: mainFeedArtifactLabel(artifact),
    meta: [artifact.type, artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined].filter(Boolean).join(" · "),
    href: artifactHref?.(artifact),
    artifactId: artifact.id,
    artifactType: artifact.type,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    previewKind: isImageArtifact(artifact) ? "image" : "file",
    previewable: artifact.type !== "video",
  })));
}

function isMainFeedSafeRow(row: ConversationWorkCellRow): boolean {
  return isMainFeedSafeText([
    row.title,
    row.description,
    row.meta,
    ...(row.detailLines ?? []).map((line) => line.text),
  ].filter(Boolean).join(" "));
}

function isMainFeedSafeText(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return true;
  }
  return !MAIN_FEED_INTERNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function mainFeedArtifactLabel(artifact: RunArtifact): string {
  const title = artifact.title?.trim();
  if (title && !isLowSignalArtifactTitle(title)) {
    return title;
  }
  const path = artifact.path?.trim();
  return path || title || artifact.id;
}

function isImageArtifact(artifact: RunArtifact): boolean {
  return artifact.type === "image" || artifact.contentType?.toLowerCase().startsWith("image/") === true;
}

function isLowSignalArtifactTitle(value: string): boolean {
  return /^(Generated file metadata|Workflow step context|Workflow step output|Action preview):/iu.test(value) ||
    /\bcontent log\b/iu.test(value);
}

function mainFeedGroupSummary(
  kind: ConversationWorkCellGroupKind,
  count: number,
  t: Translate,
): string {
  if (kind === "changed") {
    return count > 0 ? t("{count} changed items", { count }) : t("No changed files recorded");
  }
  if (kind === "checked") {
    return count > 0 ? t("{count} checks", { count }) : t("No items recorded");
  }
  if (kind === "attention") {
    return count > 0 ? t("{count} attention items", { count }) : t("No attention needed");
  }
  if (kind === "evidence") {
    return t("{count} evidence items", { count });
  }
  return t("No items recorded");
}

export interface BuildConversationWorkCellInput {
  readonly threadId: string;
  readonly runs: readonly RunSession[];
  readonly turns?: readonly LingTurn[];
  readonly turnRunLinks?: readonly LingTurnRun[];
  readonly allowRunThreadFallback?: boolean;
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
  if (!turnContext && input.allowRunThreadFallback !== true) {
    return undefined;
  }
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
  const artifactsById = artifactsByIdMap(artifacts);
  const actions = (input.executionActions ?? [])
    .filter((action) => action.threadId === input.threadId || (action.runId ? runIdSet.has(action.runId) : false))
    .sort((left, right) => (right.completedAt ?? right.executedAt ?? right.resolvedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.executedAt ?? left.resolvedAt ?? left.createdAt));
  const pendingApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending");
  const failedRuns = runs.filter((run) => run.status === "failed");
  const failedActions = actions.filter((action) => action.status === "failed" || action.status === "denied" || action.status === "expired");
  const mode: ConversationWorkCellMode = isWorkCellStatusActive(status) ? "active" : "completed";
  const title = turnContext?.turn.title || readRunTitle(latestRun);
  const evidenceLinks = mainFeedArtifactEvidenceLinks(artifacts, input.artifactHref);
  const groups = mainFeedEvidenceGroups(
    buildWorkCellGroups({ t: input.t, runs, approvals, artifacts, artifactsById, actions, failedRuns, failedActions, pendingApprovals }),
    input.t,
  );

  return normalizeConversationOperationCell({
    id: turnContext ? `work-cell:turn:${turnContext.turn.id}` : `work-cell:${input.threadId}`,
    sourceKind: "run_thread",
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
      title,
      pendingApprovalCount: pendingApprovals.length,
    }),
    stats: [
      { id: "tries", label: input.t("Tries"), value: String(runs.length) },
      { id: "artifacts", label: input.t("Artifacts"), value: String(artifacts.length) },
      { id: "approvals", label: input.t("Approvals"), value: String(approvals.length) },
    ],
    operationRows: buildActiveRows({ t: input.t, latestRun, runs, pendingApprovals, artifacts, actions }),
    agentBranches: [],
    terminalReportRows: [],
    groups,
    evidenceLinks,
    artifactStripItems: buildConversationArtifactStripItems({ groups, evidenceLinks, t: input.t }),
    updatedAt: turnContext?.turn.updatedAt ?? latestRun.endedAt ?? latestRun.startedAt ?? latestRun.updatedAt,
  });
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
    allowRunThreadFallback: true,
    approvals: filteredRuns.flatMap((item) => item.approvals),
    artifactsByRun,
    executionActions: filterEvidenceActions(input.evidence.actions, input.threadId, filteredRuns.map((item) => item.run.id), input.runIds),
    t: input.t,
    artifactHref: input.artifactHref,
  });
  return {
    groups: cell?.groups ?? emptyWorkCellGroups(input.t),
    evidenceLinks: mainFeedEvidenceLinks(cell?.evidenceLinks ?? []),
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
    { id: "checked", label: t("Checks"), summary: t("No items recorded"), rows: [] },
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
  const artifactsById = artifactsByIdMap(input.artifacts);
  const actionRows = [...input.actions]
    .filter(isMainFeedActionRow)
    .sort(compareExecutionActionTranscriptOrder)
    .map((action) => executionActionEvidenceRow(action, artifactsById, input.t));

  if (actionRows.length > 0) {
    rows.push(...actionRows);
  } else {
    rows.push({
      id: `run:${input.latestRun.id}`,
      kind: "watch",
      title: runOperationTitle(input.latestRun.status, readRunTitle(input.latestRun), input.t),
      description: input.latestRun.errorMessage ? truncatePreview(input.latestRun.errorMessage, 180) : undefined,
      meta: operationStatusMeta(input.latestRun.status, input.t),
      tone: runStatusTone(input.latestRun.status),
    });
  }

  for (const approval of input.pendingApprovals.slice(0, 3)) {
    rows.push({
      id: `approval:${approval.id}`,
      kind: "approval",
      title: approval.title,
      description: approval.description,
      meta: input.t("Approval required"),
      tone: "waiting",
    });
  }

  if (input.runs.length > 1) {
    rows.push({
      id: "attempts",
      kind: "watch",
      title: input.t("Earlier tries"),
      description: input.t("{count} earlier tries", { count: input.runs.length - 1 }),
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
  readonly artifactsById: ReadonlyMap<string, RunArtifact>;
  readonly actions: readonly ExecutionAction[];
  readonly failedRuns: readonly RunSession[];
  readonly failedActions: readonly ExecutionAction[];
  readonly pendingApprovals: readonly ApprovalRequest[];
}): readonly ConversationWorkCellGroup[] {
  const changedArtifacts = input.artifacts.filter((artifact) => artifact.type === "diff" || artifact.type === "file");
  const changedRows = uniqueBy(changedArtifacts, (artifact) => artifact.path || artifact.id).slice(0, 8).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    kind: "edit" as const,
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral" as const,
  }));
  const checkedRows = input.runs.slice(0, 8).map((run) => ({
    id: `run:${run.id}`,
    kind: "verify" as const,
    title: readRunTitle(run),
    description: run.errorMessage ? truncatePreview(run.errorMessage, 160) : undefined,
    meta: operationStatusMeta(run.status, input.t),
    tone: runStatusTone(run.status),
  }));
  const evidenceRows: ConversationWorkCellRow[] = [
    ...buildConversationExecutionActionEvidenceRows({
      actions: input.actions,
      artifactsById: input.artifactsById,
      t: input.t,
      limit: 8,
    }),
    ...input.artifacts.slice(0, 8).map((artifact) => {
      const kind: ConversationOperationKind = artifact.type === "diff" || artifact.type === "file" || artifact.path ? "edit" : "verify";
      return {
        id: `evidence:${artifact.id}`,
        kind,
        title: artifact.title || artifact.path || artifact.id,
        description: artifact.path,
        meta: artifact.type,
        tone: "neutral" as const,
      };
    }),
    ...input.approvals.slice(0, 5).map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval" as const,
      title: approval.title,
      description: approval.description,
      meta: effectiveApprovalStatus(approval),
      tone: effectiveApprovalStatus(approval) === "pending" ? "waiting" as const : "neutral" as const,
    })),
  ];
  const attentionRows: ConversationWorkCellRow[] = [
    ...input.pendingApprovals.slice(0, 5).map((approval) => ({
      id: `pending:${approval.id}`,
      kind: "approval" as const,
      title: approval.title,
      description: approval.description,
      meta: input.t("Waiting for approval"),
      tone: "waiting" as const,
    })),
    ...input.failedRuns.slice(0, 5).map((run) => ({
      id: `failed-run:${run.id}`,
      kind: "watch" as const,
      title: readRunTitle(run),
      description: run.errorMessage ? truncatePreview(run.errorMessage, 180) : input.t("Failed without a captured error message."),
      meta: operationStatusMeta(run.status, input.t),
      tone: "failed" as const,
    })),
    ...input.failedActions.slice(0, 5).map((action) => ({
      id: `failed-action:${action.id}`,
      kind: operationKindForExecutionAction(action),
      title: action.title,
      description: action.summary,
      detailLines: executionActionDetailLines(action, input.artifactsById, input.t),
      meta: operationStatusMeta(action.status, input.t),
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
      label: input.t("Checks"),
      summary: input.t("{count} checks", { count: input.runs.length }),
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

export function buildConversationExecutionActionEvidenceRows(input: {
  readonly actions: readonly ExecutionAction[];
  readonly artifacts?: readonly RunArtifact[];
  readonly artifactsById?: ReadonlyMap<string, RunArtifact>;
  readonly t: Translate;
  readonly limit?: number;
}): readonly ConversationWorkCellRow[] {
  const artifactsById = input.artifactsById ?? artifactsByIdMap(input.artifacts ?? []);
  return input.actions
    .filter(isMainFeedActionRow)
    .slice(0, input.limit ?? 8)
    .map((action) => executionActionEvidenceRow(action, artifactsById, input.t));
}

function artifactsByIdMap(artifacts: readonly RunArtifact[]): ReadonlyMap<string, RunArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

function isMainFeedActionRow(action: ExecutionAction): boolean {
  if (action.status === "proposed") {
    return false;
  }
  return executionActionHasUserFacingTarget(action) ||
    action.resultArtifactIds.length > 0 ||
    Boolean(action.summary.trim());
}

function executionActionEvidenceRow(
  action: ExecutionAction,
  artifactsById: ReadonlyMap<string, RunArtifact>,
  t: Translate,
): ConversationWorkCellRow {
  return {
    id: `action:${action.id}`,
    kind: operationKindForExecutionAction(action),
    title: action.title,
    description: action.summary,
    detailLines: executionActionDetailLines(action, artifactsById, t),
    meta: operationStatusMeta(action.status, t),
    tone: executionActionTone(action),
  };
}

function compareExecutionActionTranscriptOrder(left: ExecutionAction, right: ExecutionAction): number {
  const leftTime = left.executedAt ?? left.resolvedAt ?? left.completedAt ?? left.createdAt;
  const rightTime = right.executedAt ?? right.resolvedAt ?? right.completedAt ?? right.createdAt;
  const timeComparison = leftTime.localeCompare(rightTime);
  return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
}

function executionActionDetailLines(
  action: ExecutionAction,
  artifactsById: ReadonlyMap<string, RunArtifact>,
  t: Translate,
): readonly ConversationWorkCellRowDetailLine[] {
  const lines: ConversationWorkCellRowDetailLine[] = [];
  const push = (line: ConversationWorkCellRowDetailLine): void => {
    const text = line.text.trim();
    if (!text || lines.some((existing) => existing.text === text)) {
      return;
    }
    lines.push({ ...line, text });
  };

  for (const ref of action.targetRefs) {
    if (ref.type === "command") {
      const command = userFacingTargetRefText(ref);
      if (command) {
        push({ kind: "code", text: `$ ${truncatePreview(command, 140)}` });
      }
      continue;
    }
    if (ref.type === "file") {
      const path = userFacingTargetRefText(ref);
      if (path) {
        push({ text: path });
      }
      continue;
    }
    if (ref.type === "mcp_tool") {
      const tool = userFacingTargetRefText(ref);
      if (tool) {
        push({ text: `${t("Tool")}: ${tool}` });
      }
    }
  }

  const outputArtifacts = action.resultArtifactIds
    .map((artifactId) => artifactsById.get(artifactId))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact))
    .filter((artifact) => isMainFeedSafeText([mainFeedArtifactLabel(artifact), artifact.path].join(" ")));
  if (outputArtifacts.length > 0) {
    push({ text: outputArtifacts.length === 1 ? t("1 output recorded") : t("{count} outputs recorded", { count: outputArtifacts.length }) });
  }

  if (lines.length === 0 && action.scopeSummary?.trim()) {
    push({ text: action.scopeSummary });
  }

  return lines.slice(0, 5);
}

function executionActionHasUserFacingTarget(action: ExecutionAction): boolean {
  return action.targetRefs.some((ref) =>
    (ref.type === "command" || ref.type === "file" || ref.type === "mcp_tool") &&
    Boolean(userFacingTargetRefText(ref)));
}

function userFacingTargetRefText(ref: ExecutionAction["targetRefs"][number]): string | undefined {
  const value = (ref.path ?? ref.label ?? "").trim();
  if (!value || value === ref.id || isInternalTargetLabel(value)) {
    return undefined;
  }
  return value;
}

function isInternalTargetLabel(value: string): boolean {
  return /\b(?:run|work[-_\s]?unit|workflow|task|channel)_[a-z0-9_-]+\b/iu.test(value) ||
    /\btool[_-]?call[_-]?[a-z0-9_-]*\b/iu.test(value) ||
    /^call[_-]?[a-z0-9_-]+$/iu.test(value) ||
    /^[a-z0-9_-]{24,}$/iu.test(value);
}

function executionActionTone(action: ExecutionAction): ConversationWorkCellRowTone {
  if (action.status === "failed" || action.status === "denied" || action.status === "expired") {
    return "failed";
  }
  if (action.status === "waiting_for_approval") {
    return "waiting";
  }
  if (action.status === "succeeded" || action.status === "approved") {
    return "success";
  }
  if (action.status === "executing") {
    return "running";
  }
  return "neutral";
}

function buildWorkCellSummary(input: {
  readonly t: Translate;
  readonly status: ConversationWorkCellStatus;
  readonly latestRun: RunSession;
  readonly title: string;
  readonly pendingApprovalCount: number;
}): string {
  if (input.status === "succeeded") {
    return input.title;
  }
  if (input.status === "failed") {
    const issue = input.latestRun.errorMessage ? truncatePreview(input.latestRun.errorMessage, 180) : input.t("No failure message was captured.");
    return input.t("Failed: {issue}", { issue });
  }
  if (input.status === "cancelled" || input.status === "superseded") {
    return input.t("Cancelled: {title}.", { title: input.title });
  }
  if (input.status === "waiting_for_approval" || input.pendingApprovalCount > 0) {
    return input.t("Waiting for approval to continue.");
  }
  if (input.status === "queued" || input.status === "open") {
    return input.t("Queued: {title}.", { title: input.title });
  }
  if (input.status === "blocked") {
    return input.t("Blocked: waiting for input.");
  }
  return input.t("Working on {title}.", { title: input.title });
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
  return "Task";
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

function runOperationTitle(status: RunSession["status"], title: string, t: Translate): string {
  if (status === "waiting_for_approval") {
    return t("Waiting for approval: {title}", { title });
  }
  if (status === "queued") {
    return t("Waiting to start {title}", { title });
  }
  if (status === "failed") {
    return t("Could not finish {title}", { title });
  }
  if (status === "cancelled") {
    return t("Stopped {title}", { title });
  }
  if (status === "succeeded") {
    return t("Finished {title}", { title });
  }
  return t("Working on {title}", { title });
}

function operationStatusMeta(status: string, t: Translate): string | undefined {
  if (status === "succeeded") {
    return undefined;
  }
  if (status === "failed") {
    return t("Failed");
  }
  if (status === "cancelled" || status === "superseded") {
    return t("Stopped");
  }
  if (status === "waiting_for_approval") {
    return t("Waiting for approval");
  }
  if (status === "queued") {
    return undefined;
  }
  if (status === "denied") {
    return t("Denied");
  }
  if (status === "expired") {
    return t("Expired");
  }
  return undefined;
}

function operationKindForExecutionAction(action: ExecutionAction): ConversationOperationKind {
  if (action.actionType === "read" || action.actionType === "grep" || action.actionType === "find" || action.actionType === "ls") {
    return "read";
  }
  if (action.actionType === "write" || action.actionType === "edit") {
    return "edit";
  }
  if (action.actionType === "bash" || action.targetRefs.some((target) => target.type === "command")) {
    return "run_command";
  }
  if (action.actionType === "workflow_step") {
    return "handoff";
  }
  if (action.actionType === "mcp_tool_call") {
    return "search";
  }
  return "approval";
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
