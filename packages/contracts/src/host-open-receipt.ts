import { isChannelOperationRelativePathV1 } from "./channel-operation-bindings.js";

/**
 * A Host-issued launch receipt, never a model claim or a navigation grant.
 * Launch acceptance does not prove that a window rendered or became visible.
 */
export interface HostOpenLocalTargetReceiptV1 {
  readonly contractVersion: 1;
  readonly capabilityId: "host.open_local_target";
  readonly status: "launched";
  readonly path: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly approvalId: string;
  readonly receiptId: string;
  readonly launchedAt: string;
  readonly visibility: "unverified";
}

const keys = new Set(["contractVersion", "capabilityId", "status", "path", "runId", "attemptId",
  "toolCallId", "approvalId", "receiptId", "launchedAt", "visibility"]);

/** Validate the closed, bounded wire format. Authorization is checked separately. */
export function isHostOpenLocalTargetReceiptV1(value: unknown): value is HostOpenLocalTargetReceiptV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.size || Object.keys(record).some(key => !keys.has(key))
    || record.contractVersion !== 1 || record.capabilityId !== "host.open_local_target"
    || record.status !== "launched" || record.visibility !== "unverified"
    || !isChannelOperationRelativePathV1(record.path) || record.path.length > 4096
    || !["runId", "attemptId", "toolCallId", "approvalId", "receiptId"].every(key => identifier(record[key]))
    || typeof record.launchedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.launchedAt)) return false;
  const timestamp = Date.parse(record.launchedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === record.launchedAt;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
