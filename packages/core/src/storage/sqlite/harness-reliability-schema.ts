import type { HarnessProjectionDomain } from "../../harness/reliability.js";

/** Explicit metadata columns: no request snapshots, tool results or artifact bodies. */
export const harnessProjectionSources: Readonly<Record<HarnessProjectionDomain, {
  readonly table: string;
  readonly columns: string;
  readonly extraEpochTables: readonly string[];
}>> = {
  continuation: {
    table: "runner_continuations",
    columns: "id, run_id, NULL AS root_run_id, work_unit_id, state, revision, updated_at",
    extraEpochTables: [],
  },
  tool_execution: {
    table: "harness_tool_executions",
    columns: "id, run_id, NULL AS root_run_id, work_unit_id, state, revision, updated_at",
    extraEpochTables: ["harness_tool_execution_artifacts"],
  },
  evaluation: {
    table: "run_evaluations",
    columns: "id, run_id, root_run_id, NULL AS work_unit_id, state, revision, updated_at",
    extraEpochTables: [
      "run_evaluation_grades",
      "run_evaluation_tasks",
      "run_evaluation_task_attempts",
      "run_evaluation_task_results",
      "run_evaluation_qa_namespace",
      "run_evaluation_qa_batches",
      "run_evaluation_qa_enrollments",
      "run_evaluation_qa_requests",
      "run_evaluation_human_intents",
      "run_evaluation_human_events",
      "run_evaluation_human_heads",
    ],
  },
  delegation: {
    table: "delegation_steps",
    columns: "id, parent_run_id AS run_id, root_run_id, NULL AS work_unit_id, state, revision, updated_at",
    extraEpochTables: ["delegation_messages"],
  },
};

export const HARNESS_PROJECTION_EMPTY_DIGEST = "0".repeat(64);

export function harnessReliabilityIdentity(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || value.includes("\0")) {
    throw new TypeError("harness_reliability_identity_invalid");
  }
  return value;
}

export function harnessReliabilityTime(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new TypeError("harness_reliability_time_invalid");
  return value;
}

export function harnessReliabilityLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw new TypeError("harness_reliability_limit_invalid");
  }
  return value as number;
}
