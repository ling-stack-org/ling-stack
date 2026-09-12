import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, redactSecrets } from "../../core/dist/index.js";

const sourceRoot = new URL("../src/", import.meta.url);
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(sourceRoot.href) && specifier.startsWith(".") && specifier.endsWith(".js")) {
    return nextResolve(new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const { captureNormalConversationContext: capture, readNormalConversationContext: restore } = await import("../src/features/conversations/normal-conversation-context.ts");
hook.deregister();

const at = (minute) => new Date(Date.UTC(2026, 8, 6, 0, minute)).toISOString();
const payload = (body) => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-context-test-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "N03", objective: "Frozen normal context" }, at(0));
  return { cwd, store, database, thread };
}

function user(f, index, legacy = false) {
  const id = `turn-${index}`;
  const itemId = `conversation-user:${id}`;
  const body = `ROUND_${index}_USER`;
  if (legacy) {
    f.store.createLingTurn({ id, threadId: f.thread.id, teammateId: "ling_agent", sourceItemId: itemId,
      kind: "manual_followup", title: body, userInstruction: body, createdByActor: "local-user" }, at(index));
    f.store.appendConversationItem({ id: itemId, threadId: f.thread.id, turnId: id, kind: "user_message",
      actorType: "local_user", visibility: "thread_participants", payload: payload(body), domainRefs: [{ type: "turn", id }] }, at(index));
  } else {
    f.store.appendConversationUserTurn({ itemId, turnId: id, threadId: f.thread.id, title: body, userInstruction: body,
      payload: payload(body), domainRefs: [{ type: "turn", id }], idempotencyKey: `user-${index}` }, at(index));
  }
  return f.store.getLingTurn(id);
}

function reply(f, turn, canonical = false, body = `${turn.id}_ASSISTANT`) {
  const runId = `run-${turn.id}`;
  f.store.createRun({ id: runId, cwd: f.cwd, taskId: `task-${turn.id}`, providerName: "openai", providerModel: "fixture",
    threadId: f.thread.id, turnId: turn.id, teammateId: "ling_agent", taskSnapshot: { id: `task-${turn.id}`, title: turn.title, prompt: turn.userInstruction },
    providerSnapshot: { provider: "openai", model: "fixture" }, requestSnapshot: { threadId: f.thread.id, turnId: turn.id }, createdAt: turn.createdAt });
  f.store.appendEvent(runId, "message_end", { role: "assistant", text: body });
  if (canonical) f.store.appendConversationItem({ id: `answer-${turn.id}`, threadId: f.thread.id, turnId: turn.id,
    kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent", visibility: "thread_participants",
    payload: { body, format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: "narration" },
    domainRefs: [{ type: "turn", id: turn.id }, { type: "run", id: runId }] }, turn.createdAt);
  return runId;
}

test("capture preserves twelve rounds of canonical and verified legacy narration, never current input", async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 12; index += 1) reply(f, user(f, index, index <= 4), index > 4);
  const source = user(f, 13);
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.equal(captured.hydration.entries.filter((entry) => entry.role === "user").length, 12);
  assert.equal(captured.hydration.entries.filter((entry) => entry.role === "assistant").length, 12);
  assert.equal(captured.hydration.entries.filter((entry) => entry.origin === "run_narration").length, 4);
  assert.equal(captured.renderedHistory.includes("ROUND_13_USER"), false);
  for (let index = 1; index <= 12; index += 1) assert.ok(captured.renderedHistory.includes(`turn-${index}_ASSISTANT`));
  assert.deepEqual(restore(JSON.parse(JSON.stringify(redactSecrets(captured)))), captured);
});

test("existing canonical assistant omitted by budget or visibility cannot be resurrected from events", async (t) => {
  for (const reason of ["budget", "visibility", "segment"]) {
    const f = await fixture(t);
    const first = user(f, 1);
    const body = `FORBIDDEN_${reason}_` + "x".repeat(reason === "budget" ? 2_000 : 10);
    reply(f, first, true, body);
    if (reason === "visibility") f.database.prepare("UPDATE conversation_items SET visibility='operator' WHERE id=?").run(`answer-${first.id}`);
    const source = user(f, 2);
    if (reason === "segment") f.store.applyTurnContextAssignment({ turnId: source.id, target: { kind: "new", state: "active" },
      status: "committed", decisionSource: "user", policyVersion: "test", evidenceRefs: [] }, at(3));
    const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId, maxHistoryTextChars: 1_024 });
    assert.equal(captured.renderedHistory.includes(`FORBIDDEN_${reason}`), false, reason);
    assert.equal(captured.hydration.entries.some((entry) => entry.origin === "run_narration"), false, reason);
  }
});

test("snapshot is detached, redaction-stable, and restored without any store access", async (t) => {
  const f = await fixture(t);
  reply(f, user(f, 1, true), false, "Keep project AMBER and sk-test-not-a-real-secret-123456.");
  const source = user(f, 2);
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("sk-test-not-a-real-secret"), false);
  f.store.appendEvent("run-turn-1", "message_end", { role: "assistant", text: "LATE_HISTORY" });
  const restored = restore(JSON.parse(JSON.stringify(redactSecrets(captured))));
  assert.equal(JSON.stringify(restored), serialized);
  assert.equal(restored.renderedHistory.includes("LATE_HISTORY"), false);
  const changed = JSON.parse(serialized);
  changed.renderedHistory += "FORGED";
  assert.throws(() => restore(changed), /snapshot|fingerprint/i);
});

test("collector reads inside the database snapshot, not merely a synchronous JavaScript interval", async (t) => {
  const f = await fixture(t);
  reply(f, user(f, 1, true));
  const source = user(f, 2);
  const originalList = f.store.listEvents.bind(f.store);
  let changed = false;
  f.store.listEvents = (runId, options) => {
    if (!changed) {
      changed = true;
      f.database.prepare("UPDATE run_events SET data_json=? WHERE run_id=?").run(JSON.stringify({ role: "assistant", text: "CONCURRENT_WRITE" }), runId);
    }
    return originalList(runId, options);
  };
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.ok(captured.renderedHistory.includes("turn-1_ASSISTANT"));
  assert.equal(captured.renderedHistory.includes("CONCURRENT_WRITE"), false);
});

test("legacy hidden, foreign and stale canonical user sources never fall back to Turn instruction", async (t) => {
  for (const reason of ["hidden", "foreign", "stale"]) {
    const f = await fixture(t);
    const old = user(f, 1, true);
    reply(f, old, false, "DENIED_ASSISTANT");
    if (reason === "hidden") f.database.prepare("UPDATE conversation_items SET visibility='operator' WHERE id=?").run(old.sourceItemId);
    if (reason === "stale") f.database.prepare("UPDATE conversation_items SET status='failed', committed_at=NULL WHERE id=?").run(old.sourceItemId);
    if (reason === "foreign") {
      const other = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Foreign", objective: "Foreign" }, at(0));
      const source = f.store.appendConversationUserTurn({ threadId: other.id, title: "Foreign", userInstruction: "FOREIGN_USER", payload: payload("FOREIGN_USER"), idempotencyKey: "foreign" }, at(1));
      f.database.prepare("DELETE FROM conversation_items WHERE id=?").run(old.sourceItemId);
      f.database.prepare("UPDATE ling_turns SET source_item_id=? WHERE id=?").run(source.item.id, old.id);
    }
    const source = user(f, 2);
    const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
    assert.equal(captured.renderedHistory.includes("ROUND_1_USER"), false, reason);
    assert.equal(captured.renderedHistory.includes("FOREIGN_USER"), false, reason);
  }
});

test("legacy narration is not admitted after multiple segments exist", async (t) => {
  const f = await fixture(t);
  reply(f, user(f, 1, true), false, "LEGACY_DENIED");
  const source = user(f, 2);
  f.store.applyTurnContextAssignment({ turnId: source.id, target: { kind: "new", state: "active" }, status: "committed", decisionSource: "user", policyVersion: "test", evidenceRefs: [] }, at(3));
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.equal(captured.renderedHistory.includes("LEGACY_DENIED"), false);
});

test("summary-covered canonical assistant is never resurrected as run narration", async (t) => {
  const f = await fixture(t);
  const old = user(f, 1);
  reply(f, old, true, "COVERED_ASSISTANT");
  const source = user(f, 3);
  const assignment = f.store.getEffectiveTurnContextAssignment(source.id);
  const answer = f.store.getConversationItem(`answer-${old.id}`);
  f.database.prepare(`INSERT INTO conversation_context_summaries (id, workspace_id, thread_id, segment_id, scope, status, version,
    covered_from_sequence, covered_through_sequence, objective, decisions_json, constraints_json, open_questions_json,
    active_work_refs_json, source_refs_json, policy_version, created_at)
    VALUES ('summary-1', 'workspace_default', ?, ?, 'segment', 'active', 1, 1, ?, 'SUMMARY_ONLY', '[]', '[]', '[]', '[]', ?, 'test', ?)`)
    .run(f.thread.id, assignment.segmentId, answer.sequence, JSON.stringify([{ type: "conversation_item", id: old.sourceItemId }, { type: "conversation_item", id: answer.id }]), at(2));
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.ok(captured.renderedHistory.includes("SUMMARY_ONLY"));
  assert.equal(captured.renderedHistory.includes("COVERED_ASSISTANT"), false);
});

test("latest retry uses its exact owner and foreign Run snapshot is rejected", async (t) => {
  const f = await fixture(t);
  const old = user(f, 1);
  reply(f, old, false, "OLD_ATTEMPT");
  f.store.createRun({ id: "retry-run", cwd: f.cwd, taskId: "retry-task", providerName: "openai", providerModel: "fixture", threadId: f.thread.id,
    turnId: old.id, teammateId: "ling_agent", taskSnapshot: { id: "retry-task", title: "Retry", prompt: "Retry" },
    providerSnapshot: { provider: "openai", model: "fixture" }, requestSnapshot: { threadId: f.thread.id, turnId: old.id }, createdAt: at(2) });
  f.store.appendEvent("retry-run", "message_end", { role: "assistant", text: "LATEST_RETRY" });
  const source = user(f, 3);
  const captured = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.ok(captured.renderedHistory.includes("LATEST_RETRY"));
  assert.equal(captured.renderedHistory.includes("OLD_ATTEMPT"), false);
  f.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify({ threadId: "foreign", turnId: old.id }), "retry-run");
  const rejected = capture({ store: f.store, threadId: f.thread.id, sourceItemId: source.sourceItemId });
  assert.equal(rejected.renderedHistory.includes("LATEST_RETRY"), false);
});
