import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import {
  coordinateConversationContextSummary,
  planConversationContextSummary,
} from "../dist/features/channels/context-processing/conversation-summary-coordinator.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";
import { estimateTextTokens } from "../dist/features/channels/context-packs.js";

const summaryPolicy = {
  softCompletedTurnCount: 10,
  softInputBudgetRatio: 0.3,
  hardInputBudgetRatio: 0.7,
  targetInputBudgetRatio: 0.55,
  rawTailCompletedTurnCount: 2,
  generationChunkBudgetRatio: 0.25,
};

test("summary coordinator compacts stable turns, preserves a raw tail, and advances coverage", async (t) => {
  const fixture = await createFixture(t, "rolling");
  const firstBatch = [];
  for (let index = 0; index < 12; index += 1) {
    firstBatch.push(addCompletedTurn(fixture, `first-${index}`, `Decision ${index}`));
  }
  const firstPlan = planConversationContextSummary({
    store: fixture.store,
    sourceItemId: firstBatch.at(-1).item.id,
    inputBudgetTokens: 16_000,
    policy: summaryPolicy,
  });
  assert.ok(firstPlan);
  assert.equal(firstPlan.trigger, "soft");
  assert.equal(firstPlan.sourceItems.length, 10);
  assert.equal(firstPlan.coveredThroughSequence, firstBatch[9].item.sequence);
  assert.equal(firstPlan.estimatedRawTailTokens > 0, true);

  const first = await coordinateConversationContextSummary({
    store: fixture.store,
    sourceItemId: firstBatch.at(-1).item.id,
    inputBudgetTokens: 16_000,
    policy: summaryPolicy,
    generate: mergeDraft,
    now: "2026-08-10T02:30:00.000Z",
  });
  assert.equal(first.status, "completed");
  assert.equal(first.commit.status, "committed");
  assert.equal(first.commit.summary.coveredThroughSequence, firstBatch[9].item.sequence);

  const secondBatch = [];
  for (let index = 0; index < 10; index += 1) {
    secondBatch.push(addCompletedTurn(fixture, `second-${index}`, `Constraint ${index}`));
  }
  const second = await coordinateConversationContextSummary({
    store: fixture.store,
    sourceItemId: secondBatch.at(-1).item.id,
    inputBudgetTokens: 16_000,
    policy: summaryPolicy,
    generate: mergeDraft,
    now: "2026-08-10T03:30:00.000Z",
  });
  assert.equal(second.status, "completed");
  assert.equal(second.commit.status, "committed");
  assert.equal(second.commit.summary.version, 2);
  assert.equal(second.commit.summary.coveredFromSequence, firstBatch[0].item.sequence);
  assert.equal(second.commit.summary.coveredThroughSequence, secondBatch[7].item.sequence);
  assert.equal(second.commit.summary.sourceRefs.some((ref) =>
    ref.type === "context_summary" && ref.id === first.commit.summary.id), true);
  assert.equal(fixture.store.getConversationContextSummary(first.commit.summary.id)?.status, "superseded");
});

test("summary coordinator selects the hard trigger and discards a late assignment result", async (t) => {
  const fixture = await createFixture(t, "race");
  const turns = [];
  for (let index = 0; index < 10; index += 1) {
    turns.push(addCompletedTurn(fixture, `race-${index}`, `Long fact ${index} ${"x".repeat(900)}`));
  }
  const plan = planConversationContextSummary({
    store: fixture.store,
    sourceItemId: turns.at(-1).item.id,
    inputBudgetTokens: 1_024,
    policy: {
      ...summaryPolicy,
      softCompletedTurnCount: 100,
    },
  });
  assert.ok(plan);
  assert.equal(plan.trigger, "hard");
  assert.equal(plan.sourceItems.length, 8);

  let corrected = false;
  const result = await coordinateConversationContextSummary({
    store: fixture.store,
    sourceItemId: turns.at(-1).item.id,
    inputBudgetTokens: 1_024,
    policy: {
      ...summaryPolicy,
      softCompletedTurnCount: 100,
    },
    generate: async (input) => {
      if (!corrected) {
        corrected = true;
        fixture.store.applyTurnContextAssignment({
          turnId: turns[0].turnId,
          target: { kind: "existing", segmentId: turns[0].contextSegmentId },
          status: "committed",
          decisionSource: "user",
          confidence: 1,
          evidenceRefs: [{ type: "conversation_item", id: turns[0].item.id }],
          policyVersion: "continuity-v2-segmentation-v1",
        }, "2026-08-10T04:30:00.000Z");
      }
      return mergeDraft(input);
    },
    now: "2026-08-10T04:31:00.000Z",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.commit, { status: "discarded_stale", reason: "assignments_changed" });
});

test("summary coordinator counts the active summary in the hard budget and bounds its replacement", async (t) => {
  const fixture = await createFixture(t, "summary-budget");
  const first = addCompletedTurn(fixture, "initial", "Initial summary source");
  const initialSummary = commitSingleTurnSummary(fixture, first, {
    objective: `Oversized objective ${"x".repeat(7_900)}`,
    now: nextTimestamp(fixture),
  });
  const laterTurns = [];
  for (let index = 0; index < 10; index += 1) {
    laterTurns.push(addCompletedTurn(fixture, `later-${index}`, `Fact ${index}`));
  }
  const plan = planConversationContextSummary({
    store: fixture.store,
    sourceItemId: laterTurns.at(-1).item.id,
    inputBudgetTokens: 1_024,
    policy: {
      ...summaryPolicy,
      softCompletedTurnCount: 100,
      softInputBudgetRatio: 0.9,
    },
  });
  assert.ok(plan);
  assert.equal(plan.trigger, "hard");
  assert.ok(plan.estimatedProjectionTokens > plan.inputBudgetTokens * summaryPolicy.hardInputBudgetRatio);
  assert.ok(plan.estimatedRawTokens < plan.inputBudgetTokens * 0.9);

  const result = await coordinateConversationContextSummary({
    store: fixture.store,
    sourceItemId: laterTurns.at(-1).item.id,
    inputBudgetTokens: 1_024,
    policy: {
      ...summaryPolicy,
      softCompletedTurnCount: 100,
      softInputBudgetRatio: 0.9,
    },
    generate: async () => ({
      objective: `Compact objective ${"y".repeat(5_000)}`,
      decisions: Array.from({ length: 100 }, (_, index) => `Decision ${index} ${"d".repeat(200)}`),
      constraints: Array.from({ length: 100 }, (_, index) => `Constraint ${index} ${"c".repeat(200)}`),
      openQuestions: Array.from({ length: 100 }, (_, index) => `Question ${index} ${"q".repeat(200)}`),
    }),
    now: nextTimestamp(fixture),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.commit.status, "committed");
  assert.equal(result.commit.summary.supersedesSummaryId, initialSummary.id);
  const draftTokens = estimateTextTokens(JSON.stringify({
    objective: result.commit.summary.objective,
    decisions: result.commit.summary.decisions,
    constraints: result.commit.summary.constraints,
    openQuestions: result.commit.summary.openQuestions,
  }));
  assert.ok(draftTokens <= result.plan.summaryTokenBudget);
});

test("branch projection reconstructs from its immutable snapshot without copying parent items", async (t) => {
  const fixture = await createFixture(t, "branch");
  const parent = fixture.store.appendConversationUserTurn({
    itemId: "item_branch_parent",
    turnId: "turn_branch_parent",
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    title: "Original parent fact",
    userInstruction: "Original parent fact",
    payload: {
      body: "Original parent fact",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "branch-parent",
  }, nextTimestamp(fixture));
  const initialSummary = commitSingleTurnSummary(fixture, parent, {
    objective: "Original parent objective",
    now: nextTimestamp(fixture),
  });
  const parentProjection = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: parent.item.id,
    view: "reply",
  });
  assert.deepEqual(parentProjection.metadata.summaryIds, [initialSummary.id]);
  const branch = fixture.store.resolveOrCreateConversationThread({
    id: "thread_branch_snapshot",
    surfaceKind: "branch",
    channelId: fixture.channel.id,
    parentThreadId: fixture.thread.id,
    parentTurnId: parent.turnId,
    title: "Branch snapshot",
    objective: "Keep the fork boundary stable",
    forkContextSnapshot: {
      id: "snapshot_branch_projection",
      segmentId: parentProjection.metadata.segmentId,
      projectionVersion: parentProjection.metadata.projectionVersion,
      throughItemSequence: parentProjection.metadata.throughItemSequence,
      summaryIds: parentProjection.metadata.summaryIds,
      sourceRefs: [
        { type: "thread", id: fixture.thread.id },
        { type: "turn", id: parent.turnId },
        { type: "conversation_item", id: parent.item.id },
      ],
      policyVersion: parentProjection.metadata.policyVersion,
    },
  }, nextTimestamp(fixture)).thread;
  assert.equal(branch.forkContextSnapshotId, "snapshot_branch_projection");
  assert.equal(fixture.store.listConversationItemsPage({ threadId: branch.id, limit: 10 }).items.length, 0);

  const child = fixture.store.appendConversationUserTurn({
    itemId: "item_branch_child",
    turnId: "turn_branch_child",
    channelId: fixture.channel.id,
    threadId: branch.id,
    title: "Child question",
    userInstruction: "Child question",
    payload: {
      body: "Child question",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "branch-child",
  }, nextTimestamp(fixture));
  const childProjection = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: child.item.id,
    view: "reply",
  });
  assert.equal(childProjection.forkSnapshot?.id, "snapshot_branch_projection");
  assert.deepEqual(childProjection.items.map((item) => item.id), [parent.item.id, child.item.id]);
  assert.deepEqual(childProjection.sharedCore.objectives, ["Original parent objective"]);

  const replacement = fixture.store.appendConversationUserTurn({
    itemId: "item_branch_parent_replacement",
    turnId: "turn_branch_parent_replacement",
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    title: "Changed parent fact",
    userInstruction: "Changed parent fact",
    payload: {
      body: "Changed parent fact",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    supersedesItemId: parent.item.id,
    idempotencyKey: "branch-parent-replacement",
  }, nextTimestamp(fixture));
  const replacementSummary = commitSingleTurnSummary(fixture, replacement, {
    objective: "Changed parent objective",
    coveredFromSequence: parent.item.sequence,
    expectedActiveSummaryId: initialSummary.id,
    now: nextTimestamp(fixture),
  });
  assert.equal(fixture.store.getConversationContextSummary(initialSummary.id)?.status, "superseded");
  assert.equal(replacementSummary.objective, "Changed parent objective");
  const reconstructed = buildConversationContextProjection({
    store: fixture.store,
    sourceItemId: child.item.id,
    view: "reply",
  });
  assert.deepEqual(reconstructed.items.map((item) => item.id), [parent.item.id, child.item.id]);
  assert.equal(reconstructed.items[0].payload.body, "Original parent fact");
  assert.deepEqual(reconstructed.sharedCore.objectives, ["Original parent objective"]);
});

async function createFixture(t, suffix) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-summary-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-08-10T02:00:00.000Z";
  const channel = store.createChannel({ name: `Summary ${suffix}`, boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Summary",
    objective: "Exercise proactive summaries",
  }, now).thread;
  return { cwd, store, channel, thread, nextTimestamp: Date.parse(now) + 1_000 };
}

function addCompletedTurn(fixture, suffix, body) {
  const turnAt = nextTimestamp(fixture);
  const result = fixture.store.appendConversationUserTurn({
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    title: body.slice(0, 80),
    userInstruction: body,
    payload: {
      body,
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: `summary:${suffix}`,
  }, turnAt);
  const runAt = nextTimestamp(fixture);
  const run = fixture.store.createRun({
    id: `run_summary_${suffix}`,
    cwd: fixture.cwd,
    taskId: `task_summary_${suffix}`,
    channelId: fixture.channel.id,
    threadId: fixture.thread.id,
    turnId: result.turnId,
    providerName: "test",
    providerModel: "test",
    taskSnapshot: { id: `task_summary_${suffix}`, title: body, prompt: body },
    providerSnapshot: { provider: "test", model: "test" },
    requestSnapshot: { cwd: fixture.cwd, task: { id: `task_summary_${suffix}`, title: body, prompt: body } },
    createdAt: runAt,
  });
  fixture.store.markRunStarted(run.id, nextTimestamp(fixture));
  fixture.store.markRunSucceeded(run.id, nextTimestamp(fixture));
  return result;
}

function nextTimestamp(fixture) {
  const value = new Date(fixture.nextTimestamp).toISOString();
  fixture.nextTimestamp += 1_000;
  return value;
}

function commitSingleTurnSummary(fixture, turn, input) {
  const assignment = fixture.store.getEffectiveTurnContextAssignment(turn.turnId);
  assert.ok(assignment);
  const result = fixture.store.commitConversationContextSummary({
    threadId: turn.item.threadId,
    segmentId: assignment.segmentId,
    scope: "segment",
    coveredFromSequence: input.coveredFromSequence ?? turn.item.sequence,
    coveredThroughSequence: turn.item.sequence,
    objective: input.objective,
    decisions: [],
    constraints: [],
    openQuestions: [],
    activeWorkRefs: [],
    sourceRefs: [
      ...(input.expectedActiveSummaryId
        ? [{ type: "context_summary", id: input.expectedActiveSummaryId }]
        : []),
      { type: "conversation_item", id: turn.item.id },
    ],
    policyVersion: "continuity-v2-summary-v1",
    projectionVersion: `ctxv2_branch_${turn.item.sequence}`,
    visibilityFingerprint: "visibility_branch_fixture",
    expectedActiveSummaryId: input.expectedActiveSummaryId ?? null,
    sourceFence: [{
      itemId: turn.item.id,
      sequence: turn.item.sequence,
      revision: turn.item.revision,
      updatedAt: turn.item.updatedAt,
      visibility: turn.item.visibility,
      visibilityOwnerId: turn.item.visibilityOwnerId,
      turnId: turn.turnId,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
    }],
  }, input.now);
  assert.equal(result.status, "committed");
  return result.summary;
}

async function mergeDraft(input) {
  const bodies = input.items
    .filter((item) => item.kind === "user_message")
    .map((item) => item.payload.body.slice(0, 80));
  return {
    objective: input.current.objective ?? "Maintain durable continuity.",
    decisions: [...input.current.decisions, ...bodies.filter((body) => body.startsWith("Decision"))],
    constraints: [...input.current.constraints, ...bodies.filter((body) => body.startsWith("Constraint"))],
    openQuestions: input.current.openQuestions,
  };
}
