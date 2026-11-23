import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, registerResolvedWorkspace } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";

test("device storage route only scans a trusted registered workspace", async t => {
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
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/device-storage/scans?cwd=${encodeURIComponent(cwd)}`;
  const forbidden = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify({ scope: "current" }) });
  assert.equal(forbidden.status, 403);
  const started = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "current" }) });
  assert.equal(started.status, 202);
  const id = (await started.json() as { id: string }).id;
  let job: { status: string; snapshot?: { categories: { category: string; knownBytes: number }[] } } | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${address.port}/device-storage/scans/${id}?cwd=${encodeURIComponent(cwd)}`);
    job = await response.json() as typeof job;
    if (job?.status !== "scanning") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(job?.snapshot, `scan status: ${job?.status}`);
  assert.ok((job.snapshot.categories.find(item => item.category === "conversations")?.knownBytes ?? 0) >= 17);
});
