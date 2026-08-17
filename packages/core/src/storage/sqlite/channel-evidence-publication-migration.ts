import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export const CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION = 116;
export const CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_NAME = "seal_channel_evidence_and_publication_events";

const NON_TERMINAL_WORKFLOW_STATUSES = new Set(["draft", "ready", "running", "waiting_for_approval", "blocked"]);

export interface ChannelEvidencePublicationMigrationContext {
  readonly database: DatabaseSync;
  readonly artifactsDir: string;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyChannelEvidencePublicationMigration(
  input: ChannelEvidencePublicationMigrationContext,
): boolean {
  if (input.hasMigration(CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION)
    && postconditionsPass(input.database)) return false;
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    addColumnIfMissing(input.database, "artifacts", "sealed_payload_json", "TEXT");
    addColumnIfMissing(input.database, "artifacts", "content_sha256", "TEXT");
    addColumnIfMissing(input.database, "control_plane_events", "idempotency_key", "TEXT");
    input.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_event_idempotency
      ON control_plane_events(workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    sealRecoverableWorkflowOutputPackets(input.database, input.artifactsDir);
    assertPostconditions(input.database);
    assertRecoverableWorkflowOutputPacketsSealed(input.database);
    if (!input.hasMigration(CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION)) {
      input.recordMigration(
        CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION,
        CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_NAME,
      );
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    if (input.database.isTransaction) input.database.exec("ROLLBACK;");
    throw error;
  }
}

function sealRecoverableWorkflowOutputPackets(database: DatabaseSync, artifactsDir: string): void {
  const workflows = database.prepare(`
    SELECT id, status, metadata_json
    FROM channel_workflows
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  for (const row of workflows) {
    const workflowId = String(row.id);
    if (!workflowNeedsSemanticRecovery(database, workflowId, String(row.status), parseRecord(row.metadata_json))) {
      continue;
    }
    const steps = database.prepare(`
      SELECT id, run_id, metadata_json
      FROM channel_workflow_steps
      WHERE workflow_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
    `).all(workflowId) as Record<string, SQLOutputValue>[];
    for (const step of steps) {
      const metadata = parseRecord(step.metadata_json);
      const artifactId = nonEmptyString(metadata?.outputArtifactId);
      if (!artifactId) continue;
      sealWorkflowOutputPacket(database, artifactsDir, {
        artifactId,
        workflowId,
        workflowStepId: String(step.id),
        runId: typeof step.run_id === "string" ? step.run_id : undefined,
      });
    }
  }
}

function workflowNeedsSemanticRecovery(
  database: DatabaseSync,
  workflowId: string,
  status: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata || typeof metadata.requiredParticipantManifest !== "object") return false;
  if (NON_TERMINAL_WORKFLOW_STATUSES.has(status)) return true;
  const published = database.prepare(`
    SELECT published_message_id
    FROM ling_terminal_reports
    WHERE source_kind = 'workflow' AND source_id = ?
      AND status IN ('committed', 'fallback') AND published_message_id IS NOT NULL
    ORDER BY generation DESC LIMIT 1
  `).get(workflowId) as Record<string, SQLOutputValue> | undefined;
  if (!published) return true;
  const sourceTurnId = nonEmptyString(metadata.sourceTurnId);
  if (!sourceTurnId) return false;
  const turn = database.prepare("SELECT status FROM ling_turns WHERE id = ?").get(sourceTurnId) as
    | Record<string, SQLOutputValue>
    | undefined;
  return !turn || turn.status === "open" || turn.status === "running" || turn.status === "waiting_for_approval";
}

function sealWorkflowOutputPacket(
  database: DatabaseSync,
  artifactsDir: string,
  expected: {
    readonly artifactId: string;
    readonly workflowId: string;
    readonly workflowStepId: string;
    readonly runId?: string;
  },
): void {
  const row = database.prepare(`
    SELECT id, run_id, path, sealed_payload_json, content_sha256
    FROM artifacts WHERE id = ?
  `).get(expected.artifactId) as Record<string, SQLOutputValue> | undefined;
  if (!row) throw new Error(`Workflow output packet artifact is missing: ${expected.artifactId}`);
  if (expected.runId && row.run_id !== expected.runId) {
    throw new Error(`Workflow output packet Run mismatch: ${expected.artifactId}`);
  }
  const existingPayload = parseJson(row.sealed_payload_json);
  if (existingPayload !== undefined) {
    assertPacketOwnership(existingPayload, expected);
    const fingerprint = sha256Json(existingPayload);
    if (row.content_sha256 !== fingerprint) {
      throw new Error(`Workflow output packet sealed digest mismatch: ${expected.artifactId}`);
    }
    return;
  }
  const artifactPath = resolveArtifactPath(artifactsDir, String(row.path));
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Workflow output packet cannot be sealed: ${expected.artifactId}`, { cause: error });
  }
  assertPacketOwnership(payload, expected);
  database.prepare(`
    UPDATE artifacts SET sealed_payload_json = ?, content_sha256 = ?
    WHERE id = ? AND sealed_payload_json IS NULL AND content_sha256 IS NULL
  `).run(JSON.stringify(payload), sha256Json(payload), expected.artifactId);
}

function assertPacketOwnership(
  payload: unknown,
  expected: { readonly artifactId: string; readonly workflowId: string; readonly workflowStepId: string; readonly runId?: string },
): void {
  const packet = asRecord(payload);
  if (!packet || packet.schemaVersion !== 1 || packet.workflowId !== expected.workflowId
    || packet.workflowStepId !== expected.workflowStepId
    || (expected.runId && packet.runId !== expected.runId)) {
    throw new Error(`Workflow output packet ownership mismatch: ${expected.artifactId}`);
  }
}

function assertPostconditions(database: DatabaseSync): void {
  for (const [table, column] of [
    ["artifacts", "sealed_payload_json"],
    ["artifacts", "content_sha256"],
    ["control_plane_events", "idempotency_key"],
  ] as const) {
    if (!tableColumns(database, table).has(column)) {
      throw new Error(`Migration 116 postcondition failed: ${table}.${column} is missing`);
    }
  }
  const index = database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_control_plane_event_idempotency'
  `).get();
  if (!index) throw new Error("Migration 116 postcondition failed: publication event idempotency index is missing");
}

function assertRecoverableWorkflowOutputPacketsSealed(database: DatabaseSync): void {
  const workflows = database.prepare(`
    SELECT id, status, metadata_json
    FROM channel_workflows
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  for (const row of workflows) {
    const workflowId = String(row.id);
    if (!workflowNeedsSemanticRecovery(database, workflowId, String(row.status), parseRecord(row.metadata_json))) {
      continue;
    }
    const steps = database.prepare(`
      SELECT id, run_id, metadata_json
      FROM channel_workflow_steps
      WHERE workflow_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
    `).all(workflowId) as Record<string, SQLOutputValue>[];
    for (const step of steps) {
      const artifactId = nonEmptyString(parseRecord(step.metadata_json)?.outputArtifactId);
      if (!artifactId) continue;
      const artifact = database.prepare(`
        SELECT run_id, sealed_payload_json, content_sha256
        FROM artifacts WHERE id = ?
      `).get(artifactId) as Record<string, SQLOutputValue> | undefined;
      if (!artifact) throw new Error(`Workflow output packet artifact is missing: ${artifactId}`);
      const expectedRunId = typeof step.run_id === "string" ? step.run_id : undefined;
      if (expectedRunId && artifact.run_id !== expectedRunId) {
        throw new Error(`Workflow output packet Run mismatch: ${artifactId}`);
      }
      const payload = parseJson(artifact.sealed_payload_json);
      if (payload === undefined || typeof artifact.content_sha256 !== "string") {
        throw new Error(`Workflow output packet is not sealed: ${artifactId}`);
      }
      assertPacketOwnership(payload, {
        artifactId,
        workflowId,
        workflowStepId: String(step.id),
        runId: expectedRunId,
      });
      if (sha256Json(payload) !== artifact.content_sha256) {
        throw new Error(`Workflow output packet sealed digest mismatch: ${artifactId}`);
      }
    }
  }
}

function postconditionsPass(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    assertRecoverableWorkflowOutputPacketsSealed(database);
    return true;
  } catch {
    return false;
  }
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  if (!tableColumns(database, table).has(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Record<string, SQLOutputValue>[])
    .map((row) => String(row.name)));
}

function resolveArtifactPath(root: string, storedPath: string): string {
  const absolute = isAbsolute(storedPath) ? storedPath : resolve(root, storedPath);
  const relation = relative(root, absolute);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Workflow output packet path is outside artifact root: ${storedPath}`);
  }
  return absolute;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(parseJson(value));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
