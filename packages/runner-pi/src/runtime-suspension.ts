import { types } from "node:util";
import type { PiRunnerRuntimeSuspensionDirective } from "./types.js";

const identityPattern = /^[a-zA-Z0-9_.:-]{1,240}$/;
const validIdentity = (value: unknown): value is string => typeof value === "string" && identityPattern.test(value);
const reject = (): never => { throw new Error("Invalid Pi runtime suspension directive."); };

function captureDirective(value: unknown): PiRunnerRuntimeSuspensionDirective {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject();
  const names = ["schemaVersion", "kind", "runId", "attemptId", "suspensionId", "checkpointId", "checkpointSha256"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) return reject();
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(value, name));
  if (descriptors.some(field => !field || !("value" in field) || !field.enumerable)) return reject();
  const [schemaVersion, kind, runId, attemptId, suspensionId, checkpointId, checkpointSha256] = descriptors.map(field => field!.value);
  if (schemaVersion !== 1 || kind !== "runtime_suspension" || !validIdentity(runId) || !validIdentity(attemptId)
    || !validIdentity(suspensionId) || !validIdentity(checkpointId) || typeof checkpointSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(checkpointSha256)) return reject();
  return Object.freeze({ schemaVersion, kind, runId, attemptId, suspensionId, checkpointId, checkpointSha256 });
}

/** Closed data-only receipt, bound to this physical Run/Attempt. No checkpoint is manufactured here. */
export function readRuntimeSuspensionDirective(value: unknown, expected: {
  readonly runId?: string;
  readonly runnerAttemptId?: string;
}): PiRunnerRuntimeSuspensionDirective {
  const directive = captureDirective(value);
  if (!validIdentity(expected.runId) || !validIdentity(expected.runnerAttemptId)
    || directive.runId !== expected.runId || directive.attemptId !== expected.runnerAttemptId) return reject();
  return directive;
}

/** SDK control outcome only, not task success or Host executor/tree drain proof. */
export class PiRunnerSuspended extends Error {
  readonly request: PiRunnerRuntimeSuspensionDirective;
  constructor(request: PiRunnerRuntimeSuspensionDirective, readonly sdkStoppedAt: string) {
    super("Runner suspended at a Host-sealed checkpoint.");
    this.name = "PiRunnerSuspended";
    this.request = captureDirective(request);
  }
}
