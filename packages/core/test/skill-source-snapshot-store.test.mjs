import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

async function withStore(prefix, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      await fn(store, cwd);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function sourceSnapshotInput(overrides = {}) {
  return {
    id: overrides.id ?? "skill_source_review",
    skillId: overrides.skillId ?? "review",
    sourceKind: overrides.sourceKind ?? "gstack-skill-directory",
    sourcePath: overrides.sourcePath ?? "skills/gstack-review/SKILL.md",
    upstreamName: overrides.upstreamName ?? "review",
    upstreamVersion: overrides.upstreamVersion ?? "1.58.3.0",
    upstreamSkillPath: overrides.upstreamSkillPath ?? ".agents/skills/gstack-review/SKILL.md",
    sourceChecksum: overrides.sourceChecksum ?? "sha256-review-1",
    rawSkillMarkdown: overrides.rawSkillMarkdown ?? "---\nname: review\n---\n# Review\n",
    agentMetadata: overrides.agentMetadata ?? {
      displayName: "Review",
      shortDescription: "Review current diff.",
      allowImplicitInvocation: false,
    },
    referencedFiles: overrides.referencedFiles ?? [{
      path: "references/checklist.md",
      kind: "reference",
      checksum: "sha256-ref",
      sizeBytes: 128,
      includedInSnapshot: false,
    }],
    warnings: overrides.warnings ?? [{
      code: "host_specific_tool",
      severity: "warning",
      message: "References a host-specific browser helper.",
      location: "SKILL.md:20",
    }],
    reviewStatus: overrides.reviewStatus ?? "published",
  };
}

test("sqlite skill source snapshots upsert, list, and survive reopening", async () => {
  await withStore("ling-stack-skill-source-snapshot-", async (store, cwd) => {
    const created = store.upsertSkillSourceSnapshot(sourceSnapshotInput(), "2026-06-22T00:00:00.000Z");

    assert.equal(created.id, "skill_source_review");
    assert.equal(created.workspaceId, "workspace_default");
    assert.equal(created.skillId, "review");
    assert.equal(created.reviewStatus, "published");
    assert.equal(created.rawSkillMarkdown.includes("# Review"), true);
    assert.equal(created.agentMetadata.displayName, "Review");
    assert.equal(created.referencedFiles[0].path, "references/checklist.md");
    assert.equal(created.warnings[0].code, "host_specific_tool");

    const updated = store.upsertSkillSourceSnapshot({
      ...sourceSnapshotInput(),
      sourceChecksum: "sha256-review-2",
      rawSkillMarkdown: "---\nname: review\n---\n# Review updated\n",
    }, "2026-06-22T00:01:00.000Z");
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-06-22T00:01:00.000Z");
    assert.equal(updated.sourceChecksum, "sha256-review-2");

    assert.equal(store.getSkillSourceSnapshot("review").sourceChecksum, "sha256-review-2");
    assert.deepEqual(store.listSkillSourceSnapshots({ sourceKind: "gstack-skill-directory" }).map((item) => item.id), ["skill_source_review"]);
    assert.deepEqual(store.listSkillSourceSnapshots({ skillId: "qa" }), []);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getSkillSourceSnapshot("review").rawSkillMarkdown.includes("updated"), true);
      assert.equal(reopened.listSkillSourceSnapshots({ reviewStatus: "published" }).length, 1);
    } finally {
      reopened.close();
    }
  });
});

test("sqlite skill source snapshots archive without deleting source evidence", async () => {
  await withStore("ling-stack-skill-source-archive-", async (store) => {
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ skillId: "qa", id: "skill_source_qa" }), "2026-06-22T00:00:00.000Z");

    const archived = store.archiveSkillSourceSnapshot("qa", "2026-06-22T00:02:00.000Z");

    assert.equal(archived.id, "skill_source_qa");
    assert.equal(archived.reviewStatus, "archived");
    assert.equal(store.getSkillSourceSnapshot("qa"), undefined);
    assert.equal(store.listSkillSourceSnapshots().length, 0);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 1);
  });
});

test("sqlite skill source lifecycle stores policy, artifacts, and rollback snapshots", async () => {
  await withStore("ling-stack-skill-source-lifecycle-", async (store) => {
    const defaultPolicy = store.getSkillSourceUpgradePolicy("2026-06-22T00:00:00.000Z");
    assert.equal(defaultPolicy.mode, "prompt");
    assert.equal(defaultPolicy.allowNewSkills, false);

    const policy = store.updateSkillSourceUpgradePolicy({
      mode: "auto-safe",
      approvedRootIds: ["root_1"],
      allowNewSkills: true,
      lastCheckedAt: "2026-06-22T00:01:00.000Z",
    }, "2026-06-22T00:01:00.000Z");
    assert.equal(policy.mode, "auto-safe");
    assert.deepEqual(policy.approvedRootIds, ["root_1"]);
    assert.equal(policy.allowGlobalGstackUpgrade, false);
    assert.equal(policy.lastCheckedAt, "2026-06-22T00:01:00.000Z");

    const first = store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "skill_source_review_v1", sourceChecksum: "sha256-review-v1" }), "2026-06-22T00:02:00.000Z");
    const artifact = store.upsertSkillSourceArtifact({
      snapshotId: first.id,
      path: "references/checklist.md",
      kind: "reference",
      checksum: "sha256-ref",
      sizeBytes: 128,
      storageRef: "skill-source/skill_source_review_v1/ref.md",
      mediaType: "text/markdown; charset=utf-8",
      reviewStatus: "published",
      includedInRuntime: true,
    }, "2026-06-22T00:02:10.000Z");
    assert.equal(artifact.workspaceId, "workspace_default");
    assert.equal(store.listSkillSourceArtifacts({ snapshotId: first.id }).length, 1);

    store.archiveSkillSourceSnapshot("review", "2026-06-22T00:03:00.000Z");
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "skill_source_review_v2", sourceChecksum: "sha256-review-v2" }), "2026-06-22T00:04:00.000Z");
    const rolledBack = store.rollbackSkillSourceSnapshot("skill_source_review_v1", "2026-06-22T00:05:00.000Z");

    assert.equal(rolledBack.skillId, "review");
    assert.equal(rolledBack.reviewStatus, "published");
    assert.equal(rolledBack.sourceChecksum, "sha256-review-v1");
    assert.equal(rolledBack.id, "skill_source_review_v1");
    assert.equal(store.listSkillSourceArtifacts({ snapshotId: rolledBack.id }).length, 1);
    assert.equal(store.getSkillSourceSnapshotById("skill_source_review_v2").reviewStatus, "archived");
  });
});
