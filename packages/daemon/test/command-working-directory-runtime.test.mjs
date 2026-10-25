import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, digestHarnessToolValue } from "@ling-stack/core";
import { bindWorkflowCommandRequest, WorkflowCommandBindingError } from "../dist/features/runs/workflow-command-cwd.js";
import { workflowOperationEffectRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";
import { captureRestrictedCommandDirectory } from "../dist/runtime/sandbox/restricted-command-directory.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { createApprovalCommandRuleProposal, isApprovalCommandRuleProposalCurrent, findMatchingApprovalCommandRulesForCommand } from "../dist/features/runs/approval-command-rules.js";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";
import { executeHarnessedBashTool } from "../dist/features/harness/tool-execution/broker.js";
import { verifyWorkflowStepExecutionOperations } from "../dist/features/channels/workflow-operation-evidence.js";
import { createTypedWorkflowBasis, typedOperation, gateOwner } from "./support/workflow-operation-gate-fixture.mjs";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";
import { createLingStackBashToolExtension } from "../../runner-pi/dist/extensions/bash.js";
import { normalizeBashRequest } from "../dist/features/runs/unified-exec-request.js";

const directory = { path: "project", sourceRefs: [{ itemId: "source", quote: "在目录 project 中运行", actorType: "local_user" }] };

test("ordinary and teammate requests bind one effective cwd before approval and execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-ordinary-command-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSqliteRunStore(root);
  t.after(() => store.close());
  const now = new Date().toISOString();
  const teammate = store.createAiTeammate({ roleKey: "engineer", displayName: "Cwd fixture",
    description: "Temporary directory contract", allowedTools: ["bash"], approvalProfile: { mode: "none" } }, now);
  for (const teammateId of [undefined, teammate.id]) {
    const id = teammateId ? "private-cwd" : "ordinary-cwd";
    store.createRun({ id, cwd: root, taskId: id, teammateId, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: { id, title: id }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    const run = store.getRun(id);
    for (const inputCwd of [undefined, "project", join(root, "project")]) {
      const request = { toolName: "bash", toolCallId: id, cwd: root, task: run.taskSnapshot,
        input: { command: "printf cwd", ...(inputCwd === undefined ? {} : { cwd: inputCwd }) } };
      const bound = bindWorkflowCommandRequest(store, run, request);
      const expected = inputCwd === undefined ? root : join(root, "project");
      assert.equal(bound.cwd, expected);
      assert.equal(normalizeBashRequest(run, bound).request.cwd, expected);
      assert.deepEqual(bound.input, request.input);
      assert.equal(store.getRun(id).cwd, root);
      assert.equal(bindWorkflowCommandRequest(store, run, bound).cwd, expected, "rebinding is idempotent");
    }
    for (const cwd of ["../outside", tmpdir(), "", "  ", 7, null]) {
      const request = { toolName: "bash", toolCallId: id, cwd: root, task: run.taskSnapshot,
        input: { command: "printf cwd", cwd } };
      assert.throws(() => bindWorkflowCommandRequest(store, run, request), /command_cwd_invalid/);
      assert.ok("error" in normalizeBashRequest(run, request), "direct launch normalization cannot accept invalid cwd either");
    }
  }
});

test("model-visible bash cwd reaches the immutable Host binding without moving the Run workspace", async t => {
  const command = "node cli.js ../records.csv";
  const f = await createRestrictedCommandFixture(t, command, [], undefined, directory);
  const registered = [], requests = [];
  createLingStackBashToolExtension({ cwd: f.cwd, task: f.request.task,
    provider: { provider: "fixture", model: "fixture" },
    async onApprovalRequired(request) {
      const bound = bindWorkflowCommandRequest(f.store, f.run, request);
      requests.push(bound);
      return { approved: true, handledResult: { content: [{ type: "text", text: "binding-only probe; no process dispatched" }] } };
    },
  })({ on() {}, registerTool: tool => registered.push(tool) });
  assert.equal(registered[0].parameters.properties.cwd?.type, "string");
  for (const cwd of [undefined, "project", join(f.cwd, "project")]) {
    const params = { command, ...(cwd === undefined ? {} : { cwd }) };
    await registered[0].execute(`cwd-${requests.length}`, params);
    assert.equal(requests.at(-1).cwd, join(f.cwd, "project"));
    assert.deepEqual(requests.at(-1).input, params);
    assert.equal(f.store.getRun(f.run.id).cwd, f.cwd);
  }
  for (const cwd of [f.cwd, "other", "../escape", 7, null]) {
    await assert.rejects(registered[0].execute("foreign-cwd", { command, cwd }), /operation_binding_cwd_mismatch/);
  }
  assert.equal(requests.length, 3, "foreign/malformed cwd never reaches the accepted Host callback");
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0, "this probe never launches or fabricates an execution");
});

test("command binding preserves a machine code and explanatory reason at both rejection boundaries", async t => {
  const f = await createRestrictedCommandFixture(t, "node cli.js ../records.csv", [], undefined, directory);
  // Identity-only runtime: a binding rejection must happen before resolving any
  // binary, and this configuration cannot admit or execute a command.
  const runtime = new NativeRestrictedCommandRuntime({
    inputHelper: { path: "/not-executed", sha256: "0".repeat(64), version: "binding-rejection-test" }, executables: {},
  });
  for (const [request, code, reason] of [
    [{ ...f.request, input: { command: "node other.js" } }, "operation_binding_command_out_of_scope",
      "No unique owned operation authorizes this exact command."],
    [{ ...f.request, cwd: tmpdir() }, "operation_binding_cwd_mismatch",
      "Command execution cwd differs from the immutable operation directory."],
  ]) {
    assert.throws(() => bindWorkflowCommandRequest(f.store, f.run, request), error =>
      error instanceof WorkflowCommandBindingError && error.code === code && error.reason === reason
      && error.message === `${code}: ${reason}`);
    const rejection = workflowOperationEffectRejection({ store: f.store, run: f.run, request,
      restrictedCommandRuntime: runtime });
    assert.equal(rejection.code, code);
    assert.equal(rejection.reason, reason);
  }
});

test("Host binds session cwd to the frozen directory without changing Run or raw command", async t => {
  const f = await createRestrictedCommandFixture(t, "node cli.js ../records.csv", [], undefined, directory);
  const request = bindWorkflowCommandRequest(f.store, f.run, f.request);
  assert.equal(request.cwd, join(f.cwd, "project"));
  assert.deepEqual(request.input, f.request.input);
  assert.equal(f.run.cwd, f.cwd);
  assert.equal(f.request.cwd, f.cwd);
  for (const input of [{ ...f.request, cwd: tmpdir() },
    { ...f.request, input: { ...f.request.input, cwd: "elsewhere" } },
    { ...f.request, input: { ...f.request.input, cwd: f.cwd } }]) {
    assert.throws(() => bindWorkflowCommandRequest(f.store, f.run, input), /operation_binding_cwd_mismatch/);
  }
  const consistent = { ...f.request, input: { ...f.request.input, cwd: "project" } };
  assert.equal(bindWorkflowCommandRequest(f.store, f.run, consistent).cwd, request.cwd);
  const restored = createSqliteRunStore(f.cwd);
  try {
    assert.equal(bindWorkflowCommandRequest(restored, restored.getRun(f.run.id), f.request).cwd, request.cwd,
      "a separate SQLite reader resolves only the durable frozen operation");
  } finally { restored.close(); }
});

test("directory identity checks reject replacement and symlinks, including internal aliases", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-directory-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const captured = captureRestrictedCommandDirectory(root, directory);
  captured.assertCurrent();
  await rename(join(root, "project"), join(root, "old-project"));
  await mkdir(join(root, "project"));
  assert.throws(() => captured.assertCurrent(), /restricted_command_directory_changed/);
  await rm(join(root, "project"), { recursive: true });
  await symlink("old-project", join(root, "project"));
  assert.throws(() => captureRestrictedCommandDirectory(root, directory), /restricted_command_directory_invalid/);
  for (const path of ["../escape", "project/..", "/tmp", "project/./child"]) {
    assert.throws(() => captureRestrictedCommandDirectory(root, { ...directory, path }), /restricted_command_directory_invalid/);
  }
});

test("similar-command fingerprints and matching distinguish working directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-command-rules-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSqliteRunStore(root);
  t.after(() => store.close());
  const now = new Date().toISOString();
  const runId = "run_cwd_rules", taskId = "task_cwd_rules";
  store.createRun({ id: runId, cwd: root, taskId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: { id: taskId, title: "Directory-bound command rules" },
    providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: { cwd: root }, createdAt: now });
  const make = cwd => createApprovalCommandRuleProposal({ command: "node --test cli.test.js", requestedPrefix: ["node", "--test"],
    cwd, risk: "medium", riskFlags: [] });
  const first = make(join(root, "one")), second = make(join(root, "two"));
  assert.notEqual(first.fingerprint, second.fingerprint);
  for (const proposal of [first, second]) {
    const approval = store.createApprovalRequest({ runId, taskId, actionType: "bash", risk: "medium", title: "Isolated rule", description: "Test only",
      payload: { type: "bash", cwd: proposal.cwd, command: "node --test cli.test.js", riskFlags: [] },
      availableDecisions: ["approve_once", "approve_command_rule", "deny"], proposedCommandRule: proposal }, new Date().toISOString());
    assert.equal(isApprovalCommandRuleProposalCurrent(approval), true);
    assert.equal(isApprovalCommandRuleProposalCurrent({ ...approval, payload: { ...approval.payload, cwd: root } }), false);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_command_rule", proposedRuleFingerprint: proposal.fingerprint }, new Date().toISOString());
  }
  assert.equal(store.listApprovalCommandRules().length, 2);
  for (const cwd of [first.cwd, second.cwd]) {
    const rules = findMatchingApprovalCommandRulesForCommand(store, "node --test other.test.js", cwd);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].cwd, resolve(cwd));
  }
  assert.equal(findMatchingApprovalCommandRulesForCommand(store, "node --test other.test.js", root), undefined);
  assert.equal(store.findMatchingApprovalCommandRule("bash", ["node", "--test"], join(root, "third")), undefined);
  const reopened = createSqliteRunStore(root);
  try { assert.equal(findMatchingApprovalCommandRulesForCommand(reopened, "node --test", first.cwd)?.[0].cwd, first.cwd); }
  finally { reopened.close(); }
});

test("Broker identity uses the Host-selected cwd before preparing any execution", async t => {
  const f = await createRestrictedCommandFixture(t, "node cli.js ../records.csv", [], undefined, directory);
  const execute = request => executeHarnessedBashTool({ mode: "enforce", store: f.store, run: f.run,
    sourceFence: f.sourceFence, request, effectivePolicySnapshot: f.run.requestSnapshot.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data) });
  const result = await execute(f.request);
  assert.equal(result.isError, true, "no real native runtime was supplied to this identity-only fixture");
  assert.match(result.content[0].text, /operation_binding_isolation_unavailable/);
  const rows = f.store.listHarnessToolExecutions(f.run.id);
  assert.equal(rows.length, 1);
  const identity = cwd => digestHarnessToolValue({ schemaVersion: 1, toolName: f.request.toolName,
    toolCallId: f.request.toolCallId, input: f.request.input, cwd });
  assert.equal(rows[0].requestDigest, identity(join(f.cwd, "project")));
  assert.notEqual(rows[0].requestDigest, identity(f.cwd));
  const denied = await execute({ ...f.request, toolCallId: "foreign-cwd",
    input: { ...f.request.input, cwd: "different" } });
  assert.match(denied.content[0].text, /operation_binding_cwd_mismatch/);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 1);
  assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "host_command_prepared").length, 0);
});

test("fan-in accepts command evidence only from the operation's frozen directory", async t => {
  for (const location of [undefined, "root", "foreign", "bound"]) {
    const f = await createRestrictedCommandFixture(t, "node cli.js ../records.csv", [], undefined, directory);
    const cwd = location === "root" ? f.cwd : location === "foreign" ? join(f.cwd, "other")
      : location === "bound" ? join(f.cwd, "project") : undefined;
    const now = new Date().toISOString();
    const stream = { byteCount: 0, lineCount: 0, preview: "", truncated: false };
    f.store.appendEvent(f.run.id, "tool_start", { toolCallId: f.request.toolCallId, toolName: "bash", args: f.request.input });
    f.store.appendEvent(f.run.id, "tool_end", { toolCallId: f.request.toolCallId, toolName: "bash", isError: false,
      result: { details: { unifiedExec: { status: "succeeded", command: { kind: "shell", command: f.request.input.command, shell: "bash" },
        ...(cwd === undefined ? {} : { cwd }), startedAt: now, endedAt: now, durationMs: 0,
        exitCode: 0, timedOut: false, cancelled: false, stdout: stream, stderr: stream, artifacts: [] } } } });
    const verified = verifyWorkflowStepExecutionOperations({ store: f.store,
      step: f.store.getChannelWorkflowStep(f.basis.step.id), now: new Date().toISOString() });
    assert.equal(verified.status, location === "bound" ? "verified" : "blocked", JSON.stringify({ location, verified }));
    if (location !== "bound") assert.equal(verified.operationResults[0].reasonCode, "required_operation_missing_evidence");
  }
});

test("a typed command without explicit cwd still requires evidence from its frozen Run root", async t => {
  for (const location of ["foreign", "missing", "bound"]) {
    const f = await createRestrictedCommandFixture(t, "node cli.js");
    const cwd = location === "bound" ? f.cwd : location === "foreign" ? join(f.cwd, "project") : undefined;
    const now = new Date().toISOString(), stream = { byteCount: 0, lineCount: 0, preview: "", truncated: false };
    f.store.appendEvent(f.run.id, "tool_start", { toolCallId: f.request.toolCallId, toolName: "bash", args: f.request.input });
    f.store.appendEvent(f.run.id, "tool_end", { toolCallId: f.request.toolCallId, toolName: "bash", isError: false,
      result: { details: { unifiedExec: { status: "succeeded", command: { kind: "shell", command: f.request.input.command, shell: "bash" },
        ...(cwd === undefined ? {} : { cwd }), startedAt: now, endedAt: now, durationMs: 0,
        exitCode: 0, timedOut: false, cancelled: false, stdout: stream, stderr: stream, artifacts: [] } } } });
    const verified = verifyWorkflowStepExecutionOperations({ store: f.store,
      step: f.store.getChannelWorkflowStep(f.basis.step.id), now });
    assert.equal(verified.status, location === "bound" ? "verified" : "blocked", JSON.stringify({ location, verified }));
  }
});

test("dependency command evidence is bound to its own Run root, not the consuming Run", async t => {
  for (const location of ["producer", "consumer"]) {
    const root = await mkdtemp(join(tmpdir(), "ling-dependency-cwd-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = createSqliteRunStore(root);
    t.after(() => store.close());
    const now = "2026-10-25T06:00:00.000Z";
    const operations = [typedOperation("run_command", "node produce.js", "produce"),
      typedOperation("run_command", "node consume.js", "consume", ["produce"])];
    const basis = createTypedWorkflowBasis(store, root, operations, now);
    const produceStep = store.createChannelWorkflowStep({ workflowId: basis.workflow.id, title: "Producer",
      prompt: "Produce", toParticipantId: gateOwner, toParticipantLabel: "Engineer", status: "running",
      metadata: { executionPlan: basis.snapshot.plan, executionOperationIds: ["produce"] } }, now);
    const consumeStep = store.updateChannelWorkflowStep(basis.step.id,
      { metadata: { ...basis.step.metadata, executionOperationIds: ["consume"] } }, now);
    const roots = { producer: join(root, "producer"), consumer: join(root, "consumer") };
    for (const [step, key, index] of [[produceStep, "producer", 0], [consumeStep, "consumer", 1]]) {
      const requirement = createDelegatedStepRequirement({ workflow: basis.workflow, step,
        participant: { expectedOutcome: "execution" }, manifestFingerprint: "cwd-dependency" });
      const current = store.updateChannelWorkflowStep(step.id,
        { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
      const task = store.createTask({ channelId: basis.channel.id, title: key, prompt: key,
        assigneeTeammateId: gateOwner }, now);
      const run = store.createRun({ id: `run_${key}`, cwd: roots[key], taskId: task.id, channelId: basis.channel.id,
        workflowStepId: step.id, teammateId: gateOwner, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {
          delegatedRequirement: requirement, workflowOperationExecution: createWorkflowOperationExecutionSnapshot(current) }, createdAt: now });
      store.markRunStarted(run.id, now);
      store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, now);
      const command = operations[index].commandMatchPolicy.command;
      const endedAt = `2026-10-25T06:00:0${index + 1}.000Z`;
      const stream = { byteCount: 0, lineCount: 0, preview: "", truncated: false };
      store.appendEvent(run.id, "tool_start", { toolCallId: key, toolName: "bash", args: { command } });
      store.appendEvent(run.id, "tool_end", { toolCallId: key, toolName: "bash", isError: false,
        result: { details: { unifiedExec: { status: "succeeded", command: { kind: "shell", command, shell: "bash" },
          cwd: index === 0 ? roots[location] : roots.consumer, startedAt: now, endedAt, durationMs: (index + 1) * 1000,
          exitCode: 0, timedOut: false, cancelled: false, stdout: stream, stderr: stream, artifacts: [] } } } });
    }
    const verified = verifyWorkflowStepExecutionOperations({ store,
      step: store.getChannelWorkflowStep(consumeStep.id), now });
    assert.equal(verified.status, location === "producer" ? "verified" : "blocked", JSON.stringify({ location, verified }));
  }
});
