import { createHash } from "node:crypto";

export class RunEvaluationInputError extends Error {
  readonly code = "evaluation.result_invalid" as const;
}

export function digestRunEvaluationValue(value: unknown): string {
  return createHash("sha256").update(canonicalRunEvaluationJson(value), "utf8").digest("hex");
}

export function canonicalRunEvaluationJson(value: unknown): string {
  assertRunEvaluationJsonSafe(value, "evaluation value");
  return JSON.stringify(sortRunEvaluationJson(value));
}

export function assertRunEvaluationJsonSafe(
  value: unknown,
  field: string,
  seen = new Set<object>(),
  depth = 0,
): void {
  if (depth > 64) throw new RunEvaluationInputError(`${field} exceeds the maximum JSON depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RunEvaluationInputError(`${field} contains a non-finite number.`);
    return;
  }
  if (typeof value !== "object") throw new RunEvaluationInputError(`${field} is not JSON-safe.`);
  if (seen.has(value)) throw new RunEvaluationInputError(`${field} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertRunEvaluationJsonSafe(item, field, seen, depth + 1);
  } else {
    if (!isRunEvaluationJsonRecord(value)) {
      throw new RunEvaluationInputError(`${field} contains a non-plain object.`);
    }
    for (const item of Object.values(value)) assertRunEvaluationJsonSafe(item, field, seen, depth + 1);
  }
  seen.delete(value);
}

export function isRunEvaluationJsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortRunEvaluationJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRunEvaluationJson);
  if (isRunEvaluationJsonRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortRunEvaluationJson(value[key])]));
  }
  return value;
}
