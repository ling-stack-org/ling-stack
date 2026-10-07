import type { ChannelWorkflowStep, RunSession } from "../types.js";
import { mergeWorkflowChildUserInputHistory } from "./workflow-child-user-input.js";

/** Guarded full reads and mutation results own lifecycle, but cannot roll back read projections. */
export function mergeWorkflowStepReadModel(previous: ChannelWorkflowStep | undefined, incoming: ChannelWorkflowStep): ChannelWorkflowStep {
  if (!previous || previous.id !== incoming.id || previous.workspaceId !== incoming.workspaceId
    || previous.channelId !== incoming.channelId || previous.workflowId !== incoming.workflowId) return incoming;
  // This Host metadata stamp gates old step snapshots only; it never locates Q/A or tools.
  if (incoming.updatedAt < previous.updatedAt) return previous;
  if (previous.runId !== incoming.runId || previous.toParticipantId !== incoming.toParticipantId) return incoming;
  const projected = mergeWorkflowNarration([previous], [incoming])[0]!;
  return { ...incoming, runNarration: projected.runNarration, runUserInputHistory: projected.runUserInputHistory };
}

/** Full membership replacement: removed steps stay removed; retained runs keep independent Q/A revisions. */
export function mergeWorkflowStepReadModels(current: readonly ChannelWorkflowStep[], incoming: readonly ChannelWorkflowStep[]): readonly ChannelWorkflowStep[] {
  const byId = new Map(current.map(step => [step.id, step]));
  return incoming.map(step => mergeWorkflowStepReadModel(byId.get(step.id), step));
}

/** Only poll the workflows whose selected runs are still live. */
export function liveNarrationWorkflowIds(steps: readonly ChannelWorkflowStep[], runs: readonly RunSession[], channelId: string): readonly string[] {
  const active = new Set(runs.filter(run => run.channelId === channelId
    && (run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval"
      || run.status === "yielded" && steps.some(step => step.runId === run.id && step.channelId === channelId && step.status === "waiting_for_input"))).map(run => run.id));
  return [...new Set(steps.filter(step => step.channelId === channelId && step.runId && active.has(step.runId)).map(step => step.workflowId))];
}

/** Never roll back a newer segment or attach an old request to a retried step. */
export function mergeWorkflowNarration(current: readonly ChannelWorkflowStep[], incoming: readonly ChannelWorkflowStep[]): readonly ChannelWorkflowStep[] {
  const byId = new Map(incoming.map(step => [step.id, step]));
  let changed = false;
  const result = current.map(step => {
    const update = byId.get(step.id);
    if (!update || update.runId !== step.runId || update.channelId !== step.channelId || update.workspaceId !== step.workspaceId
      || update.workflowId !== step.workflowId || update.toParticipantId !== step.toParticipantId) return step;
    const runUserInputHistory = mergeWorkflowChildUserInputHistory(step, update);
    const base = runUserInputHistory === step.runUserInputHistory ? step : { ...step, runUserInputHistory };
    if (base !== step) changed = true;
    if (update.runNarration === undefined) return base;
    // An explicit Host rejection revokes the old projection; an absent field does not.
    if (update.runNarration === null) {
      if (step.runNarration === null) return base;
      changed = true;
      return { ...base, runNarration: null };
    }
    const before = step.runNarration?.segments.at(-1)?.endEventSequence ?? -1;
    const after = update.runNarration.segments.at(-1)?.endEventSequence ?? 0;
    if (before >= after) return base;
    changed = true;
    return { ...base, runNarration: update.runNarration };
  });
  return changed ? result : current;
}
