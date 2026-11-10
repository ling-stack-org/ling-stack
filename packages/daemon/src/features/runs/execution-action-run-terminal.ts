import type { RunEventEnvelope, RunSession } from "@ling-stack/core";

/**
 * A failed/cancelled Run fences unfinished tool evidence without manufacturing
 * a tool_end, exit code or process-stop receipt. Completed tools retain their
 * earlier tool_end. Sequence, not transport order or model text, owns the fence.
 */
export function executionActionRunTerminalEvent(
  run: RunSession,
  events: readonly RunEventEnvelope[],
  startSequence: number,
): RunEventEnvelope | undefined {
  const terminalType = run.status === "failed" ? "run_error"
    : run.status === "cancelled" ? "run_cancelled" : undefined;
  if (!terminalType) return undefined;
  return events.reduce<RunEventEnvelope | undefined>((first, event) => {
    if (event.runId !== run.id || event.type !== terminalType || event.seq <= startSequence) return first;
    return !first || event.seq < first.seq || event.seq === first.seq && event.id.localeCompare(first.id) < 0
      ? event : first;
  }, undefined);
}
