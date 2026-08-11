import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "./channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  authorizationAndAccessFromLegacyPermission,
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
  inferPermissionPreset,
  legacyPermissionFromAuthorizationAndAccess,
  permissionModeForPreset,
  permissionPresetRequiresConfirmation,
  resolveSessionRunPolicy,
  workspaceAccessModeRequiresConfirmation,
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

test("permission presets map to existing session permission modes", () => {
  assert.equal(permissionModeForPreset("read_only"), "ask_everything");
  assert.equal(permissionModeForPreset("workspace_collaboration"), "workspace_write");
  assert.equal(permissionModeForPreset("full_access"), "full_access");
  assert.equal(permissionModeForPreset("custom"), "custom");
  assert.equal(inferPermissionPreset("ask_everything"), "read_only");
  assert.equal(inferPermissionPreset("workspace_write"), "workspace_collaboration");
  assert.equal(inferPermissionPreset("full_access"), "full_access");
  assert.equal(inferPermissionPreset("balanced"), "custom");
  assert.equal(permissionPresetRequiresConfirmation("full_access"), true);
  assert.equal(permissionPresetRequiresConfirmation("workspace_collaboration"), false);
});

test("independent authorization and workspace access resolve the complete policy matrix", () => {
  const workspacePolicy = {
    workspaceId: "workspace_default",
    toolDecisions: defaultApprovalToolDecisions,
    allowedWritePaths: ["legacy-path"],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
  const expected = {
    read_only: {
      ask: ["deny", "deny", "deny"],
      smart: ["deny", "deny", "deny"],
      always: ["deny", "deny", "deny"],
    },
    workspace_write: {
      ask: ["ask", "ask", "ask"],
      smart: ["ask", "allow", "allow"],
      always: ["ask", "allow", "allow"],
    },
    full_access: {
      ask: ["ask", "ask", "ask"],
      smart: ["ask", "allow", "allow"],
      always: ["allow", "allow", "allow"],
    },
  };

  for (const workspaceAccessMode of ["read_only", "workspace_write", "full_access"]) {
    for (const authorizationMode of ["ask", "smart", "always"]) {
      const result = resolveSessionRunPolicy({
        workspacePolicy,
        authorizationMode,
        workspaceAccessMode,
        channelBoundPath: "/workspace/project",
      });
      assert.deepEqual(
        [
          result.approvalPolicy.toolDecisions.bash,
          result.approvalPolicy.toolDecisions.edit,
          result.approvalPolicy.toolDecisions.write,
        ],
        expected[workspaceAccessMode][authorizationMode],
      );
      assert.deepEqual(
        result.snapshot.allowedWritePaths,
        workspaceAccessMode === "read_only"
          ? []
          : workspaceAccessMode === "full_access"
            ? ["/"]
            : ["/workspace/project"],
      );
      assert.equal(result.snapshot.authorizationMode, authorizationMode);
      assert.equal(result.snapshot.workspaceAccessMode, workspaceAccessMode);
    }
  }
});

test("independent permissions preserve hard denies and compatibility projections", () => {
  const result = resolveSessionRunPolicy({
    workspacePolicy: {
      workspaceId: "workspace_default",
      toolDecisions: { ...defaultApprovalToolDecisions, edit: "deny" },
      allowedWritePaths: ["."],
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    authorizationMode: "always",
    workspaceAccessMode: "workspace_write",
  });

  assert.equal(result.approvalPolicy.toolDecisions.edit, "deny");
  assert.equal(result.approvalPolicy.toolDecisions.bash, "ask");
  assert.equal(result.snapshot.mode, "custom");
  assert.ok(result.snapshot.riskNotes.some((note) => note.code === "workspace_command_requires_approval"));
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("workspace_write", "workspace_collaboration"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("ask_everything", "full_access"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("custom", "full_access"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(legacyPermissionFromAuthorizationAndAccess("always", "workspace_write"), {
    permissionMode: "custom",
    permissionPreset: "custom",
  });
  assert.equal(workspaceAccessModeRequiresConfirmation("full_access"), true);
  assert.equal(workspaceAccessModeRequiresConfirmation("workspace_write"), false);
});

test("workspace settings persist independent defaults without cross-overwriting", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-workspace-permissions-"));
  let store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getWorkspaceSettings().defaultAuthorizationMode, "smart");
    assert.equal(store.getWorkspaceSettings().defaultWorkspaceAccessMode, "workspace_write");

    const authorizationOnly = store.updateWorkspaceSettings({ defaultAuthorizationMode: "ask" }, "2026-07-11T00:00:00.000Z");
    assert.equal(authorizationOnly.defaultAuthorizationMode, "ask");
    assert.equal(authorizationOnly.defaultWorkspaceAccessMode, "workspace_write");
    assert.equal(authorizationOnly.defaultPermissionMode, "custom");
    assert.equal(authorizationOnly.defaultPermissionPreset, "custom");

    const accessOnly = store.updateWorkspaceSettings({ defaultWorkspaceAccessMode: "read_only" }, "2026-07-11T00:01:00.000Z");
    assert.equal(accessOnly.defaultAuthorizationMode, "ask");
    assert.equal(accessOnly.defaultWorkspaceAccessMode, "read_only");
    assert.equal(accessOnly.defaultPermissionMode, "ask_everything");
    assert.equal(accessOnly.defaultPermissionPreset, "read_only");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const reopened = store.getWorkspaceSettings();
    assert.equal(reopened.defaultAuthorizationMode, "ask");
    assert.equal(reopened.defaultWorkspaceAccessMode, "read_only");
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

test("sqlite store persists run interventions, idempotency, FIFO order, cancellation, and lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-interventions-"));
  const now = "2026-06-04T03:00:00.000Z";
  let firstInterventionId = "";
  let attachmentId = "";
  let linkPreviewId = "";
  let store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Guidance", boundPath: cwd }, now);
    const otherChannel = store.createChannel({ name: "Other", boundPath: cwd }, now);
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "text",
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 32,
      path: `${channel.id}/notes.txt`,
      createdAt: now,
    });
    const otherAttachment = store.createChannelAttachment({
      channelId: otherChannel.id,
      kind: "text",
      fileName: "other.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      path: `${otherChannel.id}/other.txt`,
      createdAt: now,
    });
    const linkPreview = store.createChannelLinkPreview(
      {
        channelId: channel.id,
        url: "https://example.com/docs",
        normalizedUrl: "https://example.com/docs",
        title: "Docs",
        status: "ready",
      },
      now,
    );
    attachmentId = attachment.id;
    linkPreviewId = linkPreview.id;
    store.createRun({
      id: "run_source",
      cwd,
      taskId: "task_guided",
      channelId: channel.id,
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
        messagePayload: {
          body: "After this finishes, check the settings page.",
          attachmentIds: [attachment.id],
          linkPreviewIds: [linkPreview.id],
        },
        idempotencyKey: "guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:01:00.000Z",
    );
    firstInterventionId = first.id;
    assert.deepEqual(first.messagePayload, {
      body: "After this finishes, check the settings page.",
      attachmentIds: [attachment.id],
      linkPreviewIds: [linkPreview.id],
    });
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
    assert.throws(
      () => store.createRunIntervention(
        {
          sourceRunId: "run_source",
          mode: "queue_followup",
          instruction: "Cross-channel attachment should fail.",
          messagePayload: {
            body: "Cross-channel attachment should fail.",
            attachmentIds: [otherAttachment.id],
            linkPreviewIds: [],
          },
          idempotencyKey: "bad-cross-channel",
          requestedBy: "local-user",
        },
        "2026-06-04T03:02:30.000Z",
      ),
      /Attachment does not belong to channel/,
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
    assert.deepEqual(store.getRunIntervention(firstInterventionId).messagePayload, {
      body: "After this finishes, check the settings page.",
      attachmentIds: [attachmentId],
      linkPreviewIds: [linkPreviewId],
    });
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

test("sqlite store atomically claims pending interventions beyond the first history page", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-intervention-claim-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_claim_source",
      cwd,
      taskId: "task_claim_source",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: "2026-08-08T00:00:00.000Z",
    });

    let pendingId = "";
    for (let index = 0; index < 101; index += 1) {
      const createdAt = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1_000).toISOString();
      const intervention = store.createRunIntervention({
        sourceRunId: "run_claim_source",
        mode: "queue_followup",
        instruction: `guidance ${index}`,
        idempotencyKey: `claim-${index}`,
      }, createdAt);
      if (index < 100) {
        store.updateRunInterventionStatus({
          interventionId: intervention.id,
          expectedStatuses: ["queued"],
          status: "started",
          startedAt: createdAt,
          completedAt: createdAt,
          now: createdAt,
        });
      } else {
        pendingId = intervention.id;
      }
    }

    const claimed = store.claimNextRunIntervention({
      sourceRunId: "run_claim_source",
      expectedStatuses: ["cancelling_source", "queued"],
      status: "starting_continuation",
      startedAt: "2026-08-08T00:02:00.000Z",
      now: "2026-08-08T00:02:00.000Z",
    });
    assert.equal(claimed?.id, pendingId);
    assert.equal(claimed?.status, "starting_continuation");
    assert.equal(store.claimNextRunIntervention({
      sourceRunId: "run_claim_source",
      expectedStatuses: ["cancelling_source", "queued"],
      status: "starting_continuation",
      startedAt: "2026-08-08T00:02:01.000Z",
      now: "2026-08-08T00:02:01.000Z",
    }), undefined);
    assert.equal(store.updateRunInterventionStatus({
      interventionId: pendingId,
      expectedStatuses: ["queued"],
      status: "cancelled",
      now: "2026-08-08T00:02:02.000Z",
    }), undefined);
    assert.equal(store.getRunIntervention(pendingId)?.status, "starting_continuation");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store loads only the latest completed intervention replies before the current item", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-intervention-replies-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Continuation context", boundPath: cwd }, "2026-08-08T00:00:00.000Z");
    store.createRun({
      id: "run_reply_context_source",
      cwd,
      taskId: "task_reply_context_source",
      channelId: channel.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: "2026-08-08T00:00:00.000Z",
    });

    const replyIds = [];
    for (let index = 0; index < 8; index += 1) {
      const timestamp = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1_000).toISOString();
      const reply = appendChannelItemFixture(store, {
        channelId: channel.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: `reply ${index}`,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        status: "ready",
      }, timestamp);
      const workUnit = store.createWorkUnit({
        workspaceId: channel.workspaceId,
        kind: "channel_ai_reply",
        ownerType: "channel_message",
        ownerId: reply.id,
        channelId: channel.id,
        idempotencyKey: `reply-context-work-unit-${index}`,
        createdByActor: "local-user",
        request: {},
        linkedMessageId: reply.id,
        now: timestamp,
      });
      const intervention = store.createRunIntervention({
        sourceRunId: "run_reply_context_source",
        mode: "queue_followup",
        instruction: `guidance ${index}`,
        idempotencyKey: `reply-context-intervention-${index}`,
      }, timestamp);
      store.updateRunInterventionStatus({
        interventionId: intervention.id,
        expectedStatuses: ["queued"],
        status: "started",
        continuationWorkUnitId: workUnit.id,
        startedAt: timestamp,
        completedAt: timestamp,
        now: timestamp,
      });
      replyIds.push(reply.id);
    }
    const current = store.createRunIntervention({
      sourceRunId: "run_reply_context_source",
      mode: "queue_followup",
      instruction: "current guidance",
      idempotencyKey: "reply-context-current",
    }, "2026-08-08T00:00:09.000Z");

    assert.deepEqual(
      store.listPriorRunInterventionReplyMessages({
        sourceRunId: "run_reply_context_source",
        beforeInterventionId: current.id,
        channelId: channel.id,
        limit: 6,
      }).map((message) => message.id),
      replyIds.slice(-6),
    );
    assert.deepEqual(
      store.listPriorRunInterventionReplyMessages({
        sourceRunId: "run_reply_context_source",
        beforeInterventionId: current.id,
        channelId: channel.id,
      }).map((message) => message.id),
      replyIds,
    );
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

test("sqlite store keeps media production run history when scenes and projects are removed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-production-"));
  const createdAt = "2026-07-13T00:00:00.000Z";
  const updatedAt = "2026-07-13T00:02:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const project = store.createMediaProject({
      name: "Launch storyboard",
      defaultProviderPresetId: "provider_seedance",
      canvasViewport: { x: 10, y: -6, zoom: 1.2 },
    }, createdAt);
    const firstScene = store.createMediaScene({
      projectId: project.id,
      title: "Opening",
      prompt: "A cinematic product reveal.",
      ratio: "16:9",
      durationSeconds: 5,
      canvasPosition: { x: 40, y: 72 },
    }, createdAt);
    const secondScene = store.createMediaScene({
      projectId: project.id,
      title: "Close up",
      prompt: "A close up of the material.",
      ratio: "16:9",
      durationSeconds: 5,
      canvasPosition: { x: 360, y: 72 },
    }, createdAt);
    assert.deepEqual(store.listMediaScenes(project.id).map((scene) => scene.id), [firstScene.id, secondScene.id]);

    const reordered = store.reorderMediaScenes(project.id, [secondScene.id, firstScene.id], updatedAt);
    assert.deepEqual(reordered.map((scene) => scene.id), [secondScene.id, firstScene.id]);
    assert.deepEqual(reordered.map((scene) => scene.sortOrder), [0, 1]);

    const job = store.createMediaJob({
      providerPresetId: "provider_seedance",
      operation: "video_generate",
      prompt: secondScene.prompt,
      input: { ratio: "16:9", duration: 5 },
    }, updatedAt);
    const sceneRun = store.createMediaSceneRun({
      projectId: project.id,
      sceneId: secondScene.id,
      mediaJobId: job.id,
      providerSnapshot: { model: "seedance-1-0-pro" },
      inputSnapshot: { prompt: secondScene.prompt, apiKey: "sk-secret" },
    }, updatedAt);
    assert.deepEqual(store.getMediaSceneRunByMediaJobId(job.id), sceneRun);
    assert.equal(store.getMediaSceneRunByMediaJobId("media_job_missing"), undefined);
    const handle = store.upsertMediaJobExecutionHandle({
      mediaJobId: job.id,
      adapterKind: "seedance",
      externalOperationId: "task_123",
      recovery: { statusEndpoint: "https://example.invalid/tasks/task_123", authorization: "Bearer secret" },
    }, updatedAt);
    assert.equal(handle.externalOperationId, "task_123");
    assert.equal(handle.recovery.authorization, "[REDACTED]");

    const selected = store.updateMediaScene(secondScene.id, { selectedMediaSceneRunId: sceneRun.id }, updatedAt);
    assert.equal(selected?.selectedMediaSceneRunId, sceneRun.id);
    assert.equal(store.deleteMediaScene(secondScene.id), true);
    assert.equal(store.getMediaSceneRun(sceneRun.id)?.mediaJobId, job.id);
    assert.equal(store.getMediaJob(job.id)?.id, job.id);

    assert.equal(store.deleteMediaProject(project.id), true);
    assert.equal(store.getMediaSceneRun(sceneRun.id)?.sceneId, secondScene.id);
    assert.equal(store.getMediaJobExecutionHandle(job.id)?.externalOperationId, "task_123");
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

test("sqlite store creates approval checkpoints and syncs approval lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-checkpoints-"));
  const now = "2026-06-19T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_checkpoints",
      cwd,
      taskId: "task_approval_checkpoints",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_checkpoints", title: "Approval checkpoints" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const cases = [
      {
        suffix: "approved",
        method: "approveApprovalRequest",
        expectedStatus: "approved",
        reason: "Approved for smoke.",
        resolvedAt: "2026-06-19T00:01:00.000Z",
      },
      {
        suffix: "denied",
        method: "denyApprovalRequest",
        expectedStatus: "denied",
        reason: "Too risky.",
        resolvedAt: "2026-06-19T00:02:00.000Z",
      },
      {
        suffix: "expired",
        method: "expireApprovalRequest",
        expectedStatus: "expired",
        reason: "Timed out.",
        resolvedAt: "2026-06-19T00:03:00.000Z",
      },
      {
        suffix: "cancelled",
        method: "cancelApprovalRequest",
        expectedStatus: "cancelled",
        reason: "Run stopped.",
        resolvedAt: "2026-06-19T00:04:00.000Z",
      },
    ];

    for (const entry of cases) {
      const approval = store.createApprovalRequest(
        {
          runId: "run_approval_checkpoints",
          taskId: "task_approval_checkpoints",
          toolCallId: `tool_${entry.suffix}`,
          actionType: "bash",
          risk: "medium",
          title: `Approve ${entry.suffix}`,
          description: `echo ${entry.suffix}`,
          payload: { type: "bash", cwd, command: `echo ${entry.suffix}`, riskFlags: [] },
        },
        now,
      );

      const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
      assert.ok(checkpoint);
      assert.equal(checkpoint.approvalId, approval.id);
      assert.equal(checkpoint.runId, "run_approval_checkpoints");
      assert.equal(checkpoint.taskId, "task_approval_checkpoints");
      assert.equal(checkpoint.toolCallId, `tool_${entry.suffix}`);
      assert.equal(checkpoint.status, "pending");
      assert.equal(checkpoint.actionType, "bash");
      assert.deepEqual(checkpoint.sideEffect, approval.payload);
      assert.deepEqual(checkpoint.previewArtifactIds, []);
      assert.deepEqual(checkpoint.resultArtifactIds, []);

      const resolved = store[entry.method](approval.id, { reason: entry.reason }, entry.resolvedAt);
      assert.ok(resolved);
      assert.equal(resolved.status, entry.expectedStatus);

      const synced = store.getApprovalCheckpointForApproval(approval.id);
      assert.ok(synced);
      assert.equal(synced.status, entry.expectedStatus);
      assert.equal(synced.resolvedAt, entry.resolvedAt);
      assert.equal(synced.updatedAt, entry.resolvedAt);
      assert.deepEqual(store.listApprovalCheckpoints({ status: entry.expectedStatus }).map((item) => item.approvalId), [approval.id]);
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store updates approval checkpoint resume metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-resume-"));
  const now = "2026-06-19T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_resume",
      cwd,
      taskId: "task_approval_resume",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_resume", title: "Approval resume" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const approval = store.createApprovalRequest(
      {
        runId: "run_approval_resume",
        taskId: "task_approval_resume",
        actionType: "bash",
        risk: "high",
        title: "Approve resumable command",
        description: "echo resume",
        payload: { type: "bash", cwd, command: "echo resume", riskFlags: ["writes"] },
      },
      now,
    );
    const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(checkpoint);

    const resumePending = store.updateApprovalCheckpointStatus(
      checkpoint.id,
      {
        status: "resume_pending",
        previewArtifactIds: ["artifact_preview"],
        resultArtifactIds: ["artifact_result"],
        runnerResumeHandle: {
          kind: "ling_continuation",
          runId: "run_approval_resume",
          attemptId: "attempt_approval_resume",
          verified: true,
        },
      },
      "2026-06-19T01:01:00.000Z",
    );

    assert.ok(resumePending);
    assert.equal(resumePending.status, "resume_pending");
    assert.deepEqual(resumePending.previewArtifactIds, ["artifact_preview"]);
    assert.deepEqual(resumePending.resultArtifactIds, ["artifact_result"]);
    assert.deepEqual(resumePending.runnerResumeHandle, {
      kind: "ling_continuation",
      runId: "run_approval_resume",
      attemptId: "attempt_approval_resume",
      verified: true,
    });

    const resumeFailed = store.updateApprovalCheckpointStatus(
      checkpoint.id,
      {
        status: "resume_failed",
        runnerResumeHandle: null,
        resumeFailureReason: "Runner rejected resume handle.",
      },
      "2026-06-19T01:02:00.000Z",
    );

    assert.ok(resumeFailed);
    assert.equal(resumeFailed.status, "resume_failed");
    assert.equal(resumeFailed.runnerResumeHandle, undefined);
    assert.equal(resumeFailed.resumeFailureReason, "Runner rejected resume handle.");
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
        description: "Legacy media cost approval.",
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
    const checkpoint = store.getApprovalCheckpointForApproval("approval_legacy");
    assert.ok(checkpoint);
    assert.equal(checkpoint.id, "approval_checkpoint_approval_legacy");
    assert.equal(checkpoint.runId, "run_legacy_approval");
    assert.equal(checkpoint.taskId, "task_legacy_approval");
    assert.equal(checkpoint.status, "pending");
    assert.equal(checkpoint.createdAt, now);
    assert.deepEqual(checkpoint.sideEffect, { type: "bash", cwd, command: "echo legacy", riskFlags: [] });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
