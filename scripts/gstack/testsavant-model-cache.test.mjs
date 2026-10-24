import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const realUnlink = fsPromises.unlink;
  let sharingDenied = false;
  const mocked = t.mock.method(fsPromises, "unlink", async path => {
    if (path === join(lock, `owner-${deadToken}.json`) && !sharingDenied) {
      sharingDenied = true;
      throw Object.assign(new Error("Windows delete-pending sharing denial"), { code: "EPERM" });
    }
    return realUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const acquire = () => createTestsavantModelCache({ ...f, pollMs: 1 })(f.stateRoot);
  assert.deepEqual(await Promise.all([acquire(), acquire()]), [f.final, f.final]);
  assert.equal(sharingDenied, true);
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
  try {
    const acquire = () => createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 })(f.stateRoot);
    assert.deepEqual(await Promise.all([acquire(), acquire()]), [f.final, f.final]);
    assert.equal(f.calls.length, 7);
    assert.deepEqual(await readdir(f.models), [original.revision]);
  } catch (error) {
    error.message += `\ndirectory_observation=${JSON.stringify(error.directoryObservation ?? null)}`;
    throw error;
  }
});

test("an empty orphaned lock with many independent writers publishes exactly one verified model", async t => {
  const f = await fixture(t);
  await mkdir(f.models, { recursive: true, mode: 0o700 });
  await mkdir(`${f.final}.lock`, { mode: 0o700 });
  try {
    const callers = Array.from({ length: 32 }, () => createTestsavantModelCache({ ...f, pollMs: 1 })(f.stateRoot));
    assert.deepEqual(await Promise.all(callers), Array(32).fill(f.final));
    assert.equal(f.calls.length, 7);
    assert.deepEqual(await readdir(f.models), [original.revision]);
  } catch (error) {
    error.message += `\ndirectory_observation=${JSON.stringify(error.directoryObservation ?? null)}`;
    throw error;
  }
});

for (const replacement of ["removed", "live-owner", "stable-alias"]) {
  test(`a deleted canonical lock observation handles ${replacement} without trusting an alias or deleting a new owner`, async t => {
    const f = await fixture(t), lock = `${f.final}.lock`, token = randomUUID();
    await mkdir(f.models, { recursive: true, mode: 0o700 });
    await mkdir(lock, { mode: 0o700 });
    const originalRename = fsPromises.rename, originalRealpath = fsPromises.realpath;
    const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
      if (to === lock && await lstat(to).catch(error => { if (error.code !== "ENOENT") throw error; })) {
        throw Object.assign(new Error("Directory target already exists"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });
    let injected = false;
    const canonical = t.mock.method(fsPromises, "realpath", async path => {
      if (path !== lock || injected) return originalRealpath(path);
      injected = true;
      // The hosted NTFS reproduction returned $Extend/$Deleted after its
      // handle's original empty directory had already been removed.
      if (replacement !== "stable-alias") await rmdir(lock);
      if (replacement === "live-owner") {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: process.pid, token }));
      }
      return join(f.stateRoot, "$Extend", "$Deleted", token);
    });
    syncBuiltinESMExports();
    t.after(() => { canonical.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); });
    const acquire = createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 });
    if (replacement === "removed") {
      assert.equal(await acquire(f.stateRoot), f.final);
      assert.equal(f.calls.length, 7);
      assert.deepEqual(await readdir(f.models), [original.revision]);
    } else {
      await assert.rejects(acquire(f.stateRoot), replacement === "live-owner" ? /cache_busy_timeout/ : /cache_directory_invalid/);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(await readdir(lock), replacement === "live-owner" ? [`owner-${token}.json`] : []);
      if (replacement === "live-owner") assert.deepEqual(JSON.parse(await readFile(join(lock, `owner-${token}.json`))), { pid: process.pid, token });
    }
    assert.equal(injected, true);
  });
}

for (const replacement of ["removed", "live-owner", "stable"]) {
  test(`a failed native lock realpath handles ${replacement} without trusting a stale handle`, async t => {
    const f = await fixture(t), lock = `${f.final}.lock`, token = randomUUID();
    await mkdir(f.models, { recursive: true, mode: 0o700 });
    await mkdir(lock, { mode: 0o700 });
    const originalRename = fsPromises.rename, originalRealpath = fsPromises.realpath;
    const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
      if (to === lock && await lstat(to).catch(error => { if (error.code !== "ENOENT") throw error; })) {
        throw Object.assign(new Error("Directory target already exists"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });
    let injected = false;
    const canonical = t.mock.method(fsPromises, "realpath", async path => {
      if (path !== lock || injected) return originalRealpath(path);
      injected = true;
      if (replacement !== "stable") await rmdir(lock);
      if (replacement === "live-owner") {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: process.pid, token }));
      }
      throw Object.assign(new Error("Native realpath handle became invalid"), { code: "EBADF" });
    });
    syncBuiltinESMExports();
    t.after(() => { canonical.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); });
    const acquire = createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 });
    if (replacement === "removed") {
      assert.equal(await acquire(f.stateRoot), f.final);
      assert.equal(f.calls.length, 7);
      assert.deepEqual(await readdir(f.models), [original.revision]);
    } else {
      await assert.rejects(acquire(f.stateRoot), replacement === "live-owner" ? /cache_busy_timeout/ : { code: "EBADF" });
      assert.equal(f.calls.length, 0);
      assert.deepEqual(await readdir(lock), replacement === "live-owner" ? [`owner-${token}.json`] : []);
      if (replacement === "live-owner") assert.deepEqual(JSON.parse(await readFile(join(lock, `owner-${token}.json`))), { pid: process.pid, token });
    }
    assert.equal(injected, true);
  });
}

test("an invalid private lock remains rejected after its canonical directory disappears", {
  skip: process.platform === "win32" && !process.getuid ? "Windows has no process.getuid private directory mode guard" : false
}, async t => {
  assert.equal(typeof process.getuid, "function");
  const f = await fixture(t), lock = `${f.final}.lock`;
  await mkdir(f.models, { recursive: true, mode: 0o700 });
  await mkdir(lock, { mode: 0o700 });
  await chmod(lock, 0o755);
  const before = await lstat(lock);
  assert.equal(before.uid, process.getuid());
  assert.equal(before.mode & 0o777, 0o755);
  const originalRename = fsPromises.rename, originalRealpath = fsPromises.realpath;
  const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to === lock && await lstat(to).catch(error => { if (error.code !== "ENOENT") throw error; })) {
      throw Object.assign(new Error("Directory target already exists"), { code: "EPERM" });
    }
    return originalRename(from, to);
  });
  let injected = false;
  const canonical = t.mock.method(fsPromises, "realpath", async path => {
    if (path !== lock || injected) return originalRealpath(path);
    injected = true;
    await rmdir(lock);
    return join(f.stateRoot, "$Extend", "$Deleted", randomUUID());
  });
  t.after(() => { canonical.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();
  await assert.rejects(createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 })(f.stateRoot), error => {
    assert.equal(error.message, "testsavant_model_cache_directory_invalid");
    assert.notEqual(error.code, "ESTALE");
    assert.equal(error.directoryObservation.before.mode & 0o777, 0o755);
    assert.deepEqual(error.directoryObservation.after, { error: "ENOENT" });
    return true;
  });
  assert.equal(injected, true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.models), []);
});

for (const code of ["EACCES", "EPERM"]) {
  test(`a rejected canonical lock observation preserves ${code} without deleting its owner`, async t => {
    const f = await fixture(t), lock = `${f.final}.lock`, token = randomUUID();
    const ownerName = `owner-${token}.json`, owner = { pid: process.pid, token };
    await mkdir(f.models, { recursive: true, mode: 0o700 });
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, ownerName), JSON.stringify(owner));
    const originalRename = fsPromises.rename, originalRealpath = fsPromises.realpath, originalLstat = fsPromises.lstat;
    const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
      if (to === lock && await lstat(to).catch(error => { if (error.code !== "ENOENT") throw error; })) {
        throw Object.assign(new Error("Directory target already exists"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });
    let injected = false, denied = false;
    const canonical = t.mock.method(fsPromises, "realpath", async path => {
      if (path !== lock || injected) return originalRealpath(path);
      injected = true;
      return join(f.stateRoot, "$Extend", "$Deleted", token);
    });
    const stat = t.mock.method(fsPromises, "lstat", async (path, ...args) => {
      if (path === lock && injected && !denied) {
        denied = true;
        throw Object.assign(new Error("Directory observation denied"), { code });
      }
      return originalLstat(path, ...args);
    });
    t.after(() => { stat.mock.restore(); canonical.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); });
    syncBuiltinESMExports();
    await assert.rejects(createTestsavantModelCache({ ...f, pollMs: 1, timeoutMs: 1000 })(f.stateRoot), error => {
      assert.equal(error.message, "testsavant_model_cache_directory_invalid");
      assert.notEqual(error.code, "ESTALE");
      assert.deepEqual(error.directoryObservation.after, { error: code });
      return true;
    });
    assert.equal(injected, true); assert.equal(denied, true);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.models), [`${original.revision}.lock`]);
    assert.deepEqual(await readdir(lock), [ownerName]);
    assert.deepEqual(JSON.parse(await readFile(join(lock, ownerName))), owner);
  });
}

for (const replacement of ["removed", "new-owner"]) {
  test(`writer cleanup tolerates another recovery leaving the released lock ${replacement}`, async t => {
    const f = await fixture(t), lock = `${f.final}.lock`, token = randomUUID();
    const originalUnlink = fsPromises.unlink;
    const unlink = t.mock.method(fsPromises, "unlink", async path => {
      const result = await originalUnlink(path);
      if (dirname(path) === lock) {
        // Force the competing recovery after owner release, before our rmdir.
        await rmdir(lock);
        if (replacement === "new-owner") {
          await mkdir(lock, { mode: 0o700 });
          await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: process.pid, token }));
        }
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { unlink.mock.restore(); syncBuiltinESMExports(); });
    assert.equal(await createTestsavantModelCache(f)(f.stateRoot), f.final);
    assert.equal(f.calls.length, 7);
    assert.deepEqual((await readdir(f.models)).sort(), [original.revision,
      ...(replacement === "new-owner" ? [`${original.revision}.lock`] : [])].sort());
    if (replacement === "new-owner") assert.deepEqual(await readdir(lock), [`owner-${token}.json`]);
  });
}

for (const operation of ["unlink", "rmdir"]) {
  for (const persistent of [false, true]) {
    test(`lock ${operation} handles ${persistent ? "persistent" : "transient"} Windows sharing denial`, async t => {
      const f = await fixture(t), lock = `${f.final}.lock`, realOperation = fsPromises[operation];
      let denials = 0;
      const mocked = t.mock.method(fsPromises, operation, async path => {
        if ((operation === "unlink" ? dirname(path) === lock : path === lock) && (persistent || denials === 0)) {
          denials++;
          throw Object.assign(new Error("Windows delete-pending sharing denial"), { code: "EPERM" });
        }
        return realOperation(path);
      });
      syncBuiltinESMExports();
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
      if (persistent) {
        await assert.rejects(createTestsavantModelCache(f)(f.stateRoot), { code: "EPERM" });
        assert.ok(denials > 1 && denials <= 8);
      } else {
        assert.equal(await createTestsavantModelCache(f)(f.stateRoot), f.final);
        assert.equal(denials, 1);
        assert.deepEqual(await readdir(f.models), [original.revision]);
      }
    });
  }
}

test("dead-owner partial cleanup preserves persistent errors after releasing its lock", async t => {
  const f = await fixture(t), token = randomUUID();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise(resolve => child.once("close", resolve));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  const lock = `${f.final}.lock`, abandoned = join(f.models, `.${original.revision}.${token}.partial`);
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: child.pid, token }));
  await mkdir(abandoned, { mode: 0o700 });
  const realRm = fsPromises.rm;
  const mocked = t.mock.method(fsPromises, "rm", async (path, options) => {
    if (path === abandoned) throw Object.assign(new Error("Persistent partial cleanup denial"), { code: "EPERM" });
    return realRm(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(createTestsavantModelCache(f)(f.stateRoot), { code: "EPERM" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.models), [`.${original.revision}.${token}.partial`]);
});

for (const persistent of [false, true]) {
  test(`a vanished lock after rename collision ${persistent ? "preserves persistent denial" : "can be claimed on retry"}`, async t => {
    const f = await fixture(t), lock = `${f.final}.lock`, realRename = fsPromises.rename;
    let denials = 0;
    const mocked = t.mock.method(fsPromises, "rename", async (from, to) => {
      if (to === lock && (persistent || denials === 0)) {
        denials++;
        // Another recovery removed the collision target before exists(lock).
        throw Object.assign(new Error("Collision target disappeared"), { code: "EPERM" });
      }
      return realRename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    if (persistent) {
      await assert.rejects(createTestsavantModelCache(f)(f.stateRoot), { code: "EPERM" });
      assert.ok(denials > 1 && denials <= 8);
      assert.equal(f.calls.length, 0);
    } else {
      assert.equal(await createTestsavantModelCache(f)(f.stateRoot), f.final);
      assert.equal(denials, 1);
      assert.deepEqual(await readdir(f.models), [original.revision]);
    }
  });
}

for (const collision of ["lock-sharing-denial", "partial-disappeared"]) {
  test(`dead-owner recovery handles ${collision} without losing cleanup`, async t => {
    const f = await fixture(t), token = randomUUID();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise(resolve => child.once("close", resolve));
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const lock = `${f.final}.lock`, abandoned = join(f.models, `.${original.revision}.${token}.partial`);
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: child.pid, token }));
    await mkdir(abandoned, { mode: 0o700 });
    const operation = collision === "lock-sharing-denial" ? "rmdir" : "lstat", realOperation = fsPromises[operation], realRm = fsPromises.rm;
    let calls = 0;
    const mocked = t.mock.method(fsPromises, operation, async path => {
      if (collision === "lock-sharing-denial" && path === lock && calls++ === 0) {
        throw Object.assign(new Error("Windows delete-pending sharing denial"), { code: "EPERM" });
      }
      if (collision === "partial-disappeared" && path === abandoned && ++calls === 2) await realRm(abandoned, { recursive: true });
      return realOperation(path);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    assert.equal(await createTestsavantModelCache({ ...f, pollMs: 1 })(f.stateRoot), f.final);
    assert.deepEqual(await readdir(f.models), [original.revision]);
  });
}
