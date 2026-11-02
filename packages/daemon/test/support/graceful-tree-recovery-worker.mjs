import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { resolveConfig } from "../../dist/config.js";
import { createDelegatedRunDispatchAuthority } from "../../dist/features/harness/delegations/delegated-run-dispatch.js";
import { assertDelegationRecoveryParentCurrent, createDelegationRuntimeRegistry, createDelegationWorkflowSelector }
  from "../../dist/features/harness/delegations/runtime-registry.js";
import { createOriginalDelegationStoreComposition } from "../../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeDelegatedRunRequest, executeExistingRunContinuation }
  from "../../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { createRunShutdownCoordinator } from "../../dist/runtime/run-shutdown-coordinator.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./noncompacted-recovery-crash-worker.mjs";

// A separate PID has no access to the old SDK session, private binding, Store,
// observations or live maps. Only the test-owned durable database crosses over.
async function recover(input) {
  const { cwd, workflowId, rootId, sources, nonce, sourcePid } = input;
  assert.ok(process.send && nonce && sourcePid !== process.pid);
  assert.equal(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, cwd);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, channels: { terminalReports: false }, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", maxDepth: 3, rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 },
      selectedWorkflowIds: [workflowId] },
  } });
  const supervisor = new RuntimeSupervisor(config), activeRuns = new ActiveRunRegistry();
  const errors = [], acknowledgements = [], calls = [], wires = new Map();
  let store, stores, registry, shutdown;
  const transport = await createA21LoopbackTransport((_count, request) => {
    const matched = sources.filter(source => request.body.messages.some(message =>
      message.role === "tool" && message.tool_call_id === `${source.level}-read`));
    assert.equal(matched.length, 1, "the new process wire must retain exactly its original source's tool result");
    const { level, runId } = matched[0];
    assert.ok(acknowledgements.includes(level));
    const count = (wires.get(level) ?? 0) + 1; wires.set(level, count);
    const result = request.body.messages.find(message => message.role === "tool" && message.tool_call_id === `${level}-read`);
    assert.match(JSON.stringify(result.content), /one owned read per original tree source/u);
    if (level === "root") assert.equal(request.body.messages.filter(message =>
      message.role === "tool" && message.tool_call_id === "root-write").length, 1);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (count === 1 && level !== "grandchild") {
      const reservation = store.database.prepare(`SELECT r.id FROM delegation_budget_reservations r
        JOIN delegation_steps s ON s.id=r.delegation_step_id WHERE s.parent_run_id=?`).get(runId);
      assert.ok(reservation);
      return { usage, tool_calls: [{ index: 0, id: `${level}-new-process-wait`, type: "function",
        function: { name: "wait_agent", arguments: JSON.stringify({ reservationId: reservation.id, timeoutMs: 10_000 }) } }] };
    }
    return { usage, content: `Recovered ${level} in a different Host PID without replaying old tools.` };
  });
  try {
    const runner = createA21RealPiRunner(transport), actualRun = runner.runTask.bind(runner);
    runner.runTask = options => {
      calls.push(options.runId);
      const source = sources.find(value => value.runId === options.runId); assert.ok(source);
      return actualRun({ ...options, onPreparedInputAccepted: async (receipt, signal) => {
        await options.onPreparedInputAccepted(receipt, signal);
        assert.deepEqual(acknowledgements, source.level === "root" ? [] : source.level === "child" ? ["root"] : ["root", "child"]);
        acknowledgements.push(source.level);
      } });
    };
    const runners = createRunnerRegistry([{ id: "pi", displayName: "Real SDK offline graceful tree", status: "enabled", adapter: runner }]);
    const keyRef = "env:GRACEFUL_TREE_FIXTURE_KEY";
    const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
      resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
        status: { ref, kind: "env", configured: ref === keyRef } }) };
    const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
      delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
    const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
    store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding }); composition.bindExactStore(store);
    stores = new RunStoreRegistry(() => store, { recoverOnOpen: false }); stores.getStore(cwd);
    const budgetBefore = store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId);
    const reservationQuery = "SELECT id,child_run_id,parent_reservation_id,token_reserved,cost_reserved_micros,deadline_at FROM delegation_budget_reservations ORDER BY id";
    const reservationsBefore = store.database.prepare(reservationQuery).all();
    const markerPath = join(cwd, "journaled-marker.txt"), markerBefore = await stat(markerPath);
    const sink = () => ({ ...createDetachedRunExecutionSink(), writeError: (status, body) => errors.push({ status, body }) });
    registry = createDelegationRuntimeRegistry({ supervisor, activeRuns,
      isWorkflowSelected: createDelegationWorkflowSelector([workflowId]), executeDelegatedRunRequest: value =>
        executeDelegatedRunRequest(value, sink(), runners, stores, activeRuns, supervisor, resolver, {}),
      assertRecoveryParentCurrent: value => assertDelegationRecoveryParentCurrent({ ...value, activeRuns }) });
    registry.registerStore(store, composition.lifecycle); shutdown = createRunShutdownCoordinator({ activeRuns, delegations: registry });
    assert.equal(registry.recoverStore(store).dispatched, 0);
    await Promise.all([executeExistingRunContinuation({ cwd, runId: rootId, origin: "daemon_recovery",
      idempotencyDiscriminator: "graceful-tree-different-pid" }, sink(), runners, stores, activeRuns, supervisor, resolver, {}),
      activeRuns.waitForIdle()]);
    await registry.settle();
    assert.deepEqual(errors, []); assert.deepEqual(acknowledgements, ["root", "child", "grandchild"]);
    assert.deepEqual([...calls].sort(), sources.map(source => source.runId).sort());
    for (const source of sources) {
      const run = store.getRun(source.runId), attempts = store.listWorkUnitAttempts(run.workUnitId);
      assert.equal(run.status, "succeeded"); assert.equal(attempts.length, 2);
      assert.equal(attempts.filter(attempt => attempt.id === source.attemptId).length, 1);
      assert.equal(attempts.filter(attempt => attempt.status === "succeeded").length, 1);
      const events = store.listEvents(run.id, { limit: 1000 });
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${source.level}-read`).length, 1);
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${source.level}-spawn`).length,
        source.level === "grandchild" ? 0 : 1);
    }
    assert.equal(store.listEvents(rootId, { limit: 1000 }).filter(event => event.type === "tool_end" && event.data.toolCallId === "root-write").length, 1);
    const writes = store.listHarnessToolExecutions(rootId).filter(execution => execution.toolCallId === "root-write");
    assert.equal(writes.length, 1); assert.equal(writes[0].state, "succeeded");
    assert.ok(writes[0].evidenceArtifactIds.length);
    assert.equal(await readFile(markerPath, "utf8"), "one journaled write before restart\n");
    assert.equal((await stat(markerPath)).mtimeMs, markerBefore.mtimeMs, "no hidden physical rewrite is permitted");
    assert.deepEqual(store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId), budgetBefore);
    assert.deepEqual(store.database.prepare(reservationQuery).all(), reservationsBefore);
    const fanIn = store.getDelegationCompletionEvidence({ rootRunIds: [rootId] });
    assert.deepEqual(fanIn.steps.map(value => value.step.required).sort(), [false, true]);
    assert.ok(fanIn.steps.every(value => value.step.state === "succeeded" && value.results.length === 1));
    return { kind: "graceful_tree_worker_result", nonce, cwd, pid: process.pid, sourcePid,
      acknowledgements, sdkLifetimes: calls.length, wireRequests: transport.requests.length, journaledWrites: writes.length };
  } finally {
    await shutdown?.shutdown("daemon_restart");
    await transport.close(); supervisor.releaseAll(); stores?.closeAll();
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
