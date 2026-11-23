import type { LingAppServerStageBallotTally, LingAppServerWorkItemSourceRef, ProposedPlanStageDecision } from "@ling-stack/contracts";
import { planStageBallotKey, redactSecrets, type ChannelWorkflowStep, type RunSession, type RunStore, type WorkUnitAttempt } from "@ling-stack/core";
import type { PiRunnerEvent } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

type BallotResult =
  | { readonly status: "waiting" | "stale" }
  | { readonly status: "ready" | "quorum_unmet"; readonly summary: LingAppServerStageBallotTally;
      readonly sourceRefs: readonly LingAppServerWorkItemSourceRef[] };

export function readAppServerStageBallot(
  store: RunStore, target: ChannelWorkflowStep, planId: string,
  decision: ProposedPlanStageDecision, frozenKey: unknown,
): BallotResult {
  const ballot = decision.ballot;
  if (!ballot || !target.metadata?.planStageId) return { status: "stale" };
  const key = planStageBallotKey(planId, target.metadata.planStageId, decision);
  if (key !== frozenKey) return { status: "stale" };
  const stages = store.listChannelWorkflowSteps({ workflowId: target.workflowId, complete: true });
  const counts = new Map(decision.options.map(option => [option, 0]));
  const participants = new Set<string>();
  const sourceRefs: LingAppServerWorkItemSourceRef[] = [];
  let abstained = 0;
  for (const stageId of ballot.voterStageIds) {
    const voter = stages.find(step => step.metadata?.planStageId === stageId);
    if (!voter || voter.metadata?.planBallotKey !== key
      || participants.has(voter.toParticipantId)) return { status: "stale" };
    participants.add(voter.toParticipantId);
    if (!["succeeded", "failed", "cancelled", "skipped"].includes(voter.status)) {
      return { status: "waiting" };
    }
    const run = voter.runId ? store.getRun(voter.runId) : undefined;
    if (voter.status !== "succeeded" || run?.status !== "succeeded"
      || run.workflowStepId !== voter.id || run.teammateId !== voter.toParticipantId) continue;
    const option = readVote(store, run, key, decision.options);
    if (option === undefined) continue;
    if (option === null) abstained++;
    else counts.set(option, counts.get(option)! + 1);
    sourceRefs.push({ type: "workflow_step", id: voter.id, revision: voter.updatedAt });
  }
  const highest = Math.max(...counts.values());
  const tied = highest > 0 && [...counts.values()].filter(count => count === highest).length > 1;
  const tally = [...counts].map(([option, count]) => ({ option, count }));
  return { status: sourceRefs.length >= ballot.quorum ? "ready" : "quorum_unmet", sourceRefs,
    summary: { ballotKey: key, quorum: ballot.quorum, cast: sourceRefs.length, abstained, tied, tally } };
}

export function persistWorkflowStageBallot(store: RunStore, run: RunSession, attempt: WorkUnitAttempt, ballotKey: string,
  events: readonly PiRunnerEvent[], secrets: readonly (string | undefined)[], now: string): void {
  let text = "";
  for (const event of events) {
    if (event.type !== "assistant_text_delta") continue;
    if (text.length + event.text.length > 4096) return;
    text += event.text;
  }
  if (!text) return;
  let vote: unknown;
  try {
    vote = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(vote) || vote.ballotKey !== ballotKey || typeof vote.rationale !== "string"
    || !vote.rationale.trim() || vote.rationale.length > 1000 || (vote.option !== null && typeof vote.option !== "string")) return;
  const result = store.putAppServerState({ kind: "work_item_stage_ballot", recordId: attempt.id, expectedRevision: 0,
    idempotencyKey: attempt.id, payload: { runId: run.id, ballotKey, option: vote.option, rationale: redactSecrets(vote.rationale, secrets) },
  }, now);
  if (!result) throw new Error("workflow_stage_ballot_conflict");
}

function readVote(store: RunStore, run: RunSession, ballotKey: string, options: readonly string[]): string | null | undefined {
  const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  if (!unit || unit.linkedRunId !== run.id || unit.status !== "succeeded") return undefined;
  const attempt = store.listWorkUnitAttempts(unit.id).at(-1);
  if (attempt?.status !== "succeeded" || attempt.attemptNumber !== unit.attemptCount) return undefined;
  const vote = store.getAppServerState("work_item_stage_ballot", attempt.id)?.payload;
  if (isRecord(vote) && vote.runId === run.id && vote.ballotKey === ballotKey
    && (vote.option === null || typeof vote.option === "string" && options.includes(vote.option))) return vote.option;
  return undefined;
}
