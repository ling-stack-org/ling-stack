import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";

test("orchestrator persists loop evidence before abort and fences late Runner events", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-execution-loop-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });

  const observed = { abortSeen: false, events: [] };
  const runners = createRunnerRegistry([{
    id: "runner_pi_embedded",
    aliases: ["pi"],
    displayName: "Loop fixture",
    status: "enabled",
    adapter: {
      async runTask(options) {
        for (let index = 0; index < 3; index += 1) {
          const toolCallId = `repeat-${index}`;
          options.onEvent({ type: "tool_start", toolCallId, toolName: "read", args: { path: "same.txt" } });
          options.onEvent({ type: "tool_end", toolCallId, toolName: "read", result: { text: "same" }, isError: false });
        }
        observed.abortSeen = options.signal.aborted;
        options.onEvent({ type: "tool_start", toolCallId: "late-call", toolName: "write", args: { path: "late.txt" } });
        options.onEvent({ type: "tool_end", toolCallId: "late-call", toolName: "write", result: { text: "late" }, isError: false });
        options.signal.throwIfAborted();
        return { taskId: options.task.id, events: [], messages: [] };
      },
    },
  }]);
  const sink = {
    ...createDetachedRunExecutionSink(),
    writeEvent: (_type, event) => observed.events.push(event),
  };
  const runId = await executeRunRequest({
    cwd,
    task: { id: "loop-task", title: "Loop", prompt: "Repeat the same read." },
    provider: { provider: "fixture", model: "fixture" },
    tools: ["read", "write"],
    thinkingLevel: "off",
  }, sink, runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {});

  assert.ok(runId);
  assert.equal(observed.abortSeen, true);
  const store = stores.getStore(cwd);
  const run = store.getRun(runId);
  const workUnit = store.getWorkUnit(run.workUnitId);
  const attempt = store.getWorkUnitAttempt(workUnit.activeAttemptId);
  const events = store.listEvents(runId, { limit: 1000 });
  const loopEvent = events.find((event) => event.type === "loop_detected");
  const runError = events.find((event) => event.type === "run_error");

  assert.ok(loopEvent, "loop fact must be durable");
  assert.ok(runError, "terminal failure remains durable");
  assert.ok(loopEvent.seq < runError.seq, "loop fact must commit before terminal abort handling");
  assert.equal(loopEvent.data.attemptId, attempt.id);
  assert.equal(loopEvent.data.loopKind, "exact_repeat");
  assert.equal(loopEvent.data.retryable, false);
  assert.equal(events.some((event) => event.data?.toolCallId === "late-call"), false);
  assert.equal(run.status, "failed");
  assert.equal(workUnit.status, "failed");
  assert.equal(workUnit.errorCode, "execution_loop_detected");
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.errorCode, "execution_loop_detected");
  assert.equal(activeRuns.get(runId), undefined);
});
