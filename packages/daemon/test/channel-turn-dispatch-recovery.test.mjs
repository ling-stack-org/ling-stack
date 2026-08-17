import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createRequiredParticipantManifestV1,
  createWorkflowParticipantAuthorityV1,
} from "../../contracts/dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { replayAcceptedChannelTurnDispatch } from "../dist/features/channels/channel-turn-dispatch-lifecycle.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";

for (const checkpoint of ["accepted", "intent_committed"]) {
  test(`daemon startup resumes a ${checkpoint} channel dispatch once and terminal replay stays idempotent`, async (t) => {
    const cwd = await mkdtemp(resolve(tmpdir(), `ling-channel-dispatch-${checkpoint}-`));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const seed = seedAcceptedDispatch(cwd, checkpoint === "intent_committed");
    const firstRunner = new RecoveryRunner("Recovered channel reply");
    const first = await startRecoveryDaemon(cwd, firstRunner);
    try {
      await waitUntil(() => first.store.getWorkUnit(seed.dispatchWorkUnitId)?.status === "succeeded");
      assertRecoveredExactlyOnce(first.store, seed);
      assert.equal(firstRunner.replyRuns.length, 1);
      assert.equal(firstRunner.segmentationRuns.length, 0);
    } finally {
      await first.daemon.stop();
    }

    const secondRunner = new RecoveryRunner("Duplicate reply must not run");
    const second = await startRecoveryDaemon(cwd, secondRunner);
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      assertRecoveredExactlyOnce(second.store, seed);
      assert.equal(secondRunner.replyRuns.length, 0);
      assert.equal(secondRunner.segmentationRuns.length, 0);
    } finally {
      await second.daemon.stop();
    }
  });
}

test("daemon startup replaces a stale reply child without duplicating its assistant item", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-dispatch-stale-child-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const seed = seedAcceptedDispatch(cwd, true, true);
  const runner = new RecoveryRunner("Recovered stale child reply");
  const recovered = await startRecoveryDaemon(cwd, runner);
  try {
    await waitUntil(() => recovered.store.getWorkUnit(seed.dispatchWorkUnitId)?.status === "succeeded");
    assertRecoveredExactlyOnce(recovered.store, seed, { expectedDispatchAttempts: 2, expectedReplyChildren: 2, expectedRuns: 2 });
    const childUnits = recovered.store.listWorkUnits({
      kind: "channel_ai_reply",
      linkedMessageId: seed.replyItemId,
      limit: 100,
    });
    assert.deepEqual(childUnits.map((workUnit) => workUnit.status).sort(), ["failed", "succeeded"]);
    assert.deepEqual(recovered.store.listRuns({ channelId: seed.channelId, limit: 100 }).map((run) => run.status).sort(), ["failed", "succeeded"]);
    assert.equal(runner.replyRuns.length, 1);
  } finally {
    await recovered.daemon.stop();
  }
});

test("an active reply child keeps dispatch ownership and idempotent observers do not duplicate work", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-dispatch-active-child-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const runner = new DelayedRecoveryRunner();
  const fixture = await startRecoveryDaemon(cwd, runner);
  try {
    const seeded = seedProviderAndChannel(fixture.store, cwd);
    const body = {
      body: "Keep this child active until the test releases it.",
      requestAiReply: true,
      providerPresetId: seeded.provider.id,
      idempotencyKey: "dispatch-active-child",
    };
    const first = await postJson(`${fixture.url}/channels/${encodeURIComponent(seeded.channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, body);
    await waitUntil(() => runner.replyRuns.length === 1);
    const replyItemId = first.assistantItems?.[0]?.id;
    assert.ok(replyItemId);
    const sourceItem = fixture.store.getConversationItem(first.userItem.id);
    assert.ok(sourceItem?.turnId);
    const dispatch = fixture.store.findWorkUnitByIdempotency({
      kind: "channel_turn_dispatch",
      ownerType: "ling_turn",
      ownerId: sourceItem.turnId,
      idempotencyKey: `channel-turn-dispatch:${sourceItem.turnId}`,
    });
    assert.equal(dispatch?.status, "running");
    assert.equal(fixture.store.listWorkUnits({ kind: "channel_ai_reply", linkedMessageId: replyItemId, limit: 100 }).length, 1);

    const replay = await postJson(`${fixture.url}/channels/${encodeURIComponent(seeded.channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, body);
    assert.equal(replay.userItem.id, first.userItem.id);
    assert.equal(replay.assistantItems?.[0]?.id, replyItemId);
    assert.equal(runner.replyRuns.length, 1);
    assert.equal(fixture.store.listRuns({ channelId: seeded.channel.id, limit: 100 }).length, 1);

    runner.release("Active child completed once.");
    await waitUntil(() => fixture.store.getWorkUnit(dispatch.id)?.status === "succeeded");
    assert.equal(fixture.store.getConversationItem(replyItemId)?.status, "committed");
    assert.equal(fixture.store.getLingTurn(sourceItem.turnId)?.status, "succeeded");
    assert.equal(fixture.store.listWorkUnits({ kind: "channel_ai_reply", linkedMessageId: replyItemId, limit: 100 }).length, 1);
    assert.equal(fixture.store.listRuns({ channelId: seeded.channel.id, limit: 100 }).length, 1);
  } finally {
    runner.release("cleanup");
    await fixture.daemon.stop();
  }
});

test("terminal dispatch replay restores every visible multi-reply including failures", async (t) => {
  const fixture = createReplayFixture(t, "multi-reply");
  const manifest = createRequiredParticipantManifestV1([
    replayParticipant("teammate_builtin_engineer", "engineer"),
    replayParticipant("teammate_builtin_qa", "qa"),
  ]);
  const replies = [
    appendReplayAssistant(fixture, "engineer", "teammate_builtin_engineer", "ready"),
    appendReplayAssistant(fixture, "qa", "teammate_builtin_qa", "failed"),
  ];
  fixture.store.createChannelIntentDecision({
    channelId: fixture.channel.id,
    sourceItemId: fixture.accepted.item.id,
    contextProjection: buildConversationContextProjection({
      store: fixture.store,
      sourceItemId: fixture.accepted.item.id,
      view: "selector",
    }).metadata,
    action: "visible_multi_reply",
    selectedTeammateIds: manifest.participants.map((participant) => participant.participantId),
    participantManifest: manifest,
    resultItemIds: replies.map((reply) => reply.id),
    reason: "Replay every visible reply.",
    status: "accepted",
    createdBy: "deterministic",
  }, "2026-08-17T00:00:10.000Z");

  const replay = replayAcceptedChannelTurnDispatch(fixture.store, fixture.accepted.item.id);
  assert.equal(replay.aiReply?.id, replies[0].id);
  assert.deepEqual(replay.aiReplies?.map((reply) => [reply.id, reply.status]), [
    [replies[0].id, "ready"],
    [replies[1].id, "failed"],
  ]);
});

test("terminal dispatch replay restores an auto-started workflow envelope", async (t) => {
  const fixture = createReplayFixture(t, "auto-workflow");
  const reply = appendReplayAssistant(fixture, "coordinator", "ling_agent", "ready");
  const proposal = fixture.store.createChannelExecutionProposal({
    channelId: fixture.channel.id,
    sourceMessageId: fixture.accepted.item.id,
    proposedByTeammateId: "ling_agent",
    title: "Create proof",
    prompt: "Create proof.js",
    assigneeTeammateId: "teammate_builtin_engineer",
    requiredTools: ["write"],
    status: "accepted",
  }, "2026-08-17T00:01:10.000Z");
  const workflow = fixture.store.createChannelWorkflow({
    channelId: fixture.channel.id,
    title: "Create proof",
    objective: "Create proof.js",
    status: "running",
    createdBy: "ling_agent",
    metadata: {
      sourceProposalId: proposal.id,
      sourceMessageId: fixture.accepted.item.id,
      sourceTurnId: fixture.accepted.turnId,
    },
  }, "2026-08-17T00:01:11.000Z");
  fixture.store.updateChannelExecutionProposal(proposal.id, {
    status: "accepted",
    linkedWorkflowId: workflow.id,
  }, "2026-08-17T00:01:11.500Z");
  const step = fixture.store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Engineer",
    prompt: "Create proof.js",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    participantAuthority: createWorkflowParticipantAuthorityV1({
      kind: "workflow_definition",
      origin: "workflow_graph",
      participantId: "teammate_builtin_engineer",
      sourceId: workflow.id,
    }),
  }, "2026-08-17T00:01:12.000Z");
  const manifest = createRequiredParticipantManifestV1([
    replayParticipant("teammate_builtin_engineer", "engineer", ["create_file"], "execution"),
  ]);
  fixture.store.createChannelIntentDecision({
    channelId: fixture.channel.id,
    sourceItemId: fixture.accepted.item.id,
    contextProjection: buildConversationContextProjection({
      store: fixture.store,
      sourceItemId: fixture.accepted.item.id,
      view: "selector",
    }).metadata,
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest: manifest,
    proposalId: proposal.id,
    workflowId: workflow.id,
    resultItemIds: [reply.id],
    execution: { operations: [{
      id: "create_file",
      kind: "file_create",
      targetKind: "file",
      targetRef: { type: "operation", id: "proof:create", label: "proof.js" },
      required: true,
      dependsOn: [],
    }] },
    reason: "Auto-started workflow.",
    status: "accepted",
    createdBy: "deterministic",
  }, "2026-08-17T00:01:13.000Z");

  const replay = replayAcceptedChannelTurnDispatch(fixture.store, fixture.accepted.item.id);
  assert.equal(replay.aiReply?.id, reply.id);
  assert.equal(replay.autoStartedWorkflow?.proposal.id, proposal.id);
  assert.equal(replay.autoStartedWorkflow?.workflow.id, workflow.id);
  assert.deepEqual(replay.autoStartedWorkflow?.workflowSteps.map((candidate) => candidate.id), [step.id]);
});

test("terminal dispatch replay preserves a failed-only assistant result", async (t) => {
  const fixture = createReplayFixture(t, "failed-reply");
  const failed = appendReplayAssistant(fixture, "failed", "ling_agent", "failed");

  const replay = replayAcceptedChannelTurnDispatch(fixture.store, fixture.accepted.item.id);
  assert.equal(replay.aiReply?.id, failed.id);
  assert.equal(replay.aiReply?.status, "failed");
});

function createReplayFixture(t, suffix) {
  const cwd = mkdtempSync(resolve(tmpdir(), `ling-channel-dispatch-replay-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-08-17T00:00:00.000Z";
  const { channel } = seedProviderAndChannel(store, cwd, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Dispatch replay",
    objective: "Replay the complete terminal result.",
  }, now).thread;
  const accepted = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Replay",
    userInstruction: "Replay",
    payload: {
      body: "Replay",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: `terminal-replay:${suffix}`,
    dispatch: { schemaVersion: 1, requestAiReply: true },
  }, "2026-08-17T00:00:01.000Z");
  return { cwd, store, channel, thread, accepted };
}

function appendReplayAssistant(fixture, suffix, actorId, status) {
  const item = fixture.store.appendConversationItem({
    id: `item_replay_${suffix}_${fixture.accepted.turnId}`,
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    turnId: fixture.accepted.turnId,
    kind: "assistant_message",
    status: status === "failed" ? "failed" : "committed",
    actorType: actorId === "ling_agent" ? "ling_agent" : "teammate",
    actorId,
    visibility: "channel",
    payload: {
      body: `${suffix} reply`,
      format: "markdown",
      streaming: false,
      deliveryStatus: status,
      ...(status === "failed" ? { errorMessage: `${suffix} failed` } : {}),
    },
    domainRefs: [{ type: "conversation_item", id: fixture.accepted.item.id }],
  }, "2026-08-17T00:00:05.000Z");
  return item;
}

function replayParticipant(participantId, role, requiredOperationIds = [], expectedOutcome = "discussion_reply") {
  return {
    participantId,
    role,
    requirement: "required",
    expectedOutcome,
    requiredOperationIds,
    requestedBy: "structured_mention",
  };
}

function seedAcceptedDispatch(cwd, withIntentCheckpoint, withStaleReplyChild = false) {
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-12T03:00:00.000Z";
    const { provider, channel } = seedProviderAndChannel(store, cwd, now);
    const thread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Dispatch recovery",
      objective: "Resume accepted turns after daemon restart.",
    }, now).thread;
    const accepted = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: thread.id,
      title: "Continue after restart",
      userInstruction: "Continue after restart",
      payload: {
        body: "Continue after restart",
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      idempotencyKey: `dispatch-recovery:${withIntentCheckpoint ? "intent" : "accepted"}`,
      dispatch: {
        schemaVersion: 1,
        requestAiReply: true,
        requestedProviderPresetId: provider.id,
      },
    }, "2026-08-12T03:00:01.000Z");
    if (withIntentCheckpoint) {
      store.createChannelIntentDecision({
        channelId: channel.id,
        sourceItemId: accepted.item.id,
        contextProjection: buildConversationContextProjection({
          store,
          sourceItemId: accepted.item.id,
          view: "selector",
        }).metadata,
        action: "reply",
        reason: "Intent was committed before the daemon stopped.",
        status: "accepted",
        createdBy: "deterministic",
      }, "2026-08-12T03:00:02.000Z");
    }
    const replyItemId = `item_channel_reply_${accepted.turnId}_ling_agent`;
    if (withStaleReplyChild) {
      store.createChannelMessageRouteDecision({
        channelId: channel.id,
        sourceMessageId: accepted.item.id,
        mode: "default_teammate",
        action: "reply",
        selectedTeammateId: "ling_agent",
        selectedProviderPresetId: provider.id,
        confidence: 1,
        reason: "Route was committed before the reply child started.",
        status: "accepted",
        createdBy: "deterministic",
      }, "2026-08-12T03:00:03.000Z");
      store.appendConversationItem({
        id: replyItemId,
        channelId: channel.id,
        threadId: thread.id,
        turnId: accepted.turnId,
        kind: "assistant_message",
        status: "pending",
        actorType: "ling_agent",
        actorId: "ling_agent",
        visibility: "channel",
        payload: {
          body: "AI teammate is preparing a reply...",
          format: "markdown",
          streaming: true,
          deliveryStatus: "pending",
        },
        domainRefs: [{ type: "conversation_item", id: accepted.item.id }],
        idempotencyKey: `assistant-reply:${replyItemId}`,
      }, "2026-08-12T03:00:04.000Z");
      const child = store.createWorkUnit({
        id: `work_unit_stale_child_${accepted.turnId}`,
        workspaceId: accepted.item.workspaceId,
        kind: "channel_ai_reply",
        ownerType: "channel_message",
        ownerId: accepted.item.id,
        channelId: channel.id,
        teammateId: "ling_agent",
        providerPresetId: provider.id,
        runnerId: "pi",
        effectiveRunnerId: "pi",
        idempotencyKey: `channel_ai_reply:${accepted.item.id}:${replyItemId}`,
        createdByActor: "system",
        request: { sourceMessageId: accepted.item.id, linkedMessageId: replyItemId },
        linkedMessageId: replyItemId,
        now: "2026-08-12T03:00:05.000Z",
      });
      startPersistedWorkUnit(store, child.id, "attempt_stale_child", "2026-08-12T03:00:06.000Z");
      const run = store.createRun({
        id: `run_stale_child_${accepted.turnId}`,
        cwd,
        taskId: accepted.item.id,
        channelId: channel.id,
        teammateId: "ling_agent",
        providerPresetId: provider.id,
        providerName: provider.providerId,
        providerModel: provider.model,
        taskSnapshot: { id: accepted.item.id, title: "Stale child" },
        providerSnapshot: { provider: provider.providerId, model: provider.model },
        requestSnapshot: { sourceMessageId: accepted.item.id, linkedMessageId: replyItemId },
        threadId: thread.id,
        turnId: accepted.turnId,
        workUnitId: child.id,
        createdAt: "2026-08-12T03:00:07.000Z",
      });
      store.linkRunToWorkUnit(run.id, child.id, "2026-08-12T03:00:08.000Z");
      store.markRunStarted(run.id, "2026-08-12T03:00:09.000Z");
      startPersistedWorkUnit(store, accepted.dispatchWorkUnitId, "attempt_stale_dispatch", "2026-08-12T03:00:10.000Z");
    }
    return {
      channelId: channel.id,
      turnId: accepted.turnId,
      sourceItemId: accepted.item.id,
      dispatchWorkUnitId: accepted.dispatchWorkUnitId,
      replyItemId,
      expectedIntentDecisionCount: 1,
    };
  } finally {
    store.close();
  }
}

function startPersistedWorkUnit(store, workUnitId, attemptId, now) {
  assert.equal(store.transitionWorkUnitStatus({
    workUnitId,
    expectedStatus: "queued",
    event: "claim",
    actor: "system",
    now,
  }).ok, true);
  const workUnit = store.getWorkUnit(workUnitId);
  assert.ok(workUnit);
  const attempt = store.createWorkUnitAttempt({
    id: attemptId,
    workUnitId,
    attemptNumber: workUnit.attemptCount + 1,
    runtimeInstanceId: "runtime_before_restart",
    runnerId: workUnit.effectiveRunnerId ?? workUnit.runnerId ?? "daemon",
    effectiveRunnerId: workUnit.effectiveRunnerId ?? workUnit.runnerId ?? "daemon",
    status: "started",
    now,
  });
  assert.equal(store.transitionWorkUnitStatus({
    workUnitId,
    expectedStatus: "claimed",
    event: "runner_started",
    actor: "system",
    activeAttemptId: attempt.id,
    startedAt: now,
    lastEventAt: now,
    lastHeartbeatAt: now,
    now,
  }).ok, true);
}

async function startRecoveryDaemon(cwd, runner) {
  let store;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { intentSelector: false, terminalReports: false },
  }, {
    runner,
    storeFactory: (storeCwd) => {
      store = createSqliteRunStore(storeCwd);
      return store;
    },
  });
  await daemon.start();
  assert.ok(store);
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return { daemon, store, url: `http://127.0.0.1:${address.port}` };
}

function seedProviderAndChannel(store, cwd, now = new Date().toISOString()) {
  const provider = store.createProviderPreset({
    kind: "glm",
    displayName: "Recovery provider",
    providerId: "recovery-provider",
    model: "recovery-model",
    api: "google-generative-ai",
    authHeader: false,
    capabilities: ["chat"],
    input: ["text"],
    enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, {
    ok: true,
    code: "ready",
    message: "Recovery provider is ready.",
    checkedAt: now,
  });
  const channel = store.createChannel({
    name: "Dispatch recovery",
    status: "active",
    boundPath: cwd,
    defaultProviderPresetId: provider.id,
    allowedTools: ["read"],
  }, now);
  return { provider, channel };
}

function assertRecoveredExactlyOnce(store, seed, options = {}) {
  const dispatch = store.getWorkUnit(seed.dispatchWorkUnitId);
  assert.equal(dispatch?.status, "succeeded");
  assert.equal(store.listWorkUnitAttempts(seed.dispatchWorkUnitId).length, options.expectedDispatchAttempts ?? 1);
  const turn = store.getLingTurn(seed.turnId);
  assert.equal(turn?.status, "succeeded", JSON.stringify({
    turn,
    runs: store.listRuns({ channelId: seed.channelId, limit: 100 }),
    children: store.listWorkUnits({ kind: "channel_ai_reply", linkedMessageId: seed.replyItemId, limit: 100 }),
  }));

  const items = store.listConversationItemsByChannelPage({
    channelId: seed.channelId,
    kinds: ["user_message", "assistant_message"],
    effectiveOnly: true,
    limit: 100,
  }).items;
  assert.deepEqual(items.filter((item) => item.kind === "user_message").map((item) => item.id), [seed.sourceItemId]);
  assert.deepEqual(items.filter((item) => item.kind === "assistant_message").map((item) => item.id), [seed.replyItemId]);
  assert.equal(store.getConversationItem(seed.replyItemId)?.status, "committed");

  assert.equal(store.listChannelIntentDecisions({
    channelId: seed.channelId,
    sourceItemId: seed.sourceItemId,
    limit: 100,
  }).length, seed.expectedIntentDecisionCount);
  assert.equal(store.listChannelMessageRouteDecisions({
    channelId: seed.channelId,
    sourceMessageId: seed.sourceItemId,
    limit: 100,
  }).length, 1);
  assert.equal(store.listWorkUnits({
    kind: "channel_ai_reply",
    linkedMessageId: seed.replyItemId,
    limit: 100,
  }).length, options.expectedReplyChildren ?? 1);
  assert.equal(store.listRuns({ channelId: seed.channelId, limit: 100 }).length, options.expectedRuns ?? 1);
  assert.equal(store.listChannelExecutionProposals({
    channelId: seed.channelId,
    sourceMessageId: seed.sourceItemId,
    limit: 100,
  }).length, 0);
  assert.equal(store.listChannelWorkflows({ channelId: seed.channelId, limit: 100 }).length, 0);
}

class RecoveryRunner {
  constructor(replyText) {
    this.replyText = replyText;
    this.segmentationRuns = [];
    this.replyRuns = [];
  }

  async runTask(options) {
    const segmentation = /context segmentation policy proposer/i.test(options.systemPrompt ?? "");
    const text = segmentation
      ? JSON.stringify({ action: "uncertain", candidateSegmentIds: [] })
      : this.replyText;
    (segmentation ? this.segmentationRuns : this.replyRuns).push(options);
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }
}

class DelayedRecoveryRunner extends RecoveryRunner {
  constructor() {
    super("");
    this.resolveReply = undefined;
  }

  async runTask(options) {
    if (/context segmentation policy proposer/i.test(options.systemPrompt ?? "")) {
      return await super.runTask(options);
    }
    this.replyRuns.push(options);
    const text = await new Promise((resolveReply) => {
      this.resolveReply = resolveReply;
    });
    options.onEvent?.({ type: "assistant_text_delta", text });
    return { taskId: options.task.id, messages: [text], events: [] };
  }

  release(text) {
    this.resolveReply?.(text);
    this.resolveReply = undefined;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail("Timed out waiting for recovered channel dispatch.");
}
