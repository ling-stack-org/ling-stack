import type { RunSession, WorkUnit } from "../../types.js";

export interface ChannelGuidanceTarget {
  readonly run: RunSession;
  readonly sourceRunId: string;
  readonly teammateId?: string;
  readonly label: string;
}

export function deriveChannelReplyGuidanceTargets(input: {
  readonly channelId: string;
  readonly runs: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): readonly ChannelGuidanceTarget[] {
  if (!input.channelId) {
    return [];
  }

  const workUnitById = new Map(input.workUnits.map((workUnit) => [workUnit.id, workUnit]));
  return input.runs
    .filter((run) => run.channelId === input.channelId && channelReplyRunIsActive(run))
    .filter((run) => run.workUnitId && workUnitById.get(run.workUnitId)?.kind === "channel_ai_reply")
    .map((run) => ({
      run,
      sourceRunId: run.parentRunId ?? run.id,
      teammateId: run.teammateId,
      label: input.teammateLabel(run.teammateId),
    }))
    .sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt));
}

export function resolveChannelGuidanceRun(input: {
  readonly replyTargets: readonly ChannelGuidanceTarget[];
  readonly selectedReplyRunId: string;
  readonly fallbackRun?: RunSession;
}): RunSession | undefined {
  if (input.replyTargets.length === 0) {
    return input.fallbackRun;
  }
  if (input.replyTargets.length === 1) {
    return input.replyTargets[0]?.run;
  }
  return input.replyTargets.find((target) => target.run.id === input.selectedReplyRunId)?.run;
}

function channelReplyRunIsActive(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}
