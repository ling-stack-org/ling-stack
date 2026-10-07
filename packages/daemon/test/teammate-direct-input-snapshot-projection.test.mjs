import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { resolveTeammateDirectExecutionContext } from "../dist/features/teammates/direct-execution-context.js";
import { buildTeammateDirectTranscript } from "../dist/features/teammates/direct-transcript.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";

const now = "2026-09-30T07:00:00.000Z";
const engineer = "teammate_builtin_engineer";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-projection-test-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const teammate = store.getAiTeammate(engineer);
  const directThread = store.getOrCreateTeammateDirectThread(engineer, now);
  const sourceMessage = store.createTeammateDirectMessage({ threadId: directThread.id, teammateId: engineer,
    authorType: "local-user", body: "Read three files", status: "ready" }, now);
  const replyMessage = store.createTeammateDirectMessage({ threadId: directThread.id, teammateId: engineer,
    authorType: "ai-teammate", authorId: engineer, body: "", status: "pending" }, now);
  const execution = resolveTeammateDirectExecutionContext({ store, teammate, directThread, sourceMessage, replyMessage,
    providerPresetId: "test-provider", prompt: "PRIVATE_HISTORY_SENTINEL\nRead three files", systemPrompt: "PRIVATE_MEMORY_SENTINEL",
    workspace: { executionCwd: cwd, thread: directThread, binding: { mode: "local", status: "ready", executionPath: cwd, updatedAt: now },
      snapshot: { mode: "local", status: "ready", workspaceCwd: cwd, executionCwd: cwd } } });
  const run = store.createRun({ id: "private-snapshot-run", cwd, taskId: sourceMessage.id, threadId: execution.thread.id,
    turnId: execution.runRequest.turnId, teammateId: engineer, providerName: "test", providerModel: "test",
    taskSnapshot: execution.runRequest.task, providerSnapshot: {}, requestSnapshot: execution.runRequest, createdAt: now });
  for (const [index, path] of ["README.md", "src/app.py", "test/app_test.py"].entries()) {
    store.appendEvent(run.id, "tool_start", { toolCallId: `read-${index}`, toolName: "read", args: { path } });
    store.appendEvent(run.id, "tool_end", { toolCallId: `read-${index}`, toolName: "read", result: { content: [{ type: "text", text: "Actual read" }] } });
  }
  return { store, database, execution, run, sourceMessage };
}

test("private detail exposes consumed input metadata but never frozen prompts and reads write nothing", async (t) => {
  const f = await fixture(t);
  const before = f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n;
  const detail = buildTeammateDirectTranscript(f.store, engineer);
  assert.equal(detail.contextSnapshots.length, 1);
  const snapshot = detail.contextSnapshots[0];
  assert.equal(snapshot.id, f.execution.runRequest.teammateDirectInputRef.id);
  assert.equal(snapshot.throughItemSequence, detail.conversationItems.find(item => item.id === f.sourceMessage.id).sequence);
  assert.deepEqual(snapshot.sourceRefs, [{ type: "thread", id: detail.thread.id },
    { type: "turn", id: f.execution.runRequest.turnId }, { type: "conversation_item", id: f.sourceMessage.id }]);
  assert.equal(detail.executionActions.length, 3);
  assert.equal(detail.executionActions.every(action => action.participantId === engineer), true);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_HISTORY_SENTINEL|PRIVATE_MEMORY_SENTINEL|teammateDirectInputRef|payload_fingerprint/);
  assert.deepEqual(buildTeammateDirectTranscript(f.store, engineer).contextSnapshots, detail.contextSnapshots);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, before);
  assert.equal(buildTeammateDirectTranscript(f.store, "teammate_builtin_designer"), undefined);
});

test("private grouping metadata rejects drifted Run references and consumed prompts without hiding actions", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { teammateDirectInputRef: { ...f.execution.runRequest.teammateDirectInputRef, id: "foreign-snapshot" } },
    { teammateDirectInputRef: { ...f.execution.runRequest.teammateDirectInputRef, fingerprint: "forged" } },
    { task: { ...f.execution.runRequest.task, prompt: "not the frozen input" } },
    { systemPrompt: "not the frozen system input" },
    { sourceMessageId: "foreign-source" },
  ]) {
    f.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.execution.runRequest, ...patch }), f.run.id);
    const detail = buildTeammateDirectTranscript(f.store, engineer);
    assert.equal(detail.contextSnapshots.length, 0, JSON.stringify(patch));
    assert.equal(detail.executionActions.length, 3, "invalid grouping evidence must not hide atomic facts");
  }
});

test("private grouping metadata fails closed for missing or corrupt snapshots without repairing records", async (t) => {
  const f = await fixture(t);
  const id = f.execution.runRequest.teammateDirectInputRef.id;
  f.database.prepare("UPDATE conversation_context_snapshots SET payload_json=? WHERE id=?").run("corrupt", id);
  assert.equal(buildTeammateDirectTranscript(f.store, engineer).contextSnapshots.length, 0);
  assert.equal(f.database.prepare("SELECT payload_json FROM conversation_context_snapshots WHERE id=?").get(id).payload_json, "corrupt");
  f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(id);
  const detail = buildTeammateDirectTranscript(f.store, engineer);
  assert.equal(detail.contextSnapshots.length, 0);
  assert.equal(detail.executionActions.length, 3);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 0);
});

test("external Run parsing cannot accept the internal private snapshot reference", async (t) => {
  const f = await fixture(t);
  const request = parseRunRequest(f.execution.runRequest);
  assert.equal(Object.hasOwn(request, "teammateDirectInputRef"), false);
});
