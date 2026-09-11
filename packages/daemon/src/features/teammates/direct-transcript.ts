import type { ConversationDetailResponse, ConversationItemV1 } from "@ling-stack/contracts";
import { projectConversationUserInputs } from "../conversations/user-input-transcript.js";
import type { LingTurn, RunSession, RunStore } from "@ling-stack/core";
import { projectTerminalReportDto } from "../channels/terminal-report-routes.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededLingTurns,
  filterSupersededTerminalReports,
  projectConversationSupersessionTombstones,
} from "../conversations/supersession-projection.js";
import { listAllExecutionActionsForRun } from "../runs/execution-actions.js";
import { resolveTeammateDirectRunOwner } from "./direct-run-owner.js";
import { projectConversationReasoningSummaries } from "../conversations/reasoning-summary-projection.js";

/**
 * Read an existing teammate's canonical facts without creating history or
 * republishing the separate private-message narration DTO. A private Thread
 * and each linked Run must agree on their durable owner before facts are read.
 */
export function buildTeammateDirectTranscript(
  store: RunStore,
  teammateId: string,
  options: { readonly includeSuperseded?: boolean } = {},
): ConversationDetailResponse | undefined {
  const thread = store.findLingThreadByOwner({ kind: "teammate_direct", teammateId });
  if (!thread || thread.kind !== "teammate_direct" || thread.teammateId !== teammateId || thread.channelId) {
    return undefined;
  }
  const supersession = buildConversationSupersessionProjection(store, {
    surfaces: ["teammate_direct"], ownerId: teammateId,
  });
  const sourceItems = readPrivateItems(store, thread.id, teammateId, !options.includeSuperseded);
  // Item cursors, not the recent-turn page, own canonical history coverage.
  // Retain recent unanchored legacy turns as facts; never invent their items.
  const turnsById = new Map(store.listLingTurns({ threadId: thread.id, limit: 500 }).map((turn) => [turn.id, turn]));
  for (const item of sourceItems) {
    if (!item.turnId || turnsById.has(item.turnId)) continue;
    const turn = store.getLingTurn(item.turnId);
    if (turn) turnsById.set(turn.id, turn);
  }
  const scopedTurns = [...turnsById.values()].filter((turn) =>
    turn.threadId === thread.id && turn.teammateId === teammateId && !turn.channelId && !turn.workflowStepId);
  const turns = (options.includeSuperseded ? scopedTurns : filterSupersededLingTurns(scopedTurns, supersession))
    .sort(byCreatedAt);
  const turnIds = new Set(turns.map((turn) => turn.id));
  const scopedItems = sourceItems.filter((item) =>
    (!item.turnId || turnIds.has(item.turnId)) &&
    (options.includeSuperseded || !supersession.supersededResponseMessageIds.has(item.id)));
  const { conversationItems, userInputs } = projectConversationUserInputs(store, thread.id, scopedItems);
  const messageSourceIds = new Set(conversationItems.flatMap((item) => [
    item.id,
    ...item.domainRefs.filter((ref) => ref.type === "message").map((ref) => ref.id),
  ]));
  const runsById = new Map<string, RunSession>();
  const runLinks = turns.flatMap((turn) => store.listLingTurnRuns(turn.id)).filter((link) => {
    if (!turnIds.has(link.turnId) || (!options.includeSuperseded && supersession.supersededRunIds.has(link.runId))) return false;
    const owner = resolveTeammateDirectRunOwner(store, link.runId, { teammateId, canonicalThreadId: thread.id, turnId: link.turnId });
    if (!owner) return false;
    const { run } = owner;
    runsById.set(run.id, run);
    return true;
  });
  const runs = [...runsById.values()].sort(byCreatedAt);
  const reports = conversationItems.flatMap((item) => {
    if (item.kind !== "terminal_report") return [];
    const report = store.getTerminalReport(item.payload.reportId);
    return report && report.threadId === thread.id && report.resultItemId === item.id ? [report] : [];
  });
  const terminalReports = (options.includeSuperseded ? reports : filterSupersededTerminalReports(reports, supersession))
    .filter((record) => record.report && (record.status === "committed" || record.status === "fallback"))
    .map((record) => ({
      ...projectTerminalReportDto(record.report!), generation: record.generation, resultItemId: record.resultItemId!,
    }));
  const visibleSource = (source: { readonly sourceTurnId?: string; readonly sourceRunId?: string; readonly sourceMessageId?: string }) =>
    (!source.sourceTurnId || turnIds.has(source.sourceTurnId)) &&
    (!source.sourceRunId || runsById.has(source.sourceRunId)) &&
    (!source.sourceMessageId || messageSourceIds.has(source.sourceMessageId));
  const approvals = runs.flatMap((run) => store.listApprovalRequests({ runId: run.id, complete: true }));
  const approvalCheckpoints = approvals
    .map((approval) => store.getApprovalCheckpointForApproval(approval.id))
    .filter((checkpoint): checkpoint is NonNullable<typeof checkpoint> => Boolean(checkpoint));
  return {
    cwd: store.paths.cwd,
    thread,
    turns,
    conversationItems,
    userInputs,
    supersessionTombstones: projectConversationSupersessionTombstones(supersession),
    runLinks,
    runs,
    reasoningSummaries: projectConversationReasoningSummaries({
      store,
      thread,
      runLinks,
      runs,
      items: conversationItems,
    }),
    executionActions: runs.flatMap((run) => listAllExecutionActionsForRun(store, run.id)),
    approvals,
    approvalCheckpoints,
    interventions: runs.flatMap((run) => store.listRunInterventions({ sourceRunId: run.id, limit: 500 })),
    terminalReports,
    artifacts: runs.flatMap((run) => store.listArtifacts(run.id)),
    plans: store.listProposedPlanArtifacts({ threadId: thread.id, limit: 500 }).filter(visibleSource),
    compactionCheckpoints: store.listCompactionCheckpoints({ threadId: thread.id, limit: 500 }).filter(visibleSource),
    contextSnapshots: store.listConversationContextSnapshots({ threadId: thread.id, limit: 500 }),
    contextSummaries: store.listConversationContextSummaries({
      threadId: thread.id, statuses: ["active", "superseded", "invalidated"], limit: 500,
    }),
    messages: [],
    generatedMedia: [],
    defaults: {},
  };
}

function readPrivateItems(
  store: RunStore,
  threadId: string,
  teammateId: string,
  effectiveOnly: boolean,
): ConversationItemV1[] {
  const items: ConversationItemV1[] = [];
  let beforeSequence = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = store.listConversationItemsPage({ threadId, beforeSequence, effectiveOnly, limit: 500 });
    items.push(...page.items.filter((item) => item.threadId === threadId && !item.channelId &&
      (item.visibility === "thread_participants" ||
        (item.visibility === "agent_private" && item.visibilityOwnerId === teammateId))));
    const next = page.nextBeforeSequence;
    if (next === undefined) break;
    if (next >= beforeSequence) throw new Error(`Private transcript history cursor did not advance: ${threadId}`);
    beforeSequence = next;
  }
  return items.sort((left, right) => left.sequence - right.sequence);
}

function byCreatedAt(left: LingTurn | RunSession, right: LingTurn | RunSession): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
