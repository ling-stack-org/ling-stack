import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  delegatedStepRequirementFingerprintV1,
  isDelegatedStepRequirementV1,
  isRequiredParticipantManifestV1,
  workflowGraphFingerprintV1,
  type DelegatedEvidenceRefKindV1,
  type DelegatedStepRequirementV1,
  type RequiredParticipantV1,
  type WorkflowGraph,
} from "@ling-stack/contracts";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION = 115;
export const CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_NAME = "materialize_channel_delegated_step_requirements";

const NON_TERMINAL_WORKFLOW_STATUSES = new Set(["draft", "ready", "running", "waiting_for_approval", "blocked"]);

export interface ChannelDelegatedStepRequirementMigrationContext {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyChannelDelegatedStepRequirementMigration(
  input: ChannelDelegatedStepRequirementMigrationContext,
): boolean {
  if (input.hasMigration(CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION)
    && postconditionsPass(input.database)) return false;
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    const workflows = input.database.prepare(`
      SELECT id, status, metadata_json
      FROM channel_workflows
      ORDER BY created_at ASC, id ASC
    `).all() as Record<string, SQLOutputValue>[];
    for (const workflow of workflows) {
      if (!NON_TERMINAL_WORKFLOW_STATUSES.has(String(workflow.status))) continue;
      const metadata = parseRecord(workflow.metadata_json);
      const manifest = metadata?.requiredParticipantManifest;
      if (!metadata || !isRequiredParticipantManifestV1(manifest)) continue;
      materializeWorkflow(input.database, String(workflow.id), metadata, manifest);
    }
    assertPostconditions(input.database);
    if (!input.hasMigration(CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION)) {
      input.recordMigration(
        CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION,
        CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_NAME,
      );
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function materializeWorkflow(
  database: DatabaseSync,
  workflowId: string,
  workflowMetadata: Record<string, unknown>,
  manifest: import("@ling-stack/contracts").RequiredParticipantManifestV1,
): void {
  const sourceIntentDecisionId = nonEmptyString(workflowMetadata.sourceIntentDecisionId);
  const graph = parseWorkflowGraph(workflowMetadata.workflowGraph);
  const storedGraphFingerprint = nonEmptyString(workflowMetadata.workflowGraphFingerprint);
  if (!sourceIntentDecisionId || !graph || !storedGraphFingerprint
    || storedGraphFingerprint !== workflowGraphFingerprintV1(graph)) {
    throw new Error(`Delegated requirement authority is incomplete for workflow ${workflowId}`);
  }
  const decision = database.prepare(
    "SELECT participant_manifest_json FROM channel_intent_decisions WHERE id = ?",
  ).get(sourceIntentDecisionId) as Record<string, SQLOutputValue> | undefined;
  const decisionManifest = parseJson(decision?.participant_manifest_json);
  if (!isRequiredParticipantManifestV1(decisionManifest)
    || decisionManifest.fingerprint !== manifest.fingerprint) {
    throw new Error(`Delegated requirement manifest mismatch for workflow ${workflowId}`);
  }
  const rows = database.prepare(`
    SELECT id, run_id, to_participant_id, metadata_json
    FROM channel_workflow_steps
    WHERE workflow_id = ?
    ORDER BY position ASC, created_at ASC, id ASC
  `).all(workflowId) as Record<string, SQLOutputValue>[];
  const participants = new Map(manifest.participants.map((participant) => [participant.participantId, participant]));
  const steps = rows.map((row) => ({
    id: String(row.id),
    runId: typeof row.run_id === "string" ? row.run_id : undefined,
    participantId: String(row.to_participant_id),
    metadata: parseRecord(row.metadata_json) ?? {},
  }));
  for (const participant of manifest.participants.filter((candidate) => candidate.requirement === "required")) {
    if (!steps.some((step) => step.participantId === participant.participantId)) {
      throw new Error(`Required participant has no workflow step in ${workflowId}: ${participant.participantId}`);
    }
  }
  for (const step of steps) {
    const participant = participants.get(step.participantId);
    if (!participant || participant.expectedOutcome === "discussion_reply") {
      throw new Error(`Workflow step participant is outside delegated manifest in ${workflowId}: ${step.id}`);
    }
    const requirement = buildRequirement(workflowId, step.id, step.participantId, step.metadata, participant, manifest.fingerprint);
    const nextMetadata = { ...step.metadata, delegatedRequirement: requirement };
    database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(nextMetadata), step.id);
    if (step.runId) {
      const run = database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id = ?")
        .get(step.runId) as Record<string, SQLOutputValue> | undefined;
      if (!run) throw new Error(`Linked Run is missing for delegated step ${step.id}: ${step.runId}`);
      const request = parseRecord(run.request_snapshot_json);
      if (!request) throw new Error(`Linked Run request snapshot is invalid for delegated step ${step.id}: ${step.runId}`);
      database.prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...request, delegatedRequirement: requirement }), step.runId);
    }
  }
  for (const participant of manifest.participants) {
    const owned = steps.filter((step) => step.participantId === participant.participantId)
      .flatMap((step) => stringArray(step.metadata.executionOperationIds));
    if (JSON.stringify(sortedUnique(owned)) !== JSON.stringify(sortedUnique(participant.requiredOperationIds))) {
      throw new Error(`Delegated operation ownership mismatch for ${workflowId}:${participant.participantId}`);
    }
  }
}

function buildRequirement(
  workflowId: string,
  workflowStepId: string,
  participantId: string,
  metadata: Record<string, unknown>,
  participant: RequiredParticipantV1,
  participantManifestFingerprint: string,
): DelegatedStepRequirementV1 {
  const expectedOutcome = participant.expectedOutcome;
  if (expectedOutcome === "discussion_reply") {
    throw new Error(`Discussion participant cannot own delegated workflow step ${workflowStepId}`);
  }
  const acceptedEvidenceKinds: readonly DelegatedEvidenceRefKindV1[] = expectedOutcome === "synthesis"
    ? ["workflow_output_packet"]
    : ["execution_action"];
  const value: Omit<DelegatedStepRequirementV1, "fingerprint"> = {
    schemaVersion: 1,
    workflowId,
    workflowStepId,
    participantId,
    participantManifestFingerprint,
    expectedOutcome,
    requiredOperationIds: sortedUnique(stringArray(metadata.executionOperationIds)),
    requiredDependencyStepIds: sortedUnique(stringArray(metadata.dependsOnStepIds)),
    acceptedEvidenceKinds,
  };
  return { ...value, fingerprint: delegatedStepRequirementFingerprintV1(value) };
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
  const rows = database.prepare(`
    SELECT workflows.id AS workflow_id, workflows.metadata_json AS workflow_metadata_json,
           steps.id AS step_id, steps.run_id, steps.metadata_json AS step_metadata_json
    FROM channel_workflows AS workflows
    JOIN channel_workflow_steps AS steps ON steps.workflow_id = workflows.id
    WHERE workflows.status IN ('draft','ready','running','waiting_for_approval','blocked')
  `).all() as Record<string, SQLOutputValue>[];
  for (const row of rows) {
    const workflowMetadata = parseRecord(row.workflow_metadata_json);
    if (!isRequiredParticipantManifestV1(workflowMetadata?.requiredParticipantManifest)) continue;
    const stepMetadata = parseRecord(row.step_metadata_json);
    const requirement = stepMetadata?.delegatedRequirement;
    if (!isDelegatedStepRequirementV1(requirement)
      || requirement.workflowId !== row.workflow_id
      || requirement.workflowStepId !== row.step_id
      || requirement.participantManifestFingerprint !== workflowMetadata.requiredParticipantManifest.fingerprint) {
      throw new Error(`Delegated requirement postcondition failed for step ${String(row.step_id)}`);
    }
    if (typeof row.run_id === "string") {
      const run = database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id = ?")
        .get(row.run_id) as Record<string, SQLOutputValue> | undefined;
      const snapshotRequirement = parseRecord(run?.request_snapshot_json)?.delegatedRequirement;
      if (!isDelegatedStepRequirementV1(snapshotRequirement)
        || snapshotRequirement.fingerprint !== requirement.fingerprint) {
        throw new Error(`Delegated Run snapshot postcondition failed for step ${String(row.step_id)}`);
      }
    }
  }
}

function parseWorkflowGraph(value: unknown): WorkflowGraph | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const graph = value as WorkflowGraph;
  return graph.schemaVersion === 1 && typeof graph.id === "string" && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
    ? graph
    : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
