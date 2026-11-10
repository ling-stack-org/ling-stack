import assert from "node:assert/strict";
import test from "node:test";
import { createLingStackModelContextBudgetExtension } from "../dist/model-context-budget.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { formatTaskPrompt } from "../dist/utils.js";
import { assertPiModelContextCapacity } from "../dist/prepared-input.js";
import { projectCompactionTaskView } from "../dist/compaction-task-anchor.js";
import { readCompactionRecoveryView } from "../dist/compaction-recovery.js";

const task = { id: "task-anchor", title: "Preserve constraints", prompt: 'Write {"entries":[{"name":"one","rows":3}]}; never repeat completed effects.' };
const acceptedTaskPrompt = formatTaskPrompt(task);
const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: 42 });
const compacted = () => [{ role: "compactionSummary", summary: "A lossy progress summary without the original schema.", timestamp: 42 },
  { role: "assistant", content: [{ type: "toolCall", id: "done-effect", name: "write", arguments: {} }], timestamp: 43 },
  { role: "toolResult", toolCallId: "done-effect", toolName: "write", content: [{ type: "text", text: "already done" }], isError: false, timestamp: 44 }];
const text = message => message.role === "user" ? typeof message.content === "string" ? message.content
  : message.content?.filter(block => block.type === "text").map(block => block.text).join("") : undefined;
const anchorCount = messages => messages.filter(message => text(message) === acceptedTaskPrompt).length;
function contextHook(prompt = acceptedTaskPrompt) {
  let hook;
  createLingStackModelContextBudgetExtension({ acceptedTaskPrompt: prompt })({ on(name, callback) {
    assert.equal(name, "context"); hook = callback;
  } });
  return messages => hook({ messages }).messages;
}

test("task anchor leaves initial prepared input unchanged before SDK compaction", () => {
  const messages = [user(acceptedTaskPrompt)];
  assert.deepEqual(contextHook()(messages), messages);
});

test("compacted model projection retains the exact accepted task as ordinary user content", () => {
  const messages = compacted();
  const before = structuredClone(messages);
  const projected = contextHook()(messages);
  assert.equal(anchorCount(projected), 1);
  assert.deepEqual(projected[0], messages[0]);
  assert.deepEqual(projected.slice(2), messages.slice(1), "the completed call/result pair and last role must not move");
  assert.equal(projected[1].role, "user", "the accepted user task must not become a system instruction");
  assert.deepEqual(messages, before, "SDK state/evidence must not be rewritten by the projection");
});

test("repeated compaction projection is idempotent and does not trust a summary or tool echo as the anchor", () => {
  const messages = compacted();
  messages[0].summary = acceptedTaskPrompt;
  messages.at(-1).content = [{ type: "text", text: acceptedTaskPrompt }];
  const project = contextHook();
  const once = project(messages);
  const twice = project(once);
  assert.equal(anchorCount(twice), 1);
  assert.deepEqual(twice, once);
});

test("an exact retained user prompt is not reinserted or reordered", () => {
  const messages = [compacted()[0], user(acceptedTaskPrompt), ...compacted().slice(1)];
  assert.deepEqual(contextHook()(messages), messages);
});

test("restored compacted task cannot dispatch if an SDK context hook loses its accepted anchor", () => {
  const options = { cwd: "/tmp/isolated-task-anchor", task, provider: { provider: "fixture", model: "fixture" } };
  const boundary = createPiTaskBoundary(options, () => ({ systemPrompt: "Task system", messages: compacted(), acceptedTaskPrompt }));
  let requests = 0;
  const runtime = { streamSimple() { requests += 1; return {}; } };
  boundary.bindModelRuntime(runtime);
  const model = { contextWindow: 8_000, maxTokens: 512 };
  const context = { systemPrompt: "Task system", messages: [user("SDK summary only")], tools: [] };
  assert.throws(() => runtime.streamSimple(model, context, {}), /accepted task anchor/iu);
  assert.equal(requests, 0);
  assert.ok(boundary.failure, "the guard must latch errors even when SDK hooks swallow exceptions");
});

test("task anchor admission does not treat a compaction summary request as a new user task", () => {
  const options = { cwd: "/tmp/isolated-task-anchor", task, provider: { provider: "fixture", model: "fixture" } };
  const boundary = createPiTaskBoundary(options, () => ({ systemPrompt: "Task system", messages: compacted(), acceptedTaskPrompt }));
  let requests = 0;
  const runtime = { streamSimple() { requests += 1; return {}; } };
  boundary.bindModelRuntime(runtime);
  runtime.streamSimple({ contextWindow: 8_000, maxTokens: 512 },
    { systemPrompt: "Summarize conversation progress", messages: [user("previous context")], tools: [] }, {});
  assert.equal(requests, 1);
});

test("Host-sealed projected view preserves the restore mode and cannot append a new tool turn", () => {
  const messages = compacted();
  const projected = projectCompactionTaskView(messages, acceptedTaskPrompt);
  const restored = readCompactionRecoveryView({ schemaVersion: 1, modelView: projected });
  assert.equal(anchorCount(restored), 1);
  assert.deepEqual(projectCompactionTaskView(restored, acceptedTaskPrompt), restored);
  assert.deepEqual(restored.at(-1), messages.at(-1));
  assert.equal(restored.filter(message => message.role === "assistant").length, 1);
});

test("an accepted task that exceeds capacity is rejected rather than clipped or silently omitted", () => {
  const largePrompt = "whole-frozen-task ".repeat(2_000);
  const projected = contextHook(largePrompt)(compacted());
  assert.ok(projected.some(message => text(message) === largePrompt));
  assert.throws(() => assertPiModelContextCapacity({ contextWindow: 2_000, maxTokens: 256 },
    { systemPrompt: "Task system", messages: projected, tools: [] }), /model context exceeds.*budget/iu);
});

test("a compacted empty task fails closed and non-text user content cannot impersonate an anchor", () => {
  assert.throws(() => contextHook(" ")(compacted()), /accepted task anchor is empty/iu);
  const messages = [compacted()[0], { ...user(acceptedTaskPrompt), content: [
    { type: "text", text: acceptedTaskPrompt }, { type: "image", data: "not-an-exact-user-prompt", mimeType: "image/png" } ] },
  ...compacted().slice(1)];
  const projected = contextHook()(messages);
  assert.equal(projected.length, messages.length + 1);
});
