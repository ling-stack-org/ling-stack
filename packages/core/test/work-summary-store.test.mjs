import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

function assertNativeCompletionSchema(store) {
  assert.ok(store.database.prepare("PRAGMA table_info(host_attempt_completions)").all()
    .some((column) => column.name === "native_effect_inventory_json"));
  assert.equal(store.database.prepare("SELECT name FROM schema_migrations WHERE version = 175").get().name,
    "original_native_attempt_effect_inventory");
}

test("fresh work summary storage preserves the native completion migration and PR bindings across reopen", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-summary-store-fresh-"));
  let store;
  try {
    store = createSqliteRunStore(cwd);
    assertNativeCompletionSchema(store);
    const url = "https://github.com/example/repo/pull/7";
    const now = "2026-10-23T08:00:00Z";
    store.attachWorkSummaryPullRequest(url, now);
    store.close();
    store = createSqliteRunStore(cwd);
    assertNativeCompletionSchema(store);
    assert.deepEqual(store.listWorkSummaryPullRequests(), [{ url, createdAt: now }]);
  } finally {
    store?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work summary storage upgrades a database with native migration 175 already applied", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-summary-store-upgrade-"));
  let store;
  try {
    store = createSqliteRunStore(cwd);
    assertNativeCompletionSchema(store);
    // Stage the main-branch schema before work summary was introduced.
    store.database.exec("DROP TABLE work_summary_pull_requests; DELETE FROM schema_migrations WHERE name = 'create_work_summary_pull_requests'");
    store.close();
    store = createSqliteRunStore(cwd);
    assertNativeCompletionSchema(store);
    const url = "https://github.com/example/repo/pull/8";
    const now = "2026-10-23T08:00:00Z";
    store.attachWorkSummaryPullRequest(url, now);
    store.attachWorkSummaryPullRequest(url, now);
    assert.deepEqual(store.listWorkSummaryPullRequests(), [{ url, createdAt: now }]);
    store.detachWorkSummaryPullRequest(url);
    assert.deepEqual(store.listWorkSummaryPullRequests(), []);
    assert.equal(store.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    store?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
