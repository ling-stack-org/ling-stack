import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeSkillDuplicate,
  buildSkillHealthReport,
} from "../dist/index.js";

const now = "2026-06-20T00:00:00.000Z";

function skill(overrides = {}) {
  const id = overrides.id ?? "skill-alpha";
  return {
    id,
    workspaceId: "workspace_default",
    packId: overrides.packId ?? "pack-default",
    source: overrides.source ?? "custom",
    sourcePath: overrides.sourcePath,
    version: overrides.version,
    checksum: overrides.checksum,
    definition: {
      id,
      name: overrides.name ?? "Skill Alpha",
      summary: overrides.summary ?? "Use this workflow to review repeated skill generation candidates.",
      roleAffinity: overrides.roleAffinity ?? ["engineer"],
      promptFragments: overrides.promptFragments ?? ["Review the candidate and summarize the duplicate risk."],
      requiredTools: overrides.requiredTools ?? ["read"],
      requiredProviderCapabilities: overrides.requiredProviderCapabilities ?? ["chat"],
      approvalProfile: overrides.approvalProfile ?? { mode: "none" },
      stateEffects: overrides.stateEffects ?? [],
    },
    visibility: overrides.visibility ?? {
      workspaceVisible: true,
      promotableToWorkspace: true,
    },
    reviewStatus: overrides.reviewStatus ?? "published",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function candidate(overrides = {}) {
  return {
    id: overrides.id ?? "candidate-alpha",
    workspaceId: "workspace_default",
    origin: overrides.origin ?? "ling-generated",
    status: overrides.status ?? "pending",
    targetSkillId: overrides.targetSkillId,
    title: overrides.title ?? "Skill Alpha",
    summary: overrides.summary ?? "Review repeated skill generation candidates and merge the duplicate evidence.",
    positiveTriggers: overrides.positiveTriggers ?? ["skill duplicate", "generated skill candidate"],
    negativeTriggers: overrides.negativeTriggers ?? ["fresh workflow with no overlap"],
    procedureSteps: overrides.procedureSteps,
    validationSteps: overrides.validationSteps ?? [{ title: "Run health report", commandOrCheck: "GET /skills/health" }],
    requiredTools: overrides.requiredTools ?? ["read"],
    requiredProviderCapabilities: overrides.requiredProviderCapabilities ?? ["chat"],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    expiresAt: overrides.expiresAt,
    supersededBy: overrides.supersededBy,
  };
}

test("skill health flags duplicate active skills and trigger conflicts", () => {
  const report = buildSkillHealthReport({
    workspaceId: "workspace_default",
    generatedAt: now,
    skills: [
      skill({ id: "skill-one", name: "重复 Skill", requiredTools: ["read"] }),
      skill({ id: "skill-two", name: "重复 Skill", requiredTools: ["bash"], approvalProfile: { mode: "standard" } }),
      skill({ id: "skill-disabled", name: "重复 Skill", reviewStatus: "disabled" }),
    ],
  });

  assert.equal(report.summary.totalSkills, 3);
  assert.equal(report.summary.activeSkills, 2);
  assert.equal(report.summary.duplicateClusters, 1);
  assert.equal(report.summary.conflictCount, 1);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "duplicate_clusters" &&
    finding.skillIds.includes("skill-one") &&
    finding.skillIds.includes("skill-two")
  ), true);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "conflicting_triggers" &&
    finding.message.includes("requiredTools")
  ), true);
});

test("skill health flags stale candidates, missing gates, and external overlap", () => {
  const stale = candidate({
    id: "candidate-stale",
    title: "Browser scrape skill",
    summary: "Use browser scrape skill when extracting structured read-only page data.",
    positiveTriggers: ["browser scrape", "read-only extraction"],
    negativeTriggers: [],
    validationSteps: [],
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  const report = buildSkillHealthReport({
    workspaceId: "workspace_default",
    generatedAt: now,
    staleCandidateDays: 30,
    skills: [
      skill({
        id: "external-scrape",
        name: "Browser scrape skill",
        summary: "Use browser scrape skill when extracting structured read-only page data.",
        source: "skill-directory",
      }),
    ],
    candidates: [stale],
  });

  assert.equal(report.summary.pendingCandidates, 1);
  assert.equal(report.summary.staleCandidates, 1);
  assert.equal(report.summary.findings.critical, 2);
  assert.equal(report.findings.some((finding) => finding.kind === "stale_candidate" && finding.candidateIds.includes(stale.id)), true);
  assert.equal(report.findings.some((finding) => finding.kind === "missing_validation_steps" && finding.candidateIds.includes(stale.id)), true);
  assert.equal(report.findings.some((finding) => finding.kind === "missing_negative_triggers" && finding.candidateIds.includes(stale.id)), true);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "external_overlap_generated_skill" &&
    finding.skillIds.includes("external-scrape")
  ), true);
});

test("duplicate analysis separates exact overlap from unrelated candidates", () => {
  const duplicate = analyzeSkillDuplicate({
    candidate: candidate({
      id: "candidate-dupe",
      title: "Skill Alpha",
      summary: "Use this workflow to review repeated skill generation candidates.",
    }),
    activeSkills: [skill({ id: "skill-alpha", name: "Skill Alpha" })],
  });
  assert.equal(duplicate.decision, "update_existing");
  assert.equal(duplicate.similarityScore, 1);
  assert.deepEqual(duplicate.matchedSkillIds, ["skill-alpha"]);

  const unrelated = analyzeSkillDuplicate({
    candidate: candidate({
      id: "candidate-unrelated",
      title: "Release canary monitor",
      summary: "Watch live deployment metrics after a release.",
      positiveTriggers: ["post deploy canary"],
    }),
    activeSkills: [skill({ id: "skill-alpha", name: "Skill Alpha" })],
  });
  assert.equal(unrelated.decision, "no_overlap");
  assert.equal(unrelated.similarityScore < 0.65, true);
});

test("skill health flags usage failures, corrections, and unused generated skills", () => {
  const report = buildSkillHealthReport({
    workspaceId: "workspace_default",
    generatedAt: now,
    skills: [
      skill({
        id: "unstable-skill",
        name: "Unstable Skill",
        source: "custom",
        packId: "ling-generated",
        sourcePath: "ling-generated/unstable-skill",
      }),
      skill({
        id: "corrected-skill",
        name: "Corrected Skill",
      }),
      skill({
        id: "unused-generated",
        name: "Unused Generated",
        source: "custom",
        packId: "ling-generated",
        sourcePath: "ling-generated/unused-generated",
      }),
    ],
    usageStats: [
      {
        skillId: "unstable-skill",
        useCount: 4,
        successCount: 1,
        failureCount: 3,
        cancelledCount: 0,
        correctionCount: 0,
        lastUsedAt: now,
        lastFailureAt: now,
      },
      {
        skillId: "corrected-skill",
        useCount: 2,
        successCount: 2,
        failureCount: 0,
        cancelledCount: 0,
        correctionCount: 2,
        lastUsedAt: now,
        lastUserCorrectionAt: now,
      },
      {
        skillId: "unused-generated",
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        cancelledCount: 0,
        correctionCount: 0,
      },
    ],
  });

  assert.equal(report.summary.highFailureRateSkills, 1);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "high_failure_rate_skill" &&
    finding.skillIds.includes("unstable-skill")
  ), true);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "high_user_correction_skill" &&
    finding.skillIds.includes("corrected-skill")
  ), true);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "never_used_skill" &&
    finding.skillIds.includes("unused-generated")
  ), true);
});
