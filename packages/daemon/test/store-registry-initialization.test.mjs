import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

test("synchronous Store initialization failure closes the real SQLite Store", async (t) => {
  const failure = new Error("fixture synchronous initialization failed after its first SQLite read");
  const fixture = await createRegistryFixture(t, (_cwd, store) => {
    assert.deepEqual(store.listRuns({ limit: 1 }), []);
    throw failure;
  });

  assert.throws(() => fixture.registry.getStore(fixture.cwd), error => error === failure);
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].closeCalls, 1);
  assert.equal(fixture.records[0].closed, true);
  assert.throws(() => fixture.records[0].store.listRuns({ limit: 1 }));
});

test("same-workspace recovery dispatch retries initialization with a fresh Store after synchronous failure", async (t) => {
  const failure = new Error("fixture synchronous recovery initialization failed");
  let initializationCalls = 0;
  const dispatchedStores = [];
  const fixture = await createRegistryFixture(t, (_cwd, store) => {
    initializationCalls += 1;
    assert.deepEqual(store.listRuns({ limit: 1 }), []);
    if (initializationCalls === 1) throw failure;
    dispatchedStores.push(store);
  });

  assert.throws(() => fixture.registry.getStore(fixture.cwd), error => error === failure);
  const failed = fixture.records[0].store;
  const recovered = fixture.registry.getStore(fixture.cwd);
  assert.equal(fixture.records.length, 2, "a cached failed Store must not satisfy a recovery retry");
  assert.equal(initializationCalls, 2);
  assert.notEqual(recovered, failed);
  assert.deepEqual(dispatchedStores, [recovered]);
  assert.deepEqual(recovered.listRuns({ limit: 1 }), []);
  assert.equal(fixture.registry.getStore(fixture.cwd), recovered);
  assert.equal(fixture.records.length, 2);
  assert.equal(initializationCalls, 2);

  fixture.registry.closeAll();
  assert.deepEqual(fixture.records.map(record => record.closeCalls), [1, 1]);
});

test("synchronous initialization failure removes remembered real-run aliases for the failed Store", async (t) => {
  const failure = new Error("fixture initialization failed after remembering its run");
  const runId = "registry-initialization-run";
  let initializationCalls = 0;
  const fixture = await createRegistryFixture(t, (cwd, store) => {
    initializationCalls += 1;
    if (initializationCalls === 1) {
      const now = "2026-10-09T00:00:00.000Z";
      const channel = store.createChannel({ name: "Registry initialization fixture", boundPath: cwd }, now);
      const task = store.createTask({ channelId: channel.id, title: "Registry fixture", prompt: "Registry fixture" }, now);
      store.createRun({ id: runId, cwd, taskId: task.id, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: { id: task.id, title: task.title },
        providerSnapshot: { provider: "fixture", model: "fixture" },
        requestSnapshot: { cwd }, createdAt: now });
    }
    fixture.registry.rememberRun(runId, store);
    if (initializationCalls === 1) throw failure;
  });

  assert.throws(() => fixture.registry.getStore(fixture.cwd), error => error === failure);
  assert.equal(fixture.registry.findStoreForRun(runId), undefined);
  const recovered = fixture.registry.getStore(fixture.cwd);
  assert.notEqual(recovered, fixture.records[0].store);
  assert.equal(recovered.getRun(runId)?.id, runId);
  assert.equal(fixture.registry.findStoreForRun(runId), recovered);
});

test("a real Store close failure does not replace the synchronous initialization error", async (t) => {
  const failure = new Error("fixture original initialization failure");
  const cleanupFailure = new Error("fixture close failed after closing its SQLite database");
  const fixture = await createRegistryFixture(t, (_cwd, store) => {
    const close = store.close.bind(store);
    store.close = () => {
      close();
      throw cleanupFailure;
    };
    throw failure;
  });

  assert.throws(() => fixture.registry.getStore(fixture.cwd), error => error === failure);
  assert.equal(fixture.records[0].closeCalls, 1);
  assert.equal(fixture.records[0].closed, true);
  assert.throws(() => fixture.records[0].store.listRuns({ limit: 1 }));
});

async function createRegistryFixture(t, onStoreInitialized) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-store-registry-initialization-"));
  const records = [];
  const registry = new RunStoreRegistry(storeCwd => {
    assert.equal(storeCwd, cwd);
    const store = createSqliteRunStore(storeCwd);
    const close = store.close.bind(store);
    const record = { store, closeCalls: 0, closed: false };
    store.close = () => {
      record.closeCalls += 1;
      close();
      record.closed = true;
    };
    records.push(record);
    return store;
  }, { onStoreInitialized });

  t.after(async () => {
    // Also close the uncached failure path, so the old implementation's RED
    // cannot leave a real SQLite handle behind.
    try {
      registry.closeAll();
    } finally {
      for (const record of records) {
        if (!record.closed) record.store.close();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
  return { cwd, records, registry };
}
