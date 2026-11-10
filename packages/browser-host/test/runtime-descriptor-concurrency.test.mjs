import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import test, { mock } from "node:test";
import { assertA01BrokerHandshake, bounded, createA01Broker, descriptorPathForA01, observeA01Descriptor,
  runA01Child, signal, spawnA01Worker } from "../../daemon/test/support/a01-browser-descriptor-fixture.mjs";

const caseName = process.env.LING_A01_CASE;
if (!caseName) {
  for (const mode of ["same-process", "cross-process"]) test(`A01 generation fencing preserves successor (${mode})`,
    { timeout: 50_000 }, () => runA01Child(mode, import.meta.url));
} else if (caseName === "same-process") {
  test("A01 actual two-broker same-process child", { timeout: 35_000 }, async t => {
    console.log(`A01 child entered: ${caseName}`);
    const observed = observeA01Descriptor(t, descriptorPathForA01());
    const root = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    const a = await createA01Broker({ workspace: join(root, "a") });
    const b = await createA01Broker({ workspace: join(root, "b") });
    try {
      await a.broker.start();
      const gate = observed.readGate(a.broker.descriptor().generation);
      const closeA = a.broker.close();
      await bounded(gate.entered.promise, "A real descriptor bytes captured");
      const publishB = b.broker.start();
      const lane = await bounded(Promise.race([publishB.then(() => "publish-complete"),
        observed.contention.promise.then(() => "actual-lock-contention")]), "B publish or real contention");
      observed.record("release-A-read", { lane }); gate.release.complete();
      await bounded(Promise.all([closeA, publishB]), "both actual broker operations settle");
      const successor = b.broker.descriptor(), after = await observed.actualRead();
      await assertA01BrokerHandshake(successor);
      console.log(`A01 R2 lineage: ${JSON.stringify({ mode: caseName, lane, successorGeneration: successor.generation,
        publishedGeneration: after?.generation ?? null, successorPort: successor.port, successorHandshake: true,
        workspaces: [a.workspace, b.workspace], descriptorPath: descriptorPathForA01(), events: observed.events })}`);
      assert.equal(after?.generation, successor.generation, "A cleanup must not delete B's actually published descriptor");
      assert.equal(after?.port, successor.port);
    } finally { observed.releaseAll(); await a.close(); await b.close(); observed.restore(); }
  });
} else if (caseName === "cross-process") {
  test("A01 actual two-broker cross-process child", { timeout: 35_000 }, async t => {
    console.log(`A01 child entered: ${caseName}`);
    const observed = observeA01Descriptor(t, descriptorPathForA01());
    const root = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    const aWorkspace = join(root, "a"), bWorkspace = join(root, "b");
    await fs.mkdir(aWorkspace); await fs.mkdir(bWorkspace);
    const a = spawnA01Worker(import.meta.url, "worker-a", aWorkspace);
    let b;
    try {
      await a.wait("ready"); a.send({ kind: "close" });
      await a.wait("read-captured");
      b = spawnA01Worker(import.meta.url, "worker-b", bWorkspace);
      const firstB = await b.waitAny(["ready", "lock-contention"]);
      const lane = firstB.kind === "ready" ? "publish-complete" : "actual-lock-contention";
      a.send({ kind: "release-read" });
      await a.wait("closed"); const readyB = await b.wait("ready");
      const after = await observed.actualRead();
      if (after) await assertA01BrokerHandshake(after);
      console.log(`A01 R2 lineage: ${JSON.stringify({ mode: caseName, lane, successorGeneration: readyB.generation,
        publishedGeneration: after?.generation ?? null, successorPort: readyB.port, descriptorPath: descriptorPathForA01(),
        workspaces: [aWorkspace, bWorkspace], pids: [a.child.pid, b.child.pid] })}`);
      assert.equal(after?.generation, readyB.generation, "cross-process A cleanup must preserve B's actual generation");
      assert.equal(after?.port, readyB.port);
    } finally {
      a.send({ kind: "release-read" });
      for (const worker of [a, b].filter(Boolean)) {
        worker.send({ kind: "finish" });
        try { const exit = await bounded(worker.exited, "owned worker cleanup"); assert.deepEqual(exit, { code: 0, signal: null }); }
        catch (error) { worker.child.kill(); throw error; }
      }
      observed.restore();
    }
  });
} else {
  assert.ok(caseName === "worker-a" || caseName === "worker-b");
  console.log(`A01 worker entered: ${caseName}`);
  // Workers run directly under node with their own IPC channel, not under --test's channel.
  const mockContext = { mock, after(callback) { process.once("beforeExit", callback); } };
  const observed = observeA01Descriptor(mockContext, descriptorPathForA01());
  const finished = signal(); let gate, closePromise;
  const f = await createA01Broker();
  process.on("message", message => {
    if (message.kind === "release-read") gate?.release.complete();
    if (message.kind === "finish") { gate?.release.complete(); finished.complete(); }
    if (message.kind === "close" && !closePromise) {
      gate = observed.readGate(f.broker.descriptor().generation);
      gate.entered.promise.then(() => process.send({ kind: "read-captured" }));
      closePromise = f.broker.close().then(() => process.send({ kind: "closed" }));
    }
  });
  observed.contention.promise.then(evidence => process.send({ kind: "lock-contention", evidence }));
  try {
    await f.broker.start();
    process.send({ kind: "ready", generation: f.broker.descriptor().generation, port: f.broker.descriptor().port });
    await bounded(finished.promise, "worker finish", 30_000);
    if (closePromise) await closePromise;
  } finally { observed.releaseAll(); await f.close(); observed.restore(); process.disconnect(); }
}
