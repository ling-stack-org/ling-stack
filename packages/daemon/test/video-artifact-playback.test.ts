import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import type { RunArtifact } from "@ling-stack/contracts";
import { createDaemonServer } from "../dist/index.js";

test("publishes a large workspace MP4 once and serves its stored bytes with HTTP Range", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-video-artifact-"));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const run = store.createRun({ id: "video-run", cwd, taskId: "fixture", providerName: "fixture",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.markRunStarted(run.id, now);
  store.markRunSucceeded(run.id, now);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner: { async runTask() { assert.fail("publishing a file must not execute a runner"); } },
    storeFactory: () => store,
  });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const query = `cwd=${encodeURIComponent(cwd)}`;
  const name = "操作演示.mp4";
  const source = join(cwd, name);
  const size = 9 * 1024 * 1024;
  const file = await open(source, "w");
  const header = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
  try {
    await file.truncate(size);
    await file.write(header, 0, header.length, 0);
    await file.write("tail", size - 4, "ascii");
  } finally {
    await file.close();
  }
  const publish = (path: string) => fetch(`${base}/runs/${run.id}/artifacts?${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
  });
  await writeFile(join(cwd, "text.mp4"), "a text file");
  assert.equal((await publish("text.mp4")).status, 415);

  const first = await publish(name);
  assert.equal(first.status, 201);
  const { artifact } = await first.json() as { artifact: RunArtifact };
  assert.equal(artifact.type, "video");
  assert.equal(artifact.title, name);
  assert.equal(artifact.runId, run.id);
  assert.equal(artifact.sizeBytes, size);
  const retry = await publish(source);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { artifact: RunArtifact }).artifact.id, artifact.id);
  assert.equal(store.listArtifacts(run.id).length, 1);
  await rm(source);

  const content = `${base}/artifacts/${artifact.id}/content?${query}`;
  const head = await fetch(content, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(Number(head.headers.get("content-length")), size);

  const full = await fetch(content);
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get("content-length")), size);
  await full.body?.cancel();

  const prefix = await fetch(content, { headers: { Range: "bytes=0-11", Origin: "http://127.0.0.1:4174" } });
  assert.equal(prefix.status, 206);
  assert.equal(prefix.headers.get("content-range"), `bytes 0-11/${size}`);
  assert.deepEqual(Buffer.from(await prefix.arrayBuffer()), header);
  for (const range of ["bytes=-4", `bytes=${size - 4}-`]) {
    const tail = await fetch(content, { headers: { Range: range } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), `bytes ${size - 4}-${size - 1}/${size}`);
    assert.equal(await tail.text(), "tail");
  }
  const invalid = await fetch(content, { headers: { Range: `bytes=${size}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${size}`);
  const legacy = await fetch(`${content}&offset=${size - 4}&limit=2`);
  assert.equal(legacy.status, 206);
  assert.equal(await legacy.text(), "ta");
});

test("publishes an MP4 through an authenticated non-loopback daemon", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-video-authenticated-"));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const run = store.createRun({ id: "video-authenticated-run", cwd, taskId: "fixture", providerName: "fixture",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.markRunStarted(run.id, now);
  store.markRunSucceeded(run.id, now);
  const daemon = createDaemonServer({ host: "0.0.0.0", port: 0, authToken: "video-auth-token", defaultWorkspaceCwd: cwd }, {
    runner: { async runTask() { assert.fail("publishing a file must not execute a runner"); } },
    storeFactory: () => store,
  });
  t.after(async () => { await daemon.stop(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const source = join(cwd, "remote-export.mp4");
  await writeFile(source, Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]));
  const response = await fetch(`${base}/runs/${run.id}/artifacts?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { Authorization: "Bearer video-auth-token", "Content-Type": "application/json" },
    body: JSON.stringify({ path: "remote-export.mp4" }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { artifact: RunArtifact }).artifact.type, "video");
});
