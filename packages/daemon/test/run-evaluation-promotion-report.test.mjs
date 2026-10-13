import assert from "node:assert/strict";
import test from "node:test";
import { RunEvaluationInputError, digestRunEvaluationValue } from "@ling-stack/core";

// Every fixture is synthetic. These tests certify arithmetic, not human adjudication.
const moduleUrl = new URL("../dist/features/harness/evaluations/promotion-report.js", import.meta.url);
const feature = await import(moduleUrl.href).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== moduleUrl.href) throw error;
  return null;
});
const digest = (value) => digestRunEvaluationValue(value);
const frozenGrader = {
  graderId: "synthetic-grader", graderVersion: "1", promptDigest: digest("prompt-v1"),
  modelId: "synthetic-model", modelVersion: "exact-v1", samplingDigest: digest("sampling-v1"),
  rubricDigest: digest("rubric-v1"),
};
const frozenGraderDigest = digest(frozenGrader);

function observation(caseId, repeat, verdict = "pass", severity) {
  return {
    observationId: `${caseId}-observation-${repeat}`,
    sourceReference: `synthetic:${caseId}:invocation:${repeat}`,
    frozenGraderDigest, verdict,
    ...(severity === undefined ? {} : { severity }),
  };
}

function caseFixture(index, verdict = "pass", severity) {
  const caseId = `case-${index}`;
  return {
    suiteId: "synthetic-suite", suiteVersion: "1", suiteDigest: digest("suite-v1"),
    caseId, caseVersion: "1", caseDigest: digest(caseId),
    baselineId: "synthetic-baseline", baselineVersion: "1", baselineDigest: digest("baseline-v1"),
    candidateDigest: digest(`candidate-${index}`),
    evaluationId: `synthetic-evaluation-${index}`, evaluationState: "completed",
    human: {
      adjudicationId: `synthetic-adjudication-${index}`, adjudicatorId: "synthetic-human",
      adjudicatorVersion: "1", sourceReference: `synthetic:${caseId}:adjudication`,
      rubricDigest: frozenGrader.rubricDigest, verdict,
      ...(severity === undefined ? {} : { severity }),
    },
    observations: [observation(caseId, 1, verdict, severity), observation(caseId, 2, verdict, severity)],
  };
}

function dataset(count = 100) {
  const cases = Array.from({ length: count }, (_, index) => caseFixture(index));
  if (count > 0) cases[count - 1] = caseFixture(count - 1, "fail", "critical");
  return { schemaVersion: 1, evidenceKind: "synthetic", frozenGrader: { ...frozenGrader }, frozenGraderDigest, cases };
}

function report(input) {
  assert.equal(typeof feature?.buildShadowPromotionReport, "function", "New feature is not available yet.");
  return feature.buildShadowPromotionReport(input);
}

function rejected(input, pattern) {
  assert.throws(() => report(input), (error) => error instanceof RunEvaluationInputError
    && pattern.test(error.message));
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function authority(result) {
  assert.equal(result.authority, "report-only");
  assert.equal(result.modelGate, "shadow");
  assert.equal(result.enforcementAuthorized, false);
  assert.equal(result.humanEvidenceAuthenticated, false);
  assert.equal(result.evidenceKind, "synthetic");
}

test("FEATURE AVAILABILITY: the new standalone offline report exists", () => {
  assert.equal(typeof feature?.buildShadowPromotionReport, "function");
});

test("100 synthetic unique adjudicated cases meet arithmetic but never grant enforcement", () => {
  const result = report(dataset());
  authority(result);
  assert.equal(result.uniqueCaseCount, 100);
  assert.equal(result.adjudicatedCaseCount, 100);
  assert.equal(result.independentObservationCount, 200);
  assert.equal(result.thresholdsSatisfied, true);
  assert.equal(result.assessment, "thresholds_satisfied");
  assert.equal(result.falseBlockRate, 0);
  assert.equal(result.repeatedRunAgreement, 1);
});

test("99 cases fail minimum count even with perfect repeats", () => {
  const result = report(dataset(99));
  authority(result);
  assert.equal(result.thresholds.minimumCases, false);
  assert.equal(result.thresholdsSatisfied, false);
});

test("evaluation replays and renamed evaluation IDs cannot inflate case or repeat counts", () => {
  const input = dataset(99);
  input.cases.push({ ...structuredClone(input.cases[0]), evaluationId: "another-evaluation" });
  const result = report(input);
  assert.equal(result.uniqueCaseCount, 99);
  assert.equal(result.independentObservationCount, 198);
  assert.equal(result.thresholdsSatisfied, false);
});

test("content aliases with renamed case or suite IDs are rejected", () => {
  for (const field of ["caseId", "suiteId", "caseVersion", "baselineVersion"]) {
    const input = dataset();
    const alias = structuredClone(input.cases[0]);
    alias[field] = `${alias[field]}-alias`;
    input.cases.push(alias);
    rejected(input, /content alias/u);
  }
});

test("same case with a different candidate is rejected instead of choosing the best result", () => {
  const input = dataset();
  input.cases.push({ ...structuredClone(input.cases[0]), candidateDigest: digest("changed") });
  rejected(input, /candidate conflict/u);
});

test("same content under an alias cannot bypass candidate conflict rejection", () => {
  const input = dataset();
  const alias = { ...structuredClone(input.cases[0]), caseId: "alias", candidateDigest: digest("changed") };
  input.cases.push(alias);
  rejected(input, /candidate conflict/u);
});

test("conflicting human verdict, severity, or adjudicator version is rejected", () => {
  for (const change of [{ verdict: "fail", severity: "critical" }, { severity: "error" }, { adjudicatorVersion: "2" }]) {
    const input = dataset();
    const duplicate = structuredClone(input.cases[0]);
    Object.assign(duplicate.human, change);
    input.cases.push(duplicate);
    rejected(input, /adjudication conflict/u);
  }
});

test("observation replay is idempotent but changed replay is rejected", () => {
  const input = dataset();
  input.cases[0].observations.push(structuredClone(input.cases[0].observations[0]));
  assert.equal(report(input).independentObservationCount, 200);
  input.cases[0].observations[2].latencyMs = 1;
  rejected(input, /observation conflict/u);
});

test("observation IDs and source references cannot be reused as independent samples", () => {
  const input = dataset();
  input.cases[1].observations[0].observationId = input.cases[0].observations[0].observationId;
  rejected(input, /observation conflict/u);
  const copy = dataset();
  copy.cases[0].observations[1].sourceReference = copy.cases[0].observations[0].sourceReference;
  rejected(copy, /source reference/u);
});

test("identical outputs with distinct invocation identities remain independent repeats", () => {
  const result = report(dataset());
  assert.equal(result.independentObservationCount, 200);
  assert.equal(result.agreeingCaseCount, 100);
});

test("any model pass on an error or critical human fail counts one severe miss per case", () => {
  for (const severity of ["error", "critical"]) {
    const input = dataset();
    const target = input.cases[99];
    target.human.severity = severity;
    target.observations.push(observation(target.caseId, 3, "pass"), observation(target.caseId, 4, "pass"));
    const result = report(input);
    assert.equal(result.severeMissCaseCount, 1);
    assert.equal(result.thresholds.severeMisses, false);
    assert.equal(result.thresholdsSatisfied, false);
  }
});

test("model severity cannot turn a non-severe human fail into severe ground truth", () => {
  const input = dataset();
  input.cases[0] = caseFixture(0, "fail", "warning");
  input.cases[0].observations = [observation("case-0", 1, "pass", "critical"), observation("case-0", 2, "pass", "critical")];
  const result = report(input);
  assert.equal(result.severeHumanFailCaseCount, 1);
  assert.equal(result.severeMissCaseCount, 0);
});

test("human fail with missing severity cannot hide a severe miss behind other coverage", () => {
  const input = dataset();
  input.cases[0].human.verdict = "fail";
  rejected(input, /Human fail requires severity/u);
});

test("1% false-block boundary is inclusive and uses human-pass denominator", () => {
  const input = dataset(101); // 100 human passes plus one severe human fail.
  input.cases[0].observations = [observation("case-0", 1, "fail"), observation("case-0", 2, "fail")];
  const result = report(input);
  assert.equal(result.humanPassCaseCount, 100);
  assert.equal(result.falseBlockCaseCount, 1);
  assert.equal(result.falseBlockRate, 0.01);
  assert.equal(result.thresholds.falseBlockRate, true);
  assert.equal(result.thresholdsSatisfied, true);
  const above = dataset(100); // 1/99 is over 1%, although 1/100 would not be.
  above.cases[0].observations = structuredClone(input.cases[0].observations);
  assert.equal(report(above).thresholds.falseBlockRate, false);
});

test("repeated false blocks count a case once using its worst repeat", () => {
  const input = dataset(101);
  input.cases[0].observations.push(observation("case-0", 3, "fail"), observation("case-0", 4, "fail"));
  const result = report(input);
  assert.equal(result.falseBlockCaseCount, 1);
  assert.equal(result.agreeingCaseCount, 100);
});

test("agreement is case-level, compares severity, and accepts exactly 95%", () => {
  const input = dataset();
  for (let index = 0; index < 6; index += 1) input.cases[index] = caseFixture(index, "fail", "warning");
  for (let index = 0; index < 5; index += 1) input.cases[index].observations[1].severity = "info";
  const result = report(input);
  assert.equal(result.agreeingCaseCount, 95);
  assert.equal(result.repeatedRunAgreement, 0.95);
  assert.equal(result.thresholds.repeatedRunAgreement, true);
  assert.equal(result.thresholdsSatisfied, true);
  input.cases[5].observations[1].severity = "info";
  assert.equal(report(input).thresholds.repeatedRunAgreement, false);
});

test("high repeat volume cannot weight one disagreeing case into agreement", () => {
  const input = dataset();
  input.cases[0].observations = Array.from({ length: 90 }, (_, repeat) => observation("case-0", repeat));
  input.cases[0].observations.push(observation("case-0", 91, "fail"));
  assert.equal(report(input).agreeingCaseCount, 99);
});

test("missing human adjudication invalidates coverage instead of filtering the case away", () => {
  const input = dataset(101);
  delete input.cases[0].human;
  const result = report(input);
  assert.equal(result.uniqueCaseCount, 101);
  assert.equal(result.adjudicatedCaseCount, 100);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.thresholdsSatisfied, false);
  assert.equal(result.diagnostics.missingHumanAdjudicationCases, 1);
});

test("human abstain/error are not adjudicated pass/fail evidence", () => {
  for (const verdict of ["abstain", "error"]) {
    const input = dataset(101);
    input.cases[0].human.verdict = verdict;
    const result = report(input);
    assert.equal(result.adjudicatedCaseCount, 100);
    assert.equal(result.coverageComplete, false);
    assert.equal(result.diagnostics.nonDecisiveHumanCases, 1);
  }
});

test("zero/one repeat is incomplete even when all other cases agree", () => {
  for (const count of [0, 1]) {
    const input = dataset();
    input.cases[0].observations.length = count;
    const result = report(input);
    assert.equal(result.agreeingCaseCount, 99);
    assert.equal(result.coverageComplete, false);
    assert.equal(result.thresholdsSatisfied, false);
    assert.equal(result.diagnostics.insufficientRepeatCases, 1);
  }
});

test("a copied observation is not a second independent repeat", () => {
  const input = dataset();
  input.cases[0].observations[1] = structuredClone(input.cases[0].observations[0]);
  const result = report(input);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.independentObservationCount, 199);
});

test("model abstain/error invalidates coverage and never contributes agreement", () => {
  for (const verdict of ["abstain", "error"]) {
    const input = dataset();
    input.cases[0].observations = [observation("case-0", 1, verdict), observation("case-0", 2, verdict)];
    const result = report(input);
    assert.equal(result.agreeingCaseCount, 99);
    assert.equal(result.coverageComplete, false);
    assert.equal(result.thresholdsSatisfied, false);
    assert.equal(result.diagnostics.nonDecisiveModelCases, 1);
  }
});

test("empty input retains null denominators and reports missing strata", () => {
  const result = report(dataset(0));
  authority(result);
  assert.equal(result.falseBlockRate, null);
  assert.equal(result.repeatedRunAgreement, null);
  assert.equal(result.thresholds.falseBlockRate, null);
  assert.equal(result.thresholds.repeatedRunAgreement, null);
  assert.equal(result.thresholds.severeMisses, null);
  assert.equal(result.assessment, "not_assessed");
  assert.ok(result.warnings.includes("missing_human_pass_coverage"));
  assert.ok(result.warnings.includes("missing_human_fail_coverage"));
  assert.ok(result.warnings.includes("missing_severe_human_fail_coverage"));
});

test("absent pass, fail, or severe strata cannot vacuously satisfy thresholds", () => {
  for (const [verdict, severity] of [["pass", undefined], ["fail", "critical"], ["fail", "warning"]]) {
    const input = dataset();
    input.cases = input.cases.map((_, index) => caseFixture(index, verdict, severity));
    const result = report(input);
    assert.equal(result.assessment, "not_assessed");
    assert.equal(result.thresholdsSatisfied, false);
  }
  const noSevere = dataset();
  noSevere.cases[99] = caseFixture(99, "fail", "warning");
  assert.equal(report(noSevere).thresholds.severeMisses, null);
});

test("all frozen-definition fields participate in canonical version binding", () => {
  for (const field of Object.keys(frozenGrader)) {
    const input = dataset();
    input.frozenGrader = { ...frozenGrader, [field]: field.endsWith("Digest") ? digest("v2") : "v2" };
    rejected(input, /frozen grader digest/u);
    input.frozenGraderDigest = digest(input.frozenGrader);
    rejected(input, /frozen grader/u);
  }
});

test("mixed observation definition or human rubric is rejected", () => {
  const input = dataset();
  input.cases[0].observations[0].frozenGraderDigest = digest("another-definition");
  rejected(input, /frozen grader/u);
  const humanDrift = dataset();
  humanDrift.cases[0].human.rubricDigest = digest("another-rubric");
  rejected(humanDrift, /rubric/u);
});

test("missing source or frozen lineage and non-completed evaluations are rejected", () => {
  for (const mutate of [
    (input) => { delete input.cases[0].observations[0].sourceReference; },
    (input) => { delete input.cases[0].observations[0].frozenGraderDigest; },
    (input) => { delete input.cases[0].human.adjudicationId; },
    (input) => { input.cases[0].evaluationState = "grading"; },
  ]) {
    const input = dataset();
    mutate(input);
    rejected(input, /sourceReference|frozenGraderDigest|adjudicationId|completed/u);
  }
});

test("cost/latency tracks known and missing facts without counting replay twice", () => {
  const input = dataset();
  Object.assign(input.cases[0].observations[0], { costInputTokens: 7, costOutputTokens: 3, costAmountMicros: 5, latencyMs: 11 });
  input.cases[0].observations[1].costInputTokens = 0;
  input.cases[0].observations.push(structuredClone(input.cases[0].observations[0]));
  const result = report(input);
  assert.deepEqual(result.costs.costInputTokens, { knownCount: 2, missingCount: 198, sum: 7 });
  assert.deepEqual(result.costs.latencyMs, { knownCount: 1, missingCount: 199, sum: 11 });
  assert.deepEqual(report(dataset()).costs.costAmountMicros, { knownCount: 0, missingCount: 200, sum: null });
});

test("negative, non-finite, fractional and unsafe cost/latency facts are rejected", () => {
  for (const field of ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]) {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = dataset();
      input.cases[0].observations[0][field] = value;
      rejected(input, /safe integer/u);
    }
  }
});

test("safe individual cost values cannot silently overflow the aggregate", () => {
  for (const field of ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]) {
    const input = dataset();
    input.cases[0].observations[0][field] = Number.MAX_SAFE_INTEGER;
    input.cases[0].observations[1][field] = 1;
    rejected(input, /overflow/u);
  }
});

test("bounded validation rejects excessive cases, repeats, strings and unknown fields", () => {
  const manyCases = dataset(0);
  manyCases.cases = Array.from({ length: 10_001 }, () => ({}));
  rejected(manyCases, /case limit/u);
  const repeats = dataset();
  repeats.cases[0].observations = Array.from({ length: 101 }, () => ({}));
  rejected(repeats, /observation limit/u);
  const longString = dataset();
  longString.cases[0].caseId = "x".repeat(501);
  rejected(longString, /caseId/u);
  const unknown = dataset();
  unknown.store = {};
  rejected(unknown, /unknown field/u);
});

test("bounded validation rejects malformed enums, digests, schema and evidence kind", () => {
  for (const mutate of [
    (input) => { input.schemaVersion = 2; },
    (input) => { input.evidenceKind = "human-certified"; },
    (input) => { input.cases[0].caseDigest = "bad-digest"; },
    (input) => { input.cases[0].observations[0].verdict = "approve"; },
    (input) => { input.cases[0].human.severity = "fatal"; },
  ]) {
    const input = dataset();
    mutate(input);
    rejected(input, /invalid/u);
  }
});

test("accessors and exotic records are rejected without invoking user code", () => {
  let calls = 0;
  const input = dataset();
  Object.defineProperty(input.cases[0], "candidateDigest", { enumerable: true, get() { calls += 1; return digest("evil"); } });
  rejected(input, /data property/u);
  assert.equal(calls, 0);
  const exotic = dataset();
  Object.setPrototypeOf(exotic.frozenGrader, new Date());
  rejected(exotic, /plain object/u);
});

test("input order and equivalent canonical field ordering do not change the report", () => {
  const input = dataset();
  const expected = report(freeze(structuredClone(input)));
  input.cases.reverse();
  input.cases.forEach((item) => item.observations.reverse());
  input.frozenGrader = Object.fromEntries(Object.entries(input.frozenGrader).reverse());
  assert.deepEqual(report(input), expected);
});

test("input digest retains source, evaluation, adjudication, candidate and optional cost lineage", () => {
  const expected = report(dataset()).inputDigest;
  assert.match(expected, /^[a-f0-9]{64}$/u);
  for (const mutate of [
    (input) => { input.cases[0].observations[0].sourceReference = "synthetic:changed-source"; },
    (input) => { input.cases[0].evaluationId = "synthetic:changed-evaluation"; },
    (input) => { input.cases[0].human.adjudicationId = "synthetic:changed-adjudication"; },
    (input) => { input.cases[0].human.sourceReference = "synthetic:changed-human-source"; },
    (input) => { input.cases[0].candidateDigest = digest("changed-candidate"); },
    (input) => { input.cases[0].observations[0].costInputTokens = 0; },
  ]) {
    const input = dataset();
    mutate(input);
    assert.notEqual(report(input).inputDigest, expected);
  }
});

test("array subclasses, sparse arrays and array accessors are rejected before iteration", () => {
  let calls = 0;
  const input = dataset();
  Object.setPrototypeOf(input.cases, { [Symbol.iterator]() { calls += 1; throw new Error("must not execute"); } });
  rejected(input, /plain array/u);
  assert.equal(calls, 0);
  const sparse = dataset();
  delete sparse.cases[0];
  rejected(sparse, /dense plain array/u);
  const accessor = dataset();
  Object.defineProperty(accessor.cases, "0", { get() { calls += 1; throw new Error("must not execute"); } });
  rejected(accessor, /data property/u);
  assert.equal(calls, 0);
});

test("missing required or optional fields cannot be filled by prototype pollution", () => {
  for (const field of ["evaluationId", "human"]) {
    const input = dataset();
    const inherited = input.cases[0][field];
    delete input.cases[0][field];
    Object.defineProperty(Object.prototype, field, { configurable: true, value: inherited });
    try { rejected(input, /own data property/u); }
    finally { delete Object.prototype[field]; }
  }
});

test("projected evidence stays unauthenticated and report-only without any production entry", () => {
  const input = dataset();
  input.evidenceKind = "projected-evidence";
  const result = report(input);
  assert.equal(result.evidenceKind, "projected-evidence");
  assert.equal(result.humanEvidenceAuthenticated, false);
  assert.equal(result.enforcementAuthorized, false);
  assert.equal(result.authority, "report-only");
  assert.equal(result.modelGate, "shadow");
});

for (const field of ["suiteDigest", "caseDigest", "baselineDigest"]) {
  test(`immutable ${field} binding rejects changed content at the same id and version`, () => {
    const input = dataset();
    if (field === "caseDigest") {
      const changedDefinition = structuredClone(input.cases[0]);
      changedDefinition.caseDigest = digest("changed-case-definition-same-version");
      changedDefinition.evaluationId = "synthetic:changed-case-evaluation";
      changedDefinition.human.adjudicationId = "synthetic:changed-case-adjudication";
      changedDefinition.human.sourceReference = "synthetic:changed-case-human-source";
      changedDefinition.observations = [observation("changed-case-definition", 1), observation("changed-case-definition", 2)];
      input.cases.push(changedDefinition);
    } else {
      // A different logical case still references the same suite/baseline version.
      // Unique invocation IDs ensure an unrelated replay guard cannot mask drift.
      input.cases[1][field] = digest(`changed-${field}-same-version`);
    }
    rejected(input, /version.*digest|digest.*version/u);
  });
}
