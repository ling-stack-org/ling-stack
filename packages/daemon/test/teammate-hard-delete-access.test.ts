import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { ensureGitRepo } from "./git-test-helpers.mjs";

test("teammate hard delete rejects foreign origins and unknown roots before opening a store", async t => {
  const cwd = await createSqliteWorkspaceFixture(join(tmpdir(), "ling-teammate-delete-access-"));
  const store = createSqliteRunStore(cwd);
  const teammateId = "teammate_builtin_engineer";
  const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
  let opened = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory(root) { opened++; assert.equal(root, cwd); return store; },
  });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/teammates/${teammateId}/hard-delete`;
  const initial = opened;
  for (const [origin, root, error] of [
    ["https://foreign.example.invalid", cwd, "forbidden_origin"],
    ["null", cwd, "forbidden_origin"],
    ["http://localhost:4173", join(cwd, "untrusted"), "workspace_not_trusted"],
  ]) {
    const response = await fetch(`${base}?cwd=${encodeURIComponent(root)}`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, error);
  }
  assert.equal(opened, initial);
  assert.ok(store.getAiTeammate(teammateId));
  assert.equal(store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString()).id, thread.id);
  const allowed = await fetch(`${base}?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(allowed.status, 200, await allowed.text());
  assert.equal(store.getAiTeammate(teammateId), undefined);
});

test("teammate hard delete retains recovery snapshots for a persisted local workspace binding", async t => {
  const cwd = await createSqliteWorkspaceFixture(join(tmpdir(), "ling-teammate-delete-recovery-"));
  await ensureGitRepo(cwd);
  const store = createSqliteRunStore(cwd);
  const teammateId = "teammate_builtin_engineer";
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory() { return store; },
  });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const root = `cwd=${encodeURIComponent(cwd)}`;
  async function post(action: string, body: unknown) {
    const response = await fetch(`${base}/teammates/${teammateId}/direct-workspace/${action}?${root}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json();
  }
  const created = await post("create-worktree", {});
  await writeFile(join(created.binding.worktreePath, "draft.txt"), "preserved draft\n");
  await post("cleanup", { confirmed: true });
  const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
  store.updateTeammateDirectThreadWorkspace(thread.id, { mode: "local", status: "ready", executionPath: cwd, updatedAt: new Date().toISOString() }, new Date().toISOString());
  const listing = await fetch(`${base}/worktrees?${root}`);
  assert.equal(listing.status, 200);
  const [snapshot] = (await listing.json()).snapshots;
  assert.ok(snapshot);
  const deletion = await fetch(`${base}/teammates/${teammateId}/hard-delete?${root}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(deletion.status, 409);
  assert.equal((await deletion.json()).error, "worktree_recovery_pending");
  assert.ok(store.getAiTeammate(teammateId));
  await access(snapshot.snapshotPath);
  assert.equal(await readFile(join(snapshot.snapshotPath, "draft.txt"), "utf8"), "preserved draft\n");
});
