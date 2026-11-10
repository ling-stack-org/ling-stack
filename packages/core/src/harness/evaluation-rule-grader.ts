import type { RunEvaluationSeverity } from "@ling-stack/contracts";
import {
  RunEvaluationInputError,
  assertRunEvaluationJsonSafe,
  canonicalRunEvaluationJson,
  isRunEvaluationJsonRecord,
} from "./evaluation-json.js";

export type RunEvaluationJsonPath = readonly (string | number)[];

export type DeterministicRunEvaluationAssertionV1 =
  | {
      readonly type: "deep_equal";
      readonly candidatePath?: RunEvaluationJsonPath;
      readonly baselinePath?: RunEvaluationJsonPath;
    }
  | {
      readonly type: "contains";
      readonly candidatePath?: RunEvaluationJsonPath;
      readonly baselinePath?: RunEvaluationJsonPath;
    }
  | {
      readonly type: "exists";
      readonly candidatePath: RunEvaluationJsonPath;
    }
  | {
      readonly type: "number_range";
      readonly candidatePath: RunEvaluationJsonPath;
      readonly minimum?: number;
      readonly maximum?: number;
    };

export interface DeterministicRunEvaluationCaseV1 {
  readonly schemaVersion: 1;
  readonly kind: "deterministic_json_rule";
  readonly graderId: string;
  readonly graderVersion: string;
  readonly failureSeverity: RunEvaluationSeverity;
  readonly assertions: readonly DeterministicRunEvaluationAssertionV1[];
}

export interface DeterministicRunEvaluationResult {
  readonly graderType: "rule";
  readonly graderId: string;
  readonly graderVersion: string;
  readonly verdict: "pass" | "fail";
  readonly score: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rationale: Readonly<{
    schemaVersion: 1;
    passed: number;
    total: number;
    assertions: readonly Readonly<{
      index: number;
      type: DeterministicRunEvaluationAssertionV1["type"];
      passed: boolean;
    }>[];
  }>;
}

/** Deterministic, JSON-only rule grader. It never executes code or trusts model prose. */
export function gradeDeterministicRunEvaluation(input: {
  readonly caseDefinition: unknown;
  readonly baseline: unknown;
  readonly candidate: unknown;
}): DeterministicRunEvaluationResult {
  assertRunEvaluationJsonSafe(input.caseDefinition, "case definition");
  assertRunEvaluationJsonSafe(input.baseline, "baseline");
  assertRunEvaluationJsonSafe(input.candidate, "candidate");
  const definition = parseDeterministicCase(input.caseDefinition);
  const results = definition.assertions.map((assertion, index) => ({
    index,
    type: assertion.type,
    passed: evaluateAssertion(assertion, input.baseline, input.candidate),
  }));
  const passed = results.filter((result) => result.passed).length;
  const verdict = passed === results.length ? "pass" : "fail";
  return {
    graderType: "rule",
    graderId: definition.graderId,
    graderVersion: definition.graderVersion,
    verdict,
    score: passed / results.length,
    ...(verdict === "fail" ? { severity: definition.failureSeverity } : {}),
    rationale: { schemaVersion: 1, passed, total: results.length, assertions: results },
  };
}

function parseDeterministicCase(value: unknown): DeterministicRunEvaluationCaseV1 {
  if (!isRunEvaluationJsonRecord(value)) throw new RunEvaluationInputError("Rule case must be an object.");
  assertExactKeys(value, ["schemaVersion", "kind", "graderId", "graderVersion", "failureSeverity", "assertions"]);
  if (value.schemaVersion !== 1 || value.kind !== "deterministic_json_rule") {
    throw new RunEvaluationInputError("Rule case schema is unsupported.");
  }
  const graderId = identity(value.graderId, "grader id");
  const graderVersion = identity(value.graderVersion, "grader version");
  if (!["info", "warning", "error", "critical"].includes(String(value.failureSeverity))) {
    throw new RunEvaluationInputError("Rule failure severity is invalid.");
  }
  if (!Array.isArray(value.assertions) || value.assertions.length < 1 || value.assertions.length > 100) {
    throw new RunEvaluationInputError("Rule case must contain between 1 and 100 assertions.");
  }
  return {
    schemaVersion: 1,
    kind: "deterministic_json_rule",
    graderId,
    graderVersion,
    failureSeverity: value.failureSeverity as RunEvaluationSeverity,
    assertions: value.assertions.map(parseAssertion),
  };
}

function parseAssertion(value: unknown): DeterministicRunEvaluationAssertionV1 {
  if (!isRunEvaluationJsonRecord(value) || typeof value.type !== "string") {
    throw new RunEvaluationInputError("Rule assertion must be an object with a type.");
  }
  if (value.type === "deep_equal" || value.type === "contains") {
    assertExactKeys(value, ["type", "candidatePath", "baselinePath"], true);
    return {
      type: value.type,
      ...(value.candidatePath === undefined ? {} : { candidatePath: parsePath(value.candidatePath) }),
      ...(value.baselinePath === undefined ? {} : { baselinePath: parsePath(value.baselinePath) }),
    };
  }
  if (value.type === "exists") {
    assertExactKeys(value, ["type", "candidatePath"]);
    return { type: "exists", candidatePath: parsePath(value.candidatePath) };
  }
  if (value.type === "number_range") {
    assertExactKeys(value, ["type", "candidatePath", "minimum", "maximum"], true);
    const minimum = optionalFiniteNumber(value.minimum, "minimum");
    const maximum = optionalFiniteNumber(value.maximum, "maximum");
    if (minimum === undefined && maximum === undefined) {
      throw new RunEvaluationInputError("Number range requires a minimum or maximum.");
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new RunEvaluationInputError("Number range minimum exceeds maximum.");
    }
    return {
      type: "number_range",
      candidatePath: parsePath(value.candidatePath),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
  }
  throw new RunEvaluationInputError(`Unsupported rule assertion: ${value.type}`);
}

function evaluateAssertion(
  assertion: DeterministicRunEvaluationAssertionV1,
  baseline: unknown,
  candidate: unknown,
): boolean {
  if (assertion.type === "exists") return readPath(candidate, assertion.candidatePath).found;
  if (assertion.type === "number_range") {
    const actual = readPath(candidate, assertion.candidatePath);
    if (!actual.found || typeof actual.value !== "number" || !Number.isFinite(actual.value)) return false;
    return (assertion.minimum === undefined || actual.value >= assertion.minimum)
      && (assertion.maximum === undefined || actual.value <= assertion.maximum);
  }
  const expected = readPath(baseline, assertion.baselinePath ?? []);
  const actual = readPath(candidate, assertion.candidatePath ?? []);
  if (!expected.found || !actual.found) return false;
  return assertion.type === "deep_equal"
    ? canonicalRunEvaluationJson(expected.value) === canonicalRunEvaluationJson(actual.value)
    : containsJson(actual.value, expected.value);
}

function readPath(value: unknown, path: RunEvaluationJsonPath): { readonly found: boolean; readonly value?: unknown } {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return { found: false };
      current = current[segment];
      continue;
    }
    if (!isRunEvaluationJsonRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function containsJson(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => containsJson(actual[index], item));
  }
  if (isRunEvaluationJsonRecord(expected)) {
    if (!isRunEvaluationJsonRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(actual, key) && containsJson(actual[key], value));
  }
  return Object.is(actual, expected);
}

function parsePath(value: unknown): RunEvaluationJsonPath {
  if (!Array.isArray(value) || value.length > 64) throw new RunEvaluationInputError("Rule path must be an array.");
  return value.map((segment) => {
    if (typeof segment === "string" && segment.length > 0 && segment.length <= 200) return segment;
    if (Number.isSafeInteger(segment) && Number(segment) >= 0) return Number(segment);
    throw new RunEvaluationInputError("Rule path segments must be non-empty strings or non-negative integers.");
  });
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], optional = false): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new RunEvaluationInputError("Rule definition contains unsupported fields.");
  }
  if (!optional && allowed.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new RunEvaluationInputError("Rule definition is missing required fields.");
  }
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 200) {
    throw new RunEvaluationInputError(`Rule ${field} is invalid.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RunEvaluationInputError(`Rule ${field} must be finite.`);
  }
  return value;
}
