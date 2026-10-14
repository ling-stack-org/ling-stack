import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { WebSocket, WebSocketServer } from "ws";
import { createDaemonServer } from "../dist/index.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { RPC_OUTBOUND_MAX_FRAME_BYTES } from "../dist/server/rpc-outbound.js";

/** Replace only the upgraded transport, never the public RPC dispatch or Run lifecycle. */
class RunTransport extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  frames = [];
  closeCalls = [];

  send(data, options, callback) {
    this.frames.push(JSON.parse(String(data)));
    const completed = typeof options === "function" ? options : callback;
    if (typeof completed === "function") queueMicrotask(() => completed());
  }

  request(id, method, params = {}) {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.finishClose(code, reason);
  }

  terminate() { this.finishClose(1006, "fixture cleanup"); }

  finishClose(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  }
}

function gate() {
  let resolve;
  const promise = new Promise(release => { resolve = release; });
  return { promise, resolve };
}

/** A deterministic Runner with an actual isolated append, not a live model or Host-tool test. */
class GatedDetachRunner {
  pressure = gate();
  finish = gate();
  reached = false;
  calls = 0;
  effects = 0;
  aborts = 0;
  signal;
  toolCallId = "rpc_detach_write_once";

  constructor(cwd, pressureText) {
    this.effectPath = join(cwd, "detached-effect.txt");
    this.pressureText = pressureText;
  }

  async runTask(options) {
    this.calls += 1;
    this.signal = options.signal;
    const onAbort = () => { this.aborts += 1; };
    options.signal.addEventListener("abort", onAbort);
    try {
      options.onEvent({ type: "tool_start", toolCallId: this.toolCallId,
        toolName: "write", args: { path: "detached-effect.txt", content: "one effect\n" } });
      this.reached = true;
      await this.pressure.promise;
      options.onEvent({ type: "assistant_text_delta", text: this.pressureText });
      await this.finish.promise;
      options.signal.throwIfAborted();
      await appendFile(this.effectPath, "one effect\n", "utf8");
      this.effects += 1;
      options.onEvent({ type: "tool_end", toolCallId: this.toolCallId, toolName: "write",
        result: { path: "detached-effect.txt", content: [{ type: "text", text: "Appended one effect." }] }, isError: false });
      options.onEvent({ type: "assistant_text_delta", text: "Finished the isolated write after transport detachment." });
      return { taskId: options.task.id, events: [],
        messages: [{ role: "assistant", content: "Finished the isolated write after transport detachment." }] };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function waitFor(read, description) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function startFixture(t, scenario) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-rpc-run-detach-"));
  const stores = new Map();
  const pressureText = scenario === "oversized Run event"
    ? "p".repeat(RPC_OUTBOUND_MAX_FRAME_BYTES + 1) : "The runner is still executing.";
  const runner = new GatedDetachRunner(cwd, pressureText);
  const ws = new RunTransport();
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner,
    storeFactory: workspaceCwd => {
      let store = stores.get(workspaceCwd);
      if (!store) { store = createSqliteRunStore(workspaceCwd); stores.set(workspaceCwd, store); }
      return store;
    },
    mcpBroker: {
      async listTools(server) {
        return { statusSnapshot: { serverId: server.id, status: "ready", checkedAt: new Date().toISOString(),
          toolCount: 0, missingSecretRefs: [] }, tools: [] };
      },
      async callTool() { throw new Error("This fixture must not call an MCP tool"); },
    },
  });
  t.after(async () => {
    runner.pressure.resolve();
    runner.finish.resolve();
    ws.terminate();
    try { await daemon.stop(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/providers?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "openai-compatible", displayName: "Isolated detach fixture",
      providerId: "rpc-detach-fixture", model: "fixture-model", api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1", authHeader: false,
      capabilities: ["chat", "tool_call"], input: ["text"], enabled: true }),
  });
  const providerBody = await response.text();
  assert.ok(response.ok, providerBody);
  const provider = JSON.parse(providerBody).provider;
  const store = stores.get(cwd);
  assert.ok(store);
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "RPC detach fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Write one isolated fixture effect",
    prompt: "Append one line to detached-effect.txt exactly once." }, now);
  t.mock.method(WebSocketServer.prototype, "handleUpgrade", (_request, _socket, _head, accept) => accept(ws));
  daemon.server.emit("upgrade", { url: `/rpc/stream?cwd=${encodeURIComponent(cwd)}`,
    headers: { host: `127.0.0.1:${address.port}` } }, {}, Buffer.alloc(0));
  ws.request(1, "initialize");
  await waitFor(() => ws.frames.find(frame => frame.id === 1), "public initialize response");
  assert.equal(ws.frames.find(frame => frame.id === 1).result.ok, true);
  ws.request(2, "runs.start", { cwd, providerPresetId: provider.id, skipProviderPreflight: true,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: channel.id }, tools: ["write"] });
  const accepted = await waitFor(() => ws.frames.find(frame => frame.id === 2), "public runs.start response");
  assert.equal(accepted.result?.accepted, true, JSON.stringify(accepted));
  await waitFor(() => runner.reached, "real Run reaching its Runner gate");
  const run = store.listRuns({ limit: 100 }).find(item => item.taskId === task.id);
  assert.ok(run);
  assert.equal(ws.closeCalls.length, 0, "the initialized and running baseline must be healthy");
  return { cwd, store, runner, ws, task, run };
}

for (const scenario of ["over-budget socket buffer", "oversized Run event"]) {
  test(`public Run survives ${scenario} detachment with one durable effect and terminal report`, { timeout: 15_000 }, async t => {
    const { store, runner, ws, task, run } = await startFixture(t, scenario);
    if (scenario === "over-budget socket buffer") ws.bufferedAmount = Number.MAX_SAFE_INTEGER;
    runner.pressure.resolve();
    await waitFor(() => ws.closeCalls.find(call => call.code === 1013), "retryable transport close");
    assert.equal(ws.closeCalls[0].reason,
      scenario === "over-budget socket buffer" ? "slow_client_disconnect" : "outbound_frame_limit");
    assert.equal(runner.signal.aborted, false, "a consumer detach must not abort the real Run signal");
    assert.equal(runner.aborts, 0);
    assert.equal(runner.effects, 0, "the gated effect must happen only after the connection has detached");
    const sentAtDetach = ws.frames.length;
    assert.equal(ws.listenerCount("message"), 0);
    assert.equal(ws.listenerCount("close"), 0);
    assert.equal(ws.listenerCount("error"), 0);

    runner.finish.resolve();
    const terminal = await waitFor(() => {
      const current = store.getRun(run.id);
      return current?.status === "succeeded" ? current : undefined;
    }, "durable Run success after transport detachment");
    const report = await waitFor(() => store.listTerminalReports({ sourceKind: "run", sourceId: run.id, limit: 100 })
      .find(item => item.status === "committed" || item.status === "fallback"), "one durable terminal report");
    assert.equal(terminal.taskId, task.id);
    assert.equal(runner.signal.aborted, false);
    assert.equal(runner.aborts, 0);
    assert.equal(runner.calls, 1, "consumer failure must not start a replacement Runner");
    assert.equal(runner.effects, 1);
    assert.equal(await readFile(runner.effectPath, "utf8"), "one effect\n");
    assert.equal(store.listRuns({ limit: 100 }).filter(item => item.taskId === task.id).length, 1);
    const events = store.listEvents(run.id, { limit: 1_000 });
    assert.equal(events.filter(event => event.type === "tool_start" && event.data.toolCallId === runner.toolCallId).length, 1);
    const toolEnds = events.filter(event => event.type === "tool_end" && event.data.toolCallId === runner.toolCallId);
    assert.equal(toolEnds.length, 1);
    assert.equal(toolEnds[0].data.isError, false);
    assert.equal(events.filter(event => event.type === "result").length, 1);
    assert.equal(events.some(event => event.type === "run_cancelled" || event.type === "run_error"), false);
    assert.ok(events.some(event => event.type === "assistant_text_delta" && event.data.text === runner.pressureText),
      "the consumer budget must not truncate the durable Run event that caused detachment");
    const actions = listAllExecutionActionsForRun(store, run.id).filter(action => action.toolCallId === runner.toolCallId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, "succeeded");
    assert.ok(actions[0].sourceRefs.some(ref => ref.kind === "run_event" && ref.id === toolEnds[0].id));
    assert.equal(report.sourceKind, "run");
    assert.equal(report.sourceId, run.id);
    assert.equal(report.evidenceSnapshot.terminalState, "succeeded");
    assert.ok(report.evidenceSnapshot.operations.some(operation => operation.id === actions[0].id && operation.status === "succeeded"),
      "TerminalReport must consume the durable completed tool action, even after detach");
    assert.equal(store.listTerminalReports({ sourceKind: "run", sourceId: run.id, limit: 100 }).length, 1);
    assert.equal(ws.frames.length, sentAtDetach, "late tool and terminal events must not revive the closed consumer");
    assert.equal(ws.frames.some(frame => frame.method === "$/run_event" && frame.params?.kind === "end"), false);
  });
}
