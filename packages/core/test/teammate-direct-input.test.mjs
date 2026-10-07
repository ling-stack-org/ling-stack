import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { isConversationContextProjectionMetadata } from "@ling-stack/contracts";

const now = "2026-09-30T06:00:00.000Z";
const engineer = "teammate_builtin_engineer";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-input-test-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  const database = new DatabaseSync(f.store.paths.databasePath);
  database.exec("PRAGMA busy_timeout=1");
  t.after(async () => { database.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = f.store.createLingThread({ kind: "teammate_direct", teammateId: engineer, title: "Private", objective: "Frozen input" }, now);
  const input = { threadId: thread.id, teammateId: engineer, turnId: "private-turn", itemId: "private-item",
    title: "Private source", userInstruction: "Read README.md", idempotencyKey: "private-key",
    payload: { body: "Read README.md", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    executionInput: { prompt: "PRIVATE_HISTORY\nRead README.md", systemPrompt: "Only Engineer context" } };
  return Object.assign(f, { database, thread, input });
}

test("private input freezes valid fingerprints and survives immutable replay and reopen", async (t) => {
  const f = await fixture(t);
  const first = f.store.appendTeammateDirectUserTurnWithInputSnapshot(f.input, now);
  const s = first.inputSnapshot;
  assert.equal(isConversationContextProjectionMetadata(s.projection), true);
  assert.match(s.projection.sourceStateFingerprint, /^[a-f0-9]{64}$/);
  assert.match(s.projection.visibilityFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(s.projection.segmentId, first.contextSegmentId);
  assert.equal(s.projection.throughItemSequence, first.item.sequence);
  assert.equal(Object.isFrozen(s.payload), true);
  assert.throws(() => { s.payload.prompt = "mutated"; }, TypeError);
  const replay = f.store.appendTeammateDirectUserTurnWithInputSnapshot({ ...f.input,
    executionInput: { prompt: "new history must not replace accepted input", systemPrompt: "new system" } }, now);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.inputSnapshot, s);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getTeammateDirectInputSnapshot(first.item.id, engineer), s);
  assert.deepEqual(f.store.appendTeammateDirectUserTurnWithInputSnapshot(f.input, now).inputSnapshot, s);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE source_item_id=?").get(first.item.id).n, 1);
});

test("private input keeps system actor identity and rejects source actor relabelling", async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, actorType: "system", actorId: "system" };
  const result = f.store.appendTeammateDirectUserTurnWithInputSnapshot(input, now);
  assert.equal(result.item.actorType, "system");
  assert.equal(f.store.getLingTurn(result.turnId).createdByActor, "system");
  assert.throws(() => f.store.appendTeammateDirectUserTurnWithInputSnapshot({ ...input, actorType: "local_user" }, now), /another input/);
  f.database.prepare("UPDATE ling_turns SET created_by_actor='local-user' WHERE id=?").run(result.turnId);
  assert.throws(() => f.store.getTeammateDirectInputSnapshot(result.item.id, engineer), /source scope/);
});

test("private snapshot and canonical source commit together and roll back insert failure", async (t) => {
  const f = await fixture(t);
  const executionInput = { toJSON() {
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items").get().n, 0);
    assert.throws(() => f.database.exec("BEGIN IMMEDIATE"), /locked|busy/);
    assert.throws(() => f.store.createLingThread({ kind: "conversation", title: "Forbidden", objective: "No write during serialization" }, now), /readonly|read-only/);
    return f.input.executionInput;
  } };
  f.database.exec("CREATE TRIGGER reject_private_input BEFORE INSERT ON conversation_context_snapshots BEGIN SELECT RAISE(ABORT, 'private snapshot rejected'); END");
  assert.throws(() => f.store.appendTeammateDirectUserTurnWithInputSnapshot({ ...f.input, executionInput }, now), /private snapshot rejected/);
  assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
  assert.equal(f.store.getConversationItem(f.input.itemId), undefined);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM turn_context_assignments").get().n, 0);
});

test("normal, channel and foreign private scopes cannot enter the private snapshot store", async (t) => {
  const f = await fixture(t);
  const normal = f.store.createLingThread({ kind: "conversation", title: "Normal", objective: "Normal" }, now);
  const other = f.store.createLingThread({ kind: "teammate_direct", teammateId: "teammate_builtin_designer", title: "Other", objective: "Other" }, now);
  const channel = f.store.createChannel({ name: "Channel", boundPath: f.cwd }, now);
  const root = f.store.createLingThread({ kind: "channel_root", channelId: channel.id, title: "Root", objective: "Root" }, now);
  for (const threadId of [normal.id, other.id, root.id]) {
    assert.throws(() => f.store.appendTeammateDirectUserTurnWithInputSnapshot({ ...f.input, threadId,
      ...(threadId === root.id ? { channelId: channel.id } : {}) }, now), /scope|match|teammate/);
    assert.equal(f.store.getConversationItem(f.input.itemId), undefined);
  }
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, () => assert.fail("normal guard must reject private input before capture"), now), /scope/);
});

test("missing private snapshot fails replay without recapturing historical input", async (t) => {
  const f = await fixture(t);
  const first = f.store.appendTeammateDirectUserTurnWithInputSnapshot(f.input, now);
  f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(first.inputSnapshot.id);
  assert.equal(f.store.getTeammateDirectInputSnapshot(first.item.id, engineer), undefined);
  assert.throws(() => f.store.appendTeammateDirectUserTurnWithInputSnapshot(f.input, now), /missing; cannot recapture/);
  assert.deepEqual(f.store.getConversationItem(first.item.id), first.item);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 0);
});

test("private snapshot read rejects row drift, payload corruption, forged projection and foreign owner", async (t) => {
  const f = await fixture(t);
  const first = f.store.appendTeammateDirectUserTurnWithInputSnapshot(f.input, now);
  const s = first.inputSnapshot;
  assert.throws(() => f.store.getTeammateDirectInputSnapshot(first.item.id, "teammate_builtin_designer"), /owner mismatch/);
  // Corrupt only this disposable fixture, including otherwise FK-protected fields.
  f.database.exec("PRAGMA foreign_keys=OFF");
  for (const field of ["payload_fingerprint", "thread_id", "segment_id", "source_refs_json", "policy_version"]) {
    const original = f.database.prepare(`SELECT ${field} AS value FROM conversation_context_snapshots WHERE id=?`).get(s.id).value;
    f.database.prepare(`UPDATE conversation_context_snapshots SET ${field}=? WHERE id=?`).run("corrupt", s.id);
    assert.throws(() => f.store.getTeammateDirectInputSnapshot(first.item.id, engineer), /mismatch/, field);
    f.database.prepare(`UPDATE conversation_context_snapshots SET ${field}=? WHERE id=?`).run(original, s.id);
  }
  for (const change of [
    v => { v.payload.prompt = "drift"; },
    v => { v.projection.visibilityFingerprint = "forged-owner"; },
    v => { v.projection.sourceRefs.push({ type: "conversation_item", id: "foreign-secret" }); },
  ]) {
    const value = structuredClone(s);
    change(value);
    const { fingerprint: ignored, ...body } = value;
    value.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    f.database.prepare("UPDATE conversation_context_snapshots SET payload_json=?, payload_fingerprint=? WHERE id=?")
      .run(JSON.stringify(value), value.fingerprint, s.id);
    assert.throws(() => f.store.getTeammateDirectInputSnapshot(first.item.id, engineer), /fingerprint|redaction/);
  }
  f.database.prepare("UPDATE conversation_context_snapshots SET payload_json=? WHERE id=?").run("not json", s.id);
  assert.throws(() => f.store.getTeammateDirectInputSnapshot(first.item.id, engineer), SyntaxError);
});

test("unredacted private input never persists and the source transaction rolls back", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.appendTeammateDirectUserTurnWithInputSnapshot({ ...f.input,
    executionInput: { prompt: "OPENAI_API_KEY=sk-test-private-secret-123456789", systemPrompt: "Only private" } }, now), /redaction/);
  assert.equal(f.store.getConversationItem(f.input.itemId), undefined);
  assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 0);
});
