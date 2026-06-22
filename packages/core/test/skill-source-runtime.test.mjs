import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillSourceRuntimePrompt } from "../dist/index.js";

function snapshot(overrides = {}) {
  return {
    id: overrides.id ?? "skill_source_review",
    workspaceId: "workspace_default",
    skillId: overrides.skillId ?? "review",
    sourceKind: "gstack-skill-directory",
    sourcePath: "skills/gstack-review/SKILL.md",
    upstreamName: "gstack",
    upstreamVersion: "1.58.3.0",
    upstreamSkillPath: "gstack-review/SKILL.md",
    sourceChecksum: "sha256:review",
    rawSkillMarkdown: overrides.rawSkillMarkdown ?? "---\nname: review\n---\n# Review\nUse the review flow.",
    agentMetadata: {
      displayName: "gstack-review",
      defaultPrompt: "Use gstack-review for this task.",
      allowImplicitInvocation: true,
    },
    referencedFiles: [{
      path: "references/checklist.md",
      kind: "reference",
      checksum: "sha256:checklist",
      sizeBytes: 32,
      includedInSnapshot: false,
    }],
    warnings: overrides.warnings ?? [{
      code: "host_specific_tool",
      severity: "info",
      message: "References host-specific behavior.",
      location: "SKILL.md:10",
    }],
    reviewStatus: "published",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

test("skill source runtime prompt renders source text, metadata, inventory, and policy boundary", () => {
  const result = buildSkillSourceRuntimePrompt({ snapshot: snapshot() });

  assert.equal(result.context.loaded, true);
  assert.equal(result.context.snapshotId, "skill_source_review");
  assert.equal(result.context.truncated, false);
  assert.equal(result.context.warningSeverities[0], "info");
  assert.match(result.promptFragment, /Selected Skill Source Snapshot/);
  assert.match(result.promptFragment, /does not grant tools/);
  assert.match(result.promptFragment, /# Review/);
  assert.match(result.promptFragment, /Display name: gstack-review/);
  assert.match(result.promptFragment, /references\/checklist.md/);
});

test("skill source runtime prompt records truncation evidence", () => {
  const result = buildSkillSourceRuntimePrompt({
    snapshot: snapshot({ rawSkillMarkdown: "x".repeat(120) }),
    maxLoadedChars: 40,
  });

  assert.equal(result.context.loaded, true);
  assert.equal(result.context.sourceLengthChars, 120);
  assert.equal(result.context.loadedChars, 40);
  assert.equal(result.context.truncated, true);
  assert.match(result.promptFragment, /truncated for this run/);
});

test("skill source runtime prompt suppresses source text when error warnings exist", () => {
  const result = buildSkillSourceRuntimePrompt({
    snapshot: snapshot({
      warnings: [{
        code: "secret_reference",
        severity: "error",
        message: "Possible raw secret-like value appears in SKILL.md.",
      }],
    }),
  });

  assert.equal(result.context.loaded, false);
  assert.equal(result.context.blockedReason, "source_snapshot_has_error_warnings");
  assert.equal(result.promptFragment, undefined);
});
