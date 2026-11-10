import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexEventNormalizer } from "../dist/runtime/adapters/codex/event-normalizer.js";

const ids = { threadId: "thread-1", turnId: "turn-1" };
const notification = (method, params = {}) => ({ method, params: { ...ids, ...params } });
const item = (method, value) => notification(`item/${method}`, { item: value });
const text = (delta, id = "message-1") => notification("item/agentMessage/delta", { itemId: id, delta });
const done = (items = [], status = "completed") => notification("turn/completed", { turn: { id: ids.turnId, items, status } });
const agent = (value, id = "message-1") => ({ type: "agentMessage", id, text: value });
const command = (status = "inProgress", extra = {}) => ({ type: "commandExecution", id: "cmd-1", command: "whois example.com",
  cwd: "/tmp/owned", status, exitCode: null, aggregatedOutput: null, durationMs: null, ...extra });
const create = options => new CodexEventNormalizer({ ...ids, requireAssistantText: true, ...options });
const body = events => events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join("");

test("current moderation metadata preserves the accepted turn without projecting private observations", () => {
  const normalizer = create();
  normalizer.receive(notification("turn/started", { turn: { id: ids.turnId, status: "inProgress", items: [] } }));
  for (const metadata of [null, { privateTestMetadata: "do-not-project" }]) {
    assert.deepEqual(normalizer.receive(notification("turn/moderationMetadata", { metadata })), []);
  }
  normalizer.receive(item("completed", agent("Expected text")));
  const end = normalizer.receive(done());
  assert.equal(end.find(event => event.type === "message_end").data.text, "Expected text");
  assert.equal(JSON.stringify(end).includes("do-not-project"), false);
});

test("moderation metadata retains identity and byte limits without allowing unknown future events", () => {
  for (const params of [{ threadId: "other", metadata: null }, { turnId: "other", metadata: null }, {}, { metadata: undefined }]) {
    assert.throws(() => create().receive(notification("turn/moderationMetadata", params)), { code: "invalid_event" });
  }
  assert.throws(() => create({ maxBytes: 64 }).receive(notification("turn/moderationMetadata", {
    metadata: "a".repeat(65),
  })), { code: "capacity_exceeded" });
  assert.throws(() => create().receive(notification("turn/unknownFutureObservation", { metadata: null })), { code: "unsupported_item" });
});

test("native image generation retains returned bytes and failure status, never trusts savedPath", () => {
  const normalizer = create({ requireAssistantText: false });
  const initial = { type: "imageGeneration", id: "image-1", status: "in_progress", result: "", revisedPrompt: null, failure: null };
  assert.equal(normalizer.receive(item("started", initial))[0].data.toolName, "image_generation");
  const final = { ...initial, status: "completed", result: "cGl4ZWxz", revisedPrompt: "revised", savedPath: "/untrusted/private.png" };
  const events = normalizer.receive(item("completed", final));
  assert.equal(events[0].data.isError, false);
  assert.equal(events[0].data.result.content[0].data, "cGl4ZWxz");
  assert.equal(JSON.stringify(events).includes("/untrusted"), false);
  assert.deepEqual(normalizer.receive(item("completed", final)), []);
  const failed = create({ requireAssistantText: false }).receive(item("completed", { ...initial, status: "failed",
    failure: { type: "usageLimitExceeded", limitId: "owned-limit", resetsAt: 123 } }));
  assert.equal(failed.at(-1).data.isError, true);
  assert.deepEqual(failed.at(-1).data.result.content, []);
  assert.equal(failed.at(-1).data.result.failure.type, "usageLimitExceeded");
  assert.throws(() => create().receive(item("completed", { ...initial, status: "completed" })), { code: "invalid_event" });
});

test("native deltas stream live and final snapshots never duplicate or erase earlier messages", () => {
  const normalizer = create();
  const events = normalizer.receive(text("first message "));
  assert.equal(body(events), "first message ");
  events.push(...normalizer.receive(item("completed", agent("first message "))));
  assert.deepEqual(normalizer.receive(item("completed", agent("first message "))), []);
  events.push(...normalizer.receive(item("completed", agent("second message", "message-2"))));
  events.push(...normalizer.receive(done([agent("first message "), agent("second message", "message-2")])));
  assert.equal(body(events), "first message second message");
  const final = events.filter(event => event.type === "message_end");
  assert.equal(final.length, 1);
  assert.equal(final[0].data.text, body(events));
  assert.equal(events.at(-1).type, "turn_end");
});

test("terminal snapshot supplies missing final text without replaying a complete item twice", () => {
  const normalizer = create();
  const events = normalizer.receive(done([agent("complete only")]));
  assert.equal(body(events), "complete only");
  assert.throws(() => normalizer.receive(text("late")), { code: "invalid_event" });
});

test("assistant item boundaries do not reorder held text or split configured secrets", () => {
  const normalizer = create({ extraSecrets: ["owned secret"] });
  const events = [...normalizer.receive(text("owned ", "first")),
    ...normalizer.receive(item("completed", agent("owned ", "first"))),
    ...normalizer.receive(text("secret tail", "second")),
    ...normalizer.receive(item("completed", agent("secret tail", "second"))),
    ...normalizer.receive(done())];
  assert.equal(body(events), "[REDACTED] tail");
});

test("file change kinds are primitives, not array-coerced enum values", () => {
  assert.throws(() => create().receive(item("started", { type: "fileChange", id: "file-1", status: "inProgress",
    changes: [{ path: "file", kind: { type: ["add"] }, diff: "+x" }] })), { code: "invalid_event" });
});

test("native command observations become start/update/end events without executing a tool", () => {
  const normalizer = create({ requireAssistantText: false });
  const start = command();
  const events = normalizer.receive(item("started", start));
  assert.deepEqual(events[0], { type: "tool_start", data: { toolCallId: "cmd-1", toolName: "bash",
    args: { command: "whois example.com", cwd: "/tmp/owned" } } });
  assert.deepEqual(normalizer.receive(item("started", start)), []);
  events.push(...normalizer.receive(notification("item/commandExecution/outputDelta", { itemId: "cmd-1", delta: "owned output " })));
  assert.equal(events.at(-1).data.partialResult.content[0].text, "owned output ");
  events.push(...normalizer.receive(item("completed", command("completed", { exitCode: 2, aggregatedOutput: "owned output " }))));
  assert.equal(events.at(-1).type, "tool_end");
  assert.equal(events.at(-1).data.isError, true);
  assert.deepEqual(normalizer.receive(item("completed", command("completed", { exitCode: 2, aggregatedOutput: "owned output " }))), []);
  normalizer.receive(done());
});

test("native file and MCP/dynamic results retain real operation status and structured text", () => {
  const normalizer = create({ requireAssistantText: false });
  const changes = [{ path: "new.txt", kind: { type: "add" }, diff: "+new\n" }];
  const cases = [
    [{ type: "fileChange", id: "file-1", changes, status: "inProgress" }, { type: "fileChange", id: "file-1", changes, status: "declined" }, "apply_patch", true],
    [{ type: "mcpToolCall", id: "mcp-1", server: "owned", tool: "read", arguments: { token: "private" }, status: "inProgress" },
      { type: "mcpToolCall", id: "mcp-1", server: "owned", tool: "read", arguments: { token: "private" }, status: "completed",
        result: { content: [{ type: "text", text: "returned" }], structuredContent: { value: 1 }, isError: false }, error: null }, "mcp:owned/read", false],
    [{ type: "dynamicToolCall", id: "dynamic-1", namespace: null, tool: "lookup", arguments: {}, status: "inProgress" },
      { type: "dynamicToolCall", id: "dynamic-1", namespace: null, tool: "lookup", arguments: {}, status: "completed",
        success: false, contentItems: [{ type: "inputText", text: "not found" }] }, "lookup", true],
  ];
  for (const [start, final, name, isError] of cases) {
    const events = [...normalizer.receive(item("started", start)), ...normalizer.receive(item("completed", final))];
    assert.equal(events[0].data.toolName, name);
    assert.equal(events.at(-1).data.isError, isError);
    assert.equal(JSON.stringify(events).includes("private"), false);
  }
  normalizer.receive(done());
});

test("MCP and dynamic tools accept only their own native terminal status enums", () => {
  for (const tool of [
    { type: "mcpToolCall", id: "mcp", server: "owned", tool: "lookup", arguments: {}, result: null, error: null },
    { type: "dynamicToolCall", id: "dynamic", namespace: null, tool: "lookup", arguments: {}, success: null, contentItems: null },
  ]) {
    assert.throws(() => create().receive(item("completed", { ...tool, status: "declined" })), { code: "invalid_event" });
    const events = create({ requireAssistantText: false }).receive(item("completed", { ...tool, status: "failed" }));
    assert.equal(events.at(-1).data.isError, true);
  }
});

test("summary reasoning uses its own stream and raw reasoning does not duplicate it", () => {
  const normalizer = create({ requireAssistantText: false });
  const raw = notification("item/reasoning/textDelta", { itemId: "reason-1", contentIndex: 0, delta: "raw thought " });
  assert.deepEqual(normalizer.receive(raw), []);
  const events = normalizer.receive(notification("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex: 0, delta: "summary " }));
  events.push(...normalizer.receive(item("completed", { type: "reasoning", id: "reason-1", summary: ["summary "], content: ["raw thought "] })));
  events.push(...normalizer.receive(done()));
  assert.equal(events.filter(event => event.type === "assistant_thinking_delta").map(event => event.data.text).join(""), "summary ");
});

test("summary parts keep their index boundaries in streamed and snapshot-only output", () => {
  const summary = ["step one", "step two", "", "last step"];
  const final = { type: "reasoning", id: "reason-1", summary, content: [] };
  for (const streamed of [true, false]) {
    const normalizer = create({ requireAssistantText: false });
    const events = [];
    if (streamed) {
      for (const [summaryIndex, delta] of summary.entries()) {
        // The native sequential-summary path omits the first part-added event.
        if (summaryIndex > 0) events.push(...normalizer.receive(notification("item/reasoning/summaryPartAdded", { itemId: final.id, summaryIndex })));
        events.push(...normalizer.receive(notification("item/reasoning/summaryTextDelta", { itemId: final.id, summaryIndex, delta })));
      }
    }
    events.push(...normalizer.receive(item("completed", final)));
    assert.deepEqual(normalizer.receive(item("completed", final)), []);
    events.push(...normalizer.receive(done([final])));
    assert.equal(events.filter(event => event.type === "assistant_thinking_delta").map(event => event.data.text).join(""), "step one\nstep two\n\nlast step");
  }
});

test("reasoning rejects out-of-order, conflicting and closed-item content", () => {
  const part = summaryIndex => notification("item/reasoning/summaryPartAdded", { itemId: "reason-1", summaryIndex });
  const delta = (summaryIndex, value) => notification("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex, delta: value });
  const final = { type: "reasoning", id: "reason-1", summary: ["first", "second"], content: [] };
  assert.throws(() => create().receive(part(1)), { code: "invalid_event" });
  assert.throws(() => create().receive(delta(2, "missing parts")), { code: "invalid_event" });
  const normalizer = create({ requireAssistantText: false });
  normalizer.receive(delta(0, "first"));
  normalizer.receive(part(1));
  assert.deepEqual(normalizer.receive(part(1)), []);
  normalizer.receive(delta(1, "second"));
  assert.throws(() => normalizer.receive(delta(0, "late")), { code: "invalid_event" });
  assert.throws(() => normalizer.receive(item("completed", { ...final, summary: ["first\nsecond"] })), { code: "invalid_event" });
  normalizer.receive(item("completed", final));
  assert.throws(() => normalizer.receive(part(2)), { code: "invalid_event" });
  assert.throws(() => normalizer.receive(delta(1, "late")), { code: "invalid_event" });
  assert.throws(() => normalizer.receive(notification("item/reasoning/textDelta", { itemId: final.id, contentIndex: 0, delta: "late raw" })), { code: "invalid_event" });
  assert.throws(() => create().receive(notification("item/reasoning/textDelta", { itemId: final.id, contentIndex: -1, delta: "invalid" })), { code: "invalid_event" });
});

test("split native secrets never reach normalized text or final payloads", () => {
  const normalizer = create({ extraSecrets: ["owned secret"] });
  const events = [];
  for (const chunk of ["answer owned ", "secret Be", "arer abc ", "sk-123456", "789012 done "]) events.push(...normalizer.receive(text(chunk)));
  events.push(...normalizer.receive(done()));
  assert.equal(body(events), "answer [REDACTED] [REDACTED] [REDACTED] done ");
  assert.equal(events.find(event => event.type === "message_end").data.text, body(events));
});

test("empty successful chat and unfinished tools cannot become a successful answer", () => {
  assert.throws(() => create().receive(done()), { code: "empty_output" });
  const normalizer = create({ requireAssistantText: false });
  normalizer.receive(item("started", command()));
  assert.throws(() => normalizer.receive(done()), { code: "invalid_event" });
});

test("failed and cancelled turns finish pending observations as errors, never tool success", () => {
  for (const status of ["failed", "interrupted"]) {
    const normalizer = create();
    normalizer.receive(item("started", command()));
    const events = normalizer.receive(done([], status));
    assert.equal(events.find(event => event.type === "tool_end").data.isError, true);
    assert.equal(events.find(event => event.type === "message_end").data.stopReason, status === "failed" ? "error" : "aborted");
  }
});

test("cross-turn, conflicting final and invalid tool shapes fail explicitly", () => {
  assert.throws(() => create().receive({ ...text("foreign"), params: { ...text("foreign").params, turnId: "other" } }), { code: "invalid_event" });
  const normalizer = create();
  normalizer.receive(text("original"));
  assert.throws(() => normalizer.receive(item("completed", agent("different"))), { code: "invalid_event" });
  assert.throws(() => create().receive(item("started", command("invented"))), { code: "invalid_event" });
});

test("native event state and total output are bounded", () => {
  const items = create({ maxItems: 1 });
  items.receive(text("one", "one"));
  assert.throws(() => items.receive(text("two", "two")), { code: "capacity_exceeded" });
  const bytes = create({ maxBytes: 32 });
  assert.throws(() => bytes.receive(text("x".repeat(33))), { code: "capacity_exceeded" });
});
