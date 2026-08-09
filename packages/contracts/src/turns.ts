export type LingTurnKind =
  | "initial_request"
  | "manual_followup"
  | "queued_followup"
  | "interrupt_redirect"
  | "workflow_step"
  | "external_work_update"
  | "automation_tick"
  | "review_queue_action";

export type LingTurnStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type LingTurnCreatedByActor = "local-user" | "system" | "teammate" | "automation";

export type LingTurnRunRole = "primary" | "retry" | "resume" | "repair" | "validation";

export interface LingTurn {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly kind: LingTurnKind;
  readonly status: LingTurnStatus;
  readonly title: string;
  readonly userInstruction: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly automationId?: string;
  readonly sourceItemId?: string;
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly createdByActor: LingTurnCreatedByActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface LingTurnRun {
  readonly turnId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly role: LingTurnRunRole;
  readonly createdAt: string;
}

export interface CreateLingTurnRequest {
  readonly id?: string;
  readonly kind: LingTurnKind;
  readonly title: string;
  readonly userInstruction: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly automationId?: string;
  readonly sourceItemId?: string;
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly createdByActor?: LingTurnCreatedByActor;
}

export interface LingThreadTurnsResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly turns: readonly LingTurn[];
  readonly runLinks: readonly LingTurnRun[];
}

export interface LingTurnMutationResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly turn: LingTurn;
  readonly runLinks: readonly LingTurnRun[];
}
