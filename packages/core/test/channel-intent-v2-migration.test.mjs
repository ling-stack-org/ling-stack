import assert from "node:assert/strict";
import { appendLegacyChannelMessageFixture } from "./legacy-continuity-fixture.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createLegacySqliteRunStoreForMigrationTest,
  createPreContinuityV2ReleaseSqliteRunStoreForMigrationTest,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";
import { CHANNEL_INTENT_V2_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-intent-v2-migration.js";
import { CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-intent-execution-plan-migration.js";
import { CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-participant-manifest-migration.js";
import { CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-delegated-step-requirement-migration.js";
import { CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-evidence-publication-migration.js";
import { CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION } from "../dist/storage/sqlite/control-plane-replay-state-migration.js";
import { APPROVAL_RESUME_BASIS_MIGRATION_VERSION } from "../dist/storage/sqlite/approval-resume-basis-migration.js";
import { CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-participant-authority-migration.js";
import { CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-proposal-blocker-migration.js";
import { RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION } from "../dist/storage/sqlite/runtime-attempt-fence-migration.js";
import { createRequiredParticipantManifestV1, createWorkflowParticipantAuthorityV1, workflowGraphFingerprintV1 } from "../../contracts/dist/index.js";

test("release migration rollback preserves the pre-119 schema and retry completes after repair", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-release-migration-rollback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-24T01:00:00.000Z";

  const fixture = createPreContinuityV2ReleaseSqliteRunStoreForMigrationTest(cwd);
  const channel = fixture.createChannel({ name: "Release migration", boundPath: cwd }, now);
  const workflow = fixture.createChannelWorkflow({
    channelId: channel.id,
    title: "Legacy workflow",
    objective: "Exercise migration rollback",
    createdBy: "test",
    status: "ready",
  }, now);
  fixture.close();

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  const workspaceId = database.prepare("SELECT workspace_id FROM channels WHERE id = ?").get(channel.id).workspace_id;
  database.prepare(`
    INSERT INTO channel_workflow_steps (
      id, workspace_id, channel_id, workflow_id, source_handoff_id,
      context_summary_id, task_id, run_id, position, title, prompt,
      to_participant_id, to_participant_label, status, blocker,
      result_summary, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    "legacy-invalid-step",
    workspaceId,
    channel.id,
    workflow.id,
    1,
    "Legacy step",
    "This row is intentionally malformed for migration rollback.",
    "",
    "Unknown",
    "queued",
    now,
    now,
  );
  database.close();

  assert.throws(
    () => createSqliteRunStore(cwd),
    /Cannot backfill participant authority for a malformed workflow step row/,
  );

  database = new DatabaseSync(databasePath);
  try {
    const columns = new Set(database.prepare("PRAGMA table_info(channel_workflow_steps)").all().map((row) => row.name));
    assert.equal(columns.has("participant_authority_json"), false);
    assert.equal(database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION), undefined);
    assert.equal(database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION), undefined);
    assert.equal(database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION), undefined);
    assert.equal(database.prepare("SELECT to_participant_id FROM channel_workflow_steps WHERE id = ?").get("legacy-invalid-step").to_participant_id, "");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.prepare("UPDATE channel_workflow_steps SET to_participant_id = ? WHERE id = ?")
      .run("teammate_builtin_engineer", "legacy-invalid-step");
  } finally {
    database.close();
  }

  const reopened = createSqliteRunStore(cwd);
  try {
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.ok(migrated.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION));
      assert.ok(migrated.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION));
      assert.ok(migrated.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION));
      const authority = migrated.prepare("SELECT participant_authority_json FROM channel_workflow_steps WHERE id = ?").get("legacy-invalid-step").participant_authority_json;
      assert.equal(JSON.parse(authority).participantId, "teammate_builtin_engineer");
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(migrated.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      migrated.close();
    }
  } finally {
    reopened.close();
  }
});

test("fresh database applies migrations 113 through 121 with reopen and integrity invariants", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-completion-fresh-migrations-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  createSqliteRunStore(cwd).close();
  createSqliteRunStore(cwd).close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath, { readOnly: true });
  const versions = database.prepare(`
    SELECT version FROM schema_migrations
    WHERE version BETWEEN ? AND ?
    ORDER BY version ASC
  `).all(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION, RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION)
    .map((row) => row.version);
  assert.deepEqual(versions, [
    CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION,
    CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION,
    CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION,
    CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION,
    CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION,
    APPROVAL_RESUME_BASIS_MIGRATION_VERSION,
    CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION,
    CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION,
    RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION,
  ]);
  for (const table of ["work_unit_attempts", "runtime_events", "runtime_heartbeats", "runtime_semaphore_slots", "resource_leases"]) {
    assert.ok(database.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'fencing_token'`).get(table));
  }
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_unit_attempts_active'",
  ).get());
  const intentColumns = new Map(database.prepare("PRAGMA table_info(channel_intent_decisions)").all()
    .map((row) => [row.name, row]));
  assert.equal(intentColumns.get("participant_manifest_json")?.notnull, 1);
  const artifactColumns = new Set(database.prepare("PRAGMA table_info(artifacts)").all().map((row) => row.name));
  assert.equal(artifactColumns.has("sealed_payload_json"), true);
  assert.equal(artifactColumns.has("content_sha256"), true);
  const eventColumns = new Set(database.prepare("PRAGMA table_info(control_plane_events)").all().map((row) => row.name));
  assert.equal(eventColumns.has("idempotency_key"), true);
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_control_plane_event_idempotency'",
  ).get());
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_replay_state'",
  ).get());
  const checkpointColumns = new Map(database.prepare("PRAGMA table_info(approval_checkpoints)").all()
    .map((row) => [row.name, row]));
  assert.equal(checkpointColumns.get("revision")?.notnull, 1);
  assert.equal(checkpointColumns.has("resume_basis_json"), true);
  const workflowStepColumns = new Set(database.prepare("PRAGMA table_info(channel_workflow_steps)").all().map((row) => row.name));
  assert.equal(workflowStepColumns.has("participant_authority_json"), true);
  const proposalColumns = new Set(database.prepare("PRAGMA table_info(channel_execution_proposals)").all().map((row) => row.name));
  assert.equal(proposalColumns.has("blocker_json"), true);
  assert.equal(proposalColumns.has("revision"), true);
  assert.equal(proposalColumns.has("confirmation_claim_id"), true);
  assert.equal(proposalColumns.has("confirmation_claim_expires_at"), true);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("workflow participant provider blocker round trips and invalid stored JSON fails reopen", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-proposal-provider-blocker-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-17T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Provider blocker", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Provider blocker",
    objective: "Verify provider blocker persistence.",
  }, now).thread;
  const turn = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Engineer and QA",
    userInstruction: "Engineer and QA",
    payload: { body: "Engineer and QA", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "proposal-provider-blocker",
  }, now);
  const blocker = {
    schemaVersion: 1,
    code: "workflow_participant_provider_unavailable",
    reasonCode: "workspace_default_provider_missing",
    participantId: "teammate_builtin_qa",
    bindingMode: "workspace_default",
    source: "workspace_default",
    owner: "workspace",
    repairTarget: "model_workbench",
    message: "QA needs a workspace default model.",
  };
  const proposal = store.createChannelExecutionProposal({
    channelId: channel.id,
    sourceMessageId: turn.item.id,
    proposedByTeammateId: "ling_agent",
    title: "Engineer and QA",
    prompt: "Engineer and QA",
    assigneeTeammateId: "teammate_builtin_engineer",
    status: "blocked",
    errorMessage: blocker.message,
    blocker,
  }, now);
  assert.deepEqual(store.getChannelExecutionProposal(proposal.id).blocker, blocker);
  assert.equal(store.updateChannelExecutionProposal(proposal.id, { blocker: null }, now).blocker, undefined);
  assert.deepEqual(store.updateChannelExecutionProposal(proposal.id, { blocker }, now).blocker, blocker);
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.prepare("UPDATE channel_execution_proposals SET blocker_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...blocker, owner: "channel" }), proposal.id);
  database.close();
  assert.throws(() => createSqliteRunStore(cwd), /Invalid proposal blocker contract/);
});

test("workflow participant authority round trips and rejects reassignment or metadata tampering", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-participant-authority-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-16T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Authority", boundPath: cwd }, now);
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Authority workflow",
    objective: "Preserve assignment authority",
    createdBy: "local-user",
    status: "ready",
  }, now);
  const authority = createWorkflowParticipantAuthorityV1({
    kind: "workflow_definition",
    origin: "workflow_graph",
    participantId: "teammate_builtin_engineer",
    sourceId: "graph_authority",
  });
  const invalidAuthority = createWorkflowParticipantAuthorityV1({
    kind: "channel_selection",
    origin: "workflow_graph",
    participantId: authority.participantId,
    sourceId: "forged-origin",
  });
  assert.throws(() => store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Forged",
    prompt: "Should fail",
    toParticipantId: authority.participantId,
    toParticipantLabel: "Engineer",
    participantAuthority: invalidAuthority,
  }, now), /Invalid participant authority/);
  assert.throws(() => store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Forged provider",
    prompt: "Should fail before insert",
    toParticipantId: authority.participantId,
    toParticipantLabel: "Engineer",
    participantAuthority: authority,
    metadata: {
      providerBinding: {
        schemaVersion: 1,
        participantId: authority.participantId,
        bindingMode: "workspace_default",
        source: "private_request_override",
        providerPresetId: "provider_forged",
      },
    },
  }, now), /Invalid participant provider binding/);
  assert.equal(store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 20 }).length, 0);
  const created = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Engineer",
    prompt: "Do the work",
    toParticipantId: authority.participantId,
    toParticipantLabel: "Engineer",
    participantAuthority: authority,
    metadata: {
      providerBinding: {
        schemaVersion: 1,
        participantId: authority.participantId,
        bindingMode: "workspace_default",
        source: "workspace_default",
        providerPresetId: "provider_workspace",
      },
    },
  }, now);
  assert.deepEqual(created.participantAuthority, authority);
  assert.equal(store.getChannelWorkflowStep(created.id)?.participantAuthority.fingerprint, authority.fingerprint);
  assert.equal(store.getChannelWorkflowStep(created.id)?.metadata?.providerBinding?.providerPresetId, "provider_workspace");
  assert.throws(() => store.updateChannelWorkflowStep(created.id, {
    toParticipantId: "teammate_builtin_qa",
  }, now), /immutable/);
  assert.throws(() => store.updateChannelWorkflowStep(created.id, {
    metadata: {
      ...created.metadata,
      providerBinding: {
        ...created.metadata.providerBinding,
        providerPresetId: "provider_tampered",
      },
    },
  }, now), /provider binding is immutable/);
  assert.throws(() => store.updateChannelWorkflowStep(created.id, {
    metadata: {
      ...created.metadata,
      participantAuthority: createWorkflowParticipantAuthorityV1({
        kind: "channel_selection",
        origin: "manual_channel_step",
        participantId: authority.participantId,
        sourceId: "tampered",
      }),
    },
  }, now), /immutable/);
  store.close();

  store = createSqliteRunStore(cwd);
  try {
    const reopened = store.getChannelWorkflowStep(created.id);
    assert.equal(reopened?.participantAuthority.fingerprint, authority.fingerprint);
    assert.equal(reopened?.participantAuthority.participantId, authority.participantId);
  } finally {
    store.close();
  }
});

test("Channel Intent v2 migration deletes v1 rows and preserves new v2 decisions on reopen", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-intent-v2-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = createLegacySqliteRunStoreForMigrationTest(cwd);
  const channel = legacy.createChannel({ name: "Intent v2", boundPath: cwd }, "2026-08-10T10:00:00.000Z");
  const message = appendLegacyChannelMessageFixture(legacy, {
    channelId: channel.id,
    authorType: "local-user",
    body: "Write an article",
  }, "2026-08-10T10:01:00.000Z");
  const legacyDatabase = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  legacyDatabase.prepare(`
    INSERT INTO channel_intent_decisions (
      id, schema_version, workspace_id, channel_id, source_message_id, action,
      selected_teammate_id, selected_teammate_ids_json, proposal_id, reply_message_id,
      reply_message_ids_json, workflow_id, reason, status, created_by, error_message,
      created_at, updated_at
    ) VALUES (
      'legacy-intent', 1, 'workspace_default', ?, ?, 'single_reply',
      'ling_agent', '[]', NULL, NULL, '[]', NULL, 'legacy', 'accepted',
      'deterministic', NULL, '2026-08-10T10:01:01.000Z', '2026-08-10T10:01:01.000Z'
    )
  `).run(channel.id, message.id);
  legacyDatabase.close();
  legacy.close();

  let store = createSqliteRunStore(cwd);
  assert.deepEqual(store.listChannelIntentDecisions({ channelId: channel.id }), []);
  const sourceItem = store.getConversationItem(message.id);
  assert.ok(sourceItem?.turnId);
  const assignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
  assert.ok(assignment);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: sourceItem.id,
    contextProjection: projectionFor(sourceItem, assignment),
    action: "reply",
    reason: "Ordinary content reply.",
    status: "accepted",
    createdBy: "deterministic",
  }, "2026-08-10T10:02:00.000Z");
  assert.equal(decision.schemaVersion, 2);
  assert.equal(decision.action, "reply");
  assert.deepEqual(decision.selectedTeammateIds, []);
  assert.deepEqual(decision.resultItemIds, []);
  store.close();

  store = createSqliteRunStore(cwd);
  assert.equal(store.getChannelIntentDecision(decision.id)?.id, decision.id);
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath, { readOnly: true });
  const columns = database.prepare("PRAGMA table_info(channel_intent_decisions)").all().map((row) => row.name);
  assert.equal(columns.includes("source_turn_id"), true);
  assert.equal(columns.includes("context_segment_id"), true);
  assert.equal(columns.includes("context_projection_version"), true);
  assert.equal(columns.includes("clarification_json"), true);
  assert.equal(columns.includes("execution_json"), true);
  assert.equal(columns.includes("source_message_id"), false);
  assert.equal(columns.includes("selected_teammate_id"), false);
  assert.equal(columns.includes("reply_message_ids_json"), false);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CHANNEL_INTENT_V2_MIGRATION_VERSION));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("Channel Intent execution-plan migration rewrites singular v2 JSON once", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-intent-plan-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Intent plan", boundPath: cwd }, "2026-08-12T10:00:00.000Z");
  store.close();

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  const item = database.prepare(`
    SELECT conversation_items.id AS item_id, conversation_items.turn_id, turn_context_assignments.segment_id
    FROM conversation_items
    INNER JOIN turn_context_assignments ON turn_context_assignments.turn_id = conversation_items.turn_id
    WHERE conversation_items.channel_id = ?
    LIMIT 1
  `).get(channel.id);
  assert.equal(item, undefined);
  database.close();

  store = createSqliteRunStore(cwd);
  const rootThread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Intent plan conversation",
    objective: "Test intent plan migration",
  }, "2026-08-12T10:00:30.000Z").thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: rootThread.id,
    title: "Create README.md",
    userInstruction: "Create README.md",
    payload: {
      body: "Create README.md",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "test:singular-v2-intent",
  }, "2026-08-12T10:01:00.000Z");
  store.close();

  database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION);
  database.prepare(`
    INSERT INTO channel_intent_decisions (
      id, schema_version, workspace_id, channel_id, source_turn_id, source_item_id,
      context_segment_id, context_projection_version, action,
      selected_teammate_ids_json, proposal_id, result_item_ids_json, workflow_id,
      reason, clarification_json, execution_json, status, created_by, error_code,
      created_at, updated_at
    ) VALUES (
      'singular-v2-intent', 2, 'workspace_default', ?, ?, ?, ?, 'projection-test',
      'execute', '["teammate_builtin_engineer"]', NULL, '[]', NULL, 'legacy v2 singular execution', NULL,
      '{"kind":"file_create","targetKind":"file"}', 'accepted', 'deterministic', NULL,
      '2026-08-12T10:01:01.000Z', '2026-08-12T10:01:01.000Z'
    )
  `).run(channel.id, ingested.turnId, ingested.item.id, ingested.contextSegmentId);
  database.close();

  store = createSqliteRunStore(cwd);
  assert.deepEqual(store.getChannelIntentDecision("singular-v2-intent").execution, {
    operations: [{
      id: "operation_1",
      kind: "file_create",
      targetKind: "file",
      targetRef: {
        type: "operation",
        id: "legacy:singular-v2-intent:operation_1",
        label: "Unresolved legacy file target",
      },
      required: true,
      dependsOn: [],
    }],
  });
  store.close();

  store = createSqliteRunStore(cwd);
  assert.equal(store.getChannelIntentDecision("singular-v2-intent").execution.operations.length, 1);
  store.close();
});

test("Channel Intent execution-plan migration repairs a recorded draft version", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-intent-plan-recorded-repair-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-12T11:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Recorded intent plan", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Recorded intent plan",
    objective: "Repair recorded migration 113",
  }, now).thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Create README.md",
    userInstruction: "Create README.md",
    payload: { body: "Create README.md", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "recorded-intent-plan-source",
  }, now);
  store.close();

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO channel_intent_decisions (
      id, schema_version, workspace_id, channel_id, source_turn_id, source_item_id,
      context_segment_id, context_projection_version, action,
      selected_teammate_ids_json, participant_manifest_json, proposal_id,
      result_item_ids_json, workflow_id, reason, clarification_json, execution_json,
      status, created_by, error_code, created_at, updated_at
    ) VALUES (
      'recorded-singular-v2-intent', 2, 'workspace_default', ?, ?, ?, ?, 'projection-test',
      'execute', '["teammate_builtin_engineer"]',
      '{"schemaVersion":1,"participants":[{"participantId":"teammate_builtin_engineer","role":"engineer","requirement":"required","expectedOutcome":"execution","requiredOperationIds":["operation_1"],"requestedBy":"structured_mention"}],"fingerprint":"invalid-until-114-repair"}',
      NULL, '[]', NULL, 'recorded singular execution', NULL,
      '{"kind":"file_create","targetKind":"file"}', 'accepted', 'deterministic', NULL,
      ?, ?
    )
  `).run(channel.id, ingested.turnId, ingested.item.id, ingested.contextSegmentId, now, now);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION));
  database.close();

  store = createSqliteRunStore(cwd);
  try {
    assert.deepEqual(store.getChannelIntentDecision("recorded-singular-v2-intent").execution, {
      operations: [{
        id: "operation_1",
        kind: "file_create",
        targetKind: "file",
        targetRef: {
          type: "operation",
          id: "legacy:recorded-singular-v2-intent:operation_1",
          label: "Unresolved legacy file target",
        },
        required: true,
        dependsOn: [],
      }],
    });
  } finally {
    store.close();
  }
  database = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("participant manifest migration repairs a recorded draft migration from selected participants", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-participant-manifest-repair-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-14T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Manifest repair", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Manifest repair",
    objective: "Repair manifest",
  }, now).thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Create file",
    userInstruction: "Create file",
    payload: { body: "Create file", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "manifest-repair-source",
  }, now);
  const assignment = store.getEffectiveTurnContextAssignment(ingested.turnId);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: ingested.item.id,
    contextProjection: projectionFor(ingested.item, assignment),
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest: createRequiredParticipantManifestV1([{
      participantId: "teammate_builtin_engineer",
      role: "engineer",
      requirement: "required",
      expectedOutcome: "execution",
      requiredOperationIds: ["create_file"],
      requestedBy: "structured_mention",
    }]),
    execution: { operations: [{
      id: "create_file",
      kind: "file_create",
      targetKind: "file",
      targetRef: { type: "operation", id: "file:create", label: "app.js" },
      required: true,
      dependsOn: [],
    }] },
    reason: "Create file",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  store.close();

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  database.prepare("UPDATE channel_intent_decisions SET participant_manifest_json = ? WHERE id = ?")
    .run(JSON.stringify(createRequiredParticipantManifestV1([])), decision.id);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION));
  database.close();

  store = createSqliteRunStore(cwd);
  const repaired = store.getChannelIntentDecision(decision.id).participantManifest;
  assert.deepEqual(repaired.participants.map((participant) => participant.participantId), ["teammate_builtin_engineer"]);
  assert.deepEqual(repaired.participants[0].requiredOperationIds, ["create_file"]);
  store.close();
  database = new DatabaseSync(databasePath, { readOnly: true });
  const column = database.prepare("PRAGMA table_info(channel_intent_decisions)").all()
    .find((item) => item.name === "participant_manifest_json");
  assert.equal(column.notnull, 1);
  database.close();
});

test("participant manifest migration unions operation ownership across repeated participant steps", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-participant-manifest-repeated-owner-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-14T01:30:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Repeated owner", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Repeated owner",
    objective: "Repair all operation ownership.",
  }, now).thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Create and edit file",
    userInstruction: "Create and edit file",
    payload: { body: "Create and edit file", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "manifest-repeated-owner-source",
  }, now);
  const execution = { operations: [
    {
      id: "create_file",
      kind: "file_create",
      targetKind: "file",
      targetRef: { type: "operation", id: "file:create", label: "app.js" },
      required: true,
      dependsOn: [],
    },
    {
      id: "edit_file",
      kind: "file_edit",
      targetKind: "file",
      targetRef: { type: "operation", id: "file:edit", label: "app.js" },
      required: true,
      dependsOn: ["create_file"],
    },
  ] };
  const manifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_engineer",
    role: "engineer",
    requirement: "required",
    expectedOutcome: "execution",
    requiredOperationIds: ["create_file", "edit_file"],
    requestedBy: "structured_mention",
  }]);
  const graph = {
    schemaVersion: 1,
    id: "graph_repeated_owner",
    name: "Repeated owner",
    entryNodeId: "create",
    nodes: [
      { id: "create", kind: "step", name: "Create", prompt: "Create app.js", teammateId: "teammate_builtin_engineer" },
      { id: "edit", kind: "step", name: "Edit", prompt: "Edit app.js", teammateId: "teammate_builtin_engineer" },
    ],
    edges: [{ id: "create_to_edit", fromNodeId: "create", toNodeId: "edit", condition: { kind: "all_succeeded" } }],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Create and edit file",
    objective: "Create and edit app.js",
    status: "running",
    createdBy: "system",
    metadata: {
      sourceTurnId: ingested.turnId,
      requiredParticipantManifest: manifest,
      workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
    },
  }, now);
  const createStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 0,
    title: "create_file",
    prompt: "create_file",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "queued",
    metadata: {
      graphId: graph.id,
      graphNodeId: "create",
      executionPlan: execution,
      executionOperationIds: ["create_file"],
      dependsOnStepIds: [],
    },
  }, now);
  store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 1,
    title: "edit_file",
    prompt: "edit_file",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "queued",
    metadata: {
      graphId: graph.id,
      graphNodeId: "edit",
      executionPlan: execution,
      executionOperationIds: ["edit_file"],
      dependsOnStepIds: [createStep.id],
    },
  }, now);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: ingested.item.id,
    contextProjection: projectionFor(ingested.item, store.getEffectiveTurnContextAssignment(ingested.turnId)),
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest: manifest,
    workflowId: workflow.id,
    execution,
    reason: "One participant owns two required operations across two steps.",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  store.updateChannelWorkflow(workflow.id, {
    metadata: {
      ...workflow.metadata,
      sourceIntentDecisionId: decision.id,
    },
  }, now);
  store.close();

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  database.prepare("UPDATE channel_intent_decisions SET participant_manifest_json = ? WHERE id = ?")
    .run(JSON.stringify(createRequiredParticipantManifestV1([])), decision.id);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(CHANNEL_PARTICIPANT_MANIFEST_MIGRATION_VERSION));
  database.close();

  store = createSqliteRunStore(cwd);
  assert.deepEqual(
    store.getChannelIntentDecision(decision.id).participantManifest.participants[0].requiredOperationIds,
    ["create_file", "edit_file"],
  );
  store.close();
  database = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("participant manifest migration rolls back conflicting selected and proposal participants", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-participant-manifest-conflict-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-14T02:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Manifest conflict", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id, title: "Conflict", objective: "Conflict" }, now).thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Engineer and QA",
    userInstruction: "Engineer and QA",
    payload: { body: "Engineer and QA", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "manifest-conflict-source",
  }, now);
  const proposal = store.createChannelExecutionProposal({
    channelId: channel.id,
    sourceMessageId: ingested.item.id,
    proposedByTeammateId: "ling_agent",
    title: "Engineer and QA",
    prompt: "Engineer and QA",
    assigneeTeammateId: "teammate_builtin_engineer",
    collaborationSteps: [{ teammateId: "teammate_builtin_qa", action: "reviewed", summary: "Verify" }],
    requiredTools: ["write", "bash"],
    status: "draft",
  }, now);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: ingested.item.id,
    contextProjection: projectionFor(ingested.item, store.getEffectiveTurnContextAssignment(ingested.turnId)),
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest: createRequiredParticipantManifestV1([{
      participantId: "teammate_builtin_engineer",
      role: "engineer",
      requirement: "required",
      expectedOutcome: "execution",
      requiredOperationIds: ["create_file"],
      requestedBy: "structured_mention",
    }]),
    proposalId: proposal.id,
    execution: { operations: [{
      id: "create_file",
      kind: "file_create",
      targetKind: "file",
      targetRef: { type: "operation", id: "file:create", label: "app.js" },
      required: true,
      dependsOn: [],
    }] },
    reason: "Conflicting sources",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  store.close();
  const databasePath = resolveRuntimePaths(cwd).databasePath;
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE channel_intent_decisions SET participant_manifest_json = ? WHERE id = ?")
    .run(JSON.stringify(createRequiredParticipantManifestV1([])), decision.id);
  database.close();
  assert.throws(() => createSqliteRunStore(cwd), /Participant manifest sources conflict/);
  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(JSON.parse(reopened.prepare("SELECT participant_manifest_json FROM channel_intent_decisions WHERE id = ?").get(decision.id).participant_manifest_json).participants, []);
  reopened.close();
});

test("delegated-step requirement migration repairs non-terminal step and Run snapshots on reopen", async (t) => {
  const fixture = await createDelegatedRequirementMigrationFixture(t, "repair");
  const databasePath = resolveRuntimePaths(fixture.cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  const stepMetadata = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?")
    .get(fixture.stepId).metadata_json);
  delete stepMetadata.delegatedRequirement;
  database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(stepMetadata), fixture.stepId);
  const requestSnapshot = JSON.parse(database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id = ?")
    .get(fixture.runId).request_snapshot_json);
  delete requestSnapshot.delegatedRequirement;
  database.prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify(requestSnapshot), fixture.runId);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(CHANNEL_DELEGATED_STEP_REQUIREMENT_MIGRATION_VERSION));
  database.close();

  createSqliteRunStore(fixture.cwd).close();
  createSqliteRunStore(fixture.cwd).close();

  database = new DatabaseSync(databasePath, { readOnly: true });
  const repairedStep = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?")
    .get(fixture.stepId).metadata_json).delegatedRequirement;
  const repairedRun = JSON.parse(database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id = ?")
    .get(fixture.runId).request_snapshot_json).delegatedRequirement;
  assert.equal(repairedStep.workflowStepId, fixture.stepId);
  assert.equal(repairedStep.participantId, "teammate_builtin_engineer");
  assert.deepEqual(repairedStep.requiredOperationIds, ["create_file"]);
  assert.equal(repairedRun.fingerprint, repairedStep.fingerprint);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("delegated-step requirement migration rolls back conflicting graph authority", async (t) => {
  const fixture = await createDelegatedRequirementMigrationFixture(t, "conflict");
  const databasePath = resolveRuntimePaths(fixture.cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  const workflowMetadata = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflows WHERE id = ?")
    .get(fixture.workflowId).metadata_json);
  workflowMetadata.workflowGraphFingerprint = "wgfv1_conflicting_graph";
  database.prepare("UPDATE channel_workflows SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(workflowMetadata), fixture.workflowId);
  const stepMetadata = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?")
    .get(fixture.stepId).metadata_json);
  delete stepMetadata.delegatedRequirement;
  database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(stepMetadata), fixture.stepId);
  database.close();

  assert.throws(() => createSqliteRunStore(fixture.cwd), /Delegated requirement authority is incomplete/);

  database = new DatabaseSync(databasePath, { readOnly: true });
  const after = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?")
    .get(fixture.stepId).metadata_json);
  assert.equal(after.delegatedRequirement, undefined);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("evidence publication migration repairs a recorded version with an unsealed recoverable packet", async (t) => {
  const fixture = await createEvidencePublicationMigrationFixture(t, "repair");
  const databasePath = resolveRuntimePaths(fixture.cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE artifacts SET sealed_payload_json = NULL, content_sha256 = NULL WHERE id = ?
  `).run(fixture.artifactId);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(CHANNEL_EVIDENCE_PUBLICATION_MIGRATION_VERSION));
  database.close();

  createSqliteRunStore(fixture.cwd).close();
  createSqliteRunStore(fixture.cwd).close();

  database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database.prepare(`
    SELECT sealed_payload_json, content_sha256 FROM artifacts WHERE id = ?
  `).get(fixture.artifactId);
  assert.equal(JSON.parse(row.sealed_payload_json).workflowStepId, fixture.stepId);
  assert.match(row.content_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("evidence publication migration rolls back a recoverable packet ownership conflict", async (t) => {
  const fixture = await createEvidencePublicationMigrationFixture(t, "conflict");
  const databasePath = resolveRuntimePaths(fixture.cwd).databasePath;
  let database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE artifacts SET sealed_payload_json = NULL, content_sha256 = NULL WHERE id = ?
  `).run(fixture.artifactId);
  const packetPath = join(resolveRuntimePaths(fixture.cwd).artifactsDir, fixture.artifactPath);
  await writeFile(packetPath, JSON.stringify({
    schemaVersion: 1,
    workflowId: fixture.workflowId,
    workflowStepId: "wfstep_wrong_owner",
    runId: fixture.runId,
  }), "utf8");
  database.close();

  assert.throws(() => createSqliteRunStore(fixture.cwd), /Workflow output packet ownership mismatch/);

  database = new DatabaseSync(databasePath, { readOnly: true });
  const after = database.prepare(`
    SELECT sealed_payload_json, content_sha256 FROM artifacts WHERE id = ?
  `).get(fixture.artifactId);
  assert.equal(after.sealed_payload_json, null);
  assert.equal(after.content_sha256, null);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

async function createEvidencePublicationMigrationFixture(t, suffix) {
  const fixture = await createDelegatedRequirementMigrationFixture(t, `evidence-${suffix}`);
  const paths = resolveRuntimePaths(fixture.cwd);
  const database = new DatabaseSync(paths.databasePath);
  const artifactId = `artifact_evidence_${suffix}`;
  const artifactPath = join(fixture.runId, "workflows", fixture.workflowId, "steps", fixture.stepId, "output.json");
  const packet = {
    schemaVersion: 1,
    workflowId: fixture.workflowId,
    workflowStepId: fixture.stepId,
    runId: fixture.runId,
    teammateId: "teammate_builtin_engineer",
    status: "succeeded",
    artifactIds: [],
    blockers: [],
    changedPaths: [],
    sourceRefs: [],
    generatedAt: "2026-08-14T04:00:00.000Z",
  };
  const packetAbsolutePath = join(paths.artifactsDir, artifactPath);
  await mkdir(join(paths.artifactsDir, fixture.runId, "workflows", fixture.workflowId, "steps", fixture.stepId), { recursive: true });
  await writeFile(packetAbsolutePath, `${JSON.stringify(packet)}\n`, "utf8");
  database.prepare(`
    INSERT INTO artifacts (
      id, run_id, media_job_id, external_work_id, type, path, title,
      content_type, size_bytes, sealed_payload_json, content_sha256, created_at
    ) VALUES (?, ?, NULL, NULL, 'json', ?, 'Workflow output packet',
      'application/json; charset=utf-8', NULL, ?, ?, '2026-08-14T04:00:00.000Z')
  `).run(artifactId, fixture.runId, artifactPath, JSON.stringify(packet), sha256Json(packet));
  const stepMetadata = JSON.parse(database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?")
    .get(fixture.stepId).metadata_json);
  stepMetadata.outputArtifactId = artifactId;
  database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(stepMetadata), fixture.stepId);
  database.close();
  return { ...fixture, artifactId, artifactPath };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function createDelegatedRequirementMigrationFixture(t, suffix) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-channel-delegated-requirement-${suffix}-`));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = "2026-08-14T03:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: `Delegated ${suffix}`, boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: `Delegated ${suffix}`,
    objective: "Verify delegated migration",
  }, now).thread;
  const ingested = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Create app.js",
    userInstruction: "Create app.js",
    payload: { body: "Create app.js", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `delegated-requirement-${suffix}`,
  }, now);
  const manifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_engineer",
    role: "engineer",
    requirement: "required",
    expectedOutcome: "execution",
    requiredOperationIds: ["create_file"],
    requestedBy: "explicit_role",
  }]);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: ingested.item.id,
    contextProjection: projectionFor(ingested.item, store.getEffectiveTurnContextAssignment(ingested.turnId)),
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest: manifest,
    execution: { operations: [{
      id: "create_file",
      kind: "file_create",
      targetKind: "file",
      targetRef: { type: "operation", id: "file:create", label: "app.js" },
      required: true,
      dependsOn: [],
    }] },
    reason: "Create app.js",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  const graph = {
    schemaVersion: 1,
    id: `graph_${suffix}`,
    entryNodeId: "engineer",
    nodes: [{ id: "engineer", kind: "step", name: "Engineer", prompt: "Create app.js", teammateId: "teammate_builtin_engineer" }],
    edges: [],
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Create app.js",
    objective: "Create app.js",
    status: "running",
    createdBy: "system",
    metadata: {
      sourceTurnId: ingested.turnId,
      sourceIntentDecisionId: decision.id,
      requiredParticipantManifest: manifest,
      workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
    },
  }, now);
  const step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Engineer",
    prompt: "Create app.js",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "running",
    metadata: {
      graphId: graph.id,
      graphNodeId: "engineer",
      executionPlan: decision.execution,
      executionOperationIds: ["create_file"],
      dependsOnStepIds: [],
    },
  }, now);
  const task = store.createTask({ channelId: channel.id, title: "Engineer", prompt: "Create app.js" }, now);
  const runId = `run_delegated_requirement_${suffix}`;
  store.createRun({
    id: runId,
    cwd,
    taskId: task.id,
    channelId: channel.id,
    teammateId: "teammate_builtin_engineer",
    workflowStepId: step.id,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: task,
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, workflowStepId: step.id },
    createdAt: now,
  });
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId }, now);
  store.close();
  return { cwd, workflowId: workflow.id, stepId: step.id, runId };
}

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}
