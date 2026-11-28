import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createLegacySqliteRunStoreForMigrationTest, createSqliteRunStore } from "../dist/index.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

const trigger = "trg_harness_pruned_artifact_no_rehydrate";

test("legacy Continuity fixtures defer artifact retention until sealed artifact columns exist", async (t: TestContext) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-legacy-harness-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = createLegacySqliteRunStoreForMigrationTest(cwd);
  try {
    const legacyDatabase = testDatabase(legacy);
    assert.equal(legacyDatabase.prepare("PRAGMA table_info(artifacts)").all()
      .some((column: { name?: string }) => column.name === "sealed_payload_json"), false);
    assert.equal(legacyDatabase.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), undefined,
      "legacy fixtures must not contain triggers referencing future artifact columns");
    assert.equal(legacyDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=177").get(), undefined);
    assert.equal(legacyDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=195").get(), undefined);
    assert.equal(legacyDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=196").get(), undefined);
  } finally { legacy.close(); }

  for (let reopen = 0; reopen < 2; reopen += 1) {
    const current = createSqliteRunStore(cwd);
    try {
      const currentDatabase = testDatabase(current);
      assert.ok(currentDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=177").get());
      assert.ok(currentDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=195").get());
      assert.ok(currentDatabase.prepare("SELECT 1 FROM schema_migrations WHERE version=196").get());
      assert.ok(currentDatabase.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger));
      assert.equal((currentDatabase.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check, "ok");
      assert.deepEqual(currentDatabase.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { current.close(); }
  }
});
