import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateWorkflowOperationRunContext } from "../dist/features/runs/workflow-operation-snapshot.js";
import { approveRawCommand, assertKnownNoStart, changeSelectedSkillProfile, changeUntypedRawRequirement, changeWorkspacePolicy, commandFacts,
  createRawSourceFixture, createRealRawDispatch, loadRawSourceModule, mutateAfterCommandBind, observeRawProducer, operationFact, quoteShell,
  replacePersistedRequestSnapshot, replaceRawAttempt } from "./support/unified-exec-raw-source-fixture.mjs";

const confirmation = () => ({ mode: "full_access", confirmed: true,
  confirmedAt: new Date(Date.now() - 1000).toISOString(), reason: "Temporary isolated source regression" });
const forbiddenProducer = () => { throw new Error("forbidden raw producer entered"); };

for (const commandRule of [false, true]) {
  test(`root ${commandRule ? "command rule" : "one-time approval"} cannot authorize a model-selected subdirectory`, async t => {
    const f = await createRawSourceFixture(t, { authorizationMode: "ask" });
    mkdirSync(join(f.cwd, "project"));
    const approved = approveRawCommand(f, "printf raw-source", { commandRule });
    const calls = observeRawProducer(t);
    const result = await f.execute({ cwd: "project" }, commandRule ? {} : { approvalId: approved.approval.id });
    assert.equal(calls.length, 0, "approval cwd must match the actual process cwd before native entry");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, commandRule ? /approval_required/ : /approval_invalid/);
    assertKnownNoStart(f, { requireCommandFact: false });
    assert.equal(commandFacts(f).length, 0, "denial occurs before command preparation, not after launch");
  });
}

test("public legacy raw entry refuses an active stage before the producer and durably proves no-start", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true });
  const approved = approveRawCommand(f);
  const calls = observeRawProducer(t, forbiddenProducer);
  const result = await f.execute({}, { approvalId: approved.approval.id });
  assert.equal(calls.length, 0, "ordinary legacy raw is controlled, not Full Access");
  assert.equal(result.isError, true);
  assertKnownNoStart(f);
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage), "refusal must not poison stage coverage");
});

test("original controlled and independently sourced Full Access entries must exist", async () => {
  const module = await loadRawSourceModule();
  assert.ok(module?.UNIFIED_EXEC_RAW_ACTOR_ENTRY, "missing source-owned controlled raw entry");
  assert.ok(module?.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY, "missing source-owned Full Access entry");
  assert.equal(module.UNIFIED_EXEC_RAW_ACTOR_ENTRY.entryId, "unified_exec_raw");
  assert.equal(module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY.entryId, "unified_exec_full_access");
  assert.notEqual(module.UNIFIED_EXEC_RAW_ACTOR_ENTRY, module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY);
  assert.equal(typeof module.UNIFIED_EXEC_RAW_ACTOR_ENTRY.assertMayInvoke, "function");
  assert.equal(typeof module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY.assertMayInvoke, "function");
  assert.ok(Object.isFrozen(module.UNIFIED_EXEC_RAW_ACTOR_ENTRY));
  assert.ok(Object.isFrozen(module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY));
});

for (const [name, options] of [
  ["missing confirmation", { workspaceAccessMode: "full_access" }],
  ["false confirmation", { workspaceAccessMode: "full_access", permissionConfirmation: { ...confirmation(), confirmed: false } }],
  ["future confirmation", { workspaceAccessMode: "full_access", permissionConfirmation: { ...confirmation(), confirmedAt: "2099-01-01T00:00:00.000Z" } }],
  ["invalid timestamp", { workspaceAccessMode: "full_access", permissionConfirmation: { ...confirmation(), confirmedAt: "not-a-date" } }],
  ["blank reason", { workspaceAccessMode: "full_access", permissionConfirmation: { ...confirmation(), reason: "  " } }],
  ["wrong confirmation mode", { workspaceAccessMode: "full_access", permissionConfirmation: { ...confirmation(), mode: "workspace_write" } }],
  ["confirmation without persisted Full Access", { permissionConfirmation: confirmation() }],
  ["allowedWritePaths root is not authorization", { requestSnapshot: snapshot => ({ ...snapshot,
    effectivePolicySnapshot: { ...snapshot.effectivePolicySnapshot, allowedWritePaths: ["/"] } }) }],
  ["Full Access request with workspace policy snapshot", { requestSnapshot: snapshot => ({ ...snapshot,
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() }) }],
  ["Full Access policy without matching persisted request", { workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation(), requestSnapshot: snapshot => ({ ...snapshot, workspaceAccessMode: "workspace_write" }) }],
  ["legacy empty snapshot does not grant Full Access", { requestSnapshot: {} }],
]) {
  test(`public active-stage raw rejects ${name} with zero producer and no unknown`, async t => {
    const f = await createRawSourceFixture(t, { ...options, activeStage: true });
    const approved = approveRawCommand(f);
    const calls = observeRawProducer(t, forbiddenProducer);
    const result = await f.execute({}, { approvalId: approved.approval.id });
    assert.equal(calls.length, 0);
    assert.equal(result.isError, true);
    assertKnownNoStart(f, { requireCommandFact: false });
    assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
  });
}

for (const authorizationMode of ["ask", "smart", "always"]) {
  test(`persisted confirmed Full Access ${authorizationMode} uses its own actual entry, even with an active stage`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode,
      workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
    const calls = observeRawProducer(t);
    const approval = authorizationMode === "always" ? undefined : approveRawCommand(f);
    const result = await f.execute({}, approval ? { approvalId: approval.approval.id } : {});
    assert.equal(calls.length, 1, "authorizationMode is separate from Full Access isolation selection");
    assert.equal(result.isError, false);
    assert.equal(result.details.unifiedExec.status, "succeeded");
    assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
    assert.equal(operationFact(f).phase, "unknown_outcome", "Full Access grants no descendants closure");
    assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage), "external entry must not forge controlled coverage");
  });
}

for (const authorizationMode of ["ask", "smart"]) {
  test(`Full Access ${authorizationMode} cannot bypass its required approval`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode,
      workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
    const calls = observeRawProducer(t, forbiddenProducer), result = await f.execute();
    assert.equal(calls.length, 0); assert.equal(result.isError, true);
    assertKnownNoStart(f, { requireCommandFact: false });
  });
}

test("confirmed Full Access cannot bypass workspace bash deny", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation() });
  changeWorkspacePolicy(f);
  const calls = observeRawProducer(t, forbiddenProducer), result = await f.execute();
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f, { requireCommandFact: false });
});

for (const [name, options] of [
  ["persisted plan mode", { workspaceAccessMode: "full_access", permissionConfirmation: confirmation(),
    command: "touch plan-must-not-write",
    requestSnapshot: snapshot => ({ ...snapshot, effectivePolicySnapshot: { ...snapshot.effectivePolicySnapshot,
      conversationMode: "plan", planModeMutationPolicy: "deny_repo_tracked_mutation" } }) }],
  ["persisted read-only access", { workspaceAccessMode: "read_only" }],
  ["effective policy bash deny", { workspaceAccessMode: "full_access", permissionConfirmation: confirmation(),
    requestSnapshot: snapshot => ({ ...snapshot, effectivePolicySnapshot: { ...snapshot.effectivePolicySnapshot,
      toolDecisions: { ...snapshot.effectivePolicySnapshot.toolDecisions, bash: "deny" } } }) }],
  ["strict profile even with always authorization", { workspaceAccessMode: "full_access", permissionConfirmation: confirmation(),
    requestSnapshot: snapshot => ({ ...snapshot, approvalProfile: { mode: "strict", requiredForTools: ["bash"] } }) }],
]) {
  test(`raw source respects ${name} instead of taking an external bypass`, async t => {
    const f = await createRawSourceFixture(t, { ...options, activeStage: true });
    const calls = observeRawProducer(t, forbiddenProducer), result = await f.execute(options.command ? { command: options.command } : {});
    assert.equal(calls.length, 0); assert.equal(result.isError, true);
    assertKnownNoStart(f, { requireCommandFact: false });
    if (options.command) assert.equal(existsSync(join(f.cwd, "plan-must-not-write")), false);
  });
}

test("Full Access always still requires approval for consequential risk", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation() });
  const calls = observeRawProducer(t, forbiddenProducer), result = await f.execute({ command: "git push origin main" });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f, { requireCommandFact: false });
});

for (const [name, approvalOptions] of [
  ["different tool call", { toolCallId: "another-tool-call" }],
  ["different prior Attempt", { priorAttemptId: "another-prior-attempt" }],
]) {
  test(`persisted Full Access approval cannot borrow ${name} lineage`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
      workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
    const approved = approveRawCommand(f, "printf raw-source", approvalOptions);
    const calls = observeRawProducer(t, forbiddenProducer);
    const result = await f.execute({}, { approvalId: approved.approval.id });
    assert.equal(calls.length, 0); assert.equal(result.isError, true);
    assertKnownNoStart(f, { requireCommandFact: false });
  });
}

test("persisted Full Access smart may use a current genuine command rule", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  const approved = approveRawCommand(f, "printf raw-source", { commandRule: true });
  assert.equal(approved.rule.sourceApprovalId, approved.approval.id);
  const calls = observeRawProducer(t), result = await f.execute();
  assert.equal(calls.length, 1); assert.equal(result.isError, false);
  assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("revoking a genuine command rule after exact bind blocks the physical launch", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  const approved = approveRawCommand(f, "printf raw-source", { commandRule: true });
  const calls = observeRawProducer(t, forbiddenProducer);
  const result = await f.execute({}, { hostOperation: mutateAfterCommandBind(f,
    () => f.store.revokeApprovalCommandRule(approved.rule.id, new Date().toISOString())) });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f);
});

for (const [name, mutate] of [
  ["persisted source request", f => replacePersistedRequestSnapshot(f, { ...f.run.requestSnapshot, unrelatedRevision: 2 })],
  ["workspace policy", f => changeWorkspacePolicy(f)],
  ["permission confirmation", f => replacePersistedRequestSnapshot(f, { ...f.run.requestSnapshot,
    permissionConfirmation: { ...confirmation(), confirmed: false } })],
]) {
  test(`Full Access rechecks ${name} inside the launch boundary after exact bind`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
      permissionConfirmation: confirmation() });
    const calls = observeRawProducer(t, forbiddenProducer);
    const result = await f.execute({}, { hostOperation: mutateAfterCommandBind(f, () => mutate(f)) });
    assert.equal(calls.length, 0); assert.equal(result.isError, true);
    assertKnownNoStart(f);
  });
}

test("an obsolete Attempt after bind cannot launch using the newly current owner", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation() });
  const calls = observeRawProducer(t, forbiddenProducer);
  await assert.rejects(f.execute({}, { hostOperation: mutateAfterCommandBind(f, () => replaceRawAttempt(f)) }));
  assert.equal(calls.length, 0);
  assert.equal(operationFact(f).phase, "unknown_outcome", "obsolete ownership cannot manufacture durable no-start");
  assert.equal(commandFacts(f).at(-1).data.outcome, "stop_unconfirmed");
});

test("caller run flags or a cloned source cannot manufacture Full Access provenance", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true });
  const calls = observeRawProducer(t, forbiddenProducer);
  const run = { ...f.run, fullAccess: true, requestSnapshot: { ...f.run.requestSnapshot,
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation(),
    effectivePolicySnapshot: { ...f.effectivePolicySnapshot, workspaceAccessMode: "full_access", allowedWritePaths: ["/"] } } };
  const result = await f.execute({}, { run, fullAccess: true });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f, { requireCommandFact: false });
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("the exact external entry cannot execute a caller-created source record", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true });
  const calls = observeRawProducer(t, forbiddenProducer);
  const entry = f.module?.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY;
  assert.ok(entry, "source-owned Full Access entry must exist");
  assert.throws(() => entry.invoke(undefined, { store: f.store, run: f.run, sourceFence: f.sourceFence,
    command: { kind: "shell", command: "printf unauthorized", shell: "bash" }, fullAccess: true,
    permissionConfirmation: confirmation(), options: { cwd: f.cwd, env: {} } }), /source|provenance|invalid|binding/u);
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("the public path without a Host operation still refuses before the actual producer", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, trackHost: false });
  const approved = approveRawCommand(f), calls = observeRawProducer(t, forbiddenProducer);
  const result = await f.execute({}, { approvalId: approved.approval.id });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assert.equal(commandFacts(f).at(-1).data.outcome, "not_started");
  assert.deepEqual(f.store.listHostOperationBlockers(f.source), []);
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("an original one-shot Full Access source dispatch cannot be cloned, borrowed or replayed", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation() });
  const dispatch = createRealRawDispatch(f), calls = observeRawProducer(t);
  let entered = 0;
  assert.ok(Object.isFrozen(dispatch));
  assert.throws(() => dispatch.spawn.call({ ...dispatch }, {}, () => entered++), /invalid/u);
  assert.equal(calls.length, 0); assert.equal(entered, 0);
  dispatch.assertMayLaunch();
  const child = dispatch.spawn({}, () => entered++);
  child.stdin.end(); child.stdout.resume(); child.stderr.resume();
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0); assert.equal(calls.length, 1); assert.equal(entered, 1);
  assert.throws(() => dispatch.assertMayLaunch(), /already_consumed/u);
  assert.throws(() => dispatch.spawn({}, () => entered++), /invalid|consumed/u);
  assert.equal(calls.length, 1); assert.equal(entered, 1);
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

for (const [name, overrides] of [
  ["another normalized workspace subdirectory", f => ({ approvalRequest: { input: { cwd: "subA" } },
    normalizedRequest: { cwd: join(f.cwd, "subB") } })],
  ["normalized cwd outside the Run workspace", f => ({ approvalRequest: { input: { cwd: "subA" } },
    normalizedRequest: { cwd: f.stagePath } })],
  ["an outside Pi input cwd even with a matching normalized cwd", f => ({ approvalRequest: { input: { cwd: f.stagePath } },
    normalizedRequest: { cwd: f.stagePath } })],
  ["a substituted shell", () => ({ normalizedRequest: { command: { kind: "shell", shell: "zsh", command: "printf raw-source" } } })],
  ["a substituted normalized approvalId", () => ({ normalizedRequest: { approvalId: "caller-forged-approval" } })],
]) {
  test(`exported raw factory rejects ${name} before any producer`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
      permissionConfirmation: confirmation() });
    for (const directory of ["subA", "subB"]) mkdirSync(join(f.cwd, directory));
    const calls = observeRawProducer(t, forbiddenProducer);
    assert.throws(() => createRealRawDispatch(f, overrides(f)), /command_binding_invalid/u);
    assert.equal(calls.length, 0);
    assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
  });
}

for (const commandRule of [false, true]) {
  test(`exported raw factory cannot borrow a root ${commandRule ? "rule" : "approval"} for a subdirectory`, async t => {
    const f = await createRawSourceFixture(t, { authorizationMode: "ask" });
    mkdirSync(join(f.cwd, "subA"));
    const approved = approveRawCommand(f, "printf raw-source", { commandRule });
    const calls = observeRawProducer(t, forbiddenProducer);
    assert.throws(() => createRealRawDispatch(f, {
      ...(commandRule ? {} : { approvalId: approved.approval.id }),
      approvalRequest: { input: { cwd: "subA" } },
    }), commandRule ? /approval_required/ : /approval_invalid/);
    assert.equal(calls.length, 0);
  });
}

test("a legitimate Pi input subdirectory requires its own approval payload at the original raw source", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  const subdirectory = join(f.cwd, "subA"); mkdirSync(subdirectory);
  const approved = approveRawCommand({ ...f, cwd: subdirectory }, "pwd");
  assert.equal(approved.approval.payload.cwd, subdirectory);
  const dispatch = createRealRawDispatch(f, { approvalId: approved.approval.id,
    approvalRequest: { input: { command: "pwd", cwd: "subA" } } });
  const calls = observeRawProducer(t);
  let entered = 0;
  dispatch.assertMayLaunch();
  const child = dispatch.spawn({}, () => entered++), chunks = [];
  child.stdout.on("data", bytes => chunks.push(bytes)); child.stderr.resume(); child.stdin.end();
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0); assert.equal(calls.length, 1); assert.equal(entered, 1);
  assert.equal(calls[0][2].cwd, subdirectory);
  assert.equal(Buffer.concat(chunks).toString("utf8").trim(), subdirectory);
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("a current published selected Skill strict profile cannot be bypassed by a valid command rule", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation(),
    skillApprovalProfile: { mode: "strict", requiredForTools: ["bash"] } });
  assert.equal(f.run.requestSnapshot.approvalProfile, undefined, "runtime merged profile is intentionally not in the request");
  const approved = approveRawCommand(f, "printf raw-source", { commandRule: true });
  assert.ok(approved.rule);
  const calls = observeRawProducer(t, forbiddenProducer), result = await f.execute();
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f, { requireCommandFact: false });
});

test("a published selected Skill profile becoming strict after bind revokes a rule-only launch", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation(), skillApprovalProfile: { mode: "none" } });
  const approved = approveRawCommand(f, "printf raw-source", { commandRule: true });
  assert.ok(approved.rule);
  const calls = observeRawProducer(t, forbiddenProducer);
  const result = await f.execute({}, { hostOperation: mutateAfterCommandBind(f,
    () => changeSelectedSkillProfile(f, { mode: "strict", requiredForTools: ["bash"] })) });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assertKnownNoStart(f);
});

test("a genuine untyped delegated requirement and nonempty approval fingerprint may execute normally", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, delegated: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  assert.equal(validateWorkflowOperationRunContext(f).status, "legacy");
  assert.equal(f.run.requestSnapshot.workflowOperationExecution, undefined);
  assert.equal(f.delegation.requirement.executionPlanFingerprint, undefined);
  const approved = approveRawCommand(f);
  assert.equal(approved.basis.workflowStepId, f.run.workflowStepId);
  assert.equal(approved.basis.delegatedRequirementFingerprint, f.delegation.requirement.fingerprint);
  assert.ok(approved.basis.delegatedRequirementFingerprint);
  const calls = observeRawProducer(t), result = await f.execute({}, { approvalId: approved.approval.id });
  assert.equal(calls.length, 1); assert.equal(result.isError, false);
  assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

test("an untyped delegated requirement changed after capture cannot borrow the prior approval fingerprint", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, delegated: true, authorizationMode: "smart",
    workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  const approved = approveRawCommand(f), calls = observeRawProducer(t, forbiddenProducer);
  const result = await f.execute({}, { approvalId: approved.approval.id,
    hostOperation: mutateAfterCommandBind(f, () => changeUntypedRawRequirement(f)) });
  assert.equal(calls.length, 0); assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requirement/u);
  assertKnownNoStart(f);
});

for (const command of ["pwd", "git status --short"]) {
  test(`confirmed Full Access Plan mode keeps the existing read-only command policy (${command})`, async t => {
    const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
      permissionConfirmation: confirmation(), requestSnapshot: snapshot => ({ ...snapshot,
        effectivePolicySnapshot: { ...snapshot.effectivePolicySnapshot, conversationMode: "plan",
          planModeMutationPolicy: "deny_repo_tracked_mutation" } }) });
    if (command.startsWith("git ")) {
      // Disposable repository setup precedes the observer. This is not a
      // controlled production source and provides no isolation certification.
      const initialized = spawnSync("git", ["init", "--quiet", "--template=", "--initial-branch=main"],
        { cwd: f.cwd, encoding: "utf8", env: { PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      assert.equal(initialized.status, 0, initialized.stderr);
    }
    const calls = observeRawProducer(t), result = await f.execute({ command });
    assert.equal(calls.length, 1); assert.equal(result.isError, false);
    assert.equal(result.details.unifiedExec.status, "succeeded");
    assert.equal(calls[0][1].at(-1), command);
    assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
    assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
  });
}

test("mode none ignores stale requiredForTools and requiredForActions instead of forcing an approval", async t => {
  const f = await createRawSourceFixture(t, { activeStage: true, workspaceAccessMode: "full_access",
    permissionConfirmation: confirmation(), requestSnapshot: snapshot => ({ ...snapshot,
      approvalProfile: { mode: "none", requiredForTools: ["bash"], requiredForActions: ["bash"] } }) });
  const calls = observeRawProducer(t), result = await f.execute();
  assert.equal(calls.length, 1); assert.equal(result.isError, false);
  assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
  assert.doesNotThrow(() => f.registry.assertStageCurrent(f.stage));
});

for (const [name, permissionConfirmation] of [
  ["missing", undefined],
  ["false", { ...confirmation(), confirmed: false }],
  ["future", { ...confirmation(), confirmedAt: "2099-01-01T00:00:00.000Z" }],
  ["invalid timestamp", { ...confirmation(), confirmedAt: "not-a-date" }],
  ["blank reason", { ...confirmation(), reason: " " }],
  ["wrong mode", { ...confirmation(), mode: "workspace_write" }],
]) {
  test(`Full Access with ${name} confirmation is denied even without any stage`, async t => {
    const f = await createRawSourceFixture(t, { workspaceAccessMode: "full_access", permissionConfirmation });
    const approved = approveRawCommand(f), calls = observeRawProducer(t, forbiddenProducer);
    const result = await f.execute({}, { approvalId: approved.approval.id });
    assert.equal(calls.length, 0); assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirmation/u);
    assertKnownNoStart(f, { requireCommandFact: false });
  });
}

test("a genuine confirmed Full Access source also executes normally without a stage", async t => {
  const f = await createRawSourceFixture(t, { workspaceAccessMode: "full_access", permissionConfirmation: confirmation() });
  const calls = observeRawProducer(t), result = await f.execute();
  assert.equal(calls.length, 1); assert.equal(result.isError, false);
  assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
});

// No controlled positive occurs before the active-stage matrix. Such a real
// unbound producer must permanently close protection for subsequently bound registries.
for (const requestSnapshot of [undefined, {}]) {
  test(`public ordinary raw with no stage retains genuine shell behavior (${requestSnapshot ? "legacy empty snapshot" : "current policy"})`, async t => {
    const f = await createRawSourceFixture(t, { requestSnapshot }), calls = observeRawProducer(t);
    const target = join(f.cwd, "actual.txt"), command = `printf actual > ${quoteShell(target)}`;
    const approved = requestSnapshot ? undefined : approveRawCommand(f, command);
    const result = await f.execute({ command }, approved ? { approvalId: approved.approval.id } : {});
    assert.equal(calls.length, 1);
    assert.equal(result.isError, false);
    assert.equal(result.details.unifiedExec.status, "succeeded");
    assert.equal(readFileSync(target, "utf8"), "actual");
    assert.equal(commandFacts(f).at(-1).data.outcome, "completed");
    assert.equal(operationFact(f).phase, "unknown_outcome", "leader exit is not a physical descendants proof");
  });
}

test("caller mutation after bind cannot replace the captured raw command", async t => {
  const f = await createRawSourceFixture(t), calls = observeRawProducer(t);
  const target = join(f.cwd, "captured.txt"), forbidden = join(f.cwd, "mutable-caller.txt");
  const request = { toolName: "bash", toolCallId: "raw-source-call", cwd: f.cwd, task: f.task,
    input: { command: `printf captured > ${quoteShell(target)}`, timeoutMs: 3000 } };
  const approved = approveRawCommand(f, request.input.command);
  const result = await f.execute({}, { request, approvalId: approved.approval.id, hostOperation: mutateAfterCommandBind(f,
    () => { request.input.command = `printf wrong > ${quoteShell(forbidden)}`; }) });
  assert.equal(calls.length, 1); assert.equal(result.isError, false);
  assert.equal(readFileSync(target, "utf8"), "captured"); assert.equal(existsSync(forbidden), false);
});

test("original producer synchronous throw is unknown, never washed into a no-start fact", async t => {
  const f = await createRawSourceFixture(t);
  const approved = approveRawCommand(f);
  const calls = observeRawProducer(t, () => { throw new Error("actual raw spawn producer throw"); });
  const result = await f.execute({}, { approvalId: approved.approval.id });
  assert.equal(calls.length, 1);
  assert.equal(result.isError, true);
  assert.equal(commandFacts(f).at(-1).data.outcome, "stop_unconfirmed");
  assert.equal(operationFact(f).phase, "unknown_outcome");
  assert.notEqual(operationFact(f).settlementKind, "known_no_start");
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 1);
});

test("a COMMIT failure after the real raw spawn preserves unknown Host and command evidence", async t => {
  const f = await createRawSourceFixture(t), calls = observeRawProducer(t);
  const command = `${quoteShell(process.execPath)} -e 'setTimeout(() => {}, 1000)'`;
  const approved = approveRawCommand(f, command);
  const result = await f.execute({ command }, { approvalId: approved.approval.id,
    hostOperation: { ...f.hostOperation, launch(ticket, effect, assertMayLaunch) {
      return f.hostOperation.launch(ticket, () => {
        const value = effect(), original = f.store.database.exec.bind(f.store.database);
        f.store.database.exec = sql => {
          if (sql === "COMMIT") { f.store.database.exec = original; throw new Error("actual raw post-spawn COMMIT fixture"); }
          return original(sql);
        };
        return value;
      }, assertMayLaunch);
    } } });
  assert.equal(calls.length, 1); assert.equal(result.isError, true);
  assert.equal(result.details.unifiedExec.processObservation.stopReason, "observer_error");
  assert.equal(operationFact(f).phase, "unknown_outcome");
  assert.equal(commandFacts(f).at(-1).data.outcome, "stop_unconfirmed");
  assert.notEqual(operationFact(f).settlementKind, "known_no_start");
});
