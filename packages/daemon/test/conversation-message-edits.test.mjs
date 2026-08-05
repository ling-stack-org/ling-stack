import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createBuiltinAiTeammateId, createSqliteRunStore, LING_AGENT_ID } from "@ling-stack/core";
import { editConversationMessage } from "../dist/features/conversations/message-edits.js";
import { buildConversationDetail, startConversationReplacementRun } from "../dist/features/conversations/routes.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededChannelMessages,
  filterSupersededTeammateDirectMessages,
} from "../dist/features/conversations/supersession-projection.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";

const emptyEditFields = {
  mentions: [],
  attachmentIds: [],
  linkPreviewIds: [],
  fileRefs: [],
};

test("conversation replacement preflight failure does not leave an orphan turn", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-replacement-preflight-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: LING_AGENT_ID,
      title: "Replacement preflight",
      objective: "Replacement preflight",
    }, "2026-07-12T02:59:00.000Z");

    await assert.rejects(
      startConversationReplacementRun({
        store,
        workspaceCwd: cwd,
        thread,
        message: "Edited request",
        messageId: "conversation-user:original",
        attachmentIds: [],
        runnerRegistry: undefined,
        startRun: async () => undefined,
      }),
      /No provider preset is available/,
    );

    assert.deepEqual(store.listLingTurns({ threadId: thread.id, limit: 20 }), []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("normal conversation edit supersedes the latest turn, cancels its run, and starts replacement in the same thread", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-normal-conversation-edit-"));
  const store = createSqliteRunStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: LING_AGENT_ID,
      title: "Original request",
      objective: "Original request",
    }, "2026-07-12T03:00:00.000Z");
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Original request",
      userInstruction: "Original request",
      teammateId: LING_AGENT_ID,
      createdByActor: "local-user",
    }, "2026-07-12T03:00:01.000Z");
    const run = store.createRun(createRunInput({
      id: "run_normal_edit_old",
      cwd,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-07-12T03:00:02.000Z",
    }));
    const abortController = new AbortController();
    activeRuns.add(run.id, { abortController, streamEnvelope() {} });

    let replacementThreadId;
    const result = await editConversationMessage(store, {
      surface: "normal_conversation",
      ownerId: thread.id,
      messageId: `conversation-user:${turn.id}`,
      expectedRevision: 1,
      body: "Revised request",
      idempotencyKey: "edit-normal-1",
    }, {
      activeRuns,
      startReplacement: async ({ editable, revision }) => {
        assert.equal(editable.surface, "normal_conversation");
        replacementThreadId = editable.thread.id;
        const replacement = store.createLingTurn({
          threadId: editable.thread.id,
          kind: "manual_followup",
          title: "Revised request",
          userInstruction: revision.body,
          teammateId: LING_AGENT_ID,
          createdByActor: "local-user",
        }, "2026-07-12T03:01:00.000Z");
        return { replacementTurnId: replacement.id };
      },
    });

    assert.equal(result.status, "replacement_started");
    assert.equal(result.message.revision, 2);
    assert.equal(result.message.body, "Revised request");
    assert.deepEqual(result.interruptedRunIds, [run.id]);
    assert.equal(replacementThreadId, thread.id);
    assert.equal(store.getLingTurn(turn.id)?.status, "superseded");
    assert.equal(store.getRun(run.id)?.status, "cancelled");
    assert.equal(abortController.signal.aborted, true);
    assert.equal(store.getLingTurn(result.replacementTurnId)?.threadId, thread.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("normal conversation edit rejects a historical user turn", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-normal-conversation-edit-stale-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({ kind: "conversation", title: "Conversation", objective: "Conversation" }, "2026-07-12T04:00:00.000Z");
    const first = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "First",
      userInstruction: "First",
      createdByActor: "local-user",
    }, "2026-07-12T04:00:01.000Z");
    store.createLingTurn({
      threadId: thread.id,
      kind: "manual_followup",
      title: "Second",
      userInstruction: "Second",
      createdByActor: "local-user",
    }, "2026-07-12T04:00:02.000Z");

    await assert.rejects(
      () => editConversationMessage(store, {
        surface: "normal_conversation",
        ownerId: thread.id,
        messageId: `conversation-user:${first.id}`,
        expectedRevision: 1,
        body: "Edited first",
        idempotencyKey: "edit-normal-stale",
      }, {
        activeRuns: new ActiveRunRegistry(),
        startReplacement: async () => ({}),
      }),
      (error) => error?.code === "message_not_latest",
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pending replacement is retried idempotently without creating another revision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-edit-retry-"));
  const store = createSqliteRunStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  try {
    const thread = store.createLingThread({ kind: "conversation", title: "Retry", objective: "Retry" }, "2026-07-12T05:00:00.000Z");
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Retry",
      userInstruction: "Retry old",
      createdByActor: "local-user",
    }, "2026-07-12T05:00:01.000Z");
    const request = {
      surface: "normal_conversation",
      ownerId: thread.id,
      messageId: `conversation-user:${turn.id}`,
      expectedRevision: 1,
      body: "Retry revised",
      idempotencyKey: "edit-normal-retry",
    };

    const pending = await editConversationMessage(store, request, {
      activeRuns,
      startReplacement: async () => {
        throw new Error("provider temporarily unavailable");
      },
    });
    assert.equal(pending.status, "replacement_pending");
    assert.match(pending.failureReason, /temporarily unavailable/);
    const pendingUserMessage = buildConversationDetail(store, cwd, thread).messages.find((message) => message.id === request.messageId);
    assert.equal(pendingUserMessage?.revision, 2);
    assert.equal(pendingUserMessage?.editedAt, pending.message.createdAt);
    assert.equal(pendingUserMessage?.pendingReplacement?.idempotencyKey, request.idempotencyKey);
    assert.match(pendingUserMessage?.pendingReplacement?.failureReason ?? "", /temporarily unavailable/);

    const replay = await editConversationMessage(store, request, {
      activeRuns,
      startReplacement: async ({ editable, revision }) => {
        assert.equal(editable.surface, "normal_conversation");
        const replacement = store.createLingTurn({
          threadId: editable.thread.id,
          kind: "manual_followup",
          title: revision.body,
          userInstruction: revision.body,
          createdByActor: "local-user",
        }, "2026-07-12T05:01:00.000Z");
        return { replacementTurnId: replacement.id };
      },
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.status, "replacement_started");
    assert.equal(store.listConversationMessageRevisions({ surface: "normal_conversation", messageId: request.messageId }).length, 2);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent pending replacement retries share one replacement start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-edit-concurrent-retry-"));
  const store = createSqliteRunStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  try {
    const thread = store.createLingThread({ kind: "conversation", title: "Concurrent retry", objective: "Concurrent retry" }, "2026-07-12T05:10:00.000Z");
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Concurrent retry",
      userInstruction: "Old request",
      createdByActor: "local-user",
    }, "2026-07-12T05:10:01.000Z");
    const request = {
      surface: "normal_conversation",
      ownerId: thread.id,
      messageId: `conversation-user:${turn.id}`,
      expectedRevision: 1,
      body: "Revised request",
      idempotencyKey: "edit-normal-concurrent-retry",
    };
    await editConversationMessage(store, request, {
      activeRuns,
      startReplacement: async () => {
        throw new Error("provider temporarily unavailable");
      },
    });

    let startCount = 0;
    const dependencies = {
      activeRuns,
      startReplacement: async ({ editable, revision }) => {
        startCount += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        const replacement = store.createLingTurn({
          threadId: editable.thread.id,
          kind: "manual_followup",
          title: revision.body,
          userInstruction: revision.body,
          createdByActor: "local-user",
        }, "2026-07-12T05:11:00.000Z");
        return { replacementTurnId: replacement.id };
      },
    };
    const [first, second] = await Promise.all([
      editConversationMessage(store, request, dependencies),
      editConversationMessage(store, request, dependencies),
    ]);

    assert.equal(startCount, 1);
    assert.equal(first.status, "replacement_started");
    assert.equal(second.status, "replacement_started");
    assert.equal(first.replacementTurnId, second.replacementTurnId);
    assert.equal(store.listConversationMessageRevisions({ surface: "normal_conversation", messageId: request.messageId }).length, 2);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel and teammate-direct edits update their native messages before replacement starts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-native-message-edits-"));
  const store = createSqliteRunStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, "2026-07-12T06:00:00.000Z");
    const channelMessage = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Channel old",
    }, "2026-07-12T06:00:01.000Z");
    const channelResult = await editConversationMessage(store, {
      surface: "channel_root",
      ownerId: channel.id,
      messageId: channelMessage.id,
      expectedRevision: 1,
      body: "Channel revised",
      idempotencyKey: "edit-channel-native",
    }, {
      activeRuns,
      startReplacement: async ({ editable }) => {
        assert.equal(editable.surface, "channel_root");
        assert.equal(store.getChannelMessage(editable.messageId)?.body, "Channel revised");
        return {};
      },
    });
    assert.equal(channelResult.status, "replacement_started");

    const teammateId = createBuiltinAiTeammateId("engineer");
    const directThread = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-12T06:01:00.000Z");
    const directMessage = store.createTeammateDirectMessage({
      threadId: directThread.id,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "Private old",
    }, "2026-07-12T06:01:01.000Z");
    const directResult = await editConversationMessage(store, {
      surface: "teammate_direct",
      ownerId: teammateId,
      messageId: directMessage.id,
      expectedRevision: 1,
      body: "Private revised",
      idempotencyKey: "edit-direct-native",
    }, {
      activeRuns,
      startReplacement: async ({ editable }) => {
        assert.equal(editable.surface, "teammate_direct");
        assert.equal(store.getTeammateDirectMessage(editable.messageId)?.body, "Private revised");
        return {};
      },
    });
    assert.equal(directResult.status, "replacement_started");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct edits keep file references inside the private workspace", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-edit-file-scope-"));
  const store = createSqliteRunStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  try {
    const teammateId = createBuiltinAiTeammateId("engineer");
    const thread = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-12T06:30:00.000Z");
    const message = store.createTeammateDirectMessage({
      threadId: thread.id,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "Inspect the file",
    }, "2026-07-12T06:30:01.000Z");

    await assert.rejects(
      editConversationMessage(store, {
        surface: "teammate_direct",
        ownerId: teammateId,
        messageId: message.id,
        expectedRevision: 1,
        body: "Inspect the edited file",
        fileRefs: [{ path: "/etc/passwd", label: "passwd" }],
        idempotencyKey: "edit-direct-outside-file",
      }, {
        activeRuns,
        startReplacement: async () => {
          assert.fail("replacement must not start for an out-of-scope file reference");
        },
      }),
      /文件引用不在私聊工作区范围内/,
    );

    assert.equal(store.getTeammateDirectMessage(message.id)?.body, "Inspect the file");
    assert.equal(store.listConversationMessageRevisions({ surface: "teammate_direct", messageId: message.id }).length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default projections hide superseded turns and response messages while audit data remains stored", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-supersession-projection-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({ kind: "conversation", title: "Projection", objective: "Projection" }, "2026-07-12T07:00:00.000Z");
    const oldTurn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Old",
      userInstruction: "Old",
      createdByActor: "local-user",
    }, "2026-07-12T07:00:01.000Z");
    const replacementTurn = store.createLingTurn({
      threadId: thread.id,
      kind: "manual_followup",
      title: "Replacement",
      userInstruction: "Replacement",
      createdByActor: "local-user",
    }, "2026-07-12T07:00:02.000Z");
    store.commitConversationMessageEdit({
      surface: "normal_conversation",
      ownerId: thread.id,
      laneId: thread.id,
      messageId: `conversation-user:${oldTurn.id}`,
      expectedRevision: 1,
      current: { ...emptyEditFields, body: "Old" },
      replacement: { ...emptyEditFields, body: "Replacement" },
      supersededTurnId: oldTurn.id,
      supersededResponseMessageIds: [`conversation-assistant:${oldTurn.id}`],
      idempotencyKey: "projection-normal",
    }, "2026-07-12T07:00:03.000Z");

    const visible = buildConversationDetail(store, cwd, thread);
    const audit = buildConversationDetail(store, cwd, thread, { includeSuperseded: true });
    assert.deepEqual(visible.turns.map((turn) => turn.id), [replacementTurn.id]);
    assert.deepEqual(audit.turns.map((turn) => turn.id), [oldTurn.id, replacementTurn.id]);
    assert.equal(store.getLingTurn(oldTurn.id)?.status, "superseded");

    const channel = store.createChannel({ name: "Projection channel", boundPath: cwd }, "2026-07-12T07:01:00.000Z");
    const source = store.createChannelMessage({ channelId: channel.id, authorType: "local-user", body: "Source" }, "2026-07-12T07:01:01.000Z");
    const oldReply = store.createChannelMessage({
      channelId: channel.id,
      threadId: source.id,
      authorType: "ai-teammate",
      body: "Old reply",
    }, "2026-07-12T07:01:02.000Z");
    store.commitConversationMessageEdit({
      surface: "channel_root",
      ownerId: channel.id,
      laneId: channel.id,
      messageId: source.id,
      expectedRevision: 1,
      current: { ...emptyEditFields, body: "Source" },
      replacement: { ...emptyEditFields, body: "Source revised" },
      supersededResponseMessageIds: [oldReply.id],
      idempotencyKey: "projection-channel",
    }, "2026-07-12T07:01:03.000Z");
    const channelProjection = buildConversationSupersessionProjection(store, {
      surfaces: ["channel_root"],
      ownerId: channel.id,
    });
    assert.deepEqual(filterSupersededChannelMessages([source, oldReply], channelProjection).map((message) => message.id), [source.id]);
    assert.equal(store.getChannelMessage(oldReply.id)?.body, "Old reply");

    const teammateId = createBuiltinAiTeammateId("designer");
    const directThread = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-12T07:02:00.000Z");
    const directSource = store.createTeammateDirectMessage({
      threadId: directThread.id,
      teammateId,
      authorType: "local-user",
      body: "Direct source",
    }, "2026-07-12T07:02:01.000Z");
    const directReply = store.createTeammateDirectMessage({
      threadId: directThread.id,
      teammateId,
      authorType: "ai-teammate",
      body: "Direct old reply",
    }, "2026-07-12T07:02:02.000Z");
    store.commitConversationMessageEdit({
      surface: "teammate_direct",
      ownerId: teammateId,
      laneId: directThread.id,
      messageId: directSource.id,
      expectedRevision: 1,
      current: { ...emptyEditFields, body: "Direct source" },
      replacement: { ...emptyEditFields, body: "Direct source revised" },
      supersededResponseMessageIds: [directReply.id],
      idempotencyKey: "projection-direct",
    }, "2026-07-12T07:02:03.000Z");
    const directProjection = buildConversationSupersessionProjection(store, {
      surfaces: ["teammate_direct"],
      ownerId: teammateId,
      laneId: directThread.id,
    });
    assert.deepEqual(filterSupersededTeammateDirectMessages([directSource, directReply], directProjection).map((message) => message.id), [directSource.id]);
    assert.equal(store.getTeammateDirectMessage(directReply.id)?.body, "Direct old reply");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation detail projects approvals and queued guidance once with structured file references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-runtime-projection-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: LING_AGENT_ID,
      title: "Runtime projection",
      objective: "Runtime projection",
    }, "2026-07-12T08:00:00.000Z");
    const sourceTurn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Inspect the workspace",
      userInstruction: "Inspect the workspace",
      teammateId: LING_AGENT_ID,
      createdByActor: "local-user",
    }, "2026-07-12T08:00:01.000Z");
    const sourceRun = store.createRun(createRunInput({
      id: "run_conversation_projection_source",
      cwd,
      threadId: thread.id,
      turnId: sourceTurn.id,
      createdAt: "2026-07-12T08:00:02.000Z",
    }));
    const approval = store.createApprovalRequest({
      runId: sourceRun.id,
      taskId: sourceRun.taskId,
      toolCallId: "tool_conversation_projection",
      actionType: "bash",
      risk: "high",
      title: "Run workspace check",
      description: "Confirm the workspace check.",
      payload: { type: "bash", cwd, command: "git status --short", riskFlags: ["test"] },
    }, "2026-07-12T08:00:03.000Z");
    const intervention = store.createRunIntervention({
      sourceRunId: sourceRun.id,
      mode: "queue_followup",
      instruction: "Also inspect the release notes.",
      messagePayload: {
        body: "Also inspect the release notes.",
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [{
          path: "docs/RELEASE.md",
          label: "Release notes",
          rootRelation: "inside_workspace",
          kind: "file",
          materializationStatus: "not_loaded",
        }],
      },
      requestedBy: "local-user",
      idempotencyKey: "conversation-projection-guidance",
    }, "2026-07-12T08:00:04.000Z");

    const queued = buildConversationDetail(store, cwd, thread);
    assert.deepEqual(queued.approvals.map((item) => item.id), [approval.id]);
    assert.deepEqual(queued.interventions.map((item) => item.id), [intervention.id]);
    const guidanceId = `conversation-user:intervention:${intervention.id}`;
    const queuedGuidance = queued.messages.find((message) => message.id === guidanceId);
    assert.equal(queuedGuidance?.content, "Also inspect the release notes.");
    assert.deepEqual(queuedGuidance?.fileRefs, [{ path: "docs/RELEASE.md", label: "Release notes", source: "api" }]);

    const continuationTurn = store.createLingTurn({
      threadId: thread.id,
      kind: "manual_followup",
      title: "Continue the run",
      userInstruction: "Internal continuation prompt that must not leak into the transcript.",
      interventionId: intervention.id,
      sourceMessageId: guidanceId,
      teammateId: LING_AGENT_ID,
      createdByActor: "local-user",
    }, "2026-07-12T08:00:05.000Z");
    store.createRun({
      ...createRunInput({
        id: "run_conversation_projection_continuation",
        cwd,
        threadId: thread.id,
        turnId: continuationTurn.id,
        createdAt: "2026-07-12T08:00:06.000Z",
      }),
      parentRunId: sourceRun.id,
      interventionId: intervention.id,
      continuationReason: "queue_followup",
    });

    const continued = buildConversationDetail(store, cwd, thread);
    const projectedGuidance = continued.messages.filter((message) => message.id === guidanceId);
    assert.equal(projectedGuidance.length, 1);
    assert.equal(projectedGuidance[0].content, "Also inspect the release notes.");
    assert.equal(projectedGuidance[0].turnId, continuationTurn.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createRunInput(overrides) {
  return {
    id: overrides.id,
    cwd: overrides.cwd,
    taskId: `task_${overrides.id}`,
    providerName: "openai",
    providerModel: "gpt-test",
    taskSnapshot: { id: `task_${overrides.id}`, title: "Edit test", prompt: "Edit test" },
    providerSnapshot: { provider: "openai", model: "gpt-test" },
    requestSnapshot: { cwd: overrides.cwd, task: { id: `task_${overrides.id}`, title: "Edit test", prompt: "Edit test" } },
    threadId: overrides.threadId,
    turnId: overrides.turnId,
    createdAt: overrides.createdAt,
  };
}
