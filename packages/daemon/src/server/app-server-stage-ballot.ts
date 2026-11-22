import type { LingAppServerStageBallotTally, LingAppServerWorkItemSourceRef, ProposedPlanStageDecision } from "@ling-stack/contracts";
import { planStageBallotKey, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";

type BallotResult =
  | { readonly status: "waiting" }
  | { readonly status: "ready" | "quorum_unmet"; readonly summary: LingAppServerStageBallotTally;
      readonly sourceRefs: readonly LingAppServerWorkItemSourceRef[] };

export function readAppServerStageBallot(
  store: RunStore, target: ChannelWorkflowStep, planId: string,
  decision: ProposedPlanStageDecision, frozenKey: unknown,
): BallotResult {
  const ballot = decision.ballot;
  if (!ballot || !target.metadata?.planStageId) throw new HttpError(409, "stale_revision", "The ballot no longer belongs to this stage.");
  const key = planStageBallotKey(planId, target.metadata.planStageId, decision);
  if (key !== frozenKey) throw new HttpError(409, "stale_revision", "The ballot options or eligible stages have changed.");
  const stages = store.listChannelWorkflowSteps({ workflowId: target.workflowId, complete: true });
  const counts = new Map(decision.options.map(option => [option, 0]));
  const participants = new Set<string>();
  const sourceRefs: LingAppServerWorkItemSourceRef[] = [];
  let abstained = 0;
  for (const stageId of ballot.voterStageIds) {
    const voter = stages.find(step => step.metadata?.planStageId === stageId);
    if (!voter || voter.metadata?.planBallotKey !== key
      || participants.has(voter.toParticipantId)) throw new HttpError(409, "stale_revision", "An eligible ballot stage changed.");
    participants.add(voter.toParticipantId);
    if (!["succeeded", "failed", "cancelled", "skipped"].includes(voter.status)) {
      return { status: "waiting" };
    }
    const run = voter.runId ? store.getRun(voter.runId) : undefined;
    if (voter.status !== "succeeded" || run?.status !== "succeeded"
      || run.workflowStepId !== voter.id || run.teammateId !== voter.toParticipantId) continue;
    const option = readVote(store, run.id, key, decision.options);
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

function readVote(store: RunStore, runId: string, ballotKey: string, options: readonly string[]): string | null | undefined {
  const events = store.listEvents(runId, { limit: 1000 });
  if (events.length === 1000) return undefined;
  const text = events
    .filter(event => event.type === "assistant_text_delta")
    .map(event => isRecord(event.data) && typeof event.data.text === "string" ? event.data.text : "")
    .join("");
  if (!text || text.length > 4096) return undefined;
  try {
    const vote: unknown = JSON.parse(text);
    if (isRecord(vote) && vote.ballotKey === ballotKey && typeof vote.rationale === "string"
      && vote.rationale.trim() && vote.rationale.length <= 1000
      && (vote.option === null || typeof vote.option === "string" && options.includes(vote.option))) return vote.option;
  } catch {
    return undefined;
  }
}
