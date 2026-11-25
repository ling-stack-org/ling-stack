import type { ControlPlaneEvent } from "./run-types.js";

export type AppServerStateKind = "verify_plan" | "verify_operation" | "review_submission" | "review_finding_update"
  | "simplify_submission" | "external_federation" | "work_item_creation" | "work_item_acceptance" | "work_item_control"
  | "replay_identity" | "handoff" | "handoff_goal_transfer" | "authorization_grant" | "work_item_target" | "work_item_source"
  | "github_delivery" | "github_delivery_current" | "github_queue_intent" | "work_item_thread"
  | "automation_coordination" | "coordination_round" | "coordination_automation_run" | "project_instruction_update"
  | "change_recovery_request" | "change_transfer_request" | "github_intake_pending" | "github_intake_receipt" | "github_intake_dispatch"
  | "work_item_workflow" | "work_item_plan_change" | "native_intake_receipt" | "work_item_stage_message_delivery"
  | "work_item_deliberation_workflow" | "work_item_deliberation_application"
  | "work_item_stage_tool_receipt" | "work_item_stage_ballot" | "work_item_device_binding" | "work_item_device_receipt";

export interface AppServerStateRecord {
  readonly workspaceId: string;
  readonly kind: AppServerStateKind;
  readonly recordId: string;
  readonly revision: number;
  readonly idempotencyKey?: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PutAppServerStateInput {
  readonly workspaceId?: string;
  readonly kind: AppServerStateKind;
  readonly recordId: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
  /** When set, return the committed row for this key so the caller can validate the request identity. */
  readonly replayByIdempotencyKey?: boolean;
  readonly payload: unknown;
}

export interface PutAppServerStateResult {
  readonly status: "created" | "updated" | "replayed";
  readonly record: AppServerStateRecord;
  readonly event?: ControlPlaneEvent;
}
