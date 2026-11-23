import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DeviceStorageScanJob } from "@ling-stack/contracts";
import { createSqliteRunStore, registerResolvedWorkspace } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createManagedWorktreeBinding } from "../dist/features/channels/workspace.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";

test("device storage scans trusted workspaces and marks excluded blocked worktrees as partial", async t => {
  const cwd = await createSqliteWorkspaceFixture(join(tmpdir(), "ling-device-storage-route-"));
  const prior = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "test-user-root");
  const store = createSqliteRunStore(cwd);
  registerResolvedWorkspace(cwd);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
  t.after(async () => { await daemon.stop(); store.close(); if (prior === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = prior;
    await rm(cwd, { recursive: true, force: true }); });
  const sessions = join(cwd, ".ling-stack", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "fixture.bin"), Buffer.alloc(17));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\ntest-user-root/\n");
  git("add", ".gitignore");
  git("-c", "user.name=Ling Test", "-c", "user.email=test@ling.invalid", "commit", "-m", "Initial");
  const now = new Date().toISOString();
  const policy = { fetchBeforeCreate: false, environment: { enabled: true, setupScript: "exit 1", variables: {}, timeoutSeconds: 2 } };
  store.updateWorkspaceSettings({ worktreePolicy: policy }, now);
  const channel = store.createChannel({ name: "Setup pending", boundPath: cwd }, now);
  const managed = await createManagedWorktreeBinding(channel, cwd, store.paths, undefined, policy, store);
  assert.ok(managed.ok, JSON.stringify(managed));
  assert.equal(managed.binding.status, "blocked");
  assert.ok(managed.binding.worktreePath);
  store.updateChannel(channel.id, { workspaceBinding: managed.binding }, now);
  await writeFile(join(managed.binding.worktreePath, "fixture.bin"), Buffer.alloc(29));
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/device-storage/scans?cwd=${encodeURIComponent(cwd)}`;
  const forbidden = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify({ scope: "current" }) });
  assert.equal(forbidden.status, 403);
  const started = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "current" }) });
  assert.equal(started.status, 202);
  const id = (await started.json() as { id: string }).id;
  let job: DeviceStorageScanJob | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${address.port}/device-storage/scans/${id}?cwd=${encodeURIComponent(cwd)}`);
    job = await response.json() as DeviceStorageScanJob;
    if (job.status !== "scanning") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(job?.snapshot, `scan status: ${job?.status}`);
  assert.ok((job.snapshot.categories.find(item => item.category === "conversations")?.knownBytes ?? 0) >= 17);
  assert.deepEqual(job.snapshot.categories.find(item => item.category === "worktrees"), {
    category: "worktrees", knownBytes: 0, status: "partial", reason: "read_error",
  });
});
