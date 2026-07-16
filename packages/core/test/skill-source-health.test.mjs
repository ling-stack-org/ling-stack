import assert from "node:assert/strict";
import test from "node:test";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  buildSkillSourceContextFindings,
  buildSkillSourceHealthReport,
} from "../dist/index.js";

const now = "2026-07-03T00:00:00.000Z";

function registrySkill(overrides = {}) {
  const id = overrides.id ?? "skill-source-fixture";
  return {
    id,
    workspaceId: "workspace_default",
    packId: overrides.packId ?? GSTACK_DEFAULT_SKILL_PACK_ID,
    source: overrides.source ?? "gstack",
    sourcePath: overrides.sourcePath,
    version: overrides.version,
    checksum: overrides.checksum,
    definition: {
      id,
      name: overrides.name ?? "Skill Source Fixture",
      summary: overrides.summary ?? "Use this workflow to validate source-backed skill health.",
      roleAffinity: overrides.roleAffinity ?? ["engineer"],
      promptFragments: overrides.promptFragments ?? ["Review the skill source and report context risks."],
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

function snapshot(overrides = {}) {
  const skillId = overrides.skillId ?? "skill-source-fixture";
  return {
    id: overrides.id ?? `skill_source_${skillId}`,
    workspaceId: "workspace_default",
    skillId,
    sourceKind: overrides.sourceKind ?? "gstack-skill-directory",
    sourcePath: overrides.sourcePath ?? `${skillId}/SKILL.md`,
    upstreamName: overrides.upstreamName ?? "gstack",
    upstreamVersion: overrides.upstreamVersion,
    upstreamSkillPath: overrides.upstreamSkillPath ?? `${skillId}/SKILL.md`,
    sourceChecksum: overrides.sourceChecksum ?? "sha256:source",
    rawSkillMarkdown: overrides.rawSkillMarkdown ?? [
      "---",
      "name: source-fixture",
      "description: Run this skill.",
      "---",
      "# Source Fixture",
      "Use this skill.",
    ].join("\n"),
    referencedFiles: overrides.referencedFiles ?? [],
    warnings: overrides.warnings ?? [],
    reviewStatus: overrides.reviewStatus ?? "published",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

test("context health scanner flags bloat, weak routing, duplicate references, taxonomy risk, and unsafe optimization", () => {
  const findings = buildSkillSourceContextFindings({
    skillId: "context-risk",
    markdown: [
      "---",
      "name: context-risk",
      "description: Use this skill.",
      "---",
      "# Context Risk",
      "Core instruction.",
      "## Background",
      "Long background.",
      "## Examples",
      "Example output must include a destructive shell command.",
      "## Template",
      "```text",
      "template one",
      "```",
      "```text",
      "template two",
      "```",
      "```text",
      "template three",
      "```",
    ].join("\n"),
    referencedFiles: [
      { path: "references/a.md", kind: "reference", checksum: "sha256:dup", sizeBytes: 40_000, includedInSnapshot: true },
      { path: "references/b.md", kind: "reference", checksum: "sha256:dup", sizeBytes: 128, includedInSnapshot: true },
    ],
    warnings: [{
      code: "destructive_command",
      severity: "warning",
      message: "Mentions a destructive command.",
      location: "SKILL.md:10",
    }],
  });

  const kinds = new Set(findings.map((finding) => finding.kind));
  assert.equal(kinds.has("token_bloat"), true);
  assert.equal(kinds.has("missing_or_weak_routing_description"), true);
  assert.equal(kinds.has("reference_duplication"), true);
  assert.equal(kinds.has("body_taxonomy_risk"), true);
  assert.equal(kinds.has("optimization_unsafe"), true);
  assert.equal(findings.every((finding) => finding.evidence.length > 0), true);
  assert.equal(findings.every((finding) => finding.recommendation.length > 0), true);
});

test("source health preserves legacy missing snapshot finding and adds context health findings for published snapshots", () => {
  const report = buildSkillSourceHealthReport({
    workspaceId: "workspace_default",
    generatedAt: now,
    skills: [
      registrySkill({ id: "missing-source" }),
      registrySkill({ id: "weak-source" }),
    ],
    snapshots: [
      snapshot({
        skillId: "weak-source",
        rawSkillMarkdown: [
          "---",
          "name: weak-source",
          "description: Review.",
          "---",
          "# Weak Source",
          "Use this skill.",
        ].join("\n"),
      }),
    ],
  });

  assert.equal(report.summary.totalSkills, 2);
  assert.equal(report.summary.missingSourceSnapshots, 1);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "missing_source_snapshot" &&
    finding.skillId === "missing-source"
  ), true);
  assert.equal(report.findings.some((finding) =>
    finding.kind === "missing_or_weak_routing_description" &&
    finding.skillId === "weak-source" &&
    finding.recommendation
  ), true);
});
