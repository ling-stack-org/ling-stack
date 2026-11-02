import type { UnifiedExecResult } from "@ling-stack/core";
import type { PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { isRecord } from "../../../shared/validation.js";

interface CommandResultIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
}

type ExecutedCommandResult = Pick<UnifiedExecResult,
  "status" | "exitCode" | "signal" | "timedOut" | "cancelled" | "durationMs" | "stdout" | "stderr" | "artifacts"> & {
  readonly denied?: false;
};
interface DeniedCommandResult {
  readonly status: "failed";
  readonly denied: true;
  readonly reason: string;
}
export type BrokerCommandResult = ExecutedCommandResult | DeniedCommandResult;

/**
 * Validate only the fields consumed by the Broker, with exact result ownership.
 * A sparse pre-dispatch denial is not an execution result. Neither shape is
 * proof of process containment, physical stop or Host operation drain.
 */
export function readBrokerCommandResult(handled: PiRunnerToolHandledResult, identity: CommandResultIdentity): BrokerCommandResult {
  const result = isRecord(handled.details) ? handled.details.unifiedExec : undefined;
  if (!isRecord(result) || result.toolCallId !== identity.toolCallId || result.approvalId !== identity.approvalId) return invalid();
  if (result.denied === true) {
    if (handled.isError !== true || result.status !== "failed" || !text(result.reason)) return invalid();
    return result as unknown as DeniedCommandResult;
  }
  if (result.denied !== undefined && result.denied !== false || result.runId !== identity.runId || result.taskId !== identity.taskId
    || !["succeeded", "failed", "timed_out", "cancelled"].includes(String(result.status))
    || typeof result.timedOut !== "boolean" || typeof result.cancelled !== "boolean" || !nonNegative(result.durationMs)
    || result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode)
    || result.signal !== undefined && !text(result.signal)
    || !stream(result.stdout) || !stream(result.stderr) || !Array.isArray(result.artifacts)
    || !result.artifacts.every(artifact)) return invalid();
  return result as unknown as ExecutedCommandResult;
}

function invalid(): never { throw new Error("tool_executor_result_invalid"); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function stream(value: unknown): boolean {
  return isRecord(value) && nonNegative(value.byteCount) && typeof value.preview === "string" && typeof value.truncated === "boolean"
    && (value.lineCount === undefined || nonNegative(value.lineCount)) && (value.artifactId === undefined || text(value.artifactId))
    && (value.contentSha256 === undefined || typeof value.contentSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.contentSha256));
}
function artifact(value: unknown): boolean {
  return isRecord(value) && text(value.artifactId) && ["result", "stdout", "stderr", "combined"].includes(String(value.role))
    && text(value.contentType) && nonNegative(value.sizeBytes) && typeof value.redacted === "boolean" && typeof value.truncated === "boolean";
}
