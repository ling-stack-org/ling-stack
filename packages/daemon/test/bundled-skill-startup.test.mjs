import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { prepareBundledSkillStartup } from "../dist/features/skills/bundled-startup.js";
import { listEffectiveSkillRegistryEntries } from "../dist/features/skills/registry.js";
import { prepareRunSkillSource } from "../dist/features/runs/skill-source-context.js";
import { createDaemonServer } from "../dist/index.js";
import { updateBundledSourceMode } from "../dist/features/skills/bundled-source-mode.js";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t, deliveryStage = "executable") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-bundled-startup-")), root = join(cwd, "bundle");
  await mkdir(root);
  const bodies = new Map([["review", "---\nname: review\ndescription: Frozen review.\n---\n" + "Never bypass approval.\n".repeat(4000)],
    ["qa", "---\nname: qa\ndescription: Frozen QA.\n---\n# Complete rules\n"],
    ["new-tooling", "---\nname: new-tooling\ndescription: New upstream skill.\n---\nReview before edit or write.\n"]]);
  const files = [{ path: "LICENSE", checksum: hash("MIT\n"), sizeBytes: 4 }];
  await writeFile(join(root, "LICENSE"), "MIT\n");
  for (const [id, body] of bodies) {
    await mkdir(join(root, id)); await writeFile(join(root, id, "SKILL.md"), body);
    files.push({ path: `${id}/SKILL.md`, checksum: hash(body), sizeBytes: Buffer.byteLength(body) });
  }
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage,
    upstream: { repository: "https://github.com/garrytan/gstack", revision: "a".repeat(40), version: "1.91.101.0" },
    adaptationRevision: "ling-test-v1", target: { platform: "darwin", arch: "arm64" }, licensePath: "LICENSE",
    skills: [...bodies.keys()].map(id => ({ id, entryPath: `${id}/SKILL.md`, resourcePaths: [] })), files };
  const bytes = JSON.stringify(manifest); await writeFile(join(root, "manifest.json"), bytes);
  const selection = { rootPath: root, expectedUpstreamRevision: manifest.upstream.revision,
    expectedAdaptationRevision: manifest.adaptationRevision, expectedManifestChecksum: hash(bytes),
    expectedTarget: manifest.target, expectedSkillIds: [...bodies.keys()] };
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, root, store, bodies, selection };
}

async function nextSelection(selection) {
  const manifest = JSON.parse(await readFile(join(selection.rootPath, "manifest.json"), "utf8"));
  manifest.upstream.version = "1.91.102.0";
  manifest.upstream.revision = "b".repeat(40);
  manifest.adaptationRevision = "ling-test-v2";
  for (const skill of manifest.skills) {
    const path = join(selection.rootPath, skill.entryPath);
    const body = `${await readFile(path, "utf8")}\nNew bundled revision.\n`;
    await writeFile(path, body);
    Object.assign(manifest.files.find(file => file.path === skill.entryPath), { checksum: hash(body), sizeBytes: Buffer.byteLength(body) });
  }
  const bytes = JSON.stringify(manifest);
  await writeFile(join(selection.rootPath, "manifest.json"), bytes);
  return { ...selection, expectedUpstreamRevision: manifest.upstream.revision,
    expectedAdaptationRevision: manifest.adaptationRevision, expectedManifestChecksum: hash(bytes) };
}

test("new bundled sources follow verified upgrades; rollback pins and survives restart", async t => {
  const { cwd, store, selection } = await fixture(t);
  (await prepareBundledSkillStartup(selection))(store);
  const original = store.getSkillSourceSnapshot("review");
  assert.equal(original.bundleUpdateMode, "follow");
  const next = await nextSelection(selection);
  const initialize = await prepareBundledSkillStartup(next);
  initialize(store); initialize(store);
  assert.equal(store.getSkillSourceSnapshot("review").upstreamVersion, "1.91.102.0");
  assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 6);
  const rolledBack = store.rollbackSkillSourceSnapshot(original.id, "2026-10-16T04:00:00Z");
  assert.equal(rolledBack.bundleUpdateMode, "pinned");
  const reopened = createSqliteRunStore(cwd);
  try {
    initialize(reopened);
    assert.equal(reopened.getSkillSourceSnapshot("review").id, original.id);
    assert.equal(reopened.getSkillSourceSnapshot("review").bundleUpdateMode, "pinned");
    assert.equal(reopened.getSkillSourceSnapshot("qa").upstreamVersion, "1.91.102.0");
  } finally { reopened.close(); }
});

test("bundled follow preserves independent drafts and never downgrades a newer source", async t => {
  const { cwd, store, selection } = await fixture(t);
  const old = await prepareBundledSkillStartup(selection);
  old(store);
  const review = store.getSkillSourceSnapshot("review");
  const draft = store.upsertSkillSourceSnapshot({ ...review, id: "user-draft", rawSkillMarkdown: "User edit\n", reviewStatus: "draft" }, "2026-10-16T03:00:00Z");
  const next = await nextSelection(selection);
  (await prepareBundledSkillStartup(next))(store);
  assert.equal(store.getSkillSourceSnapshot("review").id, review.id);
  assert.equal(store.getSkillSourceSnapshot("qa").upstreamVersion, "1.91.102.0");
  old(store);
  assert.equal(store.getSkillSourceSnapshot("qa").upstreamVersion, "1.91.102.0");
  const reopened = createSqliteRunStore(cwd);
  try {
    (await prepareBundledSkillStartup(next))(reopened);
    assert.deepEqual(reopened.getSkillSourceSnapshotById(draft.id), draft);
  } finally { reopened.close(); }
});

test("a transaction-time source selection race returns a conflict without losing history", async t => {
  const { cwd, store, selection } = await fixture(t);
  (await prepareBundledSkillStartup(selection))(store);
  const stale = store.getSkillSourceSnapshot("qa"), competing = createSqliteRunStore(cwd);
  t.after(() => competing.close());
  updateBundledSourceMode(competing, stale, { bundleUpdateMode: "pinned", expectedSnapshotId: stale.id,
    expectedSourceChecksum: stale.sourceChecksum }, "2026-10-16T03:00:00Z");
  assert.throws(() => updateBundledSourceMode(store, stale, { bundleUpdateMode: "follow",
    expectedSnapshotId: stale.id, expectedSourceChecksum: stale.sourceChecksum }, "2026-10-16T04:00:00Z"),
  { statusCode: 409, code: "skill_source_publication_conflict" });
  assert.equal(store.getSkillSourceSnapshot("qa").bundleUpdateMode, "pinned");
});

test("a concurrent pin fences the entire bundled upgrade before publication", async t => {
  const { store, selection } = await fixture(t);
  (await prepareBundledSkillStartup(selection))(store);
  const before = store.listSkillSourceSnapshots({ includeArchived: true });
  const initialize = await prepareBundledSkillStartup(await nextSelection(selection));
  const publish = store.publishSkillSourceBatch.bind(store);
  t.mock.method(store, "publishSkillSourceBatch", (input, now) => {
    const qa = store.getSkillSourceSnapshot("qa");
    store.upsertSkillSourceSnapshot({ ...qa, bundleUpdateMode: "pinned" }, now);
    return publish(input, now);
  });
  assert.throws(() => initialize(store), { code: "skill_source_publication_conflict" });
  assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }).map(s => s.id).sort(), before.map(s => s.id).sort());
  assert.equal(store.getSkillSourceSnapshot("review").upstreamVersion, "1.91.101.0");
  assert.equal(store.getSkillSourceSnapshot("qa").bundleUpdateMode, "pinned");
});

test("the source API explicitly pins and resumes following with stale-selection protection", async t => {
  const { cwd, selection } = await fixture(t);
  const initializeBundledSkills = await prepareBundledSkillStartup(selection);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { initializeBundledSkills });
  await daemon.start();
  try {
    const url = `http://127.0.0.1:${daemon.server.address().port}/skills/qa/source?cwd=${encodeURIComponent(cwd)}`;
    const current = (await (await fetch(url)).json()).snapshot;
    const change = (snapshot, bundleUpdateMode) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleUpdateMode, expectedSnapshotId: snapshot.id, expectedSourceChecksum: snapshot.sourceChecksum }) });
    const pin = await change(current, "pinned");
    assert.equal(pin.status, 200);
    const pinned = (await pin.json()).snapshot;
    assert.equal(pinned.bundleUpdateMode, "pinned");
    assert.equal((await change(current, "follow")).status, 409);
    const follow = await change(pinned, "follow");
    assert.equal(follow.status, 200);
    assert.equal((await follow.json()).snapshot.bundleUpdateMode, "follow");
    assert.equal((await change(pinned, "invalid")).status, 400);
  } finally {
    await daemon.stop();
  }
});

test("verified executable package initializes full sources atomically and restart does not add history", async t => {
  const { store, bodies, selection } = await fixture(t);
  const initialize = await prepareBundledSkillStartup(selection);
  initialize(store); initialize(store);
  assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 3);
  for (const [id, body] of bodies) {
    const entry = listEffectiveSkillRegistryEntries(store).find(s => s.id === id);
    assert.equal(entry.version, "1.91.101.0");
    assert.equal(entry.checksum, hash(body));
    const loaded = prepareRunSkillSource(store, id, "no_operation");
    assert.equal(loaded.context.loadedChars, body.length);
    assert.equal(loaded.context.truncated, false);
  }
  const upstreamOnly = store.getSkillRegistryEntry("new-tooling");
  assert.equal(upstreamOnly.definition.approvalProfile.mode, "strict");
  assert.deepEqual(upstreamOnly.definition.approvalProfile.requiredForTools, ["bash", "edit", "write"]);
});

test("source-only and equal-size altered package resources reject before any store change", async t => {
  const source = await fixture(t, "source");
  await assert.rejects(prepareBundledSkillStartup(source.selection), /bundle_not_executable/);
  assert.equal(source.store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
  const executable = await fixture(t);
  const path = join(executable.root, "qa/SKILL.md"), body = await readFile(path);
  await writeFile(path, Buffer.alloc(body.length));
  await assert.rejects(prepareBundledSkillStartup(executable.selection), /checksum_mismatch/);
  assert.equal(executable.store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
});

test("boot preserves an explicitly published version, rollback history and archived user choices", async t => {
  const { store, selection } = await fixture(t);
  const initialize = await prepareBundledSkillStartup(selection);
  const pinned = store.upsertSkillSourceSnapshot({ skillId: "review", sourceKind: "gstack-skill-directory",
    upstreamName: "gstack", upstreamVersion: "1.58.3.0", sourceChecksum: hash("Pinned\n"),
    rawSkillMarkdown: "Pinned\n", reviewStatus: "published" }, "2026-10-15T00:00:00Z");
  initialize(store);
  assert.equal(store.listSkillSourceSnapshots({ skillId: "review", reviewStatus: "published" })[0].id, pinned.id);
  store.archiveSkillRegistryEntry("qa", "2026-10-15T01:00:00Z");
  store.archiveSkillSourceSnapshot("qa", "2026-10-15T01:00:00Z");
  initialize(store);
  assert.equal(store.getSkillRegistryEntry("qa").reviewStatus, "archived");
  assert.equal(store.listSkillSourceSnapshots({ skillId: "qa", reviewStatus: "published" }).length, 0);
});

test("same-ID custom ownership rejects the whole install without partially adding another source", async t => {
  const { store, selection } = await fixture(t);
  const existing = listEffectiveSkillRegistryEntries(store).find(s => s.id === "qa");
  const draft = store.createSkillImportDraft({ source: "custom", packId: "user", name: "User", description: "User",
    definitions: [{ definition: existing.definition }] }, "2026-10-15T00:00:00Z");
  store.publishSkillImportDraft(draft.id, "2026-10-15T00:00:00Z");
  const initialize = await prepareBundledSkillStartup(selection);
  assert.throws(() => initialize(store), /bundled_skill_identity_collision/);
  assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
  assert.equal(store.getSkillRegistryEntry("qa").source, "custom");
});

test("startup rechecks absence of all history inside the publication transaction", async t => {
  for (const reviewStatus of ["draft", "archived"]) await t.test(reviewStatus, async t => {
    const { cwd, store, selection } = await fixture(t);
    const initialize = await prepareBundledSkillStartup(selection);
    const competing = createSqliteRunStore(cwd);
    t.after(() => competing.close());
    const publish = store.publishSkillSourceBatch.bind(store);
    let inserted;
    t.mock.method(store, "publishSkillSourceBatch", (input, now) => {
      // A separate connection commits between startup's read and BEGIN IMMEDIATE.
      inserted = competing.upsertSkillSourceSnapshot({ skillId: "qa", sourceKind: "gstack-skill-directory",
        upstreamName: "gstack", upstreamVersion: "user-version", sourceChecksum: hash("User choice\n"),
        rawSkillMarkdown: "User choice\n", reviewStatus }, "2026-10-15T00:00:00Z");
      return publish(input, now);
    });
    assert.throws(() => initialize(store), { code: "skill_source_publication_conflict" });
    assert.equal(store.getSkillRegistryEntry("review"), undefined);
    assert.equal(store.getSkillRegistryEntry("qa"), undefined);
    assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }).map(s => s.id), [inserted.id]);
    assert.equal(store.getSkillSourceSnapshotById(inserted.id).reviewStatus, reviewStatus);
  });
});

test("the actual daemon initializes before exposing skill HTTP reads, not in a background warmup", async t => {
  const { cwd, selection } = await fixture(t);
  const initializeBundledSkills = await prepareBundledSkillStartup(selection);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { initializeBundledSkills });
  await daemon.start();
  try {
    const url = `http://127.0.0.1:${daemon.server.address().port}/skills?cwd=${encodeURIComponent(cwd)}`;
    const response = await fetch(url); assert.equal(response.status, 200);
    const { skills } = await response.json();
    for (const id of ["review", "qa"]) assert.equal(skills.find(s => s.id === id).version, "1.91.101.0");
  } finally {
    await daemon.stop();
  }
});
