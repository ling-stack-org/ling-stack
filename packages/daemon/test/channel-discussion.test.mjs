import { appendChannelItemFixture, getChannelItemViewFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore } from "../../core/dist/index.js";
import { buildContextPack, estimateTextTokens, resolveProviderContextBudget } from "../dist/features/channels/context-packs.js";
import { resolveChannelReplyExecutionTarget } from "../dist/features/channels/channel-reply-execution-target.js";
import { planConversationContextSummary } from "../dist/features/channels/context-processing/conversation-summary-coordinator.js";
import { buildLingAgentSessionViewForChannel } from "../dist/features/channels/ling-agent-session-view.js";
import { buildLingAgentTurnEnvelope } from "../dist/features/channels/ling-agent-turn-envelope.js";
import { findActiveChannelReplyRun } from "../dist/features/channels/channel-reply-dispatch.js";
import { availabilityIncidentInputForProviderRuntimeFailure } from "../dist/features/channels/provider-runtime-observations.js";
import { linkBodyExtractorV1 } from "../dist/features/channels/materialization/extractors/link-body.js";
import { officeExtractorV1 } from "../dist/features/channels/materialization/extractors/office.js";
import { pdfExtractorV1 } from "../dist/features/channels/materialization/extractors/pdf.js";
import { attachmentMaterializationFingerprint, linkPreviewMaterializationFingerprint } from "../dist/features/channels/materialization/fingerprints.js";
import { materializeInlineChannelInputs } from "../dist/features/channels/materialization/inline.js";
import { OfficeArtifactService } from "../dist/features/office-documents/artifacts.js";
import { materializeInlineTeammateDirectInputs } from "../dist/features/teammates/direct-materialization.js";
import { ensureGitRepo } from "./git-test-helpers.mjs";
import { startMockOpenAICompatibleServer } from "./support/mock-openai-compatible-server.mjs";
import {
  readPdfFixtureBytes,
  readDocxFixtureBytes,
  SummaryAwareRunner,
  RecordingRunner,
  PromptEchoRunner,
  ScriptedRunner,
  AbortableDelayedRunner,
  readCurrentChannelUserMessage,
  startDaemonForTest,
  createStoreChannelAndMessage,
  createActiveChannelReplyRunFixture,
  createChannel,
  setWorkspaceDefaultProvider,
  createStaticChatProvider,
  parseSseEvents,
  getJson,
  assertCoordinatorWorkflowStartReply,
  assertSingleReplyIntentDecision,
  waitForChannelMessageStatus,
  waitForCondition,
  postJson,
  putJson,
  patchJson,
  deleteJson,
} from "./support/channel-workspace-fixture.mjs";

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

test("channel proposal confirmation claim is durable, first-writer-wins, and recoverable", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-proposal-cas-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-09-19T10:00:00.000Z";
  try {
    const { channel, message } = createStoreChannelAndMessage(store, cwd, "prepare a safe change");
    const proposal = store.createChannelExecutionProposal({
      channelId: channel.id,
      sourceMessageId: message.id,
      proposedByTeammateId: "ling_agent",
      title: "Safe change",
      prompt: "Prepare a safe change",
      assigneeTeammateId: "ling_agent",
      status: "draft",
    }, now);
    assert.equal(proposal.revision, 1);

    const first = store.claimChannelExecutionProposal(
      proposal.id,
      "proposal-confirm:first",
      now,
      "2026-09-19T10:05:00.000Z",
    );
    assert.equal(first.kind, "claimed");
    assert.equal(first.proposal.revision, 2);

    const second = store.claimChannelExecutionProposal(
      proposal.id,
      "proposal-confirm:second",
      now,
      "2026-09-19T10:05:00.000Z",
    );
    assert.equal(second.kind, "busy");

    assert.equal(store.updateChannelExecutionProposal(proposal.id, {
      status: "cancelled",
    }, now), undefined, "a stale UI cancel cannot steal an active confirmation claim");
    assert.equal(store.updateChannelExecutionProposal(proposal.id, {
      status: "blocked",
      expectedRevision: 1,
    }, now), undefined, "an old revision cannot overwrite a claimed proposal");

    const blocked = store.updateChannelExecutionProposal(proposal.id, {
      status: "blocked",
      errorMessage: "provider unavailable",
      expectedRevision: first.proposal.revision,
      confirmationClaimId: "proposal-confirm:first",
    }, now);
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.revision, 3);

    const recovered = store.claimChannelExecutionProposal(
      proposal.id,
      "proposal-confirm:recovery",
      "2026-09-19T10:06:00.000Z",
      "2026-09-19T10:11:00.000Z",
    );
    assert.equal(recovered.kind, "claimed", "blocked proposals can be retried after the prior claim is released");
    assert.equal(recovered.proposal.revision, 4);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an expired proposal confirmation lease can be reclaimed without releasing the old claim", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-proposal-lease-expiry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-09-19T11:00:00.000Z";
    const { channel, message } = createStoreChannelAndMessage(store, cwd, "recover an abandoned confirmation");
    const proposal = store.createChannelExecutionProposal({
      channelId: channel.id,
      sourceMessageId: message.id,
      proposedByTeammateId: "ling_agent",
      title: "Abandoned confirmation",
      prompt: "Recover an abandoned confirmation",
      assigneeTeammateId: "ling_agent",
      status: "draft",
    }, now);

    const first = store.claimChannelExecutionProposal(
      proposal.id,
      "proposal-confirm:abandoned",
      now,
      "2026-09-19T11:05:00.000Z",
    );
    assert.equal(first.kind, "claimed");
    assert.equal(first.proposal.revision, 2);

    const recovered = store.claimChannelExecutionProposal(
      proposal.id,
      "proposal-confirm:recovered",
      "2026-09-19T11:06:00.000Z",
      "2026-09-19T11:11:00.000Z",
    );
    assert.equal(recovered.kind, "claimed");
    assert.equal(recovered.proposal.revision, 3);

    assert.equal(store.updateChannelExecutionProposal(proposal.id, {
      status: "blocked",
      errorMessage: "The expired owner cannot finalize this proposal.",
      expectedRevision: first.proposal.revision,
      confirmationClaimId: "proposal-confirm:abandoned",
    }, "2026-09-19T11:06:00.000Z"), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel branches follow archive restore and delete lifecycle", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-branches-"));
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
    const store = stores.find((item) => item.paths.cwd === cwd);
    assert.ok(store);
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
    appendChannelItemFixture(store, {
      channelId: channel.id,
      threadId: branch.rootThreadId,
      authorType: "local-user",
      body: "Message in model routing branch",
    }, "2026-06-22T00:01:00.000Z");
    appendChannelItemFixture(store, {
      channelId: channel.id,
      threadId: secondBranch.rootThreadId,
      authorType: "local-user",
      body: "Message in prompt cleanup branch",
    }, "2026-06-22T00:02:00.000Z");
    const firstBranchMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(branch.rootThreadId)}`);
    assert.deepEqual(
      firstBranchMessages.messages
        .filter((message) => message.authorType === "local-user")
        .map((message) => message.body),
      ["Message in model routing branch"],
    );
    const secondBranchMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(secondBranch.rootThreadId)}`);
    assert.deepEqual(
      secondBranchMessages.messages
        .filter((message) => message.authorType === "local-user")
        .map((message) => message.body),
      ["Message in prompt cleanup branch"],
    );

    const legacyBranch = store.createChannelBranch({
      channelId: channel.id,
      name: "Legacy branch",
    }, "2026-06-22T00:00:00.000Z");
    assert.equal(legacyBranch.rootThreadId, undefined);
    const repairedBranches = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}`);
    const repairedLegacy = repairedBranches.branches.find((item) => item.id === legacyBranch.id);
    assert.equal(repairedLegacy?.rootThreadId, undefined);
    assert.equal(store.getChannelBranch(legacyBranch.id).rootThreadId, undefined);
    const explicitRepair = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches/${encodeURIComponent(legacyBranch.id)}/repair?cwd=${encodeURIComponent(cwd)}`, {});
    assert.ok(explicitRepair.branch.rootThreadId);
    assert.equal(store.getChannelBranch(legacyBranch.id).rootThreadId, explicitRepair.branch.rootThreadId);

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
  assert.equal(trimmed.overBudget, true);

  const protectedOnly = buildContextPack({
    kind: "channel_reply",
    providerPreset: { ...providerBase, contextWindow: 1800, maxTokens: 512 },
    sections: [{ id: "current_user_turn", role: "user", priority: "must_keep", text: "full current request", estimatedTokens: 3_000 }],
  });
  assert.deepEqual(protectedOnly.sections.map((section) => section.id), ["current_user_turn"]);
  assert.deepEqual(protectedOnly.droppedSectionIds, []);
  assert.equal(protectedOnly.overBudget, true);
});

test("ling agent session view is open when channel has no active work", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-open-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-proposal-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-proposed-plan-source-state-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-evidence-summary-"));
  const store = createSqliteRunStore(cwd);
  try {
    const { channel, message } = createStoreChannelAndMessage(store, cwd, "collect evidence");
    const webMessage = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: "ling_agent",
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-workflow-approval-owner-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-approval-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-final-workflow-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-blocked-workflow-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-failed-run-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-session-denied-approval-"));
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-followup-"));
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
    const run = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_ling_agent_coordinator_followup",
      taskId: "task_ling_agent_coordinator_followup",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "完成后也更新 docs",
      replyDisposition: { mode: "queue_followup", activeRunId: run.id },
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.replyDispatch.disposition, "followup_queued");
    assert.equal(created.replyDispatch.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.mode, "queue_followup");
    const interventions = store.listRunInterventions({ sourceRunId: run.id });
    assert.deepEqual(interventions.map((intervention) => intervention.id), [created.replyDispatch.intervention.id]);
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

test("active channel reply does not intercept an unmarked direct workflow request", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-active-reply-direct-workflow-"));
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
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Direct workflow while reply is active",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const activeRun = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_active_reply_before_execute",
      taskId: "task_active_reply_before_execute",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.replyDispatch, undefined);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.deepEqual(store.listRunInterventions({ sourceRunId: activeRun.id }), []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.action === "execute" && decision.status === "accepted"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("root reply guidance cannot capture a branch turn and branch continuation stays on its thread", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-reply-branch-lineage-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
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
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Reply branch lineage",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 4,
        schedulingMode: "smart",
        writeLockScope: "channel",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const branch = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/branches?cwd=${encodeURIComponent(cwd)}`, {
      name: "Independent branch",
    })).branch;
    const store = stores.get(cwd);
    assert.ok(store);
    const rootRun = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_root_reply_before_branch",
      taskId: "task_root_reply_before_branch",
    });

    const branchSource = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "thread", threadId: branch.rootThreadId },
      body: "Start an independent branch reply.",
      requestAiReply: true,
      providerPresetId: provider.id,
      replyDisposition: { mode: "queue_followup", activeRunId: rootRun.id },
    });

    assert.equal(branchSource.replyDispatch.disposition, "reply_requested");
    assert.equal(branchSource.aiReply.threadId, branch.rootThreadId);
    assert.deepEqual(store.listRunInterventions({ sourceRunId: rootRun.id }), []);
    await waitForCondition(() => {
      const failed = store.listRuns({ limit: 20 }).find(run => run.threadId === branch.rootThreadId && run.status === "failed");
      assert.equal(failed?.errorMessage, undefined);
      return runner.runs.length === 1;
    }, "branch reply run to start");
    const branchRun = store.listRuns({ limit: 20 }).find((run) =>
      run.channelId === channel.id && run.threadId === branch.rootThreadId && run.id !== rootRun.id
    );
    assert.ok(branchRun);
    assert.equal(branchRun.threadId, branch.rootThreadId);

    const guidance = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "thread", threadId: branch.rootThreadId },
      body: "Continue only inside this branch.",
      requestAiReply: true,
      providerPresetId: provider.id,
      replyDisposition: { mode: "queue_followup", activeRunId: branchRun.id },
    });
    assert.equal(guidance.replyDispatch.disposition, "followup_queued");
    assert.equal(guidance.replyDispatch.sourceRunId, branchRun.id);

    runner.resolve("Initial branch reply");
    await waitForCondition(() => runner.runs.length === 2, "branch continuation to start");
    await waitForCondition(
      () => store.getRunIntervention(guidance.replyDispatch.intervention.id)?.continuationRunId,
      "branch continuation to link",
    );
    const intervention = store.getRunIntervention(guidance.replyDispatch.intervention.id);
    const continuationRun = store.getRun(intervention.continuationRunId);
    assert.ok(continuationRun);
    assert.equal(continuationRun.threadId, branch.rootThreadId);
    runner.resolve("Branch continuation reply");
  } finally {
    for (let index = 0; index < 3; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("topic channel replies keep canonical LingThread identity and isolate guidance by source message lineage", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-topic-reply-lineage-"));
  const runner = new AbortableDelayedRunner();
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
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Topic reply lineage",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);

    const topicRoot = appendChannelItemFixture(store, {
      channelId: channel.id,
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      body: "Topic root message.",
      status: "ready",
    }, "2026-08-08T00:00:00.000Z");
    const topicSource = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: topicRoot.id },
      body: "Start a reply inside this topic.",
      requestAiReply: true,
      providerPresetId: provider.id,
    });
    await waitForCondition(() => runner.runs.length === 1, "topic reply run to start");
    const topicRun = store.listRuns({ limit: 20 }).find((run) =>
      run.channelId === channel.id && !run.parentRunId
    );
    assert.ok(topicRun);
    assert.equal(topicRun.requestSnapshot.sourceMessageId, topicSource.message.id);
    assert.match(topicRun.threadId, /^thread_/);
    assert.notEqual(topicRun.threadId, topicRoot.id);

    const guidance = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "thread", threadId: topicSource.thread.id },
      body: "Continue only inside this topic.",
      requestAiReply: true,
      providerPresetId: provider.id,
      replyDisposition: { mode: "queue_followup", activeRunId: topicRun.id },
    });
    assert.equal(guidance.replyDispatch.disposition, "followup_queued");
    assert.equal(guidance.replyDispatch.sourceRunId, topicRun.id);

    runner.resolve("Initial topic reply");
    await waitForCondition(() => runner.runs.length === 2, "topic continuation to start");
    await waitForCondition(
      () => store.getRunIntervention(guidance.replyDispatch.intervention.id)?.continuationRunId,
      "topic continuation to link",
    );
    const intervention = store.getRunIntervention(guidance.replyDispatch.intervention.id);
    const continuationRun = store.getRun(intervention.continuationRunId);
    assert.equal(continuationRun.threadId, topicRun.threadId);
    assert.equal(continuationRun.requestSnapshot.sourceMessageId, guidance.message.id);
    runner.resolve("Topic continuation reply");
  } finally {
    for (let index = 0; index < 3; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator queues attachment-only active run guidance", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-attachment-followup-"));
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
    const run = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_ling_agent_coordinator_attachment_followup",
      taskId: "task_ling_agent_coordinator_attachment_followup",
    });
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "followup.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("active run follow-up context", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      attachmentIds: [attachment.id],
      replyDisposition: { mode: "queue_followup", activeRunId: run.id },
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.replyDispatch.disposition, "followup_queued");
    assert.equal(created.replyDispatch.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.sourceRunId, run.id);
    assert.deepEqual(created.replyDispatch.intervention.messagePayload.attachmentIds, [attachment.id]);
    assert.equal(created.replyDispatch.intervention.messagePayload.body, "");
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator queues file-ref-only active run guidance", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-file-ref-followup-"));
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
    const run = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_ling_agent_coordinator_file_ref_followup",
      taskId: "task_ling_agent_coordinator_file_ref_followup",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      fileRefs: [{ path: "README.md", label: "README.md", source: "composer" }],
      replyDisposition: { mode: "queue_followup", activeRunId: run.id },
    });

    assert.equal(created.aiReply, undefined);
    assert.deepEqual(created.message.fileRefs, [{ path: "README.md", label: "README.md", source: "composer" }]);
    assert.equal(created.replyDispatch.disposition, "followup_queued");
    assert.equal(created.replyDispatch.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.messagePayload.body, "");
    assert.deepEqual(created.replyDispatch.intervention.messagePayload.attachmentIds, []);
    assert.deepEqual(created.replyDispatch.intervention.messagePayload.linkPreviewIds, []);
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].path, "README.md");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].rootRelation, "inside_workspace");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].kind, "file");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].materializationStatus, "metadata_only");
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent turn envelope merges persisted and explicit text file refs safely", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-turn-file-refs-"));
  await writeFile(resolve(cwd, "README.md"), "# Current README\n", "utf8");
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({
      name: "Ling Agent File Refs",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
    }, "2026-06-11T00:00:00.000Z");
    const message = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-input-materialization-cache-"));
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

    const message = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-image-vision-inline-cache-"));
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
    const message = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-image-vision-content-cache-"));
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
    const firstMessage = appendChannelItemFixture(store, {
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
    const secondMessage = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-image-vision-timeout-retry-"));
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
    const message = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-image-vision-"));
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

test("A11 preview and body fresh native connections consume audited DNS addresses", () => {
  for (const caseName of ["preview-native", "body-native"]) {
    const childEnv = { ...process.env, LING_A11_SOCKET_CASE: caseName };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^A11 fixture child$",
      new URL("./media-native-transport.test.mjs", import.meta.url).pathname], {
      env: childEnv, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.error, undefined, `${caseName}: ${result.error?.message}`);
    assert.match(result.stdout, new RegExp(`A11 child entered: ${caseName}`), "child must execute its socket assertions");
    assert.equal(result.status, 0, `${caseName}\n${result.stdout}\n${result.stderr}`);
  }
});

test("inline materialization writes public link body cache for explicit link request", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-link-body-inline-cache-"));
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
    const message = appendChannelItemFixture(store, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-link-body-cached-reply-"));
  const runner = new ScriptedRunner(["这个页面讲的是 cached public link body。"]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { defaultWorkspaceCwd: cwd });
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this link",
      linkPreviewIds: [linkPreview.id],
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "这个页面讲的是 cached public link body。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Cached public link body for Ling to summarize/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assertSingleReplyIntentDecision(intentDecisions.decisions, created.message.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pdf and OOXML extractors materialize bounded attachment text", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-document-extractors-"));
  const store = createSqliteRunStore(cwd);
  const officeArtifacts = new OfficeArtifactService();
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
    assert.match(pdfResult.contentText, /Ling PDF fixture/);
    assert.equal(pdfResult.structuredSummary.pageCount, 1);

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

    const pptxPath = resolve(store.paths.attachmentsDir, "slides.pptx");
    await officeArtifacts.createPresentation(cwd, {
      path: pptxPath,
      title: "Ling Office fixture",
      slides: [{ title: "Native presentation", bullets: ["Bounded extraction"] }],
    });
    const pptxBytes = await readFile(pptxPath);
    const pptxAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "office",
      fileName: "slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: pptxBytes.byteLength,
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
      maxBytes: 512 * 1024,
      maxChars: 100,
      now: "2026-06-11T00:06:00.000Z",
      attachment: pptxAttachment,
      attachmentsDir: store.paths.attachmentsDir,
    });
    assert.equal(pptxResult.status, "available", JSON.stringify(pptxResult));
    assert.match(pptxResult.contentText, /Native presentation/u);
    assert.deepEqual(pptxResult.structuredSummary, { format: "pptx", warnings: [] });

    const xlsxPath = resolve(store.paths.attachmentsDir, "metrics.xlsx");
    await officeArtifacts.createWorkbook(cwd, {
      path: xlsxPath,
      sheets: [{ name: "Summary", rows: [["Metric", "Value"], ["Active users", 42]] }],
    });
    const xlsxBytes = await readFile(xlsxPath);
    const xlsxAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "office",
      fileName: "metrics.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: xlsxBytes.byteLength,
      path: "metrics.xlsx",
      createdAt: "2026-06-11T00:07:00.000Z",
    });
    const xlsxResult = await officeExtractorV1.materialize({
      workspaceId: xlsxAttachment.workspaceId,
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: xlsxAttachment.id,
      sourceFingerprint: "xlsx-fingerprint",
      requestedBy: "turn_envelope",
      maxBytes: 512 * 1024,
      maxChars: 100,
      now: "2026-06-11T00:08:00.000Z",
      attachment: xlsxAttachment,
      attachmentsDir: store.paths.attachmentsDir,
    });
    assert.equal(xlsxResult.status, "available", JSON.stringify(xlsxResult));
    assert.match(xlsxResult.contentText, /Active users/u);
    assert.deepEqual(xlsxResult.structuredSummary, { format: "xlsx", warnings: [] });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inline materialization writes pdf and docx cache for current-turn attachments", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-document-inline-cache-"));
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
    const message = appendChannelItemFixture(store, {
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
    assert.match(pdfRows[0].contentText, /Ling PDF fixture/);

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
    assert.match(envelope.attachments[0].previewText, /Ling PDF fixture/);
    assert.match(envelope.attachments[1].previewText, /Walking on imported air/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("materialized pdf and docx attachments let Ling answer without materialization clarify", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-document-materialized-reply-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this PDF and this document",
      attachmentIds: [pdfAttachment.id, docxAttachment.id],
    });

    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "我读到了 PDF 和 DOCX 的正文。");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Ling PDF fixture/);
    assert.match(runner.runs[0].task.prompt, /Walking on imported air/);
    const pdfPreview = await getJson(`${daemon.url}/attachments/${encodeURIComponent(pdfAttachment.id)}/preview?cwd=${encodeURIComponent(cwd)}&scope=channel&channelId=${encodeURIComponent(channel.id)}`);
    assert.equal(pdfPreview.kind, "pdf");
    assert.match(pdfPreview.text, /Ling PDF fixture/);
    const docxPreview = await getJson(`${daemon.url}/attachments/${encodeURIComponent(docxAttachment.id)}/preview?cwd=${encodeURIComponent(cwd)}&scope=channel&channelId=${encodeURIComponent(channel.id)}`);
    assert.equal(docxPreview.kind, "office");
    assert.match(docxPreview.text, /Walking on imported air/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assertSingleReplyIntentDecision(intentDecisions.decisions, created.message.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("materialized image attachment lets Ling answer without materialization clarify", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-image-materialized-reply-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assertSingleReplyIntentDecision(intentDecisions.decisions, created.message.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider-backed image materialization works without injected summarizer", async (t) => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-provider-backed-image-materialization-"));
  const relay = await startMockOpenAICompatibleServer(t, {
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator preserves materialized guidance metadata for active run continuation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-materialized-guidance-"));
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
    const run = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_ling_agent_materialized_guidance",
      taskId: "task_ling_agent_materialized_guidance",
    });
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "另外也更新 file:README.md",
      attachmentIds: [attachment.id],
      linkPreviewIds: [linkPreview.id],
      replyDisposition: { mode: "queue_followup", activeRunId: run.id },
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.replyDispatch.disposition, "followup_queued");
    assert.equal(created.replyDispatch.intervention.sourceRunId, run.id);
    assert.deepEqual(created.replyDispatch.intervention.messagePayload.attachmentIds, [attachment.id]);
    assert.deepEqual(created.replyDispatch.intervention.messagePayload.linkPreviewIds, [linkPreview.id]);
    assert.equal(created.replyDispatch.intervention.messagePayload.attachments[0].fileName, "followup.txt");
    assert.equal(created.replyDispatch.intervention.messagePayload.attachments[0].materializationStatus, "available");
    assert.match(created.replyDispatch.intervention.messagePayload.attachments[0].previewText, /active run follow-up context/);
    assert.equal(created.replyDispatch.intervention.messagePayload.linkPreviews[0].title, "Example Docs");
    assert.equal(created.replyDispatch.intervention.messagePayload.linkPreviews[0].materializationStatus, "metadata_only");
    assert.match(created.replyDispatch.intervention.messagePayload.linkPreviews[0].previewText, /Cached link-preview metadata only/);
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].path, "README.md");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].rootRelation, "inside_workspace");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].kind, "file");
    assert.equal(created.replyDispatch.intervention.messagePayload.fileRefs[0].materializationStatus, "metadata_only");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ling agent coordinator treats redirect-like text as queued guidance", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ling-agent-coordinator-redirect-"));
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
    const run = createActiveChannelReplyRunFixture(store, {
      cwd,
      channelId: channel.id,
      runId: "run_ling_agent_coordinator_redirect",
      taskId: "task_ling_agent_coordinator_redirect",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "停，改用 daemon API",
      replyDisposition: { mode: "queue_followup", activeRunId: run.id },
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.replyDispatch.disposition, "followup_queued");
    assert.equal(created.replyDispatch.sourceRunId, run.id);
    assert.equal(created.replyDispatch.intervention.mode, "queue_followup");
    assert.equal(created.replyDispatch.intervention.instruction, "停，改用 daemon API");
    assert.equal(store.getRun(run.id).status, "running");
    assert.deepEqual(store.listRunInterventions({ sourceRunId: run.id }).map((item) => item.id), [created.replyDispatch.intervention.id]);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel reply guidance drains FIFO without interrupting and projects every continuation reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-guidance-fifo-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
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
    const designerProvider = (await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Designer Static Chat",
      providerId: "designer-static-chat",
      model: "designer-static-model",
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await postJson(`${daemon.url}/providers/${encodeURIComponent(designerProvider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Channel reply guidance FIFO",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;
    const designerId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(designerId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: designerProvider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(designerId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);

    const source = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Start a delayed Ling reply.",
      requestAiReply: true,
      teammateId: "ling_agent",
      providerPresetId: provider.id,
    });
    assert.equal(source.aiReply.status, "pending");
    await waitForCondition(() => runner.runs.length === 1, "source channel reply to start");
    const sourceRun = store.listRuns({ limit: 20 })
      .find((run) => run.channelId === channel.id && !run.parentRunId);
    assert.ok(sourceRun);
    const sourceMessage = getChannelItemViewFixture(store, sourceRun.requestSnapshot.sourceMessageId);
    assert.ok(sourceMessage);
    assert.equal(findActiveChannelReplyRun({
      store,
      channelId: channel.id,
      sourceMessage,
      activeRunId: sourceRun.id,
    })?.id, sourceRun.id);

    const queuedInputs = [
      {
        body: "@Designer queued channel guidance one.",
        mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
        targetTeammateId: designerId,
      },
      {
        body: "Queued channel guidance two.",
        mentions: [],
        targetTeammateId: "ling_agent",
      },
    ];
    const queued = [];
    for (const queuedInput of queuedInputs) {
      const response = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
        body: queuedInput.body,
        mentions: queuedInput.mentions,
        requestAiReply: true,
        providerPresetId: provider.id,
        replyDisposition: { mode: "queue_followup", activeRunId: sourceRun.id },
      });
      assert.equal(response.replyDispatch.disposition, "followup_queued");
      assert.equal(response.replyDispatch.targetTeammateId, queuedInput.targetTeammateId);
      assert.equal(response.replyDispatch.intervention.messagePayload.targetTeammateId, queuedInput.targetTeammateId);
      queued.push(response);
    }
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.abortCount, 0);
    const queuedMessageIds = new Set(queued.map((response) => response.message.id));
    const whileQueued = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(whileQueued.messages.filter((message) => queuedMessageIds.has(message.id)), []);

    runner.resolve("Initial channel reply");
    await waitForCondition(() => runner.runs.length === 2, "first channel continuation to start");
    assert.match(runner.runs[1].task.prompt, /@Designer queued channel guidance one\./);
    assert.equal(readCurrentChannelUserMessage(runner.runs[1].task.prompt), queuedInputs[0].body);
    await waitForCondition(
      () => store.getRunIntervention(queued[0].replyDispatch.intervention.id)?.continuationRunId,
      "first channel continuation to link",
    );
    const firstContinuation = store.getRun(
      store.getRunIntervention(queued[0].replyDispatch.intervention.id).continuationRunId,
    );
    assert.equal(firstContinuation.teammateId, designerId);
    assert.equal(firstContinuation.providerPresetId, designerProvider.id);
    assert.doesNotMatch(runner.runs[1].task.prompt, /Continue a Ling Stack supervised run from preserved context\./);
    assert.match(runner.runs[1].systemPrompt, /Treat the latest queued follow-up as the current user message/);
    const whileFirstRuns = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(
      whileFirstRuns.messages.filter((message) => queuedMessageIds.has(message.id)).map((message) => message.id),
      [queued[0].message.id],
    );
    runner.resolve("First channel continuation reply");

    await waitForCondition(() => runner.runs.length === 3, "second channel continuation to start");
    assert.match(runner.runs[2].task.prompt, /Queued channel guidance two\./);
    assert.equal(readCurrentChannelUserMessage(runner.runs[2].task.prompt), queuedInputs[1].body);
    await waitForCondition(
      () => store.getRunIntervention(queued[1].replyDispatch.intervention.id)?.continuationRunId,
      "second channel continuation to link",
    );
    const secondContinuation = store.getRun(
      store.getRunIntervention(queued[1].replyDispatch.intervention.id).continuationRunId,
    );
    assert.equal(secondContinuation.teammateId, "ling_agent");
    assert.equal(secondContinuation.providerPresetId, provider.id);
    assert.doesNotMatch(runner.runs[2].task.prompt, /Continue a Ling Stack supervised run from preserved context\./);
    assert.match(runner.runs[2].systemPrompt, /Treat the latest queued follow-up as the current user message/);
    assert.match(
      runner.runs[2].task.prompt,
      /Conversation context selected by Continuity v2[\s\S]*First channel continuation reply/,
    );
    runner.resolve("Second channel continuation reply");

    await waitForCondition(
      () => store.listRunInterventions({ sourceRunId: queued[0].replyDispatch.sourceRunId }).every((item) => item.completedAt),
      "channel guidance interventions to complete",
    );
    const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    const visibleAiBodies = listed.messages
      .filter((message) => message.authorType === "ai-teammate" && message.status === "ready")
      .map((message) => message.body);
    assert.deepEqual(visibleAiBodies, [
      "Initial channel reply",
      "First channel continuation reply",
      "Second channel continuation reply",
    ]);
    for (const [index, response] of queued.entries()) {
      const intervention = store.getRunIntervention(response.replyDispatch.intervention.id);
      assert.equal(intervention.status, "started");
      assert.ok(intervention.completedAt);
      assert.equal(intervention.messagePayload.sourceMessageId, response.message.id);
      const continuationRun = store.getRun(intervention.continuationRunId);
      const continuationWorkUnit = store.getWorkUnit(intervention.continuationWorkUnitId);
      assert.equal(continuationRun.status, "succeeded");
      assert.equal(continuationWorkUnit.ownerId, response.message.id);
      assert.ok(continuationWorkUnit.linkedMessageId);
      const reply = getChannelItemViewFixture(store, continuationWorkUnit.linkedMessageId);
      assert.equal(reply.body, `${index === 0 ? "First" : "Second"} channel continuation reply`);
      assert.equal(reply.linkedRunId, continuationRun.id);
    }
    assert.equal(runner.abortCount, 0);
  } finally {
    for (let index = 0; index < 3; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel reply guidance continues draining after the first continuation fails to start", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-guidance-start-failure-"));
  const runner = new AbortableDelayedRunner();
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
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Channel reply guidance start failure",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);

    await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Start a delayed reply before draining guidance.",
      requestAiReply: true,
      providerPresetId: provider.id,
    });
    await waitForCondition(() => runner.runs.length === 1, "source reply to start before failure drain");
    const sourceRun = store.listRuns({ limit: 20 }).find((run) => run.channelId === channel.id && !run.parentRunId);
    assert.ok(sourceRun);

    const invalid = store.createRunIntervention({
      sourceRunId: sourceRun.id,
      mode: "queue_followup",
      instruction: "This source message is intentionally missing.",
      messagePayload: {
        sourceMessageId: "msg_missing_guidance_source",
        targetTeammateId: "ling_agent",
        body: "This source message is intentionally missing.",
        attachmentIds: [],
        linkPreviewIds: [],
      },
      idempotencyKey: "channel_message:msg_missing_guidance_source:queue_followup",
      requestedBy: "local-user",
    }, "2026-08-08T00:00:00.000Z");
    const valid = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "This second queued message must still run.",
      requestAiReply: true,
      providerPresetId: provider.id,
      replyDisposition: { mode: "queue_followup", activeRunId: sourceRun.id },
    });
    assert.equal(valid.replyDispatch.disposition, "followup_queued");

    runner.resolve("Initial reply before failure drain");
    await waitForCondition(
      () => store.getRunIntervention(invalid.id)?.status === "failed",
      "invalid first guidance to fail",
    );
    await waitForCondition(() => runner.runs.length === 2, "second guidance to start after first failure");
    assert.match(runner.runs[1].task.prompt, /This second queued message must still run\./);
    const validInterventionId = valid.replyDispatch.intervention.id;
    await waitForCondition(
      () => Boolean(store.getRunIntervention(validInterventionId)?.continuationRunId),
      "second guidance continuation to link after first failure",
    );
    assert.equal(store.getRunIntervention(invalid.id)?.failureReason.includes("invalid"), true);
    assert.equal(store.getRunIntervention(validInterventionId)?.status, "started");
    runner.resolve("Second guidance completed");
  } finally {
    for (let index = 0; index < 3; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued channel source stays hidden while dispatch classification is still in flight", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-classification-visibility-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const stores = new Map();
  let releaseVision;
  let visionStartedCount = 0;
  const visionRelease = new Promise((resolve) => {
    releaseVision = resolve;
  });
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
    imageVisionSummarizer: async () => {
      visionStartedCount += 1;
      await visionRelease;
      return {
        contentText: "A screenshot used to hold dispatch classification open.",
        structuredSummary: { source: "classification_visibility_test" },
      };
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Classification visibility",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;
    const source = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Start a delayed reply before classification visibility is tested.",
      requestAiReply: true,
      teammateId: "ling_agent",
      providerPresetId: provider.id,
    });
    assert.equal(source.aiReply.status, "pending");
    await waitForCondition(() => runner.runs.length === 1, "source channel reply to start");

    const store = stores.get(cwd);
    assert.ok(store);
    const sourceRun = store.listRuns({ limit: 20 })
      .find((run) => run.channelId === channel.id && run.requestSnapshot.sourceMessageId === source.message.id);
    assert.ok(sourceRun);
    await mkdir(store.paths.attachmentsDir, { recursive: true });
    await writeFile(resolve(store.paths.attachmentsDir, "classification.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "image",
      fileName: "classification.png",
      contentType: "image/png",
      sizeBytes: 8,
      path: "classification.png",
      createdAt: new Date().toISOString(),
    });
    const queuedBody = "Queue this message while dispatch classification is blocked.";
    const streamResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: queuedBody,
        attachmentIds: [attachment.id],
        requestAiReply: true,
        replyDisposition: { mode: "queue_followup", activeRunId: sourceRun.id },
      }),
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => visionStartedCount === 1, "classification image summarizer to start");

    const whileClassifying = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(whileClassifying.messages.some((message) => message.body === queuedBody), false);

    releaseVision();
    const events = parseSseEvents(await streamResponse.text());
    const terminal = events.at(-1);
    assert.equal(terminal.event, "done");
    assert.equal(terminal.data.replyDispatch.disposition, "followup_queued");
    const whileQueued = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(whileQueued.messages.some((message) => message.id === terminal.data.message.id), false);
  } finally {
    releaseVision?.();
    for (let index = 0; index < 3; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unmentioned channel guidance joins the pending Ling reply lane before its run is linked", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-pending-lane-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const stores = new Map();
  let webSearchCallCount = 0;
  let releaseWebSearch;
  const webSearchRelease = new Promise((resolve) => {
    releaseWebSearch = resolve;
  });
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    channelWebFetch: async () => {
      webSearchCallCount += 1;
      await webSearchRelease;
      return new Response(JSON.stringify({
        output_text: "Delayed web evidence.",
        output: [{
          type: "web_search_call",
          action: {
            type: "search",
            sources: [{ type: "url", url: "https://example.com/delayed", title: "Delayed source" }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai",
      displayName: "Delayed web reply",
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
      message: "Provider ready for pending reply lane test.",
      checkedAt: new Date().toISOString(),
    });
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);

    const sourcePromise = postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "查一下最新版本说明。",
      requestAiReply: true,
      providerPresetId: provider.id,
    });
    await waitForCondition(() => webSearchCallCount === 1, "source reply web search to start");
    const guidancePromise = postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "After that, reply only with pending lane guidance.",
      requestAiReply: true,
      providerPresetId: provider.id,
      replyDisposition: { mode: "queue_followup" },
    });

    releaseWebSearch();
    await waitForCondition(() => runner.runs.length === 1, "source Ling reply run to start");
    const sourceRun = store.listRuns({ teammateId: "ling_agent", limit: 20 })
      .find((run) => run.channelId === channel.id && !run.parentRunId);
    assert.ok(sourceRun);
    assert.equal(sourceRun.teammateId, "ling_agent");
    assert.ok(sourceRun.workUnitId);
    assert.equal(store.getWorkUnit(sourceRun.workUnitId).teammateId, "ling_agent");
    assert.equal(store.listRuns({ teammateId: "ai-teammate", limit: 20 }).length, 0);
    runner.resolve("Initial pending lane reply");
    const source = await sourcePromise;
    const guidance = await guidancePromise;
    assert.equal(source.aiReply.status, "pending");
    assert.equal(source.aiReply.authorId, "ling_agent");
    assert.equal(guidance.aiReply, undefined);
    assert.equal(guidance.replyDispatch.disposition, "followup_queued");
    assert.equal(guidance.replyDispatch.targetTeammateId, "ling_agent");
    assert.equal(guidance.replyDispatch.intervention.mode, "queue_followup");
    assert.equal(guidance.replyDispatch.intervention.messagePayload.sourceMessageId, guidance.message.id);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.abortCount, 0);

    await waitForCondition(() => runner.runs.length === 2, "pending lane continuation to start");
    assert.equal(readCurrentChannelUserMessage(runner.runs[1].task.prompt), guidance.message.body);
    runner.resolve("Pending lane guidance reply");
    await waitForCondition(() => store.getRunIntervention(guidance.replyDispatch.intervention.id)?.completedAt, "pending lane guidance to complete");
    assert.equal(runner.abortCount, 0);
  } finally {
    releaseWebSearch?.();
    for (let index = 0; index < 4; index += 1) {
      runner.resolve("cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel messages persist and AI blocker replies do not drop the user message", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-messages-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "请 @Engineer 完善频道需求",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.message.body, "请 @Engineer 完善频道需求");
    assert.equal(created.aiReply.status, "blocked");

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    assert.deepEqual(listed.messages.map((message) => message.id), [created.message.id, created.aiReply.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("known unavailable teammate is accepted and replayed as one typed Channel blocker", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-unavailable-participant-"));
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
    const channel = await createChannel(daemon.url, cwd);
    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "paused",
    });
    const body = {
      body: "@Engineer 请执行这个任务",
      mentions: [],
      requestAiReply: true,
      idempotencyKey: "unavailable-participant-replay",
    };

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, body);
    assert.equal(created.message.mentions[0].id, teammateId);
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, `participant_unavailable_in_channel:${teammateId}`);
    assert.match(created.aiReply.body, /当前无法在此频道参与/);

    const replay = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, body);
    assert.equal(replay.message.id, created.message.id);
    assert.equal(replay.aiReply.id, created.aiReply.id);
    assert.equal(runner.runs.length, 0);

    const store = stores.get(cwd);
    assert.ok(store);
    const sourceItem = store.getConversationItem(created.message.id);
    assert.ok(sourceItem?.turnId);
    const dispatch = store.findWorkUnitByIdempotency({
      kind: "channel_turn_dispatch",
      ownerType: "ling_turn",
      ownerId: sourceItem.turnId,
      idempotencyKey: `channel-turn-dispatch:${sourceItem.turnId}`,
    });
    assert.deepEqual(dispatch.request.unavailableRequestedParticipantIds, [teammateId]);
    assert.deepEqual(sourceItem.payload.mentions.map((mention) => mention.id), [teammateId]);
    assert.equal(dispatch.status, "succeeded");
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "blocked");
    const turnTransitions = await getJson(
      `${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=turn&entityId=${encodeURIComponent(sourceItem.turnId)}`,
    );
    assert.equal(turnTransitions.transitions.every((transition) => transition.entityType === "turn"), true);
    assert.equal(turnTransitions.transitions.every((transition) => transition.entityId === sourceItem.turnId), true);
    assert.equal(turnTransitions.transitions.some((transition) => transition.toStatus === "blocked"), true);
    assert.equal(store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
      .filter((item) => item.kind === "assistant_message").length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unavailable participant produces the same typed blocker over Channel SSE", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-unavailable-participant-sse-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      hidden: true,
    });
    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "@Engineer 请检查这个任务",
        mentions: [],
        requestAiReply: true,
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "blocked"]);
    assert.equal(events.at(-1).data.aiReply.status, "blocked");
    assert.equal(events.at(-1).data.aiReply.errorMessage, `participant_unavailable_in_channel:${teammateId}`);
    assert.deepEqual(events[0].data.message.mentions.map((mention) => mention.id), [teammateId]);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion uses the mentioned teammate provider preset", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-mentioned-teammate-provider-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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

test("an untrusted scripted channel adapter cannot publish Provider availability incidents", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-provider-runtime-incident-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
    assert.deepEqual(availability, [], "adapter error text is not an admitted SDK Provider failure fact");
    assert.deepEqual(store.listReliabilityIncidents({ agentId: teammateId, capabilityScope: "code", limit: 10 }), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus stays inert when the feature flag is disabled", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-observer-bus-off-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer 看一下这个实现边界",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready", created.message.threadId);
    const store = stores.get(cwd);
    assert.ok(store);
    assert.deepEqual(store.listChannelTeamEvidenceItems({ channelId: channel.id, limit: 10 }), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel observer bus writes bounded relevance evidence without visible observer messages", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-observer-bus-on-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-observer-bus-unavailable-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-observer-bus-provider-unavailable-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-observer-bus-provider-expired-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-web-search-context-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
    assert.ok(finalReply.linkedRunId);
    const run = store.getRun(finalReply.linkedRunId);
    assert.ok(run);
    assert.equal(run.status, "succeeded");
    assert.equal(run.workUnitId, workUnit.id);
    assert.equal(workUnit.linkedRunId, run.id);
    assert.equal(workUnit.linkedMessageId, finalReply.id);
    assert.equal(store.getLingThread(run.threadId)?.kind, "channel_discussion");
    assert.equal(store.listWorkUnits({ kind: "channel_ai_reply", linkedMessageId: finalReply.id, limit: 10 }).length, 1);
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
    assert.match(runner.runs[0].systemPrompt, /explain the limitation briefly in user-facing language/);
    assert.match(runner.runs[0].systemPrompt, /do not repeat provider, relay, or protocol diagnostics verbatim/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion blocks runner prompt envelope echoes", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-prompt-echo-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-message-stream-"));
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

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
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
    assert.deepEqual(events.map((event) => event.event), ["ready", "reply_pending", "ready", "run_linked", "delta", "done"]);
    assert.equal(events[0].data.message.body, "@Engineer 请流式回复");
    assert.equal(events[1].data.sourceItemId, events[0].data.message.id);
    assert.equal(events[1].data.targetTeammateId, "teammate_builtin_engineer");
    assert.ok(events[1].data.startedAt);
    assert.equal(events[2].data.aiReply.status, "pending");
    assert.equal(events[3].data.itemId, events[2].data.aiReply.id);
    assert.ok(events[3].data.linkedRunId);
    const { threadId, sourceMessageId, ...activeReplyWithoutLineage } = events[3].data.activeReply;
    assert.deepEqual(activeReplyWithoutLineage, {
      runId: events[3].data.linkedRunId,
      sourceRunId: events[3].data.linkedRunId,
      workUnitId: events[3].data.activeReply.workUnitId,
      channelId: channel.id,
      teammateId: "teammate_builtin_engineer",
      status: "queued",
      createdAt: events[3].data.activeReply.createdAt,
      updatedAt: events[3].data.activeReply.updatedAt,
    });
    assert.match(threadId, /^thread_/);
    assert.equal(sourceMessageId, events[0].data.message.id);
    assert.equal(threadId, events[2].data.aiReply.threadId);
    assert.ok(events[3].data.activeReply.workUnitId);
    assert.equal(JSON.stringify(events[3].data.activeReply).includes("prompt"), false);
    assert.equal(events[4].data.delta, "Streamed channel reply");
    assert.equal(events[4].data.body, "Streamed channel reply");
    assert.equal(events[5].data.aiReply.body, "Streamed channel reply");

    const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    const finalReply = listed.messages.find((message) => message.id === events[2].data.aiReply.id);
    assert.equal(finalReply.body, "Streamed channel reply");
    assert.equal(finalReply.status, "ready");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation stream materializes uploaded attachments into the run prompt", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-conversation-attachment-"));
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
        authorizationMode: "smart",
        workspaceAccessMode: "workspace_write",
      }),
    });

    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const initialReady = events.find((event) => event.event === "ready" && event.data.userMessage);
    assert.ok(initialReady);
    assert.equal(initialReady.data.userMessage.attachments[0].id, attachment.id);
    assert.equal(initialReady.data.userMessage.attachments[0].fileName, "notes.txt");
    const linkedReady = events.find((event) => event.event === "ready" && event.data.activeReply);
    assert.ok(linkedReady);
    assert.equal(linkedReady.data.activeReply.runId, linkedReady.data.runId);
    assert.equal(linkedReady.data.activeReply.sourceRunId, linkedReady.data.runId);
    assert.equal(linkedReady.data.activeReply.threadId, linkedReady.data.thread.id);
    assert.equal(linkedReady.data.activeReply.teammateId, "ling_agent");
    assert.equal(linkedReady.data.activeReply.status, "queued");
    assert.ok(linkedReady.data.activeReply.workUnitId);
    assert.equal(JSON.stringify(linkedReady.data.activeReply).includes("requestSnapshot"), false);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Attached files:/);
    assert.match(runner.runs[0].task.prompt, /Alpha decision: keep the shared composer contract\./);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Use English for user-visible output/);
    assert.ok(runner.runs[0].appendSystemPrompt.some((instruction) => /Default conversation tone: friendly\./.test(instruction)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((instruction) => /Match the language of the most recent user message/.test(instruction)));

    const done = events.find((event) => event.event === "done");
    assert.ok(done);
    assert.equal(done.data.run.requestSnapshot.lingConversationTone, "friendly");
    assert.equal(done.data.run.requestSnapshot.authorizationMode, "smart");
    assert.equal(done.data.run.requestSnapshot.workspaceAccessMode, "workspace_write");
    assert.equal(done.data.run.requestSnapshot.responseLanguage, "en-US");
    // System instructions are retained in the Runner input above but are
    // intentionally omitted from the public Run snapshot.
    assert.equal(done.data.run.requestSnapshot.appendSystemPrompt, undefined);

    const detail = await getJson(`${daemon.url}/conversations/${encodeURIComponent(initialReady.data.thread.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.defaults.authorizationMode, "smart");
    assert.equal(detail.defaults.workspaceAccessMode, "workspace_write");
    const userMessage = detail.messages.find((message) => message.id === initialReady.data.userMessage.id);
    assert.equal(userMessage.attachments[0].id, attachment.id);
    assert.deepEqual(detail.executionActions, []);

    const preview = await getJson(`${daemon.url}/attachments/${encodeURIComponent(attachment.id)}/preview?cwd=${encodeURIComponent(cwd)}&scope=conversation&threadId=${encodeURIComponent(initialReady.data.thread.id)}`);
    assert.equal(preview.kind, "plain_text");
    assert.match(preview.text, /Alpha decision/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel message stream hides unbound task proposal blocks without creating approvals", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-message-stream-proposal-"));
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

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
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
    assert.deepEqual(events.map((event) => event.event), ["ready", "reply_pending", "ready", "run_linked", "delta", "done"]);
    assert.doesNotMatch(JSON.stringify(events.map((event) => event.data)), /ling_task_proposal/);
    assert.equal(events[4].data.body, "可以开始。\n");
    assert.equal(events[5].data.aiReply.body, "可以开始。");

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(proposals.proposals.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI reply prompt carries projected segment context for short follow-ups", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-followup-context-"));
  const runner = new ScriptedRunner([
    "雨下到第三天，城里的钟停了。修表匠阿岚把怀表放进钟芯，世界重新开始走动。",
    "四百字版本",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const first = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "300字的小说",
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, first.aiReply.id, "ready");

    const second = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "400字",
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, second.aiReply.id, "ready");

    assert.equal(runner.runs.length, 2);
    assert.equal(runner.segmentationRuns.length, 1);
    assert.match(runner.runs[1].task.prompt, /Conversation context selected by Continuity v2/);
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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-plan-mode-prompt-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Plan the next implementation slice.",
      surface: { kind: "thread", threadId: thread.thread.id },
      providerPresetId: provider.id,
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready", created.message.threadId);

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
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reply-context-retry-"));
  const runner = new ScriptedRunner([
    new Error("context_length exceeded by test provider"),
    "Retry reply",
  ]);
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
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
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
    assert.notEqual(downgradedBudget.capabilitySource, "runtime_observed",
      "scripted error text permits a bounded reply retry, not Provider window learning");
    assert.equal(downgradedBudget.contextWindowTokens, 32768);
    const providerList = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    const persistedProvider = providerList.providers.find((item) => item.id === provider.id);
    assert.ok(persistedProvider);
    assert.equal(persistedProvider.contextWindow, undefined);
    assert.equal(persistedProvider.maxTokens, undefined);

    const summaries = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(summaries.contextSummaries.length, 0);
    const store = stores.get(cwd);
    assert.ok(store);
    const incidents = store.listAvailabilityIncidents({
      providerPresetId: provider.id,
      now: new Date().toISOString(),
      limit: 10,
    });
    assert.deepEqual(incidents, [], "only the trusted SDK admission seam can publish runtime availability");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel hard summary uses the effective workspace provider before dispatching a reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-proactive-summary-"));
  const runner = new SummaryAwareRunner();
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      contextWindow: 1_800,
      maxTokens: 512,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const thread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Proactive summary",
      objective: "Summarize before the provider rejects the prompt",
    }, "2026-08-10T06:00:00.000Z").thread;

    for (let index = 0; index < 10; index += 1) {
      const createdAt = new Date(Date.parse("2026-08-10T06:00:01.000Z") + index * 10_000).toISOString();
      const turn = store.appendConversationUserTurn({
        itemId: `item_proactive_summary_${index}`,
        turnId: `turn_proactive_summary_${index}`,
        channelId: channel.id,
        threadId: thread.id,
        title: `Historical fact ${index}`,
        userInstruction: `Historical fact ${index}`,
        payload: {
          body: `Historical fact ${index}: ${"x".repeat(900)}`,
          format: "plain_text",
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
        },
        idempotencyKey: `proactive-summary:${index}`,
      }, createdAt);
      const run = store.createRun({
        id: `run_proactive_summary_${index}`,
        cwd,
        taskId: `task_proactive_summary_${index}`,
        channelId: channel.id,
        threadId: thread.id,
        turnId: turn.turnId,
        providerName: "test",
        providerModel: "test",
        taskSnapshot: {
          id: `task_proactive_summary_${index}`,
          title: `Historical fact ${index}`,
          prompt: `Historical fact ${index}`,
        },
        providerSnapshot: { provider: "test", model: "test" },
        requestSnapshot: {
          cwd,
          task: {
            id: `task_proactive_summary_${index}`,
            title: `Historical fact ${index}`,
            prompt: `Historical fact ${index}`,
          },
        },
        createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
      });
      store.markRunStarted(run.id, new Date(Date.parse(createdAt) + 2_000).toISOString());
      store.markRunSucceeded(run.id, new Date(Date.parse(createdAt) + 3_000).toISOString());
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer continue from the durable summary.",
      mentions: [{ id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" }],
      teammateId: "teammate_builtin_engineer",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");

    const target = resolveChannelReplyExecutionTarget({
      store,
      channel,
      requestedTeammateId: "teammate_builtin_engineer",
    });
    assert.equal(target.providerPresetId, provider.id);
    const currentItem = store.getConversationItem(created.message.id);
    assert.ok(currentItem);
    const plan = planConversationContextSummary({
      store,
      sourceItemId: currentItem.id,
      inputBudgetTokens: resolveProviderContextBudget(provider, "channel_reply").inputBudgetTokens,
    });
    assert.equal(plan?.trigger, "hard");
    assert.equal(runner.summaryRuns.length, 1);
    assert.equal(runner.replyRuns.length, 1);
    const summaries = store.listConversationContextSummaries({ threadId: thread.id });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].objective, "Preserve the durable historical objective.");
    assert.ok(summaries[0].coveredThroughSequence < currentItem.sequence);
    assert.match(runner.replyRuns[0].task.prompt, /Preserve the durable historical objective/);
    const dispatch = store.findWorkUnitByIdempotency({
      kind: "channel_turn_dispatch", ownerType: "ling_turn", ownerId: currentItem.turnId,
      idempotencyKey: `channel-turn-dispatch:${currentItem.turnId}`,
    });
    assert.ok(dispatch);
    const summaryEvents = store.listRuntimeEvents(dispatch.id)
      .filter((event) => event.type === "work_unit_progress" && event.data.stage === "conversation_hard_summary");
    assert.deepEqual(summaryEvents.map((event) => event.data.status), ["completed"]);
    assert.equal(summaryEvents[0].attemptId, dispatch.activeAttemptId);
    assert.equal(summaryEvents[0].data.sourceItemId, currentItem.id);

    runner.failSummary = true;
    for (let index = 10; index < 20; index += 1) {
      const createdAt = new Date(Date.parse("2026-08-10T06:02:00.000Z") + index * 10_000).toISOString();
      const turn = store.appendConversationUserTurn({
        itemId: `item_proactive_summary_${index}`,
        turnId: `turn_proactive_summary_${index}`,
        channelId: channel.id,
        threadId: thread.id,
        title: `Historical fact ${index}`,
        userInstruction: `Historical fact ${index}`,
        payload: {
          body: `Historical fact ${index}: ${"x".repeat(900)}`,
          format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
        },
        idempotencyKey: `proactive-summary:${index}`,
      }, createdAt);
      const run = store.createRun({
        id: `run_proactive_summary_${index}`,
        cwd,
        taskId: `task_proactive_summary_${index}`,
        channelId: channel.id,
        threadId: thread.id,
        turnId: turn.turnId,
        providerName: "test",
        providerModel: "test",
        taskSnapshot: { id: `task_proactive_summary_${index}`, title: `Historical fact ${index}`, prompt: `Historical fact ${index}` },
        providerSnapshot: { provider: "test", model: "test" },
        requestSnapshot: { cwd, task: { id: `task_proactive_summary_${index}`, title: `Historical fact ${index}`, prompt: `Historical fact ${index}` } },
        createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
      });
      store.markRunStarted(run.id, new Date(Date.parse(createdAt) + 2_000).toISOString());
      store.markRunSucceeded(run.id, new Date(Date.parse(createdAt) + 3_000).toISOString());
    }
    const failedSummaryTurn = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer continue with the retained facts after summary failure.",
      mentions: [{ id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" }],
      teammateId: "teammate_builtin_engineer",
      requestAiReply: true,
    });
    const failedSource = store.getConversationItem(failedSummaryTurn.message.id);
    assert.ok(failedSource);
    const failedDispatch = store.findWorkUnitByIdempotency({
      kind: "channel_turn_dispatch", ownerType: "ling_turn", ownerId: failedSource.turnId,
      idempotencyKey: `channel-turn-dispatch:${failedSource.turnId}`,
    });
    assert.ok(failedDispatch);
    const failedEvents = store.listRuntimeEvents(failedDispatch.id)
      .filter((event) => event.type === "work_unit_progress" && event.data.stage === "conversation_hard_summary");
    assert.deepEqual(failedEvents.map((event) => event.data.status), ["generation_failed"]);
    assert.equal(failedEvents[0].data.fallback, "prepared_input_budget_gate");
    assert.equal(store.listConversationContextSummaries({ threadId: thread.id }).length, 1);
    const listedFallback = await waitForChannelMessageStatus(
      daemon.url, cwd, channel.id, failedSummaryTurn.aiReply.id, "ready", failedSummaryTurn.message.threadId,
    );
    const fallbackReply = listedFallback.messages.find((message) => message.id === failedSummaryTurn.aiReply.id);
    assert.equal(fallbackReply.body, "Reply after proactive summary.");
    assert.equal(runner.replyRuns.length, 2);
    const fallbackRun = runner.replyRuns[1];
    const preparedTokens = estimateTextTokens(fallbackRun.systemPrompt) + estimateTextTokens(fallbackRun.task.prompt);
    assert.ok(preparedTokens <= resolveProviderContextBudget(provider, "channel_reply").inputBudgetTokens);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel hard summary with no completed prefix records the limitation and blocks oversized input", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-no-summary-prefix-"));
  const runner = new SummaryAwareRunner();
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      contextWindow: 1_800, maxTokens: 512,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await setWorkspaceDefaultProvider(daemon.url, cwd, provider.id);
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `@Engineer analyze this full input: ${"x".repeat(12_000)}`,
      mentions: [{ id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" }],
      teammateId: "teammate_builtin_engineer",
      providerPresetId: provider.id,
      requestAiReply: true,
    });
    const listed = await waitForChannelMessageStatus(
      daemon.url, cwd, channel.id, created.aiReply.id, "blocked", created.message.threadId,
    );
    assert.match(listed.messages.find((message) => message.id === created.aiReply.id).body, /context budget/u);
    const store = stores.get(cwd);
    const source = store.getConversationItem(created.message.id);
    const dispatch = store.findWorkUnitByIdempotency({
      kind: "channel_turn_dispatch", ownerType: "ling_turn", ownerId: source.turnId,
      idempotencyKey: `channel-turn-dispatch:${source.turnId}`,
    });
    assert.ok(dispatch);
    const events = store.listRuntimeEvents(dispatch.id)
      .filter((event) => event.type === "work_unit_progress" && event.data.stage === "conversation_hard_summary");
    assert.deepEqual(events.map((event) => event.data.status), ["no_eligible_prefix"]);
    assert.equal(events[0].data.fallback, "prepared_input_budget_gate");
    assert.equal(runner.runs.length, 0);
    assert.equal(store.listRuns({ limit: 10 }).length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
