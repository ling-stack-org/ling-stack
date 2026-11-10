import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { bounded, descriptorPathForA01, observeA01Descriptor, runA01Child, signal,
  spawnA01Worker } from "../../daemon/test/support/a01-browser-descriptor-fixture.mjs";

const caseName = process.env.LING_A01_CASE;
const cases = ["coordination-yields", "coordination-timeout", "coordination-corrupt",
  "coordination-processes", "publication-faults", "coordination-cleanup"];
if (!caseName) {
  for (const name of cases) test(`A01 descriptor reliability: ${name}`, { timeout: 50_000 },
    () => runA01Child(name, import.meta.url));
} else if (caseName.startsWith("coordination-worker-")) {
  const observed = observeA01Descriptor({ mock, after(callback) { process.once("beforeExit", callback); } }, descriptorPathForA01());
  const { createChromeBrowserRuntimeDescriptor, publishChromeBrowserRuntimeDescriptor } = await import("../dist/index.js");
  const descriptor = createChromeBrowserRuntimeDescriptor({ port: 43123, generation: caseName, token: "test-a01-coordination-token" });
  const gate = observed.renameGate(descriptor.generation), go = signal(), finish = signal();
  process.on("message", message => {
    if (message.kind === "go") go.complete();
    if (message.kind === "release") gate.release.complete();
    if (message.kind === "finish") { gate.release.complete(); finish.complete(); }
  });
  observed.contention.promise.then(evidence => process.send({ kind: "lock-contention", evidence }));
  gate.entered.promise.then(() => process.send({ kind: "held", generation: descriptor.generation }));
  process.send({ kind: "ready-to-publish" });
  try {
    await bounded(go.promise, "worker launch");
    await publishChromeBrowserRuntimeDescriptor(descriptor, descriptorPathForA01());
    process.send({ kind: "published", generation: descriptor.generation });
    await bounded(finish.promise, "worker finish", 30_000);
  } finally { observed.restore(); process.disconnect(); }
} else {
  assert.ok(cases.includes(caseName));
  test(`A01 actual ${caseName} child`, { timeout: 35_000 }, async t => {
    console.log(`A01 child entered: ${caseName}`);
    const path = descriptorPathForA01(), sidecar = `${path}.coordination.sqlite`;
    const observed = observeA01Descriptor(t, path);
    const actual = { chmod: fs.chmod, rename: fs.rename, rm: fs.rm, open: fs.open };
    const product = await import("../dist/index.js");
    const { withDescriptorCoordination } = await import("../dist/descriptor-coordination.js");
    const descriptor = generation => product.createChromeBrowserRuntimeDescriptor({
      port: 43123, generation, token: "test-a01-reliability-token" });
    try {
      if (caseName === "coordination-yields" || caseName === "coordination-timeout") {
        const first = descriptor("generation-first");
        await product.publishChromeBrowserRuntimeDescriptor(first, path);
        const before = await fs.stat(sidecar), holder = new DatabaseSync(sidecar);
        holder.exec("PRAGMA busy_timeout=0"); holder.exec("BEGIN IMMEDIATE");
        let beats = 0;
        const timer = setInterval(() => { beats++; }, 10);
        try {
          const pending = product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-next"), path);
          // Attach rejection immediately, while observing actual BUSY in parallel.
          const settled = pending.then(value => ({ value }), error => ({ error }));
          const contention = await bounded(observed.contention.promise, "real BEGIN SQLITE_BUSY");
          assert.equal(contention.errcode & 0xff, 5);
          if (caseName === "coordination-yields") {
            await new Promise(done => setTimeout(done, 100));
            assert.ok(beats >= 3, "same-thread timer continues while lock owner awaits FS");
            holder.exec("ROLLBACK");
            assert.deepEqual(await settled, { value: "published" });
            assert.equal((await observed.actualRead()).generation, "generation-next");
          } else {
            const result = await bounded(settled, "bounded acquisition fails", 7_000);
            assert.equal(result.error?.message, "browser_host_descriptor_lock_timeout");
            assert.equal(result.error.cause.errcode & 0xff, 5);
            assert.equal((await observed.actualRead()).generation, first.generation);
            assert.equal(await fs.stat(`${path}.generation-next.tmp`).then(() => true, error => {
              assert.equal(error.code, "ENOENT"); return false;
            }), false, "no unlocked fallback or operation replay");
            holder.exec("ROLLBACK");
            assert.equal(await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-recovered"), path), "published");
          }
        } finally { clearInterval(timer); holder.close(); }
        const after = await fs.stat(sidecar);
        assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
        assert.equal(after.mode & 0o777, 0o600);
        assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
        console.log(`A01 L2 actual evidence: ${JSON.stringify({ caseName, beats, inode: after.ino })}`);
      } else if (caseName === "coordination-corrupt") {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(sidecar, "test-not-a-sqlite-database", { flag: "wx", mode: 0o600 });
        const before = await fs.stat(sidecar), started = performance.now();
        let failure;
        try { await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-corrupt"), path); }
        catch (error) { failure = error; }
        assert.equal(failure.errcode & 0xff, 26, "real SQLITE_NOTADB is not retried as contention");
        assert.ok(performance.now() - started < 1_000);
        assert.equal((await fs.stat(sidecar)).ino, before.ino);
        assert.equal(await fs.readFile(sidecar, "utf8"), "test-not-a-sqlite-database");
        assert.equal(await observed.actualRead(), undefined);
        console.log(`A01 non-BUSY evidence: ${JSON.stringify({ code: failure.code, errcode: failure.errcode })}`);
      } else if (caseName === "coordination-processes") {
        const workers = [];
        const spawn = async role => {
          const workspace = join(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, role);
          await fs.mkdir(workspace);
          const worker = spawnA01Worker(import.meta.url, role, workspace); workers.push(worker);
          await worker.wait("ready-to-publish"); return worker;
        };
        try {
          const a = await spawn("coordination-worker-a"), b = await spawn("coordination-worker-b");
          a.send({ kind: "go" }); b.send({ kind: "go" });
          const winner = await bounded(Promise.race([a.wait("held").then(() => a), b.wait("held").then(() => b)]), "first simultaneous creator");
          const loser = winner === a ? b : a;
          const contention = await loser.wait("lock-contention");
          assert.equal(contention.evidence.errcode & 0xff, 5);
          const identity = await fs.stat(sidecar);
          winner.send({ kind: "release" }); await winner.wait("published");
          await loser.wait("held"); loser.send({ kind: "release" });
          const successor = await loser.wait("published");
          assert.equal((await observed.actualRead()).generation, successor.generation);
          assert.equal((await fs.stat(sidecar)).ino, identity.ino);
          for (const worker of [a, b]) { worker.send({ kind: "finish" }); assert.deepEqual(await worker.exited, { code: 0, signal: null }); }
          const crashing = await spawn("coordination-worker-crash"); crashing.send({ kind: "go" });
          const held = await crashing.wait("held");
          assert.equal(crashing.child.kill("SIGKILL"), true, "only the owned child is terminated");
          assert.deepEqual(await crashing.exited, { code: null, signal: "SIGKILL" });
          const recovered = await spawn("coordination-worker-recovered"); recovered.send({ kind: "go" });
          await recovered.wait("held"); recovered.send({ kind: "release" });
          const recovery = await recovered.wait("published");
          assert.equal((await observed.actualRead()).generation, recovery.generation);
          assert.equal((await fs.stat(sidecar)).ino, identity.ino, "crash recovery must not recreate the lock file");
          assert.equal((await fs.stat(`${path}.${held.generation}.tmp`)).mode & 0o777, 0o600, "successor does not delete another operation's temp");
          recovered.send({ kind: "finish" }); assert.deepEqual(await recovered.exited, { code: 0, signal: null });
          console.log(`A01 L3 real process evidence: ${JSON.stringify({ inode: identity.ino, generation: recovery.generation, ownerSignal: "SIGKILL" })}`);
        } finally {
          for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) {
            worker.send({ kind: "release" }); worker.send({ kind: "finish" });
            await bounded(worker.exited, "worker final cleanup");
          }
        }
      } else if (caseName === "publication-faults") {
        // EEXIST must preserve somebody else's temp byte-for-byte.
        await fs.mkdir(dirname(path), { recursive: true });
        const occupied = `${path}.generation-occupied.tmp`;
        await fs.writeFile(occupied, "test-owned-other-operation", { flag: "wx" });
        await assert.rejects(product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-occupied"), path), { code: "EEXIST" });
        assert.equal(await fs.readFile(occupied, "utf8"), "test-owned-other-operation");
        for (const boundary of ["write", "temporary-permission", "rename", "final-permission"]) {
          const value = descriptor(`generation-${boundary}`), temporary = `${path}.${value.generation}.tmp`;
          let actualError, renamed = false;
          const patches = [];
          if (boundary === "write") patches.push(t.mock.method(fs, "open", async (target, ...args) => {
            const handle = await actual.open(target, ...args);
            if (target === temporary) {
              const write = handle.writeFile.bind(handle);
              handle.writeFile = async (...writeArgs) => {
                await handle.close();
                try { return await write(...writeArgs); } catch (error) { actualError = error; throw error; }
              };
            }
            return handle;
          }));
          if (boundary.endsWith("permission")) patches.push(t.mock.method(fs, "chmod", async (target, ...args) => {
            if (target === (boundary === "temporary-permission" ? temporary : path)) {
              // This user is not root. Remove directory search permission so the
              // original chmod and owned cleanup really fail with EACCES.
              assert.notEqual(process.getuid(), 0);
              await actual.chmod(dirname(path), 0o000);
              try { return await actual.chmod(target, ...args); }
              catch (error) { actualError = error; throw error; }
            }
            return actual.chmod(target, ...args);
          }));
          patches.push(t.mock.method(fs, "rename", async (source, target) => {
            if (boundary === "rename" && source === temporary) await actual.rm(temporary);
            try { const result = await actual.rename(source, target); renamed = true; return result; }
            catch (error) { actualError = error; throw error; }
          }));
          syncBuiltinESMExports();
          let failure;
          try { await product.publishChromeBrowserRuntimeDescriptor(value, path); }
          catch (error) { failure = error; }
          finally {
            await actual.chmod(dirname(path), 0o700);
            for (const patch of patches.reverse()) patch.mock.restore();
            syncBuiltinESMExports();
          }
          assert.ok(actualError, `${boundary} must reach a real failed FS call`);
          if (failure instanceof AggregateError) assert.equal(failure.errors[0], actualError);
          else assert.equal(failure, actualError);
          if (boundary === "final-permission") {
            assert.equal(renamed, true);
            assert.equal((await observed.actualRead()).generation, value.generation, "failed ACL is not a promise of zero FS effects");
            assert.ok(failure instanceof AggregateError, "original and cleanup EACCES are retained");
          } else if (boundary === "write" || boundary === "rename") {
            await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
          }
          await product.publishChromeBrowserRuntimeDescriptor(descriptor(`generation-after-${boundary}`), path);
          console.log(`A01 F1 FS evidence: ${JSON.stringify({ boundary, code: actualError.code, renamed, aggregate: failure instanceof AggregateError })}`);
        }
        await fs.writeFile(path, "test-invalid-json");
        await assert.rejects(product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-cas"), path,
          { expectedGeneration: "generation-cas" }), SyntaxError);
        await assert.rejects(product.removeChromeBrowserRuntimeDescriptor("generation-cas", path), SyntaxError);
        await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-valid"), path);
        assert.equal(await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-stale"), path,
          { expectedGeneration: "generation-stale" }), "superseded");
        assert.equal((await observed.actualRead()).generation, "generation-valid");
        await product.removeChromeBrowserRuntimeDescriptor("generation-valid", path);
        assert.equal(await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-missing"), path,
          { expectedGeneration: "generation-valid" }), "superseded");
        assert.equal(await observed.actualRead(), undefined);
      } else if (caseName === "coordination-cleanup") {
        let originalError, rollbackError, closeError;
        const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
        const rollbackPatch = t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
          const result = exec.call(this, sql);
          if (sql === "ROLLBACK") {
            try { exec.call(this, sql); } catch (error) { rollbackError = error; throw error; }
          }
          return result;
        });
        const closePatch = t.mock.method(DatabaseSync.prototype, "close", function () {
          close.call(this);
          try { close.call(this); } catch (error) { closeError = error; throw error; }
        });
        try {
          let failure;
          try { await withDescriptorCoordination(path, {}, async () => {
            try { await actual.chmod(join(dirname(path), "missing-owned-file"), 0o600); }
            catch (error) { originalError = error; throw error; }
          }); } catch (error) { failure = error; }
          assert.ok(failure instanceof AggregateError);
          assert.deepEqual(failure.errors, [originalError, rollbackError, closeError]);
          assert.equal(originalError.code, "ENOENT");
          assert.equal(rollbackError.code, "ERR_SQLITE_ERROR");
          assert.equal(closeError.code, "ERR_INVALID_STATE");
        } finally { closePatch.mock.restore(); rollbackPatch.mock.restore(); }
        const inode = (await fs.stat(sidecar)).ino;
        let rejected = false;
        try { await withDescriptorCoordination(path, {}, async () => { throw undefined; }); }
        catch (error) { rejected = true; assert.equal(error, undefined); }
        assert.equal(rejected, true);
        await product.publishChromeBrowserRuntimeDescriptor(descriptor("generation-after-cleanup"), path);
        assert.equal((await fs.stat(sidecar)).ino, inode);
        console.log("A01 F1 cleanup evidence: original/rollback/close retained, throw undefined rejects, successor lock acquired");
      }
    } finally { observed.releaseAll(); observed.restore(); }
  });
}
