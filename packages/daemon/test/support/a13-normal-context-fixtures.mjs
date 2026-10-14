import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";

// These helpers create only fixture-owned SQLite facts through public producers.
// They do not start a Daemon, resolve credentials, or dispatch a provider/tool.
export const at = (tick) => new Date(Date.UTC(2026, 8, 6) + tick * 1_000).toISOString();
export const userText = (index) => `A13_USER_${String(index).padStart(5, "0")}_END`;
export const payload = (body) => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });

/** Allocate the entire store and competing connection under one owned temp root. */
export async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a13-normal-window-"));
  // Root opts in for an evidence run; never accept a caller-provided cleanup path.
  const preserveOwnedRoot = process.env.LING_A13_KEEP_FIXTURES === "1";
  if (preserveOwnedRoot) t.diagnostic(`A13 retained fixture root: ${cwd}`);
  const f = { cwd };
  // Register before either constructor so partial setup still closes what opened.
  t.after(async () => {
    try { f.database?.close(); }
    finally {
      try { f.store?.close(); }
      finally {
        if (!preserveOwnedRoot) await rm(cwd, { recursive: true, force: true });
      }
    }
  });
  f.store = createSqliteRunStore(cwd);
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  f.database.exec("PRAGMA busy_timeout=1");
  f.thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "A13 owned context window",
    objective: "Capture admitted history without a whole-thread Turn cap" }, at(0));
  return f;
}

/** Append a canonical committed user item, source pointer, and bootstrap assignment. */
export function appendUser(f, index, { thread = f.thread, body = userText(index), now = at(100 + index),
  id = `a13-z-modern-${String(index).padStart(5, "0")}` } = {}) {
  return f.store.appendConversationUserTurn({ threadId: thread.id, turnId: id, itemId: `conversation-user:${id}`,
    title: body.slice(0, 96), userInstruction: body, payload: payload(body),
    domainRefs: [{ type: "turn", id }], idempotencyKey: `a13-user:${id}` }, now);
}

export function seedUsers(f, count, options = {}) {
  const { startIndex = 1, sameAt, ...rest } = options;
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return appendUser(f, index, { ...rest, ...(sameAt ? { now: sameAt } : {}) });
  });
}

/** A pre-bootstrap legacy source still has a lawful canonical user source pointer. */
export function appendLegacyUser(f, { id = "a13-000-deep-legacy", body = "A13_DEEP_LEGACY_USER_END", now = at(1) } = {}) {
  const itemId = `conversation-user:${id}`;
  f.store.createLingTurn({ id, threadId: f.thread.id, teammateId: "ling_agent", sourceItemId: itemId,
    kind: "manual_followup", title: body, userInstruction: body, createdByActor: "local-user" }, now);
  const item = f.store.appendConversationItem({ id: itemId, threadId: f.thread.id, turnId: id, kind: "user_message",
    actorType: "local_user", visibility: "thread_participants", payload: payload(body), domainRefs: [{ type: "turn", id }] }, now);
  return { turnId: id, item };
}

/** Link a real Run to its exact Turn; optional narration is a canonical item, not a report. */
export function ownedRun(f, source, { body = `A13_REPLY_${source.turnId}_END`, canonical = false,
  visibility = "thread_participants", terminal = false, finishAt = at(1_000) } = {}) {
  const turn = f.store.getLingTurn(source.turnId);
  assert.ok(turn);
  const id = `a13-run:${turn.id}`;
  f.store.createRun({ id, cwd: f.cwd, taskId: `a13-task:${turn.id}`, threadId: turn.threadId, turnId: turn.id,
    teammateId: "ling_agent", providerName: "openai", providerModel: "fixture", providerPresetId: "fixture",
    taskSnapshot: { id: `a13-task:${turn.id}`, title: turn.title, prompt: turn.userInstruction },
    providerSnapshot: { provider: "openai", model: "fixture" },
    requestSnapshot: { threadId: turn.threadId, turnId: turn.id, providerPresetId: "fixture", tools: ["read"] }, createdAt: turn.createdAt });
  const event = f.store.appendEvent(id, "message_end", { role: "assistant", text: body });
  let item;
  if (canonical) item = f.store.appendConversationItem({ id: `a13-answer:${turn.id}`, threadId: turn.threadId, turnId: turn.id,
    kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent", visibility,
    payload: { body, format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: "narration" },
    domainRefs: [{ type: "turn", id: turn.id }, { type: "run", id }] }, turn.createdAt);
  if (terminal) {
    assert.equal(f.store.transitionRunStatus({ runId: id, event: "runner_started", actor: "runner", now: finishAt }).ok, true);
    assert.equal(f.store.transitionRunStatus({ runId: id, event: "runner_succeeded", actor: "runner", now: finishAt }).ok, true);
    f.store.reconcileLingTurnStatus(turn.id, finishAt);
    assert.equal(f.store.getLingTurn(turn.id).status, "succeeded");
  }
  return { run: f.store.getRun(id), event, item };
}

/** Build a fresh summary from the same fenced public input used by Core's own tests. */
export function commitSummary(f, sources, objective = "A13_FRESH_SUMMARY_END") {
  const segmentId = f.store.getEffectiveTurnContextAssignment(sources[0].turnId).segmentId;
  const committed = f.store.commitConversationContextSummary({ threadId: f.thread.id, segmentId, scope: "segment",
    coveredFromSequence: sources[0].item.sequence, coveredThroughSequence: sources.at(-1).item.sequence,
    objective, decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [],
    sourceRefs: sources.map((source) => ({ type: "conversation_item", id: source.item.id })),
    policyVersion: "continuity-v2-summary-v1", projectionVersion: `ctxv2_a13_${sources.at(-1).item.sequence}`,
    visibilityFingerprint: "a13_owned_summary_visibility", expectedActiveSummaryId: null,
    sourceFence: sources.map((source) => {
      const assignment = f.store.getEffectiveTurnContextAssignment(source.turnId);
      assert.ok(assignment);
      return { itemId: source.item.id, sequence: source.item.sequence, revision: source.item.revision,
        updatedAt: source.item.updatedAt, visibility: source.item.visibility, visibilityOwnerId: source.item.visibilityOwnerId,
        turnId: source.turnId, assignmentId: assignment.id, assignmentRevision: assignment.revision };
    }) }, at(2_000));
  assert.equal(committed.status, "committed", JSON.stringify(committed));
  return committed.summary;
}

export function inputIdentity(thread, key) {
  const idempotencyKey = `normal-conversation:${thread.id}:${key}`;
  const turnId = `turn_normal_${createHash("sha256").update(idempotencyKey).digest("hex")}`;
  return { idempotencyKey, turnId, itemId: `conversation-user:${turnId}` };
}

/** Read exact rollback evidence, independently of the public 500-row Turn list. */
export function acceptanceState(f, thread = f.thread) {
  const count = (table) => f.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id=?`).get(thread.id).n;
  return { turns: count("ling_turns"), items: count("conversation_items"), snapshots: count("conversation_context_snapshots"),
    assignments: f.database.prepare(`SELECT COUNT(*) AS n FROM turn_context_assignments
      WHERE turn_id IN (SELECT id FROM ling_turns WHERE thread_id=?)`).get(thread.id).n,
    thread: f.store.getLingThread(thread.id), segments: f.store.listContextSegments({ threadId: thread.id, limit: 200 }) };
}

export function assertNoPartialInput(f, identity, before) {
  assert.equal(f.store.getLingTurn(identity.turnId), undefined);
  assert.equal(f.store.getConversationItem(identity.itemId), undefined);
  assert.equal(f.store.getEffectiveTurnContextAssignment(identity.turnId), undefined);
  assert.equal(f.store.getConversationAcceptedInputSnapshot(identity.itemId), undefined);
  assert.deepEqual(acceptanceState(f), before);
}

/** The expected context is checked against durable accepted evidence, never a fabricated snapshot. */
export function assertAccepted(f, accepted, currentBody, expectedCount, thread = f.thread) {
  const source = f.store.getConversationItem(accepted.turn.sourceItemId);
  const assignment = f.store.getEffectiveTurnContextAssignment(accepted.turn.id);
  const stored = f.store.getConversationAcceptedInputSnapshot(source.id);
  assert.ok(source && assignment && stored);
  assert.equal(source.turnId, accepted.turn.id);
  assert.equal(source.threadId, thread.id);
  assert.equal(source.payload.body, currentBody);
  assert.equal(accepted.context.hydration.source.itemId, source.id);
  assert.equal(accepted.context.projection.threadId, thread.id);
  assert.equal(accepted.context.projection.turnId, accepted.turn.id);
  assert.equal(accepted.context.projection.segmentId, assignment.segmentId);
  assert.equal(accepted.context.projection.throughItemSequence, source.sequence);
  assert.equal(stored.id, accepted.acceptedSnapshotId);
  assert.deepEqual(stored.projection, accepted.context.projection);
  assert.deepEqual(stored.payload, accepted.context);
  assert.equal(accepted.context.renderedHistory.includes(currentBody), false);
  assert.equal(accepted.context.hydration.entries.some((entry) => entry.turnId === accepted.turn.id), false);
  assert.equal(f.store.listConversationItemsForTurn({ turnId: accepted.turn.id }).filter((item) => item.kind === "user_message").length, 1);
  assert.equal(acceptanceState(f, thread).turns, expectedCount);
}
