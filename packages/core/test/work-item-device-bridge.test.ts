import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkItemDeviceBridgeError,
  bindWorkItemDevice,
  createSqliteRunStore,
  readWorkItemDeviceBindings,
  recordWorkItemDeviceReceipt,
} from "../dist/index.js";

const now = "2026-11-25T00:00:00.000Z";

test("device Work Item bindings and owner receipts survive restart without turning unknown into success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-work-item-device-"));
  let store = createSqliteRunStore(cwd);
  try {
    const created = store.createWorkItem({ sourceType: "device_task_graph_node", sourceId: "graph-1/node-1", title: "Inspect device" }, now);
    const bound = bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-1", graphNodeId: "node-1", graphRevision: 3,
      ownerHostId: "edge-host-1", ownerRouteGeneration: 4, workUnitId: "work-unit-1", attemptId: "attempt-1",
      expectedWorkItemRevision: created.workItem.revision, idempotencyKey: "bind-1",
    }, now, cwd);
    assert.equal(bound.replayed, false);
    assert.equal(bound.binding.status, "bound");
    assert.equal(readWorkItemDeviceBindings(store, created.workItem.id)[0]?.ownerHostId, "edge-host-1");

    const unknown = recordWorkItemDeviceReceipt(store, {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "edge-host-1", ownerRouteGeneration: 4,
      workUnitId: "work-unit-1", attemptId: "attempt-1", status: "unknown", resultRef: "journal:unknown", reconciled: false,
      idempotencyKey: "receipt-unknown",
    }, "2026-11-25T00:00:01.000Z", cwd);
    assert.equal(unknown.binding.status, "unknown");
    store.close();
    store = createSqliteRunStore(cwd);
    const reopened = readWorkItemDeviceBindings(store, created.workItem.id);
    assert.equal(reopened[0]?.status, "unknown");
    assert.equal(reopened[0]?.receipt?.reconciled, false);

    const settled = recordWorkItemDeviceReceipt(store, {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "edge-host-1", ownerRouteGeneration: 4,
      workUnitId: "work-unit-1", attemptId: "attempt-1", status: "succeeded", resultRef: "journal:readback-1", reconciled: true,
      idempotencyKey: "receipt-reconciled",
    }, "2026-11-25T00:00:02.000Z", cwd);
    assert.equal(settled.binding.status, "succeeded");
    assert.equal(settled.binding.receipt?.reconciled, true);
    assert.equal(recordWorkItemDeviceReceipt(store, {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "edge-host-1", ownerRouteGeneration: 4,
      workUnitId: "work-unit-1", attemptId: "attempt-1", status: "succeeded", resultRef: "journal:readback-1", reconciled: true,
      idempotencyKey: "receipt-reconciled",
    }, "2026-11-25T00:00:03.000Z", cwd).replayed, true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("device receipt ownership and graph revisions are fenced", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-work-item-device-fence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const created = store.createWorkItem({ sourceType: "device_task_graph_node", sourceId: "graph-2/node-1", title: "Inspect device" }, now);
    const bound = bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-2", graphNodeId: "node-1", graphRevision: 1,
      ownerHostId: "host-a", ownerRouteGeneration: 1, workUnitId: "unit-a", expectedWorkItemRevision: created.workItem.revision,
      idempotencyKey: "bind-a",
    }, now, cwd);
    assert.throws(() => recordWorkItemDeviceReceipt(store, {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "host-b", ownerRouteGeneration: 1, workUnitId: "unit-a",
      status: "succeeded", resultRef: "wrong-owner", idempotencyKey: "bad-owner",
    }, now, cwd), (error: unknown) => error instanceof WorkItemDeviceBridgeError && error.code === "device_receipt_conflict");
    assert.throws(() => bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-2", graphNodeId: "node-1", graphRevision: 1,
      ownerHostId: "host-b", ownerRouteGeneration: 2, workUnitId: "unit-b", expectedWorkItemRevision: created.workItem.revision,
      idempotencyKey: "bind-stale",
    }, now, cwd), (error: unknown) => error instanceof WorkItemDeviceBridgeError && error.code === "stale_revision");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
