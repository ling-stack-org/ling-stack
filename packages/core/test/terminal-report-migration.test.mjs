import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("sqlite terminal report migration creates the table and remains idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-migration-"));
  try {
    const first = createSqliteRunStore(cwd);
    const databasePath = first.paths.databasePath;
    first.close();

    const database = new DatabaseSync(databasePath);
    try {
      assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 94 AND name = 'create_ling_terminal_reports'").get());
      const columns = database.prepare("PRAGMA table_info(ling_terminal_reports)").all().map((row) => row.name);
      assert.ok(columns.includes("evidence_snapshot_json"));
      assert.ok(columns.includes("published_message_id"));
      assert.ok(columns.includes("committed_at"));
      const indexes = database.prepare("PRAGMA index_list(ling_terminal_reports)").all().map((row) => row.name);
      assert.ok(indexes.includes("idx_ling_terminal_reports_channel_thread"));
      assert.ok(indexes.includes("idx_ling_terminal_reports_fingerprint"));
    } finally {
      database.close();
    }

    const reopened = createSqliteRunStore(cwd);
    reopened.close();
    const verified = new DatabaseSync(databasePath);
    try {
      assert.equal(verified.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 94").get().count, 1);
    } finally {
      verified.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
