import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

    const reconciliation = {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "edge-host-1", ownerRouteGeneration: 4,
      workUnitId: "work-unit-1", attemptId: "attempt-1", status: "succeeded", resultRef: "journal:readback-1", reconciled: true,
      idempotencyKey: "receipt-reconciled",
    } as const;
    assert.throws(() => recordWorkItemDeviceReceipt(store, { ...reconciliation, reconciled: false }, now, cwd),
      { code: "device_receipt_conflict" });
    assert.throws(() => bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-1", graphNodeId: "node-1", graphRevision: 4,
      ownerHostId: "edge-host-2", ownerRouteGeneration: 5, workUnitId: "work-unit-2",
      expectedWorkItemRevision: created.workItem.revision, idempotencyKey: "rebind-before-reconciliation",
    }, now, cwd), { code: "device_binding_conflict" });
    const settled = recordWorkItemDeviceReceipt(store, reconciliation, "2026-11-25T00:00:02.000Z", cwd);
    assert.equal(settled.binding.status, "succeeded");
    assert.equal(settled.binding.receipt?.reconciled, true);
    assert.equal(recordWorkItemDeviceReceipt(store, reconciliation, "2026-11-25T00:00:03.000Z", cwd).replayed, true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("device receipt, binding projection and event roll back together and retry under the original key", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-work-item-device-transaction-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const { workItem } = store.createWorkItem({ sourceType: "device_task_graph_node", sourceId: "graph/node", title: "Inspect device" }, now);
  const input = { workItemId: workItem.id, graphId: "graph", graphNodeId: "node", graphRevision: 1,
    ownerHostId: "owner", ownerRouteGeneration: 1, workUnitId: "unit-a", expectedWorkItemRevision: workItem.revision, idempotencyKey: "first-binding" };
  const { binding } = bindWorkItemDevice(store, input, now, cwd);
  const receipt = {
    workItemId: workItem.id, bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    expectedWorkItemRevision: workItem.revision, ownerHostId: "owner", ownerRouteGeneration: 1, workUnitId: "unit-a",
    status: "failed", resultRef: "owner:confirmed-failure", idempotencyKey: "first-result",
  } as const;
  database.exec(`CREATE TRIGGER fail_device_receipt_event BEFORE INSERT ON control_plane_events
    WHEN NEW.action = 'work_item.device.updated'
    BEGIN SELECT RAISE(ABORT, 'fixture_device_receipt_event_failed'); END`);
  assert.throws(() => recordWorkItemDeviceReceipt(store, receipt, now, cwd), /fixture_device_receipt_event_failed/u);
  assert.deepEqual(readWorkItemDeviceBindings(store, workItem.id), [binding]);
  assert.equal(store.findAppServerStateByIdempotencyKey("work_item_device_receipt", receipt.idempotencyKey), undefined);
  database.exec("DROP TRIGGER fail_device_receipt_event");
  const committed = recordWorkItemDeviceReceipt(store, receipt, now, cwd);
  assert.equal(committed.binding.status, "failed");
  assert.equal(committed.event?.action, "work_item.device.updated");
  assert.deepEqual(recordWorkItemDeviceReceipt(store, receipt, now, cwd), { binding: committed.binding, replayed: true });
  assert.equal(bindWorkItemDevice(store, { ...input, graphRevision: 2, workUnitId: "unit-b", idempotencyKey: "replacement" }, now, cwd).binding.revision, 2);
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
