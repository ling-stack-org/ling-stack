import assert from "node:assert/strict";
import test from "node:test";
import { createLingStackToolBeforeExtension } from "../dist/extensions/tool-before.js";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

function handler(onToolBefore) {
  const handlers = new Map();
  createLingStackToolBeforeExtension({ cwd: "/workspace", onToolBefore })({
    on: (event, callback) => handlers.set(event, callback),
  });
  return handlers.get("tool_call");
}

for (const toolName of ["read", "write", "edit", "bash", "mcp__external", "image_generate", "request_permissions", "tool_hydration_load", "future_unknown"]) {
  test("tool-before gate blocks " + toolName + " without invoking a tool implementation", async () => {
    const seen = [];
    const call = handler(async (request) => {
      seen.push(request);
      return { allowed: false, code: "operation_binding_tool_out_of_scope", reason: "Denied" };
    });
    const input = { path: "allowed.txt" };
    const result = await call({ toolName, toolCallId: "call", input });
    assert.equal(result.block, true);
    assert.match(result.reason, /operation_binding_tool_out_of_scope/);
    assert.deepEqual(seen, [{ toolName, toolCallId: "call", input, cwd: "/workspace" }]);
  });
}

test("tool-before is transparent for approved and legacy calls, but rejects callback failures", async () => {
  const event = { toolName: "read", toolCallId: "call", input: { path: "allowed.txt" } };
  assert.equal(await handler(undefined)(event), undefined);
  assert.equal(await handler(() => ({ allowed: true }))(event), undefined);
  const result = await handler(() => { throw new Error("state lookup failed"); })(event);
  assert.equal(result.block, true);
  assert.match(result.reason, /tool_before_gate_failed/);
});

test("native path semantics expose tilde, at-prefix and Unicode-space reinterpretation without filesystem effects", async () => {
  const cwd = "/workspace";
  const writtenPaths = [];
  const tool = createWriteToolDefinition(cwd, { operations: {
    mkdir: async () => {},
    writeFile: async (path) => { writtenPaths.push(path); },
  } });
  for (const path of ["~/output.txt", "@output.txt", "narrow\u202fspace.txt", "no\u00a0break.txt"]) {
    await tool.execute("probe", { path, content: "not written" });
    assert.notEqual(writtenPaths.at(-1), resolve(cwd, path), path);
  }
  await tool.execute("normal", { path: "目录/normal file.txt", content: "not written" });
  assert.equal(writtenPaths.at(-1), resolve(cwd, "目录/normal file.txt"));
});
