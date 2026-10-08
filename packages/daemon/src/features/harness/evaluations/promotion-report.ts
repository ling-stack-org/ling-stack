import {
  RUN_EVALUATION_SEVERITIES,
  RUN_EVALUATION_VERDICTS,
  type RunEvaluationSeverity,
  type RunEvaluationVerdict,
} from "@ling-stack/contracts";
import { RunEvaluationInputError, digestRunEvaluationValue } from "@ling-stack/core";

/** Exact frozen configuration; names alone cannot bind stochastic grader evidence. */
export interface ShadowPromotionFrozenGrader {
  readonly graderId: string;
  readonly graderVersion: string;
  readonly promptDigest: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly samplingDigest: string;
  readonly rubricDigest: string;
}

/** Projected final label and provenance references, not authenticated human authority. */
export interface ShadowPromotionHumanAdjudication {
  readonly adjudicationId: string;
  readonly adjudicatorId: string;
  readonly adjudicatorVersion: string;
  readonly sourceReference: string;
  readonly rubricDigest: string;
  readonly verdict: RunEvaluationVerdict;
  readonly severity?: RunEvaluationSeverity;
}

/** Offline repeat identity is separate from the existing append-only grade unique key. */
export interface ShadowPromotionObservation {
  readonly observationId: string;
  readonly sourceReference: string;
  readonly frozenGraderDigest: string;
  readonly verdict: RunEvaluationVerdict;
  readonly severity?: RunEvaluationSeverity;
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costAmountMicros?: number;
  readonly latencyMs?: number;
}

export interface ShadowPromotionCase {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly suiteDigest: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly caseDigest: string;
  readonly baselineId: string;
  readonly baselineVersion: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly evaluationId: string;
  readonly evaluationState: "completed";
  readonly human?: ShadowPromotionHumanAdjudication;
  readonly observations: readonly ShadowPromotionObservation[];
}

export interface ShadowPromotionReportInput {
  readonly schemaVersion: 1;
  readonly evidenceKind: "synthetic" | "projected-evidence";
  readonly frozenGrader: ShadowPromotionFrozenGrader;
  readonly frozenGraderDigest: string;
  readonly cases: readonly ShadowPromotionCase[];
}

export interface ShadowPromotionFactSummary {
  readonly knownCount: number;
  readonly missingCount: number;
  readonly sum: number | null;
}

export interface ShadowPromotionReport {
  readonly schemaVersion: 1;
  readonly authority: "report-only";
  readonly modelGate: "shadow";
  readonly enforcementAuthorized: false;
  readonly humanEvidenceAuthenticated: false;
  readonly evidenceKind: ShadowPromotionReportInput["evidenceKind"];
  readonly frozenGraderDigest: string;
  /** Canonical projected-input lineage hash, never an authenticity certificate. */
  readonly inputDigest: string;
  readonly uniqueCaseCount: number;
  readonly adjudicatedCaseCount: number;
  readonly humanPassCaseCount: number;
  readonly humanFailCaseCount: number;
  readonly severeHumanFailCaseCount: number;
  readonly independentObservationCount: number;
  readonly falseBlockCaseCount: number;
  readonly severeMissCaseCount: number;
  readonly agreeingCaseCount: number;
  readonly falseBlockRate: number | null;
  readonly repeatedRunAgreement: number | null;
  readonly coverageComplete: boolean;
  readonly thresholds: {
    readonly minimumCases: boolean;
    readonly severeMisses: boolean | null;
    readonly falseBlockRate: boolean | null;
    readonly repeatedRunAgreement: boolean | null;
  };
  readonly thresholdsSatisfied: boolean;
  readonly assessment: "not_assessed" | "thresholds_satisfied" | "thresholds_not_satisfied";
  readonly diagnostics: {
    readonly missingHumanAdjudicationCases: number;
    readonly nonDecisiveHumanCases: number;
    readonly insufficientRepeatCases: number;
    readonly nonDecisiveModelCases: number;
  };
  readonly warnings: readonly string[];
  readonly costs: Readonly<Record<CostField, ShadowPromotionFactSummary>>;
}

const FROZEN_FIELDS = ["graderId", "graderVersion", "promptDigest", "modelId", "modelVersion", "samplingDigest", "rubricDigest"] as const;
const CASE_IDENTITY_FIELDS = ["suiteId", "suiteVersion", "suiteDigest", "caseId", "caseVersion", "caseDigest", "baselineId", "baselineVersion", "baselineDigest"] as const;
const HUMAN_FIELDS = ["adjudicationId", "adjudicatorId", "adjudicatorVersion", "sourceReference", "rubricDigest", "verdict", "severity"] as const;
const COST_FIELDS = ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"] as const;
const OBSERVATION_FIELDS = ["observationId", "sourceReference", "frozenGraderDigest", "verdict", "severity", ...COST_FIELDS] as const;
type CostField = (typeof COST_FIELDS)[number];

interface CaseEvidence {
  readonly candidateDigest: string;
  readonly human?: ShadowPromotionHumanAdjudication;
  readonly humanDigest: string;
  readonly observations: ShadowPromotionObservation[];
}

/**
 * Computes bounded, conservative case-level statistics without I/O or execution authority.
 * Missing/non-decisive evidence is retained as incomplete coverage, never filtered into a
 * qualifying corpus. Malformed, mixed-version, conflicting or overflowing facts throw the
 * existing Core input error. Synthetic success only proves arithmetic, not real calibration.
 */
export function buildShadowPromotionReport(input: ShadowPromotionReportInput): ShadowPromotionReport {
  validateInput(input);
  const cases = new Map<string, CaseEvidence>();
  const suiteVersions = new Map<string, string>();
  const caseVersions = new Map<string, string>();
  const baselineVersions = new Map<string, string>();
  const contents = new Map<string, { readonly caseKey: string; readonly candidateDigest: string }>();
  const observations = new Map<string, { readonly caseKey: string; readonly digest: string }>();
  const sources = new Map<string, string>();
  const costs = Object.fromEntries(COST_FIELDS.map((field) => [field, { knownCount: 0, missingCount: 0, sum: null }])) as
    Record<CostField, { knownCount: number; missingCount: number; sum: number | null }>;

  for (const row of input.cases) {
    bindDefinitionVersion(suiteVersions, [row.suiteId, row.suiteVersion], row.suiteDigest, "suite");
    bindDefinitionVersion(caseVersions, [row.suiteId, row.suiteVersion, row.caseId, row.caseVersion], row.caseDigest, "case");
    bindDefinitionVersion(baselineVersions, [row.baselineId, row.baselineVersion], row.baselineDigest, "baseline");
    const caseKey = digestRunEvaluationValue(Object.fromEntries(CASE_IDENTITY_FIELDS.map((field) => [field, row[field]])));
    const contentKey = digestRunEvaluationValue({ caseDigest: row.caseDigest, baselineDigest: row.baselineDigest });
    const content = contents.get(contentKey);
    if (content && content.candidateDigest !== row.candidateDigest) invalid("Case content candidate conflict.");
    if (content && content.caseKey !== caseKey) invalid("Case content alias is not independent case evidence.");
    contents.set(contentKey, { caseKey, candidateDigest: row.candidateDigest });
    // Reference row IDs can differ on replay; a changed final adjudicator/label cannot.
    const humanDigest = digestRunEvaluationValue(row.human ? {
      adjudicatorId: row.human.adjudicatorId, adjudicatorVersion: row.human.adjudicatorVersion,
      rubricDigest: row.human.rubricDigest, verdict: row.human.verdict, severity: row.human.severity ?? null,
    } : null);
    let evidence = cases.get(caseKey);
    if (evidence && evidence.candidateDigest !== row.candidateDigest) invalid("Case candidate conflict.");
    if (evidence && evidence.humanDigest !== humanDigest) invalid("Case adjudication conflict.");
    if (!evidence) {
      evidence = { candidateDigest: row.candidateDigest, human: row.human, humanDigest, observations: [] };
      cases.set(caseKey, evidence);
    }
    for (const observation of row.observations) {
      const observationDigest = digestRunEvaluationValue(normalizeObservation(observation));
      const existing = observations.get(observation.observationId);
      if (existing) {
        if (existing.caseKey !== caseKey || existing.digest !== observationDigest) invalid("observation conflict.");
        continue;
      }
      const sourceOwner = sources.get(observation.sourceReference);
      if (sourceOwner && sourceOwner !== observation.observationId) invalid("Observation source reference is reused.");
      sources.set(observation.sourceReference, observation.observationId);
      observations.set(observation.observationId, { caseKey, digest: observationDigest });
      evidence.observations.push(observation);
      for (const field of COST_FIELDS) {
        const summary = costs[field];
        const value = observation[field];
        if (value === undefined) {
          summary.missingCount += 1;
        } else {
          const sum = (summary.sum ?? 0) + value;
          if (!Number.isSafeInteger(sum)) invalid(`${field} aggregate overflow.`);
          summary.knownCount += 1;
          summary.sum = sum;
        }
      }
    }
  }

  let adjudicatedCaseCount = 0, humanPassCaseCount = 0, humanFailCaseCount = 0, severeHumanFailCaseCount = 0;
  let falseBlockCaseCount = 0, severeMissCaseCount = 0, agreeingCaseCount = 0;
  const diagnostics = { missingHumanAdjudicationCases: 0, nonDecisiveHumanCases: 0, insufficientRepeatCases: 0, nonDecisiveModelCases: 0 };
  for (const evidence of cases.values()) {
    const repeats = evidence.observations;
    const completeRepeats = repeats.length >= 2;
    const decisiveRepeats = repeats.every((repeat) => isDecisive(repeat.verdict));
    if (!completeRepeats) diagnostics.insufficientRepeatCases += 1;
    if (!decisiveRepeats) diagnostics.nonDecisiveModelCases += 1;
    const human = evidence.human;
    if (!human) { diagnostics.missingHumanAdjudicationCases += 1; continue; }
    if (!isDecisive(human.verdict)) { diagnostics.nonDecisiveHumanCases += 1; continue; }
    adjudicatedCaseCount += 1;
    if (human.verdict === "pass") {
      humanPassCaseCount += 1;
      if (repeats.some((repeat) => repeat.verdict === "fail")) falseBlockCaseCount += 1;
    } else {
      humanFailCaseCount += 1;
      if (human.severity === "error" || human.severity === "critical") {
        severeHumanFailCaseCount += 1;
        if (repeats.some((repeat) => repeat.verdict === "pass")) severeMissCaseCount += 1;
      }
    }
    const first = repeats[0];
    if (completeRepeats && decisiveRepeats && first
      && repeats.every((repeat) => repeat.verdict === first.verdict && repeat.severity === first.severity)) {
      agreeingCaseCount += 1;
    }
  }
  const warnings: string[] = [];
  if (humanPassCaseCount === 0) warnings.push("missing_human_pass_coverage");
  if (humanFailCaseCount === 0) warnings.push("missing_human_fail_coverage");
  if (severeHumanFailCaseCount === 0) warnings.push("missing_severe_human_fail_coverage");
  for (const [reason, count] of Object.entries(diagnostics)) if (count > 0) warnings.push(reason);
  const coverageComplete = warnings.length === 0;
  // Bounded case counts keep these integer cross-products safely exact.
  const thresholds = {
    minimumCases: adjudicatedCaseCount >= 100,
    severeMisses: severeHumanFailCaseCount === 0 ? null : severeMissCaseCount === 0,
    falseBlockRate: humanPassCaseCount === 0 ? null : falseBlockCaseCount * 100 <= humanPassCaseCount,
    repeatedRunAgreement: adjudicatedCaseCount === 0 ? null : agreeingCaseCount * 100 >= adjudicatedCaseCount * 95,
  };
  const thresholdsSatisfied = coverageComplete && Object.values(thresholds).every((value) => value === true);
  return {
    schemaVersion: 1, authority: "report-only", modelGate: "shadow", enforcementAuthorized: false,
    humanEvidenceAuthenticated: false, evidenceKind: input.evidenceKind, frozenGraderDigest: input.frozenGraderDigest,
    inputDigest: digestReportInput(input),
    uniqueCaseCount: cases.size, adjudicatedCaseCount, humanPassCaseCount, humanFailCaseCount, severeHumanFailCaseCount,
    independentObservationCount: observations.size, falseBlockCaseCount, severeMissCaseCount, agreeingCaseCount,
    falseBlockRate: humanPassCaseCount === 0 ? null : falseBlockCaseCount / humanPassCaseCount,
    repeatedRunAgreement: adjudicatedCaseCount === 0 ? null : agreeingCaseCount / adjudicatedCaseCount,
    coverageComplete, thresholds, thresholdsSatisfied,
    assessment: !coverageComplete ? "not_assessed" : thresholdsSatisfied ? "thresholds_satisfied" : "thresholds_not_satisfied",
    diagnostics, warnings: warnings.sort(), costs,
  };
}

function validateInput(input: unknown): asserts input is ShadowPromotionReportInput {
  const root = record(input, ["schemaVersion", "evidenceKind", "frozenGrader", "frozenGraderDigest", "cases"], "report input");
  if (root.schemaVersion !== 1 || !["synthetic", "projected-evidence"].includes(root.evidenceKind as string)) invalid("Report schema/evidence kind is invalid.");
  const frozen = record(root.frozenGrader, FROZEN_FIELDS, "frozen grader");
  for (const field of FROZEN_FIELDS) field.endsWith("Digest") ? requireDigest(frozen[field], field) : requireIdentity(frozen[field], field);
  requireDigest(root.frozenGraderDigest, "frozenGraderDigest");
  if (digestRunEvaluationValue(frozen) !== root.frozenGraderDigest) invalid("frozen grader digest is invalid.");
  const rows = boundedArray(root.cases, 10_000, "case limit");
  let observationCount = 0;
  for (const value of rows) {
    const row = record(value, [...CASE_IDENTITY_FIELDS, "candidateDigest", "evaluationId", "evaluationState", "human", "observations"], "case", ["human"]);
    for (const field of [...CASE_IDENTITY_FIELDS, "candidateDigest"] as const) {
      field.endsWith("Digest") ? requireDigest(row[field], field) : requireIdentity(row[field], field);
    }
    requireIdentity(row.evaluationId, "evaluationId");
    if (row.evaluationState !== "completed") invalid("Evaluation reference must be completed.");
    if (row.human !== undefined) {
      const human = record(row.human, HUMAN_FIELDS, "human adjudication", ["severity"]);
      for (const field of ["adjudicationId", "adjudicatorId", "adjudicatorVersion", "sourceReference"] as const) requireIdentity(human[field], field);
      requireDigest(human.rubricDigest, "human rubricDigest");
      if (human.rubricDigest !== frozen.rubricDigest) invalid("Human rubric does not match frozen grader.");
      validateDecision(human);
      if (human.verdict === "fail" && human.severity === undefined) invalid("Human fail requires severity; unknown severity is not non-severe evidence.");
    }
    const repeats = boundedArray(row.observations, 100, "observation limit");
    observationCount += repeats.length;
    if (observationCount > 100_000) invalid("Total observation limit exceeded.");
    for (const repeat of repeats) {
      const observation = record(repeat, OBSERVATION_FIELDS, "observation", ["severity", ...COST_FIELDS]);
      requireIdentity(observation.observationId, "observationId");
      requireIdentity(observation.sourceReference, "sourceReference");
      requireDigest(observation.frozenGraderDigest, "frozenGraderDigest");
      if (observation.frozenGraderDigest !== root.frozenGraderDigest) invalid("Observation frozen grader does not match.");
      validateDecision(observation);
      for (const field of COST_FIELDS) {
        const fact = observation[field];
        if (fact !== undefined && (typeof fact !== "number" || !Number.isSafeInteger(fact) || fact < 0)) invalid(`${field} must be a non-negative safe integer.`);
      }
    }
  }
}

/** Only shallow, closed projected JSON records; accessors are not evaluated. */
function record(value: unknown, fields: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid(`${label} has an unknown field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${label}.${key} must be an enumerable data property.`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field) && (!optional.includes(field) || field in value)) invalid(`${label}.${field} requires an own data property.`);
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, limit: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(`${label} is invalid or exceeded.`);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label} must be a plain array.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) invalid(`${label} must be a dense plain array.`);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) invalid(`${label} has an invalid array field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid(`${label} requires data property elements.`);
  }
  return value;
}

function normalizeObservation(observation: ShadowPromotionObservation): Record<string, unknown> {
  return {
    ...observation, severity: observation.severity ?? null,
    ...Object.fromEntries(COST_FIELDS.map((field) => [field, observation[field] ?? null])),
  };
}

/** Version keys omit content digests so changing one immutable definition is rejected. */
function bindDefinitionVersion(versions: Map<string, string>, identity: readonly string[], digest: string, kind: "suite" | "case" | "baseline"): void {
  const key = digestRunEvaluationValue(identity);
  const existing = versions.get(key);
  if (existing !== undefined && existing !== digest) invalid(`${kind} version digest conflict.`);
  versions.set(key, digest);
}

/** Retains provenance/cost differences while making input row/repeat ordering irrelevant. */
function digestReportInput(input: ShadowPromotionReportInput): string {
  const sorted = (values: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] => values
    .map((value) => ({ value, digest: digestRunEvaluationValue(value) }))
    .sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)
    .map(({ value }) => value);
  return digestRunEvaluationValue({
    schemaVersion: input.schemaVersion, evidenceKind: input.evidenceKind,
    frozenGrader: input.frozenGrader, frozenGraderDigest: input.frozenGraderDigest,
    cases: sorted(input.cases.map((row) => ({
      ...row, human: row.human ? { ...row.human, severity: row.human.severity ?? null } : null,
      observations: sorted(row.observations.map(normalizeObservation)),
    }))),
  });
}

function requireIdentity(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.trim() !== value) invalid(`${field} identity is invalid.`);
}

function requireDigest(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid(`${field} digest is invalid.`);
}

function validateDecision(value: Record<string, unknown>): void {
  if (!(RUN_EVALUATION_VERDICTS as readonly unknown[]).includes(value.verdict)
    || (value.severity !== undefined && !(RUN_EVALUATION_SEVERITIES as readonly unknown[]).includes(value.severity))) invalid("Verdict/severity is invalid.");
}

function isDecisive(verdict: RunEvaluationVerdict): boolean {
  return verdict === "pass" || verdict === "fail";
}

function invalid(message: string): never {
  throw new RunEvaluationInputError(message);
}
