import type { ApprovalRequest } from "./approval-types.js";
import type { ChannelTeamEvidenceItem, ChannelEvidenceSummaryProjection } from "./channel-team-types.js";
import type { RunArtifact, RunSession } from "./run-types.js";
import type { ChannelAttachment, ChannelMessage, ChannelWorkflowStep, Task } from "./workspace-types.js";

const DOCK_EVIDENCE_GROUP_ITEM_LIMIT = 20;

export interface BuildChannelEvidenceSummaryProjectionInput {
  readonly channelId: string;
  readonly generatedAt: string;
  readonly runs?: readonly RunSession[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly messages?: readonly ChannelMessage[];
  readonly attachments?: readonly ChannelAttachment[];
  readonly artifacts?: readonly RunArtifact[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly tasks?: readonly Task[];
  readonly workflowSteps?: readonly ChannelWorkflowStep[];
  readonly teamEvidence?: readonly ChannelTeamEvidenceItem[];
}

export function buildChannelEvidenceSummaryProjection(
  input: BuildChannelEvidenceSummaryProjectionInput,
): ChannelEvidenceSummaryProjection {
  const runs = filterRunsForChannel(input.channelId, input.runs ?? [], input.tasks ?? []);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const taskById = new Map((input.tasks ?? []).map((task) => [task.id, task]));
  const workflowStepById = new Map((input.workflowSteps ?? []).map((step) => [step.id, step]));
  const approvals = (input.approvals ?? []).filter((approval) =>
    approval.channelId === input.channelId ||
    (approval.runId ? runById.has(approval.runId) : false) ||
    (approval.taskId ? taskById.get(approval.taskId)?.channelId === input.channelId : false) ||
    (approval.workflowStepId ? workflowStepById.get(approval.workflowStepId)?.channelId === input.channelId : false)
  );
  const messages = (input.messages ?? []).filter((message) => message.channelId === input.channelId);
  const attachments = (input.attachments ?? []).filter((attachment) => attachment.channelId === input.channelId);
  const artifacts = filterArtifactsForRuns(input.artifacts ?? flattenArtifactsByRun(input.artifactsByRun), runById);
  const teamEvidence = (input.teamEvidence ?? []).filter((item) => item.channelId === input.channelId);
  const browserCount = messages.reduce((count, message) => {
    const evidence = message.webEvidence;
    return count + (evidence ? evidence.sources.length + evidence.readUrls.length : 0);
  }, 0);
  const fileRefCount = countUniqueFileRefs(messages);
  const rawFileCount = attachments.length + artifacts.length + fileRefCount;
  const countsByKind = {
    runs: Math.min(runs.length, DOCK_EVIDENCE_GROUP_ITEM_LIMIT),
    approvals: Math.min(approvals.length, DOCK_EVIDENCE_GROUP_ITEM_LIMIT),
    browser: browserCount,
    files: Math.min(rawFileCount, DOCK_EVIDENCE_GROUP_ITEM_LIMIT),
    team_evidence: teamEvidence.length,
  } as const;
  return {
    channelId: input.channelId,
    generatedAt: input.generatedAt,
    totalCount: countsByKind.runs + countsByKind.approvals + countsByKind.browser + countsByKind.files,
    countsByKind,
    pendingCount: countPending(runs, approvals),
    failedCount: countFailed(runs, approvals, messages),
    latestUpdatedAt: latestTimestamp([
      ...runs.map((run) => run.updatedAt),
      ...approvals.map((approval) => approval.resolvedAt ?? approval.createdAt),
      ...messages.map((message) => message.webEvidence?.updatedAt ?? message.updatedAt),
      ...attachments.map((attachment) => attachment.createdAt),
      ...artifacts.map((artifact) => artifact.createdAt),
      ...teamEvidence.map((item) => item.updatedAt),
    ]),
  };
}

function filterRunsForChannel(
  channelId: string,
  runs: readonly RunSession[],
  tasks: readonly Task[],
): readonly RunSession[] {
  const taskIds = new Set(tasks.filter((task) => task.channelId === channelId).map((task) => task.id));
  const seen = new Set<string>();
  const items: RunSession[] = [];
  for (const run of runs) {
    if (run.channelId !== channelId && !taskIds.has(run.taskId)) {
      continue;
    }
    if (seen.has(run.id)) {
      continue;
    }
    seen.add(run.id);
    items.push(run);
  }
  return items;
}

function flattenArtifactsByRun(
  artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>> | undefined,
): readonly RunArtifact[] {
  return artifactsByRun ? Object.values(artifactsByRun).flat() : [];
}

function filterArtifactsForRuns(
  artifacts: readonly RunArtifact[],
  runById: ReadonlyMap<string, RunSession>,
): readonly RunArtifact[] {
  const seen = new Set<string>();
  const items: RunArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact.runId || !runById.has(artifact.runId) || seen.has(artifact.id)) {
      continue;
    }
    seen.add(artifact.id);
    items.push(artifact);
  }
  return items;
}

function countUniqueFileRefs(messages: readonly ChannelMessage[]): number {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const ref of message.fileRefs) {
      seen.add(`${message.id}:${ref.path}:${ref.line ?? ""}`);
    }
  }
  return seen.size;
}

function countPending(
  runs: readonly RunSession[],
  approvals: readonly ApprovalRequest[],
): number {
  return runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval").length +
    approvals.filter((approval) => approval.status === "pending").length;
}

function countFailed(
  runs: readonly RunSession[],
  approvals: readonly ApprovalRequest[],
  messages: readonly ChannelMessage[],
): number {
  return runs.filter((run) => run.status === "failed" || run.status === "cancelled").length +
    approvals.filter((approval) => approval.status === "denied" || approval.status === "expired").length +
    messages.reduce((count, message) => {
      const evidence = message.webEvidence;
      if (!evidence) {
        return count;
      }
      return count +
        (evidence.status === "blocked" ? evidence.sources.length : 0) +
        evidence.readUrls.filter((item) => item.status === "blocked").length;
    }, 0);
}

function latestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0];
}
