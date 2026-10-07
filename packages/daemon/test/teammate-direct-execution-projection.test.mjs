import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { createTeammateDirectRunProjection } from "../dist/features/teammates/direct-execution-projection.js";

const event = (seq, type, data) => ({
  id: `event-${seq}`, runId: "run-private", seq,
  ts: "2026-09-05T00:00:00Z", type, data,
});

function createProjection() {
  let message = {
    id: "reply-private", body: "", status: "pending", authorType: "ai-teammate",
    teammateId: "engineer", authorId: "engineer", threadId: "direct-thread", linkedRunId: "run-private",
  };
  const updates = [];
  const deltas = [];
  const projection = createTeammateDirectRunProjection({
    pendingMessageId: message.id,
    scope: { teammateId: "engineer", directThreadId: "direct-thread", canonicalThreadId: "ling-thread", turnId: "private-turn" },
    store: {
      ...narrationFixture([]).store,
      getTeammateDirectMessage: () => message,
      updateTeammateDirectMessageRuntime(id, change) {
        assert.equal(id, message.id);
        message = { ...message, ...change };
        updates.push(message);
        return message;
      },
    },
    stream: { onDelta: (updated, delta) => deltas.push({ body: updated.body, delta, narrationSegments: updated.narrationSegments }) },
  });
  projection.sink.writeReady({ runId: "run-private" });
  return { ...projection, updates, deltas, message: () => message };
}

function write(projection, events) {
  for (const entry of events) projection.sink.writeEvent("run_event", entry);
}

test("private live reply preserves assistant boundaries around reads and the final report", () => {
  const projection = createProjection();
  write(projection, [
    event(1, "assistant_text_delta", { text: "我将读取文件。" }),
    event(40, "message_end", { role: "assistant", text: "我将读取文件。" }),
    event(41, "tool_start", { toolCallId: "read-1", toolName: "read", args: { path: "README.md" } }),
    event(42, "tool_end", { toolCallId: "read-1", toolName: "read", result: "Read output must not become narration." }),
    event(43, "message_end", { role: "toolResult", text: "Ignored tool result." }),
    event(50, "assistant_text_delta", { text: "接着" }),
    event(51, "assistant_text_delta", { text: "\n\n" }),
    event(52, "assistant_text_delta", { text: "运行测试。" }),
    event(76, "message_end", { role: "assistant", text: "接着\n\n运行测试。" }),
    event(77, "tool_start", { toolCallId: "test-1", toolName: "bash", args: { command: "node --test" } }),
    event(78, "tool_end", { toolCallId: "test-1", toolName: "bash", result: "tests passed" }),
    event(100, "assistant_text_delta", { text: "测试已完成。" }),
    event(355, "message_end", { role: "assistant", text: "测试已完成。" }),
  ]);
  const expected = "我将读取文件。\n\n接着\n\n运行测试。\n\n测试已完成。";
  assert.equal(projection.text(), expected);
  assert.equal(projection.message().body, expected);
  assert.equal(projection.deltas.map(({ delta }) => delta).join(""), expected);
  assert.equal(projection.message().status, "pending");
});

test("private projection is idempotent under replayed events and ignores stale text", () => {
  const projection = createProjection();
  const events = [
    event(1, "assistant_text_delta", { text: "Before." }),
    event(2, "message_end", { role: "assistant", text: "Before." }),
    event(3, "tool_start", { toolCallId: "read-1", toolName: "read", args: {} }),
    event(4, "assistant_text_delta", { text: "After." }),
    event(5, "message_end", { role: "assistant", text: "After." }),
  ];
  for (const entry of events) write(projection, [entry, entry]);
  const count = projection.updates.length;
  write(projection, [event(2, "assistant_text_delta", { text: "stale" }), ...events]);
  assert.equal(projection.text(), "Before.\n\nAfter.");
  assert.equal(projection.updates.length, count);
  assert.equal(projection.deltas.map(({ delta }) => delta).join(""), "Before.\n\nAfter.");
});

test("private projection supports final-only messages without duplicating end payloads", () => {
  const projection = createProjection();
  write(projection, [
    event(1, "message_end", { role: "assistant", text: "Final-only first." }),
    event(2, "message_end", { role: "assistant" }),
    event(3, "assistant_text_delta", { text: "Second." }),
    event(4, "message_end", { role: "assistant", text: "Second." }),
    event(5, "message_end", { role: "assistant", text: "Final-only third." }),
  ]);
  assert.equal(projection.text(), "Final-only first.\n\nSecond.\n\nFinal-only third.");
  assert.equal(projection.message().body, projection.text());
});

test("private projection still hides receipt prefixes while keeping subsequent narration", () => {
  const projection = createProjection();
  write(projection, [
    event(1, "assistant_text_delta", { text: "收到。" }),
    event(2, "message_end", { role: "assistant", text: "收到。" }),
    event(3, "assistant_text_delta", { text: "Actual answer." }),
    event(4, "message_end", { role: "assistant", text: "Actual answer." }),
    event(5, "assistant_text_delta", { text: "Next message." }),
  ]);
  assert.equal(projection.text(), "Actual answer.\n\nNext message.");
  assert.equal(projection.deltas.map(({ delta }) => delta).join(""), projection.text());
});

test("private live projection sends message_end-only completion and preserves narration identity", () => {
  const projection = createProjection();
  write(projection, [event(1, "assistant_text_delta", { text: "Before." })]);
  assert.deepEqual(projection.deltas.at(-1).narrationSegments, [{
    content: "Before.", firstEventId: "event-1", lastEventId: "event-1",
    startEventSequence: 1, endEventSequence: 1, completed: false,
  }]);
  write(projection, [event(2, "message_end", { role: "assistant", text: "Before." })]);
  assert.equal(projection.deltas.length, 2);
  assert.equal(projection.deltas.at(-1).delta, "");
  assert.deepEqual(projection.deltas.at(-1).narrationSegments, [{
    content: "Before.", firstEventId: "event-1", lastEventId: "event-2",
    startEventSequence: 1, endEventSequence: 2, completed: true,
  }]);
  write(projection, [event(2, "message_end", { role: "assistant", text: "Before." })]);
  assert.equal(projection.deltas.length, 2);
});

function narrationFixture(events) {
  const message = {
    id: "reply-private", authorType: "ai-teammate", body: "Old concatenated body.",
    teammateId: "engineer", authorId: "engineer", threadId: "direct-thread", linkedRunId: "run-private", status: "ready",
    attachmentIds: [], linkPreviewIds: [], fileRefs: [],
  };
  const reads = [];
  const store = {
    readSnapshot: read => read(),
    paths: { cwd: "/fixture" },
    getRun: () => ({ id: "run-private", teammateId: "engineer", threadId: "ling-thread" }),
    getLingThread: () => ({ id: "ling-thread", kind: "teammate_direct", teammateId: "engineer" }),
    getLingTurnForRun: () => ({ id: "private-turn", threadId: "ling-thread", teammateId: "engineer" }),
    listLingTurnRuns: () => [{ turnId: "private-turn", runId: "run-private" }],
    listTeammateDirectThreads: () => [{ id: "direct-thread", teammateId: "engineer" }],
    getTeammateDirectMessage: () => message,
    listEvents: (runId, { afterSeq, limit }) => {
      assert.equal(runId, "run-private");
      reads.push(afterSeq);
      return events.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    },
  };
  return { message, store, reads };
}

test("private history replays every event page and derives the same DTO as live narration", async () => {
  const { projectTeammateDirectMessageNarration } = await import("../dist/features/teammates/direct-message-narration.js");
  const events = [event(1, "assistant_text_delta", { text: "First." }), event(2, "message_end", { role: "assistant", text: "First." })];
  for (let seq = 3; seq <= 1000; seq++) events.push(event(seq, "tool_update", { text: "not narrative" }));
  events.push(event(1001, "assistant_text_delta", { text: "Second." }), event(1002, "message_end", { role: "assistant", text: "Second." }));
  const fixture = narrationFixture(events);
  const original = structuredClone(fixture.message);
  const live = createProjection();
  write(live, events);
  const dto = projectTeammateDirectMessageNarration(fixture.store, fixture.message);
  assert.equal(dto.body, live.text());
  assert.deepEqual(dto.narrationSegments, live.deltas.at(-1).narrationSegments);
  assert.deepEqual(fixture.reads, [0, 1000, 1002]);
  assert.deepEqual(fixture.message, original);
  for (const key of ["id", "linkedRunId", "status", "attachmentIds", "fileRefs"]) assert.equal(dto[key], fixture.message[key]);
});

test("private narration cannot hydrate another teammate or a non-private run", async () => {
  const { projectTeammateDirectMessageNarration } = await import("../dist/features/teammates/direct-message-narration.js");
  const fixture = narrationFixture([event(1, "message_end", { role: "assistant", text: "Other owner's text" })]);
  for (const override of [
    { getRun: () => undefined },
    { getRun: () => ({ id: "run-private", teammateId: "other", threadId: "ling-thread" }) },
    { getLingThread: () => ({ kind: "conversation", teammateId: "engineer" }) },
    { getLingThread: () => ({ kind: "teammate_direct", teammateId: "other" }) },
  ]) {
    assert.equal(projectTeammateDirectMessageNarration({ ...fixture.store, ...override }, fixture.message), fixture.message);
  }
  assert.deepEqual(fixture.reads, []);
  const userMessage = { ...fixture.message, authorType: "local-user" };
  assert.equal(projectTeammateDirectMessageNarration(fixture.store, userMessage), userMessage);
});

test("private live receipt filtering keeps body and segment content identical without DB reads", async () => {
  const { projectTeammateDirectMessageNarration } = await import("../dist/features/teammates/direct-message-narration.js");
  const snapshot = {
    content: "收到。\n\n  Answer.\n\nNext.",
    narrationSegments: [
      { content: "收到。", firstEventId: "event-1", lastEventId: "event-2", startEventSequence: 1, endEventSequence: 2, completed: true },
      { content: "  Answer.", firstEventId: "event-3", lastEventId: "event-4", startEventSequence: 3, endEventSequence: 4, completed: true },
      { content: "Next.", firstEventId: "event-5", lastEventId: "event-5", startEventSequence: 5, endEventSequence: 5, completed: false },
    ],
  };
  const fixture = narrationFixture([]);
  const dto = projectTeammateDirectMessageNarration({ getRun: () => assert.fail("live must not re-read history") }, fixture.message, snapshot);
  assert.equal(dto.body, "Answer.\n\nNext.");
  assert.equal(dto.narrationSegments.map(({ content }) => content).join("\n\n"), dto.body);
  assert.deepEqual(dto.narrationSegments.map(({ firstEventId }) => firstEventId), ["event-3", "event-5"]);
});

class CapturedResponse extends EventEmitter {
  output = "";
  destroyed = false;
  setHeader() {}
  writeHead(status) { this.status = status; }
  write(chunk) { this.output += chunk; }
  end(chunk = "") { this.output += chunk; }
}

function request(method, payload) {
  return Object.assign(Readable.from(payload ? [JSON.stringify(payload)] : []), {
    method, headers: { host: "localhost" }, url: "/direct-messages?cwd=%2Ffixture&includeSuperseded=true",
  });
}

test("private HTTP history and every SSE terminal path retain live narration segments", async () => {
  const { handleTeammateDirectMessageStream, handleTeammateDirectMessagesCollection } = await import("../dist/features/teammates/direct-messages.js");
  const events = [event(1, "assistant_text_delta", { text: "Before." }), event(2, "message_end", { role: "assistant", text: "Before." }),
    event(3, "tool_start", { toolName: "read" }), event(4, "message_end", { role: "assistant", text: "After." })];
  for (const status of ["ready", "blocked", "failed", "cancelled"]) {
    const fixture = narrationFixture(events);
    const store = {
      ...fixture.store,
      getAiTeammate: () => ({ id: "engineer" }),
      getOrCreateTeammateDirectThread: () => ({ id: "direct-thread", teammateId: "engineer" }),
      createTeammateDirectMessage: (input) => ({ id: "user-private", ...input }),
      listGovernanceNotifications: () => [],
      listConversationMessageRevisions: () => [],
      listConversationTurnSupersessions: () => [],
      listWorkUnits: () => [],
      findLingThreadByOwner: () => undefined,
      updateTeammateDirectMessageRuntime: (_id, changes) => Object.assign(fixture.message, changes),
      listTeammateDirectMessagesPage: () => ({ messages: [fixture.message], hasMore: false }),
    };
    const config = { maxBodyBytes: 10000 };
    const registry = { getStore: () => store };
    const response = new CapturedResponse();
    await handleTeammateDirectMessageStream(request("POST", { body: "Inspect." }), response, config, registry, "engineer", async ({ stream }) => {
      stream.onReady(fixture.message);
      const live = createTeammateDirectRunProjection({ store, pendingMessageId: fixture.message.id, stream,
        scope: { teammateId: "engineer", directThreadId: "direct-thread", canonicalThreadId: "ling-thread", turnId: "private-turn" } });
      live.sink.writeReady({ runId: "run-private" });
      write(live, events);
      fixture.message.status = status;
      if (status !== "ready") fixture.message.errorMessage = "Approval denied";
      if (status === "ready") stream.onDone(fixture.message);
      else stream.onBlocked(fixture.message);
      return fixture.message;
    });
    assert.equal(response.status, 200, response.output);
    const sse = response.output.split("\n\n").filter((block) => block.startsWith("event: ")).map((block) => {
      const [name, data] = block.split("\n");
      return { name: name.slice(7), data: JSON.parse(data.slice(6)) };
    });
    const terminal = sse.at(-1);
    assert.equal(terminal.name, status === "ready" ? "done" : status === "failed" ? "error" : "blocked");
    const liveDelta = sse.filter(({ name }) => name === "delta").at(-1).data;
    assert.deepEqual(terminal.data.aiReply.narrationSegments, liveDelta.narrationSegments);
    assert.deepEqual(sse[0].data.aiReply.narrationSegments, liveDelta.narrationSegments);
    assert.ok(sse.some(({ name, data }) => name === "delta" && data.delta === "" && data.narrationSegments[0].completed));
    assert.equal(terminal.data.aiReply.status, status);
    if (status !== "ready") assert.equal(terminal.data.aiReply.errorMessage, "Approval denied");
    const history = new CapturedResponse();
    await handleTeammateDirectMessagesCollection(request("GET"), history, config, registry, "engineer", async () => assert.fail("GET must not run"));
    assert.equal(history.status, 200, history.output);
    assert.deepEqual(JSON.parse(history.output).messages[0].narrationSegments, liveDelta.narrationSegments);
    const posted = new CapturedResponse();
    await handleTeammateDirectMessagesCollection(request("POST", { body: "Inspect.", requestAiReply: true }), posted, config, registry, "engineer", async () => fixture.message);
    assert.equal(posted.status, 201, posted.output);
    assert.deepEqual(JSON.parse(posted.output).aiReply.narrationSegments, liveDelta.narrationSegments);
  }
});

test("private HTTP media uses only owned Run IDs while preserving unanchored legacy text", async () => {
  const { handleTeammateDirectMessagesCollection } = await import("../dist/features/teammates/direct-messages.js");
  for (const corrupt of [false, true]) {
    const fixture = narrationFixture([]);
    const mediaReads = [];
    const store = {
      ...fixture.store,
      ...(corrupt ? { getRun: () => ({ id: "run-private", teammateId: "engineer", threadId: "ling-thread", workflowStepId: "foreign-workflow" }) } : {}),
      getAiTeammate: () => ({ id: "engineer" }),
      getOrCreateTeammateDirectThread: () => ({ id: "direct-thread", teammateId: "engineer" }),
      listGovernanceNotifications: () => [], listConversationMessageRevisions: () => [],
      listConversationTurnSupersessions: () => [],
      findLingThreadByOwner: () => undefined,
      listTeammateDirectMessagesPage: () => ({ messages: [fixture.message, { ...fixture.message, id: "legacy", linkedRunId: undefined },
        { ...fixture.message, id: "foreign-author", authorId: "designer" }], hasMore: false }),
      listWorkUnits: (options) => {
        if (options.kind === "media_job") mediaReads.push(options.linkedRunId);
        return [];
      },
    };
    const response = new CapturedResponse();
    await handleTeammateDirectMessagesCollection(request("GET"), response, { maxBodyBytes: 10000 }, { getStore: () => store }, "engineer", () => assert.fail("GET must not run"));
    assert.equal(response.status, 200, response.output);
    const payload = JSON.parse(response.output);
    assert.deepEqual(payload.messages.map((message) => message.id), ["reply-private", "legacy"]);
    assert.equal(payload.messages[1].body, "Old concatenated body.");
    assert.deepEqual(mediaReads, corrupt ? [] : ["run-private"]);
  }
});
