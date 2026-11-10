import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_EVALUATION_MIGRATION_VERSION = 137;
export const RUN_EVALUATION_MIGRATION_NAME = "create_run_evaluations";

export interface RunEvaluationMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

const requiredEvaluationColumns = [
  "id", "schema_version", "root_run_id", "run_id", "suite_id", "suite_version",
  "suite_artifact_id", "suite_digest", "case_id", "case_version", "case_artifact_id",
  "case_digest", "baseline_id", "baseline_version", "baseline_artifact_id", "baseline_digest",
  "candidate_artifact_id", "candidate_digest", "idempotency_key", "state", "claim_owner",
  "claim_token", "claim_expires_at", "next_attempt_at", "failure_code", "revision", "created_at",
  "updated_at", "completed_at",
] as const;

const requiredGradeColumns = [
  "id", "schema_version", "evaluation_id", "grader_type", "grader_id", "grader_version",
  "verdict", "score", "severity", "rationale_artifact_id", "raw_output_artifact_id",
  "cost_input_tokens", "cost_output_tokens", "cost_amount_micros", "latency_ms",
  "adjudication_status", "grade_digest", "created_at",
] as const;

const requiredIndexes = [
  "idx_run_evaluations_claimable",
  "idx_run_evaluations_lineage",
  "idx_run_evaluations_root_created",
  "idx_run_evaluations_idempotency",
  "idx_run_evaluation_grades_evaluation_created",
  "idx_run_evaluation_grades_grader_identity",
] as const;

const requiredTriggers = [
  "trg_run_evaluations_identity_immutable",
  "trg_run_evaluations_no_delete",
  "trg_run_evaluation_grades_no_update",
  "trg_run_evaluation_grades_no_delete",
] as const;

/** Creates immutable evaluation requests and append-only grade records. No historical scores are synthesized. */
export function applyRunEvaluationMigration(input: RunEvaluationMigrationInput): boolean {
  if (input.hasMigration(RUN_EVALUATION_MIGRATION_VERSION) && hasCompleteSchema(input.database)) {
    return false;
  }
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS run_evaluations (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        root_run_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        suite_id TEXT NOT NULL,
        suite_version TEXT NOT NULL,
        suite_artifact_id TEXT NOT NULL,
        suite_digest TEXT NOT NULL CHECK(length(suite_digest) = 64),
        case_id TEXT NOT NULL,
        case_version TEXT NOT NULL,
        case_artifact_id TEXT NOT NULL,
        case_digest TEXT NOT NULL CHECK(length(case_digest) = 64),
        baseline_id TEXT NOT NULL,
        baseline_version TEXT NOT NULL,
        baseline_artifact_id TEXT NOT NULL,
        baseline_digest TEXT NOT NULL CHECK(length(baseline_digest) = 64),
        candidate_artifact_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL CHECK(length(candidate_digest) = 64),
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'claimed', 'grading', 'completed', 'failed', 'cancelled')),
        claim_owner TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        next_attempt_at TEXT,
        failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
          'evaluation.grader_unavailable', 'evaluation.invalid_suite_version',
          'evaluation.baseline_missing', 'evaluation.lease_expired', 'evaluation.result_invalid'
        )),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(
          (state IN ('claimed', 'grading')
            AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
          OR
          (state NOT IN ('claimed', 'grading')
            AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
        ),
        CHECK(
          (state IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
          OR
          (state NOT IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL)
        ),
        CHECK(state <> 'completed' OR failure_code IS NULL),
        FOREIGN KEY(root_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY(suite_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(case_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(baseline_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(candidate_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_run_evaluations_claimable
        ON run_evaluations(state, next_attempt_at, claim_expires_at, id);
      CREATE INDEX IF NOT EXISTS idx_run_evaluations_lineage
        ON run_evaluations(run_id, suite_id, suite_version, case_id, case_version, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_run_evaluations_root_created
        ON run_evaluations(root_run_id, created_at DESC, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_evaluations_idempotency
        ON run_evaluations(idempotency_key);

      CREATE TABLE IF NOT EXISTS run_evaluation_grades (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        evaluation_id TEXT NOT NULL,
        grader_type TEXT NOT NULL CHECK(grader_type IN ('rule', 'model', 'human')),
        grader_id TEXT NOT NULL,
        grader_version TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('pass', 'fail', 'abstain', 'error')),
        score REAL CHECK(score IS NULL OR (score >= 0 AND score <= 1)),
        severity TEXT CHECK(severity IS NULL OR severity IN ('info', 'warning', 'error', 'critical')),
        rationale_artifact_id TEXT,
        raw_output_artifact_id TEXT,
        cost_input_tokens INTEGER CHECK(cost_input_tokens IS NULL OR cost_input_tokens >= 0),
        cost_output_tokens INTEGER CHECK(cost_output_tokens IS NULL OR cost_output_tokens >= 0),
        cost_amount_micros INTEGER CHECK(cost_amount_micros IS NULL OR cost_amount_micros >= 0),
        latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
        adjudication_status TEXT,
        grade_digest TEXT NOT NULL CHECK(length(grade_digest) = 64),
        created_at TEXT NOT NULL,
        FOREIGN KEY(evaluation_id) REFERENCES run_evaluations(id) ON DELETE RESTRICT,
        FOREIGN KEY(rationale_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(raw_output_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_run_evaluation_grades_evaluation_created
        ON run_evaluation_grades(evaluation_id, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_evaluation_grades_grader_identity
        ON run_evaluation_grades(evaluation_id, grader_type, grader_id, grader_version);

      CREATE TRIGGER IF NOT EXISTS trg_run_evaluations_identity_immutable
      BEFORE UPDATE OF
        root_run_id, run_id, suite_id, suite_version, suite_artifact_id, suite_digest,
        case_id, case_version, case_artifact_id, case_digest, baseline_id, baseline_version,
        baseline_artifact_id, baseline_digest, candidate_artifact_id, candidate_digest, idempotency_key
      ON run_evaluations
      WHEN
        OLD.root_run_id IS NOT NEW.root_run_id OR OLD.run_id IS NOT NEW.run_id
        OR OLD.suite_id IS NOT NEW.suite_id OR OLD.suite_version IS NOT NEW.suite_version
        OR OLD.suite_artifact_id IS NOT NEW.suite_artifact_id OR OLD.suite_digest IS NOT NEW.suite_digest
        OR OLD.case_id IS NOT NEW.case_id OR OLD.case_version IS NOT NEW.case_version
        OR OLD.case_artifact_id IS NOT NEW.case_artifact_id OR OLD.case_digest IS NOT NEW.case_digest
        OR OLD.baseline_id IS NOT NEW.baseline_id OR OLD.baseline_version IS NOT NEW.baseline_version
        OR OLD.baseline_artifact_id IS NOT NEW.baseline_artifact_id OR OLD.baseline_digest IS NOT NEW.baseline_digest
        OR OLD.candidate_artifact_id IS NOT NEW.candidate_artifact_id OR OLD.candidate_digest IS NOT NEW.candidate_digest
        OR OLD.idempotency_key IS NOT NEW.idempotency_key
      BEGIN
        SELECT RAISE(ABORT, 'run evaluation identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_run_evaluations_no_delete
      BEFORE DELETE ON run_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'run evaluations are durable records');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_run_evaluation_grades_no_update
      BEFORE UPDATE ON run_evaluation_grades
      BEGIN
        SELECT RAISE(ABORT, 'run evaluation grades are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_run_evaluation_grades_no_delete
      BEFORE DELETE ON run_evaluation_grades
      BEGIN
        SELECT RAISE(ABORT, 'run evaluation grades are append-only');
      END;
    `);
    assertPostconditions(input.database);
    if (!input.hasMigration(RUN_EVALUATION_MIGRATION_VERSION)) {
      input.recordMigration(RUN_EVALUATION_MIGRATION_VERSION, RUN_EVALUATION_MIGRATION_NAME);
    }
    if (!input.hasMigration(RUN_EVALUATION_MIGRATION_VERSION)) {
      throw new Error("Run evaluation migration marker postcondition failed.");
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function hasCompleteSchema(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    return true;
  } catch {
    return false;
  }
}

function assertPostconditions(database: DatabaseSync): void {
  const evaluationTable = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='run_evaluations'",
  ).get() as { readonly sql?: string } | undefined;
  const gradeTable = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='run_evaluation_grades'",
  ).get() as { readonly sql?: string } | undefined;
  if (!evaluationTable?.sql?.includes("candidate_digest") || !gradeTable?.sql?.includes("grade_digest")) {
    throw new Error("Run evaluation migration table postcondition failed.");
  }
  const evaluationColumns = new Set((database.prepare("PRAGMA table_info(run_evaluations)").all() as
    Array<{ readonly name: string }>).map((row) => row.name));
  const gradeColumns = new Set((database.prepare("PRAGMA table_info(run_evaluation_grades)").all() as
    Array<{ readonly name: string }>).map((row) => row.name));
  if (requiredEvaluationColumns.some((column) => !evaluationColumns.has(column))
    || requiredGradeColumns.some((column) => !gradeColumns.has(column))) {
    throw new Error("Run evaluation migration column postcondition failed.");
  }
  const indexes = new Set([
    ...(database.prepare("PRAGMA index_list(run_evaluations)").all() as Array<{ readonly name: string }>),
    ...(database.prepare("PRAGMA index_list(run_evaluation_grades)").all() as Array<{ readonly name: string }>),
  ].map((row) => row.name));
  if (requiredIndexes.some((index) => !indexes.has(index))) {
    throw new Error("Run evaluation migration index postcondition failed.");
  }
  const triggers = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('run_evaluations','run_evaluation_grades')",
  ).all() as Array<{ readonly name: string }>).map((row) => row.name));
  if (requiredTriggers.some((trigger) => !triggers.has(trigger))) {
    throw new Error("Run evaluation migration trigger postcondition failed.");
  }
  if (database.prepare("PRAGMA foreign_key_check(run_evaluations)").all().length > 0
    || database.prepare("PRAGMA foreign_key_check(run_evaluation_grades)").all().length > 0) {
    throw new Error("Run evaluation migration foreign-key postcondition failed.");
  }
}
