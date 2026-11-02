import {
  projectCanonicalConversationTimeline,
  isUserVisibleTerminalReportArtifact,
  terminalReportSourceRefs,
  userInputTranscriptRevisionSignature,
  reconcileCanonicalUserInputs,
  type CanonicalConversationItem,
  type CanonicalCompactionRecord,
  type CanonicalExecutionAction,
  type CanonicalParticipantSpan,
  type CanonicalPlanRecord,
  type CanonicalReasoningSummaryRecord,
  type CanonicalTerminalReportProjection,
  type CanonicalSourceRef,
  type CanonicalTranscriptProjection,
  type CanonicalTranscriptScope,
} from "@ling-stack/conversation-ui-core";
import type {
  ConversationDetailResponse,
  ConversationItemV1,
  ExecutionAction,
  LingThread,
  RunSession,
} from "../../types.js";

/**
 * The API/domain boundary for the canonical transcript.  The UI core remains
 * framework- and daemon-free: this adapter is the only place that knows how
 * `ConversationDetailResponse` joins runs, turn attempts, and Continuity items.
 */
export interface CanonicalTranscriptSnapshotOptions {
  readonly surface?: CanonicalTranscriptScope["surface"];
  readonly turnId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly participantId?: string;
  readonly depth?: 0 | 1;
}

export function projectConversationDetailTimeline(
  detail: ConversationDetailResponse,
  options: CanonicalTranscriptSnapshotOptions = {},
): CanonicalTranscriptProjection {
  const scope = buildScope(detail.thread, options);
  const items = detail.conversationItems
    .filter((item) => item.threadId === detail.thread.id && item.workspaceId === detail.thread.workspaceId)
    .map(toCanonicalConversationItem);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const turnByRunId = new Map(detail.runLinks.map((link) => [link.runId, link]));
  const runById = new Map(detail.runs.map((run) => [run.id, run]));
  const checkpointByApprovalId = new Map(detail.approvalCheckpoints.map((checkpoint) => [checkpoint.approvalId, checkpoint]));
  const actions = detail.executionActions
    .filter((action) => !action.threadId || action.threadId === detail.thread.id)
    .map((action) => toCanonicalExecutionAction(action, itemById, turnByRunId, runById, scope));
  const sourceSequence = items.reduce((max, item) => Math.max(max, item.sequence), 0);
  const maxItemRevision = items.reduce((max, item) => Math.max(max, item.revision), 0);
  const maxActionRevision = actions.reduce((max, action) => Math.max(max, action.revision), 0);
  const reasoningSummaries = (detail.reasoningSummaries ?? []).map(toCanonicalReasoningSummaryRecord);
  const maxReasoningRevision = reasoningSummaries.reduce((max, summary) => Math.max(max, summary.revision), 0);
  const adapterDiagnostics: import("@ling-stack/conversation-ui-core").CanonicalTranscriptDiagnostic[] = [];
  const plans = durableCollection(detail.plans, "plans", adapterDiagnostics)
    .filter((plan) => plan.threadId === detail.thread.id && plan.status !== "archived" && plan.status !== "superseded")
    .map((plan) => toCanonicalPlanRecord(plan, items, detail.thread.id, adapterDiagnostics))
    .filter((plan): plan is CanonicalPlanRecord => Boolean(plan));
  const contextSnapshots = durableCollection(detail.contextSnapshots, "context snapshots", adapterDiagnostics);
  const contextSummaries = durableCollection(detail.contextSummaries, "context summaries", adapterDiagnostics);
  const contextResolution = resolveConversationContextSnapshots({
    threadId: detail.thread.id,
    workspaceId: detail.thread.workspaceId,
    items: detail.conversationItems,
    snapshots: contextSnapshots,
    summaries: contextSummaries,
  });
  adapterDiagnostics.push(...contextResolution.diagnostics.map((diagnostic) => ({
    code: "missing_context_source" as const,
    sourceRefs: [
      { kind: "context_snapshot", id: diagnostic.snapshotId },
      ...(diagnostic.sourceRefId !== "<none>" && diagnostic.sourceRefType === "conversation_item"
        ? [{ kind: "conversation_item", id: diagnostic.sourceRefId }]
        : []),
    ],
    message: diagnostic.message,
  })));
  const contextSegmentIdByItemId = buildContextSegmentLookup(contextResolution.snapshots);
  const compactions = durableCollection(detail.compactionCheckpoints, "compaction checkpoints", adapterDiagnostics)
    .filter((checkpoint) => checkpoint.threadId === detail.thread.id)
    .map((checkpoint) => toCanonicalCompactionRecord(checkpoint, contextSnapshots, contextSummaries, items, detail.thread.id, adapterDiagnostics))
    .filter((compaction): compaction is CanonicalCompactionRecord => Boolean(compaction));
  const participantSpans = buildParticipantSpans({
    detail,
    scope,
    items,
    actions,
    turnRuns: detail.runLinks,
    itemById,
    runById,
    contextSegmentIdByItemId,
    diagnostics: adapterDiagnostics,
  });
  const terminalReports = detail.terminalReports
    .map(toCanonicalTerminalReportProjection)
    .filter((report): report is CanonicalTerminalReportProjection => Boolean(report));
  return projectCanonicalConversationTimeline({
    scope,
    items,
    actions,
    userInputs: detail.userInputs,
    turnRuns: detail.runLinks.map((link) => ({
      runId: link.runId,
      turnId: link.turnId,
      attemptNumber: link.attemptNumber,
      role: link.role,
    })),
    approvals: detail.approvals.map((approval) => toCanonicalApprovalRecord(
      approval,
      checkpointByApprovalId.get(approval.id),
      itemById,
      runById,
      actions,
      detail.thread.id,
    )),
    artifacts: visibleDetailArtifacts(detail.artifacts, actions).map((artifact) => toCanonicalArtifactRecord(artifact, actions, itemById, detail.thread.id)),
    plans,
    compactions: [...compactions, ...(detail.contextCompactions ?? [])],
    reasoningSummaries,
    terminalReports,
    participantSpans,
    contextSegmentIdByItemId,
    sourceSequence,
    sourceRevision: `${detail.thread.updatedAt}:${maxItemRevision}:${maxActionRevision}:${maxReasoningRevision}:${plans.map((plan) => `${plan.id}:${plan.revision}`).join(",")}:${[...compactions, ...(detail.contextCompactions ?? [])].map((record) => `${record.id}:${record.revision}`).join(",")}:${participantSpans.map((span) => `${span.id}:${span.revision}`).join(",")}:${userInputTranscriptRevisionSignature(detail.userInputs)}`,
    initialDiagnostics: adapterDiagnostics,
  });
}

function toCanonicalReasoningSummaryRecord(
  summary: ConversationDetailResponse["reasoningSummaries"][number],
): CanonicalReasoningSummaryRecord {
  return {
    ...summary,
    sourceRefs: summary.sourceRefs.map((ref) => ({ ...ref })),
  };
}

function toCanonicalTerminalReportProjection(
  report: ConversationDetailResponse["terminalReports"][number],
): CanonicalTerminalReportProjection | undefined {
  if (!Number.isSafeInteger(report.generation) || report.generation < 1 || !report.resultItemId) {
    return undefined;
  }
  return {
    generation: report.generation,
    resultItemId: report.resultItemId,
    report: {
      id: report.id,
      workspaceId: report.workspaceId,
      ...(report.threadId ? { threadId: report.threadId } : {}),
      ...(report.turnId ? { turnId: report.turnId } : {}),
      source: report.source,
      status: report.status,
      evidenceFingerprint: report.evidenceFingerprint,
      language: report.language,
      outcome: {
        status: report.outcome.status,
        title: report.outcome.title,
        summary: report.outcome.summary,
        sourceRefs: terminalReportSourceRefs(report.outcome.sourceRefs),
        corrections: report.outcome.corrections.map((correction) => ({
          ...correction,
          sourceRefs: terminalReportSourceRefs(correction.sourceRefs),
        })),
      },
      changes: report.changes.map((change) => ({
        ...change,
        sourceRefs: terminalReportSourceRefs(change.sourceRefs),
      })),
      verification: report.verification.map((verification) => ({
        ...verification,
        sourceRefs: terminalReportSourceRefs(verification.sourceRefs),
      })),
      participants: report.participants.map((participant) => ({
        ...participant,
        sourceRefs: terminalReportSourceRefs(participant.sourceRefs),
      })),
      artifacts: report.artifacts.map((artifact) => ({
        ...artifact,
        sourceRefs: terminalReportSourceRefs(artifact.sourceRefs),
      })),
      risks: report.risks.map((risk) => ({
        ...risk,
        sourceRefs: terminalReportSourceRefs(risk.sourceRefs),
      })),
      references: terminalReportSourceRefs(report.references),
    },
  };
}

function toCanonicalPlanRecord(
  plan: import("../../types.js").ProposedPlanArtifact,
  items: readonly CanonicalConversationItem[],
  threadId: string,
  diagnostics: import("@ling-stack/conversation-ui-core").CanonicalTranscriptDiagnostic[],
): CanonicalPlanRecord | undefined {
  const anchor = resolvePlanAnchor(plan, items);
  const sourceRefs = planSourceRefs(plan, anchor?.id);
  if (!anchor) {
    diagnostics.push({
      code: "missing_anchor",
      sourceRefs,
      message: `Plan ${plan.id} has no explicit conversation-item anchor.`,
    });
    return undefined;
  }
  return {
    id: plan.id,
    revision: recordRevision(plan.version, plan.updatedAt),
    workspaceId: plan.workspaceId,
    threadId,
    ...(plan.sourceTurnId ? { turnId: plan.sourceTurnId } : {}),
    anchorItemId: anchor.id,
    title: plan.title,
    steps: parsePlanSteps(plan.bodyMarkdown),
    sourceRefs,
  };
}

function toCanonicalCompactionRecord(
  checkpoint: import("../../types.js").CompactionCheckpoint,
  snapshots: readonly import("../../types.js").ConversationContextSnapshot[],
  summaries: readonly import("../../types.js").ConversationContextSummary[],
  items: readonly CanonicalConversationItem[],
  threadId: string,
  diagnostics: import("@ling-stack/conversation-ui-core").CanonicalTranscriptDiagnostic[],
): CanonicalCompactionRecord | undefined {
  const anchor = items
    .filter((item) => item.turnId === checkpoint.sourceTurnId)
    .sort((left, right) => left.sequence - right.sequence)[0]
    ?? items.find((item) => item.sequence === checkpoint.coveredItemSeqTo);
  const snapshot = snapshots
    .filter((candidate) => candidate.threadId === threadId)
    .find((candidate) => candidate.id === checkpoint.contextViewId || candidate.segmentId === checkpoint.contextViewId)
    ?? snapshots
      .filter((candidate) => candidate.threadId === threadId && candidate.throughItemSequence === checkpoint.coveredItemSeqTo)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const sourceRefs = compactionSourceRefs(checkpoint, snapshot, anchor?.id);
  if (!anchor) {
    diagnostics.push({
      code: "missing_anchor",
      sourceRefs,
      message: `Compaction checkpoint ${checkpoint.id} has no source-turn or covered-sequence anchor.`,
    });
    return undefined;
  }
  const summaryRecords = checkpoint.summaryIds
    .map((id) => summaries.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is import("../../types.js").ConversationContextSummary => Boolean(candidate));
  const summary = summaryRecords.length > 0
    ? summaryRecords.map((record) => record.objective ?? record.decisions[0] ?? record.constraints[0] ?? `Summary ${record.id}`).join(" · ")
    : checkpoint.summaryIds.length > 0
    ? `Context summary ${checkpoint.summaryIds.join(", ")}`
    : `Context compacted through item ${checkpoint.coveredItemSeqTo}`;
  return {
    id: checkpoint.id,
    revision: recordRevision(undefined, checkpoint.createdAt),
    workspaceId: checkpoint.workspaceId,
    threadId,
    turnId: checkpoint.sourceTurnId,
    anchorItemId: anchor.id,
    summary,
    compactedTurnCount: checkpoint.coveredTurnIds.length,
    ...(snapshot ? { snapshotRef: { kind: "context_snapshot", id: snapshot.id, label: snapshot.segmentId } } : checkpoint.contextViewId ? {
      snapshotRef: { kind: "context_view", id: checkpoint.contextViewId },
    } : {}),
    sourceRefs,
  };
}

function buildParticipantSpans(input: {
  readonly detail: ConversationDetailResponse;
  readonly scope: CanonicalTranscriptScope;
  readonly items: readonly CanonicalConversationItem[];
  readonly actions: readonly CanonicalExecutionAction[];
  readonly turnRuns: readonly import("../../types.js").LingTurnRun[];
  readonly itemById: ReadonlyMap<string, CanonicalConversationItem>;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
  readonly diagnostics: import("@ling-stack/conversation-ui-core").CanonicalTranscriptDiagnostic[];
}): readonly CanonicalParticipantSpan[] {
  if (input.scope.depth === 1) return [];
  const parentRuns = input.scope.runId
    ? input.detail.runs.filter((run) => run.id === input.scope.runId)
    : input.detail.runs.filter((run) => !run.parentRunId);
  const spans: CanonicalParticipantSpan[] = [];
  const userInputs = reconcileCanonicalUserInputs({
    scope: input.scope, incoming: { items: input.items, userInputs: input.detail.userInputs }, mode: "page",
  }).userInputs;
  for (const childRun of input.detail.runs) {
    if (!childRun.parentRunId || !parentRuns.some((parent) => parent.id === childRun.parentRunId)) continue;
    const parentAction = findParentDelegationAction(childRun, input.actions);
    // A parentRunId is also used for retry/resume. Only a teammate or an explicit
    // delegation action is a participant span; continuations remain one run chain.
    if (!childRun.teammateId && !parentAction) continue;
    const anchorId = parentAction ? conversationAnchorId(parentAction.sourceRefs) : undefined;
    const anchor = anchorId ? input.itemById.get(anchorId) : undefined;
    if (!anchor) {
      input.diagnostics.push({
        code: "missing_anchor",
        sourceRefs: uniqueCanonicalRefs([
          ...(parentAction ? parentAction.sourceRefs : []),
          { kind: "run", id: childRun.id },
        ]),
        message: `Participant run ${childRun.id} has no explicit parent conversation-item anchor.`,
      });
      continue;
    }
    const participantId = childRun.teammateId ?? `run:${childRun.id}`;
    const childTurnId = input.turnRuns.find((link) => link.runId === childRun.id)?.turnId;
    const childActions = input.actions.filter((action) => action.runId === childRun.id);
    const childActionAnchorIds = new Set(childActions.flatMap((action) =>
      action.sourceRefs.filter((ref) => ref.kind === "conversation_item").map((ref) => ref.id)));
    const childUserInputIds = new Set(userInputs.flatMap(record =>
      record.availability === "available" && record.source.runId === childRun.id
        && record.source.participantId === participantId ? [record.itemId] : []));
    // The parent anchor belongs to the outer timeline.  Re-including it in the
    // child snapshot creates a synthetic blocked row (the child run has no
    // action for the parent's tool call) and makes the same fact appear twice.
    // Child items must be owned by the child turn/run; the parent span header is
    // the only visual bridge back to the anchor.
    const childItems = input.items.filter((item) =>
      item.domainRefs?.some((ref) => ref.type === "run" && ref.id === childRun.id)
      || childUserInputIds.has(item.id)
      || (item.kind !== "assistant_message" && item.kind !== "user_message" && childActionAnchorIds.has(item.id)));
    const childProjection = projectCanonicalConversationTimeline({
      scope: {
        surface: "child",
        threadId: input.scope.threadId,
        workspaceId: input.scope.workspaceId,
        ...(childTurnId ? { turnId: childTurnId } : {}),
        runId: childRun.id,
        participantId,
        depth: 1,
      },
      items: childItems,
      actions: childActions,
      userInputs: userInputs.filter(record => childUserInputIds.has(record.itemId)),
      turnRuns: input.turnRuns.map((link) => ({ runId: link.runId, turnId: link.turnId, attemptNumber: link.attemptNumber, role: link.role })),
      approvals: (input.detail.approvals ?? []).filter((approval) => approval.runId === childRun.id).map((approval) => toCanonicalApprovalRecord(
        approval,
        input.detail.approvalCheckpoints.find((checkpoint) => checkpoint.approvalId === approval.id),
        new Map(childItems.map((item) => [item.id, item])),
        new Map([[childRun.id, childRun]]),
        childActions,
        input.scope.threadId,
      )),
      artifacts: visibleDetailArtifacts(input.detail.artifacts ?? [], childActions).filter((artifact) => artifact.runId === childRun.id).map((artifact) => toCanonicalArtifactRecord(artifact, childActions, new Map(childItems.map((item) => [item.id, item])), input.scope.threadId)),
      plans: [],
      compactions: (input.detail.contextCompactions ?? []).filter(record => record.runId === childRun.id),
      reasoningSummaries: (input.detail.reasoningSummaries ?? [])
        .filter((summary) => summary.runId === childRun.id)
        .map(toCanonicalReasoningSummaryRecord),
      participantSpans: [],
      sourceSequence: childItems.reduce((max, item) => Math.max(max, item.sequence), 0),
      sourceRevision: `${childRun.id}:${childRun.updatedAt}:${childActions.reduce((max, action) => Math.max(max, action.revision), 0)}:${(input.detail.reasoningSummaries ?? []).filter((summary) => summary.runId === childRun.id).reduce((max, summary) => Math.max(max, summary.revision), 0)}:${(input.detail.contextCompactions ?? []).filter(record => record.runId === childRun.id).map(record => `${record.id}:${record.revision}`).join(",")}:${userInputTranscriptRevisionSignature(userInputs.filter(record => childUserInputIds.has(record.itemId)))}`,
      contextSegmentIdByItemId: selectContextSegments(input.contextSegmentIdByItemId, childItems),
    });
    input.diagnostics.push(...childProjection.diagnostics);
    const attemptLink = input.turnRuns.find((link) => link.runId === childRun.id);
    const attemptId = childActions.find((action) => action.attemptId)?.attemptId;
    spans.push({
      id: `participant:${childRun.id}`,
      revision: recordRevision(undefined, childRun.updatedAt),
      workspaceId: input.scope.workspaceId,
      threadId: input.scope.threadId,
      anchorItemId: anchor.id,
      ...(parentAction ? { parentActionId: parentAction.id } : {}),
      participantId,
      label: participantLabel(childRun, participantId),
      runId: childRun.id,
      ...(attemptId ? { attemptId } : {}),
      workflowStepId: childRun.workflowStepId,
      lifecycle: participantLifecycle(childRun.status),
      sourceRefs: uniqueCanonicalRefs([
        { kind: "conversation_item", id: anchor.id },
        { kind: "run", id: childRun.id },
        { kind: "participant", id: participantId, label: participantLabel(childRun, participantId) },
        ...(parentAction ? parentAction.sourceRefs : []),
      ]),
      childItems: childProjection.items,
    });
  }
  return spans;
}

function findParentDelegationAction(
  childRun: RunSession,
  actions: readonly CanonicalExecutionAction[],
): CanonicalExecutionAction | undefined {
  const candidates = actions.filter((action) => action.runId === childRun.parentRunId);
  return uniqueMatch(candidates, (action) => action.sourceRefs.some((ref) => ref.kind === "run" && ref.id === childRun.id));
}

function participantLifecycle(status: RunSession["status"]): CanonicalParticipantSpan["lifecycle"] {
  switch (status) {
    case "queued": return "started";
    case "running": return "running";
    case "waiting_for_approval": return "waiting";
    case "yielded": return "waiting";
    case "succeeded": return "completed";
    case "failed": return "errored";
    case "cancelled": return "interrupted";
  }
}

function participantLabel(run: RunSession, participantId: string): string {
  return run.teammateId ?? participantId;
}

function resolvePlanAnchor(
  plan: import("../../types.js").ProposedPlanArtifact,
  items: readonly CanonicalConversationItem[],
): CanonicalConversationItem | undefined {
  if (plan.sourceMessageId) {
    const byId = items.find((item) => item.id === plan.sourceMessageId);
    if (byId) return byId;
    const byPayload = items.find((item) => readString(item.payload, "messageId") === plan.sourceMessageId);
    if (byPayload) return byPayload;
  }
  if (plan.sourceTurnId) {
    const byTurn = items.filter((item) => item.turnId === plan.sourceTurnId).sort((left, right) => left.sequence - right.sequence);
    if (byTurn[0]) return byTurn[0];
  }
  if (plan.sourceRunId || plan.acceptedRunId) {
    const runId = plan.sourceRunId ?? plan.acceptedRunId;
    const byRun = items.filter((item) => item.domainRefs?.some((ref) => ref.type === "run" && ref.id === runId) || readString(item.payload, "runId") === runId).sort((left, right) => left.sequence - right.sequence);
    if (byRun[0]) return byRun[0];
  }
  if (plan.acceptedWorkflowStepId) {
    const byStep = items.filter((item) => item.domainRefs?.some((ref) => ref.type === "workflow_step" && ref.id === plan.acceptedWorkflowStepId)).sort((left, right) => left.sequence - right.sequence);
    if (byStep[0]) return byStep[0];
  }
  return undefined;
}

function planSourceRefs(
  plan: import("../../types.js").ProposedPlanArtifact,
  anchorItemId?: string,
): readonly CanonicalSourceRef[] {
  return uniqueCanonicalRefs([
    { kind: "plan", id: plan.id, label: plan.title },
    ...(anchorItemId ? [{ kind: "conversation_item", id: anchorItemId }] : []),
    ...(plan.sourceMessageId ? [{ kind: "message", id: plan.sourceMessageId }] : []),
    ...(plan.sourceTurnId ? [{ kind: "turn", id: plan.sourceTurnId }] : []),
    ...(plan.sourceRunId ? [{ kind: "run", id: plan.sourceRunId }] : []),
    ...(plan.acceptedWorkflowStepId ? [{ kind: "workflow_step", id: plan.acceptedWorkflowStepId }] : []),
  ]);
}

function compactionSourceRefs(
  checkpoint: import("../../types.js").CompactionCheckpoint,
  snapshot: import("../../types.js").ConversationContextSnapshot | undefined,
  anchorItemId?: string,
): readonly CanonicalSourceRef[] {
  return uniqueCanonicalRefs([
    { kind: "compaction_checkpoint", id: checkpoint.id },
    ...(anchorItemId ? [{ kind: "conversation_item", id: anchorItemId }] : []),
    { kind: "turn", id: checkpoint.sourceTurnId },
    ...checkpoint.summaryIds.map((id) => ({ kind: "context_summary", id })),
    ...checkpoint.sourceRefs.map((ref) => ({ kind: ref.type, id: ref.id, label: ref.label })),
    ...(checkpoint.contextViewId ? [{ kind: "context_view", id: checkpoint.contextViewId }] : []),
    ...(snapshot ? [{ kind: "context_snapshot", id: snapshot.id }, ...(snapshot.segmentId ? [{ kind: "segment", id: snapshot.segmentId }] : [])] : []),
  ]);
}

function parsePlanSteps(markdown: string): readonly CanonicalPlanRecord["steps"][number][] {
  const lines = markdown.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const steps: { id: string; text: string; status: "pending" | "running" | "completed" | "blocked" }[] = [];
  for (const line of lines) {
    const checked = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/u);
    if (checked) {
      steps.push({ id: `step-${steps.length + 1}`, text: checked[2]!.trim(), status: checked[1]!.toLowerCase() === "x" ? "completed" : "pending" });
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/u);
    const bullet = line.match(/^[-*]\s+(.+)$/u);
    const text = ordered?.[1] ?? bullet?.[1];
    if (text && !text.startsWith("#")) steps.push({ id: `step-${steps.length + 1}`, text: text.trim(), status: "pending" });
  }
  if (steps.length > 0) return steps;
  return lines.filter((line) => !line.startsWith("#")).slice(0, 12).map((text, index) => ({ id: `step-${index + 1}`, text, status: "pending" }));
}

function recordRevision(version: number | undefined, updatedAt: string): number {
  if (Number.isSafeInteger(version) && (version as number) > 0) return version as number;
  const parsed = Date.parse(updatedAt);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function uniqueCanonicalRefs(refs: readonly CanonicalSourceRef[]): CanonicalSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!ref || typeof ref.kind !== "string" || typeof ref.id !== "string" || ref.id.length === 0) return false;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildScope(
  thread: LingThread,
  options: CanonicalTranscriptSnapshotOptions,
): CanonicalTranscriptScope {
  const surface = options.surface ?? inferSurface(thread);
  return {
    surface,
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    ...((options.participantId ?? (surface === "private" ? thread.teammateId : undefined))
      ? { participantId: options.participantId ?? thread.teammateId } : {}),
    depth: options.depth ?? 0,
  };
}

function inferSurface(thread: LingThread): CanonicalTranscriptScope["surface"] {
  if (thread.kind === "teammate_direct") return "private";
  if (thread.kind === "channel_discussion") {
    if (thread.parentThreadId) return thread.forkedFromRunId ? "branch" : "topic";
    return "channel_root";
  }
  return "normal";
}

function toCanonicalConversationItem(item: ConversationItemV1): CanonicalConversationItem {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    threadId: item.threadId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    sequence: item.sequence,
    kind: item.kind,
    status: item.status,
    actorType: item.actorType,
    ...(item.actorId ? { actorId: item.actorId } : {}),
    revision: item.revision,
    payload: item.payload,
    ...(item.domainRefs.length > 0 ? {
      domainRefs: item.domainRefs.map((ref) => ({ type: ref.type, id: ref.id, ...(ref.label ? { label: ref.label } : {}) })),
    } : {}),
  };
}

function toCanonicalExecutionAction(
  action: ExecutionAction,
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
  turnByRunId: ReadonlyMap<string, { readonly turnId: string; readonly attemptNumber: number; readonly role: "primary" | "retry" | "resume" | "repair" | "validation" }>,
  runById: ReadonlyMap<string, RunSession>,
  scope: CanonicalTranscriptScope,
): CanonicalExecutionAction {
  const runLink = action.runId ? turnByRunId.get(action.runId) : undefined;
  const run = action.runId ? runById.get(action.runId) : undefined;
  const sourceRefs = addConversationAnchor([
    ...action.sourceRefs,
    ...action.targetRefs
      .filter((ref) => Boolean(ref.id || ref.path || ref.label))
      .map((ref) => ({ kind: ref.type, id: ref.id ?? ref.path ?? ref.label ?? ref.type, label: ref.label, path: ref.path })),
    ...action.previewArtifactIds.map((id) => ({ kind: "artifact", id })),
    ...action.resultArtifactIds.map((id) => ({ kind: "artifact", id })),
  ], action, itemById);
  return {
    id: action.id,
    revision: action.revision,
    sourceEventSequence: action.sourceEventSequence,
    workspaceId: action.workspaceId,
    ...(action.threadId ? { threadId: action.threadId } : {}),
    ...(runLink?.turnId ? { turnId: runLink.turnId } : {}),
    ...(action.runId ? { runId: action.runId } : {}),
    ...(action.attemptId ? { attemptId: action.attemptId } : {}),
    ...(runLink ? { attemptNumber: runLink.attemptNumber, turnRunRole: runLink.role } : {}),
    ...(action.workUnitId || run?.workUnitId ? { workUnitId: action.workUnitId ?? run?.workUnitId } : {}),
    // Every execution action must carry a stable participant owner into the
    // canonical timeline. Normal conversations do not have a teammate on the
    // RunSession, so the local Ling agent is the explicit default rather than
    // omitting the field and causing the projector to fail closed.
    participantId: action.participantId ?? run?.teammateId ?? scope.participantId ?? "ling",
    workflowStepId: action.workflowStepId ?? run?.workflowStepId ?? null,
    ...(action.approvalId ? { approvalId: action.approvalId } : {}),
    ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}),
    actionType: action.actionType,
    risk: action.risk,
    status: action.status,
    title: action.title,
    summary: action.summary,
    ...(action.toolEvidence ? { toolEvidence: action.toolEvidence } : {}),
    ...(action.runtimeDiagnostic ? { runtimeDiagnostic: action.runtimeDiagnostic } : {}),
    sourceRefs,
    ...(action.diagnostics ? { diagnostics: action.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      sourceRefs: diagnostic.sourceRefs.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        ...(ref.label ? { label: ref.label } : {}),
        ...(ref.path ? { path: ref.path } : {}),
      })),
    })) } : {}),
    ...(action.commandEvidence ? {
      commandEvidence: {
        ...action.commandEvidence,
        // Keep the Host totals at the canonical boundary. The output tail is
        // intentionally bounded and must never be mistaken for the total.
        outputByteCount: action.commandEvidence.outputByteCount,
        outputLineCount: action.commandEvidence.outputLineCount,
        stdoutArtifactId: action.commandEvidence.stdoutArtifactId,
        stderrArtifactId: action.commandEvidence.stderrArtifactId,
        resultArtifactId: action.commandEvidence.resultArtifactId,
      },
    } : {}),
    previewArtifactIds: action.previewArtifactIds,
    resultArtifactIds: action.resultArtifactIds,
  };
}

function toCanonicalApprovalRecord(
  approval: ConversationDetailResponse["approvals"][number],
  checkpoint: ConversationDetailResponse["approvalCheckpoints"][number] | undefined,
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
  runById: ReadonlyMap<string, RunSession>,
  actions: readonly CanonicalExecutionAction[],
  threadId: string,
): import("@ling-stack/conversation-ui-core").CanonicalApprovalRecord {
  const runId = checkpoint?.runId ?? approval.runId;
  const run = runId ? runById.get(runId) : undefined;
  const participantId = run?.teammateId ?? (run ? "ling" : undefined);
  const explicitAnchorItemId = findItemAnchor(itemById, (item) => item.kind === "approval_request",
    (item) => readString(item.payload, "approvalRequestId") === approval.id ||
      readString(item.payload, "approvalId") === approval.id ||
      item.domainRefs?.some((ref) => ref.type === "approval" && ref.id === approval.id) === true)
    ?? findItemAnchor(itemById, (item) => item.kind === "approval_decision",
      (item) => readString(item.payload, "approvalRequestId") === approval.id ||
        readString(item.payload, "approvalId") === approval.id ||
        item.domainRefs?.some((ref) => ref.type === "approval" && ref.id === approval.id) === true);
  const actionAnchor = explicitAnchorItemId ? undefined
    : verifiedApprovalActionAnchor(approval, runId, participantId, actions, itemById, threadId);
  const anchorItemId = explicitAnchorItemId ?? actionAnchor?.itemId;
  const attemptId = checkpoint?.resumeBasis?.priorAttemptId;
  const sourceRefs = withCanonicalRefs([], [
    { kind: "approval", id: approval.id },
    ...(checkpoint ? [{ kind: "approval_checkpoint", id: checkpoint.id }] : []),
    ...(runId ? [{ kind: "run", id: runId }] : []),
    ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
    ...(participantId ? [{ kind: "participant", id: participantId }] : []),
    ...(checkpoint?.workflowStepId ? [{ kind: "workflow_step", id: checkpoint.workflowStepId }] : []),
    ...(approval.toolCallId ? [{ kind: "tool_call", id: approval.toolCallId }] : []),
    ...(anchorItemId ? [{ kind: "conversation_item", id: anchorItemId }] : []),
  ]);
  return {
    id: approval.id,
    revision: checkpoint?.revision ?? (approval.resolvedAt ? 2 : 1),
    workspaceId: [...itemById.values()][0]?.workspaceId ?? "",
    threadId,
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(participantId ? { participantId } : {}),
    ...(checkpoint?.workflowStepId ? { workflowStepId: checkpoint.workflowStepId } : {}),
    ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
    ...(actionAnchor ? { actionId: actionAnchor.actionId } : {}),
    ...(anchorItemId ? { anchorItemId } : {}),
    title: approval.title,
    summary: approval.description || approval.decisionReason,
    status: approval.status,
    sourceRefs,
  };
}

/** An approval may share its durable source Item with its correlated tool action. */
function verifiedApprovalActionAnchor(
  approval: ConversationDetailResponse["approvals"][number],
  runId: string | undefined,
  participantId: string | undefined,
  actions: readonly CanonicalExecutionAction[],
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
  threadId: string,
): { readonly itemId: string; readonly actionId: string } | undefined {
  if (!runId || !participantId) return undefined;
  const action = uniqueMatch(actions, (candidate) =>
    candidate.id === `approval:${approval.id}` &&
    candidate.approvalId === approval.id &&
    candidate.runId === runId &&
    candidate.threadId === threadId &&
    candidate.participantId === participantId &&
    candidate.toolCallId === approval.toolCallId &&
    candidate.sourceRefs.some((ref) => ref.kind === "approval" && ref.id === approval.id));
  const anchorId = conversationAnchorId(action?.sourceRefs);
  const anchor = anchorId ? itemById.get(anchorId) : undefined;
  if (!anchor || !action || anchor.threadId !== threadId || anchor.workspaceId !== action.workspaceId) return undefined;
  if (action.turnId && anchor.turnId !== action.turnId) return undefined;
  return { itemId: anchor.id, actionId: action.id };
}

function visibleDetailArtifacts(
  artifacts: ConversationDetailResponse["artifacts"],
  actions: readonly CanonicalExecutionAction[],
): ConversationDetailResponse["artifacts"] {
  return artifacts.filter((artifact) => {
    if (isUserVisibleTerminalReportArtifact({
      id: artifact.id,
      title: artifact.title ?? "",
      path: artifact.path,
      sourceRefs: artifact.runId ? [{ kind: "run", id: artifact.runId }] : [],
    })) return true;
    // Run storage is private by default. A diff may enter an edit row only
    // when one exact Host action explicitly owns its result artifact.
    return artifact.type === "diff" && Boolean(artifact.runId && uniqueMatch(actions, (action) =>
      ["edit", "write", "file_edit", "file_write"].includes(action.actionType) &&
      action.runId === artifact.runId && action.resultArtifactIds?.includes(artifact.id) === true));
  });
}

function toCanonicalArtifactRecord(
  artifact: ConversationDetailResponse["artifacts"][number],
  actions: readonly CanonicalExecutionAction[],
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
  threadId: string,
): import("@ling-stack/conversation-ui-core").CanonicalArtifactRecord {
  const owner = uniqueMatch(actions, (action) =>
    action.resultArtifactIds?.includes(artifact.id) === true || action.previewArtifactIds?.includes(artifact.id) === true);
  const anchorItemId = conversationAnchorId(owner?.sourceRefs)
    ?? findItemAnchor(itemById, (item) => item.kind === "artifact_ref", (item) =>
      readString(item.payload, "artifactId") === artifact.id ||
      readString(item.payload, "id") === artifact.id ||
      item.domainRefs?.some((ref) => ref.type === "artifact" && ref.id === artifact.id) === true);
  const sourceRefs = withCanonicalRefs(owner?.sourceRefs ?? [], [
    { kind: "artifact", id: artifact.id, ...(artifact.title ? { label: artifact.title } : {}), path: artifact.path },
    ...(anchorItemId ? [{ kind: "conversation_item", id: anchorItemId }] : []),
  ]);
  return {
    id: artifact.id,
    revision: 1,
    workspaceId: owner?.workspaceId ?? [...itemById.values()][0]?.workspaceId ?? "",
    threadId,
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    ...(owner?.id ? { actionId: owner.id } : {}),
    ...(anchorItemId ? { anchorItemId } : {}),
    type: artifact.type,
    path: artifact.path,
    ...(artifact.title ? { title: artifact.title } : {}),
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    sourceRefs,
  };
}

function uniqueMatch<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function conversationAnchorId(
  refs: readonly { readonly kind: string; readonly id: string }[] | undefined,
): string | undefined {
  const anchors = refs?.filter((ref) => ref.kind === "conversation_item") ?? [];
  return anchors.length === 1 ? anchors[0]?.id : undefined;
}

function findItemAnchor(
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
  kindPredicate: (item: CanonicalConversationItem) => boolean,
  identityPredicate: (item: CanonicalConversationItem) => boolean,
): string | undefined {
  const matches = [...itemById.values()].filter((item) => kindPredicate(item) && identityPredicate(item));
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function withCanonicalRefs(
  existing: readonly CanonicalExecutionAction["sourceRefs"][number][],
  additions: readonly CanonicalExecutionAction["sourceRefs"][number][],
): CanonicalExecutionAction["sourceRefs"] {
  const seen = new Set<string>();
  return [...existing, ...additions].filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addConversationAnchor(
  sourceRefs: ExecutionAction["sourceRefs"],
  action: ExecutionAction,
  itemById: ReadonlyMap<string, CanonicalConversationItem>,
): CanonicalExecutionAction["sourceRefs"] {
  const refs = [...sourceRefs];
  if (refs.some((ref) => ref.kind === "conversation_item")) return refs;
  const allCandidates = [...itemById.values()];
  // Correlation ids are stronger than a missing/late turnId. A tool row may be
  // imported before the turn link is materialized, so never hide an exact match
  // merely because another item in the turn is already known.
  const correlated = allCandidates.find((item) => action.toolCallId && readString(item.payload, "toolCallId") === action.toolCallId)
    ?? allCandidates.find((item) => action.approvalId && (readString(item.payload, "approvalRequestId") === action.approvalId || readString(item.payload, "approvalId") === action.approvalId))
    ?? allCandidates.find((item) => action.runId && item.domainRefs?.some((ref) => ref.type === "run" && ref.id === action.runId));
  // A unique generic item is not an anchor. Arrival order and “only row in
  // the response” are not durable lineage. Only an explicit source ref or a
  // strong correlation id may attach evidence to the canonical sequence.
  const anchor = correlated;
  if (anchor) refs.push({ kind: "conversation_item", id: anchor.id });
  return refs;
}

function durableCollection<T>(
  value: readonly T[] | undefined,
  label: string,
  diagnostics: import("@ling-stack/conversation-ui-core").CanonicalTranscriptDiagnostic[],
): readonly T[] {
  if (value !== undefined) return value;
  diagnostics.push({
    code: "missing_lineage",
    sourceRefs: [],
    message: `Conversation detail omitted durable ${label}; projection is incomplete.`,
  });
  return [];
}

/**
 * Builds the only segment lookup allowed by the display batching adapter.
 * Only explicit item refs are accepted. Snapshot watermarks are a validation
 * fence, never a substitute for the item ids actually used by the model.
 */
function buildContextSegmentLookup(
  snapshots: readonly ResolvedContextSnapshot[],
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (!snapshot.segmentId?.trim()) continue;
    for (const itemId of snapshot.sourceItemIds) {
      // Newer snapshots win for the same source item; this is deterministic
      // because detail snapshots are immutable and ordered by source refs.
      lookup.set(itemId, snapshot.segmentId);
    }
  }
  return lookup;
}

export interface ContextSnapshotResolutionDiagnostic {
  readonly code: "missing_context_source";
  readonly snapshotId: string;
  readonly sourceRefType: string;
  readonly sourceRefId: string;
  readonly message: string;
}

export interface ResolvedContextSnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId?: string;
  readonly projectionVersion: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly import("@ling-stack/contracts").ConversationContextSnapshot["sourceRefs"][number][];
  /** Canonical-order ids derived from explicit conversation_item refs. */
  readonly sourceItemIds: readonly string[];
  readonly omittedItemCount: number;
}

interface ResolveConversationContextSnapshotsInput {
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly items: readonly ConversationItemV1[];
  readonly snapshots: readonly import("@ling-stack/contracts").ConversationContextSnapshot[];
  readonly summaries?: readonly import("@ling-stack/contracts").ConversationContextSummary[];
  /** Detail responses are already visibility-filtered; callers may tighten it. */
  readonly isVisible?: (item: ConversationItemV1) => boolean;
}

interface ResolveConversationContextSnapshotsResult {
  readonly snapshots: readonly ResolvedContextSnapshot[];
  readonly diagnostics: readonly ContextSnapshotResolutionDiagnostic[];
}

/**
 * Resolves durable context source refs without using a sequence window as a
 * substitute for the actual model input. `throughItemSequence` is only a
 * safety fence: an explicitly referenced item beyond it is invalid.
 */
export function resolveConversationContextSnapshots(
  input: ResolveConversationContextSnapshotsInput,
): ResolveConversationContextSnapshotsResult {
  const diagnostics: ContextSnapshotResolutionDiagnostic[] = [];
  const itemById = latestItemsById(input.items);
  const summariesById = new Map((input.summaries ?? []).map((summary) => [summary.id, summary]));
  const resolved: ResolvedContextSnapshot[] = [];

  for (const snapshot of input.snapshots) {
    if (snapshot.threadId !== input.threadId) {
      diagnostics.push({
        code: "missing_context_source",
        snapshotId: snapshot.id,
        sourceRefType: "thread",
        sourceRefId: snapshot.threadId,
        message: `Context snapshot ${snapshot.id} belongs to another thread.`,
      });
      continue;
    }

    const sourceRefs = uniqueDomainRefs([
      ...snapshot.sourceRefs,
      ...snapshot.summaryIds.flatMap((summaryId) => summariesById.get(summaryId)?.sourceRefs ?? []),
    ]);
    const itemRefs = sourceRefs.filter((ref) => ref.type === "conversation_item");
    const sourceItems: ConversationItemV1[] = [];
    let omittedItemCount = 0;

    if (itemRefs.length === 0 && snapshot.throughItemSequence > 0) {
      diagnostics.push({
        code: "missing_context_source",
        snapshotId: snapshot.id,
        sourceRefType: "conversation_item",
        sourceRefId: "<none>",
        message: `Context snapshot ${snapshot.id} has no explicit conversation-item source refs.`,
      });
    }

    for (const ref of itemRefs) {
      const item = itemById.get(ref.id);
      const invalidReason = contextItemInvalidReason(item, input, snapshot);
      if (invalidReason) {
        omittedItemCount += 1;
        diagnostics.push({
          code: "missing_context_source",
          snapshotId: snapshot.id,
          sourceRefType: ref.type,
          sourceRefId: ref.id,
          message: invalidReason,
        });
        continue;
      }
      if (!item) continue;
      sourceItems.push(item);
    }

    const uniqueSourceItems = [...new Map(sourceItems.map((item) => [item.id, item])).values()]
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    resolved.push({
      id: snapshot.id,
      threadId: snapshot.threadId,
      segmentId: snapshot.segmentId,
      projectionVersion: snapshot.projectionVersion,
      throughItemSequence: snapshot.throughItemSequence,
      summaryIds: snapshot.summaryIds,
      sourceRefs,
      sourceItemIds: uniqueSourceItems.map((item) => item.id),
      omittedItemCount,
    });
  }

  return { snapshots: resolved, diagnostics };
}

function latestItemsById(items: readonly ConversationItemV1[]): ReadonlyMap<string, ConversationItemV1> {
  const byId = new Map<string, ConversationItemV1>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || item.revision > previous.revision || (item.revision === previous.revision && item.updatedAt > previous.updatedAt)) {
      byId.set(item.id, item);
    }
  }
  return byId;
}

function contextItemInvalidReason(
  item: ConversationItemV1 | undefined,
  input: ResolveConversationContextSnapshotsInput,
  snapshot: import("@ling-stack/contracts").ConversationContextSnapshot,
): string | undefined {
  if (!item) return "Context source item is missing from the durable detail response.";
  if (input.workspaceId !== undefined && item.workspaceId !== input.workspaceId) return "Context source item belongs to another workspace.";
  if (item.threadId !== input.threadId) return "Context source item belongs to another thread.";
  if (item.status !== "committed" || !item.committedAt) return "Context source item is not committed.";
  if (input.isVisible && !input.isVisible(item)) return "Context source item is not visible to this consumer.";
  if (item.sequence > snapshot.throughItemSequence) return "Context source item is beyond the snapshot watermark.";
  return undefined;
}

function uniqueDomainRefs<T extends { readonly type: string; readonly id: string }>(refs: readonly T[]): T[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectContextSegments(
  lookup: ReadonlyMap<string, string>,
  items: readonly CanonicalConversationItem[],
): ReadonlyMap<string, string> {
  return new Map(items.flatMap((item) => {
    const segment = lookup.get(item.id);
    return segment ? [[item.id, segment] as const] : [];
  }));
}
function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
