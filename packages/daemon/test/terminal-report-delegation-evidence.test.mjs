import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildDeterministicTerminalReport, computeTerminalReportEvidenceFingerprint, resolveSessionRunPolicy, toRuntimeAttemptFence, validateTerminalReport } from "../../core/dist/index.js";
import { SqliteDelegationLifecycleStore } from "../../core/dist/storage/sqlite/delegation-lifecycle-store.js";
import { createBudgetHarness } from "../../core/test/support/delegation-budget-fixture.mjs";
import {
  collectRunTerminalReportEvidence,
  collectTurnTerminalReportEvidence,
  collectWorkflowTerminalReportEvidence,
} from "../dist/features/channels/terminal-report-evidence.js";
import { buildTerminalReportPrompt } from "../dist/features/channels/terminal-report-prompt.js";
import { executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { observeCommandProcess } from "../dist/features/runs/unified-exec-process.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";

const capabilityNow = () => new Date().toISOString();

// The fixture uses real isolated SQLite, Host drain and lifecycle sealing. No
// Provider call or packaged-client completion is claimed by these tests.
async function fixture(t, { delegated = true, workflow = false } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-report-delegation-"))), at = capabilityNow();
  const f = createBudgetHarness(cwd, { now: at, later: at });
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = workflow ? f.store.createChannel({ name: "Report lineage", boundPath: f.cwd }, at) : undefined;
  const thread = f.store.createLingThread({ kind: channel ? "channel_discussion" : "conversation", channelId: channel?.id,
    title: "Dedicated lineage QA", objective: "Verify Host lineage" }, at);
  const turn = f.store.createLingTurn({ threadId: thread.id, kind: "initial_request", channelId: channel?.id,
    title: "Dedicated lineage QA", userInstruction: "Verify Host lineage", createdByActor: "local-user" }, at);
  const wf = workflow ? f.store.createChannelWorkflow({ channelId: channel.id, title: "Host lineage",
    objective: "Verify Host lineage", status: "succeeded", createdBy: "ling_agent" }, at) : undefined;
  const step = wf ? f.store.createChannelWorkflowStep({ workflowId: wf.id, title: "Parent step", prompt: "Verify Host lineage",
    toParticipantId: "engineer", toParticipantLabel: "Engineer", status: "succeeded" }, at) : undefined;
  // Seed the accepted parent before budget freezing or child allocation.
  f.db.prepare("UPDATE run_sessions SET thread_id=?,channel_id=?,workflow_step_id=? WHERE id='root'")
    .run(thread.id, channel?.id ?? null, step?.id ?? null);
  if (step) f.store.updateChannelWorkflowStep(step.id, { runId: "root" }, at);
  f.store.linkRunToLingTurn({ runId: "root", turnId: turn.id, role: "primary", now: at });
  const authority = { ...f.authority, ...(wf ? { channelId: channel.id, workflowId: wf.id, workflowStepId: step.id } : {}) };
  f.setCurrentAuthority(authority);
  const capture = { ...f.capture, authority }, captureToken = f.captureToken(capture);
  f.freeze({ capture: captureToken }); f.start();
  const observations = new WeakMap(), preparations = new WeakMap();
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.db }, {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id), getDelegationStep: id => f.store.getDelegationStep(id),
    getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: input => f.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input), transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => f.store.updateWorkUnitAttemptStatus(input), appendRuntimeEvent: input => f.store.appendRuntimeEvent(input),
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source), appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(observations.has(token)); return observations.get(token); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return structuredClone(preparations.get(token)); },
  });
  const child = delegated ? f.spawn({ capture: captureToken, now: capabilityNow() }) : undefined;
  let current = { run: f.store.getRun("root"), workUnit: f.unit, attempt: f.attempt };
  if (child) {
    const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
      runtimeInstanceId: "runtime", now: capabilityNow() });
    const sourceFence = toRuntimeAttemptFence(claimed.attempt), preparation = {}, observation = {};
    preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: claimed.step.id,
      reservationId: claimed.reservation.id, rootRunId: claimed.step.rootRunId, parentRunId: claimed.step.parentRunId,
      childRunId: claimed.run.id, sourceFence, runnerId: "pi", preparedAt: capabilityNow(),
      requestSnapshot: { cwd, task: claimed.run.taskSnapshot, parentRunId: claimed.step.parentRunId,
        teammateId: claimed.run.teammateId, workflowStepId: claimed.run.workflowStepId, threadId: claimed.run.threadId,
        providerPresetId: claimed.run.providerPresetId, runnerId: "pi" },
      runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd, task: claimed.run.taskSnapshot,
        provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } },
        preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
      effectivePolicySnapshot: resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
        authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot });
    lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence, preparation, now: capabilityNow() });
    observations.set(observation, { childRunId: claimed.run.id, sourceFence, runnerId: "pi",
      observationId: `accepted:${sourceFence.attemptId}`, observedAt: capabilityNow() });
    current = lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence, observation, now: capabilityNow() });
  }
  const fence = toRuntimeAttemptFence(current.attempt), source = { runId: current.run.id, ...fence };
  f.db.prepare("UPDATE ling_turns SET status='succeeded',completed_at=?,active_run_id=NULL WHERE id=?").run(at, turn.id);
  const completeRoot = () => f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=?,updated_at=? WHERE id='root'")
    .run(capabilityNow(), capabilityNow());
  return { ...f, capture, child, lifecycle, run: current.run, unit: current.workUnit, attempt: current.attempt,
    fence, source, thread, turn, workflow: wf, step, completeRoot };
}

async function sealChild(f, trackedToolCallIds) {
  const capture = f.captureToken({ ...f.capture, runId: f.run.id, sourceFence: f.fence, budget: undefined });
  const charge = f.writer.reserveModelInvocation({ runId: f.run.id, sourceFence: f.fence, invocationId: "report-charge",
    reservedTokens: 20, capture, now: capabilityNow() });
  f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: capabilityNow() });
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => trackedToolCallIds ?? true);
  assert.equal(f.store.getHostAttemptCompletion(f.source)?.effectCoverage,
    trackedToolCallIds ? "pi_tracked_tools_v1" : "pi_no_tools_v1");
  const at = capabilityNow();
  assert.equal(f.store.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: f.fence, expectedStatus: "running",
    event: "runner_succeeded", actor: "runner", now: at, endedAt: at }).ok, true);
  assert.equal(f.store.transitionWorkUnitAttemptTerminal({ ...f.fence, event: "runner_succeeded", attemptStatus: "succeeded",
    runtimeEventType: "work_unit_succeeded", actor: "runner", now: at }), true);
  f.writer.settleDelegatedChild({ reservationId: f.child.reservation.id,
    receipt: f.childReceipt({ kind: "verified_usage", childRunId: f.run.id, sourceFence: f.fence }), now: at });
  f.lifecycle.commitDelegatedChildTerminal({ reservationId: f.child.reservation.id, sourceFence: f.fence, now: capabilityNow() });
  f.completeRoot();
  return charge;
}

async function executeChildFile(f, input) {
  const toolCallId = "child-write", toolName = "write", tracker = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  const operation = tracker.beginHostCall("file_mutation", toolCallId);
  const request = { toolCallId, toolName, cwd: f.cwd, task: f.run.taskSnapshot, input };
  const common = { mode: "enforce", store: f.store, run: f.run, sourceFence: f.fence, request,
    effectivePolicySnapshot: resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
      authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot,
    appendAndMaybeStream: (type, data) => f.store.appendExecutionEvent(f.run.id, f.fence, type, data) };
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId, toolName, args: input });
  const result = await executeHarnessedFileMutationTool({ ...common, allowedWritePaths: [f.cwd],
      draft: createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] }),
      hostOperation: tracker.fileMutationOperation(operation) });
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_end", { toolCallId, toolName, isError: result.isError === true, result });
  assert.equal(tracker.settleFileFromStore(operation).phase, "safe");
  return { result, toolCallId, operation };
}

/** Actual journaled process/observer facts; not a model result or an approval-flow fixture. */
async function executeChildCommand(f, command) {
  const toolCallId = "child-command", tracker = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  const operation = tracker.beginHostCall("command", toolCallId), host = tracker.commandOperation(operation);
  const startedAt = capabilityNow(), startedMs = Date.now();
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId, toolName: "bash", args: { command } });
  const ticket = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId, cwd: f.cwd,
    command: { kind: "shell", command, shell: "bash" } });
  host.bindCommandExecution(ticket.executionId);
  const child = host.launch(ticket, () => spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: f.cwd,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8" },
    detached: process.platform !== "win32", stdio: "pipe" }));
  let stdout = "", stderr = "";
  const observed = await observeCommandProcess({ child, timeoutMs: 5000,
    onOutput(stream, bytes) { if (stream === "stdout") stdout += bytes.toString("utf8"); else stderr += bytes.toString("utf8"); } });
  const settled = f.store.settleHostCommandExecution(ticket, { kind: "observed", observation: observed.observation });
  assert.equal(settled.data.outcome, "completed");
  assert.equal(observed.error, undefined);
  host.markUnknown("command_physical_scope_unverified");
  const stream = value => ({ byteCount: Buffer.byteLength(value), lineCount: value ? value.trimEnd().split("\n").length : 0,
    preview: value, truncated: false });
  const result = { isError: observed.exitCode !== 0, content: [{ type: "text", text: stdout || stderr }],
    details: { unifiedExec: { status: observed.exitCode === 0 ? "succeeded" : "failed", toolCallId,
      command: { kind: "shell", command, shell: "bash" }, cwd: f.cwd, startedAt, endedAt: capabilityNow(),
      durationMs: Date.now() - startedMs, exitCode: observed.exitCode, timedOut: false, cancelled: false,
      processObservation: observed.observation, stdout: stream(stdout), stderr: stream(stderr), artifacts: [] } } };
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_end", { toolCallId, toolName: "bash", isError: result.isError, result });
  return { result, toolCallId, operation };
}

for (const source of ["run", "turn", "workflow"]) test(`${source} report includes sealed child lineage and measured budget without private payloads`, async t => {
  const f = await fixture(t, { workflow: source === "workflow" });
  const charge = await sealChild(f);
  const collect = () => source === "run" ? collectRunTerminalReportEvidence(f.store, "root")
    : source === "turn" ? collectTurnTerminalReportEvidence(f.store, f.turn.id)
      : collectWorkflowTerminalReportEvidence(f.store, f.workflow.id);
  const basis = f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] });
  assert.equal(basis.status, "satisfied", JSON.stringify(basis.issues));
  const snapshot = collect();
  assert.equal(snapshot.delegationCompletionFingerprint, basis.fingerprint);
  assert.equal(snapshot.evidenceFingerprint, collect().evidenceFingerprint, "collection time does not change evidence");
  const step = snapshot.steps.find(row => row.id === `delegation-step:${f.child.stepId}`);
  assert.equal(step.status, "succeeded");
  assert.equal(step.runId, f.run.id);
  const expected = [
    ["delegation_step", f.child.stepId], ["delegation_budget_reservation", f.child.reservation.id],
    ["run", f.run.id], ["runtime_attempt", f.attempt.id], ["host_attempt_completion", f.attempt.id],
    ["delegation_budget_charge", charge.id], ["delegation_result", basis.steps[0].results[0].message.id],
  ];
  for (const [kind, id] of expected) {
    assert.ok(step.sourceRefs.some(ref => ref.kind === kind && ref.id === id), `${kind}:${id}`);
    assert.ok(snapshot.references.some(ref => ref.kind === kind && ref.id === id));
    assert.ok(snapshot.participants.some(row => row.runIds.includes(f.run.id)
      && row.sourceRefs.some(ref => ref.kind === kind && ref.id === id)));
  }
  assert.ok(snapshot.references.some(ref => ref.kind === "artifact" && ref.id === basis.steps[0].results[0].artifactId
    && ref.visibility === "developer_only"));
  assert.equal(snapshot.artifacts.some(row => row.path.startsWith("sqlite:delegation-")), false);
  const report = buildDeterministicTerminalReport(snapshot);
  assert.equal(validateTerminalReport(report, snapshot).ok, true);
  assert.ok(report.participants.some(row => row.sourceRefs.some(ref => ref.kind === "delegation_step" && ref.id === f.child.stepId)),
    "the final visible report preserves the child's lineage");
  const prompt = buildTerminalReportPrompt(snapshot);
  assert.ok(prompt.allowedSourceRefKeys.includes(`delegation_step:${f.child.stepId}`));
  assert.equal(prompt.allowedSourceRefKeys.includes(`artifact:${basis.steps[0].results[0].artifactId}`), false);
  assert.match(prompt.prompt, /Host verified the delegated result/);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /authority-set|permission_snapshot|workspace_scope|env:QA_KEY|provider\.invalid|Create a small fixture/);
  const resultArtifact = f.store.getArtifact(basis.steps[0].results[0].artifactId);
  f.db.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run(JSON.stringify({ ...resultArtifact.sealedPayload, childRunId: "foreign-child" }), resultArtifact.id);
  const changed = collect();
  assert.notEqual(changed.evidenceFingerprint, snapshot.evidenceFingerprint);
  assert.notEqual(changed.delegationCompletionFingerprint, snapshot.delegationCompletionFingerprint);
  assert.equal(changed.terminalState, "blocked");
  assert.notEqual(changed.steps.find(row => row.id === step.id).status, "succeeded");
});

for (const source of ["run", "turn", "workflow"]) test(`${source} report preserves an actual child file mutation, deliverable and Host-safe completion`, async t => {
  const f = await fixture(t, { workflow: source === "workflow" });
  const { result, toolCallId, operation } = await executeChildFile(f, { path: "result.txt", content: "child-owned\n" });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "child-owned\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "succeeded");
  const hostOperation = f.store.getHostOperation(operation.operationId);
  assert.equal(hostOperation.settlementKind, "file_completed");
  assert.deepEqual(hostOperation.evidenceRef, { kind: "harness_tool_execution", id: execution.id });
  // Register only the physically verified workspace file as a deliverable;
  // Broker policies, patch plans and the sealed child result remain private.
  const artifact = f.store.createArtifact({ runId: f.run.id, type: "file", path: "result.txt",
    title: "Child result", contentType: "text/plain", createdAt: capabilityNow() });
  f.store.appendExecutionEvent(f.run.id, f.fence, "artifact_created", { toolCallId, artifactId: artifact.id });
  await sealChild(f, [toolCallId]);
  const snapshot = source === "run" ? collectRunTerminalReportEvidence(f.store, "root")
    : source === "turn" ? collectTurnTerminalReportEvidence(f.store, f.turn.id)
      : collectWorkflowTerminalReportEvidence(f.store, f.workflow.id);
  assert.equal(snapshot.terminalState, "succeeded");
  const childOperation = snapshot.operations.find(row => row.runId === f.run.id && row.kind === "edit");
  assert.equal(childOperation?.status, "succeeded");
  assert.deepEqual(childOperation.changedPaths, ["result.txt"]);
  const step = snapshot.steps.find(row => row.id === `delegation-step:${f.child.stepId}`);
  assert.deepEqual(step.changedPaths, ["result.txt"]);
  assert.deepEqual(step.artifactIds, [artifact.id]);
  assert.ok(step.sourceRefs.some(ref => ref.kind === "operation" && ref.id === childOperation.id));
  assert.ok(snapshot.artifacts.some(row => row.id === artifact.id && row.path === "result.txt"));
  assert.ok(snapshot.participants.some(row => row.runIds.includes(f.run.id)
    && row.contributionSummaries.some(summary => /Changed files/.test(summary))
    && row.sourceRefs.some(ref => ref.kind === "operation" && ref.id === childOperation.id)));
  assert.equal(snapshot.artifacts.some(row => /(?:\.ling-stack|harness|delegations)\//.test(row.path)
    || row.path.startsWith("sqlite:delegation-")), false);
  const report = buildDeterministicTerminalReport(snapshot);
  assert.equal(validateTerminalReport(report, snapshot).ok, true);
  assert.ok(report.changes.some(row => row.paths.includes("result.txt")));
});

for (const surface of ["run", "turn", "workflow"]) test(`${surface}: an actual child command contributes operations/checks but cannot fabricate safe subtree completion`, async t => {
  const f = await fixture(t, { workflow: surface === "workflow" });
  const command = "node -e 'const assert = require(\"node:assert/strict\"); assert.equal(1, 1); console.log(\"child-verified\")'";
  const { result, toolCallId, operation } = await executeChildCommand(f, command);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.details.unifiedExec.exitCode, 0);
  assert.match(result.details.unifiedExec.stdout.preview, /child-verified/);
  assert.equal(result.details.unifiedExec.processObservation.descendants, "unverified");
  assert.equal(f.store.getHostOperation(operation.operationId).phase, "unknown_outcome");
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => [toolCallId]);
  assert.equal(f.store.getHostAttemptCompletion(f.source)?.effectCoverage, undefined,
    "leader and pipe close are not Host proof that all command effects drained");
  f.completeRoot();
  const snapshot = surface === "run" ? collectRunTerminalReportEvidence(f.store, "root")
    : surface === "turn" ? collectTurnTerminalReportEvidence(f.store, f.turn.id)
      : collectWorkflowTerminalReportEvidence(f.store, f.workflow.id);
  assert.equal(snapshot.terminalState, "blocked");
  assert.ok(snapshot.operations.some(row => row.runId === f.run.id && row.kind === "check" && row.status === "succeeded"));
  assert.ok(snapshot.checks.some(row => row.runId === f.run.id && row.command === command && row.status === "passed"));
  assert.ok(snapshot.risks.some(row => row.id === "delegation-completion-barrier"));
  assert.equal(snapshot.steps.find(row => row.id === `delegation-step:${f.child.stepId}`).status, "blocked");
  assert.equal(snapshot.participants.find(row => row.runIds.includes(f.run.id)).status, "blocked");
  assert.equal(snapshot.artifacts.filter(row => row.sourceRefs.some(ref => ref.kind === "artifact" && ref.visibility !== "developer_only")).length, 0,
    "internal stdout/result artifacts are not workspace deliverables");
  const validation = validateTerminalReport(buildDeterministicTerminalReport(snapshot), snapshot);
  assert.deepEqual(validation, { ok: true, issues: [] });
});

for (const malformed of [false, true]) test(`report refuses premature source success with ${malformed ? "invalid" : "pending"} child evidence`, async t => {
  const f = await fixture(t);
  f.completeRoot();
  if (malformed) f.db.prepare("UPDATE delegation_steps SET state='succeeded',revision=revision+1,completed_at=? WHERE id=?")
    .run(capabilityNow(), f.child.stepId);
  const snapshot = collectRunTerminalReportEvidence(f.store, "root");
  assert.equal(snapshot.terminalState, "blocked");
  assert.equal(snapshot.steps.find(row => row.id === `delegation-step:${f.child.stepId}`).status, "blocked");
  assert.ok(snapshot.risks.some(row => row.id === "delegation-completion-barrier"));
  assert.ok(snapshot.participants.filter(row => row.runIds.includes(f.run.id)).every(row => row.status !== "completed"));
});

test("cross-thread child content and atomic foreign Run references are withheld", async t => {
  const f = await fixture(t);
  await sealChild(f);
  const foreign = f.store.createLingThread({ kind: "conversation", title: "Private foreign thread", objective: "Private foreign objective" }, capabilityNow());
  f.db.prepare("UPDATE run_sessions SET thread_id=? WHERE id=?").run(foreign.id, f.run.id);
  const snapshot = collectRunTerminalReportEvidence(f.store, "root");
  assert.equal(snapshot.terminalState, "blocked");
  assert.ok(snapshot.risks.some(row => row.id === `delegation-scope:${f.child.stepId}`));
  assert.equal(snapshot.steps.some(row => row.runId === f.run.id), false);
  assert.equal(snapshot.references.some(ref => ref.kind === "run" && ref.id === f.run.id), false);
  assert.equal(snapshot.participants.some(row => row.runIds.includes(f.run.id)), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /Private foreign thread/);
});

test("no dynamic children preserve the static fingerprint shape", async t => {
  const f = await fixture(t, { delegated: false });
  f.completeRoot();
  const snapshot = collectRunTerminalReportEvidence(f.store, "root");
  assert.equal(Object.hasOwn(snapshot, "delegationCompletionFingerprint"), false);
  assert.equal(snapshot.steps.some(row => row.id.startsWith("delegation-step:")), false);
  assert.equal(snapshot.references.some(ref => ref.kind.startsWith("delegation_")), false);
  const { delegationCompletionFingerprint: omitted, ...staticSnapshot } = snapshot;
  assert.equal(computeTerminalReportEvidenceFingerprint(staticSnapshot), snapshot.evidenceFingerprint);
});

test("a retry Turn's dynamic scope follows the effective Run instead of superseded descendants", async t => {
  const f = await fixture(t);
  f.completeRoot();
  const retry = f.store.createRun({ id: "retry-root", cwd: f.cwd, taskId: f.root.taskId, threadId: f.thread.id, turnId: f.turn.id,
    turnRunRole: "retry", parentRunId: "root", providerName: "fixture", providerModel: "fixture-model", taskSnapshot: {},
    providerSnapshot: {}, requestSnapshot: {}, createdAt: capabilityNow() });
  f.store.markRunSucceeded(retry.id, capabilityNow());
  const snapshot = collectTurnTerminalReportEvidence(f.store, f.turn.id);
  assert.equal(Object.hasOwn(snapshot, "delegationCompletionFingerprint"), false);
  assert.equal(snapshot.steps.some(row => row.id === `delegation-step:${f.child.stepId}`), false);
  assert.equal(snapshot.risks.some(row => row.id === "delegation-completion-barrier"), false);
});
