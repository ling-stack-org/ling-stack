import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildSkillOptimizationPreview, createSqliteRunStore } from "../dist/index.js";
import { SqliteSkillRegistryStore } from "../dist/storage/sqlite/skill-registry-store.js";

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

test("failed source rollback preserves the current snapshot and unrelated skill history", async () => {
  await withStore("ling-stack-skill-rollback-atomic-", async (store, cwd) => {
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "review-old", reviewStatus: "archived" }), "2026-10-15T00:00:00.000Z");
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "review-current" }), "2026-10-15T01:00:00.000Z");
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "qa-current", skillId: "qa" }), "2026-10-15T01:00:00.000Z");
    const before = store.listSkillSourceSnapshots({ includeArchived: true });
    const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    try {
      database.exec(`CREATE TRIGGER reject_old_source_publication
        BEFORE UPDATE OF review_status ON skill_source_snapshots
        WHEN NEW.id = 'review-old' AND NEW.review_status = 'published'
        BEGIN SELECT RAISE(ABORT, 'injected source rollback failure'); END;`);
      assert.throws(() => store.rollbackSkillSourceSnapshot("review-old", "2026-10-15T02:00:00.000Z"), /injected source rollback failure/);
      assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }), before);
      database.exec("DROP TRIGGER reject_old_source_publication");
      assert.equal(store.rollbackSkillSourceSnapshot("review-old", "2026-10-15T02:00:00.000Z").id, "review-old");
      assert.deepEqual(store.getSkillSourceSnapshot("qa"), before.find(snapshot => snapshot.id === "qa-current"));
    } finally { database.close(); }
  });
});

test("rollback selects exactly one published source even when older data has multiple published snapshots", async () => {
  await withStore("ling-stack-skill-rollback-history-", async (store, cwd) => {
    const snapshots = [
      sourceSnapshotInput({ id: "review-target", reviewStatus: "archived" }),
      sourceSnapshotInput({ id: "review-a" }),
      sourceSnapshotInput({ id: "review-b" }),
    ].map(input => store.upsertSkillSourceSnapshot({ ...input,
      sourceChecksum: `sha256-${input.id}`, rawSkillMarkdown: `# ${input.id}\n`,
    }, "2026-10-15T01:00:00.000Z"));
    const rolledBack = store.rollbackSkillSourceSnapshot("review-target", "2026-10-15T02:00:00.000Z");
    assert.equal(rolledBack.id, "review-target");
    assert.deepEqual(store.listSkillSourceSnapshots({ skillId: "review", reviewStatus: "published" }).map(snapshot => snapshot.id), ["review-target"]);
    for (const snapshot of snapshots) {
      const after = store.getSkillSourceSnapshotById(snapshot.id);
      const { reviewStatus: _beforeStatus, updatedAt: _beforeUpdated, ...beforeContent } = snapshot;
      const { reviewStatus: _afterStatus, updatedAt: _afterUpdated, ...afterContent } = after;
      assert.deepEqual(afterContent, beforeContent);
    }
    const reopened = createSqliteRunStore(cwd);
    try { assert.equal(reopened.getSkillSourceSnapshot("review").id, "review-target"); }
    finally { reopened.close(); }
  });
});

test("repeating rollback to the sole active source is idempotent and missing targets do not alter history", async () => {
  await withStore("ling-stack-skill-rollback-idempotent-", async store => {
    const original = store.upsertSkillSourceSnapshot(sourceSnapshotInput(), "2026-10-15T01:00:00.000Z");
    assert.deepEqual(store.rollbackSkillSourceSnapshot(original.id, "2026-10-15T02:00:00.000Z"), original);
    assert.equal(store.rollbackSkillSourceSnapshot("missing-source", "2026-10-15T03:00:00.000Z"), undefined);
    assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }), [original]);
  });
});

test("independent readers see the previous source until rollback commits and competing writers cannot interleave", async () => {
  await withStore("ling-stack-skill-rollback-readers-", async (store, cwd) => {
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "review-old", reviewStatus: "archived" }), "2026-10-15T00:00:00.000Z");
    store.upsertSkillSourceSnapshot(sourceSnapshotInput({ id: "review-current" }), "2026-10-15T01:00:00.000Z");
    const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
    const writer = new DatabaseSync(databasePath), observer = new DatabaseSync(databasePath);
    const published = () => observer.prepare("SELECT id FROM skill_source_snapshots WHERE review_status = 'published' ORDER BY id").all().map(row => row.id);
    let observations = 0;
    try {
      observer.exec("PRAGMA busy_timeout = 0");
      writer.function("observe_source_rollback", () => {
        observations++;
        assert.deepEqual(published(), ["review-current"]);
        assert.throws(() => observer.prepare("UPDATE skill_source_snapshots SET source_checksum = 'interleaved' WHERE id = 'review-old'").run(), /locked/);
        return 1;
      });
      writer.exec(`CREATE TEMP TRIGGER observe_source_archival AFTER UPDATE OF review_status ON skill_source_snapshots
        WHEN NEW.id = 'review-current' AND NEW.review_status = 'archived'
        BEGIN SELECT observe_source_rollback(); END;`);
      const result = new SqliteSkillRegistryStore({ database: writer }).rollbackSkillSourceSnapshot("review-old", "2026-10-15T02:00:00.000Z");
      assert.equal(observations, 1);
      assert.equal(result.id, "review-old");
      assert.deepEqual(published(), ["review-old"]);
      assert.equal(store.getSkillSourceSnapshot("review").sourceChecksum, "sha256-review-1");
    } finally { observer.close(); writer.close(); }
  });
});

test("sqlite skill compiled runtime views persist and archive without runtime use", async () => {
  await withStore("ling-stack-skill-compiled-view-", async (store, cwd) => {
    const snapshot = store.upsertSkillSourceSnapshot(sourceSnapshotInput({
      id: "skill_source_review_compiled",
      rawSkillMarkdown: [
        "---",
        "name: review",
        "description: Review a code diff before landing.",
        "---",
        "# Review",
        "Find concrete issues first.",
        "",
        "# Examples",
        "Example output stays lazy.",
      ].join("\n"),
      warnings: [],
    }), "2026-07-03T00:00:00.000Z");
    const preview = buildSkillOptimizationPreview({
      snapshot,
      mode: "preview_on_demand",
      generatedAt: "2026-07-03T00:01:00.000Z",
    });
    assert.ok(preview.compiledView);

    const created = store.upsertSkillCompiledRuntimeView({
      view: preview.compiledView,
      authorityBoundary: preview.authorityBoundary,
    }, "2026-07-03T00:02:00.000Z");

    assert.equal(created.skillId, "review");
    assert.equal(created.sourceSnapshotId, snapshot.id);
    assert.equal(created.reviewStatus, "active");
    assert.equal(created.authorityBoundary.requiredToolsChanged, false);
    assert.equal(created.lazyReferences.length, 2);
    assert.deepEqual(store.listSkillCompiledRuntimeViews({ skillId: "review" }).map((view) => view.id), [created.id]);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getSkillCompiledRuntimeView(created.id).coreRulesMarkdown.includes("# Review"), true);
      const archived = reopened.archiveSkillCompiledRuntimeView(created.id, "2026-07-03T00:03:00.000Z");
      assert.equal(archived.reviewStatus, "archived");
      assert.equal(reopened.listSkillCompiledRuntimeViews({ skillId: "review" }).length, 0);
      assert.equal(reopened.listSkillCompiledRuntimeViews({ skillId: "review", includeArchived: true }).length, 1);
    } finally {
      reopened.close();
    }
  });
});
