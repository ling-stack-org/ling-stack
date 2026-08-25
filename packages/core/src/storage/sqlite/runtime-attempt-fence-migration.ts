import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION = 121;
export const RUNTIME_ATTEMPT_FENCE_MIGRATION_NAME = "reset_unfenced_runtime_state";

export interface RuntimeAttemptFenceMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

/**
 * Installs the clean-break Attempt fence.
 *
 * Ling is still pre-release, so an old development database is not a supported
 * runtime compatibility target. We never manufacture a fence for an old row. Any
 * transient runtime row that cannot prove the complete fence is discarded, and a
 * Work Unit that pointed at such an Attempt is made stale. Conversation data is
 * outside this migration and remains intact.
 */
export function applyRuntimeAttemptFenceMigration(input: RuntimeAttemptFenceMigrationInput): boolean {
  const { database } = input;
  const requiredColumns: readonly [string, string][] = [
    ["work_unit_attempts", "fencing_token"],
    ["runtime_events", "runtime_instance_id"],
    ["runtime_events", "fencing_token"],
    ["runtime_heartbeats", "fencing_token"],
    ["runtime_semaphore_slots", "fencing_token"],
    ["runtime_semaphore_slots", "runtime_instance_id"],
    ["resource_leases", "fencing_token"],
    ["resource_leases", "runtime_instance_id"],
  ];
  const complete = requiredColumns.every(([table, column]) => input.hasColumn(table, column));
  if (complete && input.hasMigration(RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION) && postconditionsPass(database)) {
    return false;
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const [table, column] of requiredColumns) {
      if (!input.hasColumn(table, column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`);
      }
    }

    database.exec(`
      -- Do not backfill a fence from attempt_number or any other legacy value.
      -- The rows below are transient runtime state, not user conversation history.
      UPDATE work_units
      SET
        active_attempt_id = NULL,
        status = CASE
          WHEN status IN ('claimed', 'running', 'waiting_for_approval', 'cancelling') THEN 'stale'
          ELSE status
        END,
        ended_at = CASE
          WHEN status IN ('claimed', 'running', 'waiting_for_approval', 'cancelling')
            THEN COALESCE(ended_at, updated_at)
          ELSE ended_at
        END,
        error_code = CASE
          WHEN status IN ('claimed', 'running', 'waiting_for_approval', 'cancelling')
            THEN COALESCE(error_code, 'runtime_attempt_fence_clean_break_reset')
          ELSE error_code
        END,
        error_message = CASE
          WHEN status IN ('claimed', 'running', 'waiting_for_approval', 'cancelling')
            THEN COALESCE(error_message, 'The pre-fence development runtime state was reset.')
          ELSE error_message
        END
      WHERE active_attempt_id IN (
        SELECT id FROM work_unit_attempts
        WHERE fencing_token IS NULL OR fencing_token = ''
      );

      DELETE FROM runtime_events
      WHERE attempt_id IN (
        SELECT id FROM work_unit_attempts
        WHERE fencing_token IS NULL OR fencing_token = ''
      )
        OR (attempt_id IS NOT NULL AND (runtime_instance_id IS NULL OR fencing_token IS NULL OR fencing_token = ''));

      DELETE FROM runtime_heartbeats
      WHERE fencing_token IS NULL OR fencing_token = ''
        OR attempt_id IN (
          SELECT id FROM work_unit_attempts
          WHERE fencing_token IS NULL OR fencing_token = ''
        );

      DELETE FROM runtime_semaphore_slots
      WHERE runtime_instance_id IS NULL OR runtime_instance_id = ''
        OR fencing_token IS NULL OR fencing_token = ''
        OR attempt_id IN (
          SELECT id FROM work_unit_attempts
          WHERE fencing_token IS NULL OR fencing_token = ''
        )
        OR NOT EXISTS (
          SELECT 1
          FROM work_unit_attempts AS attempts
          JOIN work_units AS units ON units.id = attempts.work_unit_id
          WHERE attempts.id = runtime_semaphore_slots.attempt_id
            AND attempts.work_unit_id = runtime_semaphore_slots.work_unit_id
            AND attempts.runtime_instance_id = runtime_semaphore_slots.runtime_instance_id
            AND attempts.fencing_token = runtime_semaphore_slots.fencing_token
            AND units.active_attempt_id = attempts.id
        );

      DELETE FROM resource_leases
      WHERE owner_type IN ('run', 'work_unit_attempt')
        AND (
          work_unit_id IS NULL
          OR attempt_id IS NULL
          OR runtime_instance_id IS NULL
          OR runtime_instance_id = ''
          OR fencing_token IS NULL
          OR fencing_token = ''
          OR attempt_id IN (
            SELECT id FROM work_unit_attempts
            WHERE fencing_token IS NULL OR fencing_token = ''
          )
          OR NOT EXISTS (
            SELECT 1
            FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = resource_leases.attempt_id
              AND attempts.work_unit_id = resource_leases.work_unit_id
              AND attempts.runtime_instance_id = resource_leases.runtime_instance_id
              AND attempts.fencing_token = resource_leases.fencing_token
              AND units.active_attempt_id = attempts.id
          )
        );

      DELETE FROM work_unit_attempts
      WHERE fencing_token IS NULL OR fencing_token = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_unit_attempts_fence
      ON work_unit_attempts(work_unit_id, fencing_token);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_unit_attempts_active
      ON work_unit_attempts(work_unit_id)
      WHERE status IN ('created', 'started', 'waiting_for_approval', 'cancelling');

      CREATE INDEX IF NOT EXISTS idx_runtime_events_fence
      ON runtime_events(work_unit_id, attempt_id, runtime_instance_id, fencing_token, seq);

      CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_fence
      ON runtime_heartbeats(work_unit_id, attempt_id, fencing_token, ts);

      CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_fence
      ON runtime_semaphore_slots(work_unit_id, attempt_id, runtime_instance_id, fencing_token, status);

      CREATE INDEX IF NOT EXISTS idx_resource_leases_fence
      ON resource_leases(work_unit_id, attempt_id, runtime_instance_id, fencing_token, status);
    `);

    assertPostconditions(database);
    if (!input.hasMigration(RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION)) {
      input.recordMigration(RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION, RUNTIME_ATTEMPT_FENCE_MIGRATION_NAME);
    }
    database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}

function postconditionsPass(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    return true;
  } catch {
    return false;
  }
}

function assertPostconditions(database: DatabaseSync): void {
  const missing = database.prepare(`
    SELECT COUNT(*) AS count
    FROM work_unit_attempts
    WHERE fencing_token IS NULL OR fencing_token = ''
  `).get() as { readonly count: number };
  if (Number(missing.count) !== 0) {
    throw new Error("Runtime attempt fence migration left an attempt without fencing_token");
  }
  const unfencedSemaphore = database.prepare(`
    SELECT COUNT(*) AS count
    FROM runtime_semaphore_slots
    WHERE fencing_token IS NULL OR runtime_instance_id IS NULL
  `).get() as { readonly count: number };
  if (Number(unfencedSemaphore.count) !== 0) {
    throw new Error("Runtime attempt fence migration left a semaphore slot without a complete fence");
  }
  const activeNonCurrentSemaphore = database.prepare(`
    SELECT COUNT(*) AS count
    FROM runtime_semaphore_slots AS slots
    WHERE slots.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM work_unit_attempts AS attempts
        JOIN work_units AS units ON units.id = attempts.work_unit_id
        WHERE attempts.id = slots.attempt_id
          AND attempts.work_unit_id = slots.work_unit_id
          AND attempts.runtime_instance_id = slots.runtime_instance_id
          AND attempts.fencing_token = slots.fencing_token
          AND units.active_attempt_id = attempts.id
      )
  `).get() as { readonly count: number };
  if (Number(activeNonCurrentSemaphore.count) !== 0) {
    throw new Error("Runtime attempt fence migration left an active semaphore slot owned by a non-current Attempt");
  }
  const invalidHeartbeat = database.prepare(`
    SELECT COUNT(*) AS count
    FROM runtime_heartbeats AS heartbeats
    WHERE heartbeats.fencing_token IS NULL
      OR heartbeats.fencing_token = ''
      OR heartbeats.runtime_instance_id IS NULL
      OR heartbeats.runtime_instance_id = ''
      OR NOT EXISTS (
        SELECT 1
        FROM work_unit_attempts AS attempts
        WHERE attempts.id = heartbeats.attempt_id
          AND attempts.work_unit_id = heartbeats.work_unit_id
          AND attempts.runtime_instance_id = heartbeats.runtime_instance_id
          AND attempts.fencing_token = heartbeats.fencing_token
      )
  `).get() as { readonly count: number };
  if (Number(invalidHeartbeat.count) !== 0) {
    throw new Error("Runtime attempt fence migration left a heartbeat without a complete Attempt fence");
  }
  const unfencedRuntimeEvent = database.prepare(`
    SELECT COUNT(*) AS count
    FROM runtime_events
    WHERE attempt_id IS NOT NULL
      AND (runtime_instance_id IS NULL OR fencing_token IS NULL)
  `).get() as { readonly count: number };
  if (Number(unfencedRuntimeEvent.count) !== 0) {
    throw new Error("Runtime attempt fence migration left an Attempt event without a complete fence");
  }
  const activeInvalidRuntimeLease = database.prepare(`
    SELECT COUNT(*) AS count
    FROM resource_leases
    WHERE status = 'active'
      AND owner_type IN ('run', 'work_unit_attempt')
      AND (
        work_unit_id IS NULL
        OR attempt_id IS NULL
        OR runtime_instance_id IS NULL
        OR runtime_instance_id = ''
        OR fencing_token IS NULL
        OR fencing_token = ''
      )
  `).get() as { readonly count: number };
  if (Number(activeInvalidRuntimeLease.count) !== 0) {
    throw new Error("Runtime attempt fence migration left an active runtime lease without a complete Attempt fence");
  }
  const activeNonCurrentLease = database.prepare(`
    SELECT COUNT(*) AS count
    FROM resource_leases AS leases
    WHERE leases.status = 'active'
      AND leases.attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM work_unit_attempts AS attempts
        JOIN work_units AS units ON units.id = attempts.work_unit_id
        WHERE attempts.id = leases.attempt_id
          AND attempts.work_unit_id = leases.work_unit_id
          AND attempts.runtime_instance_id = leases.runtime_instance_id
          AND attempts.fencing_token = leases.fencing_token
          AND units.active_attempt_id = attempts.id
      )
  `).get() as { readonly count: number };
  if (Number(activeNonCurrentLease.count) !== 0) {
    throw new Error("Runtime attempt fence migration left an active lease owned by a non-current Attempt");
  }
}
