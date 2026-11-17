import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, projectConversationItemToChannelMessage } from "@ling-stack/core";
import { assignContextSegmentForTurn } from "../dist/features/channels/context-processing/context-segmentation-policy.js";
import { buildProjectedConversationContextSlice } from "../dist/features/channels/context-processing/conversation-context-adapter.js";
import { contextViewLineageKey } from "../dist/features/channels/context-processing/context-view-lineage.js";
import { buildChannelContextView } from "../dist/features/channels/context-processing/views.js";
import { buildPrivateChatContextView } from "../dist/features/channels/context-processing/private-chat.js";
import { buildWorkflowProposalContextView } from "../dist/features/channels/context-processing/proposals.js";
import { buildWorkflowStepContextView } from "../dist/features/channels/context-processing/workflow-steps.js";
import {
  buildChannelIntentSelectorContextView,
  buildChannelProtocolContextSection,
  buildChannelReplyContextView,
} from "../dist/features/channels/context-packs.js";
import { reconcileContextViewLineagesAtStartup } from "../dist/features/channels/context-processing/context-view-recovery.js";

const firstAt = "2026-11-17T03:00:00.000Z";

test("startup reconciliation rebuilds a persisted projection after SQLite reopen", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Recovery", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Recovery",
    objective: "Recovery test",
  }, firstAt).thread;
  const turn = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "rebuild me",
    userInstruction: "rebuild me",
    payload: {
      body: "rebuild me",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "context-recovery:turn",
  }, firstAt);
  await assignContextSegmentForTurn({ store, sourceItemId: turn.item.id, now: firstAt });
  const projected = buildProjectedConversationContextSlice({
    store,
    channel,
    sourceItemId: turn.item.id,
    view: "reply",
  });
  const lineageKey = contextViewLineageKey({
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: projected.projection.metadata.threadId,
    sourceItemId: turn.item.id,
    kind: "ling_agent_channel_view",
  });
  buildChannelContextView({
    kind: "ling_agent_channel_view",
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    sections: projected.sections,
    sourceRefs: projected.sourceRefs,
    sources: projected.sources,
    contextProjection: projected.projection.metadata,
    lineage: { store, lineageKey, sourceItemId: turn.item.id },
    now: firstAt,
  });
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.deepEqual({
    scanned: report.scanned,
    current: report.current,
    reconstructed: report.reconstructed,
    stale: report.stale,
    blocked: report.blocked,
    unsupported: report.unsupported,
  }, {
    scanned: 1,
    current: 1,
    reconstructed: 0,
    stale: 0,
    blocked: 0,
    unsupported: 0,
  });
  assert.equal(report.entries[0].projection?.metadata.sourceStateFingerprint,
    projected.projection.metadata.sourceStateFingerprint);

  const current = store.getConversationContextViewLineage(lineageKey);
  assert.ok(current);
  store.upsertConversationContextViewLineage({
    lineageKey,
    workspaceId: current.workspaceId,
    channelId: current.channelId,
    threadId: current.threadId,
    sourceItemId: current.sourceItemId,
    kind: current.kind,
    contextViewId: "view_future",
    contextViewCreatedAt: firstAt,
    projection: { ...current.projection, sourceStateFingerprint: "source_future" },
    viewFingerprint: "view_future",
    expectedCurrentViewId: current.contextViewId,
  }, "2026-11-17T03:01:00.000Z");
  const reconstructed = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(reconstructed.reconstructed, 1);
  assert.equal(store.getConversationContextViewLineage(lineageKey)?.contextViewId, "view_future");
});

test("startup reconciliation keeps invalid lineage fail-closed and does not write a replacement", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-blocked-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const now = "2026-11-17T03:01:00.000Z";
  store.upsertConversationContextViewLineage({
    lineageKey: "invalid-lineage",
    workspaceId: "workspace_default",
    channelId: "channel_missing",
    threadId: "thread_missing",
    sourceItemId: "item_missing",
    kind: "ling_agent_channel_view",
    contextViewId: "view_missing",
    contextViewCreatedAt: now,
    projection: {
      projectionVersion: "projection-v1",
      sourceStateFingerprint: "source-v1",
      threadId: "thread_missing",
      turnId: "turn_missing",
      segmentId: "segment_missing",
      throughItemSequence: 1,
      summaryIds: [],
      sourceRefs: [],
      policyVersion: "continuity-v2-projector-v1",
      visibilityFingerprint: "visibility-v1",
    },
    viewFingerprint: "view-v1",
  }, now);

  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(report.blocked, 1);
  assert.match(report.entries[0].reason, /Conversation projection source/);
  assert.equal(store.getConversationContextViewLineage("invalid-lineage")?.contextViewId, "view_missing");
});

test("startup reconciliation rehydrates channel reply and selector views from durable turn inputs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-channel-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Channel recovery", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Channel recovery",
    objective: "Channel recovery test",
  }, firstAt).thread;
  const turn = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "recover channel views",
    userInstruction: "recover channel views",
    payload: {
      body: "recover channel views",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "context-recovery:channel",
  }, firstAt);
  await assignContextSegmentForTurn({ store, sourceItemId: turn.item.id, now: firstAt });
  const sourceMessage = projectConversationItemToChannelMessage(turn.item);
  const teammate = store.getAiTeammate("teammate_builtin_engineer");
  assert.ok(teammate);
  const reply = buildChannelReplyContextView({
    store,
    channel,
    sourceMessage,
    teammate,
    canonicalTeammateId: teammate.id,
  });
  const selector = buildChannelIntentSelectorContextView({
    store,
    channel,
    sourceMessage,
  });
  const replyLineageKey = contextViewLineageKey({
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: thread.id,
    sourceItemId: turn.item.id,
    kind: "ling_agent_channel_view",
    consumerTeammateId: teammate.id,
  });
  const selectorLineageKey = contextViewLineageKey({
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: thread.id,
    sourceItemId: turn.item.id,
    kind: "selector_view",
  });
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(report.scanned, 2);
  assert.equal(report.current, 2);
  assert.equal(report.reconstructed, 0);
  assert.equal(report.blocked, 0);
  const recoveredReply = report.entries.find((entry) => entry.lineageKey === replyLineageKey);
  const recoveredSelector = report.entries.find((entry) => entry.lineageKey === selectorLineageKey);
  assert.equal(recoveredReply?.view?.id, reply.id);
  assert.equal(recoveredReply?.view?.kind, "ling_agent_channel_view");
  assert.equal(recoveredSelector?.view?.id, selector.id);
  assert.equal(recoveredSelector?.view?.kind, "selector_view");
  assert.equal(store.getConversationContextViewLineage(replyLineageKey)?.contextViewId, reply.id);
  assert.equal(store.getConversationContextViewLineage(selectorLineageKey)?.contextViewId, selector.id);
});

test("startup reconciliation rehydrates the durable private-chat view without writing a replacement", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-private-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const teammate = store.getAiTeammate("teammate_builtin_engineer");
  assert.ok(teammate);
  const thread = store.getOrCreateTeammateDirectThread(teammate.id, firstAt);
  const source = store.createTeammateDirectMessage({
    threadId: thread.id,
    teammateId: teammate.id,
    authorType: "local-user",
    body: "Rehydrate private context",
    status: "ready",
  }, firstAt);
  const original = buildPrivateChatContextView({
    store,
    teammate,
    thread,
    messages: [source],
    sourceMessage: source,
    now: firstAt,
  });
  const lineageKey = contextViewLineageKey({
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    sourceItemId: source.id,
    kind: "private_chat_view",
    consumerTeammateId: teammate.id,
  });
  const persisted = store.getConversationContextViewLineage(lineageKey);
  assert.ok(persisted);
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(report.current, 1);
  assert.equal(report.entries[0].view?.id, original.id);
  assert.equal(report.entries[0].view?.sections[0]?.text, original.sections[0]?.text);
  assert.equal(store.getConversationContextViewLineage(lineageKey)?.contextViewId, original.id);
});

test("startup reconciliation rehydrates a workflow proposal view from the canonical source item", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-proposal-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Proposal recovery", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Proposal recovery",
    objective: "Proposal recovery test",
  }, firstAt).thread;
  const turn = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "propose a plan",
    userInstruction: "propose a plan",
    payload: {
      body: "propose a plan",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "context-recovery:proposal",
  }, firstAt);
  await assignContextSegmentForTurn({ store, sourceItemId: turn.item.id, now: firstAt });
  const sourceMessage = {
    id: turn.item.id,
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: thread.id,
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    body: "propose a plan",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: firstAt,
    updatedAt: firstAt,
  };
  const original = buildWorkflowProposalContextView({ store, channel, sourceMessage });
  const lineageKey = contextViewLineageKey({
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: thread.id,
    sourceItemId: turn.item.id,
    kind: "workflow_proposal_view",
  });
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(report.current, 1);
  assert.equal(report.entries[0].view?.id, original.id);
  assert.equal(report.entries[0].view?.kind, "workflow_proposal_view");
  assert.equal(store.getConversationContextViewLineage(lineageKey)?.contextViewId, original.id);
});

test("startup reconciliation resolves a workflow-step view through its source message and workflow records", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-recovery-workflow-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Workflow recovery", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Workflow recovery",
    objective: "Workflow recovery test",
  }, firstAt).thread;
  const turn = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "run the step",
    userInstruction: "run the step",
    payload: {
      body: "run the step",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "context-recovery:workflow",
  }, firstAt);
  await assignContextSegmentForTurn({ store, sourceItemId: turn.item.id, now: firstAt });
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Recovery workflow",
    objective: "Recover the workflow context",
    createdBy: "ling_agent",
    metadata: { sourceMessageId: turn.item.id },
  }, firstAt);
  const step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Recover step",
    prompt: "Run the recovered step.",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    metadata: { sourceMessageId: turn.item.id },
  }, firstAt);
  const protocol = buildChannelProtocolContextSection({ store, channel });
  const protocolSection = {
    ...protocol,
    title: protocol.id,
    sourceRefIds: protocol.sourceRefIds ?? [],
    visibility: "prompt",
    quotePolicy: "public_ok",
    compactionSurvival: protocol.compactionSurvival ?? "rebuild",
  };
  const original = buildWorkflowStepContextView({
    store,
    channel,
    workflow,
    step,
    prompt: step.prompt,
    consumerTeammateId: step.toParticipantId,
    workflowSteps: [step],
    protocolSection,
  });
  const lineageKey = contextViewLineageKey({
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    threadId: thread.id,
    sourceItemId: turn.item.id,
    kind: "workflow_step_view",
    consumerTeammateId: step.toParticipantId,
  });
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const report = reconcileContextViewLineagesAtStartup({ store });
  assert.equal(report.current, 1);
  assert.equal(report.entries[0].view?.id, original.id);
  assert.equal(report.entries[0].view?.kind, "workflow_step_view");
  assert.equal(store.getConversationContextViewLineage(lineageKey)?.contextViewId, original.id);
});
