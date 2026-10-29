import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, previewGstackSkillSourceSync } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { listEffectiveSkillRegistryEntries } from "../dist/features/skills/registry.js";
import { prepareSkillSourcePublication } from "../dist/features/skills/source-publication.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-source-publication-api-"));
  const rootPath = join(cwd, "fixture-skills");
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(join(cwd, ".ling-stack/ling-stack.sqlite"));
  const roots = [{ rootPath, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.91.101.0" }];
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
  t.after(async () => { await daemon.stop(); database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  for (const id of ["qa", "review"]) {
    const directory = join(rootPath, `gstack-${id}`);
    await mkdir(join(directory, "references"), { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${id}\ndescription: ${id} workflow.\n---\n# Workflow\nRead the fixture.\n`);
    await writeFile(join(directory, "references/checklist.md"), `# ${id} reference\n`);
  }
  const preview = () => previewGstackSkillSourceSync({ roots, registrySkills: listEffectiveSkillRegistryEntries(store),
    snapshots: store.listSkillSourceSnapshots({ includeArchived: true }), includeSkillIds: ["qa", "review"] });
  const staged = async () => readdir(join(store.paths.artifactsDir, "skill-source")).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  return { cwd, rootPath, store, database, roots, daemon, preview, staged };
}

test("real publication API rolls back the entire batch on failure and converges concurrent retries", async t => {
  const f = await fixture(t);
  await f.daemon.start();
  const address = f.daemon.server.address();
  const url = `http://127.0.0.1:${address.port}/skills/sync/gstack/publish?cwd=${encodeURIComponent(f.cwd)}`;
  const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roots: f.roots, includeDetectedRoots: false, includeSkillIds: ["qa", "review"],
      selectedSkillIds: ["qa", "review"], publishArtifacts: true }) });
  f.database.exec(`CREATE TRIGGER reject_last_skill BEFORE INSERT ON skill_source_snapshots
    WHEN NEW.skill_id = 'review' BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
  const failed = await post();
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /injected publication failure/);
  assert.equal(f.store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
  assert.equal(f.store.listSkillSourceArtifacts({ includeArchived: true }).length, 0);
  assert.deepEqual(await f.staged(), []);
  f.database.exec("DROP TRIGGER reject_last_skill");
  const requests = [post(), post()];
  const first = await requests[0], second = await requests[1];
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(second.status, 200, await second.clone().text());
  const a = await first.json(), b = await second.json();
  assert.deepEqual(a.snapshots, b.snapshots);
  assert.equal(a.snapshots.length, 2);
  assert.equal(f.store.listSkillSourceSnapshots({ includeArchived: true }).length, 2);
  assert.equal(f.store.listSkillSourceArtifacts({ includeArchived: true }).length, 4);
  assert.deepEqual((await f.staged()).sort(), a.snapshots.map(s => s.id).sort());
  const retry = await post();
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual((await retry.json()).snapshots, a.snapshots);
  assert.equal((await f.staged()).length, 2);
});

test("changed resource bytes fail preparation without publishing or leaving private staging", async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  await writeFile(join(f.rootPath, "gstack-review/references/checklist.md"), "Changed bytes\n");
  await assert.rejects(prepareSkillSourcePublication(f.store, preview.records, true), error =>
    ["skill_source_artifact_budget_or_size", "skill_source_artifact_changed"].includes(error.code));
  assert.deepEqual(await f.staged(), []);
  assert.equal(f.store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
});

test("symlink substitution and truncated snapshots cannot enter the published source store", async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  const reference = join(f.rootPath, "gstack-review/references/checklist.md");
  await writeFile(join(f.cwd, "external.md"), "External\n");
  await rm(reference);
  await symlink(join(f.cwd, "external.md"), reference);
  await assert.rejects(prepareSkillSourcePublication(f.store, preview.records, true), { code: "skill_source_artifact_source_escape" });
  assert.deepEqual(await f.staged(), []);
  const truncated = structuredClone(preview.records);
  truncated[0].snapshotPreview.rawSkillMarkdown = "partial source";
  await assert.rejects(prepareSkillSourcePublication(f.store, truncated, false), { code: "skill_source_incomplete" });
  assert.equal(f.store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
});

test("publishing without artifacts still verifies source bytes and rejects changed resources before commit", async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  await writeFile(join(f.rootPath, "gstack-review/references/checklist.md"), "# altered reference\n");
  await assert.rejects(prepareSkillSourcePublication(f.store, preview.records, false), error =>
    ["skill_source_artifact_budget_or_size", "skill_source_artifact_changed"].includes(error.code));
  assert.deepEqual(await f.staged(), []);
  assert.deepEqual(f.store.listSkillSourceSnapshots({ includeArchived: true }), []);
});

test("successful preparation does not activate source rows until explicit atomic publication", async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  const prepared = await prepareSkillSourcePublication(f.store, preview.records, true);
  try {
    assert.equal(f.store.listSkillSourceSnapshots().length, 0);
    assert.equal(f.store.listSkillSourceArtifacts().length, 0);
    for (const record of prepared.records) {
      assert.equal(record.snapshot.sourceChecksum,
        `sha256:${createHash("sha256").update(record.snapshot.rawSkillMarkdown).digest("hex")}`);
    }
  } finally { await prepared.cleanup(); }
  assert.deepEqual(await f.staged(), []);
});
