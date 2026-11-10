import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import { createSqliteRunStoreFixture } from "./support/sqlite-run-store-fixture.mjs";

test("SQLite fixture retains the fresh store schema, default seeds, WAL, and foreign keys", async (t) => {
  const fresh = await workspace(t, "fresh");
  const clone = await workspace(t, "clone");
  const original = fresh.open(createSqliteRunStore);
  const store = clone.open();

  const schema = (database) => database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
  ).all();
  assert.deepEqual(schema(store.database), schema(original.database));
  assert.deepEqual(
    store.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    original.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
  );
  assert.deepEqual(defaultSeedSnapshot(store), defaultSeedSnapshot(original));
  assert.equal(store.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(store.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => store.database.prepare(`
    INSERT INTO teammate_skill_bindings (teammate_id, skill_id, source, enabled, created_at, updated_at)
    VALUES ('missing_fixture_teammate', 'read', 'user', 1, ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString()), /FOREIGN KEY constraint failed/u);
});

test("SQLite fixtures own independent files, workspace paths, and rows", async (t) => {
  const left = await workspace(t, "left");
  const right = await workspace(t, "right");
  const first = left.open();
  const second = right.open();
  const [leftFile, rightFile] = await Promise.all([
    stat(first.paths.databasePath, { bigint: true }),
    stat(second.paths.databasePath, { bigint: true }),
  ]);
  assert.notEqual(`${leftFile.dev}:${leftFile.ino}`, `${rightFile.dev}:${rightFile.ino}`);
  assert.deepEqual(first.paths, resolveRuntimePaths(left.cwd));
  assert.deepEqual(second.paths, resolveRuntimePaths(right.cwd));
  assert.notEqual(first.paths.identity.workspaceId, second.paths.identity.workspaceId);

  const now = new Date().toISOString();
  const channelId = "channel_fixture_isolation";
  first.createChannel({ id: channelId, name: "Left", boundPath: left.cwd }, now);
  assert.equal(second.getChannel(channelId), undefined);
  second.createChannel({ id: channelId, name: "Right", boundPath: right.cwd }, now);
  first.updateChannel(channelId, { name: "Changed left" }, now);
  assert.equal(second.getChannel(channelId).name, "Right");
  assert.equal(second.getChannel(channelId).boundPath, right.cwd);

  const later = await workspace(t, "later");
  assert.equal(later.open().getChannel(channelId), undefined);
});

test("SQLite fixture refuses an existing store and preserves its database bytes and rows", async (t) => {
  const existing = await workspace(t, "existing");
  const store = existing.open(createSqliteRunStore);
  const channel = store.createChannel({ name: "Keep existing", boundPath: existing.cwd }, new Date().toISOString());
  store.close();
  const before = await readFile(store.paths.databasePath);

  assert.throws(() => createSqliteRunStoreFixture(existing.cwd), { code: "EEXIST" });
  assert.deepEqual(await readFile(store.paths.databasePath), before);
  assert.equal(existing.open(createSqliteRunStore).getChannel(channel.id).name, "Keep existing");
});

test("SQLite fixture refuses a non-database sentinel without overwriting it", async (t) => {
  const existing = await workspace(t, "sentinel");
  const paths = resolveRuntimePaths(existing.cwd);
  const bytes = Buffer.from("existing fixture sentinel\u0000\u00ff", "utf8");
  await mkdir(paths.rootDir, { recursive: true });
  await writeFile(paths.databasePath, bytes);

  assert.throws(() => createSqliteRunStoreFixture(existing.cwd), { code: "EEXIST" });
  assert.deepEqual(await readFile(paths.databasePath), bytes);
});

test("SQLite fixture refuses orphan WAL/SHM without replaying or replacing old workspace state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-sqlite-fixture-orphan-"));
  const paths = resolveRuntimePaths(cwd);
  let database;
  let unexpectedStore;
  try {
    await mkdir(paths.rootDir, { recursive: true });
    database = new DatabaseSync(paths.databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE stale_fixture (value TEXT NOT NULL);
      INSERT INTO stale_fixture VALUES ('old workspace state');
    `);
    const sidecars = ["-wal", "-shm"];
    const before = await Promise.all(sidecars.map((suffix) => readFile(`${paths.databasePath}${suffix}`)));
    for (const bytes of before) assert.ok(bytes.length > 0);

    // Preserve a real writer and its journal while the main file has disappeared.
    await rm(paths.databasePath);
    assert.throws(() => {
      unexpectedStore = createSqliteRunStoreFixture(cwd);
    }, { code: "EEXIST" });
    await assert.rejects(stat(paths.databasePath), { code: "ENOENT" });
    for (let index = 0; index < sidecars.length; index++) {
      assert.deepEqual(await readFile(`${paths.databasePath}${sidecars[index]}`), before[index]);
    }

    // Either leftover journal file independently means this is an existing workspace.
    for (let index = 0; index < sidecars.length; index++) {
      const single = resolveRuntimePaths(join(cwd, `single${sidecars[index]}`));
      await mkdir(single.rootDir, { recursive: true });
      const sidecarPath = `${single.databasePath}${sidecars[index]}`;
      await writeFile(sidecarPath, before[index]);
      assert.throws(() => {
        unexpectedStore = createSqliteRunStoreFixture(single.cwd);
      }, { code: "EEXIST" });
      await assert.rejects(stat(single.databasePath), { code: "ENOENT" });
      assert.deepEqual(await readFile(sidecarPath), before[index]);
    }
  } finally {
    unexpectedStore?.close();
    database?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SQLite fixture preserves real writes across a second connection and close/reopen", async (t) => {
  const fixture = await workspace(t, "reopen");
  const first = fixture.open();
  const second = fixture.open(createSqliteRunStore);
  const now = new Date().toISOString();
  const channel = first.createChannel({ name: "Before reopen", boundPath: fixture.cwd }, now);
  assert.equal(second.getChannel(channel.id).name, "Before reopen");
  second.updateChannel(channel.id, { name: "From second connection" }, now);
  assert.equal(first.getChannel(channel.id).name, "From second connection");
  first.close();
  second.close();

  const reopened = fixture.open(createSqliteRunStore);
  assert.equal(reopened.getChannel(channel.id).name, "From second connection");
  assert.equal(reopened.getChannel(channel.id).boundPath, fixture.cwd);
  assert.equal(reopened.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
});

test("concurrent fixture setup keeps each workspace separate and copies no recovery manifests", async (t) => {
  const fixtures = await Promise.all(Array.from({ length: 4 }, (_, index) => workspace(t, `concurrent-${index}`)));
  const stores = await Promise.all(fixtures.map(async (fixture, index) => {
    const store = fixture.open();
    const now = new Date().toISOString();
    store.createRun({ id: "run_fixture_paths", cwd: fixture.cwd, taskId: "task_fixture_paths",
      providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    store.createChannel({ id: "channel_concurrent_fixture", name: `Fixture ${index}`, boundPath: fixture.cwd }, now);
    return store;
  }));

  for (let index = 0; index < stores.length; index++) {
    const store = stores[index];
    assert.equal(store.getChannel("channel_concurrent_fixture").name, `Fixture ${index}`);
    assert.equal(store.getRun("run_fixture_paths").cwd, fixtures[index].cwd);
    assert.equal(store.paths.identity.canonicalCwd, fixtures[index].cwd);
    const recoveryFiles = await readdir(join(store.paths.rootDir, "recovery"), { recursive: true });
    assert.deepEqual(recoveryFiles.filter((name) => name.endsWith(".json")), []);
    const run = store.database.prepare("SELECT cwd, event_log_path FROM run_sessions WHERE id = ?").get("run_fixture_paths");
    assert.equal(run.cwd, fixtures[index].cwd);
    assert.ok(run.event_log_path.startsWith(store.paths.sessionsDir));
    for (let other = 0; other < fixtures.length; other++) {
      if (other !== index) assert.ok(!JSON.stringify(run).includes(fixtures[other].cwd));
    }
  }
});

/** Owns every store connection and its isolated temporary workspace until the test ends. */
async function workspace(t, label) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-sqlite-fixture-test-${label}-`));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    open(factory = createSqliteRunStoreFixture) {
      const store = factory(cwd);
      stores.push(store);
      return store;
    },
  };
}

/** Compares durable default behavior without treating creation timestamps or generated scope IDs as contracts. */
function defaultSeedSnapshot(store) {
  const stable = (value, omitId = false) => Object.fromEntries(Object.entries(value).filter(
    ([key]) => key !== "createdAt" && key !== "updatedAt" && (!omitId || key !== "id"),
  ));
  const sorted = (values) => values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const teammates = store.listAiTeammates({ includeHidden: true, includeDisabled: true });
  const councils = store.listAiCouncils({ includeArchived: true });
  return {
    workspaces: store.database.prepare("SELECT id, name, default_provider_preset_id FROM workspaces ORDER BY id").all(),
    approvalPolicy: stable(store.getApprovalPolicy()),
    teammates: sorted(teammates.map((teammate) => stable(teammate))),
    skillBindings: sorted(teammates.flatMap((teammate) => store.listTeammateSkillBindings(teammate.id).map((binding) => stable(binding)))),
    memoryScopes: sorted(teammates.flatMap((teammate) => store.listTeammateMemoryScopes(teammate.id).map((scope) => stable(scope, true)))),
    councils: sorted(councils.map((council) => stable(council))),
    councilMembers: sorted(councils.flatMap((council) => store.listAiCouncilMembers(council.id).map((member) => stable(member)))),
  };
}
