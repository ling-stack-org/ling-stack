import { createHash } from "node:crypto";
import type { RunStore } from "./run-types.js";
import { readNormalTerminalToolBarrier, type UnsettledNormalTool } from "./normal-terminal-tool-barrier.js";

export type NormalTerminalReportReadStore = Pick<RunStore,
  | "getLingTurn" | "getLingTurnForRun" | "getLingThread" | "listLingTurnRuns"
  | "getConversationItem" | "getRun" | "listEvents" | "listApprovalRequests" | "listArtifacts"
>;

export interface NormalTerminalReportBasis {
  readonly source: { readonly kind: "turn" | "run"; readonly id: string };
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceItemId: string;
  readonly turnStatus: string;
  readonly effectiveRunId: string;
  readonly effectiveRunStatus: string;
  readonly successAllowed: boolean;
  readonly runIds: readonly string[];
  readonly settled: boolean;
  /** Non-success publication only; never proof of tool/process settlement. */
  readonly failurePublicationAllowed: boolean;
  readonly unsettledTools: readonly UnsettledNormalTool[];
  readonly fingerprint: string;
}

/**
 * Capture canonical ownership and the complete evidence read-set before synthesis.
 * The publication transaction rebuilds it, including late events and new attempts.
 * Provider/request snapshots are deliberately excluded; only execution authority is read.
 */
export function captureNormalTerminalReportBasis(
  store: NormalTerminalReportReadStore,
  source: NormalTerminalReportBasis["source"],
): NormalTerminalReportBasis | undefined {
  const turn = source.kind === "turn" ? store.getLingTurn(source.id) : store.getLingTurnForRun(source.id);
  const thread = turn ? store.getLingThread(turn.threadId) : undefined;
  const item = turn?.sourceItemId ? store.getConversationItem(turn.sourceItemId) : undefined;
  if (!turn || !thread || !item || thread.kind !== "conversation"
    || thread.channelId || turn.channelId || item.channelId
    || item.workspaceId !== turn.workspaceId || thread.workspaceId !== turn.workspaceId
    || item.threadId !== thread.id || item.turnId !== turn.id
    || item.kind !== "user_message" || item.status !== "committed"
    || !((item.actorType === "local_user" && turn.createdByActor === "local-user")
      || (item.actorType === "system" && turn.createdByActor === "system"))
    || item.visibility !== "thread_participants" || item.visibilityOwnerId !== undefined) return undefined;
  const links = [...store.listLingTurnRuns(turn.id)].sort((a, b) => a.attemptNumber - b.attemptNumber || a.runId.localeCompare(b.runId));
  const runs = links.map((link) => store.getRun(link.runId));
  if (!links.length || runs.some((run) => !run || run.threadId !== thread.id || store.getLingTurnForRun(run.id)?.id !== turn.id || run.channelId || run.workflowStepId)
    || (source.kind === "run" && !links.some((link) => link.runId === source.id))) return undefined;
  const effectiveLink = links.filter((link) => link.role !== "validation").at(-1);
  const effectiveRun = effectiveLink ? runs.find((run) => run?.id === effectiveLink.runId) : undefined;
  if (!effectiveRun) return undefined;
  const currentValidationIds = new Set(links.filter((link) => link.role === "validation"
    && link.attemptNumber > effectiveLink!.attemptNumber).map((link) => link.runId));
  const successAllowed = effectiveRun.status === "succeeded"
    && runs.filter((run) => run && currentValidationIds.has(run.id)).every((run) => run?.status === "succeeded");
  let settled = terminal(turn.status) && !turn.activeRunId;
  let failurePublicationAllowed = ["failed", "cancelled", "blocked"].includes(turn.status)
    && !turn.activeRunId && !successAllowed;
  const unsettledTools: UnsettledNormalTool[] = [];
  const evidence = runs.map((run) => {
    if (!run) throw new Error("Normal report Run disappeared inside a read snapshot");
    const barrier = readNormalTerminalToolBarrier(store, run);
    unsettledTools.push(...barrier.unsettledTools);
    const approvals = store.listApprovalRequests({ runId: run.id, complete: true }).sort(byId);
    const artifacts = store.listArtifacts(run.id).sort(byId);
    const stoppedAuthority = terminal(run.status) && !barrier.malformed && !approvals.some(approval => approval.status === "pending");
    settled &&= stoppedAuthority && barrier.unsettledTools.length === 0;
    failurePublicationAllowed &&= stoppedAuthority && barrier.unsettledTools.every(tool => Boolean(tool.terminalEventId));
    return {
      run: { id: run.id, threadId: run.threadId, taskId: run.taskId,
        teammateId: run.teammateId, status: run.status, updatedAt: run.updatedAt, endedAt: run.endedAt,
        errorMessage: run.errorMessage },
      events: fingerprint(barrier.events), approvals: fingerprint(approvals), artifacts: fingerprint(artifacts),
    };
  });
  return {
    source, workspaceId: turn.workspaceId, threadId: thread.id, turnId: turn.id, sourceItemId: item.id,
    turnStatus: turn.status, effectiveRunId: effectiveRun.id, effectiveRunStatus: effectiveRun.status, successAllowed,
    runIds: links.map((link) => link.runId), settled, failurePublicationAllowed, unsettledTools,
    // Publication changes the thread sequence; unrelated later turns must not
    // invalidate this Turn's result. Only stable thread scope belongs here.
    fingerprint: fingerprint({ source, thread: { id: thread.id, kind: thread.kind, workspaceId: thread.workspaceId,
      channelId: thread.channelId }, turn, item, links, evidence }),
  };
}

function terminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "blocked";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id);
}
