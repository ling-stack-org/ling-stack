import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { resolveStoragePaths } from "@ling-stack/core";
import { createDaemonServer } from "../../dist/index.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./noncompacted-recovery-crash-worker.mjs";

// Unlike the explicit-entry worker, this process supplies no Store factory,
// registry, supervisor, composition, or direct continuation executor. The
// production Daemon startup discovers and owns all three restored SDK sources.
async function recover(input) {
  const { cwd, workflowId, rootId, sources, nonce, sourcePid } = input;
  assert.ok(process.send && nonce && sourcePid !== process.pid);
  assert.equal(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const observer = new DatabaseSync(paths.databasePath, { readOnly: true });
  const acknowledgements = [], calls = [], wires = new Map();
  const rootBudget = () => observer.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId);
  const reservations = () => observer.prepare(`SELECT id,child_run_id,parent_reservation_id,token_reserved,cost_reserved_micros,deadline_at
    FROM delegation_budget_reservations ORDER BY id`).all();
  const budgetBefore = rootBudget(), reservationsBefore = reservations();
  const markerPath = join(cwd, "journaled-marker.txt"), markerBefore = await stat(markerPath);
  let daemon;
  const transport = await createA21LoopbackTransport((_count, request) => {
    const matched = sources.filter(source => request.body.messages.some(message =>
      message.role === "tool" && message.tool_call_id === `${source.level}-read`));
    assert.equal(matched.length, 1);
    const { level, runId } = matched[0];
    assert.ok(acknowledgements.includes(level), "automatic startup must obtain the original physical SDK ACK before wire");
    const count = (wires.get(level) ?? 0) + 1; wires.set(level, count);
    const result = request.body.messages.find(message => message.role === "tool" && message.tool_call_id === `${level}-read`);
    assert.match(JSON.stringify(result.content), /one owned read per original tree source/u);
    if (level === "root") assert.equal(request.body.messages.filter(message => message.role === "tool" && message.tool_call_id === "root-write").length, 1);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (count === 1 && level !== "grandchild") {
      const reservation = observer.prepare(`SELECT r.id FROM delegation_budget_reservations r
        JOIN delegation_steps s ON s.id=r.delegation_step_id WHERE s.parent_run_id=?`).get(runId);
      assert.ok(reservation);
      return { usage, tool_calls: [{ index: 0, id: `${level}-automatic-wait`, type: "function",
        function: { name: "wait_agent", arguments: JSON.stringify({ reservationId: reservation.id, timeoutMs: 10_000 }) } }] };
    }
    return { usage, content: `Automatically recovered ${level} without replaying its original tools.` };
  });
  try {
    const runner = createA21RealPiRunner(transport), realRun = runner.runTask.bind(runner);
    runner.runTask = options => {
      calls.push(options.runId);
      const source = sources.find(value => value.runId === options.runId); assert.ok(source);
      return realRun({ ...options, onPreparedInputAccepted: async (receipt, signal) => {
        await options.onPreparedInputAccepted(receipt, signal);
        assert.deepEqual(acknowledgements, source.level === "root" ? [] : source.level === "child" ? ["root"] : ["root", "child"]);
        acknowledgements.push(source.level);
      } });
    };
    const keyRef = "env:GRACEFUL_TREE_FIXTURE_KEY";
    const create = () => createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false }, harness: {
        continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
        delegations: { mode: "enforce", maxDepth: 3, rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 },
          selectedWorkflowIds: [workflowId] },
      } }, { runner, secretResolver: {
        status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
        resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
          status: { ref, kind: "env", configured: ref === keyRef } }),
      }, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
    daemon = create();
    await daemon.start();
    const deadline = Date.now() + 12_000;
    for (;;) {
      const runs = sources.map(source => observer.prepare("SELECT id,status FROM run_sessions WHERE id=?").get(source.runId));
      if (runs.every(run => run.status === "succeeded")) break;
      assert.ok(!runs.some(run => ["failed", "cancelled"].includes(run.status)), JSON.stringify(runs));
      if (Date.now() >= deadline) throw new Error(`Automatic Daemon recovery did not complete: ${JSON.stringify({ runs, calls, acknowledgements })}`);
      await delay(10);
    }
    // stop() waits for actual pending result publication/Host drain as well as
    // SDK completion before closing the owning Store.
    await daemon.stop();
    assert.deepEqual(acknowledgements, ["root", "child", "grandchild"]);
    assert.deepEqual([...calls].sort(), sources.map(source => source.runId).sort());
    for (const source of sources) {
      const run = observer.prepare("SELECT * FROM run_sessions WHERE id=?").get(source.runId);
      const attempts = observer.prepare("SELECT * FROM work_unit_attempts WHERE work_unit_id=? ORDER BY attempt_number").all(run.work_unit_id);
      assert.equal(run.status, "succeeded"); assert.equal(attempts.length, 2);
      assert.equal(attempts[0].id, source.attemptId); assert.equal(attempts[1].status, "succeeded");
      const events = observer.prepare("SELECT type,data_json FROM run_events WHERE run_id=? ORDER BY seq").all(run.id)
        .map(event => ({ type: event.type, data: JSON.parse(event.data_json) }));
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${source.level}-read`).length, 1);
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${source.level}-spawn`).length,
        source.level === "grandchild" ? 0 : 1);
      assert.equal(events.some(event => ["run_error", "run_cancelled"].includes(event.type)), false);
    }
    const writes = observer.prepare("SELECT * FROM harness_tool_executions WHERE run_id=? AND tool_call_id='root-write'").all(rootId);
    assert.equal(writes.length, 1); assert.equal(writes[0].state, "succeeded");
    assert.equal(await readFile(markerPath, "utf8"), "one journaled write before restart\n");
    assert.equal((await stat(markerPath)).mtimeMs, markerBefore.mtimeMs);
    assert.deepEqual(rootBudget(), budgetBefore); assert.deepEqual(reservations(), reservationsBefore);
    const results = observer.prepare(`SELECT s.required,s.state,COUNT(m.id) results FROM delegation_steps s
      LEFT JOIN delegation_messages m ON m.delegation_step_id=s.id AND m.kind='result' WHERE s.root_run_id=? GROUP BY s.id`).all(rootId);
    assert.deepEqual(results.map(row => row.required).sort(), [0, 1]);
    assert.ok(results.every(row => row.state === "succeeded" && row.results === 1));
    assert.equal(observer.prepare("SELECT COUNT(*) n FROM delegation_budget_charges WHERE state NOT IN ('measured','cancelled_before_dispatch')").get().n, 0);
    const counts = { calls: calls.length, wires: transport.requests.length };
    // A second ordinary startup must not claim/replay the completed tree.
    daemon = create(); await daemon.start(); await daemon.stop();
    assert.deepEqual({ calls: calls.length, wires: transport.requests.length }, counts);
    return { kind: "graceful_tree_worker_result", nonce, cwd, pid: process.pid, sourcePid,
      automaticDaemon: true, acknowledgements, sdkLifetimes: calls.length,
      wireRequests: transport.requests.length, journaledWrites: writes.length };
  } finally {
    await daemon?.stop(); await transport.close(); observer.close();
  }
}

const input = JSON.parse(process.argv[2]);
try {
  const result = await recover(input);
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()));
} catch (error) {
  process.exitCode = 1;
  await new Promise(resolve => process.send({ kind: "graceful_tree_worker_error", nonce: input.nonce,
    pid: process.pid, message: error.stack ?? String(error) }, resolve));
} finally { process.disconnect(); }
