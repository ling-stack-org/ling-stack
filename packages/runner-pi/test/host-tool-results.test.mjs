import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostToolResultAdapter } from "../dist/host-tool-results.js";
import { translatePiEvent } from "../dist/events.js";
import { createLingStackBashToolExtension } from "../dist/extensions/bash.js";
import { createLingStackFileMutationToolExtension } from "../dist/extensions/file-mutation.js";

function registry() {
  let hook;
  const adapt = createHostToolResultAdapter({ on(name, handler) {
    assert.equal(name, "tool_result"); hook = handler;
  } });
  return { adapt, end: (result, changes = {}) => hook({
    type: "tool_result", toolName: "bash", toolCallId: "call",
    content: result.content, details: result.details, isError: false, ...changes,
  }) };
}
const failure = { content: [{ type: "text", text: "failed" }], details: { sourceRefs: ["fixture"] }, isError: true };

test("Host result identity is consumed once; no markers are serialized into evidence", () => {
  const r = registry(), result = r.adapt("call", "bash", failure);
  assert.deepEqual(Object.keys(result).sort(), ["content", "details"]);
  assert.equal(result.details, failure.details);
  assert.deepEqual(r.end(result), { isError: true });
  assert.equal(r.end(result), undefined);
});

test("cloned result payloads cannot impersonate a registered Host result", () => {
  const r = registry(), result = r.adapt("call", "bash", failure);
  assert.equal(r.end(structuredClone(result)), undefined);
  assert.deepEqual(r.end(result), { isError: true });
});

for (const changes of [
  { toolCallId: "other" }, { toolName: "other" }, { details: structuredClone(failure.details) },
]) {
  test(`recognized result with conflicting ${Object.keys(changes)[0]} fails closed`, () => {
    const r = registry(), result = r.adapt("call", "bash", { ...failure, isError: false });
    assert.deepEqual(r.end(result, changes), { isError: true });
    assert.equal(r.end(result), undefined);
  });
}

test("SDK failure/cancellation has priority and consumes registered result", () => {
  const r = registry(), result = r.adapt("call", "bash", { ...failure, isError: false });
  assert.equal(r.end(result, { isError: true }), undefined);
  assert.equal(r.end(result), undefined);
});

test("parallel calls and identical call IDs use independent result object identities", () => {
  const r = registry(), other = registry();
  const failed = r.adapt("call", "bash", failure);
  const ok = r.adapt("call", "bash", { ...failure, isError: false });
  assert.equal(other.end(failed), undefined);
  assert.deepEqual(r.end(ok), { isError: false });
  assert.deepEqual(r.end(failed), { isError: true });
});

test("Host translator trusts SDK status rather than arbitrary tool-result fields", () => {
  const event = translatePiEvent({
    type: "tool_execution_end", toolName: "fixture", toolCallId: "call", isError: false,
    result: { ...failure, details: { unifiedExec: { status: "failed" } } },
  });
  assert.equal(event.isError, false);
});

for (const [toolName, extension] of [
  ["bash", createLingStackBashToolExtension],
  ["write", createLingStackFileMutationToolExtension],
  ["edit", createLingStackFileMutationToolExtension],
]) {
  for (const timing of ["before", "during"]) {
    test(`${toolName} cancellation ${timing} Host callback cannot publish a late success`, async () => {
      const controller = new AbortController(), reason = new Error("Fixture cancelled");
      const registered = new Map(); let calls = 0;
      extension({
        cwd: "/tmp/fixture-unused", task: { id: "fixture", title: "Fixture", prompt: "Fixture" },
        onApprovalRequired: async () => {
          calls += 1; controller.abort(reason);
          return { approved: true, handledResult: { ...failure, isError: false } };
        },
      })({ on() {}, registerTool: tool => registered.set(tool.name, tool) });
      if (timing === "before") controller.abort(reason);
      await assert.rejects(registered.get(toolName).execute("call", {}, controller.signal), error => error === reason);
      assert.equal(calls, timing === "before" ? 0 : 1);
    });
  }
}
