import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { resolveTeammateDirectExecutionContext } from "../dist/features/teammates/direct-execution-context.js";

const now = "2026-09-05T10:00:00.000Z";

async function fixture(t, authorType = "local-user") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-ingest-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const teammate = store.getAiTeammate("teammate_builtin_engineer");
  assert.ok(teammate);
  const directThread = store.getOrCreateTeammateDirectThread(teammate.id, now);
  const sourceMessage = store.createTeammateDirectMessage({
    threadId: directThread.id, teammateId: teammate.id, authorType,
    body: "Read README.md and report.", status: "ready",
    fileRefs: [{ path: "README.md", label: "README.md", line: 1 }],
  }, now);
  const replyMessage = store.createTeammateDirectMessage({
    threadId: directThread.id, teammateId: teammate.id, authorType: "ai-teammate",
    authorId: teammate.id, body: "", status: "pending",
  }, now);
  return {
    store, teammate, directThread, sourceMessage, replyMessage,
    providerPresetId: "provider-test",
    workspace: {
      thread: directThread,
      binding: { mode: "local", status: "ready", executionPath: cwd, updatedAt: now },
      snapshot: { mode: "local", status: "ready", workspaceCwd: cwd, executionCwd: cwd },
      executionCwd: cwd,
    },
    // Canonical history owns the actual message, not the rendered model context.
    prompt: "Private history context\n\nRead README.md and report.",
    systemPrompt: "Use only this teammate's private context.",
  };
}

test("private execution ingests a real owned canonical anchor before starting a run", async (t) => {
  const input = await fixture(t);
  const execution = resolveTeammateDirectExecutionContext(input);
  assert.ok(execution.runRequest.turnId, "private RunRequest must carry a canonical turn id");
  const turn = input.store.getLingTurn(execution.runRequest.turnId);
  const item = input.store.getConversationItem(input.sourceMessage.id);
  assert.ok(turn, "private RunRequest must reference its atomically ingested turn");
  assert.ok(item, "private tools must be anchored in durable conversation history");
  assert.equal(turn.threadId, execution.thread.id);
  assert.equal(turn.sourceItemId, item.id);
  assert.equal(turn.userInstruction, input.sourceMessage.body);
  assert.equal(turn.teammateId, input.teammate.id);
  assert.equal(item.turnId, turn.id);
  assert.equal(item.channelId, undefined);
  assert.equal(item.visibility, "agent_private");
  assert.equal(item.visibilityOwnerId, input.teammate.id);
  assert.equal(item.payload.body, input.sourceMessage.body);
  assert.deepEqual(item.payload.fileRefs, [{ path: "README.md", label: "README.md", line: 1, source: "explicit_text" }]);
  assert.equal(execution.runRequest.sourceMessageId, item.id);
  assert.equal(execution.runRequest.task.prompt, input.prompt);

  const replay = resolveTeammateDirectExecutionContext({ ...input, prompt: "New rendered context" });
  assert.equal(replay.runRequest.turnId, turn.id);
  assert.equal(replay.runRequest.task.prompt, input.prompt, "replay must consume the original frozen private input");
  assert.deepEqual(replay.runRequest.teammateDirectInputRef, execution.runRequest.teammateDirectInputRef);
  assert.ok(execution.runRequest.teammateDirectInputRef?.fingerprint, "private Run must bind immutable context evidence");
  assert.deepEqual(input.store.listConversationItemsForTurn({ turnId: turn.id }), [item]);
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, sourceMessage: { ...input.sourceMessage, body: "Conflicting message with the same id" },
  }), /idempotency key belongs to another input/);
});

test("private execution rejects a different teammate or lane without creating a turn", async (t) => {
  const input = await fixture(t);
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, sourceMessage: { ...input.sourceMessage, teammateId: "teammate_builtin_designer" },
  }), /does not belong|scope mismatch/);
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, replyMessage: { ...input.replyMessage, threadId: "another-direct-thread" },
  }), /does not belong|scope mismatch/);
  assert.equal(input.store.getConversationItem(input.sourceMessage.id), undefined);
});

test("private execution replays its accepted title after the teammate is renamed", async (t) => {
  const input = await fixture(t);
  const original = resolveTeammateDirectExecutionContext(input);
  const originalTurn = input.store.getLingTurn(original.runRequest.turnId);
  const originalItem = input.store.getConversationItem(input.sourceMessage.id);
  const teammate = input.store.updateAiTeammate(input.teammate.id, {
    displayName: "Renamed Private Engineer",
  }, "2026-09-05T10:01:00.000Z");
  assert.ok(teammate);

  const replay = resolveTeammateDirectExecutionContext({ ...input, teammate });
  assert.equal(replay.runRequest.turnId, originalTurn.id);
  assert.deepEqual(input.store.getLingTurn(originalTurn.id), originalTurn);
  assert.deepEqual(input.store.listConversationItemsForTurn({ turnId: originalTurn.id }), [originalItem]);
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, teammate, sourceMessage: { ...input.sourceMessage, body: "Changed under the same source id" },
  }), /idempotency key belongs to another input/);
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, teammate, sourceMessage: { ...input.sourceMessage, teammateId: "teammate_builtin_designer" },
  }), /scope mismatch/);
});

test("private execution rejects accepted canonical anchors outside its private scope", async (t) => {
  const input = await fixture(t);
  const original = resolveTeammateDirectExecutionContext(input);
  const originalTurn = input.store.getLingTurn(original.runRequest.turnId);
  const originalItem = input.store.getConversationItem(input.sourceMessage.id);
  const cases = [
    { name: "item owner", item: { visibilityOwnerId: "another-teammate" } },
    { name: "item thread", item: { threadId: "another-thread" } },
    { name: "item visibility", item: { visibility: "channel" } },
    { name: "turn owner", turn: { teammateId: "another-teammate" } },
    { name: "turn thread", turn: { threadId: "another-thread" } },
    { name: "turn channel", turn: { channelId: "another-channel" } },
    { name: "turn source", turn: { sourceItemId: "another-source" } },
    { name: "missing turn", turn: null },
  ];
  for (const scenario of cases) {
    const store = new Proxy(input.store, {
      get(target, key) {
        if (key === "getConversationItemByIdempotencyKey") {
          return () => ({ ...originalItem, ...scenario.item });
        }
        if (key === "getLingTurn") {
          return () => scenario.turn === null ? undefined : { ...originalTurn, ...scenario.turn };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.throws(() => resolveTeammateDirectExecutionContext({ ...input, store }),
      /canonical replay scope mismatch/, scenario.name);
  }
  assert.deepEqual(input.store.getLingTurn(originalTurn.id), originalTurn);
  assert.deepEqual(input.store.getConversationItem(originalItem.id), originalItem);
});

test("system-triggered private execution retains system actor identity", async (t) => {
  const input = await fixture(t, "system");
  const execution = resolveTeammateDirectExecutionContext({ ...input, continuationReason: "queue_followup" });
  assert.ok(execution.runRequest.turnId, "system private input must also have a canonical turn id");
  const item = input.store.getConversationItem(input.sourceMessage.id);
  const turn = input.store.getLingTurn(execution.runRequest.turnId);
  assert.equal(item?.actorType, "system");
  assert.equal(turn?.createdByActor, "system");
  assert.equal(turn?.kind, "queued_followup");
});

test("a committed private message edit creates a new canonical source without overwriting history", async (t) => {
  const input = await fixture(t);
  const original = resolveTeammateDirectExecutionContext(input);
  const originalItem = input.store.getConversationItem(input.sourceMessage.id);
  const current = {
    body: input.sourceMessage.body, mentions: [], attachmentIds: [], linkPreviewIds: [],
    fileRefs: input.sourceMessage.fileRefs,
  };
  const committed = input.store.commitConversationMessageEdit({
    surface: "teammate_direct", ownerId: input.teammate.id, laneId: input.directThread.id,
    messageId: input.sourceMessage.id, expectedRevision: 1, current,
    replacement: { ...current, body: "Read the revised README.md only." },
    sourceTurnId: original.runRequest.turnId, supersededTurnId: original.runRequest.turnId,
    idempotencyKey: "private-edit-test",
  }, "2026-09-05T10:01:00.000Z");
  const sourceMessage = input.store.getTeammateDirectMessage(input.sourceMessage.id);
  const replacement = resolveTeammateDirectExecutionContext({ ...input, sourceMessage });
  const turn = input.store.getLingTurn(replacement.runRequest.turnId);
  const replacementItem = input.store.getConversationItem(turn.sourceItemId);
  assert.notEqual(turn.id, original.runRequest.turnId);
  assert.equal(replacementItem.supersedesItemId, originalItem.id);
  assert.equal(replacementItem.payload.body, committed.revision.body);
  assert.equal(replacementItem.visibilityOwnerId, input.teammate.id);
  assert.deepEqual(input.store.getConversationItem(originalItem.id), originalItem);
  assert.equal(replacement.runRequest.sourceMessageId, input.sourceMessage.id,
    "work unit ownership must remain on the private message, not a canonical revision id");
  assert.equal(resolveTeammateDirectExecutionContext({ ...input, sourceMessage }).runRequest.turnId, turn.id);
  const teammate = input.store.updateAiTeammate(input.teammate.id, {
    displayName: "Renamed After Revision",
  }, "2026-09-05T10:02:00.000Z");
  assert.equal(resolveTeammateDirectExecutionContext({ ...input, teammate, sourceMessage }).runRequest.turnId, turn.id);
  assert.deepEqual(input.store.getLingTurn(turn.id), turn);
  assert.throws(() => resolveTeammateDirectExecutionContext({ ...input, teammate }),
    /does not match its committed revision/, "a stale pre-edit source cannot replay the revised source");
  assert.throws(() => resolveTeammateDirectExecutionContext({
    ...input, teammate, sourceMessage: { ...sourceMessage, body: "Uncommitted revision contents" },
  }), /does not match its committed revision/);
  assert.deepEqual(input.store.getConversationItem(originalItem.id), originalItem);
  assert.deepEqual(input.store.getConversationItem(replacementItem.id), replacementItem);
});
