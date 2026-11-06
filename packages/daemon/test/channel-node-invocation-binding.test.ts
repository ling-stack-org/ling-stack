import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bindChannelOperationPlan, type ChannelOperationCandidatePlanV2, type ChannelOperationCandidateV2 } from "../dist/features/channels/channel-operation-bindings.js";
import { workflowExactCommandBindingRejection } from "../dist/features/runs/approvals.js";
import { channelOperationPlanFingerprintV1, isChannelIntentExecutionPlanV1, nodeFunctionGoalCommand, parseNodeFunctionInvocation,
  type ChannelIntentExecutionOperationV1, type ChannelIntentExecutionPlanV1, type UnifiedExecResult } from "@ling-stack/contracts";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { captureNodeGoalCommandDiagnostic, type NodeGoalCommandDiagnostic } from "./support/node-goal-command-diagnostic.ts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";
import { verifyWorkflowStepExecutionOperations } from "../dist/features/channels/workflow-operation-evidence.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { isRecord } from "../dist/shared/validation.js";

type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };

const body = '创建 continuity-v2-proof.js，内容是导出 formatProof，然后运行 Node 调用 formatProof("7319") 验证。';
const owner = { kind: "host_default" } as const;
function candidate() {
  return { schemaVersion: 2, operations: [
    { id: "create_file", kind: "file_create", targetKind: "file", required: true, dependsOn: [], owner,
      sourceQuote: "创建 continuity-v2-proof.js，内容是导出 formatProof",
      target: { path: "continuity-v2-proof.js", sourceQuote: "continuity-v2-proof.js" },
      contentSource: { kind: "generated_objective", text: "导出 formatProof", sourceQuote: "导出 formatProof", inputOperationIds: [] } },
    { id: "run_command", kind: "run_command", targetKind: "command", required: true, dependsOn: ["create_file"], owner,
      sourceQuote: '然后运行 Node 调用 formatProof("7319") 验证。',
      commandGoal: { kind: "node_function", module: { path: "continuity-v2-proof.js", sourceQuote: "continuity-v2-proof.js" },
        invocation: 'formatProof("7319")', sourceQuote: 'formatProof("7319")' } },
  ] } satisfies Omit<ChannelOperationCandidatePlanV2, "operations"> & {
    operations: [ChannelOperationCandidateV2, ChannelOperationCandidateV2];
  };
}
async function fixture(t: TestContext) {
  const cwd = await mkdtemp("/private/tmp/ling-node-goal-binding-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bind = (plan = candidate(), sourceText = body) => bindChannelOperationPlan({ candidate: plan, sourceText,
    sourceItemId: "node-goal-user-item", workspaceCwd: cwd, defaultOwnerParticipantId: "engineer",
    participants: [{ id: "engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["read", "write", "bash"] }] });
  return { cwd, bind };
}

test("natural Node goal binds module, invocation and original source without inventing a user command", async t => {
  const { bind } = await fixture(t);
  const result = bind();
  assert.ok(result.status === "bound", JSON.stringify(result));
  assert.equal(isChannelIntentExecutionPlanV1(result.execution), true);
  const operation = result.execution.operations[1];
  assert.ok(operation.binding?.commandGoal);
  assert.equal(operation.binding.commandGoal.kind, "node_function");
  assert.equal(operation.binding.commandGoal.modulePath, "continuity-v2-proof.js");
  assert.equal(operation.binding.commandGoal.invocation, 'formatProof("7319")');
  assert.deepEqual(operation.binding.effectScope.readPaths, ["continuity-v2-proof.js"]);
  assert.deepEqual(operation.dependsOn, ["create_file"]);
  assert.ok(operation.binding.commandGoal.sourceRefs.every(ref => ref.itemId === "node-goal-user-item" && body.includes(ref.quote)));
  assert.ok(operation.commandMatchPolicy?.kind === "exact_command");
  const command = operation.commandMatchPolicy.command;
  assert.equal(body.includes(command), false, "the Host command must not masquerade as a user quote");
  assert.equal(workflowExactCommandBindingRejection({ bindings: [operation], request: { toolName: "bash", input: { command } } }), undefined);
  for (const substitute of [command.replace("7319", "7320"), command.replace("formatProof", "otherFunction"),
    command.replace("continuity-v2-proof.js", "other.js"), `node -e "console.log('proof:7319')"`]) {
    const rejection = workflowExactCommandBindingRejection({ bindings: [operation], request: { toolName: "bash", input: { command: substitute } } });
    assert.ok(rejection);
    assert.match(rejection, /rejected/);
  }
});

test("goal source, module dependency, invocation literals and exclusive command forms are verified", async t => {
  const { bind } = await fixture(t);
  const mutations: ((plan: ReturnType<typeof candidate>) => void)[] = [
    plan => { plan.operations[1].commandGoal.invocation = 'formatProof("9999")'; },
    plan => { plan.operations[1].commandGoal.module.path = "other.js"; },
    plan => { plan.operations[1].dependsOn = []; },
    plan => { Object.assign(plan.operations[1], { command: { text: "node --version", sourceQuote: "node --version" } }); },
    plan => { plan.operations[1].commandGoal.sourceQuote = "not in the user item"; },
    plan => { plan.operations[1].sourceQuote = 'formatProof("7319")'; },
  ];
  for (const mutate of mutations) {
    const plan = candidate(); mutate(plan);
    assert.equal(bind(plan).status, "clarify");
  }
  for (const invocation of ['formatProof(process.env.SECRET)', 'formatProof("7319");process.exit(0)', 'formatProof(1e999)']) {
    const plan = candidate(); plan.operations[1].sourceQuote = "运行 Node 调用 " + invocation;
    plan.operations[1].commandGoal.invocation = invocation; plan.operations[1].commandGoal.sourceQuote = invocation;
    const result = bind(plan, body + plan.operations[1].sourceQuote);
    assert.ok(result.status === "clarify", invocation);
    assert.deepEqual(result.missingFields, ["commandGoal.invocation"], "reject the expression itself, not unrelated provenance");
  }
});

test("invocation parser preserves JSON values and rejects expression or URL interpretation surprises", () => {
  const invocation = 'call("a",0,false,null,{"nested":[1,2]})';
  assert.deepEqual(parseNodeFunctionInvocation(invocation), { name: "call", args: ["a", 0, false, null, { nested: [1, 2] }] });
  assert.equal(parseNodeFunctionInvocation("call(Infinity)"), undefined);
  assert.equal(parseNodeFunctionInvocation("call(process.env.SECRET)"), undefined);
  assert.equal(parseNodeFunctionInvocation("call(1e999)"), undefined);
  assert.equal(parseNodeFunctionInvocation("call(...[])"), undefined);
  assert.equal(parseNodeFunctionInvocation("call() || evil()"), undefined);
  assert.equal(nodeFunctionGoalCommand({ modulePath: "bad\ud800.mjs", invocation: "call()" }), undefined);
  assert.equal(nodeFunctionGoalCommand({ modulePath: "../private.mjs", invocation: "call()" }), undefined);
});

// Actual finite-lived Host commands in a disposable workspace. This exercises
// invocation semantics and the real journal, not the still-blocked channel sandbox.
test("Host-generated Node commands really invoke ESM/CJS exports and retain failures as failures", async t => {
  const { cwd } = await fixture(t);
  const task = { id: "node_goal_task", title: "Node goal fixture", prompt: "Execute only temporary fixture functions" };
  const f = createUnifiedExecFixture(t, cwd, task, "node_goal_run");
  const run = f.run;
  assert.ok(run);
  let sequence = 0;
  const diagnostics: NodeGoalCommandDiagnostic[] = [];
  const execute = async (modulePath: string, invocation: string) => {
    const command = nodeFunctionGoalCommand({ modulePath, invocation }); assert.ok(command);
    const result = await captureNodeGoalCommandDiagnostic({ sequence: ++sequence, timeoutMs: 4000,
      record: diagnostic => diagnostics.push(diagnostic),
      execute: () => executeUnifiedBashTool({ ...f, run,
        request: { toolCallId: `node-goal-${sequence}`, toolName: "bash", cwd, task, input: { command, timeoutMs: 4000 } },
        appendAndMaybeStream: (type, data) => f.store.appendEvent(run.id, type, data) }) });
    assert.ok(isRecord(result.details) && isRecord(result.details.unifiedExec));
    const unifiedExec = result.details.unifiedExec as unknown as UnifiedExecResult;
    assert.ok(unifiedExec.command.kind === "shell");
    assert.equal(unifiedExec.command.command, command);
    assert.equal(unifiedExec.runId, run.id);
    return unifiedExec;
  };
  try {
    await writeFile(join(cwd, "proof.mjs"), 'export const formatProof = async value => "proof:" + value;');
    let result = await execute("proof.mjs", 'formatProof("7319")');
    assert.equal(result.status, "succeeded"); assert.equal(result.stdout.preview, "proof:7319\n");
    await writeFile(join(cwd, "proof.cjs"), 'module.exports = { formatProof: value => "common:" + value };');
    result = await execute("proof.cjs", 'formatProof("7319")');
    assert.equal(result.status, "succeeded"); assert.equal(result.stdout.preview, "common:7319\n");
    await writeFile(join(cwd, "quoted '# %.mjs"), "export const echo = value => value;");
    result = await execute("quoted '# %.mjs", `echo("'$(touch must-not-exist)")`);
    assert.equal(result.status, "succeeded"); assert.equal(result.stdout.preview, "'$(touch must-not-exist)\n");
    await assert.rejects(readFile(join(cwd, "must-not-exist")), { code: "ENOENT" });
    result = await execute("proof.mjs", "missing()");
    assert.equal(result.status, "failed"); assert.notEqual(result.exitCode, 0); assert.match(result.stderr.preview, /missing export/);
    await writeFile(join(cwd, "throwing.mjs"), 'export const formatProof = async () => { throw Error("fixture rejection"); };');
    result = await execute("throwing.mjs", 'formatProof("7319")');
    assert.equal(result.status, "failed"); assert.notEqual(result.exitCode, 0); assert.match(result.stderr.preview, /fixture rejection/);
    assert.deepEqual(f.store.listHostCommandWriteBlockers(cwd), []);
  } catch (error) {
    for (const diagnostic of diagnostics) t.diagnostic(JSON.stringify(diagnostic));
    throw error;
  }
});

test("recomputed plan fingerprints cannot detach generated commands from their accepted goal", async t => {
  const { bind } = await fixture(t);
  const result = bind(); assert.ok(result.status === "bound", JSON.stringify(result));
  const mutations: ((operation: Mutable<ChannelIntentExecutionOperationV1>) => void)[] = [
    operation => { assert.ok(operation.binding?.commandGoal); operation.binding.commandGoal.invocation = 'formatProof("9999")'; },
    operation => { assert.ok(operation.binding?.commandGoal); operation.binding.commandGoal.modulePath = "other.js"; },
    operation => {
      assert.ok(operation.commandMatchPolicy?.kind === "exact_command" && operation.binding);
      operation.commandMatchPolicy.command = "node --version"; operation.binding.effectScope.exactCommands = ["node --version"];
    },
  ];
  for (const mutate of mutations) {
    const plan = structuredClone(result.execution) as Mutable<ChannelIntentExecutionPlanV1>; mutate(plan.operations[1]);
    plan.fingerprint = channelOperationPlanFingerprintV1(plan.operations);
    assert.equal(isChannelIntentExecutionPlanV1(plan), false);
  }
});

// Typed execution evidence now uses the real macOS backend. Run the preserved
// native/sandbox/tests/node-goal-evidence-smoke.mjs with the built input helper.
