import type { ChannelWorkflow, ChannelWorkflowStep } from "./workflows.js";

export interface WorkflowConflictRecoveryRequest {
  readonly roundId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly repairInstruction: string;
}

export interface WorkflowConflictRecoveryScope {
  readonly workflowId: string;
  readonly roundId: string;
  readonly generation: number;
}

/** A successor has its own generation 1. sequence counts recoveries, not round generations. */
export interface WorkflowConflictRecovery {
  readonly schemaVersion: 1;
  readonly recoveryId: string;
  readonly root: WorkflowConflictRecoveryScope;
  readonly sequence: number;
  readonly predecessor: WorkflowConflictRecoveryScope & { readonly revision: number; readonly inputsDigest: string };
  readonly successor: WorkflowConflictRecoveryScope & { readonly generation: 1 };
  readonly idempotencyKey: string;
  readonly repairInstruction: string;
  readonly requestDigest: string;
  readonly authorityDigest: string;
  readonly createdAt: string;
}

export interface WorkflowConflictRecoveryResponse {
  readonly recovery: WorkflowConflictRecovery;
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  /** planning is durable and retryable with the exact original request; GET never resumes it. */
  readonly phase: "planning" | "ready";
  readonly executionProfile: "pi_host_isolated_files_v1";
  readonly mode: "candidate_only";
  readonly requiresExplicitOrchestration: true;
}

export function parseWorkflowConflictRecoveryRequest(value: unknown): WorkflowConflictRecoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Conflict recovery requires an explicit request.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["roundId", "generation", "expectedRevision", "idempotencyKey", "repairInstruction"].includes(key))
    || typeof input.roundId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.roundId)
    || typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 1
    || typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.idempotencyKey)
    || typeof input.repairInstruction !== "string" || !input.repairInstruction.trim() || input.repairInstruction.length > 4000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.repairInstruction)) {
    throw new Error("Conflict recovery accepts only an exact round/generation/revision, an idempotency key and 1-4000 characters of repair instructions.");
  }
  return { roundId: input.roundId, generation: input.generation, expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey, repairInstruction: input.repairInstruction };
}
