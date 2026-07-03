import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillOptimizationPreview } from "../dist/index.js";

const snapshot = {
  id: "skill_source_preview",
  workspaceId: "workspace_default",
  skillId: "preview-skill",
  sourceKind: "gstack-skill-directory",
  sourcePath: "preview-skill/SKILL.md",
  upstreamName: "gstack",
  upstreamSkillPath: "preview-skill/SKILL.md",
  sourceChecksum: "sha256:preview",
  rawSkillMarkdown: [
    "---",
    "name: preview-skill",
    "description: Use this skill.",
    "---",
    "# Preview Skill",
    "Follow the core workflow.",
    "## Background",
    "Background material that should not be loaded by default.",
    "## Examples",
    "Example output must include a final verification note.",
  ].join("\n"),
  referencedFiles: [
    { path: "references/checklist.md", kind: "reference", checksum: "sha256:checklist", sizeBytes: 400, includedInSnapshot: true },
    { path: "scripts/run.sh", kind: "script", checksum: "sha256:script", sizeBytes: 120, includedInSnapshot: false },
  ],
  warnings: [],
  reviewStatus: "published",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

test("optimization preview no_operation reports without compiling a runtime view", () => {
  const preview = buildSkillOptimizationPreview({
    snapshot,
    mode: "no_operation",
    generatedAt: "2026-07-03T00:00:00.000Z",
  });

  assert.equal(preview.mode, "no_operation");
  assert.equal(preview.status, "not_run");
  assert.equal(preview.compiledView, undefined);
  assert.equal(preview.compiledTokenEstimate, preview.originalTokenEstimate);
  assert.equal(preview.authorityBoundary.requiredToolsChanged, false);
  assert.equal(preview.authorityBoundary.approvalProfileChanged, false);
});

test("optimization preview builds core rules plus lazy references for manual review", () => {
  const preview = buildSkillOptimizationPreview({
    snapshot,
    mode: "preview_on_demand",
    generatedAt: "2026-07-03T00:00:00.000Z",
  });

  assert.equal(preview.mode, "preview_on_demand");
  assert.notEqual(preview.status, "not_run");
  assert.ok(preview.compiledView);
  assert.equal(preview.compiledView.coreRulesMarkdown.includes("Follow the core workflow."), true);
  assert.equal(preview.compiledView.coreRulesMarkdown.includes("Background material"), false);
  assert.equal(preview.compiledView.lazyReferences.some((reference) => reference.kind === "background"), true);
  assert.equal(preview.compiledView.lazyReferences.some((reference) => reference.kind === "example"), true);
  assert.equal(preview.compiledView.lazyReferences.some((reference) => reference.kind === "script_note" && reference.loadPolicy === "never_auto"), true);
  assert.equal(preview.risks.some((risk) => risk.kind === "context_health"), true);
  assert.equal(preview.routingDescription?.suggested?.includes("preview-skill"), true);
});
