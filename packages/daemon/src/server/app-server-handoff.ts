import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { LingAppServerHandoff, LingAppServerHandoffCreateParams, LingAppServerHandoffGoalTransfer } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { trimOversizedEvent } from "../features/control-plane/events.js";
import { continuationSourceReady } from "../runtime/continuation-source-barrier.js";

interface HandoffRecord {
  readonly fingerprint: string;
  readonly handoff: LingAppServerHandoff;
}

export async function createAppServerHandoff(
  context: DaemonContext, store: RunStore, input: LingAppServerHandoffCreateParams,
): Promise<LingAppServerHandoff> {
  const { threadId, turnId, idempotencyKey, nextInstruction } = input;
  const cwd = store.paths.cwd;
  if (!idempotencyKey.trim() || idempotencyKey.length > 200 || /[\r\n]/u.test(idempotencyKey)
    || !nextInstruction.trim() || nextInstruction.length > 8192) {
    throw new HttpError(400, "invalid_params", "Supply the handoff instruction and a non-empty idempotency key.");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([threadId, turnId, nextInstruction])).digest("hex");
  const replay = (payload: unknown) => {
    const record = payload as HandoffRecord;
    if (record.fingerprint !== fingerprint) {
      throw new HttpError(409, "idempotency_conflict", "The handoff key belongs to a different request.");
    }
    if (!store.getLingThread(threadId)) {
      throw new HttpError(404, "handoff_not_found", "The source of the handoff is no longer available.");
    }
    return record.handoff;
  };
  const existing = store.findAppServerStateByIdempotencyKey("handoff", idempotencyKey);
  if (existing) return replay(existing.payload);
  const candidate = await captureHandoffCandidate(cwd);
  const { turn, run, goal, plan } = handoffSource(context, store, threadId, turnId);
  if (await realpath(run.cwd) !== cwd) {
    throw new HttpError(409, "workspace_binding_invalid", "The handoff source ran in a different worktree.");
  }
  const handoff: LingAppServerHandoff = {
    handoffId: `handoff_${randomUUID()}`,
    sourceThreadId: threadId, sourceTurnId: turnId, sourceTurnRevision: turn.updatedAt, sourceRunId: run.id,
    candidate, nextInstruction, plan,
    createdAt: new Date().toISOString(),
    artifactIds: store.listArtifacts(run.id).slice(0, 32).map(artifact => artifact.id),
    ...(goal ? { goal: {
      id: goal.id, objective: goal.objective, updatedAt: goal.updatedAt, status: goal.status,
      completionEvidenceRefs: goal.completionEvidenceRefs.slice(0, 32), tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed, continuationDepth: goal.continuationDepth, blockedReason: goal.blockedReason,
      lastContinuationStopReason: goal.lastContinuationStopReason,
    } } : {}),
  };
  const saved = store.putAppServerState({
    kind: "handoff", recordId: handoff.handoffId, expectedRevision: 0, idempotencyKey,
    replayByIdempotencyKey: true, payload: { fingerprint, handoff } satisfies HandoffRecord,
  }, handoff.createdAt, {
    workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "runs", entityType: "handoff",
    entityId: handoff.handoffId, action: "handoff.created",
    data: { threadId, turnId, runId: run.id, handoffId: handoff.handoffId, candidateDigest: candidate.candidateDigest },
  });
  if (!saved) throw new HttpError(409, "handoff_conflict", "The handoff could not be recorded.");
  if (saved.event) context.controlPlaneEvents.publish(trimOversizedEvent(saved.event));
  return saved.status === "replayed" ? replay(saved.record.payload) : handoff;
}

export function readAppServerHandoff(store: RunStore, handoffId: string): LingAppServerHandoff {
  const record = store.getAppServerState("handoff", handoffId)?.payload as HandoffRecord | undefined;
  if (!record || !store.getLingThread(record.handoff.sourceThreadId)) {
    throw new HttpError(404, "handoff_not_found", "The handoff is unavailable in this workspace.");
  }
  return record.handoff;
}

export function readAppServerHandoffGoalTransfer(store: RunStore, handoffId: string): LingAppServerHandoffGoalTransfer | undefined {
  return store.getAppServerState("handoff_goal_transfer", handoffId)?.payload as LingAppServerHandoffGoalTransfer | undefined;
}

export async function checkAppServerHandoff(context: DaemonContext, store: RunStore, handoff: LingAppServerHandoff) {
  const candidate = await captureHandoffCandidate(store.paths.cwd);
  const source = handoffSource(context, store, handoff.sourceThreadId, handoff.sourceTurnId);
  const transfer = readAppServerHandoffGoalTransfer(store, handoff.handoffId);
  const goal = transfer ? store.getLingThreadGoal(transfer.threadId) : source.goal;
  const goalRevision = transfer?.sourceGoalRevision ?? goal?.updatedAt;
  if (candidate.candidateDigest !== handoff.candidate.candidateDigest || source.turn.updatedAt !== handoff.sourceTurnRevision
    || source.run.id !== handoff.sourceRunId || goal?.id !== handoff.goal?.id || goalRevision !== handoff.goal?.updatedAt
    || transfer && source.goal !== undefined
    || source.plan?.id !== handoff.plan?.id || source.plan?.revision !== handoff.plan?.revision) {
    throw new HttpError(409, "handoff_stale", "The source candidate, accepted plan, or evidence changed since the handoff was recorded.");
  }
  if (goal?.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    throw new HttpError(409, "resume_blocked", "The handed-off Goal has no remaining token budget.");
  }
  return source.thread;
}

export function handoffInstruction(handoff: LingAppServerHandoff): string {
  const lines = [
    `Continue from Ling handoff ${handoff.handoffId} and source Turn ${handoff.sourceTurnId}.`,
    `Candidate SHA-256 ${handoff.candidate.candidateDigest}.`,
  ];
  if (handoff.goal) {
    lines.push(`Accepted goal ${handoff.goal.id}: ${handoff.goal.objective}`);
    lines.push(`Goal status ${handoff.goal.status}. Continuation depth ${handoff.goal.continuationDepth}. Tokens used ${handoff.goal.tokensUsed}.`);
    if (handoff.goal.tokenBudget !== undefined) lines.push(`Source goal token budget ${handoff.goal.tokenBudget}.`);
    if (handoff.goal.blockedReason) lines.push(`Source blocker: ${handoff.goal.blockedReason}`);
    if (handoff.goal.completionEvidenceRefs.length) lines.push(`Goal evidence: ${JSON.stringify(handoff.goal.completionEvidenceRefs)}`);
  }
  if (handoff.plan) lines.push(`Accepted plan ${handoff.plan.id} revision ${handoff.plan.revision}.`);
  if (handoff.artifactIds.length) lines.push(`Source artifacts: ${handoff.artifactIds.join(", ")}.`);
  return [...lines, "", handoff.nextInstruction].join("\n");
}

function handoffSource(context: DaemonContext, store: RunStore, threadId: string, turnId: string) {
  const thread = store.getLingThread(threadId);
  const turn = store.listLingTurns({ threadId, orderBy: "createdAt", limit: 1 })[0];
  const run = turn?.lastRunId ? store.getRun(turn.lastRunId) : undefined;
  const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  if (!thread || thread.kind !== "conversation" || thread.channelId || thread.archivedAt || thread.status === "archived"
    || thread.activeRunId || !turn || turn.id !== turnId || !run || !unit || unit.linkedRunId !== run.id
    || !["succeeded", "failed", "cancelled"].includes(turn.status)
    || !continuationSourceReady(store, unit, context.activeRuns, "app-server-handoff", () => undefined)) {
    throw new HttpError(409, "resume_blocked", "Handoff requires the latest settled conversation Turn with reconciled execution effects.");
  }
  const goal = store.getLingThreadGoal(threadId);
  const plan = store.listProposedPlanArtifacts({ threadId, statuses: ["accepted"], limit: 1 })[0];
  return { thread, turn, run, goal, plan: plan && { id: plan.id, revision: plan.revision } };
}

async function captureHandoffCandidate(cwd: string) {
  const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
  if (snapshot.coverage !== "complete") throw new HttpError(409, "candidate_incomplete", "Handoff requires complete candidate coverage.");
  return { workspaceId: cwd, candidateDigest: snapshot.digest, filePaths: snapshot.files.map(file => file.path) };
}
