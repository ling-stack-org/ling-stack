import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { workflowOperationEffectRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-command-risk-gate-"));
  const task = { id: "risk_task", title: "Risk gate", prompt: "Finite isolated test only" };
  const f = createUnifiedExecFixture(t, cwd, task, "risk_run");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { ...f, cwd, task };
}
function prepare(f, id = "source_command") {
  return f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.sourceFence, cwd: f.cwd,
    toolCallId: id, command: { kind: "shell", command: "echo fixture", shell: "bash" } });
}
const cancelled = { scope: "process_group", leaderExited: true, stdioClosed: true,
  descendants: "unverified", stopReason: "cancelled", settledBy: "close", signalFailures: [] };

test("ordinary, private and channel writes all reject persisted stop risk; reads remain available", async t => {
  const f = await fixture(t);
  f.store.settleHostCommandExecution(prepare(f), { kind: "observed", observation: cancelled });
  const reopened = createSqliteRunStore(f.cwd);
  try {
    for (const surface of [{}, { teammateId: "private-agent" }, { channelId: "channel", workflowStepId: "step" }]) {
      const run = { ...f.run, ...surface };
      for (const toolName of ["write", "edit", "bash", "unknown_mcp_tool"]) {
        const block = workflowOperationEffectRejection({ store: reopened, run,
          request: { toolName, cwd: f.cwd, input: { path: "no-write.txt", content: "must not write" } } });
        assert.equal(block.code, "command_stop_unconfirmed");
      }
    }
    assert.equal(workflowOperationEffectRejection({ store: reopened, run: f.run,
      request: { toolName: "read", cwd: f.cwd, input: { path: "inspect.txt" } } }), undefined);
  } finally { reopened.close(); }
});

test("abort persists Host risk even after the Run is terminal and every Runner event is discarded", { timeout: 6000 }, async t => {
  const f = await fixture(t); const controller = new AbortController();
  let dropped = 0, sawOutput = false;
  await assert.rejects(executeUnifiedBashTool({
    ...f, signal: controller.signal,
    request: { toolCallId: "cancel_actual", toolName: "bash", cwd: f.cwd, task: f.task,
      input: { command: "printf 'ready%0512d' 1; sleep 3", timeoutMs: 4000 } },
    appendAndMaybeStream(type) {
      if (controller.signal.aborted) { dropped++; return undefined; }
      if (type === "tool_update") {
        sawOutput = true;
        f.store.markRunCancelled(f.run.id, new Date().toISOString());
        controller.abort();
      }
    },
  }), { name: "AbortError" });
  assert.equal(sawOutput, true);
  assert.ok(dropped > 0);
  const settled = f.store.listEvents(f.run.id).find(e => e.type === "host_command_settled");
  assert.equal(settled.data.outcome, "stop_unconfirmed");
  assert.equal(settled.data.ownerCurrent, false);
  assert.equal(f.store.getRun(f.run.id).status, "cancelled");
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.equal(reopened.listHostCommandWriteBlockers(f.cwd).length, 1); }
  finally { reopened.close(); }
});

test("prepared command is present before first output and direct retry never spawns", async t => {
  const f = await fixture(t); prepare(f);
  await assert.rejects(executeUnifiedBashTool({ ...f,
    request: { toolCallId: "retry", toolName: "bash", cwd: f.cwd, task: f.task,
      input: { command: "printf forbidden > no-write.txt" } }, appendAndMaybeStream() {},
  }), e => e.code === "command_workspace_busy");
  await assert.rejects(readFile(join(f.cwd, "no-write.txt")), /ENOENT/);
  assert.equal(f.store.listArtifacts(f.run.id).length, 0);
});

test("approval resolution rechecks command risk acquired while the user was deciding", async t => {
  const f = await fixture(t);
  const other = createUnifiedExecFixture(t, f.cwd, { ...f.task, id: "other_task" }, "other_run");
  let approve;
  const requested = new Promise(resolve => { approve = resolve; });
  const handler = createRunApprovalHandler({ ...f, workUnitId: f.sourceFence.workUnitId, attemptId: f.sourceFence.attemptId,
    approvalPolicy: { toolDecisions: { write: "ask" }, allowedWritePaths: [f.cwd] },
    appendAndMaybeStream(type, data) {
      const event = f.store.appendEvent(f.run.id, type, data);
      if (type === "approval_requested") approve(data.approvalId);
      return event;
    }, streamEnvelope() {},
  });
  const pending = handler({ toolCallId: "waiting_write", toolName: "write", task: f.task, cwd: f.cwd,
    input: { path: "no-write.txt", content: "must not write" } });
  const approvalId = await requested;
  const ticket = prepare({ ...other, cwd: f.cwd });
  other.store.settleHostCommandExecution(ticket, { kind: "observed", observation: cancelled });
  f.store.approveApprovalRequest(approvalId, {}, new Date().toISOString());
  const decision = await pending;
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /command_stop_unconfirmed/);
  await assert.rejects(readFile(join(f.cwd, "no-write.txt")), /ENOENT/);
});

test("explicitly disabling Host execution cannot approve an unjournaled SDK bash fallback", async t => {
  const f = await fixture(t);
  const handler = createRunApprovalHandler({ ...f, workUnitId: f.sourceFence.workUnitId, attemptId: f.sourceFence.attemptId,
    unifiedExecEnabled: false, approvalPolicy: { toolDecisions: { bash: "allow" }, allowedWritePaths: [f.cwd] },
    appendAndMaybeStream() {}, streamEnvelope() {},
  });
  const decision = await handler({ toolCallId: "disabled", toolName: "bash", task: f.task, cwd: f.cwd,
    input: { command: "printf forbidden > no-write.txt" } });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /host_command_executor_disabled/);
  await assert.rejects(readFile(join(f.cwd, "no-write.txt")), /ENOENT/);
});

test("a terminal Run cannot create another Host bash approval", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  f.store.markRunFailed(f.run.id, new Date().toISOString(), "Prior approval expired.");
  const handler = createRunApprovalHandler({ ...f,
    workUnitId: f.sourceFence.workUnitId, attemptId: f.sourceFence.attemptId,
    unifiedExecEnabled: true,
    approvalPolicy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [f.cwd] },
    signal: AbortSignal.timeout(300),
    appendAndMaybeStream(type, data) { return f.store.appendEvent(f.run.id, type, data); },
    streamEnvelope() {},
  });
  await handler({ toolCallId: "ghost_approval", toolName: "bash", task: f.task, cwd: f.cwd,
    input: { command: "python3 -m unittest discover -s tests -v" } }).catch(() => {});
  assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 0);
});

test("failed fenced wait transition closes an already inserted Host approval", async t => {
  const f = await fixture(t);
  f.store.transitionRunExecutionStatus = () => ({ ok: false, reason: "simulated terminal race" });
  const handler = createRunApprovalHandler({ ...f,
    workUnitId: f.sourceFence.workUnitId, attemptId: f.sourceFence.attemptId,
    unifiedExecEnabled: true,
    approvalPolicy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [f.cwd] },
    appendAndMaybeStream(type, data) { return f.store.appendEvent(f.run.id, type, data); },
    streamEnvelope() {},
  });
  const decision = await handler({ toolCallId: "lost_wait", toolName: "bash", task: f.task, cwd: f.cwd,
    input: { command: "python3 -m unittest discover -s tests -v" } });
  assert.equal(decision.approved, false);
  const [approval] = f.store.listApprovalRequests({ runId: f.run.id });
  assert.equal(approval?.status, "cancelled");
  assert.equal(approval?.resolvedBy, undefined, "a lost execution is not a user cancellation");
  assert.equal(f.store.listApprovalRequests({ runId: f.run.id, status: "pending" }).length, 0);
  assert.deepEqual(f.store.listEvents(f.run.id).filter(event => event.type === "approval_cancelled")
    .map(event => event.data.approvalId), [approval.id]);
});

test("a post-spawn Host failure cleans up the actual process and never records not_started", { timeout: 7000 }, async t => {
  const f = await fixture(t), launch = f.store.launchHostCommandExecution.bind(f.store);
  f.store.launchHostCommandExecution = (...args) => { launch(...args); throw new Error("fixture post-spawn commit failure"); };
  const result = await executeUnifiedBashTool({ ...f,
    request: { toolCallId: "launch_failure", toolName: "bash", task: f.task, cwd: f.cwd,
      input: { command: "sleep 3; printf forbidden > after-launch-failure.txt", timeoutMs: 4000 } },
    appendAndMaybeStream() {},
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.unifiedExec.status, "failed");
  assert.equal(result.details.unifiedExec.processObservation.stopReason, "observer_error");
  assert.equal(f.store.listEvents(f.run.id).find(e => e.type === "host_command_settled").data.outcome, "stop_unconfirmed");
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 1);
  await assert.rejects(readFile(join(f.cwd, "after-launch-failure.txt")), /ENOENT/);
});
