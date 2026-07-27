import type { Translate } from "../../i18n.js";
import type {
  LingThread,
  LingThreadEvidenceResponse,
  LingTurn,
  LingTurnRun,
  RunIntervention,
  RunSession,
} from "../../types.js";
import { runCanBeStopped } from "./runs-thread-view-models.js";

export function resolveThreadSourceRun(
  thread: LingThread | undefined,
  evidenceRuns: readonly LingThreadEvidenceResponse["runs"][number][],
  selectedSourceRunId: string,
): RunSession | undefined {
  const selected = selectedSourceRunId ? evidenceRuns.find((item) => item.run.id === selectedSourceRunId)?.run : undefined;
  if (selected) return selected;
  if (thread?.lastRunId) return evidenceRuns.find((item) => item.run.id === thread.lastRunId)?.run;
  return evidenceRuns.at(-1)?.run;
}

export function resolveDefaultResumeSourceTurn(turns: readonly LingTurn[]): LingTurn | undefined {
  const sorted = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  return sorted.find(isResumeSourceTurnTerminal) ?? sorted[0];
}

export function isResumeSourceTurnTerminal(turn: LingTurn): boolean {
  return turn.status === "succeeded" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "superseded";
}

export function resolveTurnRunIds(turn: LingTurn, links: readonly LingTurnRun[]): ReadonlySet<string> {
  return new Set([turn.activeRunId, turn.lastRunId, ...links.filter((link) => link.turnId === turn.id).map((link) => link.runId)]
    .filter((runId): runId is string => Boolean(runId)));
}

export function resolveDefaultRunIdForTurn(
  turn: LingTurn,
  links: readonly LingTurnRun[],
  evidenceRuns: readonly LingThreadEvidenceResponse["runs"][number][],
): string {
  if (turn.lastRunId && evidenceRuns.some((item) => item.run.id === turn.lastRunId)) return turn.lastRunId;
  return links
    .filter((link) => link.turnId === turn.id && evidenceRuns.some((item) => item.run.id === link.runId))
    .sort((left, right) => right.attemptNumber - left.attemptNumber || right.createdAt.localeCompare(left.createdAt))[0]?.runId ?? "";
}

export function uniqueInterventions(interventions: readonly RunIntervention[]): readonly RunIntervention[] {
  const byId = new Map(interventions.map((intervention) => [intervention.id, intervention]));
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function buildThreadResumeDisabledReason(input: {
  readonly hasThread: boolean;
  readonly hasSourceRun: boolean;
  readonly hasActiveNonTerminalRun: boolean;
  readonly hasActiveSelectedTurn: boolean;
  readonly isRunning: boolean;
  readonly isArchived: boolean;
  readonly t: Translate;
}): string {
  if (!input.hasThread) return input.t("Thread metadata is still loading.");
  if (input.isArchived) return input.t("Unarchive");
  if (!input.hasSourceRun) return input.t("Thread has no source run to resume.");
  if (input.hasActiveNonTerminalRun) return input.t("Thread has an active run; resume is disabled until it reaches a terminal state.");
  if (input.hasActiveSelectedTurn) return input.t("The selected turn is still active; wait for it to finish before resuming from it.");
  if (input.isRunning) return input.t("Another run is currently active; wait before starting a continuation.");
  return "";
}

export function hasActiveThreadRun(thread: LingThread | undefined, evidence: LingThreadEvidenceResponse | undefined): boolean {
  if (!thread?.activeRunId) return false;
  const active = evidence?.runs.find((item) => item.run.id === thread.activeRunId)?.run;
  return !active || runCanBeStopped(active);
}

export function stableBrowserHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
