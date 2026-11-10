import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, getRunSummaryPath } from "../../core/dist/index.js";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";

for (const scenario of ["current", "current-failure", "current-cancel", "host-cancel", "timeout", "replaced-success", "replaced-failure", "replaced-cancel", "replaced-registry", "replaced-terminal", "terminal-race", "failure-terminal-race"]) {
  test(`Runner completion cannot publish with a stale owner: ${scenario}`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-completion-fence-"));
    const registry = new RunStoreRegistry(createSqliteRunStore);
    const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
    t.after(async () => { supervisor.releaseAll(); registry.closeAll(); await rm(cwd, { recursive: true, force: true }); });
    const activeRuns = new ActiveRunRegistry();
    const observed = { events: [], terminals: [], errors: [] };
    const adapter = { async runTask(options) {
      const store = registry.getStore(cwd);
      observed.run = store.getRun(options.runId);
      const unit = store.getWorkUnit(observed.run.workUnitId);
      observed.originalAttemptId = options.runnerAttemptId;
      if (scenario.startsWith("replaced")) {
        observed.successor = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
          runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: new Date().toISOString() });
        observed.unitBefore = store.getWorkUnit(unit.id);
        if (scenario === "replaced-terminal") store.markRunSucceeded(options.runId, new Date().toISOString());
        if (scenario === "replaced-registry") activeRuns.add(options.runId, { abortController: new AbortController(),
          streamEnvelope: () => undefined, workUnitId: unit.id, attemptId: observed.successor.id,
          runtimeInstanceId: observed.successor.runtimeInstanceId });
      }
      if (scenario.endsWith("cancel")) {
        if (scenario === "host-cancel") ensureRunCancelled({ store, runId: options.runId, taskId: options.task.id, active: true, reason: "interrupt redirect" });
        activeRuns.requestStop(options.runId, { kind: "user_cancel", actor: "local-user", reason: "test cancel" });
        throw new Error("cancelled runner");
      }
      if (scenario === "timeout") {
        store.database.prepare("UPDATE work_units SET status='cancelling' WHERE id=?").run(unit.id);
        store.database.prepare("UPDATE work_unit_attempts SET status='cancelling', abort_requested_at=? WHERE id=?")
          .run(new Date().toISOString(), options.runnerAttemptId);
        activeRuns.requestStop(options.runId, { kind: "runtime_failure", code: "hard_timeout", reason: "hard_timeout" });
        throw new Error("timeout runner");
      }
      if (scenario.endsWith("terminal-race")) {
        // Reject the actual completion CAS after the callback has returned its result.
        const original = store.transitionRunStatus.bind(store);
        const event = scenario === "terminal-race" ? "runner_succeeded" : "runner_failed";
        store.transitionRunStatus = input => input.event === event
          ? { ok: false, code: "stale_transition", currentStatus: "running" } : original(input);
        const originalFenced = store.transitionRunExecutionStatus?.bind(store);
        if (originalFenced) store.transitionRunExecutionStatus = input => input.event === event
          ? { ok: false, code: "stale_transition", currentStatus: "running" } : originalFenced(input);
        await writeFile(getRunSummaryPath(store.paths, options.runId), "existing-summary", "utf8");
      }
      options.onEvent({ type: "tool_start", toolCallId: "late-write", toolName: "write", args: { path: "late.txt", content: "late output" } });
      options.onEvent({ type: "tool_end", toolCallId: "late-write", toolName: "write", result: { content: [{ type: "text", text: "late tool output" }] }, isError: false });
      if (scenario === "replaced-failure" || scenario === "current-failure" || scenario === "failure-terminal-race") throw new Error("runner failure");
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "done" }] };
    } };
    const runners = createRunnerRegistry([{ id: "runner_pi_embedded", aliases: ["pi"], displayName: "Fixture", status: "enabled", adapter }]);
    const sink = { ...createDetachedRunExecutionSink(), writeEvent: (_type, event) => observed.events.push(event),
      writeError: (_status, body) => observed.errors.push(body) };
    const runId = await executeRunRequest({ cwd, task: { id: "fixture-task", title: "Fixture", prompt: "Fixture" },
      provider: { provider: "test-provider", model: "test-model" }, tools: ["write"], thinkingLevel: "off" },
      sink, runners, registry, activeRuns, supervisor, { resolve: () => undefined }, {},
      { afterRunTerminal: run => observed.terminals.push(run.id) });
    assert.deepEqual(observed.errors, [], "fixture reached real runner dispatch");
    assert.ok(observed.run);
    assert.equal(runId, observed.run.id);
    const store = registry.getStore(cwd);
    if (scenario === "current") {
      assert.equal(store.getRun(runId).status, "succeeded");
      assert.equal(observed.terminals.length, 1);
      assert.equal(JSON.parse(await readFile(getRunSummaryPath(store.paths, runId), "utf8")).status, "succeeded");
    } else if (scenario === "current-failure" || scenario === "timeout" || scenario === "current-cancel" || scenario === "host-cancel") {
      const expected = scenario.endsWith("cancel") ? "cancelled" : "failed";
      assert.equal(store.getRun(runId).status, expected);
      assert.equal(store.getWorkUnit(observed.run.workUnitId).status, expected);
      assert.equal(observed.terminals.length, 1);
      assert.equal(JSON.parse(await readFile(getRunSummaryPath(store.paths, runId), "utf8")).status, expected);
      if (scenario === "timeout") assert.equal(store.getRun(runId).errorMessage, "hard_timeout");
    } else if (scenario.endsWith("terminal-race")) {
      assert.equal(await readFile(getRunSummaryPath(store.paths, runId), "utf8"), "existing-summary");
      assert.equal(observed.terminals.length, 0);
    } else {
      assert.equal(store.getRun(runId).status, scenario === "replaced-terminal" ? "succeeded" : "running", "old completion cannot settle the replacement run");
      assert.deepEqual(store.getWorkUnit(observed.run.workUnitId), observed.unitBefore);
      const events = store.listEvents(runId, { limit: 1000 });
      assert.equal(events.some(event => ["tool_start", "tool_end", "result", "run_error", "artifact_created"].includes(event.type)), false);
      assert.equal(store.listArtifacts(runId).length, 0);
      await assert.rejects(readFile(getRunSummaryPath(store.paths, runId)), /ENOENT/);
      assert.equal(observed.terminals.length, 0);
      if (scenario === "replaced-registry") assert.equal(activeRuns.get(runId)?.attemptId, observed.successor.id);
    }
  });
}
