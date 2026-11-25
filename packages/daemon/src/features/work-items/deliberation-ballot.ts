import { createHash } from "node:crypto";
import type { LingAppServerDeliberationWorkflowOutcome } from "@ling-stack/contracts";
import {
  deliberationWorkflowStepDigest,
  readWorkItemDeliberationBallotBasis,
  readWorkItemDeliberationWorkflowBinding,
  type ChannelWorkflowStep,
  type ControlPlaneEvent,
  type RunStore,
  type WorkItemDeliberationBallotBasis,
  type WorkItemDeliberationWorkflowBinding,
} from "@ling-stack/core";
import { z } from "zod";
import { readWorkflowStepOutputPacketArtifact } from "../channels/workflow-step-packets.js";
import { readVote } from "./stage-ballot.js";
import { readCompleteHandoffCandidate } from "./stage-handoff-candidates.js";

const challengeFields = {
  rationale: z.string().trim().min(1).max(1000),
  evidenceIds: z.array(z.string()).min(1).max(12),
};
const challengeResult = z.discriminatedUnion("disposition", [
  z.strictObject({ disposition: z.literal("resolved"), option: z.string(), ...challengeFields }),
  z.strictObject({ disposition: z.literal("tradeoff"), ...challengeFields }),
  z.strictObject({ disposition: z.literal("verify_required"), ...challengeFields }),
]);

export function readDeliberationContribution(store: RunStore, step: ChannelWorkflowStep, binding: WorkItemDeliberationWorkflowBinding) {
  const run = step.runId && store.getRun(step.runId);
  const artifactId = step.metadata?.outputArtifactId;
  const artifact = artifactId ? store.getArtifact(artifactId) : undefined;
  const packet = artifactId && readWorkflowStepOutputPacketArtifact({ store, artifactId });
  if (step.status !== "succeeded" || binding.steps[step.id] !== deliberationWorkflowStepDigest(step)
    || !run || run.status !== "succeeded" || run.workflowStepId !== step.id || run.teammateId !== step.toParticipantId
    || !artifact?.contentSha256 || !packet || packet.workflowId !== step.workflowId || packet.workflowStepId !== step.id || packet.runId !== run.id) return;
  return { id: artifact.id, digest: artifact.contentSha256, result: packet.resultSummary };
}

export async function reconcileDeliberationBallot(store: RunStore, workflowId: string, now: string): Promise<ControlPlaneEvent | undefined> {
  const binding = readWorkItemDeliberationWorkflowBinding(store, workflowId);
  if (!binding?.ballot) return;
  let retained = readWorkItemDeliberationBallotBasis(store, workflowId);
  let event: ControlPlaneEvent | undefined;
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  if (!retained) {
    const challenges = steps.filter(step => step.metadata?.templateStepId?.startsWith("challenge-"));
    if (!challenges.length || !challenges.every(step => step.status === "succeeded")) return;
    const candidate = binding.candidate;
    if (candidate && await readCompleteHandoffCandidate(candidate.cwd) !== candidate.digest) return;
    if (store.getWorkItemWorkflowAdmissionBlocker(workflowId)) return;
    const payload = evaluateChallenges(store, challenges, binding, binding.ballot);
    const written = store.putAppServerState({ kind: "work_item_deliberation_ballot", recordId: workflowId, expectedRevision: 0, payload }, now, {
      workspaceId: challenges[0]!.workspaceId, cwd: store.paths.cwd, domain: "work_items", entityType: "work_item",
      entityId: binding.workItemId, action: "work_item.deliberation.workflow_progress",
      data: { workItemId: binding.workItemId, roundId: binding.roundId, workflowId, phase: payload.status },
      idempotencyKey: `work-item-deliberation-ballot:${workflowId}`,
    });
    retained = written ? payload : readWorkItemDeliberationBallotBasis(store, workflowId);
    event = written?.event;
  }
  if (retained && retained.status !== "voting") {
    for (const step of steps) {
      if (!step.metadata?.planBallotKey || step.status !== "queued") continue;
      store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus: "queued", event: "skip",
        actor: "system", reason: retained.status, now });
    }
  }
  return event;
}

function evaluateChallenges(store: RunStore, challenges: readonly ChannelWorkflowStep[], binding: WorkItemDeliberationWorkflowBinding,
  ballot: NonNullable<WorkItemDeliberationWorkflowBinding["ballot"]>): WorkItemDeliberationBallotBasis {
  const results = challenges.map(step => readDeliberationContribution(store, step, binding));
  const challengeArtifacts = results.flatMap(result => result ? [{ id: result.id, digest: result.digest }] : []);
  const responses = results.map(result => parseChallenge(result?.result));
  if (responses.some(response => !response || response.evidenceIds.some(id => !ballot.evidenceIds.includes(id))
    || response.disposition === "resolved" && !ballot.options.includes(response.option))) return { status: "insufficient_evidence", challengeArtifacts };
  if (responses.some(response => response?.disposition === "verify_required")) return { status: "verify_required", challengeArtifacts };
  const first = responses[0];
  if (first?.disposition === "resolved" && responses.every(response => response?.disposition === "resolved" && response.option === first.option)) {
    return { status: "consensus", recommendation: first.option, challengeArtifacts };
  }
  const key = createHash("sha256").update(JSON.stringify([binding.roundId, ballot, challengeArtifacts, binding.candidate?.digest])).digest("hex");
  return { status: "voting", key, challengeArtifacts };
}

function parseChallenge(text: string | undefined) {
  if (!text || text.length > 4096) return undefined;
  try {
    const parsed = challengeResult.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function readDeliberationOutcome(store: RunStore, workflowId: string, steps: readonly ChannelWorkflowStep[],
  binding: WorkItemDeliberationWorkflowBinding): LingAppServerDeliberationWorkflowOutcome | undefined {
  const policy = binding.ballot;
  if (!policy) return;
  const basis = readWorkItemDeliberationBallotBasis(store, workflowId);
  if (!basis) return { status: "waiting" };
  if (basis.challengeArtifacts.some(pin => store.getArtifact(pin.id)?.contentSha256 !== pin.digest
    || !readWorkflowStepOutputPacketArtifact({ store, artifactId: pin.id }))) return { status: "insufficient_evidence" };
  if (basis.status === "consensus") return { status: basis.status, recommendation: basis.recommendation };
  if (basis.status !== "voting") return { status: basis.status };
  const voters = steps.filter(step => step.metadata?.planBallotKey);
  if (voters.some(step => !["succeeded", "failed", "cancelled", "skipped"].includes(step.status))) return { status: "voting" };
  const votes = new Map(policy.options.map(option => [option, 0]));
  let cast = 0;
  let abstained = 0;
  for (const step of voters) {
    const run = step.runId && store.getRun(step.runId);
    if (step.status !== "succeeded" || !run || run.status !== "succeeded" || run.workflowStepId !== step.id
      || run.teammateId !== step.toParticipantId || binding.steps[step.id] !== deliberationWorkflowStepDigest(step)) continue;
    const option = readVote(store, run, basis.key, policy.options);
    if (option === undefined) continue;
    cast++;
    if (option === null) abstained++;
    else votes.set(option, (votes.get(option) ?? 0) + 1);
  }
  const quorum = policy.quorum;
  const highest = Math.max(...votes.values());
  const tally = [...votes].map(([option, count]) => ({ option, count }));
  const tied = highest > 0 && tally.filter(entry => entry.count === highest).length > 1;
  const recommendation = cast >= quorum ? tally.find(entry => entry.count > voters.length / 2)?.option : undefined;
  return { status: "tallied", summary: { ballotKey: basis.key, quorum, cast, abstained, tied, tally },
    ...(recommendation ? { recommendation } : {}) };
}
