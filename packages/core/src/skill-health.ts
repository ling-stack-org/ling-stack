import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";
import type { SkillDefinition, SkillRegistryEntry } from "./skill-types.js";
import type { SkillUsageStats } from "./skill-usage-types.js";

export type SkillHealthSeverity = "info" | "warning" | "critical";

export type SkillDuplicateDecision =
  | "no_overlap"
  | "append_evidence"
  | "update_existing"
  | "conflict_review"
  | "reject_duplicate";

export type SkillHealthFindingKind =
  | "duplicate_clusters"
  | "conflicting_triggers"
  | "shadowed_skill"
  | "never_used_skill"
  | "stale_candidate"
  | "high_failure_rate_skill"
  | "high_user_correction_skill"
  | "external_overlap_generated_skill"
  | "superseded_but_active"
  | "missing_validation_steps"
  | "missing_negative_triggers";

export type SkillHealthRecommendedAction =
  | "review"
  | "merge"
  | "supersede"
  | "disable"
  | "archive"
  | "add_validation"
  | "add_negative_triggers"
  | "reject_candidate";

export type SkillCandidateHealthStatus =
  | "pending"
  | "needs_edit"
  | "approved_for_draft"
  | "published"
  | "rejected"
  | "quarantined"
  | "superseded"
  | "expired";

export type SkillCandidateHealthOrigin =
  | "ling-generated"
  | "recording"
  | "manual-draft"
  | "import-overlay";

export interface SkillCandidateHealthInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly origin: SkillCandidateHealthOrigin;
  readonly status: SkillCandidateHealthStatus;
  readonly targetSkillId?: string;
  readonly title: string;
  readonly summary: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps?: readonly {
    readonly title: string;
    readonly instruction?: string;
    readonly requiredTools?: readonly string[];
  }[];
  readonly validationSteps?: readonly {
    readonly title: string;
    readonly commandOrCheck?: string;
    readonly expectedResult?: string;
  }[];
  readonly requiredTools?: readonly (RunTool | string)[];
  readonly requiredProviderCapabilities?: readonly (ProviderCapability | string)[];
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly supersededBy?: string;
}

export interface SkillDuplicateAnalysis {
  readonly decision: SkillDuplicateDecision;
  readonly similarityScore: number;
  readonly matchedSkillIds: readonly string[];
  readonly matchedCandidateIds: readonly string[];
  readonly triggerOverlap: readonly string[];
  readonly conflictingFields: readonly string[];
  readonly rationale: string;
}

export interface SkillHealthFinding {
  readonly id: string;
  readonly kind: SkillHealthFindingKind;
  readonly severity: SkillHealthSeverity;
  readonly skillIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly title: string;
  readonly message: string;
  readonly recommendation: string;
  readonly recommendedAction: SkillHealthRecommendedAction;
}

export interface SkillHealthSummary {
  readonly totalSkills: number;
  readonly activeSkills: number;
  readonly generatedSkills: number;
  readonly pendingCandidates: number;
  readonly duplicateClusters: number;
  readonly conflictCount: number;
  readonly staleCandidates: number;
  readonly highFailureRateSkills: number;
  readonly findings: {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
}

export interface SkillHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly staleCandidateDays: number;
  readonly summary: SkillHealthSummary;
  readonly findings: readonly SkillHealthFinding[];
}

export interface AnalyzeSkillDuplicateInput {
  readonly candidate: SkillCandidateHealthInput;
  readonly activeSkills: readonly SkillRegistryEntry[];
  readonly pendingCandidates?: readonly SkillCandidateHealthInput[];
}

export interface BuildSkillHealthReportInput {
  readonly workspaceId: string;
  readonly skills: readonly SkillRegistryEntry[];
  readonly candidates?: readonly SkillCandidateHealthInput[];
  readonly usageStats?: readonly SkillUsageStats[];
  readonly generatedAt: string;
  readonly staleCandidateDays?: number;
  readonly limit?: number;
}

const DEFAULT_STALE_CANDIDATE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function analyzeSkillDuplicate(input: AnalyzeSkillDuplicateInput): SkillDuplicateAnalysis {
  const candidateFingerprint = fingerprintCandidate(input.candidate);
  const scoredSkills = input.activeSkills.map((skill) => ({
    id: skill.id,
    score: similarity(candidateFingerprint, fingerprintSkill(skill)),
    conflictingFields: conflictingSkillFields(input.candidate, skill.definition),
  }));
  const scoredCandidates = (input.pendingCandidates ?? [])
    .filter((candidate) => candidate.id !== input.candidate.id)
    .map((candidate) => ({
      id: candidate.id,
      score: similarity(candidateFingerprint, fingerprintCandidate(candidate)),
      conflictingFields: conflictingCandidateFields(input.candidate, candidate),
    }));

  const bestSkill = maxByScore(scoredSkills);
  const bestCandidate = maxByScore(scoredCandidates);
  const bestScore = Math.max(bestSkill?.score ?? 0, bestCandidate?.score ?? 0);
  const matchedSkillIds = scoredSkills.filter((item) => item.score >= 0.65).map((item) => item.id);
  const matchedCandidateIds = scoredCandidates.filter((item) => item.score >= 0.65).map((item) => item.id);
  const conflictingFields = uniqueStrings([
    ...(bestSkill?.conflictingFields ?? []),
    ...(bestCandidate?.conflictingFields ?? []),
  ]).sort();
  const triggerOverlap = uniqueStrings(
    input.activeSkills.flatMap((skill) => overlapTokens(candidateFingerprint.triggerTokens, fingerprintSkill(skill).triggerTokens)),
  ).sort();

  if (bestScore >= 0.85) {
    return {
      decision: bestSkill && (bestSkill.score >= (bestCandidate?.score ?? 0)) ? "update_existing" : "append_evidence",
      similarityScore: roundScore(bestScore),
      matchedSkillIds,
      matchedCandidateIds,
      triggerOverlap,
      conflictingFields,
      rationale: "Candidate strongly overlaps an existing skill or pending candidate.",
    };
  }
  if (bestScore >= 0.65) {
    return {
      decision: "conflict_review",
      similarityScore: roundScore(bestScore),
      matchedSkillIds,
      matchedCandidateIds,
      triggerOverlap,
      conflictingFields,
      rationale: "Candidate partially overlaps existing skill governance and requires review before publication.",
    };
  }
  return {
    decision: "no_overlap",
    similarityScore: roundScore(bestScore),
    matchedSkillIds: [],
    matchedCandidateIds: [],
    triggerOverlap: [],
    conflictingFields: [],
    rationale: "No active skill or pending candidate crosses the duplicate review threshold.",
  };
}

export function buildSkillHealthReport(input: BuildSkillHealthReportInput): SkillHealthReport {
  const staleCandidateDays = Math.max(input.staleCandidateDays ?? DEFAULT_STALE_CANDIDATE_DAYS, 1);
  const generatedAtMs = Date.parse(input.generatedAt);
  const staleBefore = Number.isFinite(generatedAtMs) ? generatedAtMs - staleCandidateDays * MS_PER_DAY : undefined;
  const candidates = input.candidates ?? [];
  const findings: SkillHealthFinding[] = [];
  const activeSkills = input.skills.filter((skill) => isActiveRegistryEntry(skill));
  const pendingCandidates = candidates.filter((candidate) =>
    candidate.status === "pending" ||
    candidate.status === "needs_edit" ||
    candidate.status === "approved_for_draft"
  );

  for (const finding of duplicateSkillFindings(activeSkills)) {
    findings.push(finding);
  }
  for (const finding of conflictingSkillFindings(activeSkills)) {
    findings.push(finding);
  }
  for (const finding of usageHealthFindings(activeSkills, input.usageStats ?? [])) {
    findings.push(finding);
  }

  for (const candidate of pendingCandidates) {
    if (staleBefore !== undefined && Date.parse(candidate.createdAt) < staleBefore) {
      findings.push({
        id: `skill-health:stale_candidate:${candidate.id}`,
        kind: "stale_candidate",
        severity: "warning",
        skillIds: [],
        candidateIds: [candidate.id],
        title: "Stale skill candidate",
        message: `Candidate has waited more than ${staleCandidateDays} days for review.`,
        recommendation: "Approve, edit, reject, or quarantine the candidate.",
        recommendedAction: "review",
      });
    }
    if ((candidate.validationSteps ?? []).length === 0) {
      findings.push({
        id: `skill-health:missing_validation_steps:${candidate.id}`,
        kind: "missing_validation_steps",
        severity: "critical",
        skillIds: candidate.targetSkillId ? [candidate.targetSkillId] : [],
        candidateIds: [candidate.id],
        title: "Skill candidate has no validation steps",
        message: "Generated or reviewed skills must describe how a human can verify the workflow.",
        recommendation: "Add validation steps before converting this candidate into a registry draft.",
        recommendedAction: "add_validation",
      });
    }
    if (candidate.negativeTriggers.length === 0) {
      findings.push({
        id: `skill-health:missing_negative_triggers:${candidate.id}`,
        kind: "missing_negative_triggers",
        severity: "critical",
        skillIds: candidate.targetSkillId ? [candidate.targetSkillId] : [],
        candidateIds: [candidate.id],
        title: "Skill candidate has no negative triggers",
        message: "Generated or reviewed skills need false-positive boundaries before publication.",
        recommendation: "Add do-not-use cases before converting this candidate into a registry draft.",
        recommendedAction: "add_negative_triggers",
      });
    }

    const duplicate = analyzeSkillDuplicate({ candidate, activeSkills, pendingCandidates });
    if (candidate.origin === "ling-generated" && duplicate.similarityScore >= 0.65) {
      const matchedExternalSkillIds = activeSkills
        .filter((skill) => duplicate.matchedSkillIds.includes(skill.id) && isExternalRegistryEntry(skill))
        .map((skill) => skill.id);
      if (matchedExternalSkillIds.length > 0) {
        findings.push({
          id: `skill-health:external_overlap_generated_skill:${candidate.id}`,
          kind: "external_overlap_generated_skill",
          severity: "warning",
          skillIds: matchedExternalSkillIds,
          candidateIds: [candidate.id],
          title: "Generated candidate overlaps an external skill",
          message: "Ling-generated candidates should wrap or extend external skills instead of replacing them.",
          recommendation: "Review this as an overlay or wrapper candidate.",
          recommendedAction: "review",
        });
      }
    }
  }

  const sortedFindings = findings
    .sort((left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(input.limit ?? 100, 1));

  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    staleCandidateDays,
    summary: {
      totalSkills: input.skills.length,
      activeSkills: activeSkills.length,
      generatedSkills: input.skills.filter((skill) => isGeneratedRegistryEntry(skill)).length,
      pendingCandidates: pendingCandidates.length,
      duplicateClusters: findings.filter((finding) => finding.kind === "duplicate_clusters").length,
      conflictCount: findings.filter((finding) => finding.kind === "conflicting_triggers").length,
      staleCandidates: findings.filter((finding) => finding.kind === "stale_candidate").length,
      highFailureRateSkills: findings.filter((finding) => finding.kind === "high_failure_rate_skill").length,
      findings: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        info: findings.filter((finding) => finding.severity === "info").length,
      },
    },
    findings: sortedFindings,
  };
}

function duplicateSkillFindings(skills: readonly SkillRegistryEntry[]): SkillHealthFinding[] {
  const byCanonicalName = new Map<string, SkillRegistryEntry[]>();
  const byId = new Map<string, SkillRegistryEntry[]>();
  for (const skill of skills) {
    const canonicalName = normalizeText(skill.definition.name);
    if (canonicalName) {
      byCanonicalName.set(canonicalName, [...(byCanonicalName.get(canonicalName) ?? []), skill]);
    }
    byId.set(skill.id, [...(byId.get(skill.id) ?? []), skill]);
  }
  const clusterByIds = new Map<string, SkillRegistryEntry[]>();
  for (const cluster of [...byCanonicalName.values(), ...byId.values()]) {
    if (cluster.length < 2) {
      continue;
    }
    const clusterKey = uniqueStrings(cluster.map((skill) => skill.id)).sort().join("\u0000");
    clusterByIds.set(clusterKey, cluster);
  }
  const clusters = [...clusterByIds.values()];
  return clusters.map((cluster) => {
    const skillIds = uniqueStrings(cluster.map((skill) => skill.id)).sort();
    return {
      id: `skill-health:duplicate_clusters:${skillIds.join("+")}`,
      kind: "duplicate_clusters",
      severity: "warning",
      skillIds,
      candidateIds: [],
      title: "Duplicate skill cluster",
      message: "Multiple active skills share the same id or canonical name.",
      recommendation: "Keep one canonical skill and archive or merge the duplicate.",
      recommendedAction: "merge",
    };
  });
}

function conflictingSkillFindings(skills: readonly SkillRegistryEntry[]): SkillHealthFinding[] {
  const findings: SkillHealthFinding[] = [];
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex];
      const right = skills[rightIndex];
      const leftFingerprint = fingerprintSkill(left);
      const rightFingerprint = fingerprintSkill(right);
      const score = similarity(leftFingerprint, rightFingerprint);
      if (score < 0.75) {
        continue;
      }
      const conflictingFields = conflictingSkillFieldsFromDefinitions(left.definition, right.definition);
      if (conflictingFields.length === 0) {
        continue;
      }
      findings.push({
        id: `skill-health:conflicting_triggers:${[left.id, right.id].sort().join("+")}`,
        kind: "conflicting_triggers",
        severity: "warning",
        skillIds: [left.id, right.id].sort(),
        candidateIds: [],
        title: "Conflicting skill triggers",
        message: `Skills overlap in trigger language but differ on ${conflictingFields.join(", ")}.`,
        recommendation: "Clarify trigger boundaries or merge the overlapping workflow.",
        recommendedAction: "review",
      });
    }
  }
  return findings;
}

function usageHealthFindings(
  skills: readonly SkillRegistryEntry[],
  usageStats: readonly SkillUsageStats[],
): SkillHealthFinding[] {
  const statsBySkill = new Map(usageStats.map((stats) => [stats.skillId, stats]));
  const findings: SkillHealthFinding[] = [];
  for (const skill of skills) {
    const stats = statsBySkill.get(skill.id);
    if (isGeneratedRegistryEntry(skill) && (!stats || stats.useCount === 0)) {
      findings.push({
        id: `skill-health:never_used_skill:${skill.id}`,
        kind: "never_used_skill",
        severity: "info",
        skillIds: [skill.id],
        candidateIds: [],
        title: "Generated skill has no recorded usage",
        message: "This generated skill has not been selected by any run yet.",
        recommendation: "Keep it under review until it is used or archive it after human review.",
        recommendedAction: "review",
      });
    }
    if (!stats) {
      continue;
    }
    if (stats.useCount >= 3 && stats.failureCount / Math.max(stats.useCount, 1) >= 0.5) {
      findings.push({
        id: `skill-health:high_failure_rate_skill:${skill.id}`,
        kind: "high_failure_rate_skill",
        severity: "warning",
        skillIds: [skill.id],
        candidateIds: [],
        title: "Skill has a high failure rate",
        message: `Skill failed ${stats.failureCount} time(s) across ${stats.useCount} recorded use(s).`,
        recommendation: "Review the skill instructions, validation steps, and trigger boundaries.",
        recommendedAction: "review",
      });
    }
    if (stats.correctionCount >= 2) {
      findings.push({
        id: `skill-health:high_user_correction_skill:${skill.id}`,
        kind: "high_user_correction_skill",
        severity: "warning",
        skillIds: [skill.id],
        candidateIds: [],
        title: "Skill has repeated user corrections",
        message: `Skill received ${stats.correctionCount} recorded correction event(s).`,
        recommendation: "Create an update candidate with the correction evidence.",
        recommendedAction: "review",
      });
    }
  }
  return findings;
}

interface SkillFingerprint {
  readonly id: string;
  readonly title: string;
  readonly triggerTokens: readonly string[];
  readonly procedureTokens: readonly string[];
  readonly requiredTools: readonly string[];
  readonly requiredProviderCapabilities: readonly string[];
  readonly approvalMode?: string;
}

function fingerprintSkill(skill: SkillRegistryEntry): SkillFingerprint {
  const definition = skill.definition;
  return {
    id: skill.id,
    title: normalizeText(definition.name),
    triggerTokens: tokens([definition.id, definition.name, definition.summary].join(" ")),
    procedureTokens: tokens([
      definition.summary,
      definition.requiredTools.join(" "),
      definition.requiredProviderCapabilities.join(" "),
    ].join(" ")),
    requiredTools: [...definition.requiredTools].map(String).sort(),
    requiredProviderCapabilities: [...definition.requiredProviderCapabilities].map(String).sort(),
    approvalMode: definition.approvalProfile.mode,
  };
}

function fingerprintCandidate(candidate: SkillCandidateHealthInput): SkillFingerprint {
  return {
    id: candidate.id,
    title: normalizeText(candidate.title),
    triggerTokens: tokens([candidate.id, candidate.title, candidate.summary, ...candidate.positiveTriggers].join(" ")),
    procedureTokens: tokens([
      candidate.summary,
      ...(candidate.procedureSteps ?? []).flatMap((step) => [step.title, step.instruction ?? "", ...(step.requiredTools ?? [])]),
      ...(candidate.requiredTools ?? []),
      ...(candidate.requiredProviderCapabilities ?? []),
    ].join(" ")),
    requiredTools: [...(candidate.requiredTools ?? [])].map(String).sort(),
    requiredProviderCapabilities: [...(candidate.requiredProviderCapabilities ?? [])].map(String).sort(),
  };
}

function similarity(left: SkillFingerprint, right: SkillFingerprint): number {
  if (left.id === right.id || (left.title && left.title === right.title)) {
    return 1;
  }
  const triggerScore = jaccard(left.triggerTokens, right.triggerTokens);
  const procedureScore = jaccard(left.procedureTokens, right.procedureTokens);
  return Math.min(1, triggerScore * 0.55 + procedureScore * 0.45);
}

function conflictingSkillFields(candidate: SkillCandidateHealthInput, skill: SkillDefinition): readonly string[] {
  const fields: string[] = [];
  if (!sameStringSet(candidate.requiredTools ?? [], skill.requiredTools)) {
    fields.push("requiredTools");
  }
  if (!sameStringSet(candidate.requiredProviderCapabilities ?? [], skill.requiredProviderCapabilities)) {
    fields.push("requiredProviderCapabilities");
  }
  return fields;
}

function conflictingCandidateFields(left: SkillCandidateHealthInput, right: SkillCandidateHealthInput): readonly string[] {
  const fields: string[] = [];
  if (!sameStringSet(left.requiredTools ?? [], right.requiredTools ?? [])) {
    fields.push("requiredTools");
  }
  if (!sameStringSet(left.requiredProviderCapabilities ?? [], right.requiredProviderCapabilities ?? [])) {
    fields.push("requiredProviderCapabilities");
  }
  return fields;
}

function conflictingSkillFieldsFromDefinitions(left: SkillDefinition, right: SkillDefinition): readonly string[] {
  const fields: string[] = [];
  if (!sameStringSet(left.requiredTools, right.requiredTools)) {
    fields.push("requiredTools");
  }
  if (!sameStringSet(left.requiredProviderCapabilities, right.requiredProviderCapabilities)) {
    fields.push("requiredProviderCapabilities");
  }
  if (left.approvalProfile.mode !== right.approvalProfile.mode) {
    fields.push("approvalProfile");
  }
  return fields;
}

function isActiveRegistryEntry(skill: SkillRegistryEntry): boolean {
  return skill.reviewStatus === "builtin" || skill.reviewStatus === "published";
}

function isGeneratedRegistryEntry(skill: SkillRegistryEntry): boolean {
  return skill.source === "custom" && (
    skill.packId === "ling-generated" ||
    skill.sourcePath?.includes("ling-generated") === true ||
    skill.sourcePath?.startsWith("skill-candidates/") === true
  );
}

function isExternalRegistryEntry(skill: SkillRegistryEntry): boolean {
  return skill.source === "skill-directory" || skill.source === "agents-md" || skill.source === "gstack";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): readonly string[] {
  return uniqueStrings(normalizeText(value).split(" ").filter((token) => token.length > 1)).sort();
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  let intersectionCount = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersectionCount += 1;
    }
  }
  return intersectionCount / union.size;
}

function overlapTokens(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token));
}

function sameStringSet(left: readonly unknown[], right: readonly unknown[]): boolean {
  const normalizedLeft = [...new Set(left.map(String))].sort();
  const normalizedRight = [...new Set(right.map(String))].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function maxByScore<T extends { readonly score: number }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || item.score > best.score ? item : best), undefined);
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

function severityRank(severity: SkillHealthSeverity): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}
