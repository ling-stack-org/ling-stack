import assert from "node:assert/strict";
import test from "node:test";
import { userInputTranscriptFixture, now } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { createOwnedRunNarrationAccumulator } from "../dist/features/conversations/narration-owner.js";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";
import { projectTeammateDirectMessageNarration } from "../dist/features/teammates/direct-message-narration.js";
import { createTeammateDirectRunProjection } from "../dist/features/teammates/direct-execution-projection.js";
import { attachDirectRuntimeProjectionPorts, DIRECT_RUNTIME_FIXTURE_FENCE } from "./helpers/direct-runtime-projection-ports.mjs";

async function fixture(t, surface = "normal") {
  const f = await userInputTranscriptFixture(t, { surface });
  f.created = f.store.appendEvent(f.run.id, "run_created", {
    workUnitId: f.unit.id, attemptId: f.attempt.id, threadId: f.thread.id, teammateId: f.participantId,
  });
  f.scope = { threadId: f.thread.id, turnId: f.turn.turnId, participantId: f.participantId, kind: f.thread.kind };
  f.source = { workspaceId: f.thread.workspaceId, threadId: f.thread.id, turnId: f.turn.turnId,
    runId: f.run.id, workUnitId: f.unit.id, attemptId: f.attempt.id, participantId: f.participantId };
  f.fold = () => f.store.readSnapshot(() => createOwnedRunNarrationAccumulator(f.store, f.run.id, f.scope));
  f.append = text => f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text });
  return f;
}

test("normal conversation waiting for approval does not publish a failure placeholder", async t => {
  const f = await fixture(t);
  const transition = f.store.transitionRunStatus({
    runId: f.run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now,
  });
  assert.equal(transition.ok, true);
  const detail = buildConversationDetail(f.store, f.cwd, f.store.getLingThread(f.thread.id));
  const user = detail.messages.find(message => message.role === "user");
  const assistant = detail.messages.find(message => message.role === "assistant");
  assert.equal(user.status, "running");
  assert.equal(assistant.status, "running");
  assert.equal(assistant.content, "");
  assert.equal(assistant.contentSource, "host_status");
});

test("interrupted normal detail marks a Host placeholder, never model narration, without writing history", async t => {
  const f = await fixture(t);
  f.store.appendEvent(f.run.id, "run_error", { message: "runtime_interrupted_no_checkpoint" });
  f.store.markRunFailed(f.run.id, now, "runtime_interrupted_no_checkpoint");
  const before = f.store.countEvents(f.run.id);
  const assistant = buildConversationDetail(f.store, f.cwd, f.thread).messages.find(row => row.role === "assistant");
  assert.equal(assistant.contentSource, "host_status");
  assert.ok(assistant.content.trim());
  assert.equal(assistant.errorMessage, "runtime_interrupted_no_checkpoint");
  assert.deepEqual(assistant.narrationSegments, []);
  assert.equal(f.store.countEvents(f.run.id), before);
  assert.equal(f.store.getConversationItem("narration:" + f.run.id), undefined);
});

test("real failure commentary keeps model provenance even when it uses the same words as the Host fallback", async t => {
  const f = await fixture(t);
  const text = "Ling 助手暂时无法完成这次请求。";
  f.append(text);
  f.store.appendEvent(f.run.id, "run_error", { message: "runtime_interrupted_no_checkpoint" });
  f.store.markRunFailed(f.run.id, now, "runtime_interrupted_no_checkpoint");
  const assistant = buildConversationDetail(f.store, f.cwd, f.thread).messages.find(row => row.role === "assistant");
  assert.equal(assistant.content, text);
  assert.equal(assistant.contentSource, "run_narration");
  assert.equal(assistant.narrationSegments.length, 1);
});

for (const surface of ["normal", "private"]) {
  test(surface + " history exposes fixed attempt ownership without writing facts", async t => {
    const f = await fixture(t, surface);
    const event = f.append("Before question.");
    const before = f.store.countEvents(f.run.id);
    let message;
    if (surface === "normal") {
      message = buildConversationDetail(f.store, f.cwd, f.thread).messages.find(row => row.role === "assistant");
    } else {
      message = projectTeammateDirectMessageNarration(f.store, {
        ...f.directMessage, id: "fixture-reply", authorType: "ai-teammate", authorId: f.participantId, linkedRunId: f.run.id,
      });
    }
    assert.deepEqual(message.narrationSegments[0].source, f.source);
    assert.equal(message.narrationSegments[0].firstEventId, event.id);
    assert.equal(f.store.countEvents(f.run.id), before);
    assert.ok(!JSON.stringify(message.narrationSegments).includes("fencingToken"));
    assert.ok(!JSON.stringify(message.narrationSegments).includes("source-runtime"));
  });
}

test("current WorkUnit successor cannot relabel an older Run narrative", async t => {
  const f = await fixture(t);
  const next = f.store.createWorkUnitAttempt({
    workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "successor", runnerId: f.attempt.runnerId,
    status: "started", now,
  });
  assert.notEqual(next.id, f.attempt.id);
  const fold = f.fold();
  fold.append(f.append("Original attempt."));
  assert.deepEqual(fold.snapshot().narrationSegments[0].source, f.source);
});

test("live and replay revoke all ownership after conflicting attempt, even without new text", async t => {
  const f = await fixture(t), live = f.fold();
  const first = f.append("Owned at first.");
  live.append(first);
  assert.deepEqual(live.snapshot().narrationSegments[0].source, f.source);
  const conflict = f.store.appendEvent(f.run.id, "tool_update", {
    toolCallId: "fixture-call", toolName: "read", partialResult: {}, attemptId: "foreign-attempt",
  });
  live.append(conflict);
  assert.equal(live.sourceRevision, 1);
  assert.equal(live.snapshot().narrationSegments[0].source, undefined);
  const replay = f.fold();
  f.store.listEvents(f.run.id).forEach(event => replay.append(event));
  assert.deepEqual(replay.snapshot(), live.snapshot());
});

for (const key of ["attemptId", "workUnitId", "threadId", "turnId", "participantId", "teammateId", "workflowStepId"]) {
  test("explicit " + key + " conflict cannot borrow narrative ownership", async t => {
    const f = await fixture(t), fold = f.fold();
    fold.append(f.append("First."));
    fold.append({ id: "conflict", runId: f.run.id, seq: 99, ts: now, type: "tool_update", data: { [key]: "foreign" } });
    assert.equal(fold.sourceLineage, undefined);
    assert.equal(fold.snapshot().narrationSegments[0].source, undefined);
  });
}

test("foreign Run and replayed events neither advance the cursor nor leak text", async t => {
  const f = await fixture(t), fold = f.fold();
  fold.append({ id: "foreign", runId: "other", seq: 999, ts: now, type: "message_end", data: { role: "assistant", text: "PRIVATE", attemptId: "other" } });
  const own = f.append("Owned."); fold.append(own); fold.append(own);
  assert.equal(fold.snapshot().content, "Owned.");
  assert.deepEqual(fold.sourceLineage, f.source);
});

test("missing creation evidence never borrows activeAttemptId", async t => {
  const f = await fixture(t);
  const list = f.store.listEvents.bind(f.store);
  f.store.listEvents = (id, options) => list(id, options).filter(event => event.type !== "run_created");
  const fold = f.fold();
  fold.append(f.append("Readable without attribution."));
  assert.equal(fold.snapshot().narrationSegments[0].source, undefined);
});

test("duplicate creation identity and repeated conflicting event withdraw ownership", async t => {
  const f = await fixture(t), fold = f.fold();
  fold.append(f.created);
  fold.append(f.append("First."));
  fold.append({ ...f.created, data: { ...f.created.data, attemptId: "different" } });
  assert.equal(fold.sourceLineage, undefined);
  const second = f.fold(); second.append(f.append("Second."));
  second.append({ ...f.created, id: "second-creation", seq: 100 });
  assert.equal(second.sourceLineage, undefined);
});

test("creation discovery across event pages is bounded and uses fixed IDs", async t => {
  const f = await fixture(t), original = f.store.listEvents.bind(f.store);
  const reads = [];
  f.store.listEvents = (id, options) => {
    reads.push(options.afterSeq);
    return options.afterSeq === 0 ? [{ id: "preface", runId: id, seq: 1000, type: "turn_start", ts: now, data: {} }]
      : options.afterSeq === 1000 ? [{ ...f.created, seq: 1001 }] : original(id, options);
  };
  assert.deepEqual(f.fold().sourceLineage, f.source);
  assert.deepEqual(reads, [0, 1000]);
});

test("private live source withdrawal is emitted without another text delta", async t => {
  const f = await fixture(t, "private");
  let message = f.store.createTeammateDirectMessage({
    threadId: f.directThread.id, teammateId: f.participantId, authorType: "ai-teammate",
    authorId: f.participantId, body: "", status: "pending",
  }, now);
  attachDirectRuntimeProjectionPorts(f.store, { readMessage: () => message,
    writeMessage: update => message = f.store.updateTeammateDirectMessageRuntime(message.id, update, now) });
  const deltas = [];
  const projection = createTeammateDirectRunProjection({
    store: f.store, pendingMessageId: message.id,
    scope: { teammateId: f.participantId, directThreadId: f.directThread.id, canonicalThreadId: f.thread.id, turnId: f.turn.turnId },
    stream: { onDelta: (dto, delta) => deltas.push({ dto, delta }) },
  });
  projection.sink.writeReady({ runId: f.run.id, sourceFence: DIRECT_RUNTIME_FIXTURE_FENCE });
  const first = f.append("Owned.");
  projection.sink.writeEvent("run_event", first);
  assert.deepEqual(deltas.at(-1).dto.narrationSegments[0].source, f.source);
  const conflict = f.store.appendEvent(f.run.id, "tool_update", {
    toolCallId: "fixture-call", toolName: "read", partialResult: {}, attemptId: "other",
  });
  projection.sink.writeEvent("run_event", conflict);
  assert.equal(deltas.at(-1).delta, "");
  assert.equal(deltas.at(-1).dto.narrationSegments[0].source, undefined);
  assert.equal(deltas.at(-1).dto.narrationSegments[0].sourceRevision, 1);
  assert.equal(deltas.length, 2);
});
