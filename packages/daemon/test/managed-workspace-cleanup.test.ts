import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { ensureGitRepo } from "./git-test-helpers.mjs";
import { createChannel, getJson, postJson, startDaemonForTest } from "./support/channel-workspace-fixture.mjs";

async function fixture(t: TestContext, kind: "channel" | "teammate") {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-workspace-cleanup-"));
  const daemon = await startDaemonForTest(undefined, {}, { defaultWorkspaceCwd: cwd });
  t.after(async () => { await daemon.close(); await rm(cwd, { recursive: true, force: true }); });
  await ensureGitRepo(cwd);
  const owner = kind === "channel" ? await createChannel(daemon.url, cwd) : undefined;
  const base = kind === "channel"
    ? `${daemon.url}/channels/${encodeURIComponent(owner.id)}/workspace`
    : `${daemon.url}/teammates/teammate_builtin_engineer/direct-workspace`;
  const url = (action: string) => `${base}/${action}?cwd=${encodeURIComponent(cwd)}`;
  const created = kind === "channel" ? { binding: owner.workspaceBinding }
    : await postJson(url("create-worktree"), {});
  const path: string = created.binding.worktreePath;
  await access(path);
  return { cwd, daemon, path, url, ownerId: kind === "channel" ? owner.id as string : created.threadId as string };
}

for (const kind of ["channel", "teammate"] as const) {
  test(`${kind} workspace cleanup requires confirmation and keeps a clean binding recreatable`, async t => {
    const f = await fixture(t, kind);
    const denied = await fetch(f.url("cleanup"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, "worktree_confirmation_required");
    await access(f.path);
    const cleaned = await postJson(f.url("cleanup"), { confirmed: true });
    assert.equal(cleaned.binding.mode, "managed_worktree");
    assert.equal(cleaned.binding.status, "not_created");
    assert.equal(cleaned.binding.worktreePath, f.path);
    await assert.rejects(access(f.path), /ENOENT/);
    const refreshed = await postJson(f.url("refresh"), {});
    assert.equal(refreshed.binding.status, "not_created");
    const handoff = await fetch(f.url("handoff"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "local" }),
    });
    assert.equal(handoff.status, 409);
    assert.equal((await handoff.json()).error, "worktree_snapshot_pending");
    if (kind === "channel") {
      const deleted = await fetch(`${f.daemon.url}/channels/${encodeURIComponent(f.ownerId)}?cwd=${encodeURIComponent(f.cwd)}`, { method: "DELETE" });
      assert.equal(deleted.status, 409);
      assert.equal((await deleted.json()).error, "worktree_owner_in_use");
    }
    const recreated = await postJson(f.url("create-worktree"), {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(recreated.binding.worktreePath, f.path);
    await access(f.path);
  });

  test(`${kind} workspace cleanup preserves dirty files in a recoverable snapshot`, async t => {
    const f = await fixture(t, kind);
    await writeFile(resolve(f.path, "dirty.txt"), "dirty\n");
    const refreshed = await postJson(f.url("refresh"), {});
    assert.equal(refreshed.binding.status, "ready");
    assert.equal(refreshed.binding.errorMessage, undefined);
    await postJson(f.url("cleanup"), { confirmed: true });
    await assert.rejects(access(f.path), /ENOENT/);
    const list = await getJson(`${f.daemon.url}/worktrees?cwd=${encodeURIComponent(f.cwd)}`);
    assert.equal(list.snapshots.length, 1);
    assert.equal(await readFile(resolve(list.snapshots[0].snapshotPath, "dirty.txt"), "utf8"), "dirty\n");
    const recreated = await postJson(f.url("create-worktree"), {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(await readFile(resolve(f.path, "dirty.txt"), "utf8"), "dirty\n");
    const restored = await getJson(`${f.daemon.url}/worktrees?cwd=${encodeURIComponent(f.cwd)}`);
    assert.equal(restored.snapshots.length, 0);
  });

  test(`${kind} cleanup without a body follows the saved confirmation policy`, async t => {
    const f = await fixture(t, kind);
    const denied = await fetch(f.url("cleanup"), { method: "POST" });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, "worktree_confirmation_required");
    await access(f.path);
    const policy = await fetch(`${f.daemon.url}/workspace-settings?cwd=${encodeURIComponent(f.cwd)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreePolicy: { fetchBeforeCreate: false, confirmBeforeDelete: false } }),
    });
    assert.equal(policy.status, 200, await policy.text());
    const invalid = await fetch(f.url("cleanup"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    });
    assert.equal(invalid.status, 400);
    await access(f.path);
    const cleaned = await fetch(f.url("cleanup"), { method: "POST" });
    assert.equal(cleaned.status, 200, await cleaned.clone().text());
    assert.equal((await cleaned.json()).binding.status, "not_created");
    await assert.rejects(access(f.path), /ENOENT/);
    const recreated = await postJson(f.url("create-worktree"), {});
    assert.equal(recreated.binding.status, "ready");
    await access(f.path);
  });
}
