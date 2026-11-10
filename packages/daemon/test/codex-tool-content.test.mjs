import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexEventNormalizer } from "../dist/runtime/adapters/codex/event-normalizer.js";

const create = options => new CodexEventNormalizer({ threadId: "thread", turnId: "turn", requireAssistantText: false, ...options });
const notify = (method, params) => ({ method, params: { threadId: "thread", turnId: "turn", ...params } });
const item = (value, stage = "completed") => notify(`item/${stage}`, { item: value });
const dynamic = contentItems => ({ type: "dynamicToolCall", id: "dynamic", tool: "lookup", namespace: null,
  arguments: {}, status: "completed", success: true, contentItems });
const mcp = content => ({ type: "mcpToolCall", id: "mcp", tool: "lookup", server: "owned", arguments: {},
  status: "completed", result: { content, structuredContent: { count: 1 }, _meta: { privateField: "do not publish" } }, error: null });

test("dynamic tool text is canonical content and native-only metadata does not escape", () => {
  const events = create().receive(item(dynamic([{ type: "inputText", text: "returned text", privateField: "do not publish" }])));
  assert.deepEqual(events.at(-1).data.result.content, [{ type: "text", text: "returned text" }]);
  assert.equal(JSON.stringify(events).includes("do not publish"), false);
});

test("dynamic inline image/audio bytes and remote media references remain distinct", () => {
  const events = create().receive(item(dynamic([
    { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,YXVkaW8=" },
    { type: "inputImage", imageUrl: "https://example.com/image.png" },
  ])));
  assert.deepEqual(events.at(-1).data.result.content, [
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
    { type: "resource_link", uri: "https://example.com/image.png", name: "image" },
  ]);
  assert.equal(events.some(event => event.type === "artifact_created"), false);
});

test("MCP text, binary and resource content uses SDK validation and excludes private metadata", () => {
  const events = create().receive(item(mcp([
    { type: "text", text: "returned", _meta: { privateField: "do not publish" } },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "owned://document", mimeType: "text/plain", text: "document", _meta: { privateField: "do not publish" } } },
    { type: "resource_link", uri: "owned://other", name: "other" },
  ])));
  const result = events.at(-1).data.result;
  assert.equal(JSON.stringify(events).includes("do not publish"), false);
  assert.deepEqual(result.structuredContent, { count: 1 });
  assert.deepEqual(result.content, [
    { type: "text", text: "returned" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "owned://document", mimeType: "text/plain", text: "document" } },
    { type: "resource_link", uri: "owned://other", name: "other" },
  ]);
  assert.throws(() => create().receive(item(mcp([{ type: "text", text: 10 }]))), { code: "invalid_event" });
});

test("unknown content, oversized lists and unsafe media locations fail without fetching or reading", () => {
  for (const imageUrl of ["file:///tmp/native-output.png", "javascript:alert(1)", "https://user:password@example.com/image", "data:text/html;base64,aGk=", "data:image/png;base64,not base64", "data:image/png;base64,a", " https://example.com/image"]) {
    assert.throws(() => create().receive(item(dynamic([{ type: "inputImage", imageUrl }]))), { code: "invalid_event" });
  }
  assert.throws(() => create().receive(item(dynamic([{ type: "unknown", text: "not silently dropped" }]))), { code: "unsupported_item" });
  assert.throws(() => create().receive(item(dynamic(Array.from({ length: 257 }, () => ({ type: "inputText", text: "x" }))))), { code: "capacity_exceeded" });
  assert.throws(() => create().receive(item(mcp([{ type: "image", data: "!!!", mimeType: "image/png" }]))), { code: "invalid_event" });
  assert.throws(() => create().receive(item(mcp([{ type: "resource_link", name: "bad", uri: "javascript:alert(1)" }]))), { code: "invalid_event" });
});

test("web search fills its empty native start query and preserves returned structured evidence", () => {
  const normalizer = create();
  const initial = { type: "webSearch", id: "search", query: "", action: null, results: null };
  const final = { ...initial, query: "Ling", action: { type: "search", query: "Ling", queries: null },
    results: [{ type: "text_result", ref_id: "search0", url: "https://example.com", title: "Ling", snippet: "result" }] };
  const events = [...normalizer.receive(item(initial, "started")), ...normalizer.receive(item(final))];
  assert.equal(events[0].data.toolName, "web_search");
  assert.equal(events.at(-1).data.isError, false);
  assert.equal(events.at(-1).data.result.query, "Ling");
  assert.deepEqual(events.at(-1).data.result.results, final.results);
  assert.deepEqual(normalizer.receive(item(final)), []);
});

test("image view and sleep describe native observations without opening a file or sleeping again", () => {
  const normalizer = create();
  for (const [value, name, args] of [
    [{ type: "imageView", id: "image", path: "/does-not-exist/native.png" }, "view_image", { path: "/does-not-exist/native.png" }],
    [{ type: "sleep", id: "sleep", durationMs: 3600000 }, "clock.sleep", { durationMs: 3600000 }],
  ]) {
    const events = [...normalizer.receive(item(value, "started")), ...normalizer.receive(item(value))];
    assert.deepEqual(events[0].data, { toolCallId: value.id, toolName: name, args });
    assert.equal(events.at(-1).type, "tool_end");
    assert.equal(events.at(-1).data.isError, false);
    assert.deepEqual(normalizer.receive(item(value)), []);
  }
});

test("collab tool status stays separate from returned child-agent state", () => {
  const initial = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "inProgress",
    senderThreadId: "thread", receiverThreadIds: [], prompt: "owned", model: null, reasoningEffort: null, agentsStates: {} };
  const final = { ...initial, status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "errored", message: "child failed" } } };
  const normalizer = create();
  const events = [...normalizer.receive(item(initial, "started")), ...normalizer.receive(item(final))];
  assert.equal(events[0].data.toolName, "codex.spawnAgent");
  assert.equal(events.at(-1).data.isError, false);
  assert.deepEqual(events.at(-1).data.result.agentsStates, final.agentsStates);
  assert.deepEqual(events.at(-1).data.result.receiverThreadIds, ["child"]);
  for (const status of ["failed", "interrupted"]) {
    assert.equal(create().receive(item({ ...final, status })).at(-1).data.isError, true);
  }
});

test("function output carries text/media evidence but never invents a successful tool call", () => {
  const normalizer = create();
  const value = { type: "functionCallOutput", id: "output", name: "lookup", namespace: "owned", output: [
    { type: "input_text", text: "returned" },
    { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    { type: "encrypted_content", encrypted_content: "private ciphertext" },
  ] };
  assert.deepEqual(normalizer.receive(item(value, "started")), []);
  const events = normalizer.receive(item(value));
  assert.deepEqual(events, [{ type: "progress", data: { nativeKind: "function_output", itemId: "output", toolName: "owned.lookup",
    content: [{ type: "text", text: "returned" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], opaqueContentCount: 1 } }]);
  assert.deepEqual(normalizer.receive(item(value)), []);
  assert.equal(JSON.stringify(events).includes("private ciphertext"), false);
});

test("subagent activity and terminal input remain bounded, redacted observations", () => {
  const normalizer = create({ extraSecrets: ["private input"] });
  const activity = { type: "subAgentActivity", id: "activity", kind: "started", agentThreadId: "child", agentPath: "/native/child" };
  const activityEvents = [...normalizer.receive(item(activity, "started")), ...normalizer.receive(item(activity))];
  assert.equal(activityEvents.length, 1);
  assert.deepEqual(activityEvents[0], { type: "progress", data: { nativeKind: "subagent_activity", itemId: "activity", kind: "started", agentThreadId: "child", agentPath: "/native/child" } });
  normalizer.receive(item({ type: "commandExecution", id: "command", command: "owned interactive", cwd: "/tmp", status: "inProgress" }, "started"));
  const interaction = notify("item/commandExecution/terminalInteraction", { itemId: "command", processId: "process", stdin: "private input\n" });
  const events = normalizer.receive(interaction);
  assert.equal(events[0].type, "tool_update");
  assert.deepEqual(events[0].data.partialResult, { processId: "process", stdin: "[REDACTED]\n" });
  assert.throws(() => create().receive(interaction), { code: "invalid_event" });
});

test("known search inputs, tool kinds and collab state cannot be silently replaced", () => {
  const normalizer = create();
  const initial = { type: "webSearch", id: "search", query: "", action: null, results: null };
  normalizer.receive(item(initial, "started"));
  normalizer.receive(item({ ...initial, query: "fixed" }, "started"));
  assert.throws(() => normalizer.receive(item({ ...initial, query: "changed" })), { code: "invalid_event" });
  assert.throws(() => normalizer.receive(item({ type: "sleep", id: "search", durationMs: 1 })), { code: "invalid_event" });
  assert.throws(() => create().receive(item({ type: "webSearch", id: "search", query: "x", action: { type: ["other"] }, results: null })), { code: "invalid_event" });
  for (const value of [-1, 0.1, "10"]) assert.throws(() => create().receive(item({ type: "sleep", id: "sleep", durationMs: value })), { code: "invalid_event" });
  assert.throws(() => create().receive(item({ type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed",
    senderThreadId: "thread", receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null,
    agentsStates: { child: { status: ["completed"], message: null } } })), { code: "invalid_event" });
});

test("new pending tools stay errors on cancellation and cannot silently finish with the turn", () => {
  const pending = { type: "sleep", id: "sleep", durationMs: 100 };
  const normalizer = create();
  normalizer.receive(item(pending, "started"));
  assert.throws(() => normalizer.receive(notify("turn/completed", { turn: { id: "turn", status: "completed", items: [] } })), { code: "invalid_event" });
  const events = normalizer.receive(notify("turn/completed", { turn: { id: "turn", status: "interrupted", items: [] } }));
  assert.equal(events.find(event => event.type === "tool_end").data.isError, true);
});
