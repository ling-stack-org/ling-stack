import { RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { RUN_EVALUATION_TASK_FAILURE_CODES, RUN_EVALUATION_VERDICTS, RUN_EVALUATION_SEVERITIES } from "@ling-stack/contracts";
export const FROZEN_TASK_FIELDS = ["graderId", "graderVersion", "promptDigest", "modelId", "modelVersion", "samplingDigest", "rubricDigest"] as const;
const IDENTITY_FIELDS = ["evaluationId", "evaluationKey", "frozenGraderArtifact", "frozenGraderDigest", "repeatOrdinal"] as const;
const FENCE_FIELDS = ["taskId", "attemptId", "expectedTaskRevision", "expectedAttemptRevision", "claimOwner", "claimToken", "now"] as const;
export const TASK_RESULT_FIELDS = ["verdict", "score", "severity", "rawOutputArtifact", "rationaleArtifact", "costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"] as const;

/** Validate descriptors before reading values; fixed errors never echo input or provider data. */
export function taskRecord(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !fields.includes(key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  for (const field of fields) if (!Object.hasOwn(value, field) && (!optional.includes(field) || field in value)) invalid();
  return value as Record<string, unknown>;
}
export function taskIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 500 || value.trim() !== value || value.includes("\0")) invalid();
}
export function taskDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
}
export function taskInteger(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid();
}
export function taskTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
export function taskLimit(value: unknown): number {
  if (value === undefined) return 100;
  taskInteger(value, 1);
  if (value > 500) invalid();
  return value;
}
export function validateTaskArtifactPin(value: unknown): void {
  const ref = taskRecord(value, ["artifactId", "contentSha256"]);
  taskIdentity(ref.artifactId);
  taskDigest(ref.contentSha256);
}
export function validateTaskFrozen(value: unknown): void {
  const frozen = taskRecord(value, FROZEN_TASK_FIELDS);
  for (const key of FROZEN_TASK_FIELDS) key.endsWith("Digest") ? taskDigest(frozen[key]) : taskIdentity(frozen[key]);
}
export function validateTaskEnqueueIdentity(value: unknown): void {
  const input = taskRecord(value, IDENTITY_FIELDS);
  validateIdentityFields(input);
}
function validateIdentityFields(input: Record<string, unknown>): void {
  taskIdentity(input.evaluationId);
  if (typeof input.evaluationKey !== "string" || !/^run-evaluation:[a-f0-9]{64}$/u.test(input.evaluationKey)) invalid();
  validateTaskArtifactPin(input.frozenGraderArtifact);
  taskDigest(input.frozenGraderDigest);
  taskInteger(input.repeatOrdinal, 1);
}
export function validateTaskResult(value: unknown): void {
  const result = taskRecord(value, TASK_RESULT_FIELDS, ["score", "severity", "rationaleArtifact", "costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]);
  if (!(RUN_EVALUATION_VERDICTS as readonly unknown[]).includes(result.verdict)) invalid();
  if (Object.hasOwn(result, "score") && (typeof result.score !== "number" || !Number.isFinite(result.score) || result.score < 0 || result.score > 1)) invalid();
  if (Object.hasOwn(result, "severity") && !(RUN_EVALUATION_SEVERITIES as readonly unknown[]).includes(result.severity)) invalid();
  validateTaskArtifactPin(result.rawOutputArtifact);
  if (Object.hasOwn(result, "rationaleArtifact")) validateTaskArtifactPin(result.rationaleArtifact);
  for (const key of ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]) if (Object.hasOwn(result, key)) taskInteger(result[key]);
}
export function validateTaskInput(value: unknown, kind: "enqueue" | "claim" | "renew" | "admit" | "complete" | "finish" | "unknown" | "list" | "recover" | "recoverExact"): void {
  const additions = {
    renew: ["claimExpiresAt"],
    admit: ["requestDigest", "executionScopeDigest"],
    complete: ["result"],
    finish: ["nextState", "failureCode", "nextAttemptAt"],
    unknown: []
  };
  let input: Record<string, unknown>;
  if (kind === "enqueue") {
    input = taskRecord(value, [...IDENTITY_FIELDS, "now"]);
    validateIdentityFields(input);
  } else if (kind === "claim") {
    input = taskRecord(value, ["taskId", "expectedTaskRevision", "claimOwner", "claimToken", "claimExpiresAt", "now"]);
    for (const field of ["taskId", "claimOwner", "claimToken"]) taskIdentity(input[field]);
    taskInteger(input.expectedTaskRevision);
  } else if (kind === "list" || kind === "recover") {
    input = taskRecord(value, kind === "list" ? ["now", "limit"] : ["now", "limit", "cursor"], kind === "list" ? ["limit"] : ["limit", "cursor"]);
    taskLimit(input.limit);
    if (Object.hasOwn(input, "cursor")) {
      const cursor = taskRecord(input.cursor, ["claimExpiresAt", "attemptId"]);
      taskTime(cursor.claimExpiresAt);
      taskIdentity(cursor.attemptId);
    }
  } else if (kind === "recoverExact") {
    input = taskRecord(value, ["taskId", "attemptId", "now"]);
    taskIdentity(input.taskId);
    taskIdentity(input.attemptId);
  } else {
    input = taskRecord(value, [...FENCE_FIELDS, ...additions[kind]], kind === "finish" ? ["nextAttemptAt"] : []);
    for (const field of ["taskId", "attemptId", "claimOwner", "claimToken"]) taskIdentity(input[field]);
    taskInteger(input.expectedTaskRevision);
    taskInteger(input.expectedAttemptRevision);
  }
  taskTime(input.now);
  if (kind === "claim" || kind === "renew") {
    taskTime(input.claimExpiresAt);
    if (input.claimExpiresAt <= input.now) invalid();
  }
  if (kind === "admit") {
    taskDigest(input.requestDigest);
    taskDigest(input.executionScopeDigest);
  }
  if (kind === "complete") validateTaskResult(input.result);
  if (kind === "finish") {
    if (!["queued", "failed", "cancelled"].includes(input.nextState as string) || !(RUN_EVALUATION_TASK_FAILURE_CODES as readonly unknown[]).includes(input.failureCode)) invalid();
    if (Object.hasOwn(input, "nextAttemptAt")) {
      taskTime(input.nextAttemptAt);
      if (input.nextState !== "queued" || input.nextAttemptAt <= input.now) invalid();
    }
  }
}

/** Bounded postparse validation; current Artifact getter has no preparse memory guarantee. */
export function validateTaskArtifactJson(value: unknown): void {
  let nodes = 0,
    characters = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) invalid();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      characters += item.length;
      if (characters > 1_048_576) invalid();
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) invalid();
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 100_000 || Reflect.ownKeys(item).length !== item.length + 1) invalid();
      for (let i = 0; i < item.length; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !("value" in property) || !property.enumerable) invalid();
        visit(property.value, depth + 1);
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        characters += key.length;
        if (characters > 1_048_576) invalid();
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
}
function invalid(): never {
  throw new RunEvaluationInputError("evaluation.task_invalid");
}
