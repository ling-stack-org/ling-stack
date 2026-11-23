import { createHash } from "node:crypto";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

export const WORK_ITEM_STAGE_TOOL = "work_item_coordination";

export function stageCoordinationRequestKey(runId: string, attemptId: string, key: string): string {
  return "stage-attempt:" + createHash("sha256").update(JSON.stringify([runId, attemptId, key])).digest("hex");
}

export function stageCoordinationToolKey(toolCallId: string): string {
  return "work-item-coordination:" + createHash("sha256").update(toolCallId).digest("hex");
}

export function stageCoordinationToolReceiptId(runId: string, attemptId: string, toolCallId: string): string {
  return runId + ":" + attemptId + ":" + stageCoordinationToolKey(toolCallId);
}

export interface WorkItemStageToolReceipt {
  readonly source: RuntimeAttemptFenceV1 & { readonly runId: string };
  readonly workItemId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly requestDigest: string;
  readonly outcome:
    | { readonly status: "read" }
    | { readonly status: "rejected"; readonly code: string }
    | { readonly status: "recorded"; readonly recordId: string };
}
