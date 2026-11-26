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
    const held = store.getWorkItem(created.workItem.id)!;
    assert.equal(held.control.state, "blocked");
    assert.deepEqual(held.control.unresolvedEffectIds, [bound.binding.bindingId]);
    assert.equal(held.control.recoveryOwner, "device_fabric");

    const reconciliation = {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: held.revision, ownerHostId: "edge-host-1", ownerRouteGeneration: 4,
      workUnitId: "work-unit-1", attemptId: "attempt-1", status: "succeeded", resultRef: "journal:readback-1", reconciled: true,
      idempotencyKey: "receipt-reconciled",
    } as const;
    assert.throws(() => recordWorkItemDeviceReceipt(store, { ...reconciliation, reconciled: false }, now, cwd),
      { code: "device_receipt_conflict" });
    assert.throws(() => bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-1", graphNodeId: "node-1", graphRevision: 4,
      ownerHostId: "edge-host-2", ownerRouteGeneration: 5, workUnitId: "work-unit-2",
      expectedWorkItemRevision: held.revision, idempotencyKey: "rebind-before-reconciliation",
    }, now, cwd), { code: "resume_blocked" });
    const settled = recordWorkItemDeviceReceipt(store, reconciliation, "2026-11-25T00:00:02.000Z", cwd);
    assert.equal(settled.binding.status, "succeeded");
    assert.equal(settled.binding.receipt?.reconciled, true);
    assert.equal(recordWorkItemDeviceReceipt(store, reconciliation, "2026-11-25T00:00:03.000Z", cwd).replayed, true);
    assert.deepEqual(store.getWorkItem(created.workItem.id)?.control.unresolvedEffectIds, []);
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
    status: "unknown", resultRef: "owner:outcome-uncertain", idempotencyKey: "first-result",
  } as const;
  database.exec(`CREATE TRIGGER fail_device_receipt_event BEFORE INSERT ON control_plane_events
    WHEN NEW.action = 'work_item.device.updated'
    BEGIN SELECT RAISE(ABORT, 'fixture_device_receipt_event_failed'); END`);
  assert.throws(() => recordWorkItemDeviceReceipt(store, receipt, now, cwd), /fixture_device_receipt_event_failed/u);
  assert.deepEqual(readWorkItemDeviceBindings(store, workItem.id), [binding]);
  assert.equal(store.findAppServerStateByIdempotencyKey("work_item_device_receipt", receipt.idempotencyKey), undefined);
  assert.deepEqual(store.getWorkItem(workItem.id), workItem);
  database.exec("DROP TRIGGER fail_device_receipt_event");
  const committed = recordWorkItemDeviceReceipt(store, receipt, now, cwd);
  assert.equal(committed.binding.status, "unknown");
  assert.equal(committed.event?.action, "work_item.device.updated");
  assert.deepEqual(recordWorkItemDeviceReceipt(store, receipt, now, cwd), { binding: committed.binding, replayed: true });
  const held = store.getWorkItem(workItem.id)!;
  assert.equal(committed.event?.data.workItemRevision, held.revision);
  const cancel = { actorId: "operator", expectedRevision: held.revision, expectedControlGeneration: held.control.generation,
    reason: "Settle the original device effect", idempotencyKey: "cancel-held-device" };
  const cancelling = store.applyWorkItemControl(workItem.id, "cancel", cancel, now);
  assert.equal(cancelling.status, "applied");
  assert.equal(cancelling.workItem.control.state, "cancelling");
  const reconciled = recordWorkItemDeviceReceipt(store, { ...receipt, expectedWorkItemRevision: cancelling.workItem.revision,
    status: "cancelled", reconciled: true, resultRef: "owner:cancelled", idempotencyKey: "cancel-readback" }, now, cwd);
  assert.equal(reconciled.binding.status, "cancelled");
  const replay = store.applyWorkItemControl(workItem.id, "cancel", cancel, now);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.workItem.control.state, "cancelled");
  assert.deepEqual(replay.workItem.control.unresolvedEffectIds, []);
  assert.deepEqual(replay.receipt, cancelling.receipt);
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
    recordWorkItemDeviceReceipt(store, {
      workItemId: created.workItem.id, bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
      expectedWorkItemRevision: created.workItem.revision, ownerHostId: "host-a", ownerRouteGeneration: 1, workUnitId: "unit-a",
      status: "failed", resultRef: "owner:confirmed-failure", idempotencyKey: "known-result",
    }, now, cwd);
    const replacement = bindWorkItemDevice(store, {
      workItemId: created.workItem.id, graphId: "graph-2", graphNodeId: "node-1", graphRevision: 2,
      ownerHostId: "host-b", ownerRouteGeneration: 2, workUnitId: "unit-b", expectedWorkItemRevision: created.workItem.revision,
      idempotencyKey: "replacement",
    }, now, cwd);
    assert.equal(replacement.binding.revision, 2);
    assert.equal(replacement.binding.status, "bound");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("upgrading an earlier device ledger restores its unconfirmed effect in Work Item control", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-work-item-device-upgrade-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  const old = createSqliteRunStore(cwd);
  const { workItem } = old.createWorkItem({ sourceType: "device_task_graph_node", sourceId: "graph/legacy", title: "Inspect device" }, now);
  const { binding } = bindWorkItemDevice(old, {
    workItemId: workItem.id, graphId: "graph", graphNodeId: "legacy", graphRevision: 1, ownerHostId: "legacy-edge",
    ownerRouteGeneration: 1, workUnitId: "legacy-unit", expectedWorkItemRevision: workItem.revision, idempotencyKey: "legacy-binding",
  }, now, cwd);
  const receipt = { receiptId: "legacy-receipt", bindingRevision: binding.revision, receivedAt: now, ownerHostId: binding.ownerHostId,
    ownerRouteGeneration: binding.ownerRouteGeneration, workUnitId: binding.workUnitId, status: "unknown", resultRef: "legacy:unconfirmed",
    reconciled: false } as const;
  old.putAppServerState({ kind: "work_item_device_receipt", recordId: receipt.receiptId, expectedRevision: 0, idempotencyKey: "legacy-receipt-key",
    payload: { bindingId: binding.bindingId, bindingRevision: binding.revision, receipt } }, now);
  const { databasePath } = old.paths;
  old.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM schema_migrations WHERE name = ?").run("project_unresolved_work_item_device_effects");
  database.close();

  const current = createSqliteRunStore(cwd);
  try {
    const held = current.getWorkItem(workItem.id)!;
    assert.equal(held.control.state, "blocked");
    assert.deepEqual(held.control.unresolvedEffectIds, [binding.bindingId]);
    assert.equal(current.resumeWorkItem(workItem.id, { actorId: "operator", expectedRevision: held.revision,
      expectedControlGeneration: held.control.generation, idempotencyKey: "legacy-resume" }, now)?.control.state, "blocked");
    assert.deepEqual(readWorkItemDeviceBindings(current, workItem.id)[0]?.receipt, receipt);
  } finally { current.close(); }
});
