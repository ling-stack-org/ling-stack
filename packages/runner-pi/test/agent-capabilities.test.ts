import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { PiRunnerAdapter, type PiHookDefinition, type PiRunnerEvent, type PiRunnerRunOptions } from "../dist/index.js";
import { boundedScriptText, runBoundedScript } from "../dist/script-runtime.js";

const hookSet = (hooks: PiHookDefinition[]) => ({ schemaVersion: 1 as const, digest: `sha256:${"a".repeat(64)}`, hooks });
type Call = { name: string; input: unknown };
async function fixture(t: TestContext, calls: Call[] = [], overrides: Partial<PiRunnerRunOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capabilities-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const events: PiRunnerEvent[] = [], requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    const call = calls[requests.length - 1];
    const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: "Done." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([ { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] } ].map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const runner = new PiRunnerAdapter();
  const options: PiRunnerRunOptions = { cwd, agentDir: join(cwd, "agent"), runId: "cap-run", runnerAttemptId: "cap-attempt",
    task: { id: "task", title: "Capabilities", prompt: "Use the selected tools." }, tools: ["read", "write", "bash"],
    initialToolSurface: { mediaGeneration: false, toolHydration: false, codeIntelligence: true, codeMode: true },
    provider: { provider: "capability-fixture", model: "fixture", api: "openai-completions", reasoning: false,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" },
    onEvent: event => { events.push(event); }, onToolBefore: () => ({ allowed: true }), onApprovalRequired: () => ({ approved: true }),
    ...overrides };
  return { cwd, runner, options, events, requests, run: () => runner.runTask(options) };
}

function toolEnd(events: PiRunnerEvent[], name = "code_mode") {
  const event = [...events].reverse().find(event => event.type === "tool_end" && event.toolName === name);
  assert.ok(event?.type === "tool_end"); return event;
}
function resultText(event: ReturnType<typeof toolEnd>): string {
  return (event.result as { content: { type: string; text?: string }[] }).content.map(item => item.text ?? "").join("\n");
}

test("preparation freezes schemas and executes neither hooks nor tools", async t => {
  let effects = 0;
  const f = await fixture(t, [], { hooks: hookSet([{ id: "start", event: "run_start", kind: "command", command: "echo test" }]),
    onApprovalRequired: () => { effects++; return { approved: false }; } });
  const prepared = await f.runner.prepareTaskInput(f.options);
  assert.ok(prepared.tools.some(tool => tool.name === "code_mode"));
  assert.ok(prepared.tools.some(tool => tool.name === "code_intelligence"));
  assert.equal(f.requests.length, 0); assert.equal(effects, 0); assert.deepEqual(f.events, []);
});

test("Code Mode filters read results and retains nested identities through real SDK dispatch", async t => {
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'const r = await Promise.allSettled([tools.read({path:"a.txt"}),tools.read({path:"b.txt"})]); text(r.map(x=>x.status));' } }]);
  await writeFile(join(f.cwd, "a.txt"), "large source A"); await writeFile(join(f.cwd, "b.txt"), "large source B");
  await f.run();
  const children = f.events.filter(event => event.type === "tool_end" && event.parentToolCallId === "call-1");
  assert.equal(children.length, 2);
  assert.ok(children.every(event => event.type === "tool_end" && event.toolCallId.startsWith("call-1/") && !event.isError));
  assert.match(resultText(toolEnd(f.events)), /fulfilled/);
  const lastRequest = JSON.stringify(f.requests.at(-1));
  assert.doesNotMatch(lastRequest, /large source [AB]/, "only selected script output returns to the model");
});

test("nested writes use Host approval and an SDK error cannot become success", async t => {
  let approvals = 0;
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'await tools.write({path:"blocked.txt",content:"no"});' } }], {
    onApprovalRequired: request => { approvals++; assert.ok(request.signal); return { approved: false, reason: "blocked by Host" }; },
  });
  await f.run();
  assert.equal(approvals, 1); assert.equal(toolEnd(f.events).isError, true);
  assert.match(resultText(toolEnd(f.events)), /blocked by Host/);
  await assert.rejects(readFile(join(f.cwd, "blocked.txt")), { code: "ENOENT" });
});

test("effect calls are serialized and require handled Host results", async t => {
  let active = 0, maxActive = 0, count = 0;
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'text(await Promise.allSettled([tools.bash({command:"first"}),tools.bash({command:"second"})]));' } }], {
    onApprovalRequired: async () => {
      active++; maxActive = Math.max(maxActive, active); count++; await delay(20); active--;
      return { approved: true, handledResult: { content: [{ type: "text", text: "Host result" }] } };
    },
  });
  await f.run(); assert.equal(count, 2); assert.equal(maxActive, 1); assert.equal(toolEnd(f.events).isError, false);
});

test("control tools, unselected tools and ambient Host APIs are absent", async t => {
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'text(ALL_TOOLS.map(t=>t.name)); text([typeof process,typeof require,typeof fetch,typeof setTimeout]);' } }], { tools: ["read"] });
  await f.run();
  assert.equal(toolEnd(f.events).isError, false);
  assert.equal((resultText(toolEnd(f.events)).match(/undefined/g) ?? []).length, 4);
  assert.doesNotMatch(resultText(toolEnd(f.events)), /code_mode|request_permission|bash/);
});

test("nested call budget is enforced before additional tools reach Host", async t => {
  let count = 0;
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'for(let i=0;i<40;i++) { try { await tools.code_intelligence({operation:"symbols",path:"a.ts"}); } catch {} } return "continued";' } }], {
    onCodeIntelligenceCall: async () => { count++; return { content: [{ type: "text", text: "[]" }] }; },
  });
  await f.run(); assert.equal(count, 32); assert.equal(toolEnd(f.events).isError, true);
  assert.match(resultText(toolEnd(f.events)), /code_mode_call_limit/);
});

test("QuickJS interrupts spinning code, bounds output and closes imports", { timeout: 10_000 }, async () => {
  const timeout = await runBoundedScript({ code: "while(true) {}", timeoutMs: 50 });
  assert.equal(timeout.ok, false); if (!timeout.ok) assert.equal(timeout.error.kind, "timeout");
  const noImport = await runBoundedScript({ code: 'return await import("node:fs");', timeoutMs: 1000 });
  assert.equal(noImport.ok, false);
  const subsequent = await runBoundedScript({ code: "return 42;", timeoutMs: 1000 });
  assert.equal(subsequent.ok, true); if (subsequent.ok) assert.equal(subsequent.value, 42);
  const output = boundedScriptText(await runBoundedScript({ code: 'text("x".repeat(50_000));', timeoutMs: 1000 }));
  assert.equal(output.truncated, true); assert.ok(Buffer.byteLength(output.text) <= 32 * 1024);
});

test("semantic queries retain the selected read approval policy", async t => {
  let queries = 0;
  const f = await fixture(t, [{ name: "code_intelligence", input: { operation: "symbols", path: "a.ts" } }], {
    onCodeIntelligenceCall: async () => { queries++; return { content: [] }; },
    onApprovalRequired: request => { assert.equal(request.toolName, "read"); return { approved: false, reason: "read revoked" }; },
  });
  await f.run(); assert.equal(queries, 0); assert.equal(toolEnd(f.events, "code_intelligence").isError, true);
});

test("a before-tool policy denies nested tools before approval and preserves the source call", async t => {
  let approvals = 0;
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'await tools.write({path:"guarded.txt",content:"x"});' } }], {
    hooks: hookSet([{ id: "guard", event: "before_tool", tools: ["write"], kind: "script", code: 'return {decision:"deny",reason:"generated file is protected"};' }]),
    onApprovalRequired: () => { approvals++; return { approved: true }; },
  });
  await f.run(); assert.equal(approvals, 0); assert.equal(toolEnd(f.events).isError, true);
  const receipt = f.events.find(event => event.type === "hook_execution");
  assert.ok(receipt?.type === "hook_execution" && receipt.status === "denied" && receipt.toolCallId?.startsWith("call-1/"));
});

test("a policy denial with an empty reason still blocks the tool", async t => {
  let approvals = 0;
  const f = await fixture(t, [{ name: "write", input: { path: "guarded.txt", content: "x" } }], {
    hooks: hookSet([{ id: "guard", event: "before_tool", tools: ["write"], kind: "script", code: 'return {decision:"deny",reason:""};' }]),
    onApprovalRequired: () => { approvals++; return { approved: true }; },
  });
  await f.run(); assert.equal(approvals, 0); assert.equal(toolEnd(f.events, "write").isError, true);
  await assert.rejects(readFile(join(f.cwd, "guarded.txt")), { code: "ENOENT" });
});

test("command hooks use Host approval once without recursive hook dispatch", async t => {
  const commands: string[] = [];
  const f = await fixture(t, [{ name: "read", input: { path: "file.txt" } }], {
    hooks: hookSet([{ id: "check", event: "after_tool", kind: "command", command: "printf check" }]),
    onApprovalRequired: request => { if (request.toolName === "read") return { approved: true };
      assert.equal(request.toolName, "bash"); commands.push((request.input as { command: string }).command);
      return { approved: true, handledResult: { content: [{ type: "text", text: "checked" }] } }; },
  });
  await writeFile(join(f.cwd, "file.txt"), "original"); await f.run();
  assert.equal(commands.length, 1, JSON.stringify(f.events)); assert.match(commands[0], /LING_HOOK_EVENT=/);
  assert.match(resultText(toolEnd(f.events, "read")), /original/);
  assert.equal(f.events.filter(event => event.type === "hook_execution").length, 1);
  const command = toolEnd(f.events, "bash"); assert.equal(command.parentToolCallId, "call-1");
});

test("hook failures apply the declared policy and cannot rewrite a completed tool error", async t => {
  const f = await fixture(t, [{ name: "read", input: { path: "missing.txt" } }], {
    hooks: hookSet([{ id: "observer", event: "after_tool", kind: "script", code: 'return {isError:false,content:[{type:"text",text:"fake success"}]};' }]),
  });
  await f.run(); assert.equal(toolEnd(f.events, "read").isError, true);
  assert.doesNotMatch(resultText(toolEnd(f.events, "read")), /fake success/);
});

test("blocking lifecycle hook failure stops before any provider request", async t => {
  const f = await fixture(t, [], { hooks: hookSet([{ id: "start", event: "run_start", kind: "script", code: 'throw new Error("precondition failed");' }]) });
  await assert.rejects(f.run(), /precondition failed/); assert.equal(f.requests.length, 0);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("a timed-out observer records failure and continues with the original result", async t => {
  const f = await fixture(t, [{ name: "read", input: { path: "file.txt" } }], {
    hooks: hookSet([{ id: "observer", event: "after_tool", kind: "script", timeoutMs: 30, code: "while(true) {}" }]),
  });
  await writeFile(join(f.cwd, "file.txt"), "observed value");
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.equal(toolEnd(f.events, "read").isError, false);
  assert.match(resultText(toolEnd(f.events, "read")), /observed value/);
  assert.ok(f.events.some(event => event.type === "hook_execution" && event.status === "failed"));
});

test("a blocking post-hook failure closes the model boundary even if the SDK catches it", async t => {
  const f = await fixture(t, [{ name: "read", input: { path: "file.txt" } }], {
    hooks: hookSet([{ id: "observer", event: "after_tool", kind: "script", failurePolicy: "block", code: 'throw new Error("postcondition failed");' }]),
  });
  await writeFile(join(f.cwd, "file.txt"), "observed value");
  await assert.rejects(f.run(), /postcondition failed/);
  assert.equal(f.requests.length, 1);
  assert.ok(f.events.some(event => event.type === "hook_execution" && event.status === "failed"));
});

test("command hooks require the originally selected bash tool", async t => {
  let approvals = 0;
  const f = await fixture(t, [], { tools: ["read"],
    hooks: hookSet([{ id: "start", event: "run_start", kind: "command", command: "printf check" }]),
    onApprovalRequired: () => { approvals++; return { approved: true }; },
  });
  await assert.rejects(f.run(), /hooks_command_host_authority_missing/);
  assert.equal(approvals, 0); assert.equal(f.requests.length, 0);
});

test("an interrupted command hook stops the run and emits one terminal tool receipt", async t => {
  let approvals = 0;
  const f = await fixture(t, [], {
    hooks: hookSet([{ id: "start", event: "run_start", kind: "command", command: "printf check", timeoutMs: 50, failurePolicy: "continue" }]),
    onApprovalRequired: async request => {
      approvals++;
      const signal = request.signal!; signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { approved: false };
    },
  });
  await assert.rejects(f.run(), /was interrupted/);
  assert.equal(approvals, 1); assert.equal(f.requests.length, 0);
  assert.equal(f.events.filter(event => event.type === "tool_end" && event.toolName === "bash").length, 1);
  assert.ok(f.events.some(event => event.type === "hook_execution" && event.status === "failed"));
});

test("cancellation reaches a nested Host wait and prevents follow-up execution", { timeout: 10_000 }, async t => {
  const controller = new AbortController(); let entered = false;
  const f = await fixture(t, [{ name: "code_mode", input: { code: 'await tools.bash({command:"wait"}); await tools.bash({command:"never"});' } }], {
    signal: controller.signal,
    onApprovalRequired: async request => {
      assert.equal(entered, false); entered = true;
      const signal = request.signal!;
      setTimeout(() => controller.abort(new Error("stop fixture")), 10);
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { approved: false };
    },
  });
  await assert.rejects(f.run(), { name: "AbortError" }); assert.equal(entered, true); assert.equal(f.requests.length, 1);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("restricted workflow profiles cannot acquire the new surfaces", async t => {
  const f = await fixture(t, [], { readonlyToolsProfile: "host_readonly_v1", tools: ["read"], onReadonlyToolCall: async () => ({ content: [] }) });
  await assert.rejects(f.runner.prepareTaskInput(f.options), /restricted workflow profiles/);
});
