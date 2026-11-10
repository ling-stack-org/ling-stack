import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, GSTACK_DEFAULT_UPSTREAM_VERSION } from "@ling-stack/core";
import { listEffectiveSkillRegistryEntries, listExecutableSkillDefinitions } from "../dist/features/skills/registry.js";
import { createDaemonServer } from "../dist/index.js";

const createdAt = "2026-10-14T01:00:00.000Z";
const updatedAt = "2026-10-14T02:00:00.000Z";
const checksum = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-effective-skill-registry-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const builtin = listEffectiveSkillRegistryEntries(store).find((entry) => entry.id === "review");
  assert.ok(builtin);
  return { store, builtin };
}

function publishSource(store, skillId, summary, version = "1.91.100.0", now = updatedAt, extra = {}) {
  const markdown = `---\nname: ${skillId}\ndescription: ${summary}\n---\n# Current workflow\nNever bypass approval.\n`;
  return store.upsertSkillSourceSnapshot({
    skillId, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: version,
    upstreamSkillPath: `${skillId}/SKILL.md`, rawSkillMarkdown: markdown,
    sourceChecksum: checksum(markdown), reviewStatus: "published", ...extra,
  }, now);
}

function publishDefinition(store, builtin, extra = {}) {
  const draft = store.createSkillImportDraft({
    source: "gstack", packId: "gstack-default", name: "Reviewed official bundle", version: "1.91.100.0",
    description: "Official bundle fixture", definitions: [{ definition: {
      ...builtin.definition, name: "Published review", summary: "Published definition", promptFragments: ["Published definition"],
    } }], ...extra,
  }, updatedAt);
  return store.publishSkillImportDraft(draft.id, updatedAt)[0];
}

test("fresh registry reports the actual builtin version, not a placeholder", async (t) => {
  const { builtin } = await fixture(t);
  assert.equal(builtin.version, GSTACK_DEFAULT_UPSTREAM_VERSION);
});

test("published official source metadata follows its version and preserves approved authority", async (t) => {
  const { store, builtin } = await fixture(t);
  const snapshot = publishSource(store, "review", "The current reviewed workflow.");
  const entry = listEffectiveSkillRegistryEntries(store).find((item) => item.id === "review");
  assert.equal(entry.definition.summary, "The current reviewed workflow.");
  assert.equal(entry.version, snapshot.upstreamVersion);
  assert.equal(entry.checksum, snapshot.sourceChecksum);
  for (const key of ["id", "roleAffinity", "requiredTools", "requiredProviderCapabilities", "approvalProfile", "stateEffects"]) {
    assert.deepEqual(entry.definition[key], builtin.definition[key], key);
  }
  assert.equal(listExecutableSkillDefinitions(store).find((item) => item.id === "review").summary, entry.definition.summary);
  assert.equal(store.getSkillRegistryEntry("review"), undefined, "read projection must not create persisted records");
});

test("reviewed registry definitions are not shadowed by legacy builtins", async (t) => {
  const { store, builtin } = await fixture(t);
  const published = publishDefinition(store, builtin);
  const entry = listEffectiveSkillRegistryEntries(store).find((item) => item.id === "review");
  assert.deepEqual(entry, published);
});

test("archiving a managed override does not resurrect the builtin", async (t) => {
  const { store, builtin } = await fixture(t);
  publishDefinition(store, builtin);
  store.archiveSkillRegistryEntry("review", updatedAt);
  assert.equal(listEffectiveSkillRegistryEntries(store).some((entry) => entry.id === "review"), false);
  assert.equal(listExecutableSkillDefinitions(store).some((entry) => entry.id === "review"), false);
});

test("draft sources do not become executable or replace active metadata", async (t) => {
  const { store, builtin } = await fixture(t);
  publishSource(store, "review", "Unpublished metadata.", "99.0.0", updatedAt, { reviewStatus: "draft" });
  assert.deepEqual(listEffectiveSkillRegistryEntries(store).find((item) => item.id === "review"), builtin);
});

test("rollback restores source metadata and explicit older versions rather than preferring highest version", async (t) => {
  const { store } = await fixture(t);
  const old = publishSource(store, "review", "Pinned older workflow.", "1.58.3.0", createdAt);
  store.archiveSkillSourceSnapshot("review", updatedAt);
  publishSource(store, "review", "Newer workflow.");
  store.rollbackSkillSourceSnapshot(old.id, "2026-10-14T03:00:00.000Z");
  const entry = listEffectiveSkillRegistryEntries(store).find((item) => item.id === "review");
  assert.equal(entry.version, "1.58.3.0");
  assert.equal(entry.checksum, old.sourceChecksum);
  assert.equal(entry.definition.summary, "Pinned older workflow.");
});

test("custom same-name skill metadata and visibility are not replaced by official source metadata", async (t) => {
  const { store, builtin } = await fixture(t);
  const custom = publishDefinition(store, builtin, {
    source: "custom", packId: "user-pack", definitions: [{
      definition: { ...builtin.definition, id: "custom-review", name: "review", summary: "User-edited summary." },
      visibility: { workspaceVisible: false, ownerTeammateId: "owner", promotableToWorkspace: true },
    }],
  });
  publishSource(store, "custom-review", "Not a user-approved edit.");
  const entry = listEffectiveSkillRegistryEntries(store).find((item) => item.id === "custom-review");
  assert.deepEqual(entry, custom);
  assert.ok(listEffectiveSkillRegistryEntries(store).some((item) => item.id === "review"));
});

test("the actual daemon API reports the active source revision before and after rollback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-effective-skill-http-"));
  let store;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory: (requestedCwd) => {
      assert.equal(requestedCwd, cwd);
      store ??= createSqliteRunStore(cwd);
      return store;
    },
  });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const query = `?cwd=${encodeURIComponent(cwd)}`;
    const get = async (path) => {
      const response = await fetch(`${url}${path}${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const initial = (await get("/skills")).skills.find((entry) => entry.id === "review");
    const old = publishSource(store, "review", "Original official routing.", "1.58.3.0", createdAt);
    store.archiveSkillSourceSnapshot("review", updatedAt);
    const current = publishSource(store, "review", "Current official routing.");
    const refreshed = (await get("/skills")).skills.find((entry) => entry.id === "review");
    const source = (await get("/skills/review/source")).snapshot;
    assert.equal(refreshed.definition.summary, "Current official routing.");
    assert.equal(refreshed.version, source.upstreamVersion);
    assert.equal(refreshed.checksum, source.sourceChecksum);
    assert.equal(source.id, current.id);
    assert.deepEqual(refreshed.definition.requiredTools, initial.definition.requiredTools);
    const rolledBack = await fetch(`${url}/skills/review/source/rollback${query}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshotId: old.id }),
    });
    assert.equal(rolledBack.status, 200, await rolledBack.clone().text());
    const restored = (await get("/skills")).skills.find((entry) => entry.id === "review");
    assert.equal(restored.version, old.upstreamVersion);
    assert.equal(restored.checksum, old.sourceChecksum);
    assert.equal(restored.definition.summary, "Original official routing.");
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 2);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("source publication refreshes effective metadata, preserves bindings, and survives reopen", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-source-registry-publication-"));
  const rootPath = join(cwd, "fixture-skills");
  let store;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory: (requestedCwd) => {
      assert.equal(requestedCwd, cwd);
      store ??= createSqliteRunStore(cwd);
      return store;
    },
  });
  try {
    await mkdir(join(rootPath, "gstack-review"), { recursive: true });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const query = `?cwd=${encodeURIComponent(cwd)}`;
    const post = async (path, body) => {
      const response = await fetch(`${url}${path}${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    assert.equal((await fetch(`${url}/skills${query}`)).status, 200);
    const teammate = store.listAiTeammates()[0];
    assert.ok(teammate);
    const bindings = store.replaceTeammateSkillBindings(teammate.id, [{ skillId: "review", source: "user", enabled: true }], createdAt);
    const before = listEffectiveSkillRegistryEntries(store).find((entry) => entry.id === "review");
    let request;
    let latest;
    for (const [version, description] of [["1.58.3.0", "Original fixture review."], ["1.91.100.0", "Updated fixture review."]]) {
      await writeFile(join(rootPath, "gstack-review", "SKILL.md"), `---\nname: review\ndescription: ${description}\n---\n# Review\nRead the fixture.\n`);
      request = { roots: [{ rootPath, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: version }],
        includeDetectedRoots: false, includeSkillIds: ["review"], selectedSkillIds: ["review"] };
      const published = await post("/skills/sync/gstack/publish", request);
      latest = published.snapshots[0];
      assert.equal(published.skills[0].version, version);
      assert.equal(published.skills[0].checksum, latest.sourceChecksum);
      assert.equal(published.skills[0].definition.summary, description);
      assert.deepEqual(published.skills[0].definition.requiredTools, before.definition.requiredTools);
      assert.deepEqual(published.skills[0].definition.approvalProfile, before.definition.approvalProfile);
      assert.deepEqual(store.listTeammateSkillBindings(teammate.id), bindings);
    }
    const repeated = await post("/skills/sync/gstack/publish", request);
    assert.equal(repeated.snapshots[0].id, latest.id);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 2);
    const preview = (await post("/skills/sync/gstack/preview", request)).preview.records[0];
    assert.equal(preview.state, "unchanged");
    assert.equal(preview.existingSnapshotId, latest.id);
    await daemon.stop();
    const reopened = createSqliteRunStore(cwd);
    try {
      const effective = listEffectiveSkillRegistryEntries(reopened).find((entry) => entry.id === "review");
      assert.equal(effective.version, latest.upstreamVersion);
      assert.equal(effective.checksum, latest.sourceChecksum);
      assert.equal(effective.definition.summary, "Updated fixture review.");
      assert.deepEqual(reopened.listTeammateSkillBindings(teammate.id), bindings);
    } finally { reopened.close(); }
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
