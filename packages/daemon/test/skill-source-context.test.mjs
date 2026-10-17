import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { prepareRunSkillSource } from "../dist/features/runs/skill-source-context.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-run-source-context-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  return store;
}

function publish(store, id, markdown, extra = {}) {
  return store.upsertSkillSourceSnapshot({ id, skillId: "review", sourceKind: "gstack-skill-directory", upstreamName: "gstack",
    rawSkillMarkdown: markdown, sourceChecksum: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
    reviewStatus: "published", ...extra }, "2026-10-15T10:00:00.000Z");
}

test("run preparation retains complete official rules and already prepared prompts remain frozen after upgrade", async t => {
  const store = await fixture(t);
  const markdown = `${"Approved rule.\n".repeat(6000)}\nFINAL APPROVAL MUST NOT BE SKIPPED\n`;
  publish(store, "review-old", markdown);
  const original = prepareRunSkillSource(store, "review", "no_operation");
  assert.equal(original.context.loadedChars, markdown.length);
  assert.equal(original.context.truncated, false);
  assert.match(original.promptFragment, /FINAL APPROVAL MUST NOT BE SKIPPED/);
  store.archiveSkillSourceSnapshot("review", "2026-10-15T11:00:00.000Z");
  publish(store, "review-new", "# New workflow\n");
  const next = prepareRunSkillSource(store, "review", "no_operation");
  assert.equal(next.context.snapshotId, "review-new");
  assert.equal(original.context.snapshotId, "review-old");
  assert.match(original.promptFragment, /FINAL APPROVAL MUST NOT BE SKIPPED/);
});

test("corrupt, incomplete and over-budget official instructions block before runner entry", async t => {
  const store = await fixture(t);
  for (const [markdown, extra] of [
    ["# Rule\n", { sourceChecksum: "sha256:corrupt" }],
    ["# Rule\n", { warnings: [{ code: "source_truncated", severity: "warning", message: "Incomplete" }] }],
    ["x".repeat(256 * 1024 + 1), {}],
  ]) {
    publish(store, "review-test", markdown, extra);
    assert.throws(() => prepareRunSkillSource(store, "review", "no_operation"), { code: "skill_source_not_ready" });
  }
});

test("native and custom skills without official snapshots keep their existing metadata-only behavior", async t => {
  const store = await fixture(t);
  for (const id of ["implement", "checkpoint", "user-custom-skill"]) {
    assert.equal(prepareRunSkillSource(store, id, "no_operation").context.runtimeViewKind, "metadata_only");
  }
});
