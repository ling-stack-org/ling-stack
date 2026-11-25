import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises, { mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

  const oversized = await open(join(cwd, "oversized.mp4"), "wx");
  try {
    await oversized.truncate(512 * 1024 * 1024 + 1);
    await oversized.write(header, 0, header.length, 0);
  } finally { await oversized.close(); }
  const rejected = await publish("oversized.mp4");
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json() as { error: string }).error, "video_size_exceeded");

  const changed = join(cwd, "changed.mp4");
  const replacement = join(cwd, "replacement.mp4");
  await Promise.all([writeFile(changed, header), writeFile(replacement, Buffer.concat([header, Buffer.from("replacement")]))]);
  const changedPath = await realpath(changed);
  const actualOpen = fsPromises.open;
  const openDuringReplacement = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof actualOpen>) => {
    if (args[0] === changedPath) await rename(replacement, changed);
    return actualOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const conflict = await publish("changed.mp4");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: string }).error, "video_source_changed");
  } finally {
    openDuringReplacement.mock.restore();
    syncBuiltinESMExports();
  }
  const artifactRoot = await realpath(store.paths.artifactsDir);
  const lowDisk = t.mock.method(fs, "statfsSync", (path: string) => {
    assert.equal(path, artifactRoot);
    return { bavail: 1n, bsize: 4096n };
  });
  syncBuiltinESMExports();
  try {
    const unavailable = await publish(name);
    assert.equal(unavailable.status, 507);
    assert.equal((await unavailable.json() as { error: string }).error, "video_storage_insufficient");
  } finally {
    lowDisk.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(store.listArtifacts(run.id).length, 0);

  const { dev, ino, size: sourceSize, mtimeMs, ctimeMs } = await stat(source);
  const expectedId = "artifact_" + createHash("sha256")
    .update(JSON.stringify([run.id, await realpath(source), dev, ino, sourceSize, mtimeMs, ctimeMs])).digest("hex");
  const responses = await Promise.all([publish(name), publish(source)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const first = responses.find(response => response.status === 201)!;
  const { artifact } = await first.json() as { artifact: RunArtifact };
  assert.equal(artifact.id, expectedId);
  assert.equal(artifact.type, "video");
  assert.equal(artifact.title, name);
  assert.equal(artifact.runId, run.id);
  assert.equal(artifact.sizeBytes, size);
  const retry = responses.find(response => response.status === 200)!;
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
