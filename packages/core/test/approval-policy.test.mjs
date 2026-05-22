import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
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
