import type { ApprovalRequest, ApprovalStatus, DeviceCapabilityBroker, SqliteDeviceSupportStore } from "@ling-stack/core";
import { DeviceBrokerError } from "@ling-stack/core";

type QueuedApproval = NonNullable<ReturnType<SqliteDeviceSupportStore["getQueuedApproval"]>>;

export function createDeviceApprovalQueue(
  store: SqliteDeviceSupportStore, broker: DeviceCapabilityBroker, now: () => string,
) {
  return {
    get(id: string): ApprovalRequest | undefined {
      const item = store.getQueuedApproval(id, now());
      return item && projectApproval(item);
    },
    list(status: ApprovalStatus | undefined, limit: number): ApprovalRequest[] {
      return store.listQueuedApprovals(now(), status, limit).map(projectApproval);
    },
    async resolve(id: string, action: "approve" | "deny"): Promise<ApprovalRequest> {
      const item = store.getQueuedApproval(id, now());
      if (!item) throw new DeviceBrokerError("missing_target", "the queued device approval is unavailable");
      if (item.status === (action === "approve" ? "approved" : "denied")) return projectApproval(item);
      if (item.status !== "pending") throw new DeviceBrokerError("target_changed", "the queued device approval changed");
      if (action === "deny") {
        store.denyQueuedAction(id, now());
      } else {
        const proposal = store.getActionProposal(item.binding.taskId);
        if (!proposal || proposal.requestDigest !== item.binding.normalizedInputDigest
          || proposal.request.idempotencyKey !== item.idempotencyKey) {
          throw new DeviceBrokerError("target_changed", "the approved device action changed");
        }
        await broker.execute({ ...proposal.request, approvalId: id, approval: item.binding }, undefined,
          { requireCurrentProposal: true, resolveQueuedApproval: true });
      }
      const resolved = store.getQueuedApproval(id, now());
      if (!resolved) throw new DeviceBrokerError("missing_target", "the queued device approval is unavailable");
      return projectApproval(resolved);
    },
  };
}

function projectApproval(item: QueuedApproval): ApprovalRequest {
  const { binding, payload, status } = item;
  return {
    id: binding.approvalId,
    deviceTaskId: binding.taskId,
    actionType: "device_action",
    risk: "medium",
    title: "Reload Home Assistant integration",
    description: `Reload integration ${payload.entryId}, then verify that ${payload.entityId} is available.`,
    payload,
    status,
    createdAt: item.createdAt,
    expiresAt: binding.expiresAt,
    ...(status === "pending" ? { availableDecisions: ["approve_once", "deny"] } : {}),
    ...(item.resolvedAt ? {
      resolvedAt: item.resolvedAt, resolvedBy: "local-user", decisionKind: status === "approved" ? "approve_once" : "deny",
    } : {}),
  };
}
