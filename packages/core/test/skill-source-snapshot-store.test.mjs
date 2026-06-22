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
