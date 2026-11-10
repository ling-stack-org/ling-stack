import assert from "node:assert/strict";
import test from "node:test";
import { createAiTeammateDirectReply } from "../dist/features/teammates/direct-replies.js";
import { projectTeammateDirectMessageNarration } from "../dist/features/teammates/direct-message-narration.js";
import { createTeammateDirectRunProjection } from "../dist/features/teammates/direct-execution-projection.js";
import { enrichTeammateDirectMessageWithWebEvidence } from "../dist/features/web/message-web-evidence.js";
import { buildPrivateChatContextView, collectPrivateMessageSources, collectPrivateLinkedReferenceSources } from "../dist/features/channels/context-processing/private-chat.js";
import { attachDirectRuntimeProjectionPorts, DIRECT_RUNTIME_FIXTURE_FENCE } from "./helpers/direct-runtime-projection-ports.mjs";

const now = "2026-09-06T00:00:00.000Z";
const teammate = { id: "engineer", workspaceId: "workspace", displayName: "Engineer", roleKey: "engineer", description: "Build" };
const thread = { id: "direct", teammateId: teammate.id, workspaceId: "workspace", title: "Private" };
const source = { id: "source", threadId: thread.id, teammateId: teammate.id, workspaceId: "workspace", authorType: "local-user", authorId: "local-user", body: "Legacy request mentioning @designer is ordinary text.", status: "ready", attachmentIds: [], linkPreviewIds: [], fileRefs: [], createdAt: now, updatedAt: now };
const reply = { ...source, id: "reply", authorType: "ai-teammate", authorId: teammate.id, body: "Legacy answer", linkedRunId: "run" };

function fixture() {
  const run = { id: "run", teammateId: teammate.id, threadId: "canonical", taskId: source.id, requestSnapshot: {}, taskSnapshot: { title: "Private run" }, status: "succeeded" };
  const turn = { id: "turn", teammateId: teammate.id, threadId: "canonical", sourceItemId: source.id };
  const canonical = { id: "canonical", kind: "teammate_direct", teammateId: teammate.id };
  const reads = [];
  return { run, turn, reads, store: {
    readSnapshot: read => read(),
    getRun: () => run,
    getLingThread: () => canonical,
    findLingThreadByOwner: () => canonical,
    getLingTurnForRun: () => turn,
    listLingTurnRuns: () => [{ turnId: turn.id, runId: run.id }],
    listTeammateDirectThreads: () => [thread],
    getTeammateDirectMessage: (id) => id === source.id ? source : reply,
    listEvents: (_runId, { afterSeq }) => { reads.push(afterSeq); return afterSeq ? [] : [{ id: "event", runId: "run", seq: 1, ts: now, type: "message_end", data: { role: "assistant", text: "Owned narration" } }]; },
    getTask: () => assert.fail("private context must not read channel task facts"),
    getChannelWorkflowStep: () => assert.fail("private context must not read workflow facts"),
    getChannelWorkflow: () => assert.fail("private context must not read workflow facts"),
  } };
}

test("private reply idempotency validates input scope and existing reply owner, lane and author before returning", async () => {
  for (const foreign of [
    { ...reply, teammateId: "designer" }, { ...reply, threadId: "other-direct" },
    { ...reply, authorId: "designer" }, { ...reply, authorType: "local-user" },
  ]) {
    await assert.rejects(createAiTeammateDirectReply({ teammate, thread, sourceMessage: source, replyMessageId: reply.id,
      store: { getTeammateDirectMessage: () => foreign }, startRun: () => assert.fail("must not execute"),
    }), /scope|author/i);
  }
  await assert.rejects(createAiTeammateDirectReply({ teammate, thread, sourceMessage: { ...source, threadId: "other" }, replyMessageId: reply.id,
    store: { getTeammateDirectMessage: () => reply }, startRun: () => assert.fail("must not execute"),
  }), /scope/i);
  assert.equal(await createAiTeammateDirectReply({ teammate, thread, sourceMessage: source, replyMessageId: reply.id,
    store: { getTeammateDirectMessage: () => reply }, startRun: () => assert.fail("must remain idempotent"),
  }), reply);
  const legacy = { ...reply, authorId: undefined };
  assert.equal(await createAiTeammateDirectReply({ teammate, thread, sourceMessage: source, replyMessageId: reply.id,
    store: { getTeammateDirectMessage: () => legacy }, startRun: () => assert.fail("legacy replay must remain idempotent"),
  }), legacy);
});

test("private history rejects foreign input even when caller relabels the context owner", () => {
  for (const foreign of [{ ...reply, teammateId: "designer" }, { ...reply, threadId: "other" }, { ...reply, authorId: "designer" }]) {
    const input = { teammate, thread, sourceMessage: source, messages: [foreign, source], store: fixture().store, now };
    assert.throws(() => buildPrivateChatContextView(input), /scope|author/i);
    assert.throws(() => collectPrivateMessageSources(input), /scope|author/i);
    assert.throws(() => collectPrivateLinkedReferenceSources(input), /scope|author/i);
  }
  assert.throws(() => buildPrivateChatContextView({ teammate, thread, sourceMessage: { ...source, teammateId: "designer" }, messages: [], store: fixture().store, now }), /scope/i);
  const view = buildPrivateChatContextView({ teammate, thread, sourceMessage: source, messages: [source, { ...reply, linkedRunId: undefined }], store: fixture().store, now });
  assert.match(view.sections[0].text, /Legacy answer/);
  assert.match(view.sections[0].text, /@designer/);
});

test("private linked references do not read or disclose foreign Run, task or workflow facts", () => {
  const { store, run } = fixture();
  run.channelId = "foreign-channel";
  run.workflowStepId = "foreign-step";
  const message = { ...reply, linkedTaskId: "foreign-task" };
  const input = { store, teammate, thread, sourceMessage: source, messages: [message, source], now };
  assert.deepEqual(collectPrivateLinkedReferenceSources(input), []);
  const view = buildPrivateChatContextView(input);
  assert.ok(!JSON.stringify(view).includes("foreign-task"));
  assert.ok(!view.sourceRefs.some((ref) => ["task", "run", "workflow", "workflow_step", "channel"].includes(ref.type)));
});

test("private linked references retain proven private Run metadata without querying its task table", () => {
  const { store } = fixture();
  const sources = collectPrivateLinkedReferenceSources({ store, teammate, thread, messages: [reply] });
  assert.deepEqual(sources.map((item) => item.id), ["private_ref:run:run"]);
  assert.equal(sources[0].title, "Private run");
  assert.equal(sources[0].sensitivity, "private");
});

test("private narration validates native lane, private Thread, owning Turn and Run link before events", () => {
  const cases = [
    (f) => { f.run.channelId = "channel"; },
    (f) => { f.run.workflowStepId = "step"; },
    (f) => { f.turn.teammateId = "designer"; },
    (f) => { f.turn.threadId = "foreign-canonical"; },
    (f) => { f.turn.channelId = "channel"; },
    (f) => { f.turn.workflowStepId = "step"; },
    (f) => { f.store.getLingTurnForRun = () => undefined; },
    (f) => { f.store.listLingTurnRuns = () => [{ turnId: "other-turn", runId: "run" }]; },
    (f) => { f.store.listTeammateDirectThreads = () => [{ ...thread, id: "other-direct" }]; },
    (f) => { f.run.requestSnapshot = { teammateId: "designer" }; },
    (f) => { f.run.requestSnapshot = { threadId: "foreign-canonical" }; },
    (f) => { f.run.requestSnapshot = { turnId: "foreign-turn" }; },
    (f) => { f.run.requestSnapshot = { linkedMessageId: "other-reply" }; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    assert.equal(projectTeammateDirectMessageNarration(f.store, reply), reply);
    assert.deepEqual(f.reads, []);
  }
  const f = fixture();
  assert.equal(projectTeammateDirectMessageNarration(f.store, reply).body, "Owned narration");
  const legacy = { ...reply, linkedRunId: undefined };
  assert.equal(projectTeammateDirectMessageNarration(f.store, legacy), legacy);
});

test("private live sink revalidates ownership through Core ports and ignores events outside its Run", () => {
  for (const corrupt of [undefined, "workflow", "turn"]) {
    const f = fixture();
    let message = { ...reply, linkedRunId: undefined, status: "pending", body: "" };
    const writes = [];
    f.store.getTeammateDirectMessage = () => message;
    attachDirectRuntimeProjectionPorts(f.store, { readMessage: () => message,
      writeMessage: update => { writes.push(update); return message = { ...message, ...update }; } });
    if (corrupt === "workflow") f.run.workflowStepId = "foreign-step";
    if (corrupt === "turn") f.turn.id = "different-turn";
    const projection = createTeammateDirectRunProjection({ store: f.store, pendingMessageId: message.id,
      scope: { teammateId: teammate.id, directThreadId: thread.id, canonicalThreadId: "canonical", turnId: "turn" } });
    projection.sink.writeEvent("run_event", { id: "before-ready", runId: "run", seq: 1, ts: now, type: "message_end", data: { role: "assistant", text: "Unlinked" } });
    assert.deepEqual(writes, []);
    if (corrupt) {
      // Wrong canonical Turn throws; foreign Run observations are a safe no-op.
      if (corrupt === "turn") assert.throws(() => projection.sink.writeReady({ runId: "run", sourceFence: DIRECT_RUNTIME_FIXTURE_FENCE }), /scope|owner/i);
      else projection.sink.writeReady({ runId: "run", sourceFence: DIRECT_RUNTIME_FIXTURE_FENCE });
      assert.deepEqual(writes, []);
      continue;
    }
    projection.sink.writeReady({ runId: "run", sourceFence: DIRECT_RUNTIME_FIXTURE_FENCE });
    projection.sink.writeEvent("run_event", { id: "foreign", runId: "other-run", seq: 2, ts: now, type: "message_end", data: { role: "assistant", text: "Foreign" } });
    projection.sink.writeEvent("run_event", { id: "owned", runId: "run", seq: 3, ts: now, type: "message_end", data: { role: "assistant", text: "Owned" } });
    assert.equal(message.body, "Owned");
    assert.equal(projection.text(), "Owned");
    const beforeLateCallback = structuredClone(message);
    const writeCount = writes.length;
    f.run.workflowStepId = "foreign-step-after-link";
    projection.sink.writeEvent("run_event", { id: "late-foreign-owner", runId: "run", seq: 4, ts: now,
      type: "message_end", data: { role: "assistant", text: "Must not overwrite after ownership changed" } });
    assert.deepEqual(message, beforeLateCallback);
    assert.equal(writes.length, writeCount);
    assert.equal(projection.text(), "Owned");
  }
});

test("private web evidence rejects foreign WorkUnit ownership and event linkage before projection", () => {
  for (const corrupt of ["run", "unit", "owner", "linkedRun", "event", undefined]) {
    const f = fixture();
    f.run.workUnitId = "owned-unit";
    const unit = { id: "owned-unit", kind: "teammate_direct_reply", ownerType: "teammate_direct_message", ownerId: source.id,
      teammateId: teammate.id, linkedMessageId: reply.id, linkedRunId: "run" };
    if (corrupt === "run") f.run.channelId = "foreign-channel";
    if (corrupt === "unit") unit.id = "foreign-unit";
    if (corrupt === "owner") unit.ownerId = "foreign-source";
    if (corrupt === "linkedRun") unit.linkedRunId = "foreign-run";
    const runtimeReads = [];
    f.store.listWorkUnits = () => [unit];
    f.store.listRuntimeEvents = (id) => {
      runtimeReads.push(id);
      return [{ type: "web_evidence_recorded", data: { toolSurface: "web", sourceMessageId: source.id,
        linkedMessageId: corrupt === "event" ? "foreign-message" : reply.id,
        status: "available", sources: [{ url: "https://example.test", title: "Owned web fact" }], readUrls: [], updatedAt: now } }];
    };
    const result = enrichTeammateDirectMessageWithWebEvidence(f.store, reply);
    if (corrupt) assert.equal(result.webEvidence, undefined);
    else assert.equal(result.webEvidence.sources[0].title, "Owned web fact");
    assert.deepEqual(runtimeReads, corrupt && corrupt !== "event" ? [] : ["owned-unit"]);
  }
});
