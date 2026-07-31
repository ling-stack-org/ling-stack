import assert from "node:assert/strict";
import { test } from "node:test";
import { createLingStackTaskContinuationExtension } from "../dist/extensions/task-continuation.js";

test("task continuation extension gates agent, provider, and tool boundaries", async () => {
  const handlers = new Map();
  const observed = [];
  createLingStackTaskContinuationExtension({
    cwd: process.cwd(),
    task: { id: "task", title: "Task", prompt: "Continue safely" },
    provider: { provider: "test", model: "test" },
    onTaskContinuationBoundary: async (boundary) => {
      observed.push(boundary);
    },
  })({ on: (event, handler) => handlers.set(event, handler) });

  await handlers.get("before_agent_start")({ type: "before_agent_start" });
  await handlers.get("before_provider_request")({ type: "before_provider_request" });
  await handlers.get("tool_call")({
    type: "tool_call",
    toolName: "read",
    toolCallId: "tool-read",
    input: { path: "README.md" },
  });

  assert.deepEqual(observed, ["before_agent_start", "before_provider_request", "tool_call"]);
});

test("task continuation extension waits instead of blocking a tool result", async () => {
  const handlers = new Map();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  createLingStackTaskContinuationExtension({
    cwd: process.cwd(),
    task: { id: "task", title: "Task", prompt: "Wait" },
    provider: { provider: "test", model: "test" },
    onTaskContinuationBoundary: () => waiting,
  })({ on: (event, handler) => handlers.set(event, handler) });

  let settled = false;
  const pending = handlers.get("tool_call")({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "tool-bash",
    input: { command: "echo safe" },
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.equal(await pending, undefined);
});
