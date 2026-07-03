import {
  writeRunSummary,
  type RunExecutionStoreFacet,
  type RunEventEnvelope,
  type RunSummary,
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
  message: string,
  sinkClosed: boolean,
  sink: { writeEvent(event: string, data: unknown): void },
  extraData: Record<string, unknown> = {},
): RunEventEnvelope | undefined {
  try {
    const envelope = store.appendEvent(runId, "run_error", { message, ...extraData });
    if (!sinkClosed) {
      sink.writeEvent(envelope.type, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}
