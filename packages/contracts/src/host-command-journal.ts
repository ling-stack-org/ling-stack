import type { UnifiedExecProcessObservation } from "./unified-exec.js";

/** Host facts only. A public event is not an execution or recovery capability. */
export interface HostCommandPreparedV1 {
  readonly executionId: string;
  readonly toolCallId: string;
  readonly source: {
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly runtimeInstanceId: string;
    readonly fencingToken: string;
  };
  readonly workspace: { readonly path: string; readonly realPath: string };
  readonly cwd: string;
  readonly commandDigest: string;
}
export interface HostCommandSettledV1 {
  readonly executionId: string;
  readonly outcome: "not_started" | "completed" | "stop_unconfirmed";
  readonly ownerCurrent: boolean;
  readonly observation?: UnifiedExecProcessObservation;
}
export interface HostCommandWriteBlockerV1 {
  readonly executionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly attemptId: string;
  readonly workspace: HostCommandPreparedV1["workspace"];
  readonly state: "prepared" | "stop_unconfirmed";
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === "string" && choices.includes(value);

export function isHostCommandPreparedV1(value: unknown): value is HostCommandPreparedV1 {
  if (!record(value) || !record(value.source) || !record(value.workspace)) return false;
  return [value.executionId, value.toolCallId, value.source.workUnitId, value.source.attemptId,
    value.source.runtimeInstanceId, value.source.fencingToken, value.workspace.path, value.workspace.realPath, value.cwd].every(text)
    && typeof value.commandDigest === "string" && /^[a-f0-9]{64}$/.test(value.commandDigest);
}
export function isCommandProcessObservation(value: unknown): value is UnifiedExecProcessObservation {
  if (!record(value)) return false;
  return oneOf(value.scope, ["process_group", "leader"])
    && typeof value.leaderExited === "boolean" && typeof value.stdioClosed === "boolean"
    && value.descendants === "unverified"
    && oneOf(value.settledBy, ["close", "spawn_error", "cleanup_deadline"])
    && (value.stopReason === undefined || oneOf(value.stopReason, ["cancelled", "timeout", "output_drain", "observer_error"]))
    && Array.isArray(value.signalFailures) && value.signalFailures.every(text);
}
export function isHostCommandSettledV1(value: unknown): value is HostCommandSettledV1 {
  if (!record(value) || !text(value.executionId) || !oneOf(value.outcome, ["not_started", "completed", "stop_unconfirmed"])
    || typeof value.ownerCurrent !== "boolean"
    || (value.observation !== undefined && !isCommandProcessObservation(value.observation))) return false;
  if (value.outcome === "stop_unconfirmed") return true;
  if (!value.ownerCurrent) return false;
  if (value.outcome === "not_started") return value.observation === undefined;
  const observed = value.observation;
  return isCommandProcessObservation(observed) && observed.leaderExited && observed.stdioClosed
    && observed.settledBy === "close" && observed.stopReason === undefined && observed.signalFailures.length === 0;
}
