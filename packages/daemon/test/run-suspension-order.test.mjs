import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import * as ordering from "../dist/runtime/run-suspension-order.js";
const { RunSuspensionOrder, runSuspensionOrderFor } = ordering;

function fixture() {
  const runs = new Map([ ["root", { id: "root", taskId: "task-root" }],
    ["child", { id: "child", taskId: "task-child", parentRunId: "root" }],
    ["grandchild", { id: "grandchild", taskId: "task-grandchild", parentRunId: "child" }] ]);
  return { runs, store: { getRun: id => runs.get(id) } };
}
const source = runId => ({ runId, workUnitId: `unit-${runId}`, attemptId: `attempt-${runId}`,
  runtimeInstanceId: "original-runtime", fencingToken: `fence-${runId}` });

test("leaf-first readiness and finalization are distinct and never wait on the source itself", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), child = order.capture(store, source("child")),
    grandchild = order.capture(store, source("grandchild"));
  await order.waitForDescendants(grandchild, "ready");
  let childReady = false, rootReady = false, finalized = false;
  const childWait = order.waitForDescendants(child, "ready").then(() => { childReady = true; });
  const rootWait = order.waitForDescendants(root, "ready").then(() => { rootReady = true; });
  const finalWait = order.waitForDescendants(root, "finished").then(() => { finalized = true; });
  await nextTick(); assert.equal(childReady, false); assert.equal(rootReady, false);
  order.ready(grandchild); await childWait;
  assert.equal(rootReady, false); order.ready(child); await rootWait;
  assert.equal(finalized, false, "safe boundary is not a stopped/finalized receipt");
  order.finish(grandchild); order.finish(child); await finalWait;
  order.finish(root);
});

test("a grandchild remains a descendant when its parent has no process-local handle", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), grandchild = order.capture(store, source("grandchild"));
  let resolved = false;
  const pending = order.waitForDescendants(root, "ready").then(() => { resolved = true; });
  await nextTick(); assert.equal(resolved, false);
  order.ready(grandchild); await pending;
  order.finish(grandchild); order.finish(root);
});

test("late captured descendants join an in-progress barrier", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), child = order.capture(store, source("child"));
  let resolved = false;
  const pending = order.waitForDescendants(root, "ready").then(() => { resolved = true; });
  const grandchild = order.capture(store, source("grandchild"));
  order.ready(child); await nextTick(); assert.equal(resolved, false);
  order.ready(grandchild); await pending;
  order.finish(grandchild); order.finish(child); order.finish(root);
});

test("blocked descendant cannot be forgotten, replaced or counted as stopped", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), child = order.capture(store, source("child"));
  const error = new Error("original Host effect remains unknown");
  order.block(child, error);
  await assert.rejects(order.waitForDescendants(root, "ready"), failure => failure === error);
  await assert.rejects(order.waitForDescendants(root, "finished"), failure => failure === error);
  assert.throws(() => order.finish(child), /source_blocked/);
  assert.throws(() => order.capture(store, { ...source("child"), attemptId: "replacement" }), /already_captured/);
});

test("Store ownership and retired handles isolate identical Run identifiers", async () => {
  const order = new RunSuspensionOrder(), first = fixture(), second = fixture();
  const root = order.capture(first.store, source("root")), foreignChild = order.capture(second.store, source("child"));
  await order.waitForDescendants(root, "ready");
  order.finish(root);
  const successor = order.capture(first.store, { ...source("root"), attemptId: "successor", fencingToken: "new-fence" });
  assert.throws(() => order.ready(root), /source_stale/);
  assert.throws(() => order.block(root, new Error("late callback")), /source_stale/);
  await order.waitForDescendants(successor, "finished");
  order.finish(successor); order.finish(foreignChild);
});

test("corrupt persisted ancestry is rejected rather than approximated from UI nesting", () => {
  const order = new RunSuspensionOrder(), { store, runs } = fixture();
  runs.set("root", { id: "root", taskId: "task-root", parentRunId: "grandchild" });
  assert.throws(() => order.capture(store, source("root")), /run_ancestry.cycle/);
});

test("one ActiveRuns owner shares an ordering coordinator and different owners do not", () => {
  const first = {}, second = {};
  assert.equal(runSuspensionOrderFor(first), runSuspensionOrderFor(first));
  assert.notEqual(runSuspensionOrderFor(first), runSuspensionOrderFor(second));
});

test("whole-tree completion includes every Store and late source, not just root readiness", async () => {
  const order = new RunSuspensionOrder(), first = fixture(), second = fixture();
  const root = order.capture(first.store, source("root"));
  let complete = false;
  const pending = order.waitForAllFinished().then(() => { complete = true; });
  const foreign = order.capture(second.store, source("root"));
  order.ready(root); await nextTick(); assert.equal(complete, false);
  order.finish(root); await nextTick(); assert.equal(complete, false);
  order.finish(foreign); await pending; assert.equal(complete, true);
  await order.waitForAllFinished();
});

test("a failed original source rejects the global barrier after live entries are gone", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), child = order.capture(store, source("child"));
  const failure = new Error("no authoritative stopped receipt");
  order.finish(root); order.block(child, failure);
  await assert.rejects(order.waitForAllFinished(), error => error === failure);
});

test("a ready source becoming blocked cannot authorize its parent's later begin-stop", async () => {
  const order = new RunSuspensionOrder(), { store } = fixture();
  const root = order.capture(store, source("root")), child = order.capture(store, source("child"));
  order.ready(child);
  const failure = new Error("drain failed after safe boundary");
  order.block(child, failure);
  await assert.rejects(order.waitForDescendants(root, "ready"), error => error === failure);
});
