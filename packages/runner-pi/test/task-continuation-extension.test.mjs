import assert from "node:assert/strict";
import { test } from "node:test";
import { createLingStackTaskContinuationExtension } from "../dist/extensions/task-continuation.js";
import {
  createDelegationInstructionContextProjector,
  readDelegationInstructionDirective,
} from "../dist/delegation-instruction.js";

const message = (id, content = `Instruction ${id}`, digest = "a".repeat(64)) => ({
  role: "user", content, timestamp: 1,
  delegationInstruction: { messageId: id, digest },
});
const directive = (insertAfterMessageCount, messages) => ({
  kind: "delegation_instructions", schemaVersion: 1, insertAfterMessageCount, messages,
});

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
  const context = await handlers.get("context")({ type: "context", messages: [] });
  await handlers.get("tool_call")({
    type: "tool_call",
    toolName: "read",
    toolCallId: "tool-read",
    input: { path: "README.md" },
  });

  assert.deepEqual(observed, ["before_agent_start", "before_provider_request", "tool_call"]);
  assert.deepEqual(context, { messages: [] });
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

test("delegation instruction parser rejects prototypes, getters, extra fields, sparse arrays, and bad digests", () => {
  let getterCalls = 0;
  const getterMessage = { role: "user", content: "unsafe", timestamp: 1,
    get delegationInstruction() { getterCalls += 1; return { messageId: "getter", digest: "a".repeat(64) }; } };
  const sparse = new Array(1);
  for (const value of [
    Object.assign(Object.create({ inherited: true }), directive(1, [message("prototype")])),
    directive(1, [getterMessage]),
    { ...directive(1, [message("extra")]), extra: true },
    directive(1, sparse),
    directive(1, [message("bad-digest", "unsafe", "not-a-digest")]),
  ]) assert.throws(() => readDelegationInstructionDirective(value), /Invalid delegation instruction directive/u);
  assert.equal(getterCalls, 0);
});

test("delegation instruction projector is idempotent per identity and rejects identity drift", () => {
  const projector = createDelegationInstructionContextProjector();
  const first = directive(1, [message("same")]);
  projector.accept(first);
  projector.accept(structuredClone(first));
  assert.deepEqual(projector.project([{ role: "user", content: "task" }]), [
    { role: "user", content: "task" }, message("same"),
  ]);
  assert.throws(() => projector.accept(directive(1, [message("same", "changed")])), /identity changed/u);
  assert.throws(() => projector.accept(directive(2, [message("same")])), /identity changed/u);
});

test("delegation instruction projector inserts multiple batches at stable transcript anchors", () => {
  const projector = createDelegationInstructionContextProjector();
  projector.accept(directive(2, [message("later") ]));
  projector.accept(directive(1, [message("earlier-a"), message("earlier-b") ]));
  projector.accept(directive(2, [message("later-second") ]));
  const original = [{ role: "user", content: "task" }, { role: "assistant", content: "settled" }];
  assert.deepEqual(projector.project(original), [original[0], message("earlier-a"), message("earlier-b"),
    original[1], message("later"), message("later-second")]);
  assert.deepEqual(original, [{ role: "user", content: "task" }, { role: "assistant", content: "settled" }]);
});

test("context projection failures latch execution instead of being swallowed by the SDK", async () => {
  const handlers = new Map();
  const failures = [];
  createLingStackTaskContinuationExtension({
    cwd: process.cwd(), task: { id: "task", title: "Task", prompt: "Continue safely" },
    provider: { provider: "test", model: "test" },
    onTaskContinuationBoundary: async () => directive(3, [message("missing-anchor")]),
    onTaskContinuationDirectiveFailure: error => { failures.push(error); throw error; },
  })({ on: (event, handler) => handlers.set(event, handler) });
  await assert.rejects(handlers.get("context")({ type: "context", messages: [{ role: "user", content: "task" }] }),
    /anchor is unavailable/u);
  assert.equal(failures.length, 1);
});
