import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { connect, Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { assertA01BrokerHandshake, bounded, createA01Broker, descriptorPathForA01, observeA01Descriptor,
  runA01Child, signal } from "./support/a01-browser-descriptor-fixture.mjs";

if (!process.env.LING_A01_CASE) {
  for (const name of ["refresh-close", "startup-host", "startup-listen", "startup-publication",
    "superseded-refresh", "late-refresh-error", "late-refresh-cleanup-error", "close-error-retry", "handshake-boundaries"]) {
    test(`A01 broker lifecycle: ${name}`, { timeout: 50_000 }, () => runA01Child(name, import.meta.url));
  }
} else if (process.env.LING_A01_CASE === "refresh-close") {
  test("A01 actual refresh-close child", { timeout: 35_000 }, async t => {
    assert.equal(process.env.LING_A01_CASE, "refresh-close");
    console.log("A01 child entered: refresh-close");
    const observed = observeA01Descriptor(t, descriptorPathForA01());
    const f = await createA01Broker({ refreshMs: 250 });
    try {
      await f.broker.start();
      const started = f.broker.descriptor();
      const gate = observed.renameGate(started.generation);
      await bounded(gate.entered.promise, "real refresh prepared before rename");
      let closeReturned = false;
      const close = f.broker.close().then(() => { closeReturned = true; observed.record("close-returned"); });
      // The deadline yields a correctly draining implementation; it is NOT lock-contention evidence.
      try { await bounded(close, "close held by publication", 500); }
      catch (error) { assert.equal(error.message, "A01 fixture deadline: close held by publication"); }
      const returnedWhileRenameHeld = closeReturned;
      gate.release.complete();
      await bounded(observed.published.promise, "actual released refresh rename and final chmod");
      await bounded(close, "close after released refresh");
      await new Promise(done => setImmediate(done));
      const after = await observed.actualRead();
      const closedPort = await bounded(new Promise(done => {
        const socket = connect({ host: "127.0.0.1", port: started.port });
        socket.once("connect", () => { socket.destroy(); done(false); });
        socket.once("error", () => { socket.destroy(); done(true); });
      }), "former owned port probe");
      console.log(`A01 R1 lineage: ${JSON.stringify({ returnedWhileRenameHeld, descriptorRevived: Boolean(after),
        generation: after?.generation, closedPort, descriptorPath: descriptorPathForA01(), workspace: f.workspace, events: observed.events })}`);
      assert.equal(closedPort, true);
      assert.equal(returnedWhileRenameHeld, false, "close must not succeed before an entered refresh settles");
      assert.equal(after, undefined, "a released old refresh must not revive a closed broker descriptor");
      assert.equal(f.broker.descriptor(), undefined);
    } finally { observed.releaseAll(); await f.close(); observed.restore(); }
  });
} else {
  const name = process.env.LING_A01_CASE;
  test(`A01 actual ${name} child`, { timeout: 35_000 }, async t => {
    console.log(`A01 child entered: ${name}`);
    const path = descriptorPathForA01(), observed = observeA01Descriptor(t, path);
    const actual = { access: fs.access, readFile: fs.readFile, rename: fs.rename, rm: fs.rm };
    let fixture, other, socket, expectedCloseError;
    const patches = [], releases = [];
    try {
      if (name.startsWith("startup-")) {
        fixture = await createA01Broker();
        const entered = signal(), release = signal(); releases.push(release);
        let consumed = false;
        if (name === "startup-host") patches.push(t.mock.method(fs, "access", async (target, ...args) => {
          try { return await actual.access(target, ...args); }
          finally {
            if (target === join(fixture.workspace, "missing-owned-native-host") && !consumed) {
              consumed = true; entered.complete(); await release.promise;
            }
          }
        }));
        if (name === "startup-listen") {
          const listen = Server.prototype.listen;
          patches.push(t.mock.method(Server.prototype, "listen", function (...args) {
            const callback = args.pop();
            return listen.call(this, ...args, () => {
              consumed = true; entered.complete();
              void release.promise.then(callback);
            });
          }));
        }
        syncBuiltinESMExports();
        const publication = name === "startup-publication" ? observed.renameGate() : undefined;
        const first = fixture.broker.start(), repeated = fixture.broker.start();
        assert.equal(repeated, first, "start acquires single-flight before its first await");
        await bounded(publication ? publication.entered.promise : entered.promise, "actual startup boundary");
        const closing = fixture.broker.close();
        assert.equal(fixture.broker.close(), closing, "repeated close shares the same result");
        const next = fixture.broker.start(), nextRepeated = fixture.broker.start();
        let closeReturned = false; closing.then(() => { closeReturned = true; });
        await new Promise(done => setTimeout(done, 50));
        assert.equal(closeReturned, false);
        const closeReturnedWhileHeld = closeReturned;
        if (publication) publication.release.complete(); else release.complete();
        await bounded(Promise.all([first, closing]), "captured startup drains before successor");
        // Do not hold a real listen callback for the successor too.
        for (const patch of patches.splice(0).reverse()) patch.mock.restore();
        syncBuiltinESMExports();
        await bounded(Promise.all([next, nextRepeated]), "queued successor single-flight");
        const successor = fixture.broker.descriptor(), after = await observed.actualRead();
        assert.equal(after.generation, successor.generation);
        assert.equal(observed.events.filter(event => event.kind === "rename-complete").length,
          name === "startup-publication" ? 2 : 1, "closing startup cannot install a timer or duplicate publisher");
        await assertA01BrokerHandshake(successor);
        console.log(`A01 B2 actual evidence: ${JSON.stringify({ boundary: name, closeReturnedWhileHeld,
          successorGeneration: successor.generation, successorPort: successor.port, publications: observed.events.filter(event => event.kind === "rename-complete").length })}`);
      } else if (name === "superseded-refresh") {
        const root = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
        fixture = await createA01Broker({ workspace: join(root, "a"), refreshMs: 250 });
        other = await createA01Broker({ workspace: join(root, "b") });
        await fixture.broker.start();
        const first = fixture.broker.descriptor();
        socket = await assertA01BrokerHandshake(first, { keepOpen: true });
        await other.broker.start();
        const successor = other.broker.descriptor(), gate = observed.readGate(successor.generation);
        let reads = 0;
        const read = fs.readFile;
        patches.push(t.mock.method(fs, "readFile", async (target, ...args) => {
          if (target === path) reads++;
          return read(target, ...args);
        }));
        syncBuiltinESMExports();
        await bounded(gate.entered.promise, "old refresh really reads successor generation");
        gate.release.complete();
        await new Promise(done => setTimeout(done, 600));
        assert.equal(reads, 1, "superseded owner stops refreshing instead of grabbing discovery back");
        assert.deepEqual(await observed.actualRead(), successor, "generation/token/port/TTL do not regress");
        assert.deepEqual(fixture.broker.descriptor(), first, "unpublished TTL candidate never replaces local descriptor");
        assert.equal(socket.destroyed, false, "old legal native transport remains connected");
        assert.equal(fixture.controller.snapshot(fixture.workspace).connected, true);
        await assertA01BrokerHandshake(successor);
        const refreshReads = reads;
        await fixture.broker.close();
        assert.deepEqual(await observed.actualRead(), successor);
        console.log(`A01 L4 actual evidence: ${JSON.stringify({ refreshReads, preservedTransport: true,
          oldGeneration: first.generation, discoveredGeneration: successor.generation })}`);
      } else if (name === "handshake-boundaries") {
        let clock = Date.now();
        fixture = await createA01Broker({ now: () => clock });
        await fixture.broker.start();
        const descriptor = fixture.broker.descriptor();
        await assertA01BrokerHandshake(descriptor);
        for (const [hello, expectedCode] of [
          [{ hostVersion: "0.0.1" }, "version_incompatible"],
          [{ extensionVersion: "0.1.0" }, "version_incompatible"],
          [{ token: "test-wrong-a01-native-token" }, "descriptor_invalid"],
          [{ cwd: fixture.workspace }, "native_protocol_invalid"],
          [{ origin: "https://example.invalid/" }, "origin_forbidden"],
        ]) await assertA01BrokerHandshake(descriptor, { hello, expectedCode });
        clock = descriptor.expiresAtEpochMs;
        await assertA01BrokerHandshake(descriptor, { expectedCode: "descriptor_invalid" });
        console.log("A01 R1 real socket evidence: valid handshake plus token/workspace/origin/version/expiry refusals");
      } else if (name === "close-error-retry") {
        fixture = await createA01Broker();
        await fixture.broker.start();
        const first = fixture.broker.descriptor(), gate = observed.readGate(first.generation);
        let removeError;
        const rm = fs.rm;
        patches.push(t.mock.method(fs, "rm", async (target, ...args) => {
          try { return await rm(target, ...args); }
          catch (error) { if (target === path) removeError = error; throw error; }
        }));
        syncBuiltinESMExports();
        const closing = fixture.broker.close();
        const closed = closing.then(() => ({ resolved: true }), error => ({ error }));
        assert.equal(fixture.broker.close(), closing);
        await bounded(gate.entered.promise, "close captured real generation before rm");
        await actual.rename(path, `${path}.fault-backup`); await fs.mkdir(path);
        gate.release.complete();
        const result = await bounded(closed, "failed close settles honestly");
        assert.equal(removeError.code, "ERR_FS_EISDIR");
        assert.equal(result.error, removeError);
        await assert.rejects(fixture.broker.close(), error => error === removeError);
        await fs.rmdir(path); await actual.rename(`${path}.fault-backup`, path);
        await fixture.broker.start();
        const successor = fixture.broker.descriptor();
        assert.notEqual(successor.generation, first.generation);
        assert.deepEqual(await observed.actualRead(), successor);
        await assertA01BrokerHandshake(successor);
        await fixture.broker.close();
        assert.equal(await observed.actualRead(), undefined);
        console.log(`A01 close retry evidence: ${JSON.stringify({ originalErrorCode: removeError.code,
          repeatedCloseSameError: true, successorGeneration: successor.generation, successorClosed: true })}`);
      } else {
        assert.ok(name === "late-refresh-error" || name === "late-refresh-cleanup-error");
        fixture = await createA01Broker({ refreshMs: 250 });
        await fixture.broker.start();
        const first = fixture.broker.descriptor(), renameGate = observed.renameGate(first.generation);
        const renameFailed = signal(), removeFailed = signal();
        let originalError, cleanupError;
        const rename = fs.rename, rm = fs.rm;
        patches.push(t.mock.method(fs, "rename", async (...args) => {
          try { return await rename(...args); }
          catch (error) { originalError = error; expectedCloseError = error; renameFailed.complete(); throw error; }
        }));
        patches.push(t.mock.method(fs, "rm", async (target, ...args) => {
          try { return await rm(target, ...args); }
          catch (error) { if (target === path) { cleanupError = error; removeFailed.complete(); } throw error; }
        }));
        syncBuiltinESMExports();
        await bounded(renameGate.entered.promise, "real refresh rename entered");
        // Install this only after refresh CAS has read its generation. The
        // gate is for failure cleanup, not for the earlier normal CAS read.
        const cleanupGate = observed.readGate(first.generation);
        await actual.rm(`${path}.${first.generation}.tmp`);
        renameGate.release.complete();
        await bounded(renameFailed.promise, "real refresh rename ENOENT");
        await bounded(cleanupGate.entered.promise, "failed callback captured own cleanup generation");
        let next;
        if (name === "late-refresh-error") next = fixture.broker.start();
        else {
          await actual.rename(path, `${path}.fault-backup`); await fs.mkdir(path);
        }
        cleanupGate.release.complete();
        if (name === "late-refresh-cleanup-error") {
          await bounded(removeFailed.promise, "actual rm rejects owned descriptor directory");
          await fs.rmdir(path); await actual.rename(`${path}.fault-backup`, path);
          await bounded((async () => {
            while (fixture.broker.descriptor()) await new Promise(done => setImmediate(done));
          })(), "old lifecycle cleanup settled");
          next = fixture.broker.start();
        }
        await bounded(next, "new lifecycle after failed refresh");
        const successor = fixture.broker.descriptor();
        assert.notEqual(successor.generation, first.generation);
        await assertA01BrokerHandshake(successor);
        assert.deepEqual(await observed.actualRead(), successor);
        for (const patch of patches.splice(0).reverse()) patch.mock.restore(); syncBuiltinESMExports();
        const close = fixture.broker.close();
        assert.equal(fixture.broker.close(), close);
        let failure;
        try { await close; } catch (error) { failure = error; }
        assert.equal(originalError.code, "ENOENT");
        if (cleanupError) {
          assert.ok(failure instanceof AggregateError);
          assert.deepEqual(failure.errors, [originalError, cleanupError]);
        } else assert.equal(failure, originalError);
        expectedCloseError = failure;
        assert.equal(fixture.broker.descriptor(), undefined);
        assert.equal(await observed.actualRead(), undefined);
        console.log(`A01 B3 actual evidence: ${JSON.stringify({ originalCode: originalError.code,
          cleanupCode: cleanupError?.code, successorGeneration: successor.generation, successorHandshake: true,
          preservedHistoricalError: true })}`);
      }
    } finally {
      for (const release of releases) release.complete(); observed.releaseAll(); socket?.destroy();
      for (const patch of patches.reverse()) patch.mock.restore(); syncBuiltinESMExports();
      try { await fixture?.close(); } catch (error) { assert.equal(error, expectedCloseError); }
      await other?.close(); observed.restore();
    }
  });
}
