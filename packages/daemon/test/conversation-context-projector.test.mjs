import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../../core/dist/index.js";
import {
  assignContextSegmentForTurn,
} from "../dist/features/channels/context-processing/context-segmentation-policy.js";
import {
  buildConversationContextProjection,
  projectConversationContextMessages,
} from "../dist/features/channels/context-processing/conversation-context-projector.js";

const firstAt = "2026-08-10T02:00:00.000Z";
const secondAt = "2026-08-10T02:01:00.000Z";
const thirdAt = "2026-08-10T02:02:00.000Z";

test("segmentation policy uses structural inheritance, validates model ids, and promotes provisional segments", async (t) => {
  const fixture = await createFixture(t);
  const first = appendUserTurn(fixture, "first topic", firstAt);
  const firstResolution = await assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: first.item.id,
    propose: async () => assert.fail("the first item in a thread must not call the model"),
    now: firstAt,
  });
  assert.equal(firstResolution.resolution, "structural");

  const privateItem = fixture.store.appendConversationItem({
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    turnId: first.turnId,
    kind: "system_event",
    status: "committed",
    actorType: "system",
    visibility: "agent_private",
    visibilityOwnerId: "teammate_private",
    payload: { eventType: "private_note", summary: "private evidence" },
  }, "2026-08-10T02:00:30.000Z");

  const second = appendUserTurn(fixture, "unrelated second topic", secondAt);
  const secondResolution = await assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: second.item.id,
    propose: async (view) => ({
      action: "propose_new",
      confidence: 0.72,
      relatedSegmentIds: [view.candidates[0].segmentId],
      reason: "the prior goal would mislead this turn",
    }),
    now: secondAt,
  });
  assert.equal(secondResolution.resolution, "model_policy");
  assert.equal(secondResolution.segment.state, "provisional");
  assert.notEqual(secondResolution.segment.id, firstResolution.segment.id);

  const selectorProjection = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: second.item.id,
    view: "selector",
  });
  const replyProjection = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: second.item.id,
    view: "reply",
  });
  assert.equal(selectorProjection.metadata.projectionVersion, replyProjection.metadata.projectionVersion);
  assert.equal(selectorProjection.metadata.segmentId, secondResolution.segment.id);
  assert.deepEqual(projectConversationContextMessages(selectorProjection, fixture.store).map((message) => message.id), [second.item.id]);
  assert.throws(() => buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: second.item.id,
    view: "selector",
    explicitItemIds: [privateItem.id],
  }), /not visible/);

  const third = appendUserTurn(fixture, "continue the second topic", thirdAt, second.item.id);
  const thirdResolution = await assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: third.item.id,
    propose: async () => assert.fail("a reply relation must not call the model"),
    now: thirdAt,
  });
  assert.equal(thirdResolution.resolution, "structural");
  assert.equal(thirdResolution.segment.id, secondResolution.segment.id);
  assert.equal(thirdResolution.segment.state, "active");

  const fourth = appendUserTurn(fixture, "explicitly return", "2026-08-10T02:03:00.000Z");
  const explicit = await assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: fourth.item.id,
    explicitSegmentId: firstResolution.segment.id,
    propose: async () => assert.fail("an explicit segment must not call the model"),
    now: "2026-08-10T02:03:00.000Z",
  });
  assert.equal(explicit.resolution, "user");
  assert.equal(explicit.segment.id, firstResolution.segment.id);
});

test("segmentation policy rejects model-invented segment and evidence ids", async (t) => {
  const fixture = await createFixture(t);
  const first = appendUserTurn(fixture, "first", firstAt);
  await assignContextSegmentForTurn({ store: fixture.store, sourceItemId: first.item.id, now: firstAt });
  const second = appendUserTurn(fixture, "second", secondAt);

  await assert.rejects(() => assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: second.item.id,
    propose: async () => ({
      action: "continue",
      segmentId: "segment_invented",
      confidence: 0.9,
      evidenceItemIds: [],
    }),
    now: secondAt,
  }), /invented or cannot access segment/);

  await assert.rejects(() => assignContextSegmentForTurn({
    store: fixture.store,
    sourceItemId: second.item.id,
    propose: async (view) => ({
      action: "continue",
      segmentId: view.candidates[0].segmentId,
      confidence: 0.9,
      evidenceItemIds: ["item_invented"],
    }),
    now: secondAt,
  }), /invented or cannot access evidence item/);
});

test("topic projections inherit the complete source turn through the anchor item", async (t) => {
  const fixture = await createFixture(t);
  const root = appendUserTurn(fixture, "build a game", firstAt);
  fixture.store.appendConversationItem({
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    turnId: root.turnId,
    kind: "assistant_message",
    status: "committed",
    actorType: "ling_agent",
    actorId: "ling_agent",
    visibility: "channel",
    payload: {
      body: "Create `index.html` with the game implementation.",
      format: "markdown",
      streaming: false,
      deliveryStatus: "ready",
    },
    domainRefs: [{ type: "conversation_item", id: root.item.id }],
  }, "2026-08-10T02:00:30.000Z");
  const topic = fixture.store.resolveOrCreateConversationThread({
    surfaceKind: "topic",
    channelId: fixture.channel.id,
    anchorItemId: root.item.id,
    title: "Game",
    objective: "Continue the game topic",
  }, secondAt).thread;
  const topicTurn = fixture.store.appendConversationUserTurn({
    channelId: fixture.channel.id,
    threadId: topic.id,
    title: "write it locally",
    userInstruction: "write it locally",
    payload: {
      body: "write it locally",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      replyToItemId: root.item.id,
    },
    idempotencyKey: "projector:topic-turn",
  }, secondAt);
  const projection = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: topicTurn.item.id,
    view: "resolver",
  });
  const rootTurnItems = fixture.store.listConversationItemsForTurn({ turnId: root.turnId });
  assert.deepEqual(new Set(projection.items.map((item) => item.id)), new Set([
    ...rootTurnItems.map((item) => item.id),
    topicTurn.item.id,
  ]));
  const assistant = projection.items.find((item) => item.kind === "assistant_message");
  assert.ok(assistant);
  assert.match(assistant.payload.body, /index\.html/);
});

test("summary source refs fail closed for private items outside the matching specialist view", async (t) => {
  const fixture = await createFixture(t);
  const source = appendUserTurn(fixture, "private summary boundary", firstAt);
  const privateItem = fixture.store.appendConversationItem({
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    turnId: source.turnId,
    kind: "system_event",
    status: "committed",
    actorType: "system",
    visibility: "agent_private",
    visibilityOwnerId: "teammate_private",
    payload: { eventType: "private_note", summary: "private evidence" },
  }, "2026-08-10T02:00:30.000Z");
  const assignment = fixture.store.getEffectiveTurnContextAssignment(source.turnId);
  assert.ok(assignment);
  insertConversationSummary(fixture.cwd, {
    id: "summary_private_ref",
    threadId: fixture.thread.id,
    segmentId: assignment.segmentId,
    throughSequence: source.item.sequence,
    sourceRefs: [{ type: "conversation_item", id: privateItem.id }],
  });

  assert.throws(() => buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: source.item.id,
    view: "selector",
  }), /summary source ref is not visible/);
  const specialist = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: source.item.id,
    view: "specialist",
    consumerTeammateId: "teammate_private",
  });
  assert.deepEqual(specialist.metadata.summaryIds, ["summary_private_ref"]);
});

async function createFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-projector-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Projection", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Projection",
    objective: "Projection tests",
  }, firstAt).thread;
  return { cwd, store, channel, thread };
}

function appendUserTurn(fixture, body, now, replyToItemId) {
  return fixture.store.appendConversationUserTurn({
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    title: body,
    userInstruction: body,
    payload: {
      body,
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      ...(replyToItemId ? { replyToItemId } : {}),
    },
    idempotencyKey: `projector:${body}`,
  }, now);
}

function insertConversationSummary(cwd, input) {
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.prepare(`
      INSERT INTO conversation_context_summaries (
        id, workspace_id, thread_id, segment_id, scope, status, version,
        covered_from_sequence, covered_through_sequence, objective, decisions_json,
        constraints_json, open_questions_json, active_work_refs_json, source_refs_json,
        supersedes_summary_id, policy_version, created_at
      ) VALUES (?, 'workspace_default', ?, ?, 'segment', 'active', 1, 1, ?, ?, '[]',
        '[]', '[]', '[]', ?, NULL, 'continuity-v2-summary-test', ?)
    `).run(
      input.id,
      input.threadId,
      input.segmentId,
      input.throughSequence,
      "Private source summary",
      JSON.stringify(input.sourceRefs),
      "2026-08-10T02:00:45.000Z",
    );
  } finally {
    database.close();
  }
}
