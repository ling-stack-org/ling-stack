import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../../core/dist/index.js";
import { readOriginalOfficeDirectoryNativeRuntime } from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";

function databaseSnapshot(databasePath: string, normalizeSeedMetadata = false) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
    const tables = schema.filter(row => row.type === "table").map(row => String(row.name));
    const contents = Object.fromEntries(tables.map(table => {
      const rows = database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
      return [table, rows.map(row => {
        if (normalizeSeedMetadata && table === "teammate_memory_scopes") {
          assert.match(String(row.id), /^memory_scope_[0-9a-f-]+$/u);
          row.id = "generated-memory-scope-id";
        }
        return Object.fromEntries(Object.entries(row).filter(([key]) =>
          !normalizeSeedMetadata || !["created_at", "updated_at", "applied_at"].includes(key)));
      })];
    }));
    return { schema, contents };
  } finally {
    database.close();
  }
}

function assertSnapshotsEqual(actual: ReturnType<typeof databaseSnapshot>, expected: ReturnType<typeof databaseSnapshot>) {
  assert.deepEqual(actual.schema.map(row => row.name), expected.schema.map(row => row.name));
  actual.schema.forEach((row, index) => assert.deepEqual(row, expected.schema[index], String(row.name)));
  for (const [table, rows] of Object.entries(actual.contents)) {
    assert.deepEqual(rows, expected.contents[table], table);
  }
}

test("workspace copies share only a closed template with the current cold schema and defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-stack-template-schema-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coldCwd = await mkdtemp(join(root, "cold-"));
  const cold = createSqliteRunStore(coldCwd);
  const coldDatabasePath = cold.paths.databasePath;
  cold.close();
  const [first, second] = await Promise.all([
    createSqliteWorkspaceFixture(join(root, "first-")),
    createSqliteWorkspaceFixture(join(root, "second-")),
  ]);
  const firstPaths = resolveRuntimePaths(first);
  const secondPaths = resolveRuntimePaths(second);
  assert.notEqual((await stat(firstPaths.databasePath)).ino, (await stat(secondPaths.databasePath)).ino);
  assert.deepEqual(await readdir(firstPaths.rootDir), ["ling-stack.sqlite"]);
  assert.deepEqual(await readdir(secondPaths.rootDir), ["ling-stack.sqlite"]);
  // Exact migration timestamps also prove simultaneous callers reused one initialization.
  assertSnapshotsEqual(databaseSnapshot(firstPaths.databasePath), databaseSnapshot(secondPaths.databasePath));
  assertSnapshotsEqual(databaseSnapshot(firstPaths.databasePath, true), databaseSnapshot(coldDatabasePath, true));
});

test("workspace copies keep writes, paths, constraints and reopen state independent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-stack-template-isolation-test-"));
  const stores: ReturnType<typeof createSqliteRunStore>[] = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  function openStore(cwd: string) {
    const store = createSqliteRunStore(cwd);
    stores.push(store);
    return store;
  }
  const firstCwd = await createSqliteWorkspaceFixture(join(root, "first-"));
  const secondCwd = await createSqliteWorkspaceFixture(join(root, "second-"));
  const first = openStore(firstCwd);
  const second = openStore(secondCwd);
  assert.deepEqual(first.paths, resolveRuntimePaths(firstCwd));
  assert.deepEqual(second.paths, resolveRuntimePaths(secondCwd));
  assert.notDeepEqual(first.paths.identity, second.paths.identity);
  const now = new Date().toISOString();
  const input = { id: "run_template_isolation", taskId: "task_template_isolation",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now };
  const firstRun = first.createRun({ ...input, cwd: firstCwd });
  assert.equal(second.getRun(input.id), undefined);
  const secondRun = second.createRun({ ...input, cwd: secondCwd });
  assert.notEqual(firstRun.eventLogPath, secondRun.eventLogPath);
  const teammateId = "teammate_builtin_engineer";
  const originalScopes = second.listTeammateMemoryScopes(teammateId);
  const changedScopes = first.replaceTeammateMemoryScopes(teammateId, [], now);
  assert.notDeepEqual(changedScopes.map(scope => scope.id), originalScopes.map(scope => scope.id));
  assert.deepEqual(second.listTeammateMemoryScopes(teammateId), originalScopes);
  assert.throws(() => first.createWorkUnit({ workspaceId: "workspace_missing", kind: "conversation_run",
    ownerType: "run", ownerId: input.id, idempotencyKey: "missing-workspace", createdByActor: "system", request: {}, now }),
  /FOREIGN KEY constraint failed/u);
  assert.deepEqual(first.listWorkUnits(), []);
  first.close();
  const reopened = openStore(firstCwd);
  assert.equal(reopened.getRun(input.id)?.cwd, firstCwd);
  assert.deepEqual(reopened.listTeammateMemoryScopes(teammateId), changedScopes);
  assert.equal(second.getRun(input.id)?.cwd, secondCwd);
  const thirdCwd = await createSqliteWorkspaceFixture(join(root, "third-"));
  const third = openStore(thirdCwd);
  assert.deepEqual(third.listRuns(), []);
  assert.deepEqual(third.listWorkUnits(), []);
  for (const store of [second, reopened, third]) {
    assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(store), /office_local_directory_core_composition_invalid/u);
  }
});
