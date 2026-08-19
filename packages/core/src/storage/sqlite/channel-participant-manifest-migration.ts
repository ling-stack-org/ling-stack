import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  createRequiredParticipantManifestV1,
  isRequiredParticipantManifestV1,
  type ChannelIntentDecisionV2Action,
  type ChannelIntentExecutionPlanV1,
  type RequiredParticipantExpectedOutcomeV1,
  type RequiredParticipantRequestedByV1,
  type RequiredParticipantV1,
} from "@ling-stack/contracts";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION = 114;
export const CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_NAME = "add_channel_required_participant_manifest";

const EMPTY_MANIFEST_JSON = JSON.stringify(createRequiredParticipantManifestV1([]));
const EXECUTION_ACTIONS = new Set<ChannelIntentDecisionV2Action>(["execute", "workflow_proposal"]);

export interface ChannelParticipantManifestMigrationContext {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

interface IntentRow {
  readonly id: string;
  readonly action: ChannelIntentDecisionV2Action;
  readonly selected_teammate_ids_json: string;
  readonly proposal_id: string | null;
  readonly workflow_id: string | null;
  readonly execution_json: string | null;
  readonly participant_manifest_json: string | null;
}

export function applyChannelParticipantManifestMigration(
  input: ChannelParticipantManifestMigrationContext,
): boolean {
  assertTable(input.database, "channel_intent_decisions");
  const hasColumn = tableColumns(input.database, "channel_intent_decisions").has("participant_manifest_json");
  if (hasColumn && input.hasMigration(CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION) && postconditionsPass(input.database)) {
    return false;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    if (!hasColumn) {
      input.database.exec("ALTER TABLE channel_intent_decisions ADD COLUMN participant_manifest_json TEXT;");
    }
    const rows = input.database.prepare(`
      SELECT id, action, selected_teammate_ids_json, proposal_id, workflow_id,
             execution_json, participant_manifest_json
      FROM channel_intent_decisions
      ORDER BY created_at ASC, id ASC
    `).all() as unknown as readonly IntentRow[];
    const update = input.database.prepare(
      "UPDATE channel_intent_decisions SET participant_manifest_json = ? WHERE id = ?",
    );
    for (const row of rows) {
      const existing = parseJson(row.participant_manifest_json);
      const selectedIds = parseStringArray(row.selected_teammate_ids_json, row.id, "selected_teammate_ids_json");
      const existingParticipantIds = isRequiredParticipantManifestV1(existing)
        ? existing.participants.map((participant) => participant.participantId)
        : [];
      if (isRequiredParticipantManifestV1(existing)
        && JSON.stringify(sortedUnique(existingParticipantIds)) === JSON.stringify(sortedUnique(selectedIds))
        && (!EXECUTION_ACTIONS.has(row.action) || existing.participants.length > 0)) continue;
      const manifest = reconstructManifest(input.database, row);
      update.run(JSON.stringify(manifest), row.id);
    }
    assertPostconditions(input.database);
    rebuildWithNotNullManifest(input.database);
    if (!input.hasMigration(CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION)) {
      input.recordMigration(CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION, CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_NAME);
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function reconstructManifest(database: DatabaseSync, row: IntentRow) {
  const selectedIds = parseStringArray(row.selected_teammate_ids_json, row.id, "selected_teammate_ids_json");
  const proposalIds = row.proposal_id ? proposalParticipantIds(database, row.proposal_id) : [];
  const workflowIds = row.workflow_id ? workflowParticipantIds(database, row.workflow_id) : [];
  const sourceSets = [selectedIds, proposalIds, workflowIds].filter((ids) => ids.length > 0);
  if (sourceSets.length > 1) {
    const expected = sortedUnique(sourceSets[0]!);
    for (const ids of sourceSets.slice(1)) {
      if (JSON.stringify(sortedUnique(ids)) !== JSON.stringify(expected)) {
        throw new Error(`Participant manifest sources conflict for intent ${row.id}`);
      }
    }
  }
  const participantIds = sortedUnique(sourceSets.flat());
  if (participantIds.length === 0) {
    if (EXECUTION_ACTIONS.has(row.action)) {
      throw new Error(`Required participant manifest cannot be reconstructed for intent ${row.id}`);
    }
    return createRequiredParticipantManifestV1([]);
  }
  const operations = parseExecutionPlan(row.execution_json, row.id)?.operations ?? [];
  const operationOwners = row.workflow_id ? workflowOperationOwners(database, row.workflow_id) : new Map<string, string[]>();
  const participants = participantIds.map((participantId, index): RequiredParticipantV1 => {
    const role = teammateRole(database, participantId);
    const requiredOperationIds = sortedUnique(operationOwners.get(participantId) ?? fallbackOperationIds(
      operations,
      role,
      index,
      participantIds.length,
    ));
    return {
      participantId,
      role,
      requirement: "required",
      expectedOutcome: expectedOutcome(row.action, role, index, participantIds.length),
      requiredOperationIds,
      requestedBy: requestedBy(selectedIds, proposalIds, participantId),
    };
  });
  const owned = new Set(participants.flatMap((participant) => participant.requiredOperationIds));
  const missing = operations.filter((operation) => operation.required && !owned.has(operation.id));
  if (missing.length > 0) {
    throw new Error(`Required operations have no participant owner for intent ${row.id}: ${missing.map((item) => item.id).join(",")}`);
  }
  return createRequiredParticipantManifestV1(participants);
}

function proposalParticipantIds(database: DatabaseSync, proposalId: string): string[] {
  if (!tableColumns(database, "channel_execution_proposals").size) return [];
  const row = database.prepare(`
    SELECT assignee_teammate_id, collaboration_steps_json
    FROM channel_execution_proposals WHERE id = ?
  `).get(proposalId) as Record<string, SQLOutputValue> | undefined;
  if (!row) return [];
  const ids = typeof row.assignee_teammate_id === "string" ? [row.assignee_teammate_id] : [];
  const steps = parseJson(typeof row.collaboration_steps_json === "string" ? row.collaboration_steps_json : null);
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (isRecord(step) && typeof step.teammateId === "string") ids.push(step.teammateId);
    }
  }
  return sortedUnique(ids);
}

function workflowParticipantIds(database: DatabaseSync, workflowId: string): string[] {
  if (!tableColumns(database, "channel_workflow_steps").size) return [];
  return sortedUnique((database.prepare(
    "SELECT to_participant_id FROM channel_workflow_steps WHERE workflow_id = ?",
  ).all(workflowId) as Record<string, SQLOutputValue>[])
    .flatMap((row) => typeof row.to_participant_id === "string" ? [row.to_participant_id] : []));
}

function workflowOperationOwners(database: DatabaseSync, workflowId: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!tableColumns(database, "channel_workflow_steps").has("metadata_json")) return result;
  const rows = database.prepare(
    "SELECT to_participant_id, metadata_json FROM channel_workflow_steps WHERE workflow_id = ?",
  ).all(workflowId) as Record<string, SQLOutputValue>[];
  for (const row of rows) {
    if (typeof row.to_participant_id !== "string" || typeof row.metadata_json !== "string") continue;
    const metadata = parseJson(row.metadata_json);
    if (!isRecord(metadata) || !Array.isArray(metadata.executionOperationIds)) continue;
    const operationIds = metadata.executionOperationIds.filter((id): id is string => typeof id === "string");
    result.set(row.to_participant_id, sortedUnique([
      ...(result.get(row.to_participant_id) ?? []),
      ...operationIds,
    ]));
  }
  return result;
}

function teammateRole(database: DatabaseSync, participantId: string): string {
  if (!tableColumns(database, "ai_teammates").has("role_key")) {
    throw new Error(`Cannot resolve participant role without ai_teammates.role_key: ${participantId}`);
  }
  const row = database.prepare("SELECT role_key FROM ai_teammates WHERE id = ?").get(participantId) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.role_key !== "string" || row.role_key.trim().length === 0) {
    throw new Error(`Cannot resolve participant role: ${participantId}`);
  }
  return row.role_key;
}

function expectedOutcome(
  action: ChannelIntentDecisionV2Action,
  role: string,
  index: number,
  count: number,
): RequiredParticipantExpectedOutcomeV1 {
  if (!EXECUTION_ACTIONS.has(action)) return "discussion_reply";
  if (role === "qa" || role === "security" || role === "release") return "verification";
  if (count > 1 && index === count - 1 && role === "architect") return "synthesis";
  return "execution";
}

function requestedBy(selected: readonly string[], proposal: readonly string[], participantId: string): RequiredParticipantRequestedByV1 {
  if (selected.includes(participantId)) return "structured_mention";
  return proposal.includes(participantId) ? "explicit_role" : "selector_policy";
}

function fallbackOperationIds(
  operations: NonNullable<ReturnType<typeof parseExecutionPlan>>["operations"],
  role: string,
  index: number,
  count: number,
): string[] {
  const required = operations.filter((operation) => operation.required);
  if (count === 1) return required.map((operation) => operation.id);
  const verificationRole = role === "qa" || role === "security" || role === "release";
  const matched = required.filter((operation) => verificationRole
    ? operation.kind === "run_command" || operation.kind === "open_local_target"
    : operation.kind === "file_create" || operation.kind === "file_edit");
  return (matched.length > 0 ? matched : required.filter((_operation, operationIndex) => operationIndex % count === index))
    .map((operation) => operation.id);
}

function parseExecutionPlan(value: string | null, id: string): ChannelIntentExecutionPlanV1 | undefined {
  if (!value) return undefined;
  const parsed = parseJson(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) {
    throw new Error(`Invalid execution plan for intent ${id}`);
  }
  return parsed as unknown as ChannelIntentExecutionPlanV1;
}

function postconditionsPass(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    return tableColumnNotNull(database, "channel_intent_decisions", "participant_manifest_json");
  } catch {
    return false;
  }
}

function assertPostconditions(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, action, selected_teammate_ids_json, participant_manifest_json FROM channel_intent_decisions").all() as Record<string, SQLOutputValue>[];
  for (const row of rows) {
    const id = String(row.id);
    const parsed = parseJson(typeof row.participant_manifest_json === "string" ? row.participant_manifest_json : null);
    if (!isRequiredParticipantManifestV1(parsed)) throw new Error(`Invalid participant manifest after migration: ${id}`);
    const selectedIds = parseStringArray(String(row.selected_teammate_ids_json), id, "selected_teammate_ids_json");
    const participantIds = parsed.participants.map((participant) => participant.participantId);
    if (JSON.stringify(sortedUnique(selectedIds)) !== JSON.stringify(sortedUnique(participantIds))) {
      throw new Error(`Participant manifest does not match selected participants after migration: ${id}`);
    }
    if (EXECUTION_ACTIONS.has(row.action as ChannelIntentDecisionV2Action) && parsed.participants.length === 0) {
      throw new Error(`Execution intent has empty participant manifest after migration: ${id}`);
    }
  }
}

function rebuildWithNotNullManifest(database: DatabaseSync): void {
  if (tableColumnNotNull(database, "channel_intent_decisions", "participant_manifest_json")) return;
  database.exec(`
    ALTER TABLE channel_intent_decisions RENAME TO channel_intent_decisions_manifest_nullable;
    CREATE TABLE channel_intent_decisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      context_segment_id TEXT NOT NULL,
      context_projection_version TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('no_reply','reply','visible_multi_reply','clarify','workflow_proposal','execute')),
      selected_teammate_ids_json TEXT NOT NULL,
      participant_manifest_json TEXT NOT NULL DEFAULT '${EMPTY_MANIFEST_JSON.replaceAll("'", "''")}',
      proposal_id TEXT,
      result_item_ids_json TEXT NOT NULL,
      workflow_id TEXT,
      reason TEXT NOT NULL,
      clarification_json TEXT,
      execution_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted','suppressed','failed')),
      created_by TEXT NOT NULL CHECK (created_by IN ('deterministic','model_policy')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE CASCADE,
      FOREIGN KEY(context_segment_id) REFERENCES context_segments(id) ON DELETE RESTRICT,
      FOREIGN KEY(proposal_id) REFERENCES channel_execution_proposals(id) ON DELETE SET NULL,
      FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE SET NULL
    );
    INSERT INTO channel_intent_decisions (
      id, schema_version, workspace_id, channel_id, source_turn_id, source_item_id,
      context_segment_id, context_projection_version, action, selected_teammate_ids_json,
      participant_manifest_json, proposal_id, result_item_ids_json, workflow_id, reason,
      clarification_json, execution_json, status, created_by, error_code, created_at, updated_at
    ) SELECT
      id, schema_version, workspace_id, channel_id, source_turn_id, source_item_id,
      context_segment_id, context_projection_version, action, selected_teammate_ids_json,
      participant_manifest_json, proposal_id, result_item_ids_json, workflow_id, reason,
      clarification_json, execution_json, status, created_by, error_code, created_at, updated_at
    FROM channel_intent_decisions_manifest_nullable;
    DROP TABLE channel_intent_decisions_manifest_nullable;
    CREATE INDEX idx_channel_intent_decisions_channel_created ON channel_intent_decisions(workspace_id, channel_id, created_at);
    CREATE INDEX idx_channel_intent_decisions_source ON channel_intent_decisions(workspace_id, source_item_id);
    CREATE INDEX idx_channel_intent_decisions_turn ON channel_intent_decisions(workspace_id, source_turn_id, created_at);
    CREATE INDEX idx_channel_intent_decisions_segment ON channel_intent_decisions(workspace_id, context_segment_id, created_at);
    CREATE INDEX idx_channel_intent_decisions_status ON channel_intent_decisions(workspace_id, channel_id, status, updated_at);
  `);
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return new Set();
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Record<string, SQLOutputValue>[]).map((row) => String(row.name)));
}

function tableColumnNotNull(database: DatabaseSync, table: string, column: string): boolean {
  const row = (database.prepare(`PRAGMA table_info(${table})`).all() as Record<string, SQLOutputValue>[])
    .find((item) => item.name === column);
  return row?.notnull === 1;
}

function assertTable(database: DatabaseSync, table: string): void {
  if (!tableColumns(database, table).size) throw new Error(`Channel participant-manifest migration requires table: ${table}`);
}

function parseStringArray(value: string, id: string, field: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Invalid ${field} for intent ${id}`);
  }
  return sortedUnique(parsed);
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
