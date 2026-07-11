import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { buildContextPack, resolveProviderContextBudget } from "../dist/features/channels/context-packs.js";
import { routeChannelMessageReply } from "../dist/features/channels/channel-message-router.js";
import { buildLingAgentSessionViewForChannel } from "../dist/features/channels/ling-agent-session-view.js";
import { buildLingAgentTurnEnvelope } from "../dist/features/channels/ling-agent-turn-envelope.js";
import { availabilityIncidentInputForProviderRuntimeFailure } from "../dist/features/channels/provider-runtime-observations.js";
import { linkBodyExtractorV1 } from "../dist/features/channels/materialization/extractors/link-body.js";
import { officeExtractorV1 } from "../dist/features/channels/materialization/extractors/office.js";
import { pdfExtractorV1 } from "../dist/features/channels/materialization/extractors/pdf.js";
import { attachmentMaterializationFingerprint, linkPreviewMaterializationFingerprint } from "../dist/features/channels/materialization/fingerprints.js";
import { materializeInlineChannelInputs } from "../dist/features/channels/materialization/inline.js";
import { materializeInlineTeammateDirectInputs } from "../dist/features/teammates/direct-materialization.js";
import { ensureGitRepo, ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

const require = createRequire(import.meta.url);

async function readPdfFixtureBytes() {
  const pdfParseDir = dirname(require.resolve("pdf-parse/package.json"));
  return readFile(resolve(pdfParseDir, "test", "data", "04-valid.pdf"));
}

async function readDocxFixtureBytes() {
  const mammothDir = dirname(require.resolve("mammoth/package.json"));
  return readFile(resolve(mammothDir, "test", "test-data", "single-paragraph.docx"));
}

test("health exposes channel auto_route capability", async () => {
  const disabledDaemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: false, intentSelector: false, teamObserverBus: false } });
  try {
    const health = await getJson(`${disabledDaemon.url}/health`);
    assert.equal(health.features.channels.autoRoute, false);
    assert.equal(health.features.channels.intentSelector, false);
    assert.equal(health.features.channels.teamObserverBus, false);
  } finally {
    await disabledDaemon.close();
  }

  const enabledDaemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: true, intentSelector: true, teamObserverBus: true } });
  try {
    const health = await getJson(`${enabledDaemon.url}/health`);
    assert.equal(health.features.channels.autoRoute, true);
    assert.equal(health.features.channels.intentSelector, true);
    assert.equal(health.features.channels.teamObserverBus, true);
  } finally {
    await enabledDaemon.close();
  }
});

test("channel runtime policy rejects removed executionMode field", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-removed-execution-mode-"));
  const daemon = await startDaemonForTest();
  try {
    const response = await fetch(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Old runtime policy",
        status: "active",
        boundPath: cwd,
        allowedTools: ["read"],
        runtimePolicy: {
          maxConcurrentRuns: 2,
          executionMode: "parallel",
          writeLockScope: "boundPath",
          allowReadOnlyParallel: true,
          queueOnConflict: true,
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message, /executionMode has been removed/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider runtime availability mapper records transient failures only", () => {
  const providerPreset = {
    id: "provider_static",
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
  };

  const quota = availabilityIncidentInputForProviderRuntimeFailure({
    providerPreset,
    code: "rate_limited",
    message: "Too many requests",
    now: "2026-06-27T00:00:00.000Z",
  });
  assert.equal(quota?.kind, "quota");
  assert.equal(quota?.state, "rate_limited");
  assert.equal(quota?.providerPresetId, "provider_static");
  assert.equal(quota?.modelSignature?.model, "static-model");
  assert.equal(quota?.expiresAt, "2026-06-27T00:20:00.000Z");

  const network = availabilityIncidentInputForProviderRuntimeFailure({
    providerPreset,
    error: Object.assign(new Error("fetch failed: EAI_AGAIN"), { code: "network_failed" }),
    now: "2026-06-27T00:00:00.000Z",
  });
  assert.equal(network?.kind, "network");
  assert.equal(network?.state, "offline");

  const promptLeak = availabilityIncidentInputForProviderRuntimeFailure({
    providerPreset,
    error: new Error("Runner echoed internal channel context instead of an assistant reply."),
    now: "2026-06-27T00:00:00.000Z",
  });
  assert.equal(promptLeak, undefined);
});

test("channel branches follow archive restore and delete lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-branches-"));
  const stores = [];
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.push(store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const branch = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model routing fix",
    })).branch;
    assert.ok(branch.rootThreadId);
    const branchThread = (await getJson(`${daemon.url}/threads/${encodeURIComponent(branch.rootThreadId)}?cwd=${encodeURIComponent(cwd)}`)).thread;
    assert.equal(branchThread.kind, "channel_discussion");
    assert.equal(branchThread.channelId, channel.id);
    assert.equal(branchThread.title, "Model routing fix");

    const secondBranch = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}`, {
      name: "Prompt cleanup",
    })).branch;
    assert.ok(secondBranch.rootThreadId);
    assert.notEqual(secondBranch.rootThreadId, branch.rootThreadId);
    await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: branch.rootThreadId,
      body: "Message in model routing branch",
    });
    await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: secondBranch.rootThreadId,
      body: "Message in prompt cleanup branch",
    });
    const firstBranchMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(branch.rootThreadId)}`);
    assert.deepEqual(
      firstBranchMessages.messages
        .filter((message) => message.authorType === "local-user")
        .map((message) => message.body),
      ["Message in model routing branch"],
    );
    const secondBranchMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(secondBranch.rootThreadId)}`);
    assert.deepEqual(
      secondBranchMessages.messages
        .filter((message) => message.authorType === "local-user")
        .map((message) => message.body),
      ["Message in prompt cleanup branch"],
    );

    const store = stores.find((item) => item.paths.cwd === cwd);
    assert.ok(store);
    const legacyBranch = store.createChannelBranch({
      channelId: channel.id,
      name: "Legacy branch",
    }, "2026-06-22T00:00:00.000Z");
    assert.equal(legacyBranch.rootThreadId, undefined);
    const repairedBranches = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}`);
    const repairedLegacy = repairedBranches.branches.find((item) => item.id === legacyBranch.id);
    assert.ok(repairedLegacy?.rootThreadId);
    assert.equal(store.getChannelBranch(legacyBranch.id).rootThreadId, repairedLegacy.rootThreadId);

    let listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channels.some((item) => item.id === channel.id), true);
    assert.equal(listed.branches.some((item) => item.id === branch.id), true);

    const archivedBranch = (await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "archived",
    })).branch;
    assert.equal(archivedBranch.status, "archived");
    assert.ok(archivedBranch.archivedAt);
    const archivedThread = (await getJson(`${daemon.url}/threads/${encodeURIComponent(branch.rootThreadId)}?cwd=${encodeURIComponent(cwd)}`)).thread;
    assert.ok(archivedThread.archivedAt);
    assert.equal(archivedThread.archivedReason, "channel_branch_archived");

    listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.branches.some((item) => item.id === branch.id), false);

    let archivedBranches = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}&archived=true`);
    assert.equal(archivedBranches.branches.some((item) => item.id === branch.id), true);

    const restoredBranch = (await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "active",
    })).branch;
    assert.equal(restoredBranch.status, "active");
    assert.equal(restoredBranch.archivedAt, undefined);
    const restoredThread = (await getJson(`${daemon.url}/threads/${encodeURIComponent(branch.rootThreadId)}?cwd=${encodeURIComponent(cwd)}`)).thread;
    assert.equal(restoredThread.archivedAt, undefined);
    assert.equal(restoredThread.archivedReason, undefined);

    const activeDelete = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(activeDelete.status, 409);

    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "archived",
    });
    await deleteJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(cwd)}`);
    const deletedBranchThread = (await getJson(`${daemon.url}/threads/${encodeURIComponent(branch.rootThreadId)}?cwd=${encodeURIComponent(cwd)}`)).thread;
    assert.equal(deletedBranchThread.id, branch.rootThreadId);
    assert.ok(deletedBranchThread.archivedAt);
    archivedBranches = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}&archived=true`);
    assert.deepEqual(archivedBranches.branches, []);

    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "archived",
    });
    listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channels.some((item) => item.id === channel.id), false);

    const archivedChannels = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}&archived=true`);
    assert.deepEqual(archivedChannels.channels.map((item) => item.id), [channel.id]);

    const restoredChannel = (await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "active",
    })).channel;
    assert.equal(restoredChannel.status, "active");
    listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channels.some((item) => item.id === channel.id), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("context budget manager resolves provider modes and trims lower priority sections", () => {
  const providerBase = {
    id: "provider_context_test",
    kind: "openai",
    displayName: "Context Test",
    providerId: "openai",
    model: "context-model",
    api: "openai-responses",
    headers: {},
    input: ["text"],
    compat: {},
    capabilities: ["chat"],
    enabled: true,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };

  const known = resolveProviderContextBudget({ ...providerBase, contextWindow: 12000, maxTokens: 2000 }, "channel_reply");
  assert.equal(known.mode, "model_known");
  assert.equal(known.contextWindowTokens, 12000);
  assert.equal(known.reservedOutputTokens, 2000);
  assert.equal(known.inputBudgetTokens, 9488);
  assert.equal(known.capabilitySource, "user_override");
  assert.equal(known.capabilityConfidence, "known");

  const estimated = resolveProviderContextBudget(providerBase, "intent_selector");
  assert.equal(estimated.mode, "model_estimated");
  assert.equal(estimated.contextWindowTokens, 32768);
  assert.equal(estimated.reservedOutputTokens, 512);
  assert.equal(estimated.capabilitySource, "provider_metadata");
  assert.equal(estimated.capabilityConfidence, "estimated");

  const unknown = resolveProviderContextBudget({ ...providerBase, kind: "openai-compatible" }, "channel_reply");
  assert.equal(unknown.mode, "model_unknown");
  assert.equal(unknown.contextWindowTokens, 8192);
  assert.equal(unknown.capabilitySource, "conservative_default");
  assert.equal(unknown.capabilityConfidence, "conservative");

  const trimmed = buildContextPack({
    kind: "channel_reply",
    providerPreset: { ...providerBase, contextWindow: 1800, maxTokens: 512 },
    sections: [
      { id: "must", role: "user", priority: "must_keep", text: "must", estimatedTokens: 900 },
      { id: "high", role: "evidence", priority: "high", text: "high", estimatedTokens: 900 },
      { id: "low", role: "evidence", priority: "low", text: "low", estimatedTokens: 900 },
    ],
  });
  assert.deepEqual(trimmed.sections.map((section) => section.id), ["must"]);
  assert.deepEqual(trimmed.droppedSectionIds, ["low", "high"]);
  assert.equal(trimmed.overBudget, false);
});

test("ling agent session view is open when channel has no active work", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-open-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "hello");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.id, `ling-agent-session:${channel.id}`);
    assert.equal(view.status, "open");
    assert.equal(view.owner, "ling_agent");
    assert.equal(view.confirmation, undefined);
    assert.equal(view.progress, undefined);
    assert.equal(view.finalResult, undefined);
    assert.deepEqual(view.pendingApprovalIds, []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view projects draft proposal as task confirmation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-proposal-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel, message } = createStoreChannelAndMessage(store, cwd, `在 ${cwd} 下创建 README.md`);
    const proposal = store.createChannelExecutionProposal({
      channelId: channel.id,
      sourceMessageId: message.id,
      proposedByTeammateId: "ling_agent",
      title: "Create README.md",
      prompt: `Target: ${cwd}/README.md`,
      assigneeTeammateId: "ling_agent",
      requiredTools: ["write"],
      riskSummary: "Need write permission for README.md.",
      status: "draft",
    }, "2026-06-11T00:01:00.000Z");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "ready_for_confirmation");
    assert.equal(view.objective, proposal.title);
    assert.equal(view.confirmation?.proposalId, proposal.id);
    assert.deepEqual(view.confirmation?.requiredTools, ["write"]);
    assert.equal(view.confirmation?.assigneeTeammateId, "ling_agent");
    assert.ok(view.evidenceRefs.some((ref) => ref.type === "proposal" && ref.id === proposal.id));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("proposed plan APIs hydrate deleted source message state without deleting plans", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-proposed-plan-source-state-"));
  const store = createSqliteRunStore(cwd);
  let thread;
  let channel;
  let message;
  try {
    ({ channel, message } = createStoreChannelAndMessage(store, cwd, "source plan"));
    thread = store.createLingThread({
      kind: "channel",
      channelId: channel.id,
      title: "Plan source state",
      objective: "Hydrate proposed plan source state.",
    }, "2026-06-11T00:01:00.000Z");
    store.close();

    const daemon = await startDaemonForTest();
    try {
      const available = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/proposed-plans?cwd=${encodeURIComponent(cwd)}`, {
        id: "plan_available_source",
        channelId: channel.id,
        sourceMessageId: message.id,
        title: "Available source plan",
        bodyMarkdown: "Use the source message.",
      });
      assert.equal(available.plan.sourceMessageState, "available");

      const orphan = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/proposed-plans?cwd=${encodeURIComponent(cwd)}`, {
        id: "plan_deleted_source",
        channelId: channel.id,
        sourceMessageId: "msg_deleted_source",
        title: "Deleted source plan",
        bodyMarkdown: "Keep this plan for audit history.",
      });
      assert.equal(orphan.plan.sourceMessageState, "deleted");

      const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposed-plans?cwd=${encodeURIComponent(cwd)}&limit=20`);
      const listedOrphan = listed.plans.find((plan) => plan.id === "plan_deleted_source");
      assert.equal(listedOrphan?.sourceMessageState, "deleted");
      assert.equal(listed.plans.some((plan) => plan.id === "plan_available_source" && plan.sourceMessageState === "available"), true);
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel team metrics exposes visible evidence total separately from team evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-evidence-summary-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel, message } = createStoreChannelAndMessage(store, cwd, "collect evidence");
    const webMessage = store.createChannelMessage({
      channelId: channel.id,
      authorType: "ai-teammate",
      body: "web evidence",
      fileRefs: [{ path: `${cwd}/README.md`, line: 12 }],
    }, "2026-06-11T00:02:00.000Z");
    const workUnit = store.createWorkUnit({
      id: "wu_channel_web_evidence",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "channel_ai_reply",
      ownerType: "channel_message",
      ownerId: webMessage.id,
      channelId: channel.id,
      idempotencyKey: "wu-channel-web-evidence",
      createdByActor: "system",
      request: { messageId: webMessage.id },
      linkedMessageId: webMessage.id,
      now: "2026-06-11T00:02:05.000Z",
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      type: "web_evidence_recorded",
      actor: "system",
      ts: "2026-06-11T00:02:10.000Z",
      data: {
        toolSurface: "web",
        sourceMessageId: message.id,
        linkedMessageId: webMessage.id,
        sourceCount: 1,
        readUrlCount: 1,
        status: "degraded",
        query: "ling stack",
        sources: [{ url: "https://example.com/source", title: "Example source" }],
        readUrls: [{ url: "https://example.com/read", status: "blocked", reason: "timeout" }],
        updatedAt: "2026-06-11T00:02:10.000Z",
      },
    });
    const task = store.createTask({
      channelId: channel.id,
      title: "Evidence task",
      prompt: "Collect visible evidence.",
    }, "2026-06-11T00:03:00.000Z");
    const run = store.createRun({
      id: "run_channel_visible_evidence",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:04:00.000Z",
    });
    store.createApprovalRequest({
      runId: run.id,
      taskId: task.id,
      channelId: channel.id,
      actionType: "bash",
      risk: "medium",
      title: "Approve command",
      description: "Approve visible evidence command.",
      payload: { type: "bash", cwd, command: "echo ok", riskFlags: [] },
    }, "2026-06-11T00:04:30.000Z");
    store.createArtifact({
      runId: run.id,
      type: "file",
      path: `${cwd}/report.md`,
      title: "report.md",
      createdAt: "2026-06-11T00:05:00.000Z",
    });
    store.createChannelAttachment({
      channelId: channel.id,
      messageId: webMessage.id,
      kind: "text",
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 20,
      path: `${cwd}/notes.txt`,
      createdAt: "2026-06-11T00:05:30.000Z",
    });
    for (let index = 0; index < 25; index += 1) {
      store.createChannelAttachment({
        channelId: channel.id,
        messageId: webMessage.id,
        kind: "text",
        fileName: `extra-${index}.txt`,
        contentType: "text/plain",
        sizeBytes: 20 + index,
        path: `${cwd}/extra-${index}.txt`,
        createdAt: `2026-06-11T00:05:${String(31 + index).padStart(2, "0")}.000Z`,
      });
    }
    store.createChannelTeamEvidenceItem({
      channelId: channel.id,
      turnId: webMessage.id,
      agentId: "engineer",
      kind: "specialist_note",
      evidenceGrade: "observed",
      summary: "Team-only specialist evidence.",
      visibility: "internal",
      status: "completed",
    }, "2026-06-11T00:06:00.000Z");
    store.close();

    const daemon = await startDaemonForTest();
    try {
      const response = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/team-metrics?cwd=${encodeURIComponent(cwd)}&limit=50`);
      assert.equal(response.metrics.summary.totalEvidenceCount, 1);
      assert.equal(response.metrics.visibleEvidence.totalCount, 24);
      assert.deepEqual(response.metrics.visibleEvidence.countsByKind, {
        runs: 1,
        approvals: 1,
        browser: 2,
        files: 20,
        team_evidence: 1,
      });
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval-only workflow owner closes immediately after approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-approval-owner-"));
  const store = createSqliteRunStore(cwd);
  let workflow;
  let step;
  let approval;
  try {
    const channel = store.createChannel({ name: "Approval owner", boundPath: cwd }, "2026-06-11T00:00:00.000Z");
    workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Review risky command",
      objective: "Close the approval-only workflow owner.",
      status: "waiting_for_approval",
      createdBy: "system",
    }, "2026-06-11T00:01:00.000Z");
    step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Review risky shell command",
      prompt: "Review the proposed command.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "waiting_for_approval",
    }, "2026-06-11T00:01:10.000Z");
    approval = store.createApprovalRequest({
      workflowStepId: step.id,
      channelId: channel.id,
      actionType: "bash",
      risk: "high",
      title: "Review risky shell command",
      description: "Approval-only legacy workflow step.",
      payload: { type: "bash", cwd, command: "git status --short", riskFlags: ["requires_user_review"] },
    }, "2026-06-11T00:01:20.000Z");
    store.close();

    const daemon = await startDaemonForTest();
    try {
      const resolved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
        reason: "Reviewed.",
      });
      assert.equal(resolved.approval.status, "approved");

      const workflowResponse = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(workflowResponse.workflow.status, "succeeded");
      const stepsResponse = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(stepsResponse.workflowSteps.find((candidate) => candidate.id === step.id)?.status, "succeeded");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view projects active workflow approval wait", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-approval-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "帮我跑测试");
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Run tests",
      objective: "Run the test suite.",
      status: "running",
      createdBy: "ling_agent",
    }, "2026-06-11T00:01:00.000Z");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Execute test command",
      prompt: "Run tests.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "waiting_for_approval",
    }, "2026-06-11T00:02:00.000Z");
    const run = store.createRun({
      id: "run_ling_agent_session_waiting",
      cwd,
      taskId: "task_ling_agent_session_waiting",
      channelId: channel.id,
      teammateId: "ling_agent",
      workflowStepId: step.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_session_waiting", title: "Execute test command" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:03:00.000Z",
    });
    store.markRunWaitingForApproval(run.id, "2026-06-11T00:04:00.000Z");
    store.updateChannelWorkflowStep(step.id, { runId: run.id }, "2026-06-11T00:04:00.000Z");
    const approval = store.createApprovalRequest({
      runId: run.id,
      taskId: run.taskId,
      channelId: channel.id,
      actionType: "bash",
      risk: "medium",
      title: "Approve test command",
      description: "Run tests.",
      payload: { type: "bash", cwd, command: "pnpm test", riskFlags: [] },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, "2026-06-11T00:05:00.000Z");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "waiting_for_approval");
    assert.equal(view.activeWorkflowId, workflow.id);
    assert.equal(view.activeRunId, run.id);
    assert.deepEqual(view.pendingApprovalIds, [approval.id]);
    assert.equal(view.progress?.workflowId, workflow.id);
    assert.equal(view.progress?.activeStepId, step.id);
    assert.ok(view.evidenceRefs.some((ref) => ref.type === "approval" && ref.id === approval.id));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view projects terminal workflow final result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-final-workflow-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "实现并验证");
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Implement feature",
      objective: "Implement and verify the feature.",
      status: "succeeded",
      createdBy: "ling_agent",
    }, "2026-06-11T00:01:00.000Z");
    const firstStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 1,
      title: "Implementation",
      prompt: "Implement.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "succeeded",
    }, "2026-06-11T00:02:00.000Z");
    const secondStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 2,
      title: "Verification",
      prompt: "Verify.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "succeeded",
    }, "2026-06-11T00:03:00.000Z");
    const verificationRun = store.createRun({
      id: "run_ling_agent_session_final_verification",
      cwd,
      taskId: "task_ling_agent_session_final_verification",
      channelId: channel.id,
      teammateId: "ling_agent",
      workflowStepId: secondStep.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_session_final_verification", title: "Verify feature" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:03:30.000Z",
    });
    store.markRunSucceeded(verificationRun.id, "2026-06-11T00:04:30.000Z");
    const artifact = store.createArtifact({
      runId: verificationRun.id,
      type: "file",
      path: `${cwd}/src/feature.ts`,
      title: "feature.ts",
      contentType: "text/typescript; charset=utf-8",
      sizeBytes: 128,
      createdAt: "2026-06-11T00:04:45.000Z",
    });
    store.updateChannelWorkflowStep(firstStep.id, { resultSummary: "Implemented feature." }, "2026-06-11T00:04:00.000Z");
    store.updateChannelWorkflowStep(secondStep.id, {
      runId: verificationRun.id,
      resultSummary: "Verified checks.",
      metadata: { outputArtifactIds: [artifact.id] },
    }, "2026-06-11T00:05:00.000Z");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "succeeded");
    assert.equal(view.finalResult?.outcome, "succeeded");
    assert.equal(view.finalResult?.summary, "Verified checks.");
    assert.deepEqual(view.finalResult?.changedPaths, [`${cwd}/src/feature.ts`]);
    assert.deepEqual(view.finalResult?.artifactIds, [artifact.id]);
    assert.deepEqual(view.finalResult?.checks.map((check) => check.title), ["Implementation", "Verification"]);
    assert.ok(view.evidenceRefs.some((ref) => ref.type === "workflow" && ref.id === workflow.id));
    assert.ok(view.evidenceRefs.some((ref) => ref.type === "run" && ref.id === verificationRun.id));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view projects blocked workflow final result with next action", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-blocked-workflow-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "需要写文件");
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Create README.md",
      objective: "Create the requested file.",
      status: "blocked",
      createdBy: "ling_agent",
    }, "2026-06-11T00:01:00.000Z");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 1,
      title: "Create file",
      prompt: "Create README.md.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "blocked",
    }, "2026-06-11T00:02:00.000Z");
    store.updateChannelWorkflowStep(step.id, { blocker: "Write permission was not granted." }, "2026-06-11T00:03:00.000Z");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "blocked");
    assert.equal(view.finalResult?.outcome, "blocked");
    assert.equal(view.finalResult?.summary, "Write permission was not granted.");
    assert.deepEqual(view.finalResult?.nextActions, ["Write permission was not granted."]);
    assert.deepEqual(view.finalResult?.checks, [{
      id: step.id,
      title: "Create file",
      status: "blocked",
      summary: "Write permission was not granted.",
    }]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view projects terminal failed run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-failed-run-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "修复失败任务");
    const run = store.createRun({
      id: "run_ling_agent_session_failed",
      cwd,
      taskId: "task_ling_agent_session_failed",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_session_failed", title: "Fix failing task" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunFailed(run.id, "2026-06-11T00:02:00.000Z", "Typecheck failed.");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "failed");
    assert.equal(view.finalResult?.outcome, "failed");
    assert.equal(view.finalResult?.title, "Fix failing task");
    assert.equal(view.finalResult?.summary, "Typecheck failed.");
    assert.deepEqual(view.finalResult?.nextActions, ["Typecheck failed."]);
    assert.ok(view.evidenceRefs.some((ref) => ref.type === "run" && ref.id === run.id));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent session view reports denied approval for terminal run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-session-denied-approval-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel } = createStoreChannelAndMessage(store, cwd, "创建 README.md");
    const run = store.createRun({
      id: "run_ling_agent_session_denied_approval",
      cwd,
      taskId: "task_ling_agent_session_denied_approval",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_session_denied_approval", title: "Create README.md" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const approval = store.createApprovalRequest({
      runId: run.id,
      taskId: run.taskId,
      channelId: channel.id,
      actionType: "write",
      risk: "medium",
      title: "Approve README.md write",
      description: "Allow creating README.md.",
      payload: { type: "file_write", path: `${cwd}/README.md`, bytes: 16 },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, "2026-06-11T00:02:00.000Z");
    store.denyApprovalRequest(approval.id, { reason: "Need a narrower path.", resolvedBy: "local-user" }, "2026-06-11T00:03:00.000Z");
    store.markRunCancelled(run.id, "2026-06-11T00:04:00.000Z");

    const view = buildLingAgentSessionViewForChannel({ store, channelId: channel.id });

    assert.equal(view.status, "cancelled");
    assert.equal(view.finalResult?.outcome, "cancelled");
    assert.equal(view.finalResult?.summary, "Approval denied: Approve README.md write.");
    assert.deepEqual(view.finalResult?.nextActions, ["Need a narrower path."]);
    assert.deepEqual(view.finalResult?.approvals, [{
      approvalId: approval.id,
      actionType: "write",
      status: "denied",
      title: "Approve README.md write",
    }]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator queues active run follow-up before ordinary routing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-followup-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent Coordinator",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_ling_agent_coordinator_followup",
      cwd,
      taskId: "task_ling_agent_coordinator_followup",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_coordinator_followup", title: "Active work" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "完成后也更新 docs",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.activeSessionAction.mode, "queue_followup");
    assert.equal(created.activeSessionAction.status, "created");
    assert.equal(created.activeSessionAction.sourceRunId, run.id);
    assert.equal(created.intervention.sourceRunId, run.id);
    assert.equal(created.intervention.mode, "queue_followup");
    const interventions = store.listRunInterventions({ sourceRunId: run.id });
    assert.deepEqual(interventions.map((intervention) => intervention.id), [created.intervention.id]);
    assert.deepEqual(store.listEvents(run.id).map((event) => event.type), ["run_intervention_created", "run_followup_queued"]);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator queues attachment-only active run guidance", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-attachment-followup-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent Coordinator Attachment",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_ling_agent_coordinator_attachment_followup",
      cwd,
      taskId: "task_ling_agent_coordinator_attachment_followup",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_coordinator_attachment_followup", title: "Active work" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "followup.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("active run follow-up context", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.activeSessionAction.mode, "queue_followup");
    assert.equal(created.activeSessionAction.status, "created");
    assert.equal(created.activeSessionAction.sourceRunId, run.id);
    assert.equal(created.intervention.sourceRunId, run.id);
    assert.deepEqual(created.intervention.messagePayload.attachmentIds, [attachment.id]);
    assert.equal(created.intervention.messagePayload.body, "");
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator queues file-ref-only active run guidance", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-file-ref-followup-"));
  await writeFile(resolve(cwd, "README.md"), "# File ref guidance\n", "utf8");
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent Coordinator File Ref",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_ling_agent_coordinator_file_ref_followup",
      cwd,
      taskId: "task_ling_agent_coordinator_file_ref_followup",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_coordinator_file_ref_followup", title: "Active work" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      fileRefs: [{ path: "README.md", label: "README.md", source: "composer" }],
    });

    assert.equal(created.aiReply, undefined);
    assert.deepEqual(created.message.fileRefs, [{ path: "README.md", label: "README.md", source: "composer" }]);
    assert.equal(created.activeSessionAction.mode, "queue_followup");
    assert.equal(created.activeSessionAction.status, "created");
    assert.equal(created.activeSessionAction.sourceRunId, run.id);
    assert.equal(created.intervention.sourceRunId, run.id);
    assert.equal(created.intervention.messagePayload.body, "");
    assert.deepEqual(created.intervention.messagePayload.attachmentIds, []);
    assert.deepEqual(created.intervention.messagePayload.linkPreviewIds, []);
    assert.equal(created.intervention.messagePayload.fileRefs[0].path, "README.md");
    assert.equal(created.intervention.messagePayload.fileRefs[0].rootRelation, "inside_workspace");
    assert.equal(created.intervention.messagePayload.fileRefs[0].kind, "file");
    assert.equal(created.intervention.messagePayload.fileRefs[0].materializationStatus, "metadata_only");
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent turn envelope merges persisted and explicit text file refs safely", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-turn-file-refs-"));
  await writeFile(resolve(cwd, "README.md"), "# Current README\n", "utf8");
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({
      name: "Ling Agent File Refs",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Also inspect file:README.md and path:/tmp/outside.txt",
      fileRefs: [{ path: "README.md", label: "README.md", source: "composer" }],
    }, "2026-06-11T00:01:00.000Z");

    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });

    assert.deepEqual(envelope.fileRefs.map((ref) => ref.path), ["README.md", "/tmp/outside.txt"]);
    assert.equal(envelope.fileRefs[0].source, "composer");
    assert.equal(envelope.fileRefs[0].rootRelation, "inside_workspace");
    assert.equal(envelope.fileRefs[0].kind, "file");
    assert.equal(envelope.fileRefs[1].source, "explicit_text");
    assert.equal(envelope.fileRefs[1].rootRelation, "outside_workspace");
    assert.equal(envelope.fileRefs[1].materializationStatus, "blocked");
    assert.match(envelope.fileRefs[1].blockedReason, /outside the active workspace/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel input materialization cache upserts and feeds turn envelope", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-input-materialization-cache-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({
      name: "Materialization cache",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "screenshot.png",
      contentType: "image/png",
      sizeBytes: 128,
      path: "screenshot.png",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const fingerprint = attachmentMaterializationFingerprint(attachment);

    const first = store.createChannelInputMaterialization({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
      sourceFingerprint: fingerprint,
      extractorId: "image_vision_summary_v1",
      extractorVersion: "1",
      contentKind: "vision_summary",
      status: "available",
      contentText: "The screenshot shows a save button overlapping the sidebar.",
      byteCount: 128,
      tokenEstimate: 12,
      policyDecisionJson: { source: "test" },
    }, "2026-06-11T00:02:00.000Z");
    const second = store.createChannelInputMaterialization({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
      sourceFingerprint: fingerprint,
      extractorId: "image_vision_summary_v1",
      extractorVersion: "1",
      contentKind: "vision_summary",
      status: "available",
      contentText: "Updated screenshot summary from cache.",
      truncated: true,
    }, "2026-06-11T00:03:00.000Z");

    assert.equal(second.id, first.id);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contentText, "Updated screenshot summary from cache.");
    assert.equal(rows[0].truncated, true);
    assert.deepEqual(first.policyDecisionJson, { source: "test" });

    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Fix this screenshot",
      attachmentIds: [attachment.id],
    }, "2026-06-11T00:04:00.000Z");
    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });

    assert.equal(envelope.attachments.length, 1);
    assert.equal(envelope.attachments[0].materializationStatus, "available");
    assert.equal(envelope.attachments[0].materializationId, first.id);
    assert.equal(envelope.attachments[0].previewStatus, "available");
    assert.equal(envelope.attachments[0].previewText, "Updated screenshot summary from cache.");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inline materialization writes image vision cache with injected summarizer", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-image-vision-inline-cache-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    await writeFile(resolve(store.paths.attachmentsDir, "inline.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const channel = store.createChannel({
      name: "Image vision materialization",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "inline.png",
      contentType: "image/png",
      sizeBytes: 8,
      path: "inline.png",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Please handle this.",
      attachmentIds: [attachment.id],
    }, "2026-06-11T00:02:00.000Z");

    let summarizerCalls = 0;
    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: message,
      now: "2026-06-11T00:03:00.000Z",
      imageVisionSummarizer: async (input) => {
        summarizerCalls += 1;
        assert.equal(input.attachment.id, attachment.id);
        assert.equal(input.maxBytes, 5 * 1024 * 1024);
        assert.equal(input.maxChars, 4_000);
        assert.match(input.absolutePath, /inline\.png$/);
        return {
          contentText: "The screenshot shows a save button overlapping the sidebar.",
          structuredSummary: { source: "test_summarizer" },
          policyDecision: { mode: "test" },
        };
      },
    });

    assert.equal(summarizerCalls, 1);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].extractorId, "image_vision_summary_v1");
    assert.equal(rows[0].contentKind, "vision_summary");
    assert.equal(rows[0].status, "available");
    assert.match(rows[0].contentText, /save button overlapping/);
    assert.deepEqual(rows[0].structuredSummaryJson, { source: "test_summarizer" });
    assert.deepEqual(rows[0].policyDecisionJson, { mode: "test" });

    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });
    assert.equal(envelope.attachments[0].materializationStatus, "available");
    assert.equal(envelope.attachments[0].previewStatus, "available");
    assert.match(envelope.attachments[0].previewText, /save button overlapping/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inline image materialization reuses same image content after provider timeout", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-image-vision-content-cache-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    await writeFile(resolve(store.paths.attachmentsDir, "first.png"), imageBytes);
    await writeFile(resolve(store.paths.attachmentsDir, "second.png"), imageBytes);
    const channel = store.createChannel({
      name: "Image vision content cache",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const firstAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "same.png",
      contentType: "image/png",
      sizeBytes: imageBytes.byteLength,
      path: "first.png",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const firstMessage = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "看下这个图片",
      attachmentIds: [firstAttachment.id],
    }, "2026-06-11T00:02:00.000Z");

    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: firstMessage,
      now: "2026-06-11T00:03:00.000Z",
      imageVisionSummarizer: async () => ({
        contentText: "The image shows a red banner with visible Chinese text.",
        structuredSummary: { source: "first_pass" },
      }),
    });

    const secondAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "same.png",
      contentType: "image/png",
      sizeBytes: imageBytes.byteLength,
      path: "second.png",
      createdAt: "2026-06-11T00:04:00.000Z",
    });
    const secondMessage = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "同一张图再看一次",
      attachmentIds: [secondAttachment.id],
    }, "2026-06-11T00:05:00.000Z");

    let timeoutSummarizerCalls = 0;
    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: secondMessage,
      now: "2026-06-11T00:06:00.000Z",
      imageVisionSummarizer: async () => {
        timeoutSummarizerCalls += 1;
        throw new Error("The operation was aborted due to timeout");
      },
    });

    assert.equal(timeoutSummarizerCalls, 0);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: secondAttachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "available");
    assert.match(rows[0].contentText, /red banner/);

    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: secondMessage });
    assert.equal(envelope.attachments[0].materializationStatus, "available");
    assert.match(envelope.attachments[0].previewText, /red banner/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retryable image materialization failures are not cached permanently", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-image-vision-timeout-retry-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
    await writeFile(resolve(store.paths.attachmentsDir, "retry.png"), imageBytes);
    const channel = store.createChannel({
      name: "Image vision timeout retry",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "retry.png",
      contentType: "image/png",
      sizeBytes: imageBytes.byteLength,
      path: "retry.png",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "看下这个图片",
      attachmentIds: [attachment.id],
    }, "2026-06-11T00:02:00.000Z");

    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: message,
      now: "2026-06-11T00:03:00.000Z",
      imageVisionSummarizer: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    });
    assert.equal(store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    }).length, 0);

    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: message,
      now: "2026-06-11T00:04:00.000Z",
      imageVisionSummarizer: async () => ({
        contentText: "The retried image summary is available.",
      }),
    });

    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "available");
    assert.match(rows[0].contentText, /retried image summary/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct materialization reads image attachments with injected summarizer", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-image-vision-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    await writeFile(resolve(store.paths.attachmentsDir, "direct-image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const teammate = store.createAiTeammate({
      roleKey: "engineer",
      displayName: "Engineer",
      description: "Helps with private chat.",
      avatarTone: "blue",
      approvalProfile: { mode: "none" },
      status: "active",
    }, "2026-06-11T01:00:00.000Z");
    const thread = store.getOrCreateTeammateDirectThread(teammate.id, "2026-06-11T01:01:00.000Z");
    const message = store.createTeammateDirectMessage({
      threadId: thread.id,
      teammateId: teammate.id,
      authorType: "local-user",
      authorId: "local-user",
      body: "Look at this screenshot.",
      status: "ready",
    }, "2026-06-11T01:02:00.000Z");
    const attachment = store.createTeammatePrivateAttachment({
      teammateId: teammate.id,
      threadId: thread.id,
      messageId: message.id,
      scope: "teammate_direct_thread",
      kind: "image",
      fileName: "direct-image.png",
      contentType: "image/png",
      sizeBytes: 8,
      path: "direct-image.png",
      createdAt: "2026-06-11T01:03:00.000Z",
    });
    const messageWithAttachment = store.createTeammateDirectMessage({
      threadId: thread.id,
      teammateId: teammate.id,
      authorType: "local-user",
      authorId: "local-user",
      body: "Please read this image.",
      attachmentIds: [attachment.id],
      status: "ready",
    }, "2026-06-11T01:04:00.000Z");

    let summarizerCalls = 0;
    const materialized = await materializeInlineTeammateDirectInputs({
      store,
      teammateId: teammate.id,
      threadId: thread.id,
      sourceMessage: messageWithAttachment,
      now: "2026-06-11T01:05:00.000Z",
      imageVisionSummarizer: async (input) => {
        summarizerCalls += 1;
        assert.equal(input.attachment.id, attachment.id);
        assert.equal(input.maxBytes, 5 * 1024 * 1024);
        assert.equal(input.maxChars, 4_000);
        assert.match(input.absolutePath, /direct-image\.png$/);
        return {
          contentText: "The image shows an error toast above a disabled send button.",
          structuredSummary: { source: "direct_test_summarizer" },
        };
      },
    });

    assert.equal(summarizerCalls, 1);
    const result = materialized.get(attachment.id);
    assert.equal(result?.status, "available");
    assert.equal(result?.kind, "image");
    assert.match(result?.contentText ?? "", /disabled send button/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("public link body extractor strips HTML and blocks unsafe redirects", async () => {
  const linkPreview = {
    id: "link_preview_public_docs",
    workspaceId: "workspace_default",
    channelId: "channel_docs",
    url: "https://example.com/docs",
    normalizedUrl: "https://example.com/docs",
    title: "Docs",
    status: "ready",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
  const success = await linkBodyExtractorV1.materialize({
    workspaceId: "workspace_default",
    channelId: "channel_docs",
    sourceKind: "link_preview",
    sourceId: linkPreview.id,
    sourceFingerprint: "fingerprint",
    requestedBy: "turn_envelope",
    maxBytes: 4096,
    maxChars: 1000,
    now: "2026-06-11T00:00:00.000Z",
    linkPreview,
    resolveHostAddresses: async () => ["93.184.216.34"],
    fetch: async () => new Response(`
      <html>
        <head><title>Docs</title><script>window.secret = true;</script></head>
        <body>
          <nav>Navigation noise</nav>
          <main><h1>Public guide</h1><p>Use this body for the summary.</p></main>
        </body>
      </html>
    `, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  });

  assert.equal(success.status, "available");
  assert.equal(success.contentKind, "html_text");
  assert.match(success.contentText, /Public guide/);
  assert.match(success.contentText, /Use this body for the summary/);
  assert.doesNotMatch(success.contentText, /window\.secret|Navigation noise/);

  let calls = 0;
  const redirected = await linkBodyExtractorV1.materialize({
    workspaceId: "workspace_default",
    channelId: "channel_docs",
    sourceKind: "link_preview",
    sourceId: linkPreview.id,
    sourceFingerprint: "fingerprint",
    requestedBy: "turn_envelope",
    maxBytes: 4096,
    maxChars: 1000,
    now: "2026-06-11T00:00:00.000Z",
    linkPreview,
    resolveHostAddresses: async () => ["93.184.216.34"],
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(redirected.status, "blocked");
  assert.equal(redirected.errorCode, "local_or_private_host");

  let privateFetchCalled = false;
  const privateBlocked = await linkBodyExtractorV1.materialize({
    workspaceId: "workspace_default",
    channelId: "channel_docs",
    sourceKind: "link_preview",
    sourceId: "link_preview_private",
    sourceFingerprint: "fingerprint",
    requestedBy: "turn_envelope",
    maxBytes: 4096,
    maxChars: 1000,
    now: "2026-06-11T00:00:00.000Z",
    linkPreview: {
      ...linkPreview,
      id: "link_preview_private",
      url: "http://127.0.0.1/private",
      normalizedUrl: "http://127.0.0.1/private",
    },
    fetch: async () => {
      privateFetchCalled = true;
      return new Response("should not fetch", { status: 200 });
    },
  });

  assert.equal(privateBlocked.status, "blocked");
  assert.equal(privateBlocked.errorCode, "local_or_private_host");
  assert.equal(privateFetchCalled, false);
});

test("inline materialization writes public link body cache for explicit link request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-link-body-inline-cache-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({
      name: "Link body materialization",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const linkPreview = store.createChannelLinkPreview({
      channelId: channel.id,
      url: "https://example.com/docs",
      normalizedUrl: "https://example.com/docs",
      title: "Example Docs",
      description: "Metadata only before body extraction.",
      siteName: "Example",
      status: "ready",
    }, "2026-06-11T00:01:00.000Z");
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Please summarize this link",
      linkPreviewIds: [linkPreview.id],
    }, "2026-06-11T00:02:00.000Z");

    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: message,
      now: "2026-06-11T00:03:00.000Z",
      resolveHostAddresses: async () => ["93.184.216.34"],
      fetch: async () => new Response("<main><p>Inline public body cache.</p></main>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });

    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "link_preview",
      sourceId: linkPreview.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].extractorId, "link_body_v1");
    assert.equal(rows[0].status, "available");
    assert.match(rows[0].contentText, /Inline public body cache/);

    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });
    assert.equal(envelope.linkPreviews[0].materializationStatus, "available");
    assert.equal(envelope.linkPreviews[0].materializationId, rows[0].id);
    assert.match(envelope.linkPreviews[0].previewText, /Inline public body cache/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cached public link body lets Ling answer without materialization clarify", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-link-body-cached-reply-"));
  const runner = new ScriptedRunner(["这个页面讲的是 cached public link body。"]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Cached link body reply",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const linkPreview = store.createChannelLinkPreview({
      channelId: channel.id,
      url: "https://example.com/guide",
      normalizedUrl: "https://example.com/guide",
      title: "Guide",
      description: "Metadata before cached body.",
      siteName: "Example",
      status: "ready",
    }, "2026-06-11T00:01:00.000Z");
    store.createChannelInputMaterialization({
      channelId: channel.id,
      sourceKind: "link_preview",
      sourceId: linkPreview.id,
      sourceFingerprint: linkPreviewMaterializationFingerprint(linkPreview),
      extractorId: "link_body_v1",
      extractorVersion: "1",
      contentKind: "html_text",
      status: "available",
      contentText: "Cached public link body for Ling to summarize.",
      byteCount: 48,
      tokenEstimate: 12,
    }, "2026-06-11T00:02:00.000Z");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this link",
      linkPreviewIds: [linkPreview.id],
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "这个页面讲的是 cached public link body。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Cached public link body for Ling to summarize/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(intentDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pdf and docx extractors materialize bounded attachment text", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-document-extractors-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    const channel = store.createChannel({
      name: "Document extractors",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");

    const pdfBytes = await readPdfFixtureBytes();
    await writeFile(resolve(store.paths.attachmentsDir, "fixture.pdf"), pdfBytes);
    const pdfAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "pdf",
      fileName: "fixture.pdf",
      contentType: "application/pdf",
      sizeBytes: pdfBytes.byteLength,
      path: "fixture.pdf",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const pdfResult = await pdfExtractorV1.materialize({
      workspaceId: pdfAttachment.workspaceId,
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: pdfAttachment.id,
      sourceFingerprint: "pdf-fingerprint",
      requestedBy: "turn_envelope",
      maxBytes: 128 * 1024,
      maxChars: 100,
      now: "2026-06-11T00:02:00.000Z",
      attachment: pdfAttachment,
      attachmentsDir: store.paths.attachmentsDir,
    });
    assert.equal(pdfResult.status, "available", JSON.stringify(pdfResult));
    assert.equal(pdfResult.contentKind, "pdf_text");
    assert.match(pdfResult.contentText, /Turk J Med Sci/);
    assert.equal(pdfResult.structuredSummary.pageCount, 5);

    const docxBytes = await readDocxFixtureBytes();
    await writeFile(resolve(store.paths.attachmentsDir, "fixture.docx"), docxBytes);
    const docxAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "office",
      fileName: "fixture.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: docxBytes.byteLength,
      path: "fixture.docx",
      createdAt: "2026-06-11T00:03:00.000Z",
    });
    const docxResult = await officeExtractorV1.materialize({
      workspaceId: docxAttachment.workspaceId,
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: docxAttachment.id,
      sourceFingerprint: "docx-fingerprint",
      requestedBy: "turn_envelope",
      maxBytes: 128 * 1024,
      maxChars: 100,
      now: "2026-06-11T00:04:00.000Z",
      attachment: docxAttachment,
      attachmentsDir: store.paths.attachmentsDir,
    });
    assert.equal(docxResult.status, "available", JSON.stringify(docxResult));
    assert.equal(docxResult.contentKind, "office_text");
    assert.match(docxResult.contentText, /Walking on imported air/);
    assert.deepEqual(docxResult.structuredSummary, { format: "docx", warnings: [] });

    const pptxAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "office",
      fileName: "slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 128,
      path: "slides.pptx",
      createdAt: "2026-06-11T00:05:00.000Z",
    });
    const pptxResult = await officeExtractorV1.materialize({
      workspaceId: pptxAttachment.workspaceId,
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: pptxAttachment.id,
      sourceFingerprint: "pptx-fingerprint",
      requestedBy: "turn_envelope",
      maxBytes: 4096,
      maxChars: 100,
      now: "2026-06-11T00:06:00.000Z",
      attachment: pptxAttachment,
      attachmentsDir: store.paths.attachmentsDir,
    });
    assert.equal(pptxResult.status, "unsupported");
    assert.equal(pptxResult.errorCode, "unsupported_office_format");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inline materialization writes pdf and docx cache for current-turn attachments", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-document-inline-cache-"));
  const store = createSqliteRunStore(cwd);
  try {
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    const channel = store.createChannel({
      name: "Document inline cache",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const pdfBytes = await readPdfFixtureBytes();
    await writeFile(resolve(store.paths.attachmentsDir, "inline.pdf"), pdfBytes);
    const pdfAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "pdf",
      fileName: "inline.pdf",
      contentType: "application/pdf",
      sizeBytes: pdfBytes.byteLength,
      path: "inline.pdf",
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    const docxBytes = await readDocxFixtureBytes();
    await writeFile(resolve(store.paths.attachmentsDir, "inline.docx"), docxBytes);
    const docxAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "office",
      fileName: "inline.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: docxBytes.byteLength,
      path: "inline.docx",
      createdAt: "2026-06-11T00:02:00.000Z",
    });
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Context attached.",
      attachmentIds: [pdfAttachment.id, docxAttachment.id],
    }, "2026-06-11T00:03:00.000Z");

    await materializeInlineChannelInputs({
      store,
      channel,
      sourceMessage: message,
      now: "2026-06-11T00:04:00.000Z",
    });

    const pdfRows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: pdfAttachment.id,
    });
    assert.equal(pdfRows.length, 1);
    assert.equal(pdfRows[0].extractorId, "pdf_text_v1");
    assert.equal(pdfRows[0].status, "available", JSON.stringify(pdfRows[0]));
    assert.match(pdfRows[0].contentText, /Turk J Med Sci/);

    const docxRows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: docxAttachment.id,
    });
    assert.equal(docxRows.length, 1);
    assert.equal(docxRows[0].extractorId, "office_text_v1");
    assert.equal(docxRows[0].status, "available", JSON.stringify(docxRows[0]));
    assert.match(docxRows[0].contentText, /Walking on imported air/);

    const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });
    assert.deepEqual(envelope.attachments.map((attachment) => attachment.materializationStatus), ["available", "available"]);
    assert.match(envelope.attachments[0].previewText, /Turk J Med Sci/);
    assert.match(envelope.attachments[1].previewText, /Walking on imported air/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("materialized pdf and docx attachments let Ling answer without materialization clarify", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-document-materialized-reply-"));
  const runner = new ScriptedRunner(["我读到了 PDF 和 DOCX 的正文。"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Materialized document reply",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const pdfAttachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "guide.pdf",
      contentType: "application/pdf",
      contentBase64: (await readPdfFixtureBytes()).toString("base64"),
    })).attachment;
    const docxAttachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBase64: (await readDocxFixtureBytes()).toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this PDF and this document",
      attachmentIds: [pdfAttachment.id, docxAttachment.id],
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "我读到了 PDF 和 DOCX 的正文。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Turk J Med Sci/);
    assert.match(runner.runs[0].task.prompt, /Walking on imported air/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(intentDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("materialized image attachment lets Ling answer without materialization clarify", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-image-materialized-reply-"));
  const runner = new ScriptedRunner(["我读到了截图摘要。"]);
  const daemon = await startDaemonForTest(runner, {
    imageVisionSummarizer: async () => ({
      contentText: "The screenshot shows the branch button hidden next to the channel title.",
      structuredSummary: { source: "test_summarizer" },
    }),
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Materialized image reply",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "screenshot.png",
      contentType: "image/png",
      contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please fix the UI from this screenshot",
      attachmentIds: [attachment.id],
      requestAiReply: true,
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "我读到了截图摘要。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /branch button hidden/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Image vision summarizer is not configured/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(intentDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider-backed image materialization works without injected summarizer", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-backed-image-materialization-"));
  const relay = await startMockOpenAICompatibleServer({
    responseContent: ({ body }) => {
      const content = body?.messages?.[0]?.content;
      if (Array.isArray(content) && content.some((part) => part?.type === "image_url")) {
        return "The screenshot shows a settings dialog with the permission section highlighted.";
      }
      return "OK";
    },
  });
  const runner = new ScriptedRunner(["我读到了 provider 视觉摘要。"]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Vision Relay",
      providerId: "relay",
      model: "vision-chat",
      api: "openai-completions",
      baseUrl: `${relay.url}/v1`,
      capabilities: ["chat"],
      input: ["text"],
      authHeader: false,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Provider backed image reply",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "settings.png",
      contentType: "image/png",
      contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "为什么还是这样？",
      attachmentIds: [attachment.id],
      requestAiReply: true,
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "我读到了 provider 视觉摘要。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /permission section highlighted/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /contents aren't available|Image vision summarizer is not configured/i);

    const store = stores.get(cwd);
    assert.ok(store);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].extractorId, "image_vision_summary_v1");
    assert.equal(rows[0].status, "available", JSON.stringify(rows[0]));
    assert.match(rows[0].contentText, /settings dialog/);

    const visionRequest = relay.requests.find((request) => Array.isArray(request.body?.messages?.[0]?.content));
    assert.ok(visionRequest);
    const imagePart = visionRequest.body.messages[0].content.find((part) => part.type === "image_url");
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
  } finally {
    await daemon.close();
    await relay.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator preserves materialized guidance metadata for active run continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-materialized-guidance-"));
  await writeFile(resolve(cwd, "README.md"), "# Current README\n", "utf8");
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent Materialized Guidance",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_ling_agent_materialized_guidance",
      cwd,
      taskId: "task_ling_agent_materialized_guidance",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_materialized_guidance", title: "Active work" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "followup.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("active run follow-up context", "utf8").toString("base64"),
    })).attachment;
    const linkPreview = store.createChannelLinkPreview({
      channelId: channel.id,
      url: "https://example.com/docs",
      normalizedUrl: "https://example.com/docs",
      title: "Example Docs",
      description: "Cached link-preview metadata only.",
      siteName: "Example",
      status: "ready",
    }, "2026-06-11T00:02:30.000Z");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "另外也更新 file:README.md",
      attachmentIds: [attachment.id],
      linkPreviewIds: [linkPreview.id],
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.activeSessionAction.mode, "queue_followup");
    assert.equal(created.intervention.sourceRunId, run.id);
    assert.deepEqual(created.intervention.messagePayload.attachmentIds, [attachment.id]);
    assert.deepEqual(created.intervention.messagePayload.linkPreviewIds, [linkPreview.id]);
    assert.equal(created.intervention.messagePayload.attachments[0].fileName, "followup.txt");
    assert.equal(created.intervention.messagePayload.attachments[0].materializationStatus, "available");
    assert.match(created.intervention.messagePayload.attachments[0].previewText, /active run follow-up context/);
    assert.equal(created.intervention.messagePayload.linkPreviews[0].title, "Example Docs");
    assert.equal(created.intervention.messagePayload.linkPreviews[0].materializationStatus, "metadata_only");
    assert.match(created.intervention.messagePayload.linkPreviews[0].previewText, /Cached link-preview metadata only/);
    assert.equal(created.intervention.messagePayload.fileRefs[0].path, "README.md");
    assert.equal(created.intervention.messagePayload.fileRefs[0].rootRelation, "inside_workspace");
    assert.equal(created.intervention.messagePayload.fileRefs[0].kind, "file");
    assert.equal(created.intervention.messagePayload.fileRefs[0].materializationStatus, "metadata_only");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator requires confirmation for active run redirect", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-redirect-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent Coordinator Redirect",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_ling_agent_coordinator_redirect",
      cwd,
      taskId: "task_ling_agent_coordinator_redirect",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_ling_agent_coordinator_redirect", title: "Active work" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "停，改用 daemon API",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.intervention, undefined);
    assert.equal(created.activeSessionAction.mode, "interrupt_redirect");
    assert.equal(created.activeSessionAction.status, "requires_confirmation");
    assert.equal(created.activeSessionAction.sourceRunId, run.id);
    assert.equal(store.getRun(run.id).status, "running");
    assert.deepEqual(store.listRunInterventions({ sourceRunId: run.id }), []);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel messages persist and AI blocker replies do not drop the user message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-messages-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "请 @Engineer 完善频道需求",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.message.body, "请 @Engineer 完善频道需求");
    assert.equal(created.aiReply.status, "pending");

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    assert.deepEqual(listed.messages.map((message) => message.id), [created.message.id, created.aiReply.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion uses the mentioned teammate provider preset", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-mentioned-teammate-provider-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(check.ok, true);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 你好",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, teammateId);
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Designer reply");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Channel collaboration protocol:/);
    assert.match(runner.runs[0].task.prompt, /Response language: follow_user \(source=default\)/);
    assert.match(runner.runs[0].task.prompt, /Current teammate: Designer \(id: teammate_builtin_designer, role: designer\)/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Channel teammates \(configured roster/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion records provider runtime failures as availability incidents only", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-provider-runtime-incident-"));
  const rateLimitError = Object.assign(new Error("Too many requests"), { code: "rate_limited" });
  const runner = new ScriptedRunner([rateLimitError]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const store = stores.get(cwd);
    assert.ok(store);
    const availability = store.listAvailabilityIncidents({
      providerPresetId: provider.id,
      now: new Date().toISOString(),
      limit: 10,
    });
    assert.equal(availability.length, 1);
    assert.equal(availability[0].kind, "quota");
    assert.equal(availability[0].state, "rate_limited");
    assert.equal(availability[0].agentId, undefined);
    assert.deepEqual(store.listReliabilityIncidents({ agentId: teammateId, capabilityScope: "code", limit: 10 }), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus stays inert when the feature flag is disabled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-observer-bus-off-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { teamObserverBus: false } });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const store = stores.get(cwd);
    assert.ok(store);
    assert.deepEqual(store.listChannelTeamEvidenceItems({ channelId: channel.id, limit: 10 }), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus writes bounded relevance evidence without visible observer messages", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-observer-bus-on-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { teamObserverBus: true } });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.deepEqual(listed.messages.map((message) => message.id), [created.message.id, created.aiReply.id]);
    const store = stores.get(cwd);
    assert.ok(store);
    const evidence = store.listChannelTeamEvidenceItems({
      channelId: channel.id,
      turnId: created.message.id,
      kind: "agent_relevance_card",
      limit: 10,
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].agentId, teammateId);
    assert.equal(evidence[0].visibility, "internal");
    assert.equal(evidence[0].status, "completed");
    assert.equal(evidence[0].sourceRefs.some((sourceRef) => sourceRef.type === "message" && sourceRef.id === created.message.id), true);
    assert.match(evidence[0].summary, /Engineer/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus skips unavailable observers without blocking the main reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-observer-bus-unavailable-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { teamObserverBus: true } });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    store.createAvailabilityIncident(
      {
        id: "incident_observer_engineer_overloaded",
        agentId: teammateId,
        providerPresetId: provider.id,
        state: "overloaded",
        kind: "overload",
        severity: "medium",
        summary: "Observer provider is temporarily overloaded.",
        observedAt: "2099-06-27T00:00:00.000Z",
        expiresAt: "2099-06-28T00:10:00.000Z",
      },
      "2099-06-27T00:00:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.deepEqual(listed.messages.map((message) => message.id), [created.message.id, created.aiReply.id]);
    assert.deepEqual(
      store.listChannelTeamEvidenceItems({
        channelId: channel.id,
        turnId: created.message.id,
        kind: "agent_relevance_card",
        limit: 10,
      }),
      [],
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus applies provider-level availability incidents to matching observers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-observer-bus-provider-unavailable-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { teamObserverBus: true } });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    store.createAvailabilityIncident(
      {
        id: "incident_provider_rate_limited",
        providerPresetId: provider.id,
        state: "rate_limited",
        kind: "quota",
        severity: "medium",
        summary: "Provider quota is temporarily exhausted.",
        observedAt: "2099-06-27T00:00:00.000Z",
        expiresAt: "2099-06-28T00:10:00.000Z",
      },
      "2099-06-27T00:00:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.deepEqual(
      store.listChannelTeamEvidenceItems({
        channelId: channel.id,
        turnId: created.message.id,
        kind: "agent_relevance_card",
        limit: 10,
      }),
      [],
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus ignores expired provider-level availability incidents", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-observer-bus-provider-expired-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { teamObserverBus: true } });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    store.createAvailabilityIncident(
      {
        id: "incident_provider_expired_outage",
        providerPresetId: provider.id,
        state: "offline",
        kind: "network",
        severity: "medium",
        summary: "Provider network outage already expired.",
        observedAt: "2026-06-26T00:00:00.000Z",
        expiresAt: "2026-06-26T00:10:00.000Z",
      },
      "2026-06-26T00:00:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const evidence = store.listChannelTeamEvidenceItems({
      channelId: channel.id,
      turnId: created.message.id,
      kind: "agent_relevance_card",
      limit: 10,
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].agentId, teammateId);
    assert.equal(evidence[0].status, "completed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion injects web search context before runner reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-web-search-context-"));
  const runner = new RecordingRunner();
  const webSearchCalls = [];
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    channelWebFetch: async (url, init) => {
      webSearchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Fresh web evidence summary.",
        output: [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [
                { type: "url", url: "https://example.com/fresh", title: "Fresh source" },
              ],
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai",
      displayName: "OpenAI Responses + Web Search",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      authHeader: true,
      capabilities: ["chat", "tool_call", "reasoning", "web_search"],
    })).provider;
    const store = stores.get(cwd);
    assert.ok(store);
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider ready for web search context test.",
      checkedAt: new Date().toISOString(),
    });
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 查一下 Ling Stack 最新消息",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Designer reply");
    assert.equal(finalReply.webEvidence.status, "available");
    assert.equal(finalReply.webEvidence.query, "查一下 Ling Stack 最新消息");
    assert.equal(finalReply.webEvidence.provider.adapterId, "openai-responses-web-search");
    assert.deepEqual(finalReply.webEvidence.sources.map((source) => source.url), ["https://example.com/fresh"]);
    assert.doesNotMatch(JSON.stringify(finalReply.webEvidence), /sk-test-secret-value/);
    const workUnit = store.listWorkUnits({ kind: "channel_ai_reply", linkedMessageId: finalReply.id, limit: 1 })[0];
    assert.ok(workUnit);
    const webEvidenceEvents = store.listRuntimeEvents(workUnit.id).filter((event) => event.type === "web_evidence_recorded");
    assert.equal(webEvidenceEvents.length, 1);
    assert.equal(webEvidenceEvents[0].data.toolSurface, "web");
    assert.equal(webEvidenceEvents[0].data.sourceCount, 1);
    assert.deepEqual(webEvidenceEvents[0].data.sources.map((source) => source.url), ["https://example.com/fresh"]);
    const webProgressEvents = store.listRuntimeEvents(workUnit.id).filter((event) => event.type === "work_unit_progress" && event.data.toolSurface === "web");
    assert.deepEqual(webProgressEvents.map((event) => event.data.type), [
      "web_search_planned",
      "web_search_started",
      "web_search_completed",
    ]);
    assert.equal(webProgressEvents[2].data.status, "available");
    assert.equal(webProgressEvents[2].data.sourceCount, 1);
    assert.equal(webSearchCalls.length, 1);
    assert.equal(webSearchCalls[0].url, "https://api.openai.com/v1/responses");
    const requestBody = JSON.parse(webSearchCalls[0].init.body);
    assert.deepEqual(requestBody.tools, [{ type: "web_search", search_context_size: "low" }]);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Ling web context:/);
    assert.match(runner.runs[0].task.prompt, /Fresh web evidence summary/);
    assert.match(runner.runs[0].task.prompt, /https:\/\/example\.com\/fresh/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion blocks runner prompt envelope echoes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-prompt-echo-"));
  const runner = new PromptEchoRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 给我一片关于AI发展的分析报告",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.match(finalReply.body, /Runner echoed internal channel context/);
    assert.doesNotMatch(finalReply.body, /Channel collaboration protocol:/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Channel collaboration protocol:/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel message stream emits visible deltas into a durable AI reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-stream-"));
  const runner = new ScriptedRunner(["Streamed channel reply"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "@Engineer 请流式回复",
        mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
        requestAiReply: true,
      }),
    });

    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "ready", "delta", "done"]);
    assert.equal(events[0].data.message.body, "@Engineer 请流式回复");
    assert.equal(events[1].data.aiReply.status, "pending");
    assert.equal(events[2].data.delta, "Streamed channel reply");
    assert.equal(events[2].data.body, "Streamed channel reply");
    assert.equal(events[3].data.aiReply.body, "Streamed channel reply");

    const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
    const finalReply = listed.messages.find((message) => message.id === events[1].data.aiReply.id);
    assert.equal(finalReply.body, "Streamed channel reply");
    assert.equal(finalReply.status, "ready");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation stream materializes uploaded attachments into the run prompt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-attachment-"));
  const runner = new ScriptedRunner(["Attachment received"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      lingConversationTone: "friendly",
    });
    const attachment = (await postJson(`${daemon.url}/conversations/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "notes.txt",
      contentBase64: Buffer.from("Alpha decision: keep the shared composer contract.").toString("base64"),
    })).attachment;

    const response = await fetch(`${daemon.url}/conversations/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Summarize the attached note.",
        attachmentIds: [attachment.id],
        providerPresetId: provider.id,
      }),
    });

    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const initialReady = events.find((event) => event.event === "ready" && event.data.userMessage);
    assert.ok(initialReady);
    assert.equal(initialReady.data.userMessage.attachments[0].id, attachment.id);
    assert.equal(initialReady.data.userMessage.attachments[0].fileName, "notes.txt");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Attached files:/);
    assert.match(runner.runs[0].task.prompt, /Alpha decision: keep the shared composer contract\./);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Use English for user-visible output/);
    assert.ok(runner.runs[0].appendSystemPrompt.some((instruction) => /Default conversation tone: friendly\./.test(instruction)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((instruction) => /Use English for user-visible output/.test(instruction)));

    const done = events.find((event) => event.event === "done");
    assert.ok(done);
    assert.equal(done.data.run.requestSnapshot.lingConversationTone, "friendly");
    assert.ok(done.data.run.requestSnapshot.appendSystemPrompt.some((instruction) => /Default conversation tone: friendly\./.test(instruction)));

    const detail = await getJson(`${daemon.url}/conversations/${encodeURIComponent(initialReady.data.thread.id)}?cwd=${encodeURIComponent(cwd)}`);
    const userMessage = detail.messages.find((message) => message.id === initialReady.data.userMessage.id);
    assert.equal(userMessage.attachments[0].id, attachment.id);

    const preview = await getJson(`${daemon.url}/attachments/${encodeURIComponent(attachment.id)}/preview?cwd=${encodeURIComponent(cwd)}&scope=conversation&threadId=${encodeURIComponent(initialReady.data.thread.id)}`);
    assert.equal(preview.kind, "plain_text");
    assert.match(preview.text, /Alpha decision/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel message stream does not expose hidden task proposal blocks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-stream-proposal-"));
  const runner = new ScriptedRunner([
    `可以开始。\n<ling_task_proposal>{"title":"Stream proposal","prompt":"Implement streaming","assigneeTeammateId":"teammate_builtin_engineer","acceptanceCriteria":["reply streams"],"collaborationSteps":[{"teammateId":"teammate_builtin_engineer","action":"coordinated","summary":"Implement"}],"requiredTools":["read"],"riskSummary":"low"}</ling_task_proposal>`,
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "@Engineer 可以开始实现吗",
        mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
        requestAiReply: true,
      }),
    });

    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "ready", "delta", "done"]);
    assert.doesNotMatch(JSON.stringify(events.map((event) => event.data)), /ling_task_proposal/);
    assert.equal(events[2].data.body, "可以开始。\n");
    assert.equal(events[3].data.aiReply.body, "可以开始。");

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].title, "Stream proposal");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI reply prompt carries recent context for short follow-ups", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-reply-followup-context-"));
  const runner = new ScriptedRunner([
    "雨下到第三天，城里的钟停了。修表匠阿岚把怀表放进钟芯，世界重新开始走动。",
    "四百字版本",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const first = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "300字的小说",
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, first.aiReply.id, "ready");

    const second = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "400字",
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, second.aiReply.id, "ready");

    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Recent channel context before the latest turn/);
    assert.match(runner.runs[1].task.prompt, /300字的小说/);
    assert.match(runner.runs[1].task.prompt, /雨下到第三天，城里的钟停了/);
    assert.match(runner.runs[1].task.prompt, /User message:[\s\S]*400字/);
    assert.doesNotMatch(runner.runs[1].task.prompt, /AI teammate is preparing a reply/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI reply injects Plan Mode instructions for plan threads", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-plan-mode-prompt-"));
  const runner = new ScriptedRunner(["<proposed_plan title=\"Plan slice\">1. Inspect first.</proposed_plan>"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const thread = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.id,
    });
    await patchJson(`${daemon.url}/threads/${encodeURIComponent(thread.thread.id)}/mode?cwd=${encodeURIComponent(cwd)}`, {
      mode: "plan",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Plan the next implementation slice.",
      threadId: thread.thread.id,
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");

    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Plan Mode is active/);
    assert.match(runner.runs[0].systemPrompt, /<proposed_plan title=/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /<ling_task_proposal>/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel no-tools AI reply retries once with compacted channel summary after context-length error", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-reply-context-retry-"));
  const runner = new ScriptedRunner([
    new Error("context_length exceeded by test provider"),
    "Retry reply",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 请根据频道上下文回复",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const reply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(reply.body, "Retry reply");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Compacted channel discussion summary for a no-tools retry/);
    assert.match(runner.runs[1].task.prompt, /channel_discussion_summary|Compacted visible message count/i);
    const downgradedBudget = resolveProviderContextBudget(provider, "channel_reply");
    assert.equal(downgradedBudget.mode, "model_estimated");
    assert.equal(downgradedBudget.capabilitySource, "runtime_observed");
    assert.equal(downgradedBudget.capabilityConfidence, "estimated");
    assert.ok(downgradedBudget.contextWindowTokens < 32768);
    const providerList = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    const persistedProvider = providerList.providers.find((item) => item.id === provider.id);
    assert.ok(persistedProvider);
    assert.equal(persistedProvider.contextWindow, undefined);
    assert.equal(persistedProvider.maxTokens, undefined);

    const summaries = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(summaries.contextSummaries.length, 1);
    assert.equal(summaries.contextSummaries[0].authorType, "system");
    assert.deepEqual(summaries.contextSummaries[0].sourceMessageIds, [created.message.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mentions_only creates a blocked Ling Agent reply when the channel has no runnable provider", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-mentions-only-route-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个频道自动回复怎么设计？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const blockedReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(blockedReply.body, "AI teammate is not configured for this channel.");
    assert.equal(blockedReply.errorMessage, "No provider preset is selected for this channel discussion.");
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "mentions_only");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate routes root messages through Ling Agent without proposals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-route-"));
  const runner = new ScriptedRunner([
    `<ling_task_proposal>{"title":"Should not persist","prompt":"Create a task","acceptanceCriteria":["never"],"requiredTools":["read"],"riskSummary":"blocked by proposalMode"}</ling_task_proposal>Visible default reply`,
    "这个频道当前有多个 AI 队友，具体数量以频道成员列表为准。",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个实现边界怎么处理？",
    });
    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.match(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Do not include hidden proposal blocks/);
    assert.match(runner.runs[0].task.prompt, /Current teammate: Ling Agent \(id: ling_agent, role: custom\)/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Channel teammates \(configured roster/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].selectedTeammateId, "ling_agent");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(proposals.proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    assert.deepEqual((await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`)).runs, []);

    const countQuestion = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "现在频道有多少个队友",
    });
    assert.equal(countQuestion.aiReply.status, "pending");
    const countReplyList = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, countQuestion.aiReply.id, "ready");
    const countReply = countReplyList.messages.find((message) => message.id === countQuestion.aiReply.id);
    assert.equal(countReply.body, "这个频道当前有多个 AI 队友，具体数量以频道成员列表为准。");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Channel teammates \(configured roster; not online\/presence\):/);
    assert.match(runner.runs[1].task.prompt, /Engineer \(id: teammate_builtin_engineer, role: engineer\).*default/);
    assert.match(runner.runs[1].task.prompt, /Do not claim online\/presence status/);

    const countDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(countQuestion.message.id)}`);
    assert.equal(countDecisions.decisions.length, 1);
    assert.equal(countDecisions.decisions[0].mode, "default_teammate");
    assert.equal(countDecisions.decisions[0].action, "reply");
    assert.equal(countDecisions.decisions[0].status, "accepted");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector creates visible multi-replies for discussion-only all-teammate requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-visible-multi-reply-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "所有队友都回复我一下",
    });

    assert.equal(created.message.body, "所有队友都回复我一下");
    assert.equal(created.aiReplies.length, 3);
    assert.equal(created.aiReply.id, created.aiReplies[0].id);
    assert.deepEqual(
      created.aiReplies.map((reply) => reply.authorId).sort(),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"].sort(),
    );
    assert.deepEqual(created.aiReplies.map((reply) => reply.status), ["pending", "pending", "pending"]);

    await Promise.all(created.aiReplies.map((reply) => waitForChannelMessageStatus(daemon.url, cwd, channel.id, reply.id, "ready")));
    assert.equal(runner.runs.length, 3);
    assert(runner.runs.every((run) => /Do not include hidden proposal blocks/.test(run.systemPrompt)));
    assert(runner.runs.every((run) => /Channel teammates \(configured roster; not online\/presence\):/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Visible multi-reply participants for this batch:/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Architect \(id: teammate_builtin_architect, role: architect\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Engineer \(id: teammate_builtin_engineer, role: engineer\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /QA \(id: teammate_builtin_qa, role: qa\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Do not claim online\/presence status/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /not-yet-generated peer replies/.test(run.task.prompt)));

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "visible_multi_reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.deepEqual(
      [...decisions.decisions[0].selectedTeammateIds].sort(),
      created.aiReplies.map((reply) => reply.authorId).sort(),
    );
    assert.deepEqual(
      [...decisions.decisions[0].replyMessageIds].sort(),
      created.aiReplies.map((reply) => reply.id).sort(),
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector creates workflow proposals for execution-shaped all-teammate requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-workflow-proposal-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "所有队友都回复我一下：Architect 先拆，Engineer 实现，QA 验证",
    });

    assert.equal(created.message.body, "所有队友都回复我一下：Architect 先拆，Engineer 实现，QA 验证");
    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].sourceMessageId, created.message.id);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_engineer");
    assert.deepEqual(
      proposals.proposals[0].collaborationSteps.map((step) => step.teammateId),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"],
    );
    assert.equal(proposals.proposals[0].responseLanguage, "zh-CN");
    assert.match(proposals.proposals[0].prompt, /建议协作步骤/);
    assert.match(proposals.proposals[0].acceptanceCriteria[0], /可审计 proposal evidence/);
    assert.match(proposals.proposals[0].collaborationSteps[0].summary, /拆解实现边界/);
    assert.match(proposals.proposals[0].riskSummary, /工作流 proposal/);

    const listedMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedMessages.messages.filter((message) => message.kind === "ai_reply").length, 0);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
    assert.match(decisions.decisions[0].reason, /Workflow proposal created from channel intent/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector does not assign specialists outside current channel", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-roster-boundary-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.equal(proposals.proposals[0].proposedByTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].collaborationSteps.map((step) => step.teammateId), ["ling_agent"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /Engineer:|QA:|Architect:/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector uses attached AI council specialists without copying memberships", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-council-specialists-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  const developmentCouncilId = "council_builtin_development";
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Council-backed Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_designer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
    }
    await putJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Designer 先 review 交互，QA 验证这个频道设置改动",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.deepEqual(
      [...proposals.proposals[0].collaborationSteps.map((step) => step.teammateId)].sort(),
      ["teammate_builtin_designer", "teammate_builtin_qa"].sort(),
    );
    assert.equal(proposals.proposals[0].collaborationSteps.some((step) => step.teammateId === "ling_agent"), false);
    const designerStep = proposals.proposals[0].collaborationSteps.find((step) => step.teammateId === "teammate_builtin_designer");
    assert.ok(designerStep);
    assert.ok(designerStep.sources?.some((source) => source.kind === "council" && source.councilDisplayName === "Development Council"));

    const effective = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/effective-council?cwd=${encodeURIComponent(cwd)}`);
    const designerSpecialist = effective.effectiveCouncil.specialists.find((specialist) => specialist.teammateId === "teammate_builtin_designer");
    assert.ok(designerSpecialist);
    assert.ok(designerSpecialist.sources.some((source) => source.kind === "council" && source.councilId === developmentCouncilId));

    const confirmed = await postJson(`${daemon.url}/channel-proposals/${encodeURIComponent(proposals.proposals[0].id)}/confirm-workflow?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(confirmed.proposal.status, "accepted");
    assert.deepEqual(
      [...confirmed.workflowSteps.map((step) => step.toParticipantId)].sort(),
      ["teammate_builtin_designer", "teammate_builtin_qa"].sort(),
    );
    const designerWorkflowStep = confirmed.workflowSteps.find((step) => step.toParticipantId === "teammate_builtin_designer");
    assert.ok(designerWorkflowStep);
    assert.ok(designerWorkflowStep.metadata?.proposalStepSources?.some((source) =>
      source.kind === "council" &&
      source.councilId === developmentCouncilId &&
      source.councilDisplayName === "Development Council"
    ));

    const designerChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/channels?cwd=${encodeURIComponent(cwd)}`);
    const qaChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_qa")}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(designerChannels.memberships.some((membership) => membership.channelId === channel.id), false);
    assert.equal(qaChannels.memberships.some((membership) => membership.channelId === channel.id), false);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector asks one clarify question for underspecified work requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep"],
    })).channel;
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "做一下吧",
    });

    assert.equal(created.message.body, "做一下吧");
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.threadId, created.message.id);
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /确认范围/);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].selectedTeammateId, "ling_agent");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
    assert.match(decisions.decisions[0].reason, /Clarify question created from channel intent/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector auto-starts explicit direct workflow proposals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-direct-workflow-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "开始跑 Architect -> Engineer -> QA",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 3);
    await waitForCondition(() => runner.runs.length === 3, "direct workflow proposal runner sequence");
    const listedMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
    const terminalReply = assertCoordinatorWorkflowTerminalReply(listedMessages.messages);
    assert.match(terminalReply.body, /结果：Designer reply/);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].responseLanguage, "zh-CN");
    assert.deepEqual(
      proposals.proposals[0].collaborationSteps.map((step) => step.teammateId),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"],
    );
    assert.match(proposals.proposals[0].riskSummary, /runtime approval policy/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 2);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "direct_workflow");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
    assert.equal(decisions.decisions.some((decision) => /auto-started proposal/.test(decision.reason)), true);

    assert.equal(created.autoStartedWorkflow.workflow.metadata.responseLanguage, "zh-CN");
    assert.match(created.autoStartedWorkflow.workflowSteps[0].prompt, /用户可读输出请使用中文/);
    assert.match(created.autoStartedWorkflow.workflowSteps[0].prompt, /API 字段和证据摘录保持原文/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit response language overrides workspace default for workflow proposals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-language-override-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "zh-CN",
    });
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证。Please respond in English.",
    });
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].responseLanguage, "en-US");
    assert.match(proposals.proposals[0].prompt, /Proposed collaboration/);
    assert.match(proposals.proposals[0].acceptanceCriteria[0], /Create auditable proposal evidence/);
    assert.match(proposals.proposals[0].riskSummary, /Multi-agent work starts after confirmation/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel response language overrides follow-user inference for workflow proposals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-language-channel-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      responseLanguage: "en-US",
      allowedTools: ["read", "grep"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].responseLanguage, "en-US");
    assert.match(proposals.proposals[0].prompt, /Proposed collaboration/);
    assert.match(proposals.proposals[0].riskSummary, /Multi-agent work starts after confirmation/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file creation becomes direct workflow with bounded write tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-file-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_docs");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].riskSummary, /write/);
    assert.match(proposals.proposals[0].prompt, /权限边界/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 2);
    assert.equal(decisions.decisions[0].action, "direct_workflow");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions.some((decision) => /auto-started proposal/.test(decision.reason)), true);

    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Confirmed task-scoped tools:\nwrite/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit Ling Agent file request becomes direct workflow instead of discussion reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-mentioned-ling-file-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Mentioned Ling Agent execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `@Ling Agent 在 ${cwd} 下创建 login.html`,
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /login\.html/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) => decision.action === "direct_workflow" && /Bounded executable request/.test(decision.reason)), true);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /login\.html/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace follow-up can create the single file named by the previous Ling Agent reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-followup-file-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我写一个登录页面",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "你可以先在工作区新建一个文件：`login.html`，然后把代码粘进去。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "可以直接在工作区帮我做好吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /Target: login\.html/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /login\.html/);
    assert.match(runner.runs[0].task.prompt, /Requested objective from recent same-thread\/channel objective/);
    assert.match(runner.runs[0].task.prompt, /帮我写一个登录页面/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up can create the single file named by the previous Ling Agent reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-followup-file-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: [
          "如果确认，可以在工作区创建 `index.html`。",
          "",
          "```html",
          "<!doctype html>",
          "<html><body><canvas id=\"game\"></canvas><script>const gameReady = true;</script></body></html>",
          "```",
        ].join("\n"),
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "你不可以直接帮我写到里面吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.message.threadId, previousUser.id);
    assert.equal(created.aiReply.threadId, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /Target: index\.html/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) => decision.action === "direct_workflow" && /Bounded executable request/.test(decision.reason)), true);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Target: index\.html/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up opens the recent HTML target with bounded bash tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-followup-browser-open-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Thread browser open execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "已创建文件：`index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "可以直接帮我浏览器打开吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);
    assert.match(proposals.proposals[0].prompt, /Open index\.html in the local browser/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /Create index\.html|declared file tool scope/);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["bash"]);
    assert.match(runner.runs[0].task.prompt, /Target: index\.html/);
    assert.match(runner.runs[0].task.prompt, /Do not recreate or edit the file/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up opens recent target from typed operation kind", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-open-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "direct_workflow", operationKind: "open_local_target", reason: "User wants to preview the recent local artifact." }),
    "Opened local target.",
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model typed local target open",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "已创建文件：`index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "可以直接帮我展示一下这个成果吗？",
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);
    assert.match(proposals.proposals[0].prompt, /Open index\.html in the local browser/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /Create index\.html|declared file tool scope/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) =>
      decision.action === "direct_workflow" &&
      decision.createdBy === "model" &&
      /direct_workflow\/open_local_target/.test(decision.reason)
    ), true);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel intent selector/i);
    assert.deepEqual(runner.runs[1].tools, ["bash"]);
    assert.match(runner.runs[1].task.prompt, /Target: index\.html/);
    assert.match(runner.runs[1].task.prompt, /Do not recreate or edit the file/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up writes the recent local target without phrase-rule matching", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-file-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "direct_workflow", operationKind: "file_create", reason: "User is asking Ling to write the previously discussed file locally." }),
    "Created local file.",
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "先记一下以后可能要落地文件",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: [
          "如果确认，可以在工作区创建 `index.html`：",
          "```html",
          "<!doctype html>",
          "<html><body><canvas id=\"game\"></canvas><script>const gameReady = true;</script></body></html>",
          "```",
        ].join("\n"),
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /Target: index\.html/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) =>
      decision.action === "direct_workflow" &&
      decision.createdBy === "model" &&
      /Model-assisted direct_workflow\/file_create validated/.test(decision.reason)
    ), true);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel intent selector/i);
    assert.deepEqual(runner.runs[1].tools, ["write"]);
    assert.match(runner.runs[1].task.prompt, /Target: index\.html/);
    assert.match(runner.runs[1].task.prompt, /Requested content from recent same-thread code block/);
    assert.match(runner.runs[1].task.prompt, /gameReady = true/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up clarifies instead of creating empty recent target", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-empty-file-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "direct_workflow", operationKind: "file_create", reason: "User is asking Ling to write the previously discussed file locally." }),
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model thread follow-up empty target",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "先记一下以后可能要落地文件",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "如果确认，可以在工作区创建 `index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /目标文件是 index\.html/);
    assert.match(created.aiReply.body, /没有明确要写入的内容/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted local write request clarifies when no target validates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-model-followup-missing-target-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "direct_workflow", operationKind: "file_create", reason: "User is asking Ling to write something locally." }),
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model local write clarify",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /确认目标|clarify the target/i);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    assert.equal(runner.runs.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.length, 1);
    assert.equal(intentDecisions.decisions[0].action, "clarify");
    assert.equal(intentDecisions.decisions[0].createdBy, "model");
    assert.match(intentDecisions.decisions[0].reason, /target validation failed/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace follow-up clarifies when the previous Ling Agent reply names multiple files", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-followup-file-ambiguous-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ambiguous follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个登录页并补 README",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "可以新建 `login.html`，也可以把说明补到 `README.md`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "可以直接在工作区帮我做好吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "ready");
    assert.match(created.aiReply.body, /多个可能的文件目标|多个可能目标/);
    assert.match(created.aiReply.body, /login\.html/);
    assert.match(created.aiReply.body, /README\.md/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /multiple file targets/i);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up clarifies when the previous Ling Agent reply names multiple files", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-followup-file-ambiguous-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ambiguous thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个登录页面和说明文档",
      },
      "2026-06-12T09:00:00.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: previousUser.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "可以新建 `login.html`，也可以把说明补到 `README.md`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "你直接帮我写到里面",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.threadId, previousUser.id);
    assert.match(created.aiReply.body, /多个可能的文件目标|多个可能目标/);
    assert.match(created.aiReply.body, /login\.html/);
    assert.match(created.aiReply.body, /README\.md/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /multiple file targets/i);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text attachment preview can feed a direct README write workflow", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachment-readme-preview-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment README execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "readme-copy.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("README body from attachment", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.match(proposals.proposals[0].prompt, /Attachment: readme-copy\.txt/);
    assert.match(proposals.proposals[0].prompt, /README body from attachment/);
    assert.match(runner.runs[0].task.prompt, /README body from attachment/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => /auto-started proposal/.test(decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text attachment materialization cache hit avoids rereading attachment file", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachment-cache-hit-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment materialization cache hit",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "readme-cache.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Cached attachment body", "utf8").toString("base64"),
    })).attachment;

    const first = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });
    assert.equal(first.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);

    const store = stores.get(cwd);
    assert.ok(store);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].extractorId, "text_attachment_v1");
    assert.equal(rows[0].status, "available");
    assert.equal(rows[0].contentText, "Cached attachment body");

    await rm(resolve(store.paths.attachmentsDir, attachment.path), { force: true });

    const second = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 SECOND.md",
      attachmentIds: [attachment.id],
    });
    assert.equal(second.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Cached attachment body/);
    const afterCacheHit = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(afterCacheHit.length, 1);
    assert.equal(afterCacheHit[0].status, "available");
    assert.equal(afterCacheHit[0].contentText, "Cached attachment body");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment-dependent README write blocks when attachment content is not materialized", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachment-readme-blocked-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment README blocked",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const oversized = "x".repeat(20 * 1024);
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "large-readme-source.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from(oversized, "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "blocked");
    assert.match(proposals.proposals[0].errorMessage, /可读的附件内容|readable attachment content/i);
    assert.doesNotMatch(proposals.proposals[0].errorMessage, /附件预览|attachment preview|too large|previewStatus/i);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "direct_workflow");
    assert.match(decisions.decisions[0].reason, /no available attachment preview\/extraction/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unreadable screenshot task creates Ling materialization clarify reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-screenshot-materialization-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Screenshot materialization clarify",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "screenshot.png",
      contentType: "image/png",
      contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "根据这个截图修 UI",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    assert.match(created.aiReply.body, /没能读取 screenshot\.png|could not read image content/i);
    assert.doesNotMatch(created.aiReply.body, /OCR|视觉提取|metadata_only|extractor|SSRF/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.match(decisions.decisions[0].reason, /Attachment content is not materialized/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("blocked link body request creates Ling materialization clarify reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-link-materialization-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Link materialization clarify",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls"],
    })).channel;
    const linkPreview = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://127.0.0.1/private",
    })).linkPreview;
    assert.equal(linkPreview.status, "blocked");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this link",
      linkPreviewIds: [linkPreview.id],
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    assert.match(created.aiReply.body, /local\/private links automatically|本机或私有地址/i);
    assert.doesNotMatch(created.aiReply.body, /body extraction is blocked|SSRF|metadata_only|extractor/i);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /Link body materialization is blocked/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent fallback creates file proposal when no Docs teammate can run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-ling-agent-fallback-docs-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent fallback docs",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.equal(proposals.proposals[0].proposedByTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].collaborationSteps.map((step) => step.teammateId), ["ling_agent"]);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理/);

    assert.equal(created.autoStartedWorkflow.proposal.status, "accepted");
    assert.equal(created.autoStartedWorkflow.workflow.createdBy, "ling_agent");
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantId, "ling_agent");
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantLabel, "Ling Agent");
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Assigned teammate: Ling Agent/);
    assert.match(runner.runs[0].task.prompt, /Confirmed task-scoped tools:\nwrite/);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].teammateId, "ling_agent");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent fallback edits code proposal when no Engineer teammate can run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-ling-agent-fallback-engineer-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent fallback engineer",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `修改 ${cwd}/src/app.ts，把标题改成 Ling`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["edit"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理/);
    assert.match(proposals.proposals[0].riskSummary, /Engineer/);

    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantId, "ling_agent");
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["edit"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["edit"]);
    assert.match(runner.runs[0].task.prompt, /Assigned teammate: Ling Agent/);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].teammateId, "ling_agent");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file creation starts with task-scoped write when channel lacks static write tool", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-file-channel-readonly-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Read only docs",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.orchestration.status, "started", created.autoStartedWorkflow.orchestration.blocker);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.equal(proposals.proposals[0].errorMessage, undefined);
    assert.match(proposals.proposals[0].riskSummary, /write/);
    assert.doesNotMatch(proposals.proposals[0].riskSummary, /频道缺少所需工具/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);

    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].metadata.sourceProposalId, proposals.proposals[0].id);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file edit inherits target path from recent workflow context", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-file-continuation-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs edit continuation",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write", "edit"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });
    const createProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(createProposals.proposals.length, 1);
    assert.equal(createProposals.proposals[0].status, "accepted");

    const edited = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "在 README.md 中添加一句测试语句",
    });

    assertCoordinatorWorkflowStartReply(edited);
    assert.equal(edited.autoStartedWorkflow.workflowSteps.length, 1);
    const editProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(editProposals.proposals.length, 1);
    assert.equal(editProposals.proposals[0].status, "accepted");
    assert.equal(editProposals.proposals[0].linkedWorkflowId, edited.autoStartedWorkflow.workflow.id);
    assert.deepEqual(editProposals.proposals[0].requiredTools, ["edit"]);
    assert.match(editProposals.proposals[0].title, /README\.md|\.\.\./);
    assert.match(editProposals.proposals[0].prompt, new RegExp(`Target: ${escapeRegExp(cwd)}/README\\.md`));
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(decisions.decisions[0].action, "direct_workflow");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file edit normalizes Users path without leading slash", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-file-users-path-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs users path edit",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;

    const edited = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Users/tianxiao/ling-stack-test 下面，在 README.md 中添加一句测试语句",
    });

    assertCoordinatorWorkflowStartReply(edited);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["edit"]);
    assert.match(proposals.proposals[0].title, /\/Users\/tianxiao\/ling-stack-test\/README\.md/);
    assert.match(proposals.proposals[0].prompt, /Target: \/Users\/tianxiao\/ling-stack-test\/README\.md/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file creation how-to question remains ordinary Ling chat intent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-howto-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "How-to docs",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "如何创建 README.md？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(decisions.decisions, []);

    const whyQuestion = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "为什么不能创建 README.md？",
    });
    assert.equal(whyQuestion.aiReply.status, "pending");
    assert.equal(whyQuestion.aiReply.authorId, "ling_agent");
    const whyProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(whyQuestion.message.id)}`);
    assert.deepEqual(whyProposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step test request becomes direct workflow with bounded bash tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-single-step-test-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "QA execution",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_qa",
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "开始执行测试",
    });

    assert.equal(created.aiReply, undefined);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_qa");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);
    assert.match(proposals.proposals[0].riskSummary, /bash/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].action, "direct_workflow");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk push merge request auto-starts when required tools are not denied", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-high-risk-push-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "帮我 push 合并代码",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.match(proposals.proposals[0].riskSummary, /runtime approval policy/);

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 1);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => /High-risk side effect is runtime-gated: git_push_or_merge/.test(decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk thread follow-up creates a proposal without auto-starting", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-thread-high-risk-push-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release thread",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = store.createChannelMessage(
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "这个分支后面要发版",
      },
      "2026-06-12T09:00:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      threadId: previousUser.id,
      body: "帮我 push 合并代码",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].linkedWorkflowId, undefined);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.action === "direct_workflow" && decision.status === "accepted"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk push merge request blocks before run when required tool is denied", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-high-risk-push-deny-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/approval-policy?cwd=${encodeURIComponent(cwd)}`, {
      toolDecisions: { bash: "deny" },
    });
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "帮我 push 合并代码",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].linkedWorkflowId, undefined);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.status === "failed" && /denies required tools: bash/.test(decision.errorMessage ?? decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted channel intent no_reply falls through to ordinary Ling replies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-model-no-reply-fallthrough-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "no_reply", reason: "Not an executable task." }),
    "这个问题应该由 Ling Agent 回复。",
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep"],
    })).channel;
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个实现边界怎么处理？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "这个问题应该由 Ling Agent 回复。");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel intent selector/i);
    assert.match(runner.runs[0].task.prompt, /Classify the latest user channel message into exactly one Ling intent/);
    assert.match(runner.runs[0].task.prompt, /Available teammate roles JSON/);
    assert.match(runner.runs[1].systemPrompt, /Do not include hidden proposal blocks/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 1);
    assert.equal(routeDecisions.decisions[0].mode, "default_teammate");
    assert.equal(routeDecisions.decisions[0].action, "reply");
    assert.equal(routeDecisions.decisions[0].status, "accepted");
    assert.equal(routeDecisions.decisions[0].replyMessageId, created.aiReply.id);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "no_reply");
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].createdBy, "model");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted channel intent selector does not fall back to phrase-rule workflow proposal", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-model-fallback-"));
  const runner = new ScriptedRunner(["not json", "普通频道回复。"]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    await waitForCondition(() => runner.runs.length === 2, "ordinary channel reply after selector parse failure");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate route suppresses duplicate Ling Agent replies for the same source message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-idempotent-"));
  const now = "2026-06-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const provider = store.createProviderPreset(
      {
        kind: "glm",
        displayName: "Static Chat",
        providerId: "static-chat",
        model: "static-model",
        api: "google-generative-ai",
        capabilities: ["chat"],
        input: ["text"],
        authHeader: false,
        enabled: true,
      },
      now,
    );
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider configuration is valid.",
      checkedAt: now,
    });
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultProviderPresetId: provider.id,
        defaultTeammateId: "engineer",
        autoReplyMode: "default_teammate",
      },
      now,
    );
    const sourceMessage = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "这个问题应该怎么回复？",
      },
      now,
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: sourceMessage.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "Existing reply.",
      },
      now,
    );

    const route = await routeChannelMessageReply({
      store,
      channel,
      sourceMessage,
      config: testDaemonConfig(cwd),
      secretResolver: createCompositeSecretResolver({ env: {} }),
      runnerRegistry: unusedRunnerRegistry(),
    });

    assert.equal(route.action, "no_reply");
    assert.equal(route.reason, "An AI reply already exists for this source message.");
    const decisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: sourceMessage.id });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].status, "suppressed");
    assert.equal(decisions[0].reason, "An AI reply already exists for this source message.");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate route treats channel branches and topic replies as separate surfaces", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-surface-route-"));
  const now = "2026-06-25T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const provider = store.createProviderPreset(
      {
        kind: "glm",
        displayName: "Static Chat",
        providerId: "static-chat",
        model: "static-model",
        api: "google-generative-ai",
        capabilities: ["chat"],
        input: ["text"],
        authHeader: false,
        enabled: true,
      },
      now,
    );
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider configuration is valid.",
      checkedAt: now,
    });
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultProviderPresetId: provider.id,
        defaultTeammateId: "engineer",
        autoReplyMode: "default_teammate",
      },
      now,
    );
    const branch = store.createChannelBranch(
      {
        channelId: channel.id,
        name: "test",
        rootThreadId: "thread_branch_root",
      },
      now,
    );
    const branchMessage = store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: branch.rootThreadId,
        authorType: "local-user",
        body: "分支里也需要继续回复。",
      },
      now,
    );
    const topicSource = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "主频道源消息。",
      },
      now,
    );
    const topicReply = store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: topicSource.id,
        authorType: "local-user",
        body: "这是 topic reply，不应该自动拉起 agent。",
      },
      now,
    );

    const sharedRouteInput = {
      store,
      channel,
      config: testDaemonConfig(cwd),
      secretResolver: createCompositeSecretResolver({ env: {} }),
      runnerRegistry: unusedRunnerRegistry(),
    };
    const branchRoute = await routeChannelMessageReply({
      ...sharedRouteInput,
      sourceMessage: branchMessage,
    });
    const topicRoute = await routeChannelMessageReply({
      ...sharedRouteInput,
      sourceMessage: topicReply,
    });

    assert.equal(branchRoute.action, "reply");
    assert.equal(branchRoute.teammateId, "ling_agent");
    assert.equal(branchRoute.reason, "Ling Agent answered a channel branch message.");
    assert.equal(topicRoute.action, "no_reply");
    assert.equal(topicRoute.reason, "Topic replies are outside the first auto-reply scope.");

    const branchDecisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: branchMessage.id });
    assert.equal(branchDecisions.length, 1);
    assert.equal(branchDecisions[0].action, "reply");
    assert.equal(branchDecisions[0].status, "accepted");
    const topicDecisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: topicReply.id });
    assert.equal(topicDecisions.length, 1);
    assert.equal(topicDecisions[0].action, "no_reply");
    assert.equal(topicDecisions[0].status, "suppressed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent replies to greetings, repeated greetings, punctuation, and acknowledgements", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-greeting-"));
  const runner = new ScriptedRunner([
    "你好，我在。可以继续说你的问题。",
    "我在，继续说。",
    "晚上好，我在。",
    "看到了，继续说。",
    "收到，继续。",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;

    const preConfigGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(preConfigGreeting.aiReply.status, "pending");
    const preConfigListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, preConfigGreeting.aiReply.id, "ready");
    const preConfigReply = preConfigListed.messages.find((message) => message.id === preConfigGreeting.aiReply.id);
    assert.equal(preConfigReply.body, "你好，我在。可以继续说你的问题。");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      autoReplyMode: "default_teammate",
    });

    const repeatedGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(repeatedGreeting.aiReply.status, "pending");
    const repeatedListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, repeatedGreeting.aiReply.id, "ready");
    const repeatedReply = repeatedListed.messages.find((message) => message.id === repeatedGreeting.aiReply.id);
    assert.equal(repeatedReply.body, "我在，继续说。");
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(repeatedGreeting.message.id)}`);
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].replyMessageId, repeatedGreeting.aiReply.id);

    const eveningGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "晚上好",
    });
    assert.equal(eveningGreeting.aiReply.status, "pending");
    const eveningListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, eveningGreeting.aiReply.id, "ready");
    const eveningReply = eveningListed.messages.find((message) => message.id === eveningGreeting.aiReply.id);
    assert.equal(eveningReply.body, "晚上好，我在。");

    const punctuation = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "。。",
    });
    assert.equal(punctuation.aiReply.status, "pending");
    const punctuationListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, punctuation.aiReply.id, "ready");
    const punctuationReply = punctuationListed.messages.find((message) => message.id === punctuation.aiReply.id);
    assert.equal(punctuationReply.body, "看到了，继续说。");

    const acknowledgement = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "好的",
    });
    assert.equal(acknowledgement.aiReply.status, "pending");
    const acknowledgementListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, acknowledgement.aiReply.id, "ready");
    const acknowledgementReply = acknowledgementListed.messages.find((message) => message.id === acknowledgement.aiReply.id);
    assert.equal(acknowledgementReply.body, "收到，继续。");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate creates a blocked Ling Agent reply when the channel has no runnable provider", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-suppressed-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个问题谁来回复？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const blockedReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(blockedReply.body, "AI teammate is not configured for this channel.");
    assert.equal(blockedReply.errorMessage, "No provider preset is selected for this channel discussion.");
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit mentions still reply and keep proposal extraction enabled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-explicit-route-"));
  const runner = new ScriptedRunner([
    `Visible explicit reply<ling_task_proposal>{"title":"Explicit proposal","prompt":"Create explicit task","acceptanceCriteria":["ok"],"requiredTools":["read"],"riskSummary":"explicit"}</ling_task_proposal>`,
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 这个明确任务可以处理吗？",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Visible explicit reply");
    assert.match(runner.runs[0].systemPrompt, /include one hidden proposal block/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].createdBy, "explicit_mention");
    assert.equal(decisions.decisions[0].status, "accepted");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].title, "Explicit proposal");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route is rejected by channel create and update while the feature flag is disabled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-disabled-"));
  const daemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: false, intentSelector: false } });
  try {
    const createUrl = `${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`;
    const createBody = {
      name: "Engineering",
      boundPath: cwd,
      autoReplyMode: "auto_route",
    };
    await ensureGitRepoForChannelPost(createUrl, createBody);
    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    assert.equal(createResponse.status, 400);
    assert.equal((await createResponse.json()).error, "auto_route_disabled");

    const channel = await createChannel(daemon.url, cwd);
    const updateResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReplyMode: "auto_route" }),
    });
    assert.equal(updateResponse.status, 400);
    assert.equal((await updateResponse.json()).error, "auto_route_disabled");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route uses the model selector and records accepted route evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-model-"));
  const stores = new Map();
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.9,
      reason: "Designer owns UI wording.",
      alternativesConsidered: [
        {
          teammateId: "teammate_builtin_designer",
          label: "Designer",
          score: 0.9,
          reason: "Best fit.",
        },
      ],
    }),
    `<ling_task_proposal>{"title":"Should not persist","prompt":"Create auto task","acceptanceCriteria":["never"],"requiredTools":["read"],"riskSummary":"blocked by proposalMode"}</ling_task_proposal>Designer auto route reply`,
  ]);
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { autoRoute: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Design",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "auto_route",
      allowedTools: ["read"],
    })).channel;
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const oldGuidanceMessage = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "排队引导：旧频道引导不应继续影响后续消息。",
      },
      "2026-06-12T08:00:00.000Z",
    );
    const oldRun = store.createRun({
      id: "run_old_channel_guidance",
      cwd,
      taskId: "task_old_channel_guidance",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_old_channel_guidance", title: "Old active work", prompt: "Old active work." },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, task: { id: "task_old_channel_guidance", title: "Old active work", prompt: "Old active work.", channelId: channel.id } },
      createdAt: "2026-06-12T08:00:01.000Z",
    });
    store.createRunIntervention(
      {
        sourceRunId: oldRun.id,
        mode: "queue_followup",
        instruction: oldGuidanceMessage.body,
        requestedBy: "local-user",
        idempotencyKey: `channel_message:${oldGuidanceMessage.id}:queue_followup`,
      },
      "2026-06-12T08:00:02.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个设置文案应该怎么改？",
    });

    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.match(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel message router/i);
    assert.match(runner.runs[0].task.prompt, /Decide whether one AI teammate should reply/);
    assert.match(runner.runs[0].task.prompt, /Root local-user messages should produce a visible Ling outcome/);
    assert.match(runner.runs[0].task.prompt, /Channel collaboration protocol:/);
    assert.match(runner.runs[0].task.prompt, /Auto reply mode: auto_route \(source=channel_setting\)/);
    assert.match(runner.runs[0].task.prompt, /Candidates JSON/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /旧频道引导不应继续影响后续消息/);
    assert.match(runner.runs[1].systemPrompt, /Do not include hidden proposal blocks/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "auto_route");
    assert.equal(decisions.decisions[0].createdBy, "model");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].selectedTeammateId, "ling_agent");
    assert.equal(decisions.decisions[0].confidence, 0.9);
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
    assert.equal(decisions.decisions[0].alternativesConsidered[0].teammateId, teammateId);
    assert.equal(decisions.decisions[0].contextPack.kind, "auto_route_selector");
    assert.deepEqual(decisions.decisions[0].contextPack.sectionIds, [
      "auto_route_instructions",
      "channel_collaboration_protocol",
      "auto_route_source_message",
      "auto_route_recent_context",
      "auto_route_candidates",
    ]);
    assert.deepEqual(decisions.decisions[0].contextPack.sourceRefCounts, { channel: 1, message: 1 });
    assert.equal(decisions.decisions[0].contextPack.providerPresetId, provider.id);
    assert.deepEqual((await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`)).proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(runs.runs.filter((run) => run.id !== oldRun.id), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route falls back to Ling Agent replies on selector failure", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-fallback-"));
  const runner = new ScriptedRunner(["not json"]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { autoRoute: true } });
  try {
    const channel = await createAutoRouteTestChannel(daemon.url, cwd);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个交给谁回复？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.equal(runner.runs.length, 2);
    let decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "model");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.2,
      reason: "Unsure.",
      alternativesConsidered: [],
    }));
    const lowConfidence = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个 UI 问题可以自动判断吗？",
    });
    assert.equal(lowConfidence.aiReply.status, "pending");
    assert.equal(lowConfidence.aiReply.authorId, "ling_agent");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(lowConfidence.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.match(decisions.decisions[0].reason, /Route model confidence was below threshold/);

    runner.responses.push(`Here is the decision: ${JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.9,
      reason: "Wrapped JSON should fail strict parsing.",
      alternativesConsidered: [],
    })}`);
    const wrappedJson = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个带解释的模型输出应该失败吗？",
    });
    assert.equal(wrappedJson.aiReply.status, "pending");
    assert.equal(wrappedJson.aiReply.authorId, "ling_agent");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(wrappedJson.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_missing",
      confidence: 0.9,
      reason: "Unknown teammate should fail closed.",
      alternativesConsidered: [],
    }));
    const unknownTeammate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个未知 teammate 应该失败吗？",
    });
    assert.equal(unknownTeammate.aiReply.status, "pending");
    assert.equal(unknownTeammate.aiReply.authorId, "ling_agent");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(unknownTeammate.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI replies return pending message before runner finishes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-ai-reply-pending-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer async please",
      mentions: [{ id: teammateId, label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
      providerPresetId: provider.id,
      teammateId,
    });

    assert.equal(created.aiReply.status, "pending");
    await waitForCondition(() => runner.runs.length === 1, "runner to start channel AI reply");
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.completed, false);
    const pending = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(pending.messages.find((message) => message.id === created.aiReply.id).status, "pending");

    runner.resolve("Delayed reply");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Delayed reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel attachment upload validates file types and serves content safely", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachments-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const uploaded = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("hello channel", "utf8").toString("base64"),
    });
    assert.equal(uploaded.attachment.kind, "text");
    assert.equal(uploaded.attachment.fileName, "brief.txt");

    const content = await fetch(`${daemon.url}/attachments/${encodeURIComponent(uploaded.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.equal(await content.text(), "hello channel");

    const typed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "payload.txt",
      contentType: "text/html",
      contentBase64: Buffer.from("<script>alert(1)</script>", "utf8").toString("base64"),
    });
    const typedContent = await fetch(`${daemon.url}/attachments/${encodeURIComponent(typed.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.match(typedContent.headers.get("content-type") ?? "", /^text\/plain/);

    const rejected = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "archive.zip",
        contentBase64: Buffer.from("zip").toString("base64"),
      }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /Unsupported attachment type/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment-only channel turn reaches Ling Agent with metadata and preview", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachment-only-turn-"));
  const runner = new ScriptedRunner(["看到了 brief.txt。你要我总结、写入文件，还是作为当前任务上下文？"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment turn",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("hello channel attachment", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "看到了 brief.txt。你要我总结、写入文件，还是作为当前任务上下文？");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Turn envelope/);
    assert.match(runner.runs[0].task.prompt, /brief\.txt/);
    assert.match(runner.runs[0].task.prompt, /hello channel attachment/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 1);
    assert.equal(routeDecisions.decisions[0].action, "reply");
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(intentDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel asset references must stay within the same channel", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-reference-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "source message",
    });
    const attachment = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentBase64: Buffer.from("brief", "utf8").toString("base64"),
      messageId: message.message.id,
    });
    const preview = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private",
    });

    const crossUpload = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "other.txt",
        contentBase64: Buffer.from("other", "utf8").toString("base64"),
        messageId: message.message.id,
      }),
    });
    assert.equal(crossUpload.status, 400);
    assert.equal((await crossUpload.json()).error, "message_channel_mismatch");

    const crossMessage = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "cross channel reference",
        attachmentIds: [attachment.attachment.id],
        linkPreviewIds: [preview.linkPreview.id],
      }),
    });
    assert.equal(crossMessage.status, 400);
    assert.equal((await crossMessage.json()).error, "attachment_channel_mismatch");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel collaboration protocol resolver API patches existing channel fields and reverts to defaults", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-settings-"));
  const daemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: false } });
  try {
    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "zh-CN",
    });
    const channel = await createChannel(daemon.url, cwd);

    const initial = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.protocol.schemaVersion, 1);
    assert.equal(initial.protocol.channelId, channel.id);
    assert.equal(initial.protocol.responseLanguage, "zh-CN");
    assert.equal(initial.sources.responseLanguage.source, "workspace_setting");
    assert.equal(initial.sources.responseLanguage.channelValue, "workspace");
    assert.equal(initial.sources.responseLanguage.workspaceValue, "zh-CN");
    assert.equal(initial.protocol.autoReplyMode, "mentions_only");
    assert.equal(initial.sources.autoReplyMode.source, "default");
    assert.equal(initial.protocol.defaultTeammateId, undefined);
    assert.equal(initial.sources.defaultTeammateId.source, "default");
    assert.equal(initial.storage.mode, "channel_fields_and_protocol_overrides");
    assert.deepEqual(initial.storage.editableFields, ["responseLanguage", "autoReplyMode", "defaultTeammateId", "defaultWorkflowPreference", "visibleMultiReplyMaxParticipants", "privacyRules", "reviewRules"]);
    assert.equal(initial.storage.unsupportedFields.length, 0);

    const patched = await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "en-US",
      autoReplyMode: "default_teammate",
      defaultTeammateId: "teammate_builtin_engineer",
    });
    assert.equal(patched.protocol.responseLanguage, "en-US");
    assert.equal(patched.sources.responseLanguage.source, "channel_setting");
    assert.equal(patched.protocol.autoReplyMode, "default_teammate");
    assert.equal(patched.sources.autoReplyMode.source, "channel_setting");
    assert.equal(patched.protocol.defaultTeammateId, "teammate_builtin_engineer");
    assert.equal(patched.sources.defaultTeammateId.source, "channel_setting");
    const channelAfterPatch = (await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`)).channel;
    assert.equal(channelAfterPatch.responseLanguage, "en-US");
    assert.equal(channelAfterPatch.autoReplyMode, "default_teammate");
    assert.equal(channelAfterPatch.defaultTeammateId, "teammate_builtin_engineer");

    const unsupported = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privacyRules: ["Do not expose private teammate chat."] }),
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.error, "unsupported_protocol_field");
    assert.equal(unsupportedBody.field, "privacyRules");

    const autoRoute = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReplyMode: "auto_route" }),
    });
    assert.equal(autoRoute.status, 400);
    assert.equal((await autoRoute.json()).error, "auto_route_disabled");

    const missingTeammate = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTeammateId: "missing_teammate" }),
    });
    assert.equal(missingTeammate.status, 400);
    assert.equal((await missingTeammate.json()).error, "default_teammate_not_found");

    const reverted = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/revert?cwd=${encodeURIComponent(cwd)}`, {});
    assert.deepEqual(reverted.revertedFields, ["responseLanguage", "autoReplyMode", "defaultTeammateId", "defaultWorkflowPreference", "visibleMultiReplyMaxParticipants", "privacyRules", "reviewRules"]);
    assert.equal(reverted.protocol.responseLanguage, "zh-CN");
    assert.equal(reverted.sources.responseLanguage.source, "workspace_setting");
    assert.equal(reverted.protocol.autoReplyMode, "mentions_only");
    assert.equal(reverted.sources.autoReplyMode.source, "default");
    assert.equal(reverted.protocol.defaultTeammateId, undefined);
    const channelAfterRevert = (await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`)).channel;
    assert.equal(channelAfterRevert.responseLanguage, undefined);
    assert.equal(channelAfterRevert.autoReplyMode, "mentions_only");
    assert.equal(channelAfterRevert.defaultTeammateId, undefined);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel collaboration protocol drafts apply protocol-only overrides with source refs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-drafts-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Draft a protocol update.",
    });
    const otherMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(second.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Wrong channel source.",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: {
        defaultWorkflowPreference: "architect_engineer_qa",
        visibleMultiReplyMaxParticipants: 2,
        privacyRules: ["Do not expose private teammate chat."],
        reviewRules: ["Require QA evidence before Done."],
      },
      reason: "AI suggested a tighter channel protocol.",
      createdBy: "ai-draft",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Source request" }],
    });
    assert.equal(created.draft.status, "draft");
    assert.equal(created.draft.baseVersion, 0);
    assert.equal(created.protocol.defaultWorkflowPreference, "manual");
    assert.equal(created.sources.defaultWorkflowPreference.source, "default");

    let drafts = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}&status=draft`);
    assert.deepEqual(drafts.drafts.map((draft) => draft.id), [created.draft.id]);

    const applied = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts/${encodeURIComponent(created.draft.id)}/apply?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(applied.draft.status, "applied");
    assert.equal(applied.draft.appliedProtocolVersion, 1);
    assert.equal(applied.protocol.protocolVersion, 1);
    assert.equal(applied.protocol.defaultWorkflowPreference, "architect_engineer_qa");
    assert.equal(applied.sources.defaultWorkflowPreference.source, "protocol_override");
    assert.equal(applied.protocol.visibleMultiReplyMaxParticipants, 2);
    assert.deepEqual(applied.protocol.privacyRules, ["Do not expose private teammate chat."]);
    assert.deepEqual(applied.protocol.reviewRules, ["Require QA evidence before Done."]);

    const stale = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { visibleMultiReplyMaxParticipants: 3 },
      reason: "Stale update.",
    });
    const staleApply = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts/${encodeURIComponent(stale.draft.id)}/apply?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    assert.equal(staleApply.status, 409);
    const staleBody = await staleApply.json();
    assert.equal(staleBody.error, "draft_base_version_mismatch");
    assert.equal(staleBody.draft.status, "stale");

    const crossRef = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedPatch: { visibleMultiReplyMaxParticipants: 4 },
        reason: "Cross-channel source should fail.",
        sourceRefs: [{ type: "message", id: otherMessage.message.id }],
      }),
    });
    assert.equal(crossRef.status, 400);
    assert.match((await crossRef.json()).message, /channel/i);

    const reverted = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/revert?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reverted.protocol.protocolVersion, undefined);
    assert.equal(reverted.protocol.defaultWorkflowPreference, "manual");
    assert.equal(reverted.sources.defaultWorkflowPreference.source, "default");
    drafts = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}&status=applied`);
    assert.equal(drafts.drafts.some((draft) => draft.id === created.draft.id), true);

    const candidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { reviewRules: ["Keep candidate review separate from skill creation."] },
      reason: "Channel canvas candidate.",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Canvas source" }],
    });
    assert.equal(candidate.draft.status, "draft");
    const candidates = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}&status=draft&limit=5`);
    assert.equal(candidates.drafts.some((draft) => draft.id === candidate.draft.id), true);

    const rejected = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates/${encodeURIComponent(candidate.draft.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "reject",
      reason: "Not needed now.",
    });
    assert.equal(rejected.draft.status, "cancelled");
    assert.equal(rejected.protocol.protocolVersion, undefined);

    const approvedCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { privacyRules: ["Do not turn every channel protocol into a skill."] },
      reason: "Approved channel canvas candidate.",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Canvas source" }],
    });
    const reviewed = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates/${encodeURIComponent(approvedCandidate.draft.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Matches channel canvas policy.",
    });
    assert.equal(reviewed.draft.status, "applied");
    assert.equal(reviewed.protocol.protocolVersion, 1);
    assert.deepEqual(reviewed.protocol.privacyRules, ["Do not turn every channel protocol into a skill."]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel collaboration protocol endpoints persist state and reject cross-channel sources", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-api-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Use manual handoffs for v1.1.",
    });
    const otherMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(second.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Other channel.",
    });
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: first.id,
      title: "Implement protocol",
      prompt: "Build channel protocol state.",
    })).task;

    const emptyBrief = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/brief?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(emptyBrief.brief.objective, "");

    const decision = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      sourceMessageId: message.message.id,
      title: "Manual handoffs",
      decision: "Handoffs do not change task state.",
      createdBy: "local-user",
    });
    const superseded = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      title: "Manual handoffs update",
      decision: "Supersede by creating a new active decision.",
      supersedesDecisionId: decision.decision.id,
      createdBy: "local-user",
    });
    assert.equal(superseded.decision.status, "active");
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(decisions.decisions.find((item) => item.id === decision.decision.id).status, "superseded");

    const brief = await patchJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/brief?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Ship channel v1.1",
      scope: "Collaboration protocol",
      acceptanceCriteria: ["Brief persists"],
      decisionIds: [superseded.decision.id],
      updatedBy: "local-user",
    });
    assert.deepEqual(brief.brief.acceptanceCriteria, ["Brief persists"]);

    const handoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need implementation",
      requiredInput: "Plan",
      expectedOutput: "Patch",
      createdBy: "local-user",
    });
    await patchJson(`${daemon.url}/handoffs/${encodeURIComponent(handoff.handoff.id)}?cwd=${encodeURIComponent(cwd)}`, { status: "completed" });
    const listedTask = (await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks.find((item) => item.id === task.id);
    assert.equal(listedTask.status, "todo");

    const summary = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`, {
      targetType: "task",
      targetId: task.id,
      sourceMessageIds: [message.message.id],
      decisionIds: [superseded.decision.id],
      summary: "Build the protocol layer.",
      authorType: "local-user",
    });
    assert.equal(summary.contextSummary.targetId, task.id);

    const crossSummary = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "thread",
        targetId: otherMessage.message.id,
        sourceMessageIds: [otherMessage.message.id],
        summary: "Should fail.",
        authorType: "local-user",
      }),
    });
    assert.equal(crossSummary.status, 400);
    assert.match((await crossSummary.json()).message, /channel/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel handoff workflows start steps, create tasks, and expose blockers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflows-api-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: first.id,
      title: "Implement workflow",
      prompt: "Build v1.2.",
    })).task;
    const handoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need implementation",
      requiredInput: "v1.2 plan",
      expectedOutput: "Patch",
      createdBy: "local-user",
    });

    const createdWorkflow = await postJson(`${daemon.url}/handoffs/${encodeURIComponent(handoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
    });
    assert.equal(createdWorkflow.workflow.status, "draft");
    assert.equal(createdWorkflow.workflowStep.status, "queued");

    const started = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(createdWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_task",
      taskTitle: "Workflow generated task",
    });
    assert.equal(started.workflow.status, "succeeded");
    assert.equal(started.workflowStep.status, "succeeded");
    assert.equal(started.task.title, "Workflow generated task");
    assert.equal(started.task.assigneeTeammateId, "engineer");

    const workflowEvents = await getJson(`${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=workflow&entityId=${encodeURIComponent(createdWorkflow.workflow.id)}`);
    assert.ok(workflowEvents.transitions.some((event) => event.toStatus === "succeeded"));
    const stepEvents = await getJson(`${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=workflow_step&entityId=${encodeURIComponent(createdWorkflow.workflowStep.id)}`);
    assert.ok(stepEvents.transitions.some((event) => event.toStatus === "succeeded"));

    const secondHandoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need run",
      requiredInput: "v1.2 plan",
      expectedOutput: "Run",
      createdBy: "local-user",
    });
    const blockedWorkflow = await postJson(`${daemon.url}/handoffs/${encodeURIComponent(secondHandoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
    });
    const blocked = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(blockedWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_and_run_task",
    });
    assert.equal(blocked.workflowStep.status, "blocked");
    assert.match(blocked.blocker, /provider preset/i);

    const crossWorkflow = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceHandoffId: handoff.handoff.id,
        title: "Cross channel",
        objective: "Should fail.",
        createdBy: "local-user",
      }),
    });
    assert.equal(crossWorkflow.status, 400);
    assert.match((await crossWorkflow.json()).message, /channel/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow handoff intents validate, accept, and stay visible as workflow evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-handoff-intents-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Handoff intent workflow",
      objective: "Validate workflow handoff intent evidence.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const sourceStep = createParallelWorkflowStep(store, workflow.id, "Source Step", {
      branchGroupId: "source",
    });

    const created = await postJson(`${daemon.url}/workflow-handoff-intents?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      workflowId: workflow.id,
      sourceWorkflowStepId: sourceStep.id,
      fromParticipantId: "teammate_builtin_architect",
      fromParticipantLabel: "Architect",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      reason: "Engineer should implement the validated boundary.",
      requiredInput: "Design boundary",
      expectedOutput: "Patch",
      riskSummary: "No permission is granted by this packet.",
      sourceRefs: [
        { type: "workflow", id: workflow.id, label: workflow.title },
        { type: "workflow_step", id: sourceStep.id, label: sourceStep.title },
      ],
      createdBy: "orchestrator",
    });
    assert.equal(created.handoffIntent.status, "validated");
    assert.equal(created.handoffIntent.validation.targetTeammateExists, true);
    assert.equal(created.handoffIntent.validation.targetTeammateActive, true);

    const stepAfterIntent = store.getChannelWorkflowStep(sourceStep.id);
    assert.ok(stepAfterIntent.metadata.handoffIntentIds.includes(created.handoffIntent.id));

    const accepted = await postJson(`${daemon.url}/workflow-handoff-intents/${encodeURIComponent(created.handoffIntent.id)}/accept?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(accepted.intent.status, "accepted");
    assert.ok(accepted.intent.channelHandoffId);

    const listed = await getJson(`${daemon.url}/workflow-handoff-intents?cwd=${encodeURIComponent(cwd)}&workflowId=${encodeURIComponent(workflow.id)}`);
    assert.deepEqual(listed.handoffIntents.map((intent) => intent.id), [created.handoffIntent.id]);

    const evidence = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(evidence.handoffIntents.some((intent) => intent.id === created.handoffIntent.id && intent.status === "accepted"), true);
    assert.equal(evidence.handoffs.some((handoff) => handoff.id === accepted.intent.channelHandoffId && handoff.status === "accepted"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow collaboration card endpoints derive compact product cards", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-collaboration-card-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Ship collaboration card read model",
      objective: "Expose a compact collaboration card without raw workflow internals.",
      status: "running",
      createdBy: "ling_agent",
    }, "2026-06-13T00:00:00.000Z");
    const designStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 1,
      title: "Design API boundary",
      prompt: "Define the daemon API contract.",
      toParticipantId: "teammate_builtin_architect",
      toParticipantLabel: "Architect",
      status: "succeeded",
      metadata: { branchGroupId: "design" },
    }, "2026-06-13T00:01:00.000Z");
    store.updateChannelWorkflowStep(designStep.id, { resultSummary: "Contract boundary is ready." }, "2026-06-13T00:02:00.000Z");
    const implementationStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 2,
      title: "Implement endpoint",
      prompt: "Implement the daemon endpoint and client facade.",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: "waiting_for_approval",
      metadata: { branchGroupId: "implementation", maxParallelSiblings: 2 },
    }, "2026-06-13T00:03:00.000Z");
    const run = store.createRun({
      id: "run_collaboration_card_waiting",
      cwd,
      taskId: "task_collaboration_card_waiting",
      channelId: channel.id,
      teammateId: "teammate_builtin_engineer",
      workflowStepId: implementationStep.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_collaboration_card_waiting", title: "Implement endpoint" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-13T00:04:00.000Z",
    });
    store.markRunWaitingForApproval(run.id, "2026-06-13T00:05:00.000Z");
    store.updateChannelWorkflowStep(implementationStep.id, { runId: run.id }, "2026-06-13T00:05:00.000Z");
    store.createApprovalRequest({
      runId: run.id,
      taskId: run.taskId,
      channelId: channel.id,
      actionType: "write",
      risk: "medium",
      title: "Approve endpoint edit",
      description: "Allow editing daemon endpoint files.",
      payload: { type: "file_write", path: `${cwd}/packages/daemon/src/features/channels/collaboration-cards.ts`, bytes: 128 },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, "2026-06-13T00:06:00.000Z");

    const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/collaboration-cards?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channelId, channel.id);
    assert.equal(listed.cards.length, 1);
    const card = listed.cards[0];
    assert.equal(card.workflowId, workflow.id);
    assert.equal(card.mode, "waiting");
    assert.equal(card.executionMode, "parallel");
    assert.equal(card.currentOwnerLabel, "Engineer");
    assert.equal(card.pendingApprovalCount, 1);
    assert.equal(card.completedStepCount, 1);
    assert.equal(card.totalStepCount, 2);
    assert.equal(card.branches.length, 2);
    assert.equal(card.branches.some((branch) => branch.ownerLabels.includes("Architect")), true);
    assert.equal(card.branches.some((branch) => branch.ownerLabels.includes("Engineer")), true);
    assert.equal(JSON.stringify(card).includes("selector"), false);
    assert.equal(JSON.stringify(card).includes("contextPack"), false);

    const single = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/collaboration-card?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(single.workflowId, workflow.id);
    assert.deepEqual(single.card, card);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("autoplan-lite workflow compiles durable steps and orchestrates them through the runner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-orchestrator-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Autoplan",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Build the orchestrator test slice.",
      providerPresetId: provider.id,
      runnerId: "pi",
      createdBy: "local-user",
    });
    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflowSteps.length, 8);
    assert.equal(compiled.workflowSteps[0].metadata.templateStepId, "product-discovery");
    assert.equal(compiled.workflowSteps[0].metadata.requestedRunnerId, "pi");
    assert.equal(compiled.workflowSteps[0].metadata.policy.onRunFailed, "block_for_user");
    assert.equal(compiled.workflowSteps[4].metadata.policy.onRunFailed, "fail_workflow");
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds.length, 1);

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    assert.equal(firstTick.workflowStep.metadata.templateStepId, "product-discovery");
    const stepsAfterFirstTick = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const firstStepAfterFirstTick = stepsAfterFirstTick.workflowSteps.find((step) => step.id === firstTick.workflowStep.id);
    assert.ok(firstStepAfterFirstTick);
    assert.ok(firstStepAfterFirstTick.metadata.contextArtifactId);
    const firstContext = await getArtifactJson(daemon.url, cwd, firstStepAfterFirstTick.metadata.contextArtifactId);
    assert.equal(firstContext.schemaVersion, 1);
    assert.equal(firstContext.workflowId, compiled.workflow.id);
    assert.equal(firstContext.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstContext.objective, "Build the orchestrator test slice.");
    assert.deepEqual(firstContext.dependencies, []);
    assert.equal(firstContext.providerPresetId, provider.id);
    assert.equal(firstContext.contextPack.kind, "workflow_step");
    assert.equal(firstContext.contextPack.providerPresetId, provider.id);
    assert.equal(firstContext.contextPack.budget.mode, "model_estimated");
    assert.equal(firstContext.contextPack.budget.capabilitySource, "provider_metadata");
    assert.equal(firstContext.contextPack.budget.capabilityConfidence, "estimated");
    assert.equal(firstContext.contextPack.overBudget, false);
    assert.equal(firstContext.contextPack.sections.some((section) => section.id === "workflow_runtime_boundary"), true);
    assert.equal(firstContext.contextPack.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);
    const workflowEvidenceAfterFirstTick = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    const firstStepEvidence = workflowEvidenceAfterFirstTick.steps.find((item) => item.step.id === firstStepAfterFirstTick.id);
    assert.ok(firstStepEvidence);
    assert.equal(firstStepEvidence.contextInspect.availability, "available");
    assert.equal(firstStepEvidence.contextInspect.contextArtifactId, firstStepAfterFirstTick.metadata.contextArtifactId);
    assert.equal(firstStepEvidence.contextInspect.kind, "workflow_step");
    assert.equal(firstStepEvidence.contextInspect.budget.mode, "model_estimated");
    assert.equal(firstStepEvidence.contextInspect.budget.capabilitySource, "provider_metadata");
    assert.equal(firstStepEvidence.contextInspect.budget.capabilityConfidence, "estimated");
    assert.equal(firstStepEvidence.contextInspect.sections.some((section) => section.id === "workflow_runtime_boundary"), true);
    assert.equal(firstStepEvidence.contextInspect.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);
    assert.equal(firstStepEvidence.contextInspect.safety.rawPromptTextIncluded, false);
    assert.doesNotMatch(JSON.stringify(firstStepEvidence.contextInspect), /Workflow step runtime boundary:/);
    assert.ok(firstStepAfterFirstTick.runId);
    const firstRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(firstStepAfterFirstTick.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstRun.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.runnerResolution.requestSource, "workflow_step");
    const runsForStep = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.deepEqual(runsForStep.runs.map((run) => run.id), [firstRun.id]);
    const threadsForStep = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.equal(threadsForStep.threads.length, 1);
    assert.equal(threadsForStep.threads[0].kind, "workflow_step");
    assert.equal(threadsForStep.threads[0].workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(threadsForStep.threads[0].lastRunId, firstRun.id);

    await waitForCondition(() => runner.runs.length === 4, "autoplan-lite planning runner sequence");
    const implementationTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "implementation");
    assert.equal(implementationTick.status, "started");
    assert.equal(implementationTick.workflowStep.metadata.templateStepId, "implementation");

    await waitForCondition(() => runner.runs.length === 6, "autoplan-lite implementation and review sequence");
    const qaTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "qa");
    assert.equal(qaTick.status, "started");
    assert.equal(qaTick.workflowStep.metadata.templateStepId, "qa");

    await waitForCondition(() => runner.runs.length === 7, "autoplan-lite qa sequence");
    const shipTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "ship");
    assert.equal(shipTick.status, "started");
    assert.equal(shipTick.workflowStep.metadata.templateStepId, "ship");

    await waitForCondition(() => runner.runs.length === 8, "autoplan-lite runner sequence");
    const finalWorkflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalWorkflow.workflow.status, "succeeded");
    const finalSteps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(finalSteps.workflowSteps.map((step) => step.status), Array(8).fill("succeeded"));
    const productStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "product-discovery");
    assert.ok(productStep);
    assert.ok(productStep.metadata.outputArtifactId);
    assert.ok(productStep.metadata.outputArtifactIds.includes(productStep.metadata.outputArtifactId));
    const productOutput = await getArtifactJson(daemon.url, cwd, productStep.metadata.outputArtifactId);
    assert.equal(productOutput.schemaVersion, 1);
    assert.equal(productOutput.workflowStepId, productStep.id);
    assert.equal(productOutput.runId, productStep.runId);
    assert.equal(productOutput.status, "succeeded");
    assert.ok(productOutput.artifactIds.includes(productStep.metadata.contextArtifactId));
    assert.equal(productOutput.runnerAudit.effectiveRunnerId, "pi");
    const designStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "design-review");
    assert.ok(designStep);
    assert.ok(designStep.metadata.outputArtifactId);
    const implementationStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "implementation");
    assert.ok(implementationStep);
    assert.ok(implementationStep.metadata.contextArtifactId);
    const implementationContext = await getArtifactJson(daemon.url, cwd, implementationStep.metadata.contextArtifactId);
    assert.equal(implementationContext.workflowStepId, implementationStep.id);
    assert.equal(implementationContext.dependencies.length, 2);
    assert.equal(implementationContext.dependencies.every((dependency) => dependency.outputArtifactId), true);
    assert.equal(implementationContext.priorOutputArtifactIds.length >= 2, true);
    assert.match(runner.runs[0].task.prompt, /Context Pack: workflow_step/);
    assert.match(runner.runs[0].task.prompt, /Provider budget mode: model_estimated/);
    assert.match(runner.runs[0].task.prompt, /Workflow context artifact: pending until run starts/);
    assert.match(runner.runs[0].task.prompt, /Dependencies:\n- none/);
    assert.match(runner.runs[0].task.prompt, /Approval gates:\n- none/);
    const implementationRun = runner.runs.find((run) => run.task.title === "Implementation");
    assert.ok(implementationRun);
    assert.match(implementationRun.task.prompt, /Context Pack: workflow_step/);
    assert.match(implementationRun.task.prompt, /Provider budget mode: model_estimated/);
    assert.match(implementationRun.task.prompt, /Dependency output:/);
    assert.match(implementationRun.task.prompt, /Approval gates:\n- pre-run: mode=standard; risk=medium/);
    assert.match(implementationRun.task.prompt, /Design Review \(succeeded\)/);
    assert.match(implementationRun.task.prompt, /Engineering Review \(succeeded\)/);
    assert.ok(implementationRun.task.prompt.includes(designStep.metadata.outputArtifactId));
    assert.deepEqual(runner.runs.map((run) => run.task.title), [
      "Product Discovery",
      "Product Review",
      "Design Review",
      "Engineering Review",
      "Implementation",
      "Code Review",
      "QA",
      "Ship",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow graph compiles into durable steps and emits standardized packets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-graph-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Graph workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      workflowGraph: {
        schemaVersion: 1,
        id: "graph_test",
        name: "Graph Test",
        summary: "Graph compile test",
        entryNodeId: "plan",
        nodes: [
          {
            id: "plan",
            kind: "step",
            name: "Plan",
            prompt: "Draft the implementation boundary.",
            teammateTemplateId: "architect",
            skillId: "spec",
            autoStart: true,
          },
          {
            id: "review",
            kind: "step",
            name: "Review",
            prompt: "Review the implementation boundary.",
            teammateTemplateId: "engineer",
            skillId: "review",
            autoStart: true,
          },
        ],
        edges: [
          {
            id: "plan_to_review",
            fromNodeId: "plan",
            toNodeId: "review",
            condition: { kind: "all_succeeded" },
          },
        ],
        termination: {
          success: "all_required_succeeded",
          onFailedRequiredNode: "fail_workflow",
          onApprovalDenied: "block_for_user",
        },
        maxParallelSteps: 1,
      },
      objective: "Ship graph compile test.",
      providerPresetId: provider.id,
      runnerId: "pi",
      createdBy: "local-user",
    });
    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflow.metadata.workflowGraphId, "graph_test");
    assert.equal(compiled.workflow.metadata.workflowGraphSchemaVersion, 1);
    assert.equal(compiled.workflow.metadata.termination.onFailedRequiredNode, "fail_workflow");
    assert.equal(compiled.workflowSteps.length, 2);
    assert.deepEqual(compiled.workflowSteps.map((step) => step.metadata.graphNodeId), ["plan", "review"]);
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds.length, 1);
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds[0], compiled.workflowSteps[0].id);

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    await waitForCondition(() => runner.runs.length === 2, "workflow graph runner sequence");

    const finalWorkflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalWorkflow.workflow.status, "succeeded");
    const finalSteps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const planStep = finalSteps.workflowSteps.find((step) => step.metadata.graphNodeId === "plan");
    const reviewStep = finalSteps.workflowSteps.find((step) => step.metadata.graphNodeId === "review");
    assert.ok(planStep);
    assert.ok(reviewStep);
    assert.ok(planStep.metadata.contextArtifactId);
    assert.ok(planStep.metadata.outputArtifactId);
    assert.ok(reviewStep.metadata.contextArtifactId);

    const planContext = await getArtifactJson(daemon.url, cwd, planStep.metadata.contextArtifactId);
    assert.equal(planContext.graphId, "graph_test");
    assert.equal(planContext.graphNodeId, "plan");
    assert.equal(planContext.teammateId, planStep.toParticipantId);
    assert.equal(planContext.skillId, "spec");
    assert.equal(planContext.contextPack.kind, "workflow_step");
    assert.equal(planContext.contextPack.sections.some((section) => section.id === "workflow_current_step"), true);
    assert.equal(planContext.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);

    const planOutput = await getArtifactJson(daemon.url, cwd, planStep.metadata.outputArtifactId);
    assert.equal(planOutput.graphId, "graph_test");
    assert.equal(planOutput.graphNodeId, "plan");
    assert.equal(planOutput.teammateId, planStep.toParticipantId);
    assert.equal(planOutput.skillId, "spec");
    assert.ok(Array.isArray(planOutput.blockers));
    assert.ok(Array.isArray(planOutput.changedPaths));
    assert.equal(planOutput.sourceRefs.some((ref) => ref.type === "run" && ref.id === planStep.runId), true);

    const reviewContext = await getArtifactJson(daemon.url, cwd, reviewStep.metadata.contextArtifactId);
    assert.equal(reviewContext.dependencies.length, 1);
    assert.equal(reviewContext.dependencies[0].workflowStepId, planStep.id);
    assert.equal(reviewContext.dependencies[0].outputArtifactId, planStep.metadata.outputArtifactId);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow step context compacts dependency output before blocking on provider budget", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-context-compaction-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
      contextWindow: 1800,
      maxTokens: 512,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Context compaction workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Dependency compaction",
      objective: "Verify dependency output compaction before the downstream step starts.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const hugeDependencySummary = `Important dependency summary. ${"research finding detail ".repeat(80)}`;
    const upstreamSteps = Array.from({ length: 7 }, (_, index) => {
      const step = createParallelWorkflowStep(store, workflow.id, `Research Findings ${index + 1}`, {
        branchGroupId: `research-${index + 1}`,
        providerPresetId: provider.id,
        status: "succeeded",
      });
      store.updateChannelWorkflowStep(
        step.id,
        { resultSummary: hugeDependencySummary },
        now,
      );
      return step;
    });
    const downstream = createParallelWorkflowStep(store, workflow.id, "Implementation From Research", {
      branchGroupId: "implementation",
      providerPresetId: provider.id,
      dependsOnStepIds: upstreamSteps.map((step) => step.id),
      dependencyMode: "all_succeeded",
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, downstream.id);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Compacted workflow dependency summary/);
    assert.match(runner.runs[0].task.prompt, /Compaction id: workflow_packet_summary_/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail/);

    const startedStep = await waitForWorkflowStepStatus(daemon.url, cwd, workflow.id, downstream.id, "succeeded");
    assert.ok(startedStep.metadata.contextArtifactId);
    const contextPacket = await getArtifactJson(daemon.url, cwd, startedStep.metadata.contextArtifactId);
    assert.equal(contextPacket.contextPack.kind, "workflow_step");
    assert.equal(contextPacket.contextPack.budget.mode, "model_known");
    assert.equal(contextPacket.contextPack.budget.contextWindowTokens, 1800);
    assert.equal(contextPacket.contextPack.budget.reservedOutputTokens, 512);
    assert.equal(contextPacket.contextPack.budget.reservedRuntimeOverheadTokens, 512);
    assert.equal(contextPacket.contextPack.budget.inputBudgetTokens, 1024);
    assert.equal(contextPacket.contextPack.budget.tokenizer, "openai-compatible");
    assert.equal(contextPacket.contextPack.budget.capabilitySource, "user_override");
    assert.equal(contextPacket.contextPack.budget.capabilityConfidence, "known");
    assert.equal(typeof contextPacket.contextPack.estimatedInputTokens, "number");
    assert.equal(contextPacket.contextPack.overBudget, false);
    assert.equal(contextPacket.contextPack.sections.some((section) => section.id === "workflow_dependency_summary"), true);
    assert.equal(contextPacket.contextPack.sections.some((section) => section.id === "workflow_dependency_1"), false);
    assert.equal(contextPacket.contextPack.sections.every((section) => typeof section.estimatedTokens === "number"), true);
    const protocolSection = contextPacket.contextPack.sections.find((section) => section.id === "channel_collaboration_protocol");
    assert.ok(protocolSection);
    assert.equal(protocolSection.metadata.autoReplyMode, "mentions_only");
    assert.equal(protocolSection.metadata.autoReplyModeSource, "default");
    assert.equal(contextPacket.contextPack.droppedSectionIds.includes("workflow_dependency_summary"), false);
    assert.equal(contextPacket.contextPack.compactionIds.length, 1);
    const compactionArtifactId = contextPacket.contextPack.compactionIds[0];
    assert.equal(contextPacket.contextPack.sourceRefs.some((ref) => ref.type === "artifact" && ref.id === compactionArtifactId), true);

    const compactionPacket = await getArtifactJson(daemon.url, cwd, compactionArtifactId);
    assert.equal(compactionPacket.schemaVersion, 1);
    assert.equal(compactionPacket.kind, "workflow_packet_summary");
    assert.equal(compactionPacket.workflowId, workflow.id);
    assert.equal(compactionPacket.workflowStepId, downstream.id);
    assert.equal(compactionPacket.dependencyOutputRefs.length, upstreamSteps.length);
    assert.deepEqual(compactionPacket.dependencyOutputRefs.map((ref) => ref.workflowStepId), upstreamSteps.map((step) => step.id));
    assert.equal(compactionPacket.droppedSectionIds.some((id) => id.startsWith("workflow_dependency_")), true);
    assert.equal(compactionPacket.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === upstreamSteps[0].id), true);
    assert.ok(compactionPacket.summary.includes(`Dependency count: ${upstreamSteps.length}.`));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow planning failure follows policy and blocks for user repair", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-planning-failure-"));
  const runner = new SelectiveFailingRunner(["Product Discovery"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Planning failure workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Block failed planning for repair.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const failedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, firstTick.workflowStep.id, "blocked");
    assert.equal(failedStep.metadata.policy.onRunFailed, "block_for_user");
    assert.match(failedStep.blocker, /Product Discovery failed/);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow implementation failure follows policy and fails the workflow", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-implementation-failure-"));
  const runner = new SelectiveFailingRunner(["Implementation"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Implementation failure workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Fail implementation when policy requires it.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    await waitForCondition(() => runner.runs.length === 4, "planning and review steps before implementation failure");
    const implementationTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "implementation");
    assert.equal(implementationTick.status, "started");
    const failedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "failed");
    assert.equal(failedStep.metadata.policy.onRunFailed, "fail_workflow");
    assert.match(failedStep.blocker, /Implementation failed/);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "failed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow post-step gate pauses downstream steps until approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-post-gate-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Post gate workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Pause after discovery for review.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const discoveryStep = store.getChannelWorkflowStep(compiled.workflowSteps[0].id);
    assert.ok(discoveryStep);
    store.updateChannelWorkflowStep(
      discoveryStep.id,
      {
        metadata: {
          ...discoveryStep.metadata,
          gates: [{
            stage: "post",
            approvalProfile: { mode: "standard", risk: "medium" },
            title: "Review discovery output",
            reason: "Review Product Discovery output before downstream planning starts.",
            requiredForStatuses: ["succeeded"],
          }],
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const gatedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "waiting_for_approval");
    assert.equal(gatedStep.metadata.activeGateStage, "post");
    assert.ok(gatedStep.metadata.postStepApprovalId);
    assert.equal(runner.runs.length, 1);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(discoveryStep.id)}`);
    assert.equal(pending.approvals.length, 1);
    assert.equal(pending.approvals[0].payload.gateStage, "post");

    const waitingTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(waitingTick.status, "waiting_for_approval");
    assert.equal(runner.runs.length, 1);
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Discovery output reviewed.",
    });
    const discoveryAfterApproval = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "succeeded");
    assert.equal(discoveryAfterApproval.metadata.activeGateStage, undefined);
    assert.ok(discoveryAfterApproval.metadata.outputArtifactId);
    const workflowAfterApproval = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflowAfterApproval.workflow.status, "running");
    const nextTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(nextTick.status, "started");
    assert.equal(nextTick.workflowStep.metadata.templateStepId, "product-review");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow post-step gate resumes after daemon restart when approval was granted", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-post-gate-restart-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  let daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Post gate restart workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Resume a granted post gate after daemon restart.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const discoveryStep = store.getChannelWorkflowStep(compiled.workflowSteps[0].id);
    assert.ok(discoveryStep);
    store.updateChannelWorkflowStep(
      discoveryStep.id,
      {
        metadata: {
          ...discoveryStep.metadata,
          gates: [{
            stage: "post",
            approvalProfile: { mode: "standard", risk: "medium" },
            title: "Restart review discovery output",
            reason: "Review Product Discovery output before restart recovery continues.",
            requiredForStatuses: ["succeeded"],
          }],
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const gatedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "waiting_for_approval");
    assert.equal(gatedStep.metadata.activeGateStage, "post");
    assert.ok(gatedStep.metadata.postStepApprovalId);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(discoveryStep.id)}`);
    assert.equal(pending.approvals.length, 1);
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Discovery output approved before daemon restart.",
    });

    await daemon.close();
    daemon = await startDaemonForTest(runner);

    const resumedTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(resumedTick.status, "started");
    assert.equal(resumedTick.workflowStep.metadata.templateStepId, "product-review");
    const discoveryAfterRestart = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "succeeded");
    assert.equal(discoveryAfterRestart.metadata.activeGateStage, undefined);
    assert.ok(discoveryAfterRestart.metadata.outputArtifactId);
    await waitForCondition(() => runner.runs.length >= 2, "post-gate restart downstream runner start");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow run cancellation follows default policy and blocks for user", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-cancellation-policy-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Cancellation policy workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Cancel a running workflow step and block for repair.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    assert.equal(firstTick.workflowStep.metadata.templateStepId, "product-discovery");
    assert.ok(firstTick.runId);
    await waitForCondition(() => runner.runs.length === 1, "workflow runner start before run cancellation");

    const cancelled = await postJson(`${daemon.url}/runs/${encodeURIComponent(firstTick.runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Cancellation policy regression.",
    });
    assert.equal(cancelled.cancelled, true);
    const reconciled = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reconciled.status, "blocked");
    assert.match(reconciled.blocker, /cancelled/i);
    const blockedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, firstTick.workflowStep.id, "blocked");
    assert.equal(blockedStep.metadata.policy.onRunCancelled, "block_for_user");
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
  } finally {
    runner.resolve("late completion after cancellation");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow approval denial follows onApprovalDenied policy and blocks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-approval-denial-policy-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Approval denial policy workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Deny a pre-step approval and block for user decision.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    await waitForCondition(() => runner.runs.length === 4, "planning and review steps before approval denial");
    const implementationStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "waiting_for_approval");
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(implementationStep.id)}`);
    assert.equal(pending.approvals.length, 1);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Implementation plan needs revision.",
    });
    const blockedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "blocked");
    assert.equal(blockedStep.metadata.policy.onApprovalDenied, "block_for_user");
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
    assert.equal(workflow.workflow.blocker, undefined);
    const deniedTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(deniedTick.status, "blocked");
    assert.equal(deniedTick.workflowStep.id, implementationStep.id);
    assert.match(deniedTick.blocker, /revision/);
    assert.equal(runner.runs.length, 4);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow skipped optional step allows downstream steps to start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-skip-optional-"));
  const runner = new SelectiveFailingRunner(["Product Review"]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Skip optional workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Skip optional product review and continue downstream.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const productReview = compiled.workflowSteps.find((step) => step.metadata?.templateStepId === "product-review");
    assert.ok(productReview);
    store.updateChannelWorkflowStep(
      productReview.id,
      {
        metadata: {
          ...productReview.metadata,
          policy: {
            ...productReview.metadata.policy,
            onRunFailed: "skip_if_optional",
          },
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const skippedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "product-review", "skipped");
    assert.equal(skippedStep.metadata.policy.onRunFailed, "skip_if_optional");
    const downstreamTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(downstreamTick.status, "started");
    assert.equal(downstreamTick.workflowStep.metadata.templateStepId, "design-review");
    await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "design-review", "succeeded");
    await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "engineering-review", "succeeded");
    assert.equal(runner.runs.some((run) => run.task.title === "Design Review"), true);
    assert.equal(runner.runs.some((run) => run.task.title === "Engineering Review"), true);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "waiting_for_approval");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow orchestrator starts independent parallel branches within channel budget", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-parallel-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Parallel workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Parallel branches",
      objective: "Run independent read-only branch steps.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    const firstStep = createParallelWorkflowStep(store, workflow.id, "Branch A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    const secondStep = createParallelWorkflowStep(store, workflow.id, "Branch B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    const thirdStep = createParallelWorkflowStep(store, workflow.id, "Branch C", {
      branchGroupId: "branch-c",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 2);
    assert.equal(tick.schedulingDecision.effectiveMode, "parallel");
    assert.equal(tick.schedulingDecision.parallelLimit, 2);
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "read_only_parallel_allowed"]);
    assert.deepEqual(tick.startedSteps.map((item) => item.workflowStep.id).sort(), [firstStep.id, secondStep.id].sort());
    assert.deepEqual(tick.schedulingDecision.queuedStepIds, [thirdStep.id]);
    await runner.waitUntilStarted(2);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["queued", "running", "running"]);
  } finally {
    try {
      runner.resolveAll("parallel cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "parallel cleanup");
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("custom workflow template compiles deterministic steps and dependencies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Custom template",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a custom deterministic workflow.",
      providerPresetId: "provider_static",
      runnerId: "pi",
      customTemplate: customTemplate({
        id: "custom-safe-template",
        name: "Custom Safe Template",
        maxParallelSteps: 2,
        steps: [
          {
            id: "research",
            name: "Research",
            prompt: "Research the problem.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "planning",
          },
          {
            id: "qa",
            name: "QA",
            prompt: "Verify the result.",
            teammateTemplateId: "designer",
            skillId: "plan-design-review",
            dependsOn: ["research"],
            joinGroupId: "review",
            dependencyMode: "all_succeeded",
          },
        ],
      }),
    });

    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflow.title, "Custom Safe Template");
    assert.equal(compiled.workflowSteps.length, 2);
    assert.equal(compiled.workflowSteps[0].metadata.workflowTemplateId, "custom-safe-template");
    assert.equal(compiled.workflowSteps[0].metadata.templateVersion, "custom:1");
    assert.equal(compiled.workflowSteps[0].metadata.autoStart, false);
    assert.equal(compiled.workflowSteps[0].metadata.maxParallelSiblings, 2);
    assert.equal(compiled.workflowSteps[0].toParticipantId, "teammate_builtin_architect");
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds[0], compiled.workflowSteps[0].id);
    assert.equal(compiled.workflowSteps[1].metadata.joinGroupId, "review");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow councilSlotKey resolves through attached AI council specialists", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-council-slot-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Council slot workflow");
    const developmentCouncilId = "council_builtin_development";
    await putJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });

    const customCompiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a council-backed custom template.",
      customTemplate: customTemplate({
        id: "council-slot-template",
        name: "Council Slot Template",
        steps: [
          {
            id: "implementation",
            name: "Implementation",
            prompt: "Implement the slice.",
            councilSlotKey: "engineer",
            skillId: "implement",
          },
        ],
      }),
    });

    const customStep = customCompiled.workflowSteps[0];
    assert.equal(customStep.toParticipantId, "teammate_builtin_engineer");
    assert.equal(customStep.metadata.councilSlotKey, "engineer");
    assert.equal(customStep.metadata.proposalStepSources[0].kind, "council");
    assert.equal(customStep.metadata.proposalStepSources[0].councilId, developmentCouncilId);
    assert.equal(customStep.metadata.proposalStepSources[0].slotKey, "engineer");

    const graphCompiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a council-backed workflow graph.",
      workflowGraph: {
        schemaVersion: 1,
        id: "council_slot_graph",
        name: "Council Slot Graph",
        entryNodeId: "review",
        nodes: [
          {
            id: "review",
            kind: "step",
            name: "Review",
            prompt: "Review the plan.",
            councilSlotKey: "architect",
            skillId: "plan-eng-review",
          },
        ],
        edges: [],
        termination: {
          success: "all_required_succeeded",
          onFailedRequiredNode: "fail_workflow",
          onApprovalDenied: "block_for_user",
        },
        maxParallelSteps: 1,
      },
    });

    const graphStep = graphCompiled.workflowSteps[0];
    assert.equal(graphStep.toParticipantId, "teammate_builtin_architect");
    assert.equal(graphStep.metadata.councilSlotKey, "architect");
    assert.equal(graphStep.metadata.proposalStepSources[0].kind, "council");
    assert.equal(graphStep.metadata.proposalStepSources[0].councilId, developmentCouncilId);
    assert.equal(graphStep.metadata.proposalStepSources[0].slotKey, "architect");

    const missingSlot = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject missing council slot.",
        customTemplate: customTemplate({
          id: "missing-council-slot-template",
          name: "Missing Council Slot Template",
          steps: [
            {
              id: "missing",
              name: "Missing",
              prompt: "Use a missing slot.",
              councilSlotKey: "missing-slot",
            },
          ],
        }),
      }),
    });
    assert.equal(missingSlot.status, 400);
    assert.match((await missingSlot.json()).message, /No effective AI council member found/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template rejects cycles and unknown runners at compile time", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-invalid-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const cyclic = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject cycles.",
        customTemplate: customTemplate({
          id: "cycle-template",
          name: "Cycle Template",
          steps: [
            { id: "a", name: "A", prompt: "A", teammateTemplateId: "architect", dependsOn: ["b"] },
            { id: "b", name: "B", prompt: "B", teammateTemplateId: "architect", dependsOn: ["a"] },
          ],
        }),
      }),
    });
    assert.equal(cyclic.status, 400);
    assert.equal((await cyclic.json()).error, "bad_request");

    const unknownRunner = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject unknown runner.",
        customTemplate: customTemplate({
          id: "unknown-runner-template",
          name: "Unknown Runner Template",
          steps: [
            { id: "a", name: "A", prompt: "A", teammateTemplateId: "architect", requestedRunnerId: "missing-runner" },
          ],
        }),
      }),
    });
    assert.equal(unknownRunner.status, 400);
    assert.match((await unknownRunner.json()).message, /not registered|missing-runner/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template unsafe autostart requires explicit confirmation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-autostart-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Unsafe custom template");
    const body = {
      objective: "Unsafe autostart.",
      autoStart: true,
      customTemplate: customTemplate({
        id: "unsafe-template",
        name: "Unsafe Template",
        steps: [
          {
            id: "implement",
            name: "Implement",
            prompt: "Implement changes.",
            teammateTemplateId: "engineer",
            skillId: "implement",
          },
        ],
      }),
    };

    const rejected = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /confirmUnsafeAutoStart/);

    const accepted = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      ...body,
      confirmUnsafeAutoStart: true,
    });
    assert.equal(accepted.workflowSteps[0].metadata.autoStart, true);
    assert.equal(accepted.workflowSteps[0].metadata.skillId, "implement");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template parallel branches start within compiled budget", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-parallel-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Custom parallel template",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read", "grep", "find", "ls"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Run custom parallel branches.",
      providerPresetId: provider.id,
      autoStart: true,
      customTemplate: customTemplate({
        id: "custom-parallel",
        name: "Custom Parallel",
        maxParallelSteps: 2,
        steps: [
          {
            id: "branch-a",
            name: "Branch A",
            prompt: "Read branch A.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "a",
          },
          {
            id: "branch-b",
            name: "Branch B",
            prompt: "Read branch B.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "b",
          },
        ],
      }),
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 2);
    cleanupWorkflowId = compiled.workflow.id;
    await runner.waitUntilStarted(2);
    assert.deepEqual(runner.runs.map((run) => run.task.title).sort(), ["Branch A", "Branch B"]);
  } finally {
    try {
      runner.resolveAll("custom parallel cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "custom parallel cleanup");
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow orchestrator keeps serial behavior when smart scheduling max runs is one", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-serial-budget-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Serial budget workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      name: channel.name,
      status: channel.status,
      boundPath: channel.boundPath,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: channel.defaultTeammateId,
      allowedTools: ["read"],
      runtimePolicy: channel.runtimePolicy,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Serial branches",
      objective: "Keep default single-start behavior.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Serial A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    createParallelWorkflowStep(store, workflow.id, "Serial B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "max_concurrent_runs_one"]);
    cleanupWorkflowId = workflow.id;
    await runner.waitUntilStarted(1);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["queued", "running"]);
  } finally {
    try {
      runner.resolveAll("serial cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "serial cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling keeps side-effectful branches serial", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-write-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart write workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Write branches",
      objective: "Keep write branches serial.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Write A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      requiredTools: ["write"],
    });
    createParallelWorkflowStep(store, workflow.id, "Write B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      requiredTools: ["write"],
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "side_effectful_step_serial"]);
    await runner.waitUntilStarted(1);
  } finally {
    try {
      runner.resolveAll("write cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "write cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling keeps unknown-tool branches serial", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-unknown-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart unknown workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Unknown branches",
      objective: "Keep unknown tools serial.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Unknown A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      omitRequiredTools: true,
    });
    createParallelWorkflowStep(store, workflow.id, "Unknown B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      omitRequiredTools: true,
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.equal(tick.schedulingDecision.safetyEvidence, "unknown");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "unknown_tools_serial"]);
    await runner.waitUntilStarted(1);
  } finally {
    try {
      runner.resolveAll("unknown cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "unknown cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling does not start sibling branches while approval is pending", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-approval-"));
  const runner = new ParallelDelayedRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart approval workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Approval branches",
      objective: "Wait for approval before siblings.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Approval A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      approvalGate: { mode: "standard", risk: "medium" },
    });
    createParallelWorkflowStep(store, workflow.id, "Approval B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "waiting_for_approval");
    assert.equal(tick.waitingApprovals.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "approval_pending"]);
    assert.equal(runner.runs.length, 0);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(steps.workflowSteps.filter((step) => step.status === "waiting_for_approval").length, 1);
    assert.equal(steps.workflowSteps.filter((step) => step.status === "queued").length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow dependencyMode any_succeeded can start a fan-in after mixed terminal branches", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-any-succeeded-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Any succeeded workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Fan-in",
      objective: "Start when one dependency succeeded.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const succeeded = createParallelWorkflowStep(store, workflow.id, "Succeeded branch", {
      branchGroupId: "branch-a",
      providerPresetId: provider.id,
      status: "succeeded",
    });
    const failed = createParallelWorkflowStep(store, workflow.id, "Failed branch", {
      branchGroupId: "branch-b",
      providerPresetId: provider.id,
      status: "failed",
    });
    const fanIn = createParallelWorkflowStep(store, workflow.id, "Fan-in", {
      branchGroupId: "join",
      joinGroupId: "join-main",
      providerPresetId: provider.id,
      dependsOnStepIds: [succeeded.id, failed.id],
      dependencyMode: "any_succeeded",
      maxParallelSiblings: 2,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, fanIn.id);
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].task.title, "Fan-in");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow fan-in creates summary artifact, memory candidate, selector decision, and evidence drilldown", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-fanin-evidence-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Fan-in evidence workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Fan-in evidence",
      objective: "Create auditable fan-in evidence.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const succeeded = createParallelWorkflowStep(store, workflow.id, "Succeeded Evidence Branch", {
      branchGroupId: "branch-a",
      providerPresetId: provider.id,
      status: "succeeded",
    });
    const failed = createParallelWorkflowStep(store, workflow.id, "Failed Evidence Branch", {
      branchGroupId: "branch-b",
      providerPresetId: provider.id,
      status: "failed",
    });
    const fanIn = createParallelWorkflowStep(store, workflow.id, "Fan-in Evidence", {
      branchGroupId: "join",
      joinGroupId: "join-evidence",
      providerPresetId: provider.id,
      dependsOnStepIds: [succeeded.id, failed.id],
      dependencyMode: "any_succeeded",
      maxParallelSiblings: 2,
      fanInPolicy: {
        mode: "memory_candidates",
        requireAllBranchesTerminal: true,
        includeFailedBranches: true,
        createSummaryArtifact: true,
        createMemoryCandidates: true,
        memoryCandidateScope: "channel",
        maxInputArtifacts: 8,
      },
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, fanIn.id);
    const completedFanIn = await waitForWorkflowStepStatus(daemon.url, cwd, workflow.id, fanIn.id, "succeeded");
    assert.ok(completedFanIn.metadata.selectorDecisionIds.length > 0);
    assert.ok(completedFanIn.metadata.outputArtifactId);
    assert.ok(completedFanIn.metadata.fanInSummaryArtifactId);
    assert.equal(completedFanIn.metadata.memoryCandidateIds.length, 1);

    const outputPacket = await getArtifactJson(daemon.url, cwd, completedFanIn.metadata.outputArtifactId);
    assert.equal(outputPacket.sourceRefs.some((ref) => ref.type === "workflow_selector_decision" && ref.id === completedFanIn.metadata.selectorDecisionIds[0]), true);

    const workflowEvidence = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflowEvidence.selectorDecisions.some((decision) => decision.id === completedFanIn.metadata.selectorDecisionIds[0] && decision.status === "accepted"), true);
    assert.equal(workflowEvidence.memoryCandidates.some((candidate) =>
      candidate.memory.id === completedFanIn.metadata.memoryCandidateIds[0] &&
      candidate.memory.reviewState === "candidate" &&
      candidate.memory.verifyBeforeUse === true &&
      candidate.sourceWorkflowStepIds.includes(completedFanIn.id)
    ), true);

    const stepEvidence = await getJson(`${daemon.url}/workflow-steps/${encodeURIComponent(completedFanIn.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(stepEvidence.workflowStep.step.id, completedFanIn.id);
    assert.equal(stepEvidence.selectorDecisions.length, 1);
    assert.equal(stepEvidence.memoryCandidates.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow cancel aborts active run, queued steps, and pending workflow approvals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-cancel-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Cancel workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Cancel the workflow.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    await waitForCondition(() => runner.runs.length === 1, "workflow runner start before cancel");

    const cancelled = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workflow.status, "cancelled");
    assert.equal(cancelled.cancelledRunIds.length, 1);
    assert.deepEqual(cancelled.workflowSteps.map((step) => step.status), Array(8).fill("cancelled"));

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(cancelled.cancelledRunIds[0])}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.status, "cancelled");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow step retry starts a blocked step after configuration is repaired", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-retry-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Retry workflow");
    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Retry a blocked workflow step.",
      createdBy: "local-user",
    });
    const blocked = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.workflowStep.metadata.templateStepId, "product-discovery");
    assert.match(blocked.blocker, /provider preset/i);

    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      defaultProviderPresetId: provider.id,
    });

    const retried = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(blocked.workflowStep.id)}/retry?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(retried.status, "started");
    assert.equal(retried.workflowStep.metadata.templateStepId, "product-discovery");
    await waitForCondition(() => runner.runs.length >= 1, "workflow retry runner start");
    assert.equal(runner.runs[0].task.title, "Product Discovery");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel link preview blocks localhost targets instead of fetching them", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-links-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const preview = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private",
    });
    assert.equal(preview.linkPreview.status, "blocked");
    assert.match(preview.linkPreview.errorMessage, /localhost/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AI teammate private workspace endpoints persist roster, setup, private messages, and activity", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-api-"));
  let daemon = await startDaemonForTest();
  try {
    const seeded = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(seeded.teammates.some((item) => item.id === "teammate_builtin_engineer"));

    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "custom",
      displayName: "Private Reviewer",
      description: "Reviews private workspace notes.",
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    });
    const teammateId = created.teammate.id;

    const memberships = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    assert.deepEqual(memberships.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);

    const skills = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "review", source: "user", enabled: true }],
    });
    assert.deepEqual(skills.bindings.map((item) => item.skillId), ["review"]);

    const memory = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      scopes: [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
    });
    assert.deepEqual(memory.scopes.map((item) => [item.kind, item.channelId ?? null, item.enabled]), [
      ["private-chat-summary", null, true],
      ["private-notes", null, true],
      ["channel-brief", channel.id, true],
      ["channel-decisions", channel.id, true],
    ]);
    const disabledMemory = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopes: [{ kind: "private-chat-summary", enabled: false }],
      }),
    });
    assert.equal(disabledMemory.status, 400);
    const disabledMemoryBody = await disabledMemory.json();
    assert.equal(disabledMemoryBody.error, "bad_request");
    assert.match(disabledMemoryBody.message, /memory is always enabled/i);

    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review private workspace",
      prompt: "Verify private chat state.",
      assigneeTeammateId: teammateId,
    })).task;
    const teammateTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(teammateTasks.tasks.map((item) => item.id), [task.id]);

    const initialDirectWorkspace = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initialDirectWorkspace.binding.status, "not_created");
    const createdDirectWorkspace = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(createdDirectWorkspace.binding.mode, "managed_worktree");
    assert.equal(createdDirectWorkspace.binding.status, "ready");
    assert.match(createdDirectWorkspace.snapshot.executionCwd, /\.ling-stack\/worktrees\/teammates\//);
    await access(createdDirectWorkspace.snapshot.executionCwd);

    const linkPreview = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private-note",
    });
    assert.equal(linkPreview.linkPreview.teammateId, teammateId);
    assert.equal(linkPreview.linkPreview.status, "blocked");
    const listedLinkPreviews = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-link-previews?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listedLinkPreviews.linkPreviews.map((item) => item.id), [linkPreview.linkPreview.id]);

    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please review this private workspace.",
      linkPreviewIds: [linkPreview.linkPreview.id],
      fileRefs: [{
        path: "README.md",
        label: "README.md",
        rootRelation: "inside_workspace",
        kind: "file",
        materializationStatus: "metadata_only",
      }],
      requestAiReply: true,
    });
    assert.equal(message.message.status, "ready");
    assert.deepEqual(message.message.linkPreviewIds, [linkPreview.linkPreview.id]);
    assert.equal(message.message.fileRefs[0].path, "README.md");
    assert.equal(message.aiReply.status, "blocked");
    assert.match(message.aiReply.errorMessage, /provider preset/i);

    const listedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);

    const activity = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/activity?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(activity.items.some((item) => item.kind === "direct-message" && item.sourceId === message.message.id));
    assert.ok(activity.items.some((item) => item.kind === "task" && item.sourceId === task.id));

    await daemon.close();
    daemon = await startDaemonForTest();

    const restartedRoster = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(restartedRoster.teammates.some((item) => item.id === teammateId && item.displayName === "Private Reviewer"));
    const restartedChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedChannels.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);
    const restartedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);
    const restartedTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedTasks.tasks.map((item) => item.id), [task.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AI teammate private reply waits for startup provider refresh instead of using stale timeout", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-provider-startup-refresh-"));
  await ensureGitRepo(cwd);
  const relay = await startMockOpenAICompatibleServer();
  const runner = new RecordingRunner();
  let daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "中转站",
      providerId: "relay",
      model: "relay-chat",
      api: "openai-completions",
      baseUrl: `${relay.url}/v1`,
      authHeader: true,
      apiKey: "local-relay-secret",
    })).provider;
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await daemon.close();

    const store = createSqliteRunStore(cwd);
    try {
      store.recordProviderCheckResult(provider.id, {
        ok: false,
        code: "network_failed",
        message: "Provider network check failed: The operation was aborted due to timeout",
        checkedAt: "2026-05-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }

    daemon = await startDaemonForTest(runner);
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "重启后直接发一条私聊。",
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.body, "Designer reply");
    assert.equal(runner.runs.length, 1);
    assert.equal(relay.requests.some((request) => request.method === "POST" && request.path === "/v1/chat/completions"), true);

    const refreshed = await getJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(refreshed.provider.lastCheck.ok, true);
    assert.equal(refreshed.provider.lastCheck.code, "ready");
  } finally {
    await daemon.close();
    await relay.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct messages default to latest page and load older history with cursor", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-message-pagination-"));
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_designer";
    const created = [];
    for (let index = 0; index < 106; index += 1) {
      const response = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
        body: `private message ${index + 1}`,
        requestAiReply: false,
      });
      created.push(response.message);
    }

    const latest = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(latest.messages.length, 100);
    assert.equal(latest.hasMore, true);
    assert.equal(latest.nextBeforeMessageId, created[6].id);
    assert.deepEqual(latest.messages.map((message) => message.id), created.slice(6).map((message) => message.id));

    const older = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}&beforeMessageId=${encodeURIComponent(latest.nextBeforeMessageId)}`);
    assert.equal(older.hasMore, false);
    assert.deepEqual(older.messages.map((message) => message.id), created.slice(0, 6).map((message) => message.id));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace settings API persists UI preferences in .ling-stack state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-settings-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initial = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.settings.schemaVersion, 1);
    assert.equal(initial.settings.workspaceCwd, undefined);
    assert.equal(initial.settings.lingConversationTone, undefined);
    assert.deepEqual(initial.settings.skillGovernancePolicy, {
      generationMode: "semi_auto",
      recordingMode: "user_initiated",
      invocationMode: "explicit_only",
      publishMode: "manual_review",
      bindMode: "manual_review",
    });

    const patched = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      workspaceCwd: cwd,
      theme: "dark",
      locale: "zh-CN",
      lingConversationTone: "friendly",
      defaultProviderPresetId: "provider_default_chat",
      channelNotifications: { channel_one: "mentions" },
      channelActivityViews: { channel_one: [{ id: "custom:review", name: "Review" }] },
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    assert.equal(patched.settings.workspaceCwd, cwd);
    assert.equal(patched.settings.theme, "dark");
    assert.equal(patched.settings.locale, "zh-CN");
    assert.equal(patched.settings.lingConversationTone, "friendly");
    assert.equal(patched.settings.defaultProviderPresetId, "provider_default_chat");
    assert.equal(patched.settings.channelNotifications.channel_one, "mentions");
    assert.equal(patched.settings.skillGovernancePolicy.generationMode, "approval_only");

    const reopened = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(reopened.settings.theme, "dark");
    assert.equal(reopened.settings.lingConversationTone, "friendly");
    assert.equal(reopened.settings.defaultProviderPresetId, "provider_default_chat");
    assert.equal(reopened.settings.channelActivityViews.channel_one[0].id, "custom:review");
    assert.equal(reopened.settings.skillGovernancePolicy.generationMode, "approval_only");

    const reset = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultProviderPresetId: null,
      lingConversationTone: null,
      skillGovernancePolicy: null,
    });
    assert.equal(reset.settings.defaultProviderPresetId, undefined);
    assert.equal(reset.settings.lingConversationTone, undefined);
    assert.equal(reset.settings.skillGovernancePolicy.generationMode, "semi_auto");

    const invalid = await fetch(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lingConversationTone: "verbose" }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /lingConversationTone must be friendly, pragmatic, none, or null/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel workspace API supports local and external path handoff", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-api-"));
  const externalPath = resolve(cwd, "external-workspace");
  const daemon = await startDaemonForTest();
  try {
    await mkdir(externalPath, { recursive: true });
    const channel = await createChannel(daemon.url, cwd);
    const initial = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.binding.mode, "managed_worktree");
    assert.equal(initial.binding.status, "ready");
    assert.equal(initial.binding.branchName, `ling/channel-${channel.id}`);
    assert.equal(initial.snapshot.workspaceCwd, cwd);
    assert.match(initial.snapshot.executionCwd, /\.ling-stack\/worktrees\/channels\//);
    await access(initial.snapshot.executionCwd);

    const external = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "external_path",
      executionPath: externalPath,
    });
    assert.equal(external.binding.mode, "external_path");
    assert.equal(external.binding.status, "ready");
    assert.equal(external.snapshot.executionCwd, externalPath);

    await rm(externalPath, { recursive: true, force: true });
    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "missing");

    const local = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    });
    assert.equal(local.binding.mode, "local");
    assert.equal(local.binding.status, "ready");
    assert.equal(local.snapshot.executionCwd, cwd);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation creates an isolated managed worktree by default", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-worktree-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);

    assert.equal(first.workspaceBinding?.mode, "managed_worktree");
    assert.equal(second.workspaceBinding?.mode, "managed_worktree");
    assert.equal(first.workspaceBinding?.status, "ready");
    assert.equal(second.workspaceBinding?.status, "ready");
    assert.equal(first.workspaceBinding?.branchName, `ling/channel-${first.id}`);
    assert.equal(second.workspaceBinding?.branchName, `ling/channel-${second.id}`);
    assert.notEqual(first.workspaceBinding?.worktreePath, second.workspaceBinding?.worktreePath);
    assert.match(first.workspaceBinding?.worktreePath ?? "", /\.ling-stack\/worktrees\/channels\//);
    await access(first.workspaceBinding?.worktreePath ?? "");
    await access(second.workspaceBinding?.worktreePath ?? "");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed channel and direct worktrees use resolved workspace worktrees directory", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-resolved-worktrees-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-resolved-worktrees-user-"));
  let workspacePaths;
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const paths = resolveStoragePaths(storeCwd, {
        userRootDir: userRoot,
        workspaceStateLocation: "user-data-dir",
      }).workspace;
      if (storeCwd === cwd) {
        workspacePaths = paths;
      }
      return createSqliteRunStore(storeCwd, paths);
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    assert.ok(workspacePaths);
    assert.equal(channel.workspaceBinding?.worktreePath?.startsWith(resolve(workspacePaths.worktreesDir, "channels")), true);
    await access(channel.workspaceBinding?.worktreePath ?? "");

    const teammateId = "teammate_builtin_engineer";
    const direct = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(direct.binding.worktreePath.startsWith(resolve(workspacePaths.worktreesDir, "teammates")), true);
    await access(direct.binding.worktreePath);

    await assert.rejects(() => access(resolve(cwd, ".ling-stack", "worktrees")), /ENOENT/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("channel workspace cleanup removes clean managed worktrees and keeps the binding recreatable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-worktree-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const worktreePath = channel.workspaceBinding?.worktreePath;
    assert.ok(worktreePath);
    await access(worktreePath);

    const cleaned = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cleaned.binding.mode, "managed_worktree");
    assert.equal(cleaned.binding.status, "not_created");
    assert.equal(cleaned.binding.worktreePath, worktreePath);
    await assert.rejects(() => access(worktreePath), /ENOENT/);

    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "not_created");

    const recreated = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(recreated.binding.worktreePath, worktreePath);
    await access(worktreePath);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel workspace cleanup refuses dirty managed worktrees without blocking refresh", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-worktree-dirty-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const worktreePath = channel.workspaceBinding?.worktreePath;
    assert.ok(worktreePath);
    await writeFile(resolve(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "worktree_dirty");
    assert.equal(body.binding.status, "ready");
    await access(resolve(worktreePath, "dirty.txt"));

    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "ready");
    assert.equal(refreshed.binding.errorMessage, undefined);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct teammate workspace cleanup removes clean managed worktrees and can recreate them", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-worktree-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    await ensureGitRepo(cwd);
    const teammateId = "teammate_builtin_engineer";
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    const worktreePath = created.binding.worktreePath;
    await access(worktreePath);

    const cleaned = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cleaned.binding.mode, "managed_worktree");
    assert.equal(cleaned.binding.status, "not_created");
    assert.equal(cleaned.binding.worktreePath, worktreePath);
    await assert.rejects(() => access(worktreePath), /ENOENT/);

    const recreated = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(recreated.binding.worktreePath, worktreePath);
    await access(worktreePath);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct teammate workspace cleanup refuses dirty managed worktrees", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-worktree-dirty-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    await ensureGitRepo(cwd);
    const teammateId = "teammate_builtin_engineer";
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    const worktreePath = created.binding.worktreePath;
    await writeFile(resolve(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "worktree_dirty");
    assert.equal(body.binding.status, "ready");
    await access(resolve(worktreePath, "dirty.txt"));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation uses local workspace binding when cwd is not a Git repository", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-worktree-nongit-"));
  const daemon = await startDaemonForTest();
  try {
    const response = await fetch(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Engineering",
        boundPath: cwd,
        allowedTools: ["read"],
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.channel.name, "Engineering");
    assert.equal(body.channel.boundPath, cwd);
    assert.equal(body.channel.workspaceBinding?.mode, "local");
    assert.equal(body.channel.workspaceBinding?.status, "ready");
    assert.equal(body.channel.workspaceBinding?.executionPath, cwd);
    assert.equal(body.channel.workspaceBinding?.worktreePath, undefined);

    const listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channels.length, 1);
    assert.equal(listed.channels[0].id, body.channel.id);
    assert.equal(listed.channels[0].workspaceBinding?.mode, "local");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory API scopes lexical recall and channel replies audit used memory", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const otherChannel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(check.ok, true);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const channelMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Model Workbench width",
      body: "Model Workbench should use the same horizontal width as other pages.",
      tags: ["model-workbench"],
    })).memory;
    const teammateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_designer",
      title: "Designer private width preference",
      body: "Designer private memory says Model Workbench width should stay aligned.",
      sensitivity: "private",
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_engineer",
      title: "Engineer private width preference",
      body: "Engineer private memory also mentions Model Workbench width.",
      sensitivity: "private",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: otherChannel.id,
      title: "Other channel width",
      body: "Other channel also mentions Model Workbench width.",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Secret memory",
      body: "Secret-adjacent Model Workbench token.",
      sensitivity: "secret-adjacent",
    });

    const listed = await getJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.vectorRetrieval.status, "not_installed");
    assert.equal(listed.vectorRetrieval.optional, true);

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_designer",
      channelId: channel.id,
      intent: "channel-reply",
      query: "model workbench width",
    });
    assert.ok(recall.memories.some((item) => item.memory.id === channelMemory.id));
    assert.ok(recall.memories.some((item) => item.memory.id === teammateMemory.id));
    assert.equal(recall.memories.some((item) => item.memory.ownerId === otherChannel.id), false);
    assert.equal(recall.memories.some((item) => item.memory.ownerId === "teammate_builtin_engineer"), false);
    assert.equal(recall.memories.some((item) => item.memory.sensitivity === "secret-adjacent"), false);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer fix Model Workbench width",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.aiReply.status, "pending");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.match(runner.runs[0].systemPrompt, /Used memory:/);
    assert.match(runner.runs[0].systemPrompt, /Model Workbench width/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Designer private memory says/);

    const used = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&responseId=${encodeURIComponent(created.aiReply.id)}`);
    assert.ok(used.events[0].memoryIds.includes(channelMemory.id));
    assert.equal(used.events[0].memoryIds.includes(teammateMemory.id), false);
    assert.match(used.events[0].policyVersion, /memory_use_isolation_v1/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory review policy exposes promotion inbox and gates candidate recall", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-review-policy-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);

    const defaultPolicy = await getJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(defaultPolicy.policy.mode, "balanced");
    assert.equal(defaultPolicy.policy.requireManualForWorkspace, true);

    const patchedPolicy = await patchJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`, {
      mode: "conservative",
      autoActiveSameScope: false,
    });
    assert.equal(patchedPolicy.policy.mode, "conservative");
    assert.equal(patchedPolicy.policy.autoActiveSameScope, false);

    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Review gated memory",
      body: "Review gated memory should only be recalled after approval.",
      reviewState: "candidate",
      sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Reflection job" }],
    })).memory;

    const blockedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(blockedRecall.memories.some((item) => item.memory.id === candidate.id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === candidate.id), true);
    const inboxItem = inbox.items.find((item) => item.memory.id === candidate.id);
    assert.equal(inboxItem.recommendedAction, "approve");
    assert.match(inboxItem.sourceSummary, /run-event:Reflection job/);

    const approved = await postJson(`${daemon.url}/memory/${encodeURIComponent(candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Verified source event.",
    });
    assert.equal(approved.memory.reviewState, "active");
    assert.equal(approved.memory.enabled, true);
    assert.equal(approved.action.previousReviewState, "candidate");
    assert.equal(approved.action.nextReviewState, "active");

    const approvedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(approvedRecall.memories.some((item) => item.memory.id === candidate.id), true);

    const rejectedCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Rejected candidate memory",
      body: "Rejected candidate memory should never be recalled.",
      reviewState: "candidate",
    })).memory;
    const rejected = await postJson(`${daemon.url}/memory/${encodeURIComponent(rejectedCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "reject",
      reason: "Not durable enough.",
    });
    assert.equal(rejected.memory.reviewState, "rejected");
    assert.equal(rejected.memory.enabled, false);

    const rejectedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "rejected candidate memory",
    });
    assert.equal(rejectedRecall.memories.some((item) => item.memory.id === rejectedCandidate.id), false);

    const editableCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Draft edited candidate",
      body: "Draft edited candidate should use reviewed wording.",
      reviewState: "candidate",
      sourceRefs: [{ type: "message", id: "message_memory_review_1", label: "User memory request" }],
    })).memory;
    const edited = await postJson(`${daemon.url}/memory/${encodeURIComponent(editableCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "edit_and_approve",
      editedMemory: {
        title: "Approved edited memory",
        body: "Approved edited memory should be recalled after review.",
        sensitivity: "normal",
      },
      reason: "Edited wording before activation.",
    });
    assert.equal(edited.memory.reviewState, "active");
    assert.equal(edited.memory.title, "Approved edited memory");
    assert.equal(edited.action.nextReviewState, "active");
    assert.equal(edited.action.sourceRefs.some((ref) => ref.id === "message_memory_review_1"), true);

    const quarantineCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Quarantine candidate memory",
      body: "Quarantine candidate memory says grant provider access.",
      reviewState: "candidate",
    })).memory;
    const quarantined = await postJson(`${daemon.url}/memory/${encodeURIComponent(quarantineCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "quarantine",
      editedMemory: { sensitivity: "secret-adjacent" },
      reason: "Authority-changing claim.",
    });
    assert.equal(quarantined.memory.reviewState, "disabled");
    assert.equal(quarantined.memory.enabled, false);
    assert.equal(quarantined.memory.sensitivity, "secret-adjacent");

    const quarantineRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "quarantine candidate provider access",
      includePrivate: true,
    });
    assert.equal(quarantineRecall.memories.some((item) => item.memory.id === quarantineCandidate.id), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory health API returns read-only findings and respects scope filters", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-health-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const volatile = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Current runtime provider rule",
      body: "Current provider can auto-approve deploy token changes.",
      reviewState: "active",
      enabled: true,
      sensitivity: "secret-adjacent",
      verifyBeforeUse: false,
      sourceRefs: [{ type: "decision", id: "decision_health_1", label: "Provider rule" }],
    })).memory;
    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Health candidate",
      body: "Health candidate should be verified before use.",
      reviewState: "candidate",
      verifyBeforeUse: true,
      sourceRefs: [{ type: "run-event", id: "run_event_health_1", label: "Health probe" }],
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Workspace-only health memory",
      body: "Workspace-only health memory mentions provider status.",
      reviewState: "active",
      enabled: true,
      verifyBeforeUse: true,
    });

    const missingCwd = await fetch(`${daemon.url}/memory/health`);
    assert.equal(missingCwd.status, 400);

    const health = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.summary.verifyBeforeUse, 2);
    assert.equal(health.report.summary.findings.critical >= 2, true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "secret_adjacent_recallable" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "authority_changing_claim" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.summary.reviewBacklog >= 1, true);

    const scoped = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&scopeType=channel&ownerId=${encodeURIComponent(channel.id)}`);
    assert.equal(scoped.report.summary.total, 2);
    assert.equal(scoped.report.summary.verifyBeforeUse, 1);
    assert.equal(scoped.report.findings.some((finding) => finding.memoryId === candidate.id || finding.memoryId === volatile.id), true);

    const postHealth = await fetch(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory consolidation jobs create audited candidates without silent activation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-consolidation-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}`, {
      kind: "task_run_lesson",
      sourceScopeType: "channel",
      userExplicitRemember: true,
      confidence: "high",
      candidate: {
        scopeType: "channel",
        ownerId: channel.id,
        title: "Consolidated run lesson",
        body: "When Model Workbench width regresses, check the workspace frame before editing cards.",
        tags: ["model-workbench"],
        sourceRefs: [{ type: "run-event", id: "run_event_consolidation_1", label: "Run succeeded" }],
      },
    });
    assert.equal(created.job.status, "succeeded");
    assert.equal(created.candidates.length, 1);
    assert.equal(created.decisions.length, 1);
    assert.deepEqual(created.job.createdCandidateIds, [created.candidates[0].id]);
    assert.equal(created.candidates[0].reviewState, "candidate");
    assert.equal(created.candidates[0].enabled, true);
    assert.equal(created.decisions[0].outcome, "auto-candidate");
    assert.equal(created.decisions[0].reasonCode, "consolidation_candidate_only");

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "consolidated run lesson model workbench width",
    });
    assert.equal(recall.memories.some((item) => item.memory.id === created.candidates[0].id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === created.candidates[0].id), true);

    const listed = await getJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}&status=succeeded`);
    assert.equal(listed.jobs.some((job) => job.id === created.job.id), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run validates requestedSkillId and records the selected skill", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-aware-run-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Implement skill-aware run",
      prompt: "Use the implement skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
      requestedSkillId: "implement",
    })).task;
    const store = stores.get(cwd);
    assert.ok(store);
    store.upsertSkillSourceSnapshot({
      id: "skill_source_implement_runtime",
      skillId: "implement",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-implement/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.3.0",
      upstreamSkillPath: "gstack-implement/SKILL.md",
      sourceChecksum: "sha256:implement-runtime",
      rawSkillMarkdown: "---\nname: implement\n---\n# Full Implement Skill\nUse full source details.",
      referencedFiles: [{
        path: "references/plan.md",
        kind: "reference",
        checksum: "sha256:ref",
        sizeBytes: 12,
        includedInSnapshot: false,
      }],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");
    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.selectedSkillId, "implement");
    assert.equal(runner.runs[0].tools.includes("edit"), true);
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Implement only the approved slice/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Selected Skill Source Snapshot/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /# Full Implement Skill/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /does not grant tools/.test(line)));
    const skillSourceContext = run.requestSnapshot.skillSourceContext;
    assert.equal(skillSourceContext.runtimeViewKind, "original_source");
    assert.equal(skillSourceContext.optimizationMode, "no_operation");
    assert.equal(skillSourceContext.compiledViewId, undefined);
    assert.equal(skillSourceContext.snapshotId, "skill_source_implement_runtime");
    assert.equal(skillSourceContext.sourceChecksum, "sha256:implement-runtime");
    assert.equal(skillSourceContext.includedRefs.some((ref) => ref.sourceRef === "skill-source:skill_source_implement_runtime:rawSkillMarkdown"), true);
    assert.equal(skillSourceContext.deferredRefs.some((ref) => ref.sourceRef === "skill-source-file:references/plan.md"), true);
    const runCreated = store.listEvents(runId).find((event) => event.type === "run_created");
    assert.equal(runCreated?.data.skillSourceContext.runtimeViewKind, "original_source");
    assert.equal(runCreated?.data.skillSourceContext.snapshotId, "skill_source_implement_runtime");
    assert.equal(runCreated?.data.skillSourceContext.sourceChecksum, "sha256:implement-runtime");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run records compiled skill context fallback plan on missing lazy reference failure", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-runtime-fallback-"));
  const runner = new ScriptedRunner([new Error("missing reference lazy_examples")]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Implement with compiled skill context",
      prompt: "Use the implement skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
      requestedSkillId: "implement",
    })).task;
    const store = stores.get(cwd);
    assert.ok(store);
    store.upsertSkillSourceSnapshot({
      id: "skill_source_implement_runtime_compiled",
      skillId: "implement",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-implement/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.3.0",
      upstreamSkillPath: "gstack-implement/SKILL.md",
      sourceChecksum: "sha256:implement-runtime-compiled",
      rawSkillMarkdown: "---\nname: implement\n---\n# Full Implement Skill\nUse full source details.\n# Examples\nLong examples.",
      referencedFiles: [],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");
    store.upsertSkillCompiledRuntimeView({
      view: {
        id: "skill_compiled_implement_runtime",
        skillId: "implement",
        sourceSnapshotId: "skill_source_implement_runtime_compiled",
        createdAt: "2026-06-22T00:01:00.000Z",
        compilerVersion: "test",
        coreRulesMarkdown: "Use compact implement rules.",
        lazyReferences: [{
          id: "lazy_examples",
          title: "Implementation examples",
          kind: "example",
          sourceRef: "SKILL.md#examples",
          summary: "Examples stay lazy until retry.",
          tokenEstimate: 8,
          loadPolicy: "on_retry",
        }],
        sourceMap: [{
          compiledRef: "coreRulesMarkdown",
          sourceRef: "SKILL.md#workflow",
          rationale: "Core workflow remains included.",
        }],
        tokenEstimate: 15,
        fallbackPolicy: "original_on_error",
      },
      authorityBoundary: {
        requiredToolsChanged: false,
        requiredProviderCapabilitiesChanged: false,
        approvalProfileChanged: false,
        teammateBindingsChanged: false,
      },
    }, "2026-06-22T00:02:00.000Z");

    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
      skillOptimizationMode: "auto_runtime_experimental",
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);

    assert.equal(run.status, "failed");
    assert.equal(run.requestSnapshot.skillSourceContext.runtimeViewKind, "compiled_view");
    assert.equal(run.requestSnapshot.skillSourceContext.compiledViewId, "skill_compiled_implement_runtime");
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Selected Skill Compiled Runtime View/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Available Skill References/.test(line)));
    const runError = store.listEvents(runId).find((event) => event.type === "run_error");
    assert.equal(runError?.data.skillContextFallback.reasonCode, "compiled_missing_reference");
    assert.equal(runError?.data.skillContextFallback.retryRuntimeViewKind, "original_source");
    assert.deepEqual(runError?.data.skillContextFallback.matchedRefIds, ["lazy_examples"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run materializes linked channel attachments into runner prompt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-task-attachment-run-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Slash task attachment body", "utf8").toString("base64"),
    })).attachment;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review attached brief",
      prompt: "Review the attached brief.",
      attachmentIds: [attachment.id],
    })).task;
    assert.deepEqual(task.attachmentIds, [attachment.id]);

    await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });

    assert.equal(runner.runs.length, 1);
    const prompt = runner.runs[0].task.prompt;
    assert.match(prompt, /Review the attached brief\./);
    assert.match(prompt, /Task attachments:/);
    assert.match(prompt, /brief\.txt/);
    assert.match(prompt, /Slash task attachment body/);

    const durableTask = (await getJson(`${daemon.url}/tasks/${encodeURIComponent(task.id)}?cwd=${encodeURIComponent(cwd)}`)).task;
    assert.equal(durableTask.prompt, "Review the attached brief.");
    assert.deepEqual(durableTask.attachmentIds, [attachment.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill suggestions are visible recommendations and do not mutate run selection", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-suggestions-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "reasoning", "tool_call"] })).provider;
    const suggestions = await postJson(`${daemon.url}/skills/suggestions?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_engineer",
      channelId: channel.id,
      providerPresetId: provider.id,
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
      limit: 5,
    });
    assert.equal(suggestions.suggestions[0].skillId, "review");
    assert.equal(suggestions.suggestions[0].sourceRefs[0].type, "skill");

    const afterExplicitSelection = await postJson(`${daemon.url}/skills/suggestions?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_engineer",
      channelId: channel.id,
      providerPresetId: provider.id,
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
      requestedSkillId: "review",
    });
    assert.equal(afterExplicitSelection.suggestions.some((suggestion) => suggestion.skillId === "review"), false);

    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review pull request without explicit skill",
      prompt: "Find behavioral bugs and missing tests, but do not preselect a skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
    })).task;
    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.selectedSkillId ?? undefined, undefined);
    assert.equal((runner.runs[0].appendSystemPrompt ?? []).some((line) => /Find concrete issues first/.test(line)), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate persona draft import returns warnings without mutating durable teammate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-persona-draft-"));
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_engineer";
    const before = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    const draft = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/persona-draft?cwd=${encodeURIComponent(cwd)}`, {
      sourcePath: "AGENTS.md",
      content: "# Senior Engineer\n\nCan use bash tools and external-send secrets.",
    });
    assert.equal(draft.draft.sourceKind, "agents-md");
    assert.equal(draft.draft.displayName, "Senior Engineer");
    assert.ok(draft.draft.warnings.some((warning) => /cannot grant tools/i.test(warning)));
    const after = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    assert.equal(after.displayName, before.displayName);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill health API returns read-only registry findings", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-health-api-"));
  const daemon = await startDaemonForTest();
  try {
    const missingCwd = await fetch(`${daemon.url}/skills/health`);
    assert.equal(missingCwd.status, 400);

    const health = await getJson(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}&limit=5`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.workspaceId, "workspace_default");
    assert.equal(typeof health.report.generatedAt, "string");
    assert.equal(health.report.summary.totalSkills > 0, true);
    assert.equal(health.report.summary.activeSkills > 0, true);
    assert.equal(Array.isArray(health.report.findings), true);
    assert.equal(health.report.findings.length <= 5, true);

    const postHealth = await fetch(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill source API returns source health and published snapshots", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-source-api-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const initialHealth = await getJson(`${daemon.url}/skills/source-health?cwd=${encodeURIComponent(cwd)}&limit=3`);
    assert.equal(initialHealth.cwd, cwd);
    assert.equal(initialHealth.report.workspaceId, "workspace_default");
    assert.equal(initialHealth.report.summary.totalSkills > 0, true);
    assert.equal(initialHealth.report.summary.missingSourceSnapshots > 0, true);
    assert.equal(initialHealth.report.findings.length <= 3, true);

    const store = stores.get(cwd);
    assert.ok(store);
    const snapshot = store.upsertSkillSourceSnapshot({
      id: "skill_source_review_api",
      skillId: "review",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-review/SKILL.md",
      upstreamName: "review",
      upstreamVersion: "1.58.3.0",
      sourceChecksum: "sha256-review-api",
      rawSkillMarkdown: "---\nname: review\n---\n# Review\n",
      referencedFiles: [],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");

    const source = await getJson(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(source.cwd, cwd);
    assert.equal(source.snapshot.id, snapshot.id);
    assert.equal(source.snapshot.rawSkillMarkdown.includes("# Review"), true);

    const optimizationPreview = await postJson(`${daemon.url}/skills/review/optimization-preview?cwd=${encodeURIComponent(cwd)}`, {
      mode: "preview_on_demand",
    });
    assert.equal(optimizationPreview.cwd, cwd);
    assert.equal(optimizationPreview.preview.skillId, "review");
    assert.equal(optimizationPreview.preview.sourceSnapshotId, snapshot.id);
    assert.equal(optimizationPreview.preview.mode, "preview_on_demand");
    assert.ok(optimizationPreview.preview.compiledView);
    assert.equal(optimizationPreview.preview.authorityBoundary.requiredToolsChanged, false);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 1);

    const compiledCreate = await postJson(`${daemon.url}/skills/review/compiled-views?cwd=${encodeURIComponent(cwd)}`, {
      mode: "preview_on_demand",
    });
    assert.equal(compiledCreate.cwd, cwd);
    assert.equal(compiledCreate.view.skillId, "review");
    assert.equal(compiledCreate.view.sourceSnapshotId, snapshot.id);
    assert.equal(compiledCreate.view.reviewStatus, "active");
    assert.equal(compiledCreate.view.authorityBoundary.requiredToolsChanged, false);
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review" }).length, 1);

    const compiledList = await getJson(`${daemon.url}/skills/review/compiled-views?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(compiledList.views.length, 1);
    assert.equal(compiledList.views[0].id, compiledCreate.view.id);

    const archivedCompiled = await postJson(`${daemon.url}/skills/review/compiled-views/${encodeURIComponent(compiledCreate.view.id)}/archive?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(archivedCompiled.view.reviewStatus, "archived");
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review" }).length, 0);
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review", includeArchived: true }).length, 1);

    const postSource = await fetch(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postSource.status, 405);

    const archivedSourceResponse = await fetch(`${daemon.url}/skills/review/source/archive?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    assert.equal(archivedSourceResponse.status, 200);
    const archivedSource = await archivedSourceResponse.json();
    assert.equal(archivedSource.cwd, cwd);
    assert.equal(archivedSource.snapshot.id, snapshot.id);
    assert.equal(archivedSource.snapshot.reviewStatus, "archived");

    const missingPublishedSource = await fetch(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingPublishedSource.status, 404);

    const healthAfterArchive = await getJson(`${daemon.url}/skills/source-health?cwd=${encodeURIComponent(cwd)}&limit=3`);
    assert.equal(healthAfterArchive.report.summary.sourceBackedSkills, 0);
    assert.equal(healthAfterArchive.report.summary.missingSourceSnapshots > 0, true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gstack skill source sync previews and publishes selected snapshots only", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-source-sync-api-"));
  const skillRoot = resolve(cwd, "skills");
  const reviewSkill = resolve(skillRoot, "gstack-review");
  await mkdir(resolve(reviewSkill, "agents"), { recursive: true });
  await mkdir(resolve(reviewSkill, "references"), { recursive: true });
  await writeFile(resolve(reviewSkill, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review the current diff before landing.",
    "---",
    "# Review",
    "Use AskUserQuestion for one-way decisions.",
  ].join("\n"));
  await writeFile(resolve(reviewSkill, "agents", "openai.yaml"), [
    "interface:",
    "  display_name: gstack-review",
    "  short_description: Pre-landing review.",
    "policy:",
    "  allow_implicit_invocation: true",
  ].join("\n"));
  await writeFile(resolve(reviewSkill, "references", "checklist.md"), "# Checklist\n");

  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const syncBody = {
      roots: [{ rootPath: skillRoot, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.58.3.0" }],
      includeDetectedRoots: false,
      includeSkillIds: ["review"],
    };
    const preview = await postJson(`${daemon.url}/skills/sync/gstack/preview?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(preview.cwd, cwd);
    assert.equal(preview.preview.summary.totalRecords, 1);
    assert.equal(preview.preview.records[0].skillId, "review");
    assert.equal(preview.preview.records[0].state, "attachable");
    assert.equal(preview.preview.records[0].agentMetadata.displayName, "gstack-review");
    assert.equal(preview.preview.records[0].referencedFiles.some((file) => file.path === "references/checklist.md"), true);

    const store = stores.get(cwd);
    assert.ok(store);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
    const registryBefore = store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }).length;

    const refresh = await postJson(`${daemon.url}/skills/sync/gstack/refresh?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(refresh.cwd, cwd);
    assert.equal(refresh.preview.summary.totalRecords, 1);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);

    const published = await postJson(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      ...syncBody,
      selectedSkillIds: ["review"],
    });
    assert.equal(published.cwd, cwd);
    assert.equal(published.skills[0].id, "review");
    assert.equal(published.snapshots.length, 1);
    assert.equal(published.snapshots[0].skillId, "review");
    assert.equal(published.snapshots[0].reviewStatus, "published");
    assert.equal(published.snapshots[0].rawSkillMarkdown.includes("# Review"), true);
    assert.equal(store.listSkillSourceSnapshots({ reviewStatus: "published" }).length, 1);
    assert.equal(store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }).length, registryBefore);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gstack skill source sync requires confirmation before publishing new skills", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-source-sync-new-api-"));
  const skillRoot = resolve(cwd, "skills");
  const newSkill = resolve(skillRoot, "gstack-research-lab");
  await mkdir(newSkill, { recursive: true });
  await writeFile(resolve(newSkill, "SKILL.md"), [
    "---",
    "name: research-lab",
    "description: Research a local implementation question before coding.",
    "---",
    "# Research Lab",
  ].join("\n"));

  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const syncBody = {
      roots: [{ rootPath: skillRoot, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.58.3.0" }],
      includeDetectedRoots: false,
      includeSkillIds: ["research-lab"],
    };
    const preview = await postJson(`${daemon.url}/skills/sync/gstack/preview?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(preview.preview.records[0].skillId, "research-lab");
    assert.equal(preview.preview.records[0].state, "new");

    const rejected = await fetch(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...syncBody, selectedSkillIds: ["research-lab"] }),
    });
    assert.equal(rejected.status, 409);

    const published = await postJson(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      ...syncBody,
      selectedSkillIds: ["research-lab"],
      allowNewSkills: true,
    });
    assert.equal(published.skills[0].id, "research-lab");
    assert.equal(published.skills[0].source, "gstack");
    assert.equal(published.snapshots[0].skillId, "research-lab");

    const store = stores.get(cwd);
    assert.ok(store);
    assert.equal(store.getSkillRegistryEntry("research-lab").packId, "gstack-source-sync");
    assert.equal(store.getSkillSourceSnapshot("research-lab").reviewStatus, "published");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill candidate API persists manual candidates and gates review approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-candidate-api-"));
  const daemon = await startDaemonForTest();
  try {
    const payload = {
      id: "skill_candidate_api_manual",
      title: "Reusable release checklist",
      summary: "Capture the repeated release checklist as a reviewed candidate skill.",
      definition: {
        workflowPhase: "ship",
        positiveTriggers: ["repeated release checklist"],
        negativeTriggers: ["one-off release note"],
        procedureSteps: [{ title: "Collect release evidence", instruction: "Read linked run and approval evidence." }],
        validationSteps: [{ title: "Run skill health", commandOrCheck: "GET /skills/health", expectedResult: "No critical candidate findings." }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      sourceRefs: [{ type: "manual", id: "manual_release_note", label: "Manual release note" }],
    };
    const created = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, payload);
    assert.equal(created.candidate.id, payload.id);
    assert.equal(created.candidate.origin, "manual-draft");
    assert.equal(created.candidate.proposedAction, "create");
    assert.equal(created.candidate.status, "pending");
    assert.equal(created.candidate.duplicateAnalysis.decision, "no_overlap");

    const listed = await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&status=pending&origin=manual-draft&limit=10`);
    assert.deepEqual(listed.candidates.map((candidate) => candidate.id), [payload.id]);

    const detail = await getJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.candidate.id, payload.id);
    assert.deepEqual(detail.reviewRecords, []);

    const approved = await postJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve_for_draft",
      reason: "Manual validation is present.",
      actor: "system",
    });
    assert.equal(approved.candidate.status, "approved_for_draft");
    assert.equal(approved.action.actor, "user");
    assert.equal(approved.action.previousStatus, "pending");
    assert.equal(approved.action.nextStatus, "approved_for_draft");

    const reviewedDetail = await getJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(reviewedDetail.reviewRecords.length, 1);
    assert.equal(reviewedDetail.reviewRecords[0].action, "approve_for_draft");

    const draftResponse = await postJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(draftResponse.candidate.id, payload.id);
    assert.equal(draftResponse.draft.source, "custom");
    assert.equal(draftResponse.draft.sourcePath, `skill-candidates/${payload.id}`);
    assert.equal(draftResponse.draft.definitions[0].definition.id, "reusable-release-checklist");
    assert.match(draftResponse.draft.definitions[0].definition.promptFragments[0], /repeated release checklist/);

    const publishedDraft = await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draftResponse.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(publishedDraft.skills[0].id, "reusable-release-checklist");
    assert.equal(publishedDraft.skills[0].packId, "ling-generated");
    const listedSkills = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listedSkills.skills.some((skill) => skill.id === "reusable-release-checklist" && skill.source === "custom"));
    const draftEvents = await getJson(`${daemon.url}/skills/usage-events?cwd=${encodeURIComponent(cwd)}&candidateId=${encodeURIComponent(payload.id)}&limit=10`);
    assert.deepEqual(draftEvents.events.map((event) => event.kind).sort(), ["draft_created", "published"]);

    const correction = await postJson(`${daemon.url}/skills/reusable-release-checklist/corrections?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Correction evidence should be collected before release checklist validation.",
      candidateId: payload.id,
    });
    assert.equal(correction.event.kind, "user_corrected");
    assert.equal(correction.event.skillId, "reusable-release-checklist");
    await postJson(`${daemon.url}/skills/reusable-release-checklist/corrections?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Correction repeated for health finding.",
      candidateId: payload.id,
    });
    const usageStats = await getJson(`${daemon.url}/skills/usage-stats?cwd=${encodeURIComponent(cwd)}&skillId=reusable-release-checklist`);
    assert.equal(usageStats.stats[0].correctionCount, 2);

    const missingGate = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_candidate_missing_gate_api",
      title: "Weak candidate",
      summary: "Candidate without negative triggers cannot be approved.",
      definition: {
        workflowPhase: "operate",
        positiveTriggers: ["weak repeated operation"],
        negativeTriggers: [],
        procedureSteps: [{ title: "Read evidence" }],
        validationSteps: [{ title: "Manual check" }],
        requiredTools: [],
        requiredProviderCapabilities: [],
      },
      sourceRefs: [{ type: "manual", id: "manual_weak_note" }],
    });
    const pendingDraft = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(missingGate.candidate.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(pendingDraft.status, 400);
    assert.match(await pendingDraft.text(), /approved_for_draft/);

    const blocked = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(missingGate.candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_for_draft" }),
    });
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /negative triggers/);

    const health = await getJson(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}&limit=20`);
    assert.equal(health.report.summary.pendingCandidates, 2);
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "missing_negative_triggers" &&
      finding.candidateIds.includes(missingGate.candidate.id)
    ));
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "never_used_skill" &&
      finding.skillIds.includes("reusable-release-checklist")
    ));
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "high_user_correction_skill" &&
      finding.skillIds.includes("reusable-release-checklist")
    ));

    const duplicateConflict = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_candidate_duplicate_conflict_api",
      title: "Duplicate release checklist",
      summary: "A duplicate candidate that still needs conflict review.",
      status: "approved_for_draft",
      definition: {
        workflowPhase: "ship",
        positiveTriggers: ["release checklist"],
        negativeTriggers: ["one-off note"],
        procedureSteps: [{ title: "Read release evidence" }],
        validationSteps: [{ title: "Run health report" }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      duplicateAnalysis: {
        decision: "conflict_review",
        similarityScore: 0.8,
        matchedSkillIds: ["reusable-release-checklist"],
        matchedCandidateIds: [],
        triggerOverlap: ["release checklist"],
        conflictingFields: ["requiredTools"],
        rationale: "Existing release checklist skill overlaps with this candidate.",
      },
      sourceRefs: [{ type: "manual", id: "manual_duplicate_note" }],
    });
    const duplicateDraft = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(duplicateConflict.candidate.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(duplicateDraft.status, 400);
    assert.match(await duplicateDraft.text(), /conflict_review/);

    const missing = await fetch(`${daemon.url}/skill-candidates/missing_candidate?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("procedure observation API routes structured observations before candidate creation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-procedure-observation-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const observationPayload = {
      id: "procedure_observation_api_manual",
      source: "explicit_user_request",
      signals: ["save_as_skill"],
      title: "Reusable UI verification flow",
      summary: "Capture a repeated UI verification flow as a reviewed skill candidate.",
      normalizedGoal: "verify web ui change",
      positiveTriggers: ["web ui verification"],
      negativeTriggers: ["docs-only change"],
      procedureSteps: [{ title: "Run Web typecheck", instruction: "Run the Web typecheck.", requiredTools: ["bash"] }],
      validationSteps: [{ title: "Run Playwright smoke", commandOrCheck: "corepack pnpm --filter @ling-stack/web exec playwright test", expectedResult: "Relevant tests pass." }],
      sourceRefs: [{ type: "manual", id: "manual_ui_observation", label: "Manual UI observation" }],
      confidence: "high",
      reusableScore: 85,
    };

    const createdObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, observationPayload);
    assert.equal(createdObservation.observation.id, observationPayload.id);
    assert.equal(createdObservation.route.kind, "skill");
    assert.deepEqual(createdObservation.route.blockers, []);

    const listedObservations = await getJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}&routeKind=skill&limit=10`);
    assert.deepEqual(listedObservations.observations.map((item) => item.id), [observationPayload.id]);

    const playbookObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, {
      id: "procedure_observation_api_playbook",
      channelId: channel.id,
      source: "workflow_step_output",
      signals: ["long_successful_sequence"],
      title: "Channel workflow release playbook",
      summary: "A channel workflow produced a repeatable release playbook.",
      normalizedGoal: "channel release playbook",
      positiveTriggers: ["channel release workflow"],
      procedureSteps: [{ title: "Summarize release evidence", instruction: "Collect test, review, and rollout evidence.", requiredTools: ["read"] }],
      sourceRefs: [{ type: "run", id: "run_playbook_api", label: "Playbook run" }],
      confidence: "high",
      reusableScore: 79,
    });
    assert.equal(playbookObservation.route.kind, "playbook");
    assert.equal(playbookObservation.route.reasonCode, "channel_scoped_repeatable_playbook");

    const channelObservations = await getJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=playbook&limit=10`);
    assert.deepEqual(channelObservations.observations.map((item) => item.id), ["procedure_observation_api_playbook"]);

    const playbookClusters = await getJson(`${daemon.url}/procedure-observation-clusters?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=playbook&status=ready_for_review&limit=10`);
    assert.equal(playbookClusters.clusters.length, 1);
    assert.equal(playbookClusters.clusters[0].recommendedAction, "create_playbook_candidate");
    assert.equal(playbookClusters.clusters[0].channelId, channel.id);

    const clusterDetail = await getJson(`${daemon.url}/procedure-observation-clusters/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(clusterDetail.cluster.id, playbookClusters.clusters[0].id);
    assert.deepEqual(clusterDetail.observations.map((item) => item.id), ["procedure_observation_api_playbook"]);

    const playbookCandidateResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const playbookCandidateText = await playbookCandidateResponse.text();
    assert.equal(playbookCandidateResponse.status, 201, playbookCandidateText);
    const playbookCandidate = JSON.parse(playbookCandidateText);
    assert.equal(playbookCandidate.candidate.status, "draft");
    assert.equal(playbookCandidate.candidate.channelId, channel.id);
    assert.equal(playbookCandidate.candidate.title, "Channel workflow release playbook");
    assert.equal(playbookCandidate.candidate.procedureSteps.length, 1);
    assert.match(playbookCandidate.candidate.reason, /procedure observation cluster/);
    assert.deepEqual(playbookCandidate.candidate.sourceRefs.map((ref) => ref.type), ["run"]);

    const listedPlaybookCandidates = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates?cwd=${encodeURIComponent(cwd)}&status=draft&limit=10`);
    assert.equal(listedPlaybookCandidates.candidates.some((candidate) => candidate.id === playbookCandidate.candidate.id), true);

    const approvedPlaybookCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/${encodeURIComponent(playbookCandidate.candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Promote to channel playbook.",
    });
    assert.equal(approvedPlaybookCandidate.candidate.status, "active");
    assert.ok(approvedPlaybookCandidate.candidate.activatedAt);

    const duplicatePlaybookCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(duplicatePlaybookCandidate.candidate.id, playbookCandidate.candidate.id);
    assert.equal(duplicatePlaybookCandidate.candidate.status, "active");

    const canvas = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/canvas?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(canvas.protocol.channelId, channel.id);
    assert.equal(canvas.candidateClusters.some((cluster) => cluster.id === playbookClusters.clusters[0].id), true);
    assert.equal(canvas.sections.some((section) => section.kind === "candidate_clusters" && section.status === "needs_review"), true);

    const protocolSourceMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "This channel needs reviewer signoff before implementation handoff.",
    });
    const protocolSourceDecision = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      sourceMessageId: protocolSourceMessage.message.id,
      title: "Handoff review",
      decision: "Reviewer signoff is required before implementation handoff.",
      createdBy: "local-user",
    });
    const protocolObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, {
      id: "procedure_observation_api_protocol",
      channelId: channel.id,
      source: "multi_agent_handoff",
      signals: ["handoff_stabilized"],
      title: "Stable handoff review protocol",
      summary: "The channel repeatedly hands work from planner to engineer with reviewer signoff.",
      normalizedGoal: "review multi agent handoffs",
      positiveTriggers: ["planner to engineer handoff", "reviewer signoff"],
      negativeTriggers: ["single-agent task"],
      procedureSteps: [{ title: "Require review before implementation handoff", instruction: "Reviewer confirms the next agent has enough context.", requiredTools: ["read"] }],
      validationSteps: [{ title: "Confirm handoff context", commandOrCheck: "Review handoff packet source refs.", expectedResult: "The next agent receives a scoped packet." }],
      sourceRefs: [
        { type: "message", id: protocolSourceMessage.message.id, label: "Protocol source message" },
        { type: "decision", id: protocolSourceDecision.decision.id, label: "Protocol decision" },
      ],
      confidence: "high",
      reusableScore: 88,
    });
    assert.equal(protocolObservation.route.kind, "channel_protocol");
    assert.equal(protocolObservation.route.reasonCode, "multi_agent_handoff_protocol");

    const protocolClusters = await getJson(`${daemon.url}/procedure-observation-clusters?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=channel_protocol&status=ready_for_review&limit=10`);
    assert.equal(protocolClusters.clusters.length, 1);
    assert.equal(protocolClusters.clusters[0].recommendedAction, "create_channel_protocol_candidate");

    const protocolDraftResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const protocolDraftText = await protocolDraftResponse.text();
    assert.equal(protocolDraftResponse.status, 201, protocolDraftText);
    const protocolDraft = JSON.parse(protocolDraftText);
    assert.equal(protocolDraft.draft.status, "draft");
    assert.equal(protocolDraft.draft.channelId, channel.id);
    assert.equal(protocolDraft.draft.proposedPatch.reviewRules.length, 1);
    assert.match(protocolDraft.draft.proposedPatch.reviewRules[0], /Stable handoff review protocol/);
    assert.match(protocolDraft.draft.reason, /procedure observation cluster/);
    assert.deepEqual(protocolDraft.draft.sourceRefs.map((ref) => ref.type), ["message", "channel_decision"]);

    const manualProtocolDraft = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      proposedPatch: { reviewRules: ["Keep multi-agent handoffs reviewed before implementation."] },
      reason: "Reviewer promoted the ready cluster.",
    });
    assert.deepEqual(manualProtocolDraft.draft.proposedPatch.reviewRules, ["Keep multi-agent handoffs reviewed before implementation."]);
    assert.equal(manualProtocolDraft.draft.reason, "Reviewer promoted the ready cluster.");

    const canvasAfterDraft = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/canvas?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(canvasAfterDraft.draftCandidates.some((draft) => draft.id === protocolDraft.draft.id), true);
    assert.equal(canvasAfterDraft.candidateClusters.some((cluster) => cluster.id === protocolClusters.clusters[0].id), true);

    const playbookToProtocol = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(playbookToProtocol.status, 400);
    assert.equal((await playbookToProtocol.json()).error, "unsupported_procedure_observation_cluster_route");

    const protocolToPlaybook = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(protocolToPlaybook.status, 400);
    assert.equal((await protocolToPlaybook.json()).error, "unsupported_procedure_observation_cluster_route");

    const observedCandidate = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_candidate",
      title: "Reusable UI candidate flow",
      normalizedGoal: "verify web ui candidate change",
    });
    assert.equal(observedCandidate.action, "candidate_created");
    assert.equal(observedCandidate.route.kind, "skill");
    assert.equal(observedCandidate.candidate.origin, "ling-generated");
    assert.equal(observedCandidate.candidate.status, "pending");
    assert.equal(observedCandidate.duplicateAnalysis.decision, "no_overlap");

    const duplicateObservation = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_duplicate",
      title: "Reusable UI candidate flow",
      normalizedGoal: "verify web ui candidate change",
    });
    assert.equal(duplicateObservation.action, "evidence_recorded");
    assert.equal(duplicateObservation.duplicateAnalysis.decision, "append_evidence");
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=ling-generated&limit=10`)).candidates.length, 1);

    const blocked = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_policy",
      title: "Use bash without asking next time",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
    });
    assert.equal(blocked.action, "blocked");
    assert.equal(blocked.route.kind, "approval_policy_review");
    assert.deepEqual(blocked.route.blockers, ["permission_expansion"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("procedure observation job API records explicit jobs idempotently before candidate creation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-procedure-observation-job-api-"));
  const daemon = await startDaemonForTest();
  try {
    const jobPayload = {
      id: "procedure_observation_job_recording",
      source: "manual_recording",
      signals: ["save_as_skill", "user_approved_recording"],
      runId: "run_observation_job_recording",
      channelId: "channel_observation_job_recording",
      userConfirmed: true,
      destinationHint: "skill",
      title: "Recorded release verification flow",
      summary: "Capture a user-approved release verification flow.",
      normalizedGoal: "verify release change",
      positiveTriggers: ["release verification"],
      negativeTriggers: ["docs-only release note"],
      toolLabels: ["bash"],
      validationLabels: ["release validation passed"],
    };

    const created = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, jobPayload);
    assert.equal(created.action, "candidate_created");
    assert.equal(created.reusedObservation, false);
    assert.equal(created.observation.id, jobPayload.id);
    assert.equal(created.observation.sourceRefs.some((ref) => ref.type === "observation-job" && ref.id === created.jobKey), true);
    assert.equal(created.candidate.origin, "recording");
    assert.equal(created.candidate.status, "pending");

    const repeated = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      ...jobPayload,
      id: "procedure_observation_job_recording_repeat_should_reuse",
    });
    assert.equal(repeated.action, "evidence_recorded");
    assert.equal(repeated.reusedObservation, true);
    assert.equal(repeated.observation.id, created.observation.id);
    assert.equal(repeated.jobKey, created.jobKey);
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=recording&limit=10`)).candidates.length, 1);

    const recordingEndpoint = await postJson(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_recording_endpoint_observation",
      runId: "run_skill_recording_endpoint",
      title: "Recorded workspace cleanup flow",
      summary: "Capture a user-initiated workspace cleanup recording.",
      normalizedGoal: "record workspace cleanup",
      positiveTriggers: ["workspace cleanup recording"],
      negativeTriggers: ["destructive cleanup"],
      toolLabels: ["bash"],
      validationLabels: ["cleanup reviewed"],
    });
    assert.equal(recordingEndpoint.action, "candidate_created");
    assert.equal(recordingEndpoint.generationMode, "semi_auto");
    assert.equal(recordingEndpoint.recordingMode, "user_initiated");
    assert.equal(recordingEndpoint.candidate.origin, "recording");

    const evidenceOnly = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_success_only",
      userConfirmed: false,
      title: "Successful UI validation chain",
      summary: "Record a successful chain as evidence only.",
      normalizedGoal: "verify ui change",
      positiveTriggers: ["ui verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["web typecheck passed"],
    });
    assert.equal(evidenceOnly.action, "evidence_recorded");
    assert.equal(evidenceOnly.reusedObservation, false);
    assert.equal(evidenceOnly.candidate, undefined);

    const firstPostRun = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_post_run_one",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Successful regression verification chain",
      summary: "Record a successful regression verification chain.",
      normalizedGoal: "verify regression change",
      positiveTriggers: ["regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["regression typecheck passed"],
    });
    assert.equal(firstPostRun.action, "evidence_recorded");
    assert.equal(firstPostRun.generationDecision.source, "post_run_terminal");
    assert.equal(firstPostRun.generationDecision.decision, "append_evidence");
    assert.equal(firstPostRun.observation.sourceRefs.some((ref) => ref.type === "skill" && ref.id === "implement"), true);

    const secondPostRun = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_post_run_two",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Successful regression verification chain",
      summary: "Record another successful regression verification chain.",
      normalizedGoal: "verify regression change",
      positiveTriggers: ["regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["regression typecheck passed"],
    });
    assert.equal(secondPostRun.action, "candidate_created");
    assert.equal(secondPostRun.candidate.origin, "ling-generated");
    assert.equal(secondPostRun.generationDecision.source, "post_run_terminal");
    assert.equal(secondPostRun.generationDecision.decision, "create_skill_candidate");
    assert.equal(secondPostRun.generationDecision.createdCandidateId, secondPostRun.candidate.id);

    const generationDecisions = await getJson(`${daemon.url}/candidate-generation-decisions?cwd=${encodeURIComponent(cwd)}&clusterId=${encodeURIComponent(secondPostRun.observation.clusterId)}&limit=10`);
    assert.equal(generationDecisions.decisions.length, 2);
    assert.deepEqual(generationDecisions.decisions.map((decision) => decision.decision).sort(), ["append_evidence", "create_skill_candidate"]);

    const blocked = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "manual_recording",
      signals: ["save_as_skill", "user_approved_recording"],
      runId: "run_observation_job_policy",
      userConfirmed: true,
      title: "Use bash without asking",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
      positiveTriggers: ["skip approval"],
      negativeTriggers: ["manual review needed"],
      toolLabels: ["bash"],
      validationLabels: ["manual check"],
    });
    assert.equal(blocked.action, "blocked");
    assert.equal(blocked.route.kind, "approval_policy_review");

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const approvalOnlyFirst = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_approval_only_one",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Approval-only regression verification chain",
      summary: "Record a successful chain under approval-only policy.",
      normalizedGoal: "verify approval only regression",
      positiveTriggers: ["approval-only regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["approval-only typecheck passed"],
    });
    const approvalOnlySecond = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_approval_only_two",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Approval-only regression verification chain",
      summary: "Record another successful chain under approval-only policy.",
      normalizedGoal: "verify approval only regression",
      positiveTriggers: ["approval-only regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["approval-only typecheck passed"],
    });
    assert.equal(approvalOnlyFirst.action, "evidence_recorded");
    assert.equal(approvalOnlySecond.action, "evidence_recorded");
    assert.equal(approvalOnlySecond.candidate, undefined);
    assert.match(approvalOnlySecond.generationDecision.reason, /approval_only/);

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "off",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const generationOffRecording = await postJson(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_recording_generation_off",
      runId: "run_skill_recording_generation_off",
      title: "Recorded evidence-only flow",
      summary: "Recording should be retained as evidence when generation is off.",
      normalizedGoal: "record evidence only",
      positiveTriggers: ["evidence-only recording"],
      negativeTriggers: ["candidate creation"],
      toolLabels: ["bash"],
      validationLabels: ["manual review"],
    });
    assert.equal(generationOffRecording.action, "evidence_recorded");
    assert.equal(generationOffRecording.candidate, undefined);
    assert.equal(generationOffRecording.generationMode, "off");

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "disabled",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const disabledRecording = await fetch(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "run_skill_recording_disabled",
        title: "Disabled recording",
        summary: "This should be rejected by policy.",
        normalizedGoal: "disabled recording",
      }),
    });
    assert.equal(disabledRecording.status, 409);
    assert.equal((await disabledRecording.json()).error, "skill_recording_disabled");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill recording eligibility previews run evidence without creating candidates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-recording-eligibility-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Skill Recording",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_skill_recording_eligibility",
      cwd,
      taskId: "task_skill_recording_eligibility",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_skill_recording_eligibility", title: "Verify release checklist" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");
    store.appendEvent(run.id, "tool_start", { toolName: "bash" });
    store.appendEvent(run.id, "tool_end", { toolName: "bash" });
    store.markRunSucceeded(run.id, "2026-06-11T00:03:00.000Z");

    const eligibility = await getJson(`${daemon.url}/skill-recordings/eligibility?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(run.id)}`);
    assert.equal(eligibility.visible, true);
    assert.equal(eligibility.recommended, true);
    assert.equal(eligibility.reasonCode, "available");
    assert.equal(eligibility.actionHint, "create_candidate");
    assert.equal(eligibility.recordingMode, "user_initiated");
    assert.equal(eligibility.route.kind, "skill");
    assert.equal(eligibility.duplicateAnalysis.decision, "no_overlap");
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=recording&limit=10`)).candidates.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill import draft publishes registry skills and teammate bindings use effective model", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-import-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initialSkills = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(initialSkills.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));

    const importRequest = {
      source: "custom",
      sourcePath: "SKILL.md",
      content: [
        "---",
        "name: Custom QA Review",
        "description: Run a focused QA pass. Do not grant bash approvals or secrets.",
        "---",
        "",
        "Review the target surface and report concrete failures first.",
      ].join("\n"),
    };
    const draft = await postJson(`${daemon.url}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, importRequest);
    assert.equal(draft.draft.definitions.length, 1);
    assert.equal(draft.draft.definitions[0].definition.id, "custom-qa-review");
    assert.ok(draft.draft.definitions[0].warnings.some((warning) => warning.code === "permission_like_instruction"));
    assert.ok(draft.contextFindings.some((finding) => finding.kind === "optimization_unsafe"));

    const draftPreview = await postJson(`${daemon.url}/skills/import-draft/optimization-preview?cwd=${encodeURIComponent(cwd)}`, {
      ...importRequest,
      mode: "preview_on_demand",
    });
    assert.equal(draftPreview.preview.skillId, "custom-qa-review");
    assert.equal(draftPreview.preview.mode, "preview_on_demand");
    assert.equal(draftPreview.preview.status, "manual_review_required");
    assert.equal(draftPreview.preview.authorityBoundary.requiredToolsChanged, false);

    const published = await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draft.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(published.skills[0].id, "custom-qa-review");
    const draftCompiledResponse = await fetch(`${daemon.url}/skills/custom-qa-review/compiled-views?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview_on_demand" }),
    });
    assert.equal(draftCompiledResponse.status, 404);
    assert.equal((await draftCompiledResponse.json()).error, "skill_source_snapshot_not_found");
    const listed = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    const refreshed = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.ok(refreshed.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));
    assert.ok(refreshed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    assert.equal(typeof refreshed.refreshedAt, "string");
    assert.equal(typeof refreshed.registryGeneration, "number");
    const refreshedAgain = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshedAgain.registryGeneration > refreshed.registryGeneration, true);

    const teammateId = "teammate_builtin_engineer";
    const updated = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "custom-qa-review", source: "user", enabled: true }],
    });
    const customEffective = updated.effectiveSkills.find((skill) => skill.skillId === "custom-qa-review");
    assert.ok(customEffective);
    assert.equal(customEffective.executable, true);

    const unknownResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: [{ skillId: "missing-new-skill", source: "user", enabled: true }] }),
    });
    assert.equal(unknownResponse.status, 400);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct message stream emits ready delta and done events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-stream-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Stream a private reply.", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "delta", "done"]);
    assert.equal(events[1].data.delta, "Designer reply");
    assert.equal(events[2].data.aiReply.body, "Designer reply");
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.messages.at(-1).body, "Designer reply");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply injects web search context before runner reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-web-search-context-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const webSearchCalls = [];
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    webFetch: async (url, init) => {
      webSearchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Private fresh web evidence summary.",
        output: [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [
                { type: "url", url: "https://example.com/private-fresh", title: "Private fresh source" },
              ],
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai",
      displayName: "OpenAI Responses + Web Search",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      authHeader: true,
      capabilities: ["chat", "tool_call", "reasoning", "web_search"],
    })).provider;
    const store = stores.get(cwd);
    assert.ok(store);
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider ready for private web search context test.",
      checkedAt: new Date().toISOString(),
    });
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "查一下 Ling Stack 最新消息", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.equal(events[0].event, "ready");
    assert.equal(events.at(-1).event, "done");
    assert.ok(events.some((event) => event.event === "delta" && /正在准备 web_search/.test(event.data.body)));
    assert.ok(events.some((event) => event.event === "delta" && /正在搜索网页/.test(event.data.body)));
    assert.ok(events.some((event) => event.event === "delta" && /web_search 找到 1 个来源/.test(event.data.body)));
    const doneEvent = events.find((event) => event.event === "done");
    assert.equal(doneEvent.data.aiReply.webEvidence.status, "available");
    assert.equal(doneEvent.data.aiReply.webEvidence.query, "查一下 Ling Stack 最新消息");
    assert.equal(doneEvent.data.aiReply.webEvidence.provider.adapterId, "openai-responses-web-search");
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.sources.map((source) => source.url), ["https://example.com/private-fresh"]);
    assert.doesNotMatch(JSON.stringify(doneEvent.data.aiReply.webEvidence), /sk-test-secret-value/);
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const finalReply = listed.messages.find((message) => message.id === doneEvent.data.aiReply.id);
    assert.equal(finalReply.webEvidence.status, "available");
    const workUnit = store.listWorkUnits({ kind: "teammate_direct_reply", linkedMessageId: finalReply.id, limit: 1 })[0];
    assert.ok(workUnit);
    const webProgressEvents = store.listRuntimeEvents(workUnit.id).filter((event) => event.type === "work_unit_progress" && event.data.toolSurface === "web");
    assert.deepEqual(webProgressEvents.map((event) => event.data.type), [
      "web_search_planned",
      "web_search_started",
      "web_search_completed",
    ]);
    assert.equal(webProgressEvents[2].data.status, "available");
    assert.equal(webProgressEvents[2].data.sourceCount, 1);

    assert.equal(webSearchCalls.length, 1);
    assert.equal(webSearchCalls[0].url, "https://api.openai.com/v1/responses");
    const requestBody = JSON.parse(webSearchCalls[0].init.body);
    assert.deepEqual(requestBody.tools, [{ type: "web_search", search_context_size: "low" }]);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Ling web context:/);
    assert.match(runner.runs[0].task.prompt, /Private fresh web evidence summary/);
    assert.match(runner.runs[0].task.prompt, /https:\/\/example\.com\/private-fresh/);
    assert.match(runner.runs[0].systemPrompt, /If Ling web context is included/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct web search context blocks unsupported providers without fetching", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-web-search-unsupported-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  let fetched = false;
  const daemon = await startDaemonForTest(runner, {
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    webFetch: async () => {
      fetched = true;
      return new Response("should not fetch", { status: 200 });
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "查一下 Ling Stack 最新消息", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.equal(events[0].event, "ready");
    assert.equal(events.at(-1).event, "done");
    assert.ok(events.some((event) => event.event === "delta" && /web_search 被阻止/.test(event.data.body)));
    const doneEvent = events.find((event) => event.event === "done");
    assert.equal(doneEvent.data.aiReply.webEvidence.status, "blocked");
    assert.match(doneEvent.data.aiReply.webEvidence.reason, /No Ling global web_search backend is configured/);
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.sources, []);
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.readUrls, []);

    assert.equal(fetched, false);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Web search status: blocked/);
    assert.match(runner.runs[0].task.prompt, /No Ling global web_search backend is configured/);
    assert.match(runner.runs[0].task.prompt, /will not bypass model settings/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct message rejects workspace file refs outside private workspace", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-file-ref-boundary-"));
  await ensureGitRepo(cwd);
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_designer";
    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Read this file.",
        fileRefs: [{ path: resolve(tmpdir(), "outside-private-chat.txt"), label: "outside-private-chat.txt", source: "composer" }],
      }),
    });
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.match(error.message, /文件引用不在私聊工作区范围内/);
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.messages.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply materializes current text and docx attachments", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-attachment-materialization-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const textAttachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-note.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Private direct attachment body", "utf8").toString("base64"),
    })).attachment;
    const docxAttachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-brief.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBase64: (await readDocxFixtureBytes()).toString("base64"),
    })).attachment;

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Summarize these private attachments.",
        attachmentIds: [textAttachment.id, docxAttachment.id],
        providerPresetId: provider.id,
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "delta", "done"]);

    const prompt = runner.runs[0].task.prompt;
    assert.match(prompt, /Attachment content:/);
    assert.match(prompt, /Private direct attachment body/);
    assert.match(prompt, /Walking on imported air/);
    assert.doesNotMatch(prompt, /currently exposes attachment metadata only/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply uses private chat memory isolation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-memory-isolation-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const channel = await createChannel(daemon.url, cwd);
    const privateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Direct memory token",
      body: "Designer private directmemorytoken preference should be available in private chat.",
      sensitivity: "private",
    })).memory;
    const otherPrivateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_engineer",
      title: "Other direct memory token",
      body: "Engineer private directmemorytoken preference must stay isolated.",
      sensitivity: "private",
    })).memory;
    const channelMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Channel direct memory token",
      body: "Channel directmemorytoken context must not enter private chat by default.",
    })).memory;

    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Use directmemorytoken in this private reply.",
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Used memory:/);
    assert.match(runner.runs[0].systemPrompt, /Designer private directmemorytoken preference/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Engineer private directmemorytoken preference/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Channel directmemorytoken context/);

    const used = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&responseId=${encodeURIComponent(created.aiReply.id)}`);
    assert.ok(used.events[0].memoryIds.includes(privateMemory.id));
    assert.equal(used.events[0].memoryIds.includes(otherPrivateMemory.id), false);
    assert.equal(used.events[0].memoryIds.includes(channelMemory.id), false);
    assert.match(used.events[0].policyVersion, /memory_use_isolation_v1/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct prompt anchors latest attachment message instead of old guidance context", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-attachment-anchor-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const stores = [];
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.push(store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "要继续补「排队引导」相关内容。",
      requestAiReply: false,
    });
    const store = stores.find((item) => item.paths.cwd === cwd);
    assert.ok(store);
    const thread = store.getOrCreateTeammateDirectThread(teammateId, "2026-06-12T08:00:00.000Z");
    store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId,
        authorType: "system",
        authorId: "system",
        body: "排队引导：旧排队引导不应继续生效。",
        status: "ready",
      },
      "2026-06-12T08:01:00.000Z",
    );
    const attachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "screenshot.png",
      contentType: "image/png",
      contentBase64: Buffer.from("not-a-real-image").toString("base64"),
      scope: "teammate_direct_thread",
    })).attachment;

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "描述下这个图片是什么内容",
        attachmentIds: [attachment.id],
        providerPresetId: provider.id,
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "delta", "done"]);

    const prompt = runner.runs.at(-1).task.prompt;
    const oldGuidanceIndex = prompt.indexOf("要继续补「排队引导」相关内容。");
    const latestIndex = prompt.indexOf("Latest message to answer now:\nUser: 描述下这个图片是什么内容");
    assert.equal(oldGuidanceIndex >= 0, true);
    assert.equal(latestIndex > oldGuidanceIndex, true);
    assert.doesNotMatch(prompt, /旧排队引导不应继续生效/);
    assert.match(prompt, /Attachments: screenshot\.png \(image, image\/png,/);
    assert.match(prompt, /Reply to the Latest message to answer now/);
    assert.match(prompt, /Do not infer unseen attachment contents/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply cancel aborts active reply and marks pending message cancelled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-cancel-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start a cancellable private reply.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(response.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "private reply runner to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runtime.activeReply.status, "running");
    assert.ok(runtime.activeReply.workUnitId);
    assert.ok(runtime.activeReply.messageId);

    const cancelled = await postJson(`${daemon.url}/teammate-direct-replies/${encodeURIComponent(runtime.activeReply.workUnitId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");
    assert.equal(cancelled.message.status, "cancelled");
    assert.equal(cancelled.message.body, "回复已停止");
    assert.equal(runner.abortCount, 1);

    runner.resolve("Late private reply");
    await response.text().catch(() => "");
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const aiReply = listed.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(aiReply.status, "cancelled");
    assert.equal(aiReply.body, "回复已停止");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance can promote to immediate continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-promote-guidance-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start thinking.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "direct reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const rejectedGuidance = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "queue_followup",
        instruction: "Use outside file.",
        messagePayload: {
          body: "Use outside file.",
          attachmentIds: [],
          fileRefs: [{ path: resolve(tmpdir(), "outside-guidance.txt"), label: "outside-guidance.txt", source: "composer" }],
        },
        idempotencyKey: "test-reject-outside-guidance-file-ref",
      }),
    });
    assert.equal(rejectedGuidance.status, 400);
    assert.match((await rejectedGuidance.json()).message, /文件引用不在私聊工作区范围内/);

    const queued = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Use this queued guidance immediately.",
      messagePayload: {
        body: "Use this queued guidance immediately.",
        attachmentIds: [],
      },
      idempotencyKey: "test-promote-queued-guidance",
    });
    assert.equal(queued.intervention.status, "queued");
    assert.deepEqual(queued.intervention.messagePayload, {
      body: "Use this queued guidance immediately.",
      attachmentIds: [],
      linkPreviewIds: [],
    });

    const promoted = await postJson(`${daemon.url}/teammate-direct-interventions/${encodeURIComponent(queued.intervention.id)}/promote?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(promoted.intervention.id, queued.intervention.id);
    assert.deepEqual(promoted.intervention.messagePayload, queued.intervention.messagePayload);
    assert.equal(promoted.intervention.status, "cancelling_source");
    assert.equal(runner.abortCount, 1);
    await waitForCondition(() => runner.runs.length === 2, "promoted continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes("Use this queued guidance immediately."), true);
    assert.equal(runner.runs[1].task.prompt.includes("排队引导"), true);

    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.interventions.filter((item) => item.id === queued.intervention.id).length, 1);
    assert.equal(listed.interventions.some((item) => item.status === "queued"), false);

    runner.resolve("Promoted continuation reply");
    await streamResponse.text().catch(() => "");
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const cancelledReply = messages.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(cancelledReply.status, "cancelled");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance starts automatically after source reply completes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-queued-guidance-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start and then follow queued guidance.", providerPresetId: provider.id }),
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "source private reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const queued = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Continue from the queued guidance.",
      idempotencyKey: "test-auto-queued-guidance",
    });
    assert.equal(queued.intervention.status, "queued");

    runner.resolve("Initial private reply");
    await waitForCondition(() => runner.runs.length === 2, "queued continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes("Continue from the queued guidance."), true);
    assert.equal(runner.runs[1].task.prompt.includes("排队引导"), true);
    runner.resolve("Queued continuation reply");
    await streamResponse.text();

    const listedInterventions = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedInterventions.interventions.some((item) => item.id === queued.intervention.id), false);
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(messages.messages.some((message) => message.authorType === "system" && message.body.includes("Continue from the queued guidance.")), true);
    assert.equal(messages.messages.at(-1).body, "Queued continuation reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance drains multiple queued items in thread FIFO order", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-queued-guidance-fifo-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start and then drain queued guidance.", providerPresetId: provider.id }),
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "source private reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const queuedInstructions = [
      "Queued guidance one.",
      "Queued guidance two.",
      "Queued guidance three.",
    ];
    const queued = [];
    for (const [index, instruction] of queuedInstructions.entries()) {
      const response = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
        mode: "queue_followup",
        instruction,
        idempotencyKey: `test-auto-queued-guidance-fifo-${index}`,
      });
      assert.equal(response.intervention.status, "queued");
      queued.push(response.intervention);
    }

    runner.resolve("Initial private reply");
    await waitForCondition(() => runner.runs.length === 2, "first queued continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes(queuedInstructions[0]), true);

    runner.resolve("First queued continuation reply");
    await waitForCondition(() => runner.runs.length === 3, "second queued continuation to start");
    assert.equal(runner.runs[2].task.prompt.includes(queuedInstructions[1]), true);

    runner.resolve("Second queued continuation reply");
    await waitForCondition(() => runner.runs.length === 4, "third queued continuation to start");
    assert.equal(runner.runs[3].task.prompt.includes(queuedInstructions[2]), true);

    runner.resolve("Third queued continuation reply");
    await streamResponse.text();
    const queuedIds = new Set(queued.map((item) => item.id));
    await waitForCondition(async () => {
      const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
      return !listed.interventions.some((item) => queuedIds.has(item.id));
    }, "queued guidance chain to close");
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    for (const instruction of queuedInstructions) {
      assert.equal(messages.messages.some((message) => message.authorType === "system" && message.body.includes(instruction)), true);
    }
    assert.equal(messages.messages.at(-1).body, "Third queued continuation reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private attachments avatar and hard delete stay scoped to teammate private data", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-attachments-hard-delete-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    const attachment = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-note.txt",
      contentBase64: Buffer.from("private note", "utf8").toString("base64"),
    });
    const content = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(await content.text(), "private note");
    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "See the private note.",
      attachmentIds: [attachment.attachment.id],
    });
    assert.deepEqual(message.message.attachmentIds, [attachment.attachment.id]);
    const avatar = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/avatar?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "avatar.png",
      contentBase64: Buffer.from("png", "utf8").toString("base64"),
    });
    assert.equal(avatar.teammate.avatarImageAttachmentId, avatar.attachment.id);
    const crossScope = await fetch(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "bad", attachmentIds: [attachment.attachment.id] }),
    });
    assert.equal(crossScope.status, 400);
    assert.match((await crossScope.json()).message, /does not belong/i);

    const memory = await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Hard delete private memory",
      body: "This memory should disappear.",
      sensitivity: "private",
    });
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Assigned before delete",
      prompt: "Keep task history.",
      assigneeTeammateId: teammateId,
    })).task;

    const deleted = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test delete",
    });
    assert.equal(deleted.tombstone.entityId, teammateId);
    assert.equal(deleted.tombstone.deletedCounts.privateAttachments, 2);
    const missingMessages = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingMessages.status, 404);
    const missingContent = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingContent.status, 404);
    const updatedTask = (await getJson(`${daemon.url}/tasks/${encodeURIComponent(task.id)}?cwd=${encodeURIComponent(cwd)}`)).task;
    assert.equal(updatedTask.assigneeTeammateId, undefined);
    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId,
      intent: "private-chat",
      query: "Hard delete private memory",
      includePrivate: true,
    });
    assert.equal(recall.memories.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class RecordingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({ type: "assistant_text_delta", text: "Designer reply" });
    return {
      taskId: options.task.id,
      messages: ["Designer reply"],
      events: [],
    };
  }
}

class PromptEchoRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({ type: "assistant_text_delta", text: options.task.prompt });
    return {
      taskId: options.task.id,
      messages: [options.task.prompt],
      events: [],
    };
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class ScriptedRunner {
  constructor(responses) {
    this.responses = responses.slice();
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    const text = response ?? "";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }
}

class SelectiveFailingRunner {
  constructor(failingTitles) {
    this.failingTitles = new Set(failingTitles);
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    if (this.failingTitles.has(options.task.title)) {
      throw new Error(`${options.task.title} failed by test runner`);
    }
    options.onEvent?.({ type: "assistant_text_delta", text: `${options.task.title} complete` });
    return {
      taskId: options.task.id,
      messages: [`${options.task.title} complete`],
      events: [],
    };
  }
}

class DelayedRunner {
  constructor() {
    this.runs = [];
    this.completed = false;
    this.pending = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    const text = await new Promise((resolve) => {
      this.pending = resolve;
    });
    this.completed = true;
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  resolve(text) {
    this.pending?.(text);
    this.pending = undefined;
  }
}

class AbortableDelayedRunner {
  constructor() {
    this.runs = [];
    this.abortCount = 0;
    this.pending = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    const text = await new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      options.signal?.addEventListener("abort", () => {
        this.abortCount += 1;
        reject(new Error("aborted by test"));
      }, { once: true });
    });
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  resolve(text) {
    this.pending?.resolve(text);
    this.pending = undefined;
  }
}

class ParallelDelayedRunner {
  constructor() {
    this.runs = [];
    this.pendingResolvers = [];
    this.startedResolvers = [];
    this.autoResolveText = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    this.startedResolvers.splice(0).forEach((resolveStarted) => resolveStarted());
    let text = this.autoResolveText;
    if (text === undefined) {
      text = await new Promise((resolve) => {
        this.pendingResolvers.push(resolve);
      });
    }
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  async waitUntilStarted(count) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (this.runs.length >= count) {
        return;
      }
      await new Promise((resolve) => {
        this.startedResolvers.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    assert.fail(`Timed out waiting for ${count} parallel runs. Started: ${this.runs.length}`);
  }

  resolveAll(text) {
    this.autoResolveText = text;
    this.pendingResolvers.splice(0).forEach((resolvePending) => resolvePending(text));
  }
}

function testDaemonConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { autoRoute: false, intentSelector: false },
  };
}

function unusedRunnerRegistry() {
  return {
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    resolve() {
      throw new Error("runner registry should not be used by deterministic route test");
    },
  };
}

async function startDaemonForTest(runner, dependencies = {}, config = {}) {
  const { channels, ...restConfig } = config;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    ...restConfig,
    channels: { intentSelector: false, ...channels },
  }, {
    ...dependencies,
    ...(runner ? { runner } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function createParallelWorkflowStep(store, workflowId, title, metadata = {}) {
  return store.createChannelWorkflowStep(
    {
      workflowId,
      position: metadata.position ?? 1,
      title,
      prompt: `Complete ${title}.`,
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: metadata.status,
      metadata: {
        templateStepId: title.toLowerCase().replaceAll(" ", "-"),
        branchGroupId: metadata.branchGroupId,
        joinGroupId: metadata.joinGroupId,
        dependsOnStepIds: metadata.dependsOnStepIds,
        dependencyMode: metadata.dependencyMode,
        fanInPolicy: metadata.fanInPolicy,
        maxParallelSiblings: metadata.maxParallelSiblings,
        providerPresetId: metadata.providerPresetId,
        requiredTools: metadata.omitRequiredTools ? undefined : metadata.requiredTools ?? ["read"],
        approvalGate: metadata.approvalGate,
      },
    },
    new Date().toISOString(),
  );
}

function createStoreChannelAndMessage(store, cwd, body) {
  const now = "2026-06-11T00:00:00.000Z";
  const channel = store.createChannel({
    name: "Ling Agent Session",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  }, now);
  const message = store.createChannelMessage({
    channelId: channel.id,
    authorType: "local-user",
    body,
  }, now);
  return { channel, message };
}

function customTemplate(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "custom-template",
    name: "Custom Template",
    steps: [],
    ...overrides,
  };
}

async function createChannel(baseUrl, cwd) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Engineering",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function createWorkflowTestChannel(baseUrl, cwd, name) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name,
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function createAutoRouteTestChannel(baseUrl, cwd) {
  const provider = (await createStaticChatProvider(baseUrl, cwd)).provider;
  await postJson(`${baseUrl}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
  const channel = (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultProviderPresetId: provider.id,
    autoReplyMode: "auto_route",
    allowedTools: ["read"],
  })).channel;
  const teammateId = "teammate_builtin_designer";
  await patchJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
    providerPresetId: provider.id,
  });
  await putJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
    memberships: [{ channelId: channel.id }],
  });
  return channel;
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function startMockOpenAICompatibleServer(options = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    const responseContent = typeof options.responseContent === "function"
      ? options.responseContent({ request, body })
      : options.responseContent ?? "OK";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-startup-refresh",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: responseContent }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function postTaskRunAndReadReadyRunId(baseUrl, cwd, taskId, body) {
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const text = await response.text();
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes("runId"));
  assert.ok(dataLine, text);
  return JSON.parse(dataLine.slice("data:".length).trim()).runId;
}

function parseSseEvents(text) {
  return text
    .split(/\n\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) {
        return undefined;
      }
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      };
    })
    .filter(Boolean);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function getArtifactJson(baseUrl, cwd, artifactId) {
  const response = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

function assertCoordinatorWorkflowStartReply(result, expectedThreadId = result.message.id) {
  assert.equal(result.aiReply.kind, "ai_reply");
  assert.equal(result.aiReply.status, "ready");
  assert.equal(result.aiReply.threadId, expectedThreadId);
  assert.equal(result.aiReply.authorId, "ling_agent");
  assert.match(result.aiReply.body, /确认需求/);
  assert.match(result.aiReply.body, /开始处理/);
  assert.doesNotMatch(result.aiReply.body, /主会话/);
  assert.doesNotMatch(result.aiReply.body, /工作证据|折叠证据摘要/);
}

function assertCoordinatorWorkflowTerminalReply(messages) {
  const reply = messages.find((message) =>
    message.kind === "ai_reply" &&
    message.authorId === "ling_agent" &&
    /^(完成：|Done:)/u.test(message.body)
  );
  assert.ok(reply, "expected Ling Agent workflow terminal summary reply");
  assert.equal(reply.status, "ready");
  assert.doesNotMatch(reply.body, /我已完成|I finished|打开工作证据|展开下方证据摘要|evidence summary/i);
  return reply;
}

function assertIntentDecisionInspectPayloadIsSafe(decision) {
  const allowedKeys = new Set([
    "schemaVersion",
    "id",
    "workspaceId",
    "channelId",
    "sourceMessageId",
    "action",
    "selectedTeammateId",
    "selectedTeammateIds",
    "proposalId",
    "replyMessageId",
    "replyMessageIds",
    "workflowId",
    "reason",
    "status",
    "createdBy",
    "errorMessage",
    "createdAt",
    "updatedAt",
  ]);
  const forbiddenKeys = [
    "prompt",
    "body",
    "messages",
    "contextPack",
    "systemPrompt",
    "taskPrompt",
    "proposal",
    "rawPrompt",
    "hiddenPrompt",
    "privateMessages",
    "artifactBody",
    "providerSecret",
    "providerSecrets",
    "apiKey",
    "apiKeyRef",
    "secretRef",
    "providerApiKey",
    "confidence",
    "score",
  ];
  for (const key of Object.keys(decision)) {
    assert.equal(allowedKeys.has(key), true, `unexpected intent inspect field: ${key}`);
  }
  for (const key of forbiddenKeys) {
    assert.equal(Object.hasOwn(decision, key), false, `unsafe intent inspect field exposed: ${key}`);
  }
}

async function waitForChannelMessageStatus(baseUrl, cwd, channelId, messageId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/channels/${encodeURIComponent(channelId)}/messages?cwd=${encodeURIComponent(cwd)}`);
    const message = latest.messages.find((item) => item.id === messageId);
    if (message?.status === status) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for channel message ${messageId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function waitForWorkflowStepStatus(baseUrl, cwd, workflowId, workflowStepId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.id === workflowStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow step ${workflowStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function settleParallelDelayedWorkflow(baseUrl, cwd, workflowId, runner, text, options = {}) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    runner.resolveAll(text);
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const runningSteps = latest.workflowSteps.filter((step) => step.status === "running");
    const queuedSteps = options.drainQueued ? latest.workflowSteps.filter((step) => step.status === "queued") : [];
    if (runningSteps.length === 0) {
      if (queuedSteps.length > 0) {
        await postJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
      const hasRunning = settled.workflowSteps.some((step) => step.status === "running");
      const hasQueued = options.drainQueued && settled.workflowSteps.some((step) => step.status === "queued");
      if (!hasRunning && !hasQueued) {
        return settled.workflowSteps;
      }
      continue;
    }
    await Promise.all(runningSteps.map((step) => waitForWorkflowStepStatus(baseUrl, cwd, workflowId, step.id, "succeeded")));
  }
  assert.fail(`Timed out waiting for parallel delayed workflow ${workflowId} to settle. Latest: ${JSON.stringify(latest)}`);
}

async function waitForWorkflowTemplateStepStatus(baseUrl, cwd, workflowId, templateStepId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow template step ${templateStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function approveWorkflowStepGate(baseUrl, cwd, workflowId, templateStepId) {
  const deadline = Date.now() + 2_000;
  let approval;
  let step;
  while (Date.now() < deadline) {
    const steps = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    step = steps.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    assert.ok(step, `Expected workflow step for template step ${templateStepId}`);
    const approvals = await getJson(`${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(step.id)}`);
    approval = approvals.approvals[0];
    if (approval) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(approval, `Expected pending approval for workflow step ${templateStepId}`);
  assert.equal(approval.workflowStepId, step.id);
  assert.equal(approval.actionType, "workflow_step");
  assert.equal(approval.payload.type, "workflow_step");
  assert.equal(approval.payload.workflowStepId, step.id);
  const actions = await getJson(`${baseUrl}/execution-actions?cwd=${encodeURIComponent(cwd)}&status=waiting_for_approval`);
  assert.equal(actions.actions.some((action) => action.approvalId === approval.id && action.targetRefs.some((ref) => ref.type === "workflow_step" && ref.id === step.id)), true);
  await postJson(`${baseUrl}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
    reason: `approve ${templateStepId}`,
  });
  return await postJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
}

async function postJson(url, body) {
  await ensureGitRepoForChannelPost(url, body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function deleteJson(url) {
  const response = await fetch(url, {
    method: "DELETE",
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response;
}
