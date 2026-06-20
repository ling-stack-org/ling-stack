import type { EffectiveTeammateSkill } from "./effective-skills.js";
import type { SkillCandidateSourceRef } from "./skill-candidate-types.js";
import type { SkillHealthFinding, SkillHealthFindingKind } from "./skill-health.js";

export type SkillInvocationSuggestionBlocker =
  | "disabled_binding"
  | "missing_tools"
  | "missing_provider_capability"
  | "channel_policy"
  | "approval_mismatch"
  | SkillHealthFindingKind;

export interface SkillInvocationSuggestion {
  readonly skillId: string;
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
  readonly blockers: readonly SkillInvocationSuggestionBlocker[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}

export interface SkillInvocationSuggestionContext {
  readonly title?: string;
  readonly prompt?: string;
  readonly requestedSkillId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
}

export interface SuggestSkillInvocationsInput {
  readonly context: SkillInvocationSuggestionContext;
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly healthFindings?: readonly SkillHealthFinding[];
  readonly limit?: number;
}

export function suggestSkillInvocations(input: SuggestSkillInvocationsInput): SkillInvocationSuggestion[] {
  const queryTokens = tokenize([input.context.title, input.context.prompt].filter(Boolean).join(" "));
  if (queryTokens.length === 0) {
    return [];
  }
  const healthFindingsBySkill = groupHealthFindingsBySkill(input.healthFindings ?? []);
  const requestedSkillId = input.context.requestedSkillId?.trim();
  const scored = input.effectiveSkills
    .filter((skill) => skill.skillId !== requestedSkillId)
    .filter((skill) => skill.executable)
    .map((skill) => {
      const score = scoreSkill(queryTokens, skill);
      const healthFindings = healthFindingsBySkill.get(skill.skillId) ?? [];
      const blockers = uniqueStrings(healthFindings.map((finding) => finding.kind)) as SkillInvocationSuggestionBlocker[];
      return { skill, score, blockers };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.skillId.localeCompare(right.skill.skillId));

  return scored.slice(0, Math.min(Math.max(input.limit ?? 5, 1), 20)).map(({ skill, score, blockers }) => ({
    skillId: skill.skillId,
    reason: suggestionReason(skill, score, blockers),
    confidence: confidenceForScore(score),
    blockers,
    sourceRefs: suggestionSourceRefs(skill.skillId, input.context),
  }));
}

function scoreSkill(queryTokens: readonly string[], skill: EffectiveTeammateSkill): number {
  const query = new Set(queryTokens);
  const skillTokens = new Set(tokenize([
    skill.skillId,
    skill.skill.name,
    skill.skill.summary,
    skill.skill.workflowPhase,
    ...skill.skill.roleAffinity,
    ...skill.promptFragments,
  ].join(" ")));
  let score = 0;
  for (const token of query) {
    if (skillTokens.has(token)) {
      score += 1;
    }
  }
  score += keywordBoost(query, skill.skillId);
  return score;
}

function keywordBoost(query: ReadonlySet<string>, skillId: string): number {
  const tokenGroups: Record<string, readonly string[]> = {
    review: ["review", "pr", "pull", "bug", "bugs", "risk", "risky", "regression", "find", "issue", "issues", "missing", "behavioral", "assumption", "assumptions", "tests"],
    implement: ["implement", "build", "code", "fix", "develop"],
    investigate: ["debug", "investigate", "root", "cause", "failure", "broken"],
    health: ["health", "typecheck", "lint", "build", "test"],
    qa: ["qa", "test", "verify", "playwright", "regression"],
    "qa-only": ["qa", "test", "verify", "report"],
    ship: ["ship", "release", "push", "merge", "pr"],
    "document-generate": ["doc", "docs", "document", "documentation"],
    "document-release": ["doc", "docs", "release", "changelog"],
    "design-review": ["design", "visual", "layout", "ui", "ux"],
    "design-html": ["design", "frontend", "ui", "implement"],
    cso: ["security", "secret", "threat", "trust", "credential"],
  };
  let boost = 0;
  for (const token of tokenGroups[skillId] ?? []) {
    if (query.has(token)) {
      boost += 2;
    }
  }
  return boost;
}

function suggestionReason(
  skill: EffectiveTeammateSkill,
  score: number,
  blockers: readonly SkillInvocationSuggestionBlocker[],
): string {
  const healthNote = blockers.length > 0 ? ` Health blockers: ${blockers.join(", ")}.` : "";
  return `Task context matches ${skill.skill.name} (${skill.skill.workflowPhase}) with score ${score}.${healthNote}`;
}

function confidenceForScore(score: number): SkillInvocationSuggestion["confidence"] {
  if (score >= 6) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

function suggestionSourceRefs(
  skillId: string,
  context: SkillInvocationSuggestionContext,
): readonly SkillCandidateSourceRef[] {
  const refs: SkillCandidateSourceRef[] = [{ type: "skill", id: skillId, label: "Suggested skill" }];
  if (context.taskId) {
    refs.push({ type: "decision", id: context.taskId, label: "Suggestion task context" });
  }
  if (context.channelId) {
    refs.push({ type: "decision", id: context.channelId, label: "Suggestion channel context" });
  }
  return refs;
}

function groupHealthFindingsBySkill(findings: readonly SkillHealthFinding[]): Map<string, SkillHealthFinding[]> {
  const result = new Map<string, SkillHealthFinding[]>();
  for (const finding of findings) {
    for (const skillId of finding.skillIds) {
      result.set(skillId, [...(result.get(skillId) ?? []), finding]);
    }
  }
  return result;
}

function tokenize(value: string): string[] {
  return uniqueStrings(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
