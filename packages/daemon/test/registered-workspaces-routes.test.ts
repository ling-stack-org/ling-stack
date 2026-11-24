import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, registerResolvedWorkspace } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";

test("registered workspace selection only activates known available local paths", async t => {
  const temp = await realpath(tmpdir());
  const cwd = await createSqliteWorkspaceFixture(join(temp, "ling-workspace-switch-"));
  const other = await mkdtemp(join(temp, "ling-workspace-switch-other-"));
  const target = await mkdtemp(join(temp, "ling-workspace-switch-unregistered-"));
  const nestedWorkspace = join(other, "nested");
  const nestedTarget = join(target, "nested");
  await mkdir(nestedWorkspace);
  await mkdir(nestedTarget);
  const prior = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "user-root");
  const store = createSqliteRunStore(cwd);
  registerResolvedWorkspace(cwd);
  registerResolvedWorkspace(other);
  registerResolvedWorkspace(nestedWorkspace);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store, desktopBridgeToken: "fixture-desktop-bridge" });
  t.after(async () => { await daemon.stop(); store.close(); if (prior === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = prior; await rm(cwd, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const listWorkspaces = (origin?: string, token = "fixture-desktop-bridge") => fetch(`${base}/workspaces/registered`,
    { headers: { "X-Ling-Desktop-Bridge-Token": token, ...(origin ? { Origin: origin } : {}) } });
  assert.equal((await listWorkspaces(undefined, "incorrect-token")).status, 403);
  assert.equal((await listWorkspaces(`http://localhost:${address.port}`)).status, 403);
  const list = await listWorkspaces();
  assert.equal(list.status, 200);
  assert.ok((await list.json() as { workspaces: { cwd: string }[] }).workspaces.some(item => item.cwd === other));
  const activate = (path: string, origin?: string, token = "fixture-desktop-bridge") => fetch(`${base}/workspaces/activate`, { method: "POST",
    headers: { "content-type": "application/json", "X-Ling-Desktop-Bridge-Token": token,
      ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ cwd: path }) });
  const protectedUrl = `${base}/device-storage/scans?cwd=${encodeURIComponent(other)}`;
  assert.equal((await fetch(protectedUrl)).status, 403);
  assert.equal((await activate(other, undefined, "incorrect-token")).status, 403);
  assert.equal((await activate(other, `http://localhost:${address.port}`)).status, 403);
  assert.equal((await fetch(protectedUrl)).status, 403);
  assert.equal((await activate(other)).status, 200);
  assert.equal((await fetch(protectedUrl)).status, 404);
  assert.equal((await activate(join(cwd, "missing"))).status, 404);
  assert.equal((await activate(other, "https://foreign.invalid")).status, 403);
  await rm(other, { recursive: true });
  assert.equal((await activate(other)).status, 409);
  await symlink(target, other, "junction");
  const linked = await (await listWorkspaces()).json() as { workspaces: { cwd: string; available: boolean }[] };
  assert.equal(linked.workspaces.find(item => item.cwd === other)?.available, false);
  assert.equal(linked.workspaces.find(item => item.cwd === nestedWorkspace)?.available, false);
  assert.equal((await activate(other)).status, 409);
  assert.equal((await activate(nestedWorkspace)).status, 409);
  assert.equal((await fetch(`${base}/device-storage/scans?cwd=${encodeURIComponent(target)}`)).status, 403);
  assert.equal((await fetch(`${base}/device-storage/scans?cwd=${encodeURIComponent(nestedTarget)}`)).status, 403);
});
