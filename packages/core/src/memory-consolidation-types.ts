import { randomUUID } from "node:crypto";
import type { MemorySourceRef } from "./memory-types.js";

export type MemoryConsolidationJobKind =
  | "private_chat_summary"
  | "channel_decision_summary"
  | "task_run_lesson"
  | "workspace_consolidation";

export type MemoryConsolidationJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MemoryConsolidationJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly status: MemoryConsolidationJobStatus;
  readonly createdCandidateIds: readonly string[];
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryConsolidationJobInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly status?: MemoryConsolidationJobStatus;
  readonly createdCandidateIds?: readonly string[];
  readonly errorMessage?: string;
}

export interface UpdateMemoryConsolidationJobInput {
  readonly status?: MemoryConsolidationJobStatus;
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly createdCandidateIds?: readonly string[];
  readonly errorMessage?: string | null;
}

export interface ListMemoryConsolidationJobsOptions {
  readonly workspaceId?: string;
  readonly kind?: MemoryConsolidationJobKind;
  readonly status?: MemoryConsolidationJobStatus;
  readonly limit?: number;
}

export function createMemoryConsolidationJobId(): string {
  return `memory_consolidation_job_${randomUUID().replaceAll("-", "")}`;
}
