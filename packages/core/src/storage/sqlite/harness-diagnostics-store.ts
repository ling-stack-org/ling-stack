import type { SQLOutputValue } from "node:sqlite";
import type {
  HarnessDiagnosticAttemptV1,
  HarnessDiagnosticCursorV1,
  HarnessDiagnosticPageV1,
  HarnessDiagnosticQueryV1,
  HarnessDiagnosticScopeV1,
} from "@ling-stack/contracts";
import type { HarnessDiagnosticsStore } from "../../harness/store-ports.js";
import { mapHarnessDiagnostic, mapHarnessDiagnosticAttempt, mapHarnessDiagnosticScope } from "./harness-diagnostics-mappers.js";
import { harnessDiagnosticIdentity, validateHarnessDiagnosticQuery, HarnessDiagnosticsStoreError } from "./harness-diagnostics-validation.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Bounded metadata-only diagnostics, with a scope-bound live keyset and no execution authority. */
export class SqliteHarnessDiagnosticsStore implements HarnessDiagnosticsStore {
  constructor(private readonly context: SqliteStoreContext) {}

  queryWorkUnitHarnessDiagnosticScope(workUnitId: string): HarnessDiagnosticScopeV1 | undefined {
    const unit = harnessDiagnosticIdentity(workUnitId);
    const row = this.context.database.prepare(`
      SELECT unit.id AS work_unit_id, unit.linked_run_id, run.id AS run_id, run.work_unit_id AS run_work_unit_id
      FROM work_units AS unit LEFT JOIN run_sessions AS run ON run.id = unit.linked_run_id
      WHERE unit.id = ?
    `).get(unit);
    return row ? mapHarnessDiagnosticScope(row as Record<string, SQLOutputValue>) : undefined;
  }

  getHarnessDiagnosticAttempt(workUnitId: string, attemptId: string): HarnessDiagnosticAttemptV1 {
    const unit = harnessDiagnosticIdentity(workUnitId);
    const attempt = harnessDiagnosticIdentity(attemptId);
    const row = this.context.database.prepare(`
      SELECT id, work_unit_id, runtime_instance_id, fencing_token, status FROM work_unit_attempts WHERE id = ?
    `).get(attempt);
    return mapHarnessDiagnosticAttempt(row as Record<string, SQLOutputValue> | undefined, unit, attempt);
  }

  queryHarnessDiagnostics(runId: string, workUnitId: string, input?: HarnessDiagnosticQueryV1): HarnessDiagnosticPageV1 {
    const run = harnessDiagnosticIdentity(runId);
    const unit = harnessDiagnosticIdentity(workUnitId);
    const { limit, cursor } = validateHarnessDiagnosticQuery(run, unit, input);
    return readSqliteSnapshot(this.context.database, () => {
      this.assertScope(run, unit);
      const statement = this.context.database.prepare(selectSql(Boolean(cursor)));
      statement.setReadBigInts(true);
      const branchParameters = cursor ? [run, unit, cursor.createdAt, cursor.kind, cursor.id] : [run, unit];
      const rows = statement.all(...Array.from({ length: 4 }, () => branchParameters).flat(), limit + 1);
      // The probe is validated too: corruption must be visible, not concealed behind pagination.
      const mapped = rows.map((row) => mapHarnessDiagnostic(row as Record<string, SQLOutputValue>));
      const items = mapped.slice(0, limit);
      const last = items.at(-1);
      const nextCursor: HarnessDiagnosticCursorV1 | undefined = mapped.length > limit && last
        ? { runId: run, workUnitId: unit, createdAt: last.createdAt, kind: last.kind, id: last.id } : undefined;
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  private assertScope(runId: string, workUnitId: string): void {
    const scope = this.context.database.prepare(`
      SELECT run.work_unit_id AS run_work_unit_id, unit.linked_run_id AS linked_run_id
      FROM run_sessions AS run JOIN work_units AS unit ON unit.id = ?
      WHERE run.id = ?
    `).get(workUnitId, runId);
    if (!scope || scope.run_work_unit_id !== workUnitId || scope.linked_run_id !== runId) {
      throw new HarnessDiagnosticsStoreError("diagnostics.lineage_mismatch", "Harness diagnostics Run and WorkUnit lineage does not match.");
    }
  }
}

/** All branches select only approved metadata. Existing lineage indexes bound the read to one Run. */
function selectSql(after: boolean): string {
  const keyset = (kind: string, table: string) => after
    ? `AND (${table}.created_at COLLATE BINARY, '${kind}' COLLATE BINARY, ${table}.id COLLATE BINARY) < (?, ?, ?)` : "";
  return `
    SELECT
      'continuation' AS kind, id, schema_version, run_id, work_unit_id, revision, created_at, updated_at,
      NULL AS root_run_id, claim_owner, claim_expires_at, next_attempt_at, state, failure_code,
      source_attempt_id, target_attempt_id, origin, strategy, runner_id, generation, failure_detail_artifact_id, completed_at,
      NULL AS attempt_id, NULL AS tool_call_id, NULL AS tool_name, NULL AS executor_kind, NULL AS continuation_id,
      NULL AS delegation_step_id, NULL AS supersedes_execution_id, NULL AS policy_snapshot_artifact_id,
      NULL AS approval_id, NULL AS sandbox_profile_id, NULL AS execution_started_at, NULL AS execution_finished_at,
      NULL AS parent_attempt_id, NULL AS workflow_id, NULL AS workflow_step_id,
      NULL AS parent_delegation_step_id, NULL AS child_run_id, NULL AS required, NULL AS depth
    FROM runner_continuations AS continuation
    WHERE run_id = ? AND work_unit_id = ? ${keyset("continuation", "continuation")}
    UNION ALL
    SELECT
      'tool_execution' AS kind, id, schema_version, run_id, work_unit_id, revision, created_at, updated_at,
      NULL AS root_run_id, claim_owner, claim_expires_at, next_attempt_at, state, failure_code,
      NULL AS source_attempt_id, NULL AS target_attempt_id, NULL AS origin, NULL AS strategy,
      NULL AS runner_id, NULL AS generation, NULL AS failure_detail_artifact_id, NULL AS completed_at,
      attempt_id, tool_call_id, tool_name, executor_kind, continuation_id, delegation_step_id, supersedes_execution_id,
      policy_snapshot_artifact_id, approval_id, sandbox_profile_id, execution_started_at, execution_finished_at,
      NULL AS parent_attempt_id, NULL AS workflow_id, NULL AS workflow_step_id,
      NULL AS parent_delegation_step_id, NULL AS child_run_id, NULL AS required, NULL AS depth
    FROM harness_tool_executions AS tool_execution
    WHERE run_id = ? AND work_unit_id = ? ${keyset("tool_execution", "tool_execution")}
    UNION ALL
    SELECT
      'evaluation' AS kind, evaluation.id, evaluation.schema_version, evaluation.run_id,
      evaluation_run.work_unit_id AS work_unit_id, evaluation.revision, evaluation.created_at, evaluation.updated_at,
      evaluation.root_run_id, evaluation.claim_owner, evaluation.claim_expires_at, evaluation.next_attempt_at,
      evaluation.state, evaluation.failure_code,
      NULL AS source_attempt_id, NULL AS target_attempt_id, NULL AS origin, NULL AS strategy,
      NULL AS runner_id, NULL AS generation, NULL AS failure_detail_artifact_id, evaluation.completed_at,
      NULL AS attempt_id, NULL AS tool_call_id, NULL AS tool_name, NULL AS executor_kind, NULL AS continuation_id,
      NULL AS delegation_step_id, NULL AS supersedes_execution_id, NULL AS policy_snapshot_artifact_id,
      NULL AS approval_id, NULL AS sandbox_profile_id, NULL AS execution_started_at, NULL AS execution_finished_at,
      NULL AS parent_attempt_id, NULL AS workflow_id, NULL AS workflow_step_id,
      NULL AS parent_delegation_step_id, NULL AS child_run_id, NULL AS required, NULL AS depth
    FROM run_evaluations AS evaluation
    JOIN run_sessions AS evaluation_run ON evaluation_run.id = evaluation.run_id
    JOIN work_units AS evaluation_unit ON evaluation_unit.id = evaluation_run.work_unit_id
    WHERE evaluation.run_id = ? AND evaluation_run.work_unit_id = ?
      AND evaluation_unit.linked_run_id = evaluation.run_id ${keyset("evaluation", "evaluation")}
    UNION ALL
    SELECT
      'delegation' AS kind, delegation.id, delegation.schema_version, delegation.parent_run_id AS run_id,
      delegation_run.work_unit_id AS work_unit_id, delegation.revision, delegation.created_at, delegation.updated_at,
      delegation.root_run_id, NULL AS claim_owner, NULL AS claim_expires_at, NULL AS next_attempt_at,
      delegation.state, delegation.failure_code,
      NULL AS source_attempt_id, NULL AS target_attempt_id, NULL AS origin, NULL AS strategy,
      NULL AS runner_id, NULL AS generation, NULL AS failure_detail_artifact_id, delegation.completed_at,
      NULL AS attempt_id, NULL AS tool_call_id, NULL AS tool_name, NULL AS executor_kind, NULL AS continuation_id,
      NULL AS delegation_step_id, NULL AS supersedes_execution_id, NULL AS policy_snapshot_artifact_id,
      NULL AS approval_id, NULL AS sandbox_profile_id, NULL AS execution_started_at, NULL AS execution_finished_at,
      delegation.parent_attempt_id, delegation.workflow_id, delegation.workflow_step_id,
      delegation.parent_delegation_step_id, delegation.child_run_id, delegation.required, delegation.depth
    FROM delegation_steps AS delegation
    JOIN run_sessions AS delegation_run ON delegation_run.id = delegation.parent_run_id
    JOIN work_units AS delegation_unit ON delegation_unit.id = delegation_run.work_unit_id
    WHERE delegation.parent_run_id = ? AND delegation_run.work_unit_id = ?
      AND delegation_unit.linked_run_id = delegation.parent_run_id ${keyset("delegation", "delegation")}
    ORDER BY created_at COLLATE BINARY DESC, kind COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT ?
  `;
}
