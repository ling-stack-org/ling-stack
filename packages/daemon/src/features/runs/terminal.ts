import {
  writeRunSummary,
  type RunExecutionStoreFacet,
  type RunEventEnvelope,
  type RunSummary,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";

export function writeTerminalSummary(summaryPath: string, summary: RunSummary): string | undefined {
  try {
    writeRunSummary(summaryPath, summary);
    return summaryPath;
  } catch {
    return undefined;
  }
}

export function appendFailureEvent(
  store: RunExecutionStoreFacet,
  runId: string,
  sourceFence: RuntimeAttemptFenceV1,
  message: string,
  sinkClosed: boolean,
  sink: { writeEvent(event: string, data: unknown): void },
  extraData: Record<string, unknown> = {},
  now?: string,
): RunEventEnvelope | undefined {
  try {
    const envelope = store.appendExecutionEvent(runId, sourceFence, "run_error", { message, ...extraData }, now);
    if (!sinkClosed) {
      sink.writeEvent(envelope.type, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}
