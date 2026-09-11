import type { UnifiedExecResult, UnifiedExecStreamSummary } from "@ling-stack/core";

/**
 * Providers serialize tool content, not Host-only details. Expose the existing
 * bounded, redacted previews without reading or duplicating the raw streams.
 */
export function renderUnifiedExecModelOutput(result: UnifiedExecResult): string {
  return [
    summarizeResult(result),
    ...(result.processObservation?.stopReason ? [
      "Background descendant termination is unverified. Do not automatically retry overlapping writes; cancellation does not undo previous effects.",
    ] : []),
    renderStream("stdout", result.stdout),
    renderStream("stderr", result.stderr),
    "Evidence artifacts:\n" + result.artifacts.map((artifact) =>
      `- ${artifact.role}: ${artifact.artifactId} (truncated: ${artifact.truncated ? "yes" : "no"})`,
    ).join("\n"),
  ].join("\n\n");
}

function renderStream(name: "stdout" | "stderr", stream: UnifiedExecStreamSummary): string {
  return `${name} (${stream.byteCount} bytes; ${stream.lineCount} lines; preview truncated: ${stream.truncated ? "yes" : "no"}):\n`
    + (stream.preview || "(empty)");
}

function summarizeResult(result: UnifiedExecResult): string {
  if (result.processObservation?.stopReason === "output_drain") {
    return "Command leader exited, but output collection did not finish. This is an incomplete execution result, not successful completion.";
  }
  if (result.processObservation?.stopReason === "observer_error") {
    return "Command observation failed. Check the Host error evidence before continuing.";
  }
  if (result.status === "timed_out") {
    return `Command timed out after ${result.durationMs}ms.`;
  }
  if (result.status === "cancelled") {
    return `Command cancelled after ${result.durationMs}ms.`;
  }
  if (result.exitCode !== undefined) {
    return `Command exited ${result.exitCode} in ${result.durationMs}ms.`;
  }
  return `Command ${result.status} in ${result.durationMs}ms.`;
}
