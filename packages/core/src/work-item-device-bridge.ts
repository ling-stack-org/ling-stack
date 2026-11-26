import { createHash } from "node:crypto";
import type {
  LingAppServerWorkItemDeviceBinding,
  LingAppServerWorkItemDeviceBindParams,
  LingAppServerWorkItemDeviceReceipt,
  LingAppServerWorkItemDeviceReceiptParams,
} from "@ling-stack/contracts";
import type { AppendControlPlaneEventInput, ControlPlaneEvent, RunStore } from "./run-types.js";
import type { WorkItem } from "./work-item-types.js";

type DeviceBindingRecord = { readonly binding: LingAppServerWorkItemDeviceBinding };
type DeviceReceiptRecord = {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly receipt: LingAppServerWorkItemDeviceReceipt;
};

export class WorkItemDeviceBridgeError extends Error {
  constructor(readonly code:
    | "work_item_not_found"
    | "invalid_params"
    | "device_binding_conflict"
    | "stale_revision"
    | "resume_blocked"
    | "device_receipt_conflict", message: string) {
    super(message);
    this.name = "WorkItemDeviceBridgeError";
  }
}

export type WorkItemDeviceMutationStore = Pick<RunStore, "getWorkItem" | "getAppServerState" | "findAppServerStateByIdempotencyKey"
  | "listAppServerState" | "putAppServerState"> & {
    updateDeviceEffect(workItem: WorkItem, bindingId: string, unresolved: boolean, now: string): number;
  };
type WorkItemDeviceMutation = { readonly binding: LingAppServerWorkItemDeviceBinding; readonly replayed: boolean; readonly event?: ControlPlaneEvent };

export function deviceBindingId(workItemId: string, graphId: string, graphNodeId: string): string {
  return `work_item_device_binding_${digest([workItemId, graphId, graphNodeId])}`;
}

export function readWorkItemDeviceBindings(
  store: Pick<WorkItemDeviceMutationStore, "listAppServerState">, workItemId: string,
): readonly LingAppServerWorkItemDeviceBinding[] {
  const bindings = store.listAppServerState("work_item_device_binding").flatMap(record => {
    const value = record.payload as Partial<DeviceBindingRecord>;
    return value.binding?.workItemId === workItemId ? [value.binding as LingAppServerWorkItemDeviceBinding] : [];
  });
  const receipts = store.listAppServerState("work_item_device_receipt").flatMap(record => {
    const value = record.payload as Partial<DeviceReceiptRecord>;
    return value.bindingId && value.receipt ? [value as DeviceReceiptRecord] : [];
  });
  return bindings.map(binding => {
    const latest = receipts
      .filter(entry => entry.bindingId === binding.bindingId && entry.bindingRevision === binding.revision)
      .sort((left, right) => left.receipt.receivedAt.localeCompare(right.receipt.receivedAt) || left.receipt.receiptId.localeCompare(right.receipt.receiptId))
      .at(-1)?.receipt;
    return latest && (!binding.receipt || latest.receivedAt > binding.receipt.receivedAt)
      ? { ...binding, status: latest.status, updatedAt: latest.receivedAt, receipt: latest } : binding;
  }).sort((left, right) => left.bindingId.localeCompare(right.bindingId));
}

export function bindWorkItemDevice(
  store: Pick<RunStore, "writeWorkItemDeviceState">,
  input: LingAppServerWorkItemDeviceBindParams,
  now: string,
  cwd: string,
): WorkItemDeviceMutation {
  validateBindingInput(input);
  return store.writeWorkItemDeviceState(current => commitDeviceBinding(current, input, now, cwd));
}

function commitDeviceBinding(store: WorkItemDeviceMutationStore, input: LingAppServerWorkItemDeviceBindParams, now: string, cwd: string): WorkItemDeviceMutation {
  const workItem = store.getWorkItem(input.workItemId);
  if (!workItem) throw new WorkItemDeviceBridgeError("work_item_not_found", "The Work Item is unavailable.");
  const bindingId = deviceBindingId(input.workItemId, input.graphId, input.graphNodeId);
  const state = store.getAppServerState("work_item_device_binding", bindingId);
  const existing = state?.payload as DeviceBindingRecord | undefined;
  const current = existing && projectBindingWithLatestReceipt(store, existing.binding);
  if (current && state?.idempotencyKey === input.idempotencyKey && !sameBindingRequest(current, input)) {
    throw new WorkItemDeviceBridgeError("device_binding_conflict", "The binding key belongs to a different device node.");
  }
  if (current && sameBindingRequest(current, input)) return { binding: current, replayed: true };
  if (workItem.revision !== input.expectedWorkItemRevision) throw new WorkItemDeviceBridgeError("stale_revision", "The Work Item revision changed.");
  if (workItem.control.state !== "active" || workItem.control.unresolvedEffectIds.length || workItem.holds.some(hold => hold.blocksNewAdmission)
    || ["done", "cancelled", "archived", "superseded"].includes(workItem.status)) {
    throw new WorkItemDeviceBridgeError("resume_blocked", "The Work Item is held and cannot admit a device action.");
  }
  if (current) {
    if (input.graphRevision <= current.graphRevision) throw new WorkItemDeviceBridgeError("stale_revision", "The device graph revision is stale.");
    if (!["failed", "cancelled"].includes(current.status)) {
      throw new WorkItemDeviceBridgeError("device_binding_conflict", "The device node already has an active binding.");
    }
  }
  const binding: LingAppServerWorkItemDeviceBinding = {
    bindingId, workItemId: input.workItemId, graphId: input.graphId, graphNodeId: input.graphNodeId,
    graphRevision: input.graphRevision, ownerHostId: input.ownerHostId, ownerRouteGeneration: input.ownerRouteGeneration,
    workUnitId: input.workUnitId, ...(input.attemptId ? { attemptId: input.attemptId } : {}), status: "bound",
    revision: (existing?.binding.revision ?? 0) + 1, boundAt: existing?.binding.boundAt ?? now, updatedAt: now,
  };
  const result = store.putAppServerState({
    kind: "work_item_device_binding", recordId: bindingId, expectedRevision: state?.revision ?? 0,
    idempotencyKey: input.idempotencyKey, payload: { binding } satisfies DeviceBindingRecord,
  }, now, deviceBridgeEvent(cwd, workItem.workspaceId, input.workItemId, binding, workItem.revision));
  if (!result) throw new WorkItemDeviceBridgeError("stale_revision", "The device binding changed before it was committed.");
  return { binding: projectBindingWithLatestReceipt(store, binding), replayed: result.status === "replayed", ...(result.event ? { event: result.event } : {}) };
}

export function recordWorkItemDeviceReceipt(
  store: Pick<RunStore, "writeWorkItemDeviceState">,
  input: LingAppServerWorkItemDeviceReceiptParams,
  now: string,
  cwd: string,
): WorkItemDeviceMutation {
  validateReceiptInput(input);
  return store.writeWorkItemDeviceState(current => commitDeviceReceipt(current, input, now, cwd));
}

function commitDeviceReceipt(store: WorkItemDeviceMutationStore, input: LingAppServerWorkItemDeviceReceiptParams, now: string, cwd: string): WorkItemDeviceMutation {
  const workItem = store.getWorkItem(input.workItemId);
  if (!workItem) throw new WorkItemDeviceBridgeError("work_item_not_found", "The Work Item is unavailable.");
  const state = store.getAppServerState("work_item_device_binding", input.bindingId);
  const saved = state?.payload as DeviceBindingRecord | undefined;
  if (!saved || saved.binding.workItemId !== input.workItemId) throw new WorkItemDeviceBridgeError("device_binding_conflict", "The device binding is unavailable.");
  const binding = projectBindingWithLatestReceipt(store, saved.binding);
  if (binding.revision !== input.expectedBindingRevision) {
    throw new WorkItemDeviceBridgeError("stale_revision", "The device binding revision changed.");
  }
  if (binding.ownerHostId !== input.ownerHostId || binding.ownerRouteGeneration !== input.ownerRouteGeneration
    || binding.workUnitId !== input.workUnitId || input.attemptId !== binding.attemptId) {
    throw new WorkItemDeviceBridgeError("device_receipt_conflict", "The receipt does not belong to the current owner host and WorkUnit.");
  }
  const prior = store.findAppServerStateByIdempotencyKey("work_item_device_receipt", input.idempotencyKey);
  if (prior) {
    const payload = prior.payload as DeviceReceiptRecord;
    if (payload.bindingId !== input.bindingId || payload.bindingRevision !== input.expectedBindingRevision
      || !sameReceiptRequest(payload.receipt, input)) {
      throw new WorkItemDeviceBridgeError("device_receipt_conflict", "The receipt key belongs to a different result.");
    }
    return { binding, replayed: true };
  }
  if (workItem.revision !== input.expectedWorkItemRevision) throw new WorkItemDeviceBridgeError("stale_revision", "The Work Item revision changed.");
  if (binding.receipt && (binding.status !== "unknown" || input.status === "unknown" || input.reconciled !== true)) {
    throw new WorkItemDeviceBridgeError("device_receipt_conflict", "The current device result already has a receipt. An unknown result requires owner reconciliation.");
  }
  const receipt = receiptFromInput(input, now, binding.revision);
  const receiptRecord: DeviceReceiptRecord = { bindingId: binding.bindingId, bindingRevision: binding.revision, receipt };
  const receiptId = `work_item_device_receipt_${digest([input.bindingId, input.idempotencyKey])}`;
  const savedReceipt = store.putAppServerState({ kind: "work_item_device_receipt", recordId: receiptId,
    expectedRevision: 0, idempotencyKey: input.idempotencyKey, payload: receiptRecord }, now);
  if (!savedReceipt) throw new WorkItemDeviceBridgeError("device_receipt_conflict", "The receipt was committed concurrently.");
  const nextBinding = { ...binding, status: input.status, updatedAt: now, receipt } satisfies LingAppServerWorkItemDeviceBinding;
  const workItemRevision = input.status === "unknown" || binding.status === "unknown"
    ? store.updateDeviceEffect(workItem, binding.bindingId, input.status === "unknown", now) : workItem.revision;
  const updated = store.putAppServerState({ kind: "work_item_device_binding", recordId: binding.bindingId,
    expectedRevision: state!.revision,
    payload: { binding: nextBinding } satisfies DeviceBindingRecord }, now,
    deviceBridgeEvent(cwd, workItem.workspaceId, input.workItemId, nextBinding, workItemRevision));
  if (!updated) throw new WorkItemDeviceBridgeError("stale_revision", "The device binding changed while the receipt was being projected.");
  return { binding: nextBinding, replayed: false,
    ...(updated.event ? { event: updated.event } : {}) };
}

function sameReceiptRequest(receipt: LingAppServerWorkItemDeviceReceipt, input: LingAppServerWorkItemDeviceReceiptParams): boolean {
  return receipt.bindingRevision === input.expectedBindingRevision && receipt.ownerHostId === input.ownerHostId
    && receipt.ownerRouteGeneration === input.ownerRouteGeneration && receipt.workUnitId === input.workUnitId
    && receipt.attemptId === input.attemptId && receipt.status === input.status && receipt.resultRef === input.resultRef
    && receipt.reconciled === (input.reconciled === true);
}

function projectBindingWithLatestReceipt(store: Pick<WorkItemDeviceMutationStore, "listAppServerState">,
  binding: LingAppServerWorkItemDeviceBinding): LingAppServerWorkItemDeviceBinding {
  return readWorkItemDeviceBindings(store, binding.workItemId).find(item => item.bindingId === binding.bindingId) ?? binding;
}

function sameBindingRequest(binding: LingAppServerWorkItemDeviceBinding, input: LingAppServerWorkItemDeviceBindParams): boolean {
  return binding.workItemId === input.workItemId && binding.graphId === input.graphId && binding.graphNodeId === input.graphNodeId
    && binding.graphRevision === input.graphRevision && binding.ownerHostId === input.ownerHostId
    && binding.ownerRouteGeneration === input.ownerRouteGeneration && binding.workUnitId === input.workUnitId && binding.attemptId === input.attemptId;
}

function receiptFromInput(input: LingAppServerWorkItemDeviceReceiptParams, now: string, bindingRevision: number): LingAppServerWorkItemDeviceReceipt {
  return { receiptId: `device_receipt_${digest([input.bindingId, input.idempotencyKey, input.resultRef])}`, bindingRevision,
    ownerHostId: input.ownerHostId, ownerRouteGeneration: input.ownerRouteGeneration, workUnitId: input.workUnitId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}), status: input.status, resultRef: input.resultRef, receivedAt: now,
    reconciled: input.reconciled === true };
}

function validateBindingInput(input: LingAppServerWorkItemDeviceBindParams): void {
  const fields = [input.workItemId, input.graphId, input.graphNodeId, input.ownerHostId, input.workUnitId, input.idempotencyKey];
  if (fields.some(value => !value.trim() || value.length > 256) || !Number.isSafeInteger(input.graphRevision) || input.graphRevision < 1
    || !Number.isSafeInteger(input.ownerRouteGeneration) || input.ownerRouteGeneration < 1 || input.expectedWorkItemRevision < 1) {
    throw new WorkItemDeviceBridgeError("invalid_params", "Supply bounded graph, owner and WorkUnit identities.");
  }
}

function validateReceiptInput(input: LingAppServerWorkItemDeviceReceiptParams): void {
  const fields = [input.workItemId, input.bindingId, input.ownerHostId, input.workUnitId, input.idempotencyKey];
  if (fields.some(value => !value.trim() || value.length > 256) || !Number.isSafeInteger(input.ownerRouteGeneration) || input.ownerRouteGeneration < 1
    || input.expectedWorkItemRevision < 1 || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 1
    || !["succeeded", "failed", "cancelled", "unknown"].includes(input.status) || !input.resultRef.trim() || input.resultRef.length > 512) {
    throw new WorkItemDeviceBridgeError("invalid_params", "Supply a bounded terminal device receipt.");
  }
}

function deviceBridgeEvent(cwd: string, workspaceId: string, workItemId: string, binding: LingAppServerWorkItemDeviceBinding,
  workItemRevision: number): AppendControlPlaneEventInput {
  return { workspaceId, cwd, domain: "work_items", entityType: "work_item", entityId: workItemId,
    action: "work_item.device.updated", idempotencyKey: `${binding.bindingId}:${binding.revision}:${binding.status}`,
    data: { workItemId, bindingId: binding.bindingId, graphId: binding.graphId, graphNodeId: binding.graphNodeId,
      graphRevision: binding.graphRevision, ownerHostId: binding.ownerHostId, workUnitId: binding.workUnitId,
      status: binding.status, revision: binding.revision, workItemRevision } };
}

function digest(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
