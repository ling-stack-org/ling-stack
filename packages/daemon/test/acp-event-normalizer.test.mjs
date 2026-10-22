import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpEventNormalizer } from "../dist/runtime/acp/event-normalizer.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const sessionId = "owned-session";
const update = (normalizer, value) => normalizer.receive({ sessionId, update: value });

test("ACP live credentials reach text, thoughts, tool diffs, plans and final output without replacing streams", () => {
  const secrets = new NativeSecretRegistry(["initial phrase"]);
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: true, extraSecrets: ["static-secret"] }, secrets);
  const events = update(normalizer, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer initial ph" } });
  secrets.register(["rotated-access", "rotated-refresh"]);
  events.push(...update(normalizer, { sessionUpdate: "agent_message_chunk", content: {
    type: "text", text: "rase; rotated-access; static-secret. " } }));
  events.push(...update(normalizer, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "rotated-refresh " } }));
  events.push(...update(normalizer, { sessionUpdate: "tool_call", toolCallId: "edit", title: "rotated-access", kind: "edit",
    status: "in_progress", rawInput: { path: "/report.txt", content: "rotated-refresh" }, content: [
      { type: "diff", path: "/report.txt", oldText: "static-secret", newText: "rotated-access" },
      { type: "content", content: { type: "resource", resource: { uri: "file:///report.txt", text: "rotated-refresh" } } },
    ] }));
  secrets.register(["latest-access"]);
  events.push(...update(normalizer, { sessionUpdate: "tool_call_update", toolCallId: "edit", title: "latest-access", status: "completed" }));
  events.push(...update(normalizer, { sessionUpdate: "plan", entries: [{ content: "latest-access", status: "completed", priority: "low" }] }));
  events.push(...normalizer.finish({ stopReason: "end_turn" }));
  assert.equal(events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join(""),
    "Answer [REDACTED]; [REDACTED]; [REDACTED]. ");
  assert.equal(events.find(event => event.type === "message_end").data.text, "Answer [REDACTED]; [REDACTED]; [REDACTED]. ");
  assert.equal(events.find(event => event.type === "assistant_thinking_delta").data.text, "[REDACTED] ");
  assert.equal(events.find(event => event.type === "tool_end").data.result.title, "[REDACTED]");
  for (const secret of ["initial phrase", "static-secret", "rotated-access", "rotated-refresh", "latest-access"]) {
    assert.equal(JSON.stringify(events).includes(secret), false, secret);
  }
});

test("ACP assistant images retain content identity without becoming a tool call", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  const events = update(normalizer, { sessionUpdate: "agent_message_chunk", content: {
    type: "image", data: "cGl4ZWxz", mimeType: "image/png", uri: null, annotations: null,
    _meta: { private: "do not expose" },
  } });
  assert.deepEqual(events, [{ type: "progress", data: { nativeKind: "assistant_content", role: "assistant",
    itemId: "assistant-content-1", content: [{ type: "image", data: "cGl4ZWxz", mimeType: "image/png" }] } }]);
  const final = normalizer.finish({ stopReason: "end_turn" });
  assert.deepEqual(final.find(event => event.type === "message_end").data.contentKinds, ["image"]);
  assert.equal(final.some(event => event.type.startsWith("tool_")), false);
});

test("ACP nullable resources, links and binary observations preserve non-text order and drop extensions", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false, extraSecrets: ["fixture-secret"] });
  const content = [
    { type: "resource", resource: { uri: "file:///never-read.txt", text: "fixture-secret", mimeType: null, _meta: { private: true } } },
    { type: "resource_link", uri: "https://example.com/report", name: "Report", title: null, description: null, mimeType: null, size: null },
    { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=", annotations: { audience: null, priority: null }, _meta: null },
    { type: "resource", resource: { uri: "file:///never-read.bin", blob: "Ynl0ZXM=", mimeType: null }, annotations: null },
  ];
  const events = content.flatMap(content => update(normalizer, { sessionUpdate: "agent_message_chunk", content }));
  assert.deepEqual(events.map(event => event.data.itemId), ["assistant-content-1", "assistant-content-2", "assistant-content-3", "assistant-content-4"]);
  assert.deepEqual(events.map(event => event.data.content[0]), [
    { type: "resource", resource: { uri: "file:///never-read.txt", text: "[REDACTED]" } },
    { type: "resource_link", uri: "https://example.com/report", name: "Report" },
    { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
    { type: "resource", resource: { uri: "file:///never-read.bin", blob: "Ynl0ZXM=" } },
  ]);
  assert.deepEqual(normalizer.finish({ stopReason: "end_turn" })[0].data.contentKinds, ["resource", "resource_link", "audio"]);
});

test("ACP returned resources do not replace a workflow's required assistant text", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: true });
  update(normalizer, { sessionUpdate: "agent_message_chunk", content: { type: "resource",
    resource: { uri: "file:///report.txt", text: "This is an attachment, not assistant text" } } });
  assert.throws(() => normalizer.finish({ stopReason: "end_turn" }), { code: "empty_output" });
});

test("ACP content boundaries cannot flush secret prefixes into the text stream", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: true, extraSecrets: ["phrase with space"] });
  const events = update(normalizer, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Public phrase wi" } });
  events.push(...update(normalizer, { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "cGl4ZWxz", mimeType: "image/png" } }));
  events.push(...update(normalizer, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "th space." } }));
  events.push(...normalizer.finish({ stopReason: "end_turn" }));
  assert.equal(events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join(""), "Public [REDACTED].");
  assert.equal(JSON.stringify(events).includes("phrase wi"), false);
  assert.deepEqual(events.find(event => event.type === "message_end").data.contentKinds, ["text", "image"]);
});

test("ACP non-text thought chunks cannot become assistant attachments", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  assert.throws(() => update(normalizer, { sessionUpdate: "agent_thought_chunk", content: {
    type: "image", data: "cGl4ZWxz", mimeType: "image/png",
  } }), { code: "unsupported_item" });
});

test("ACP non-text items and tools share the bounded output-item budget", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false, maxItems: 2 });
  const content = { type: "image", data: "cGl4ZWxz", mimeType: "image/png" };
  update(normalizer, { sessionUpdate: "agent_message_chunk", content });
  update(normalizer, { sessionUpdate: "tool_call", toolCallId: "owned", status: "completed", content: [] });
  assert.throws(() => update(normalizer, { sessionUpdate: "agent_message_chunk", content }), { code: "capacity_exceeded" });
  assert.throws(() => update(normalizer, { sessionUpdate: "tool_call", toolCallId: "extra", content: [] }), { code: "capacity_exceeded" });
});

for (const [name, content] of [
  ["null image bytes", { type: "image", data: null, mimeType: "image/png" }],
  ["invalid base64", { type: "audio", data: "YXVkaW8=!", mimeType: "audio/wav" }],
  ["mismatched content MIME", { type: "image", data: "cGl4ZWxz", mimeType: "text/plain" }],
  ["executable URI", { type: "resource_link", uri: "javascript:alert(1)", name: "Report" }],
  ["credential URI", { type: "resource_link", uri: "https://secret:token@example.com/report", name: "Report" }],
  ["invalid optional title", { type: "resource_link", uri: "https://example.com/report", name: "Report", title: 9 }],
  ["missing resource payload", { type: "resource", resource: { uri: "file:///report" } }],
]) test(`ACP assistant content rejects ${name}`, () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  assert.throws(() => update(normalizer, { sessionUpdate: "agent_message_chunk", content }), { code: "invalid_event" });
});

test("ACP tool embedded content uses the same nullable field rules as assistant output", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  const events = update(normalizer, { sessionUpdate: "tool_call", toolCallId: "report", status: "completed", content: [
    { type: "content", content: { type: "resource", annotations: null, resource: { uri: "file:///never-read", text: "Report", mimeType: null } } },
  ] });
  assert.deepEqual(events[1].data.result.content, [{ type: "resource", resource: { uri: "file:///never-read", text: "Report" } }]);
});

test("ACP Kimi edit observations preserve ordered initial diff and text without implying a completed edit", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false, extraSecrets: ["fixture-secret"] });
  const events = update(normalizer, { sessionUpdate: "tool_call", toolCallId: "1:edit", title: "Edit",
    kind: "edit", status: "in_progress", rawInput: { path: "/never-read/config.txt" }, content: [
      { type: "diff", path: "/never-read/config.txt", oldText: "old", newText: "fixture-secret", _meta: { private: "omit" } },
      { type: "content", content: { type: "text", text: "Preview" } },
    ] });
  assert.deepEqual(events.map(event => event.type), ["tool_start", "tool_update"]);
  assert.deepEqual(events[1].data.partialResult.content, [
    { type: "diff", path: "/never-read/config.txt", oldText: "old", newText: "[REDACTED]" },
    { type: "text", text: "Preview" },
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(events.some(event => event.type === "tool_end" || event.type === "artifact_created"), false);
});

test("ACP partial tool metadata preserves content until a replacement array arrives", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  const events = update(normalizer, { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", content: [
    { type: "diff", path: "C:\\work\\note.txt", oldText: null, newText: "new" },
  ] });
  assert.equal(events[1].data.partialResult.status, "pending");
  const renamed = update(normalizer, { sessionUpdate: "tool_call_update", toolCallId: "edit", title: "Editing note",
    status: null, content: null });
  assert.equal(renamed[0].data.partialResult.title, "Editing note");
  assert.deepEqual(renamed[0].data.partialResult.content, events[1].data.partialResult.content);
  const completed = update(normalizer, { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "failed", content: [], rawOutput: "hidden" });
  assert.equal(completed[0].data.isError, true);
  assert.deepEqual(completed[0].data.result.content, []);
  assert.equal(JSON.stringify(completed).includes("hidden"), false);
  assert.throws(() => update(normalizer, { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" }), { code: "invalid_event" });
});

for (const [name, patch] of [
  ["relative path", { path: "relative.txt" }], ["URI", { path: "file:///tmp/file.txt" }],
  ["control character", { path: "/tmp/file\u0000.txt" }], ["missing new text", { newText: undefined }],
  ["coerced new text", { newText: ["new"] }], ["coerced old text", { oldText: 42 }],
]) test(`ACP rejects a malformed diff with ${name}`, () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  assert.throws(() => update(normalizer, { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", status: "in_progress",
    content: [{ type: "diff", path: "/tmp/file.txt", oldText: "old", newText: "new", ...patch }] }), { code: "invalid_event" });
});

test("ACP diff and MCP content retain order in a final observation and discard raw hidden output", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  const events = update(normalizer, { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", status: "completed", content: [
    { type: "content", content: { type: "text", text: "first", _meta: { private: true } } },
    { type: "diff", path: "/tmp/file.txt", oldText: "old", newText: "" },
    { type: "content", content: { type: "resource_link", uri: "https://example.com/report", name: "report" } },
  ], rawOutput: { secret: "never displayed" } });
  assert.deepEqual(events.map(event => event.type), ["tool_start", "tool_end"]);
  assert.deepEqual(events[1].data.result.content.map(part => part.type), ["text", "diff", "resource_link"]);
  assert.equal(JSON.stringify(events).includes("never displayed"), false);
  assert.deepEqual(normalizer.finish({ stopReason: "end_turn" }).map(event => event.type), ["message_end", "turn_end"]);
});

test("ACP terminal references remain unsupported without an owned terminal implementation", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false });
  assert.throws(() => update(normalizer, { sessionUpdate: "tool_call", toolCallId: "terminal", title: "Terminal", status: "in_progress",
    content: [{ type: "terminal", terminalId: "not-owned" }] }), { code: "unsupported_item" });
});

test("ACP diff observations are subject to existing output bounds", () => {
  const normalizer = new AcpEventNormalizer(sessionId, { requireAssistantText: false, maxBytes: 256 });
  assert.throws(() => update(normalizer, { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", status: "in_progress",
    content: [{ type: "diff", path: "/tmp/file.txt", newText: "x".repeat(256) }] }), { code: "capacity_exceeded" });
});
