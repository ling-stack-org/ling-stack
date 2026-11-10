import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import {
  coordinateConversationContextSummary,
  assessConversationContextSummary,
  executeConversationSummaryPlan,
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
  assert.ok(first.checkpoint);
  assert.equal(first.checkpoint.sourceTurnId, firstPlan.projection.metadata.turnId);
  assert.deepEqual(first.checkpoint.summaryIds, [first.commit.summary.id]);
  assert.match(first.checkpoint.summaryContentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.checkpoint.coveredItemSeqFrom, firstBatch[0].item.sequence);
  assert.equal(first.checkpoint.coveredItemSeqTo, firstBatch[9].item.sequence);

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
  assert.ok(second.checkpoint);
  assert.deepEqual(second.checkpoint.summaryIds, [second.commit.summary.id, first.commit.summary.id]);
});

test("summary commit remains evidence when checkpoint installation fails", async (t) => {
  const fixture = await createFixture(t, "checkpoint-failure");
  const turns = [];
  for (let index = 0; index < 10; index += 1) {
    turns.push(addCompletedTurn(fixture, `checkpoint-failure-${index}`, `Decision ${index}`));
  }
  const failingStore = new Proxy(fixture.store, {
    get(target, property) {
      if (property === "createCompactionCheckpoint") {
        return () => { throw new Error("simulated checkpoint install failure"); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await coordinateConversationContextSummary({
    store: failingStore,
    sourceItemId: turns.at(-1).item.id,
    inputBudgetTokens: 16_000,
    policy: summaryPolicy,
    generate: mergeDraft,
    now: "2026-08-10T05:30:00.000Z",
  });
  assert.equal(result.status, "checkpoint_failed");
  assert.equal(result.commit.status, "committed");
  assert.deepEqual(fixture.store.listCompactionCheckpoints({ threadId: fixture.thread.id }), []);
  assert.ok(fixture.store.getConversationContextSummary(result.commit.summary.id));
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
  assert.equal(result.status, "source_conflict");
  assert.deepEqual(result.commit, { status: "discarded_stale", reason: "assignments_changed" });
  assert.equal(result.checkpoint, undefined);
  assert.deepEqual(fixture.store.listCompactionCheckpoints({ threadId: fixture.thread.id }), []);
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

test("hard maintenance without an eligible prefix is not reported as unnecessary", async (t) => {
  const fixture = await createFixture(t, "required-tail");
  const turn = addCompletedTurn(fixture, "required-tail", "Required tail " + "x".repeat(9_000));
  let calls = 0;
  const result = await coordinateConversationContextSummary({
    store: fixture.store, sourceItemId: turn.item.id, inputBudgetTokens: 1_024,
    generate: async () => { calls++; throw new Error("must not summarize the protected tail"); },
  });
  assert.equal(result.status, "no_eligible_prefix");
  assert.equal(result.trigger, "hard");
  assert.equal(result.inputBudgetTokens, 1_024);
  assert.ok(result.estimatedProjectionTokens > 1_024);
  assert.equal(result.threadId, turn.item.threadId);
  assert.equal(result.sourceItemId, turn.item.id);
  assert.deepEqual(Object.keys(result).sort(), ["status", "trigger", "sourceItemId", "threadId", "segmentId",
    "inputBudgetTokens", "estimatedProjectionTokens"].sort());
  assert.equal(calls, 0);
  assert.equal(fixture.store.getConversationItem(turn.item.id).payload.body, turn.item.payload.body);
  assert.deepEqual(fixture.store.listConversationContextSummaries({ threadId: fixture.thread.id }), []);
  assert.deepEqual(fixture.store.listCompactionCheckpoints({ threadId: fixture.thread.id }), []);
});

test("soft maintenance with only a protected tail stays distinct from a capacity verdict", async (t) => {
  const fixture = await createFixture(t, "soft-tail");
  const turn = addCompletedTurn(fixture, "soft-tail", "Small but protected decision");
  const result = await coordinateConversationContextSummary({
    store: fixture.store, sourceItemId: turn.item.id, inputBudgetTokens: 16_000,
    policy: { ...summaryPolicy, softCompletedTurnCount: 1 },
  });
  assert.equal(result.status, "no_eligible_prefix");
  assert.equal(result.trigger, "soft");
  assert.ok(result.estimatedProjectionTokens < result.inputBudgetTokens);
});

test("below-threshold context remains not_needed without calling a generator", async (t) => {
  const fixture = await createFixture(t, "below-threshold");
  const turn = addCompletedTurn(fixture, "below-threshold", "Short decision");
  const result = await coordinateConversationContextSummary({
    store: fixture.store, sourceItemId: turn.item.id, inputBudgetTokens: 16_000,
    generate: async () => { throw new Error("must not generate"); },
  });
  assert.equal(result.status, "not_needed");
});

test("an active turn cannot become an eligible prefix just because its context is large", async (t) => {
  const fixture = await createFixture(t, "active-only");
  const turn = fixture.store.appendConversationUserTurn({
    channelId: fixture.channel.id, threadId: fixture.thread.id, title: "Active request",
    userInstruction: "Continue unfinished work", idempotencyKey: "active-only",
    payload: { body: "Unfinished constraint " + "x".repeat(9_000), format: "plain_text",
      mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, nextTimestamp(fixture));
  const assessment = assessConversationContextSummary({
    store: fixture.store, sourceItemId: turn.item.id, inputBudgetTokens: 1_024,
    policy: { ...summaryPolicy, rawTailCompletedTurnCount: 1 },
  });
  assert.equal(assessment.status, "no_eligible_prefix");
  assert.equal(assessment.trigger, "hard");
  assert.deepEqual(fixture.store.listConversationContextSummaries({ threadId: fixture.thread.id }), []);
});

test("a ready assessment preserves the same plan and source fences as the plan-only query", async (t) => {
  const fixture = await createFixture(t, "assessment-ready");
  addCompletedTurn(fixture, "assessment-ready-prefix", "Summarize this stable decision");
  const turn = addCompletedTurn(fixture, "assessment-ready-tail", "Keep this recent decision verbatim");
  const input = { store: fixture.store, sourceItemId: turn.item.id, inputBudgetTokens: 16_000,
    policy: { ...summaryPolicy, softCompletedTurnCount: 1, rawTailCompletedTurnCount: 1 } };
  const assessment = assessConversationContextSummary(input);
  assert.equal(assessment.status, "ready");
  assert.equal(assessment.plan.trigger, "soft");
  const plan = planConversationContextSummary(input);
  assert.deepEqual(assessment.plan.sourceFence, plan.sourceFence);
  assert.deepEqual(assessment.plan.sourceRefs, plan.sourceRefs);
  assert.equal(assessment.plan.estimatedProjectionTokens, plan.estimatedProjectionTokens);
});

test("already cancelled generation cannot fall through to generator_unavailable", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  controller.abort(reason);
  const result = await executeConversationSummaryPlan({
    store: {}, plan: { trigger: "hard" }, signal: controller.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error, reason);
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

async function b007CompletedSummaryFixture(t, suffix) {
  const fixture = await createFixture(t, `b007-${suffix}`);
  const turns = Array.from({ length: 12 }, (_, index) => addCompletedTurn(fixture, `b007-${suffix}-${index}`,
    index === 3 ? "Decision moved fact belongs only to the corrected topic" : `Decision retained fact ${index}`));
  const first = await coordinateConversationContextSummary({ store: fixture.store, sourceItemId: turns.at(-1).item.id,
    inputBudgetTokens: 16_000, policy: summaryPolicy, generate: mergeDraft, now: nextTimestamp(fixture) });
  assert.equal(first.status, "completed");
  assert.equal(first.commit.summary.version, 1);
  assert.equal(first.commit.summary.coveredThroughSequence, turns[9].item.sequence);
  assert.ok(first.commit.summary.decisions.includes("Decision moved fact belongs only to the corrected topic"));
  const assignment = fixture.store.getEffectiveTurnContextAssignment(turns[3].turnId);
  const moved = fixture.store.applyTurnContextAssignment({ turnId: turns[3].turnId,
    expectedPreviousRevision: assignment.revision, target: { kind: "new", state: "active", label: "Corrected separate topic" },
    status: "committed", decisionSource: "user", evidenceRefs: [{ type: "conversation_item", id: turns[3].item.id }],
    policyVersion: "continuity-v2-user-correction-v1" }, nextTimestamp(fixture));
  assert.deepEqual(moved.invalidatedSummaryIds, [first.commit.summary.id]);
  const invalidated = fixture.store.getConversationContextSummary(first.commit.summary.id);
  assert.equal(invalidated.status, "invalidated");
  const input = { store: fixture.store, sourceItemId: turns.at(-1).item.id, inputBudgetTokens: 16_000, policy: summaryPolicy };
  const plan = planConversationContextSummary(input);
  assert.ok(plan);
  assert.equal(plan.activeSummary, undefined);
  assert.equal(plan.sourceItems.length, 9);
  assert.equal(plan.sourceItems.some((item) => item.id === turns[3].item.id), false);
  assert.equal(plan.sourceRefs.some((ref) => ref.type === "context_summary" && ref.id === invalidated.id), false);
  return { ...fixture, turns, first, moved, invalidated, input, plan };
}

test("B-007 coordinator rebuild completes with a new checkpoint and never revives invalidated topic content", async (t) => {
  const fixture = await b007CompletedSummaryFixture(t, "completed");
  const generatorInputs = [];
  const rebuilt = await coordinateConversationContextSummary({ ...fixture.input, now: nextTimestamp(fixture),
    generate: async (input) => {
      generatorInputs.push({ current: input.current, itemIds: input.items.map((item) => item.id), sourceRefs: input.sourceRefs });
      return mergeDraft(input);
    },
  });
  assert.equal(rebuilt.status, "completed");
  assert.equal(rebuilt.commit.status, "committed");
  const summary = rebuilt.commit.summary;
  assert.equal(summary.version, 2);
  assert.equal(summary.supersedesSummaryId, undefined);
  assert.equal(summary.decisions.includes("Decision moved fact belongs only to the corrected topic"), false);
  assert.equal(summary.sourceRefs.some((ref) => ref.id === fixture.turns[3].item.id || ref.id === fixture.invalidated.id), false);
  assert.ok(generatorInputs.length > 0);
  for (const input of generatorInputs) {
    assert.equal(input.current.decisions.includes("Decision moved fact belongs only to the corrected topic"), false);
    assert.equal(input.itemIds.includes(fixture.turns[3].item.id), false);
    assert.equal(input.sourceRefs.some((ref) => ref.id === fixture.invalidated.id), false);
  }
  assert.notEqual(rebuilt.checkpoint.id, fixture.first.checkpoint.id);
  assert.deepEqual(rebuilt.checkpoint.summaryIds, [summary.id]);
  assert.equal(rebuilt.checkpoint.sourceTurnId, fixture.turns.at(-1).turnId);
  assert.equal(rebuilt.checkpoint.coveredItemSeqFrom, fixture.turns[0].item.sequence);
  assert.equal(rebuilt.checkpoint.coveredItemSeqTo, fixture.turns[9].item.sequence);
  assert.equal(rebuilt.checkpoint.sourceRefs.some((ref) => ref.id === fixture.turns[3].item.id || ref.id === fixture.invalidated.id), false);
  assert.deepEqual(fixture.store.getConversationContextSummary(fixture.invalidated.id), fixture.invalidated);
  assert.deepEqual(fixture.store.getCompactionCheckpoint(fixture.first.checkpoint.id), fixture.first.checkpoint);
  const projection = buildConversationContextProjection({ store: fixture.store, sourceItemId: fixture.turns.at(-1).item.id, view: "reply" });
  assert.deepEqual(projection.summaries.map((entry) => entry.id), [summary.id]);
  assert.equal(JSON.stringify(projection.sharedCore).includes("Decision moved fact belongs only to the corrected topic"), false);
  assert.equal(projection.items.some((item) => item.id === fixture.turns[3].item.id), false);
  assert.ok(projection.items.some((item) => item.id === fixture.turns[10].item.id));
  assert.ok(projection.items.some((item) => item.id === fixture.turns[11].item.id));
  assert.equal(fixture.store.getConversationItem(fixture.turns[3].item.id).payload.body,
    "Decision moved fact belongs only to the corrected topic");
});

test("B-007 coordinator discards a rebuild changed by another Store without installing a new summary or checkpoint", async (t) => {
  const fixture = await b007CompletedSummaryFixture(t, "assignment-race");
  const other = createSqliteRunStore(fixture.cwd);
  let corrected = false;
  try {
    const beforeCheckpointIds = fixture.store.listCompactionCheckpoints({ threadId: fixture.thread.id }).map(({ id }) => id);
    const result = await executeConversationSummaryPlan({ store: fixture.store, plan: fixture.plan, now: nextTimestamp(fixture),
      generate: async (input) => {
        if (!corrected) {
          corrected = true;
          const assignment = other.getEffectiveTurnContextAssignment(fixture.turns[0].turnId);
          const correction = other.applyTurnContextAssignment({ turnId: fixture.turns[0].turnId,
            expectedPreviousRevision: assignment.revision, target: { kind: "existing", segmentId: assignment.segmentId },
            status: "committed", decisionSource: "user", evidenceRefs: [{ type: "turn", id: fixture.turns[0].turnId }],
            policyVersion: "continuity-v2-user-correction-v1" }, nextTimestamp(fixture));
          assert.equal(correction.assignment.revision, assignment.revision + 1);
        }
        return mergeDraft(input);
      },
    });
    assert.equal(corrected, true);
    assert.equal(result.status, "source_conflict");
    assert.deepEqual(result.commit, { status: "discarded_stale", reason: "assignments_changed" });
    assert.equal(result.checkpoint, undefined);
    assert.deepEqual(fixture.store.listConversationContextSummaries({ threadId: fixture.thread.id }), []);
    assert.deepEqual(fixture.store.listConversationContextSummaries({ threadId: fixture.thread.id,
      statuses: ["active", "superseded", "invalidated"] }).map(({ id }) => id), [fixture.invalidated.id]);
    assert.deepEqual(fixture.store.listCompactionCheckpoints({ threadId: fixture.thread.id }).map(({ id }) => id), beforeCheckpointIds);
    assert.deepEqual(fixture.store.getConversationContextSummary(fixture.invalidated.id), fixture.invalidated);
  } finally { other.close(); }
});
