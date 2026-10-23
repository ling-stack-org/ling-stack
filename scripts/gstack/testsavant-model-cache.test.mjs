import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTestsavantModelCache, testsavantModelAcquisition } from "./testsavant-model-cache.mjs";

const original = JSON.parse(await readFile(new URL("./testsavant-model-pin.json", import.meta.url)));
async function fixture(t) {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "testsavant-owned-cache-")));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const payloads = new Map(original.files.map(file => [file.remotePath, Buffer.from(`authentic fixture ${file.path}`)]));
  const modelPin = { ...original, files: original.files.map(file => ({ ...file, sizeBytes: payloads.get(file.remotePath).length,
    checksum: `sha256:${createHash("sha256").update(payloads.get(file.remotePath)).digest("hex")}` })) };
  const calls = [];
  const request = async (value, options) => {
    const url = new URL(value); calls.push(value);
    assert.equal(url.origin, "https://huggingface.co");
    const prefix = `/${original.repository}/resolve/${original.revision}/`;
    assert.ok(url.pathname.startsWith(prefix));
    assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
    return new Response(payloads.get(url.pathname.slice(prefix.length)), { status: 200 });
  };
  return { stateRoot, modelPin, payloads, calls, request,
    models: join(stateRoot, "model-cache/testsavant"), final: join(stateRoot, "model-cache/testsavant", original.revision) };
}

test("first acquisition publishes only fully verified fixed-revision bytes; cache hits work offline", async t => {
  const f = await fixture(t), acquire = createTestsavantModelCache(f);
  assert.equal(await acquire(f.stateRoot), f.final); assert.equal(f.calls.length, 7);
  assert.deepEqual(JSON.parse(await readFile(join(f.final, "acquisition.json"))), testsavantModelAcquisition(f.modelPin));
  const offline = createTestsavantModelCache({ modelPin: f.modelPin, request: () => { throw Error("network must not be called"); } });
  assert.equal(await offline(f.stateRoot), f.final);
  assert.deepEqual(await readdir(f.models), [original.revision]);
});

test("independent callers serialize one writer and never observe a partially published model", async t => {
  const f = await fixture(t);
  const request = async (...args) => { await delay(10); return f.request(...args); };
  const first = createTestsavantModelCache({ modelPin: f.modelPin, request, pollMs: 1 });
  const second = createTestsavantModelCache({ modelPin: f.modelPin, request, pollMs: 1 });
  const results = await Promise.all([first(f.stateRoot), second(f.stateRoot), first(f.stateRoot)]);
  assert.deepEqual(results, [f.final, f.final, f.final]); assert.equal(f.calls.length, 7);
  assert.deepEqual(await readdir(f.models), [original.revision]);
});

for (const failure of ["truncated", "wrong-hash", "oversize", "redirect", "network"]) {
  test(`${failure} acquisition fails without publishing final content or leaving a lock/partial tree`, async t => {
    const f = await fixture(t);
    const request = async (url, options) => {
      if (failure === "network") throw Error("unavailable");
      if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/model" } });
      const response = await f.request(url, options), bytes = Buffer.from(await response.arrayBuffer());
      if (failure === "truncated") return new Response(bytes.subarray(1));
      if (failure === "wrong-hash") bytes[0] ^= 1;
      return new Response(failure === "oversize" ? Buffer.concat([bytes, bytes]) : bytes);
    };
    await assert.rejects(createTestsavantModelCache({ modelPin: f.modelPin, request })(f.stateRoot), /testsavant_model_/);
    assert.deepEqual(await readdir(f.models), []);
    // A failed attempt does not poison subsequent official acquisition.
    assert.equal(await createTestsavantModelCache(f)(f.stateRoot), f.final);
  });
}

test("a tampered existing cache is rejected before inference and never silently replaced or trusted", async t => {
  const f = await fixture(t), acquire = createTestsavantModelCache(f);
  await acquire(f.stateRoot);
  await writeFile(join(f.final, "onnx/model.onnx"), Buffer.alloc(f.modelPin.files[5].sizeBytes));
  await assert.rejects(acquire(f.stateRoot), /cache_content_mismatch/);
  assert.equal(f.calls.length, 7);
});

test("download deadline and another live writer both return bounded failures", async t => {
  const f = await fixture(t);
  const request = async (_url, { signal }) => { await delay(5000, undefined, { signal }); return new Response("late"); };
  await assert.rejects(createTestsavantModelCache({ modelPin: f.modelPin, request, timeoutMs: 20 })(f.stateRoot), /download_timeout/);
  assert.deepEqual(await readdir(f.models), []);
  await mkdir(`${f.final}.lock`, { mode: 0o700 });
  const liveToken = randomUUID();
  await writeFile(join(`${f.final}.lock`, `owner-${liveToken}.json`), JSON.stringify({ pid: process.pid, token: liveToken }));
  await assert.rejects(createTestsavantModelCache({ modelPin: f.modelPin, request, timeoutMs: 20, pollMs: 1 })(f.stateRoot), /cache_busy_timeout/);
  assert.deepEqual(await readdir(f.models), [`${original.revision}.lock`]);
});

test("a confirmed dead writer is recovered without deleting live or unrelated ownership", async t => {
  const f = await fixture(t), deadToken = randomUUID(), unrelated = `.${original.revision}.${randomUUID()}.partial`;
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise(resolve => child.once("close", resolve));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  await mkdir(f.models, { recursive: true, mode: 0o700 });
  const lock = `${f.final}.lock`; await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, `owner-${deadToken}.json`), JSON.stringify({ pid: child.pid, token: deadToken }));
  const abandoned = join(f.models, `.${original.revision}.${deadToken}.partial`);
  await mkdir(abandoned, { mode: 0o700 }); await writeFile(join(abandoned, "incomplete"), "do not publish");
  await mkdir(join(f.models, unrelated), { mode: 0o700 });
  const acquire = () => createTestsavantModelCache({ ...f, pollMs: 1 })(f.stateRoot);
  assert.deepEqual(await Promise.all([acquire(), acquire()]), [f.final, f.final]);
  assert.deepEqual((await readdir(f.models)).sort(), [unrelated, original.revision].sort());
  assert.equal(f.calls.length, 7);
});

test("an empty orphaned lock recovers when directory rename cannot replace an existing target", async t => {
  const f = await fixture(t), lock = `${f.final}.lock`;
  await mkdir(f.models, { recursive: true, mode: 0o700 });
  await mkdir(lock, { mode: 0o700 });
  const originalRename = fsPromises.rename;
  // Exercise Windows directory-rename collisions on every native test host.
  const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to === lock) {
      const target = await lstat(to).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (target) throw Object.assign(new Error("Directory target already exists"), { code: "EPERM" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { rename.mock.restore(); syncBuiltinESMExports(); });
  const acquire = () => createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 })(f.stateRoot);
  assert.deepEqual(await Promise.all([acquire(), acquire()]), [f.final, f.final]);
  assert.equal(f.calls.length, 7);
  assert.deepEqual(await readdir(f.models), [original.revision]);
});
