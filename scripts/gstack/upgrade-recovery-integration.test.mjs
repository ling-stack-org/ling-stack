import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSqliteRunStore } from "../../packages/core/dist/index.js";
import { prepareBundledSkillStartup } from "../../packages/daemon/dist/features/skills/bundled-startup.js";
import { updateBundledSourceMode } from "../../packages/daemon/dist/features/skills/bundled-source-mode.js";
import { prepareRunSkillSource } from "../../packages/daemon/dist/features/runs/skill-source-context.js";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function generation(work, version, bodies) {
  const rootPath = join(work, `fixture-${version}`), files = [], skills = [];
  const emit = async (path, body) => {
    await mkdir(dirname(join(rootPath, path)), { recursive: true }); await writeFile(join(rootPath, path), body);
    files.push({ path, sizeBytes: Buffer.byteLength(body), checksum: digest(body) });
  };
  await emit("LICENSE", "MIT\n"); await emit("runtime/generation.txt", `${version}`);
  for (const [id, body] of bodies) {
    const entryPath = `runtime/${id}/SKILL.md`;
    await emit(entryPath, version === 1 ? body : `${body}\nSynthetic migration revision 2.\n`);
    skills.push({ id, entryPath, resourcePaths: [] });
  }
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: `${version}`.repeat(40), version: `1.0.${version}.0` },
    adaptationRevision: `ling-migration-fixture-${version}`, target: { platform: "darwin", arch: "arm64" }, licensePath: "LICENSE", files, skills };
  const bytes = JSON.stringify(manifest); await writeFile(join(rootPath, "manifest.json"), bytes);
  const selection = { rootPath, expectedUpstreamRevision: manifest.upstream.revision, expectedAdaptationRevision: manifest.adaptationRevision,
    expectedManifestChecksum: digest(bytes), expectedTarget: manifest.target, expectedSkillIds: skills.map(skill => skill.id) };
  const path = join(work, `selection-${version}.json`); await writeFile(path, JSON.stringify(selection));
  return { path, selection };
}

test("real daemon restarts preserve frozen retry resources; missing old generations never dispatch", { timeout: 60000 }, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-upgrade-restart-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const old = await generation(work, 1, [["qa", "---\nname: qa\ndescription: Fixture QA\n---\n# qa 1\n"]]);
  const next = await generation(work, 2, [["qa", "---\nname: qa\ndescription: Fixture QA\n---\n# qa 2\n"]]);
  const phases = [];
  for (const phase of ["initial", "missing", "restored"]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("upgrade-recovery-probe.mjs", import.meta.url)), work,
      phase === "initial" ? old.path : next.path, phase], { env: { ...process.env, LING_STACK_HOME: join(work, "config") },
      encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 ** 2 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    phases.push(JSON.parse(run.stdout.trim().split("\n").at(-1)));
    if (phase === "initial") await rm(old.selection.rootPath, { recursive: true });
  }
  assert.equal(phases[1].calls.length, 0);
  assert.deepEqual(phases[2].calls.map(call => call.generation), ["1", "2", "1"]);
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/upgrade-recovery-proof.json"),
    JSON.stringify({ phases, releaseEligible: false, scope: "synthetic-resource-generations-real-daemon-no-package" }, null, 2));
});

test("all 57 frozen real bodies retain follow, pin, rollback and reopen semantics without a full resource copy", {
  skip: !process.env.LING_GSTACK_RESOURCE_STAGE && "requires frozen body source", timeout: 60000,
}, async t => {
  const sourceRoot = join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/native/executable-client/gstack");
  const manifestBytes = await readFile(join(sourceRoot, "manifest.json"));
  assert.equal(digest(manifestBytes), "sha256:bf6c489f3629107fbfba09dae571a04b7e867e635a6e73c1eb065e0940dc81db");
  const manifest = JSON.parse(manifestBytes), bodies = [];
  for (const skill of manifest.skills) {
    const bytes = await readFile(join(sourceRoot, skill.entryPath));
    assert.equal(digest(bytes), manifest.files.find(file => file.path === skill.entryPath).checksum);
    bodies.push([skill.id, bytes.toString("utf8")]);
  }
  assert.equal(bodies.length, 57);
  const work = await mkdtemp(join(tmpdir(), "ling-57-migration-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const old = await generation(work, 1, bodies), next = await generation(work, 2, bodies);
  let store = createSqliteRunStore(work);
  t.after(() => store.close());
  const before = await prepareBundledSkillStartup(old.selection), after = await prepareBundledSkillStartup(next.selection);
  before(store);
  const originals = store.listSkillSourceSnapshots({ reviewStatus: "published" });
  after(store); after(store);
  for (const snapshot of originals) {
    assert.equal(store.getSkillSourceSnapshot(snapshot.skillId).upstreamVersion, "1.0.2.0");
    assert.equal(store.rollbackSkillSourceSnapshot(snapshot.id, new Date().toISOString()).bundleUpdateMode, "pinned");
  }
  store.close(); store = createSqliteRunStore(work); after(store);
  for (const [id, body] of bodies) {
    const pinned = store.getSkillSourceSnapshot(id);
    assert.equal(pinned.bundleUpdateMode, "pinned"); assert.equal(pinned.rawSkillMarkdown, body);
    const context = prepareRunSkillSource(store, id, "no_operation").context;
    assert.equal(context.loadedChars, body.length); assert.equal(context.truncated, false);
    updateBundledSourceMode(store, pinned, { bundleUpdateMode: "follow", expectedSnapshotId: pinned.id,
      expectedSourceChecksum: pinned.sourceChecksum }, new Date().toISOString());
  }
  after(store);
  assert.ok(store.listSkillSourceSnapshots({ reviewStatus: "published" }).every(snapshot => snapshot.upstreamVersion === "1.0.2.0"));
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/all57-migration-proof.json"), JSON.stringify({
    sourceManifestChecksum: digest(manifestBytes), rows: bodies.map(([id]) => ({ id, follow: true, rollbackPin: true,
      reopen: true, fullBody: true, explicitFollow: true, installedWorkflow: "pending" })), releaseEligible: false,
    scope: "real-frozen-bodies-synthetic-two-version-sqlite-migration-not-57-workflow-execution" }, null, 2));
});

test("one disposable complete resource copy restores all57 in a fresh child after a tiny synthetic successor", {
  skip: !process.env.LING_GSTACK_EXECUTABLE_BUNDLE && "requires authenticated full resource candidate",
  timeout: 480000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-real-retained-restart-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const next = await generation(work, 2, [["qa", "---\nname: qa\ndescription: Synthetic successor\n---\n# qa 2\n"]]);
  const phases = [];
  for (const phase of ["retain-real", "reopen"]) {
    const env = { ...process.env };
    if (phase === "reopen") {
      delete env.LING_GSTACK_EXECUTABLE_BUNDLE; delete env.LING_GSTACK_BROWSER_ROOT;
      delete env.LING_GSTACK_RESOURCE_STAGE;
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("retained-resource-probe.mjs", import.meta.url)),
      work, phase, next.path], { env, encoding: "utf8", timeout: 240000, maxBuffer: 1024 ** 2 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    phases.push(JSON.parse(result.stdout.trim().split("\n").at(-1)));
  }
  assert.equal(phases[0].bound, 57); assert.equal(phases[1].restored.length, 57);
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/real-retained-resource-proof.json"),
    JSON.stringify({ phases, releaseEligible: false, scope: "real-resource-cache-restart-not-app-replacement-or-installed-workflows",
      copies: "one-owned-disposable-A-plus-tiny-synthetic-B", powerLossDurability: "not-claimed" }, null, 2));
});
