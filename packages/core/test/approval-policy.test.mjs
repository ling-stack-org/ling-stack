import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
  resolveSessionRunPolicy,
} from "../dist/index.js";

test("sqlite store creates the default approval policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const store = createSqliteRunStore(cwd);
  try {
    const policy = store.getApprovalPolicy();

    assert.equal(policy.workspaceId, "workspace_default");
    assert.deepEqual(policy.toolDecisions, defaultApprovalToolDecisions);
    assert.deepEqual(policy.allowedWritePaths, defaultAllowedWritePaths);
    assert.equal(policy.createdAt, policy.updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store merges and persists approval policy updates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const updatedAt = "2026-05-21T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const updated = store.updateApprovalPolicy(
      {
        toolDecisions: {
          bash: "allow",
          write: "deny",
        },
        allowedWritePaths: [".", "docs"],
      },
      updatedAt,
    );

    assert.equal(updated.toolDecisions.read, "allow");
    assert.equal(updated.toolDecisions.bash, "allow");
    assert.equal(updated.toolDecisions.edit, "ask");
    assert.equal(updated.toolDecisions.write, "deny");
    assert.deepEqual(updated.allowedWritePaths, [".", "docs"]);
    assert.equal(updated.updatedAt, updatedAt);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getApprovalPolicy();

    assert.equal(persisted.toolDecisions.bash, "allow");
    assert.equal(persisted.toolDecisions.write, "deny");
    assert.deepEqual(persisted.allowedWritePaths, [".", "docs"]);
    assert.equal(persisted.updatedAt, updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session permission policy snapshots structured risk notes without relaxing deny rules", () => {
  const policyUpdatedAt = "2026-06-04T00:00:00.000Z";
  const result = resolveSessionRunPolicy({
    workspacePolicy: {
      workspaceId: "workspace_default",
      toolDecisions: {
        ...defaultApprovalToolDecisions,
        bash: "deny",
        write: "deny",
      },
      allowedWritePaths: ["docs"],
      createdAt: policyUpdatedAt,
      updatedAt: policyUpdatedAt,
    },
    permissionMode: "full_access",
  });

  assert.equal(result.approvalPolicy.toolDecisions.bash, "deny");
  assert.equal(result.approvalPolicy.toolDecisions.write, "deny");
  assert.deepEqual(result.snapshot.allowedWritePaths, ["/"]);
  assert.equal(result.snapshot.workspacePolicyUpdatedAt, policyUpdatedAt);
  assert.deepEqual(
    result.snapshot.riskNotes.filter((note) => note.code === "session_mode_denied_by_workspace_policy").map((note) => note.tool),
    ["bash", "write"],
  );
});

test("sqlite store persists run artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-artifacts-"));
  const now = "2026-05-22T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_artifact_test",
      cwd,
      taskId: "task_artifact_test",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_artifact_test", title: "Artifact test" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const created = store.createArtifact({
      id: "artifact_test_markdown",
      runId: "run_artifact_test",
      type: "markdown",
      path: "run_artifact_test/result.md",
      title: "Result Markdown",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      createdAt: now,
    });

    assert.equal(created.id, "artifact_test_markdown");
    assert.equal(created.runId, "run_artifact_test");
    assert.equal(created.type, "markdown");
    assert.equal(created.path, "run_artifact_test/result.md");
    assert.equal(created.title, "Result Markdown");
    assert.equal(created.contentType, "text/markdown; charset=utf-8");
    assert.equal(created.sizeBytes, 42);
    assert.deepEqual(store.listArtifacts("run_artifact_test"), [created]);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const fetched = store.getArtifact("artifact_test_markdown");
    assert.ok(fetched);
    assert.equal(fetched.path, "run_artifact_test/result.md");
    assert.deepEqual(store.listArtifacts("run_artifact_test"), [fetched]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists run interventions, idempotency, FIFO order, cancellation, and lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-interventions-"));
  const now = "2026-06-04T03:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_source",
      cwd,
      taskId: "task_guided",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_guided", title: "Guided task", prompt: "Build the feature." },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, permissionMode: "balanced", requestedSkillId: "implement" },
      workUnitId: "wu_source",
      createdAt: now,
    });

    const first = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        sourceWorkUnitId: "wu_source",
        mode: "queue_followup",
        instruction: "After this finishes, check the settings page.",
        idempotencyKey: "guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:01:00.000Z",
    );
    const duplicate = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        sourceWorkUnitId: "wu_source",
        mode: "queue_followup",
        instruction: "Duplicate should not create another row.",
        idempotencyKey: "guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:01:05.000Z",
    );
    const second = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        mode: "interrupt_redirect",
        instruction: "Stop and use the daemon API path.",
        idempotencyKey: "redirect-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:02:00.000Z",
    );

    assert.equal(duplicate.id, first.id);
    assert.equal(store.listRunInterventions({ sourceRunId: "run_source" }).length, 2);
    assert.deepEqual(
      store.listRunInterventions({ sourceRunId: "run_source" }).map((intervention) => intervention.id),
      [first.id, second.id],
    );

    const cancelled = store.cancelRunIntervention(first.id, "2026-06-04T03:03:00.000Z", "user_cancelled");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.failureReason, "user_cancelled");

    store.createRun({
      id: "run_continuation",
      cwd,
      taskId: "task_guided",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_guided", title: "Guided task" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, continuation: true },
      parentRunId: "run_source",
      interventionId: second.id,
      continuationReason: "interrupt_redirect",
      workUnitId: "wu_continuation",
      createdAt: "2026-06-04T03:04:00.000Z",
    });

    const started = store.updateRunInterventionStatus({
      interventionId: second.id,
      status: "started",
      continuationRunId: "run_continuation",
      continuationWorkUnitId: "wu_continuation",
      startedAt: "2026-06-04T03:04:00.000Z",
      completedAt: "2026-06-04T03:04:00.000Z",
      now: "2026-06-04T03:04:00.000Z",
    });
    assert.equal(started?.continuationRunId, "run_continuation");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const interventions = store.listRunInterventions({ sourceRunId: "run_source" });
    assert.equal(interventions.length, 2);
    assert.equal(interventions[0].status, "cancelled");
    assert.equal(interventions[1].continuationRunId, "run_continuation");
    const continuation = store.getRun("run_continuation");
    assert.equal(continuation?.parentRunId, "run_source");
    assert.equal(continuation?.interventionId, interventions[1].id);
    assert.equal(continuation?.continuationReason, "interrupt_redirect");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists media jobs and status updates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-jobs-"));
  const createdAt = "2026-05-23T00:00:00.000Z";
  const updatedAt = "2026-05-23T00:01:00.000Z";
  let store = createSqliteRunStore(cwd);
  let jobId = "";
  try {
    const created = store.createMediaJob(
      {
        providerPresetId: "provider_seedream",
        operation: "image_generate",
        prompt: "Generate a clean product mockup.",
        input: { size: "1024x1024", apiKey: "sk-test_123456789" },
      },
      createdAt,
    );
    jobId = created.id;

    assert.equal(created.providerPresetId, "provider_seedream");
    assert.equal(created.operation, "image_generate");
    assert.equal(created.status, "queued");
    assert.deepEqual(created.artifactIds, []);
    assert.equal(created.input.size, "1024x1024");
    assert.equal(created.input.apiKey, "[REDACTED]");

    const artifact = store.createArtifact({
      id: "artifact_media_job_markdown",
      mediaJobId: created.id,
      type: "markdown",
      path: `${created.id}/static-result.md`,
      title: "Static media result",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt,
    });
    assert.equal(artifact.mediaJobId, created.id);
    assert.equal(artifact.runId, undefined);
    assert.deepEqual(store.listMediaJobArtifacts(created.id), [artifact]);

    const updated = store.updateMediaJobStatus(
      created.id,
      {
        status: "succeeded",
        artifactIds: [artifact.id],
      },
      updatedAt,
    );
    assert.ok(updated);
    assert.equal(updated.status, "succeeded");
    assert.deepEqual(updated.artifactIds, [artifact.id]);
    assert.equal(updated.updatedAt, updatedAt);
    assert.deepEqual(store.listMediaJobs({ status: "succeeded" }), [updated]);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const fetched = store.getMediaJob(jobId);
    assert.ok(fetched);
    assert.equal(fetched.status, "succeeded");
    assert.equal(fetched.prompt, "Generate a clean product mockup.");
    assert.deepEqual(fetched.artifactIds, ["artifact_media_job_markdown"]);
    assert.deepEqual(store.listMediaJobArtifacts(jobId), [store.getArtifact("artifact_media_job_markdown")]);
    assert.deepEqual(store.listMediaJobs({ providerPresetId: "provider_seedream" }), [fetched]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store expires pending approval requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-expiry-"));
  const now = "2026-05-22T00:00:00.000Z";
  const expiredAt = "2026-05-22T00:30:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_expiry",
      cwd,
      taskId: "task_approval_expiry",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_expiry", title: "Approval expiry" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const pending = store.createApprovalRequest(
      {
        runId: "run_approval_expiry",
        taskId: "task_approval_expiry",
        actionType: "bash",
        risk: "medium",
        title: "Approve shell command",
        description: "echo wait",
        payload: { type: "bash", cwd, command: "echo wait", riskFlags: [] },
        expiresAt: expiredAt,
      },
      now,
    );

    const expired = store.expireApprovalRequest(
      pending.id,
      { reason: "Approval request expired before a decision was received." },
      expiredAt,
    );

    assert.ok(expired);
    assert.equal(expired.status, "expired");
    assert.equal(expired.resolvedAt, expiredAt);
    assert.equal(expired.resolvedBy, undefined);
    assert.equal(expired.decisionReason, "Approval request expired before a decision was received.");
    assert.throws(() => store.approveApprovalRequest(pending.id, { reason: "too late" }, expiredAt), /not pending/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store creates and resolves media approval requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-approval-"));
  const createdAt = "2026-05-24T00:00:00.000Z";
  const expiresAt = "2026-05-24T00:30:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const job = store.createMediaJob(
      {
        providerPresetId: "provider_seedream",
        operation: "image_generate",
        prompt: "Generate a product image.",
      },
      createdAt,
    );

    const approval = store.createApprovalRequest(
      {
        mediaJobId: job.id,
        actionType: "media_cost",
        risk: "high",
        title: "Approve media job cost",
        description: "Seedream image_generate requires approval before live media execution.",
        payload: {
          type: "media_cost",
          providerPresetId: "provider_seedream",
          model: "seedream",
          operation: "image_generate",
          promptPreview: "Generate a product image.",
        },
        expiresAt,
      },
      createdAt,
    );

    assert.equal(approval.runId, undefined);
    assert.equal(approval.taskId, undefined);
    assert.equal(approval.mediaJobId, job.id);
    assert.deepEqual(store.listApprovalRequests({ mediaJobId: job.id }), [approval]);
    assert.deepEqual(store.listApprovalRequests({ runId: "run_missing" }), []);

    const approved = store.approveApprovalRequest(approval.id, { reason: "Approved for smoke." }, "2026-05-24T00:05:00.000Z");
    assert.ok(approved);
    assert.equal(approved.status, "approved");
    assert.equal(approved.mediaJobId, job.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite migration preserves legacy run approval owners", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-migration-"));
  const rootDir = resolve(cwd, ".ling-stack");
  const databasePath = resolve(rootDir, "ling-stack.sqlite");
  const now = "2026-05-24T00:00:00.000Z";
  await mkdir(rootDir, { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE run_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel_id TEXT,
        teammate_id TEXT,
        provider_preset_id TEXT,
        provider_name TEXT NOT NULL,
        provider_model TEXT NOT NULL,
        task_snapshot_json TEXT NOT NULL,
        provider_snapshot_json TEXT NOT NULL,
        request_snapshot_json TEXT NOT NULL,
        event_log_path TEXT NOT NULL,
        summary_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel_id TEXT,
        tool_call_id TEXT,
        action_type TEXT NOT NULL,
        risk TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        decision_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
      );
    `);
    legacy.prepare(`
      INSERT INTO run_sessions (
        id,
        status,
        cwd,
        task_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
        request_snapshot_json,
        event_log_path,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run_legacy_approval",
      "waiting_for_approval",
      cwd,
      "task_legacy_approval",
      "test-provider",
      "test-model",
      "{}",
      "{}",
      "{}",
      ".ling-stack/sessions/run_legacy_approval.jsonl",
      now,
      now,
    );
    legacy.prepare(`
      INSERT INTO approval_requests (
        id,
        run_id,
        task_id,
        action_type,
        risk,
        title,
        description,
        payload_json,
        status,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval_legacy",
      "run_legacy_approval",
      "task_legacy_approval",
      "bash",
      "medium",
      "Approve shell command",
      "echo legacy",
      JSON.stringify({ type: "bash", cwd, command: "echo legacy", riskFlags: [] }),
      "pending",
      now,
      "2026-05-24T00:30:00.000Z",
    );
  } finally {
    legacy.close();
  }

  const store = createSqliteRunStore(cwd);
  try {
    const approvals = store.listApprovalRequests({ runId: "run_legacy_approval" });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, "approval_legacy");
    assert.equal(approvals[0].runId, "run_legacy_approval");
    assert.equal(approvals[0].taskId, "task_legacy_approval");
    assert.equal(approvals[0].mediaJobId, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
