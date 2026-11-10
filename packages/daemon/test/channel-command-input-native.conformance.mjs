// Explicit macOS native integration. Uses current dist and a real signed QA
// bundle's helper/Electron resources; this is not new-package GUI acceptance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import { createSqliteRunStore, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { readPackagedRestrictedCommandConfig } from "../dist/runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { signalMacosSandboxProcessGroup } from "../dist/runtime/sandbox/macos-native-command.js";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { compileChannelCommandInputPolicyScope } from "../dist/features/channels/channel-command-input-policy.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot, validateWorkflowOperationRunContext } from "../dist/features/runs/workflow-operation-snapshot.js";
import { createRestrictedCommandDispatch } from "../dist/features/runs/restricted-command-dispatch.js";

assert.equal(process.platform, "darwin", "Run this explicit native conformance on macOS");
const ownFile = fileURLToPath(import.meta.url);
const app = resolve(dirname(ownFile), "../../../apps/desktop/release/human-qa-integrated-main/mac-arm64/Ling Stack Integrated Main QA.app");
const executable = join(app, "Contents/MacOS/Ling Stack Integrated Main QA");
const digest = value => createHash("sha256").update(value).digest("hex");
const participantId = "native-policy-qa", command = "node cli.js";
const body = "@Policy QA 运行 node cli.js，入口 cli.js。";
const selectedCase = process.env.LING_CHANNEL_INPUT_NATIVE_CASE;
let packagedConfig;

// Original actor launch histories are intentionally process-sticky. Reuse the
// existing protected-host test pattern: one bounded, fresh worker per scenario.
function nativeCase(name, effect) {
  if (selectedCase && selectedCase !== name) return;
  if (selectedCase) return nodeTest(name, { timeout: 58_000 }, effect);
  return nodeTest(name, { timeout: 65_000 }, t => {
    const env = { ...process.env, LING_CHANNEL_INPUT_NATIVE_CASE: name };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--import", resolve(dirname(ownFile), "support/a01-neighbor-isolation.mjs"),
      "--test", "--test-reporter=tap", ownFile], { env, encoding: "utf8", timeout: 60_000,
      killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    t.diagnostic(child.stdout ?? "");
    const diagnostics = `${name}\n${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    assert.equal(child.error, undefined, diagnostics);
    assert.equal(child.signal, null, diagnostics);
    assert.equal(child.status, 0, diagnostics);
    for (const line of ["tests 1", "pass 1", "fail 0", "cancelled 0", "skipped 0", "todo 0"]) {
      assert.match(child.stdout, new RegExp(`^# ${line}$`, "mu"), diagnostics);
    }
  });
}

function config() {
  // No verifyBundle override: the production bootstrap invokes real codesign
  // verification with its fixed 30-second deadline before deriving sealed pins.
  packagedConfig ??= readPackagedRestrictedCommandConfig({ executablePath: executable,
    environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" } });
  assert.ok(packagedConfig?.executables.node.runtime);
  return packagedConfig;
}

async function fixture(t, mode = "local") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-channel-input-native-")));
  const cwd = join(root, "workspace"), executionCwd = mode === "local" ? cwd : join(root, "execution");
  await mkdir(cwd);
  if (executionCwd !== cwd) await mkdir(executionCwd);
  const store = createSqliteRunStore(cwd), now = new Date().toISOString();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    sandbox: { restrictedCommands: config() } }));
  const runtime = supervisor.getRestrictedCommandRuntime();
  const preparedCopies = new Set();
  let unclosedChild = false;
  t.after(async () => {
    supervisor.releaseAll();
    store.close();
    assert.equal(unclosedChild, false, `Unconfirmed child closure; retain owned roots at ${root}`);
    for (const prepared of preparedCopies) prepared.dispose();
    await rm(root, { recursive: true, force: true });
  });
  store.updateApprovalPolicy({ toolDecisions: { read: "allow", bash: "allow" } }, now);
  const owner = store.createAiTeammate({ id: participantId, roleKey: "qa", displayName: "Policy QA",
    description: "Isolated real native conformance", allowedTools: ["read", "bash"], approvalProfile: { mode: "none" } }, now);
  const channel = store.createChannel({ name: "Native policy input", boundPath: cwd, allowedTools: ["read", "bash"],
    ...(mode === "local" ? {} : { workspaceBinding: { mode, status: "ready", updatedAt: now,
      ...(mode === "managed_worktree" ? { worktreePath: executionCwd } : { executionPath: executionCwd }) } }) }, now);
  store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body,
    mentions: [{ kind: "ai-teammate", id: participantId, label: "Policy QA" }] }, now);
  const sourceItem = store.getConversationItem(source.id);
  const context = { store, channelId: channel.id, participantId, operationId: "native-command",
    sourceItemId: source.id, workspaceCwd: cwd };
  const scope = compileChannelCommandInputPolicyScope(context);
  assert.ok(scope?.policyAuthority);
  const bound = bindChannelOperationPlan({ sourceItemId: source.id, sourceText: body, workspaceCwd: executionCwd,
    participants: [owner], visibleSources: [{ itemId: source.id, body, revision: sourceItem.revision, actorType: sourceItem.actorType }],
    compileCommandInputScope: input => compileChannelCommandInputPolicyScope({ ...context,
      operationId: input.operationId, participantId: input.participantId, sourceItemId: input.sourceItemId }),
    candidate: { schemaVersion: 2, operations: [{ id: "native-command", kind: "run_command", targetKind: "command",
      required: true, dependsOn: [], owner: { participantId, sourceQuote: "Policy QA" }, sourceQuote: body,
      command: { text: command, sourceQuote: command }, inputs: [{ path: "cli.js", sourceQuote: "cli.js" }] }] } });
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.deepEqual(bound.execution.operations[0].binding.commandInputScope, scope);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Native policy", objective: body,
    status: "running", createdBy: "ling_agent" }, now);
  let step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Native policy command", prompt: body,
    toParticipantId: participantId, toParticipantLabel: "Policy QA", status: "running",
    metadata: { executionPlan: bound.execution, executionOperationIds: ["native-command"] } }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step, participant: { expectedOutcome: "execution" },
    manifestFingerprint: "native-conformance-manifest" });
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  const snapshot = createWorkflowOperationExecutionSnapshot(step);
  const task = store.createTask({ channelId: channel.id, title: "Native conformance", prompt: body,
    assigneeTeammateId: participantId }, now);
  const runId = `native-policy-${step.id}`;
  const unit = store.createWorkUnit({ workspaceId: channel.workspaceId, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "native-conformance", runnerId: "pi", status: "started", now });
  const sourceFence = toRuntimeAttemptFence(attempt);
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    approvalProfile: owner.approvalProfile, channelBoundPath: channel.boundPath }).snapshot;
  store.createRun({ id: runId, cwd: executionCwd, workUnitId: unit.id, taskId: task.id, channelId: channel.id,
    threadId: sourceItem.threadId, workflowStepId: step.id, teammateId: participantId,
    providerName: "no-model", providerModel: "no-model", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { effectivePolicySnapshot: policy, workflowOperationExecution: snapshot, delegatedRequirement: requirement }, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now);
  store.markRunStarted(runId, now);
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId }, now);
  const run = store.getRun(runId), toolCallId = "native-conformance-call";
  assert.equal(validateWorkflowOperationRunContext({ store, run }).status, "ready");
  assert.equal(store.isCurrentRunExecutionOwner(runId, sourceFence), true);
  const request = { toolName: "bash", toolCallId, cwd: executionCwd, task, input: { command, timeoutMs: 10_000 } };
  const controller = new AbortController();
  const prepareDeadline = setTimeout(() => controller.abort(), 20_000);
  t.after(() => clearTimeout(prepareDeadline));
  const dispatch = createRestrictedCommandDispatch({ store, run, sourceFence, request,
    restrictedCommandRuntime: runtime, signal: controller.signal });
  const ticket = store.prepareHostCommandExecution({ runId, sourceFence, toolCallId, cwd: executionCwd,
    command: { kind: "shell", command } });
  const events = () => store.listEvents(runId).filter(event => ["host_command_prepared", "host_command_settled"].includes(event.type));
  return { root, cwd, executionCwd, store, channel, sourceItem, scope, run, ticket, dispatch, events,
    async write(files) {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(executionCwd, path)), { recursive: true });
        await writeFile(join(executionCwd, path), content, { mode: 0o600 });
      }
    },
    async prepare() {
      const prepared = await dispatch.prepare();
      clearTimeout(prepareDeadline);
      preparedCopies.add(prepared);
      return prepared;
    },
    async launch(prepared) {
      let child;
      store.launchHostCommandExecution(ticket, () => { child = prepared.spawn(); }, dispatch.assertMayLaunch);
      const result = await observeChild(child, () => { unclosedChild = true; });
      store.settleHostCommandExecution(ticket, { kind: "observed", observation: {
        scope: "process_group", leaderExited: true, stdioClosed: true, descendants: "unverified",
        settledBy: "close", signalFailures: [] } });
      return result;
    },
    assertNotStarted(label) {
      clearTimeout(prepareDeadline);
      const before = events();
      assert.equal(before.filter(event => event.type === "host_command_prepared").length, 1);
      assert.equal(before.some(event => event.type === "host_command_settled"), false);
      const settled = store.settleHostCommandExecution(ticket, { kind: "not_started" });
      assert.equal(settled.data.outcome, "not_started");
      const reopened = createSqliteRunStore(cwd);
      try {
        const durable = reopened.listEvents(runId).filter(event => event.type === "host_command_settled"
          && event.data.executionId === ticket.executionId);
        assert.deepEqual(durable, [settled]);
      } finally { reopened.close(); }
      console.log(JSON.stringify({ case: label, commandNotStarted: true, executionId: ticket.executionId,
        sourceFence, before: before.map(event => ({ type: event.type, sequence: event.seq })), settled: settled.data,
        scopeFingerprint: scope.policyAuthority.policyFingerprint,
        limit: "Native input helper/preparation effects are not claimed never-started or fully drained" }));
    } };
}

async function observeChild(child, retain) {
  let stdout = "", stderr = "", timedOut = false, closeDeadline;
  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      try { signalMacosSandboxProcessGroup(child, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      closeDeadline = setTimeout(() => { retain(); reject(new Error("native_conformance_child_close_unknown")); }, 1000);
    }, 10_000);
    child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65_536) child.kill("SIGKILL"); });
    child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 65_536) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timeout); clearTimeout(closeDeadline); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); clearTimeout(closeDeadline);
      if (timedOut) return reject(new Error(`native_conformance_child_timeout:${stderr}`));
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

const closureFiles = {
  "cli.js": "const {value}=require('./lib/first.cjs');console.log('closure:'+value);",
  "package.json": '{"type":"commonjs"}',
  "lib/first.cjs": "exports.value=require('./second.cjs').value;",
  "lib/second.cjs": "exports.value='7319';",
};

for (const mode of ["local", "external_path", "managed_worktree"]) nativeCase(`${mode}: real Node closure preserves hash and policy provenance`, async t => {
  const f = await fixture(t, mode);
  await f.write({ ...closureFiles, "private.txt": "NOT-A-MODULE-INPUT" });
  const prepared = await f.prepare(), evidence = prepared.evidence;
  assert.equal(evidence.backend, "macos_seatbelt");
  assert.equal(evidence.originalCwd, f.executionCwd);
  assert.deepEqual(evidence.inputs.map(row => row.path).sort(), Object.keys(closureFiles).sort());
  for (const row of evidence.inputs) {
    assert.equal(row.sha256, digest(closureFiles[row.path]));
    assert.equal(row.sizeBytes, Buffer.byteLength(closureFiles[row.path]));
    assert.deepEqual(row.sourceItemIds, [f.sourceItem.id]);
    if (row.path === "cli.js") assert.equal(row.derivation, undefined);
    else {
      assert.deepEqual(row.derivation.policyAuthority, f.scope.policyAuthority);
      assert.equal(row.derivation.projectRoot, ".");
      assert.equal(row.derivation.parentSha256, digest(closureFiles[row.derivation.parentPath]));
      assert.equal(row.derivation.kind, row.path === "package.json" ? "node_package_metadata_v1" : "node_module_dependency_v1");
    }
  }
  const result = await f.launch(prepared);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "closure:7319\n");
  console.log(JSON.stringify({ case: mode, result, policyHash: evidence.policyHash, profileHash: evidence.profileHash,
    inputEvidence: evidence.inputs, helper: config().inputHelper, runtimeResourceKind: config().executables.node.runtime.kind,
    journal: f.events().map(event => ({ type: event.type, data: event.data })), descendants: "unverified" }));
});

nativeCase("real Seatbelt denies origin reads, origin/staged writes, and a live loopback connection", async t => {
  const f = await fixture(t), server = createServer(socket => { socket.destroy(); });
  let accepted = 0;
  server.on("connection", () => accepted++);
  await new Promise((resolveServer, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveServer); });
  t.after(() => new Promise(resolveServer => server.close(resolveServer)));
  const port = server.address().port, privatePath = join(f.executionCwd, "private.txt");
  const cli = `const fs=require('node:fs'),net=require('node:net');const result={};` +
    `for(const [key,fn] of Object.entries({originRead:()=>fs.readFileSync(${JSON.stringify(privatePath)},'utf8'),` +
    `originWrite:()=>fs.writeFileSync(${JSON.stringify(privatePath)},'changed'),stagedWrite:()=>fs.writeFileSync('new.txt','changed')}))` +
    `{try{fn();result[key]='ALLOWED'}catch(e){result[key]=e.code}}` +
    `const socket=net.createConnection({host:'127.0.0.1',port:${port}});` +
    `const timer=setTimeout(()=>{socket.destroy();result.network='TIMEOUT';console.log(JSON.stringify(result));},2000);` +
    `socket.once('connect',()=>{clearTimeout(timer);result.network='ALLOWED';socket.destroy();console.log(JSON.stringify(result));});` +
    `socket.once('error',e=>{clearTimeout(timer);result.network=e.code;console.log(JSON.stringify(result));});`;
  await f.write({ "cli.js": cli, "package.json": '{"type":"commonjs"}', "private.txt": "PRIVATE-ORIGIN-MARKER" });
  const prepared = await f.prepare(), result = await f.launch(prepared);
  assert.equal(result.code, 0, result.stderr);
  const denials = JSON.parse(result.stdout);
  for (const key of ["originRead", "originWrite", "stagedWrite", "network"]) assert.match(denials[key], /^(?:EPERM|EACCES)$/u, `${key}:${result.stdout}`);
  assert.equal(accepted, 0);
  assert.equal(await readFile(privatePath, "utf8"), "PRIVATE-ORIGIN-MARKER");
  await assert.rejects(readFile(join(prepared.evidence.executionCwd, "new.txt")), { code: "ENOENT" });
  assert.equal(prepared.evidence.inputs.some(row => row.path === "private.txt"), false);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-ORIGIN-MARKER/u);
  console.log(JSON.stringify({ denials, loopbackWasListening: true, accepted, result, inputs: prepared.evidence.inputs.map(row => row.path) }));
});

for (const kind of ["symlink", "hardlink"]) nativeCase(`real native reader rejects ${kind} dependency before command launch`, async t => {
  const f = await fixture(t), outside = join(f.root, "outside.cjs");
  await f.write({ "cli.js": "console.log(require('./dep.cjs').value);", "package.json": '{"type":"commonjs"}' });
  await writeFile(outside, "exports.value='MUST-NOT-LAUNCH';", { mode: 0o600 });
  if (kind === "symlink") await symlink(outside, join(f.executionCwd, "dep.cjs"));
  else await link(outside, join(f.executionCwd, "dep.cjs"));
  await assert.rejects(f.prepare(), error => {
    console.log(JSON.stringify({ kind, nativeReaderRejection: error.message }));
    // openat(O_NOFOLLOW) reports ELOOP through the fixed unavailable-path code;
    // hard links have their separate native metadata rejection code.
    return error.message === (kind === "symlink" ? "native_input_helper_input_path_unavailable"
      : "native_input_helper_input_hardlink_rejected");
  });
  f.assertNotStarted(kind);
});

nativeCase("read revocation across real helper await stops preparation and durably records no command launch", async t => {
  const f = await fixture(t);
  await f.write(closureFiles);
  assert.equal(f.events().length, 1);
  const pending = f.prepare();
  // prepare() has synchronously entered the real helper path before returning
  // its first pending await. The Host mutates canonical policy, not a fake guard.
  f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, new Date().toISOString());
  await assert.rejects(pending, /protected_host_source_obsolete|restricted_command_(?:input_)?policy_changed/u);
  f.assertNotStarted("read-revoked-during-native-capture");
});

nativeCase("membership revocation after real capture blocks atomic spawn before its launch callback", async t => {
  const f = await fixture(t);
  await f.write(closureFiles);
  const prepared = await f.prepare();
  assert.deepEqual(prepared.evidence.inputs.map(row => row.path).sort(), Object.keys(closureFiles).sort());
  assert.equal(f.events().length, 1);
  f.store.replaceTeammateChannelMemberships(participantId, [], new Date().toISOString());
  let launchCallbackEntered = false;
  assert.throws(() => f.store.launchHostCommandExecution(f.ticket, () => {
    launchCallbackEntered = true;
    return prepared.spawn();
  }, f.dispatch.assertMayLaunch), /restricted_command_input_policy_changed/u);
  assert.equal(launchCallbackEntered, false);
  f.assertNotStarted("membership-revoked-before-atomic-spawn");
});
