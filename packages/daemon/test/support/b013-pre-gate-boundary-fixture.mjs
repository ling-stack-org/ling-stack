import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const scenario = process.argv[2], root = process.env.B013_BOUNDARY_OWNED_ROOT;
const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
assert.ok(root && isAbsolute(root) && resolve(root) === root && root !== "/");
assert.equal(cwd, join(root, "workspace"));
assert.equal(home, join(root, "home"));
assert.equal(process.env.HOME, home);
const participantId = "teammate_builtin_engineer";
const observations = { externalFetches: 0, keychainAccesses: 0, runnerCalls: 0, physicalReads: 0, decisions: [], starts: 0 };
let origin, daemon, store, phase = "fixture_setup", facts, failure;

// These guards precede every product import. No inherited API key or daily Store is reachable.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!origin || url.origin !== origin) {
    observations.externalFetches++;
    throw new Error(`B013 boundary fixture refuses external fetch: ${url.origin}`);
  }
  return originalFetch(input, init);
};
for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, ...args) {
    if (["security", "/usr/bin/security"].includes(String(file))) {
      observations.keychainAccesses++;
      throw new Error("B013 boundary fixture refuses system Keychain access");
    }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();

try {
  const core = await import("../../../core/dist/index.js");
  const { createDaemonServer } = await import("../../dist/index.js");
  const paths = core.resolveStoragePaths(cwd, { userRootDir: home, env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  const denySecretAccess = () => { observations.keychainAccesses++; throw new Error("B013 boundary fixture has no external credentials"); };
  await fs.writeFile(join(cwd, "evidence.txt"), "B013 boundary owned evidence\n");
  const runner = { async runTask(options) {
    observations.runnerCalls++;
    assert.equal(scenario, "tool-deny-after-pre", "this fixture must not start a Runner for admission-only cases");
    assert.equal(resolve(options.cwd), cwd);
    assert.equal(typeof options.onApprovalRequired, "function", "use the real Host tool permission callback");
    const toolCallId = `b013_boundary_read_${options.task.id}`;
    const request = { toolCallId, toolName: "read", input: { path: "evidence.txt" }, task: options.task, cwd: options.cwd };
    options.onEvent?.({ type: "tool_start", toolName: "read", toolCallId, args: request.input });
    const decision = await options.onApprovalRequired(request);
    observations.decisions.push({ approved: decision?.approved, approvalId: decision?.approvalId, reason: decision?.reason });
    if (!decision?.approved) {
      options.onEvent?.({ type: "tool_end", toolName: "read", toolCallId, isError: true,
        result: { error: decision?.reason ?? "Host did not approve this read" } });
      throw new Error(`b013_expected_tool_denial: ${decision?.reason}`);
    }
    // A broken policy cannot be concealed by a fake success. Any allowed read is real and counted.
    observations.physicalReads++;
    const text = await fs.readFile(join(cwd, "evidence.txt"), "utf8");
    options.onEvent?.({ type: "tool_end", toolName: "read", toolCallId, isError: false,
      result: { path: "evidence.txt", content: [{ type: "text", text }] } });
    return { taskId: options.task.id, messages: [text], events: [] };
  } };
  function openOwnedStore(storeCwd = cwd) {
    assert.equal(resolve(storeCwd), cwd, "no unrelated workspace or daily database may be opened");
    return core.createSqliteRunStore(cwd, paths);
  }
  async function startDaemon() {
    assert.equal(daemon, undefined);
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      harness: { evaluations: { mode: "off" } },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, { runner, secretResolver, chromeBrowserNativeMessagingEnabled: false,
      externalSecretStore: { status: denySecretAccess, resolve: denySecretAccess, setSecret: denySecretAccess, deleteSecret: denySecretAccess },
      storeFactory(storeCwd) { store = openOwnedStore(storeCwd); return store; },
    });
    await daemon.start();
    observations.starts++;
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stopDaemon() {
    await daemon.stop();
    daemon = undefined;
    store = undefined;
    origin = undefined;
  }
  await startDaemon();
  async function createProvider(name) {
    const response = await request("/providers", { kind: "glm", displayName: `B013 boundary ${name}`,
      providerId: `b013-boundary-${name}`, model: `b013-boundary-${name}`, api: "google-generative-ai",
      authHeader: false, capabilities: ["chat", "reasoning", "tool_call"], input: ["text"], enabled: true });
    assert.equal(response.status, 201, JSON.stringify(response));
    const checked = await request(`/providers/${response.body.provider.id}/check`, {});
    assert.equal(checked.status, 200, JSON.stringify(checked));
    return response.body.provider.id;
  }
  const channelProviderId = await createProvider("channel"), stepProviderId = await createProvider("step");
  const channelResponse = await request("/channels", { name: `B013 boundary ${scenario}`, status: "active", boundPath: cwd,
    defaultProviderPresetId: channelProviderId, allowedTools: ["read"], runtimePolicy: { maxConcurrentRuns: 1,
      schedulingMode: "smart", writeLockScope: "boundPath", allowReadOnlyParallel: true, queueOnConflict: true } });
  assert.equal(channelResponse.status, 201, JSON.stringify(channelResponse));
  const channel = channelResponse.body.channel, now = new Date().toISOString();
  store.updateWorkspaceSettings({ defaultProviderPresetId: channelProviderId }, now);
  store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  assert.ok(store.getAiTeammate(participantId), "the actual builtin Engineer must exist");

  function counts() {
    return Object.fromEntries(["tasks", "run_sessions", "approval_requests"].map(table =>
      [table, Number(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
  }
  function snapshot(stepId) {
    const step = store.getChannelWorkflowStep(stepId);
    return { counts: counts(), step, workflow: store.getChannelWorkflow(step.workflowId),
      leases: store.listResourceLeases({ resourceType: "workflow_step", resourceKey: stepId, limit: 100 }),
      transitions: store.listStateTransitionEvents({ limit: 1000 }).filter(event => [stepId, step.workflowId].includes(event.entityId)),
      runnerCalls: observations.runnerCalls, physicalReads: observations.physicalReads };
  }
  function assertUnexecuted(stepId) {
    facts = snapshot(stepId);
    assert.equal(facts.counts.tasks, 0, JSON.stringify(facts));
    assert.equal(facts.counts.run_sessions, 0);
    assert.equal(facts.step.taskId, undefined);
    assert.equal(facts.step.runId, undefined);
    assert.equal(facts.step.metadata?.startOwner, undefined);
    assert.deepEqual(facts.leases, []);
    assert.equal(observations.runnerCalls, 0);
    assert.equal(observations.physicalReads, 0);
  }
  const gate = (overrides = {}) => ({ stage: "pre", title: "B013 boundary pre permission",
    reason: "Approve only the stored B013 boundary definition",
    approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["read"] }, ...overrides });
  let metadata = { autoStart: false, requiredTools: ["read"], providerPresetId: stepProviderId, requestedRunnerId: "pi",
    gates: [gate()], policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user",
      onApprovalDenied: "block_for_user", retryable: true } };
  const recoveryCases = {
    "startup-approve": { decision: "approve", step: "running", workflow: "running", stepEvent: "approval_approved", workflowEvent: "approval_approved" },
    "startup-deny": { decision: "deny", step: "blocked", workflow: "blocked", stepEvent: "blocked", workflowEvent: "step_blocked" },
    "startup-pending": { decision: "pending", step: "waiting_for_approval", workflow: "waiting_for_approval" },
    "startup-approved-projection": { decision: "approve", step: "running", workflow: "running", resolvedBeforeStart: true },
    "startup-deny-fail": { decision: "deny", policy: "fail_workflow", step: "failed", workflow: "failed", stepEvent: "fail", workflowEvent: "step_failed" },
    "startup-deny-cancel": { decision: "deny", policy: "cancel_workflow", step: "cancelled", workflow: "cancelled", stepEvent: "cancel", workflowEvent: "cancel" },
    "startup-deny-skip": { decision: "deny", policy: "skip_if_optional", step: "skipped", workflow: "running", stepEvent: "skip", workflowEvent: "approval_approved" },
    "startup-expired": { decision: "expire", step: "blocked", workflow: "blocked", stepEvent: "blocked", workflowEvent: "step_blocked" },
    "startup-cancelled": { decision: "cancel", step: "blocked", workflow: "blocked", stepEvent: "blocked", workflowEvent: "step_blocked" },
    "startup-stale-definition": { decision: "approve", step: "waiting_for_approval", workflow: "waiting_for_approval", stale: "definition" },
    "startup-missing-basis": { decision: "approve", step: "waiting_for_approval", workflow: "waiting_for_approval", stale: "basis" },
  };
  const recoveryCase = recoveryCases[scenario];
  if (recoveryCase?.policy) metadata.policy.onApprovalDenied = recoveryCase.policy;
  let expectedGate;
  if (scenario === "override-implicit-runner") delete metadata.requestedRunnerId;
  if (scenario === "override-channel-provider") delete metadata.providerPresetId;
  if (scenario === "ungated-overrides") delete metadata.gates;
  if (scenario.startsWith("select-")) {
    const builtinResponse = await request(`/channels/${channel.id}/workflows`, {
      templateId: "autoplan-lite", objective: "Inspect the real builtin profile without running it", autoStart: false });
    assert.equal(builtinResponse.status, 201, JSON.stringify(builtinResponse));
    const builtin = builtinResponse.body.workflowSteps.find(step => step.metadata.templateStepId === "implementation");
    assert.ok(builtin?.metadata.approvalGate);
    const legacy = builtin.metadata.approvalGate;
    if (scenario === "select-first-applicable") {
      metadata.approvalGate = legacy;
      metadata.gates = [gate({ stage: "post" }), gate({ approvalProfile: { mode: "none" } }),
        gate({ requiredForStatuses: [] }), gate({ requiredForStatuses: ["blocked"] }),
        gate({ title: "First applicable", reason: "Only this declarative reason",
          approvalProfile: { mode: "standard", risk: "low", requiredForTools: ["read"], requiredForActions: ["provider_change"] } }),
        gate({ title: "Later must not win", reason: "Do not merge later declarative gates",
          approvalProfile: { mode: "strict", risk: "critical", requiredForTools: ["ls"], requiredForActions: ["credential_change"] } })];
      expectedGate = { title: "First applicable", declarativeReason: "Only this declarative reason", builtinReason: true,
        mode: legacy.mode, risk: legacy.risk ?? "medium", tools: [...new Set([...(legacy.requiredForTools ?? []), "read"])],
        actions: [...new Set([...(legacy.requiredForActions ?? []), "provider_change"])] };
    } else if (scenario === "select-absent") {
      metadata.gates = [gate()];
      expectedGate = { title: "B013 boundary pre permission", declarativeReason: "Approve only the stored B013 boundary definition",
        mode: "standard", risk: "medium", tools: ["read"], actions: [] };
    } else if (scenario === "select-empty-no-builtin") metadata.gates = [gate({ requiredForStatuses: [] })];
    else if (scenario === "select-empty-with-builtin" || scenario === "select-none-with-builtin") {
      metadata.approvalGate = legacy;
      metadata.gates = scenario === "select-empty-with-builtin" ? [gate({ requiredForStatuses: [] })]
        : [gate({ approvalProfile: { mode: "none" } }), gate({ stage: "post" })];
      expectedGate = { builtinTitle: true, builtinReason: true, mode: legacy.mode, risk: legacy.risk ?? "medium",
        tools: legacy.requiredForTools ?? [], actions: legacy.requiredForActions ?? [] };
    } else if (scenario === "select-default-risk-union") {
      // Valid configured builtin-style profiles intentionally omit risk to exercise conservative defaults.
      metadata.approvalGate = { mode: "standard", requiredForTools: ["write"], requiredForActions: ["git_commit"] };
      metadata.gates = [gate({ approvalProfile: { mode: "strict", requiredForTools: ["read"], requiredForActions: ["deploy"] } })];
      expectedGate = { title: "B013 boundary pre permission", builtinReason: true,
        declarativeReason: "Approve only the stored B013 boundary definition", mode: "strict", risk: "high",
        tools: ["write", "read"], actions: ["git_commit", "deploy"] };
    } else if (scenario === "select-builtin-none") {
      metadata.approvalGate = { mode: "none", risk: "critical", requiredForTools: ["write"] };
      metadata.gates = [gate({ approvalProfile: { mode: "standard", risk: "low", requiredForTools: ["read"] } })];
      expectedGate = { title: "B013 boundary pre permission", declarativeReason: "Approve only the stored B013 boundary definition",
        mode: "standard", risk: "low", tools: ["read"], actions: [] };
    } else throw new Error(`Unknown selection scenario: ${scenario}`);
  }
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "B013 boundary owned workflow",
    objective: "Exercise real admission without remote execution", status: "ready", createdBy: "local-user" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Inspect owned evidence",
    prompt: "Read evidence.txt", toParticipantId: participantId, toParticipantLabel: "Engineer", metadata }, now);
  const start = (overrides = {}, mode = "create_task") => request(`/workflow-steps/${step.id}/start`, {
    mode, idempotencyKey: `b013-boundary:${scenario}`, ...overrides });
  function assertPending(response) {
    assertUnexecuted(step.id);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body.status, "waiting_for_approval", JSON.stringify(response));
    assert.equal(facts.step.status, "waiting_for_approval");
    assert.equal(facts.workflow.status, "waiting_for_approval");
    assert.equal(facts.counts.approval_requests, 1);
    const approval = store.getApprovalRequest(facts.step.metadata.preStepApprovalId);
    assert.equal(response.body.approval.id, approval.id);
    assert.equal(approval.status, "pending");
    assert.equal(approval.channelId, channel.id);
    assert.equal(approval.workflowStepId, step.id);
    assert.equal(approval.payload.workflowId, workflow.id);
    assert.equal(approval.payload.workflowStepId, step.id);
    assert.equal(approval.payload.gateStage, "pre");
    return approval;
  }
  async function approve(approval) {
    const response = await request(`/approvals/${approval.id}/approve`, { reason: "Explicit isolated B013 boundary decision" });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(store.getApprovalRequest(approval.id).status, "approved");
    assertUnexecuted(step.id);
  }
  function assertOneCreatedTask(response) {
    facts = snapshot(step.id);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.ok(response.body.task?.id, JSON.stringify(response));
    assert.equal(facts.step.status, "succeeded");
    assert.equal(facts.counts.tasks, 1);
    assert.equal(facts.counts.run_sessions, 0);
    assert.equal(facts.step.taskId, response.body.task.id);
    assert.equal(observations.runnerCalls, 0);
    return store.getTask(response.body.task.id);
  }

  phase = "product_assertion";
  if (scenario.startsWith("override-")) {
    const field = scenario.slice("override-".length);
    const changed = field === "implicit-runner" ? { runnerId: "pi" }
      : field === "channel-provider" ? { providerPresetId: stepProviderId }
        : { [field]: field === "providerPresetId" ? channelProviderId : field === "runnerId" ? "b013-other-runner" : "Changed definition" };
    const before = snapshot(step.id), response = await start(changed);
    facts = snapshot(step.id);
    assert.equal(response.status, 409, JSON.stringify({ response, facts }));
    assert.equal(response.body.error, "workflow_pre_approval_override_forbidden");
    assert.deepEqual(facts, before, "rejection must precede approval creation, mutation, Task, Run, owner and lease");
    assertUnexecuted(step.id);
    assert.equal(facts.counts.approval_requests, 0);
    const unchanged = scenario === "override-channel-provider" ? { providerPresetId: channelProviderId } : {};
    const approval = assertPending(await start(unchanged));
    for (const boundary of ["pending", "approved"]) {
      if (boundary === "approved") await approve(approval);
      const beforeRejected = snapshot(step.id), rejected = await start(changed);
      assert.equal(rejected.status, 409, JSON.stringify(rejected));
      assert.equal(rejected.body.error, "workflow_pre_approval_override_forbidden");
      assert.deepEqual(snapshot(step.id), beforeRejected, `${boundary} permission cannot authorize a changed request`);
      assertUnexecuted(step.id);
    }
    const task = assertOneCreatedTask(await start(unchanged));
    assert.equal(facts.step.metadata.preStepApprovalMarker.consumedByTaskId, task.id);
    assert.equal(facts.counts.approval_requests, 1);
  } else if (scenario === "equivalent-explicit" || scenario === "equivalent-omitted") {
    const overrides = scenario === "equivalent-explicit" ? { taskTitle: step.title, taskPrompt: step.prompt,
      providerPresetId: stepProviderId, runnerId: "pi" } : {};
    const approval = assertPending(await start(overrides));
    assert.equal(assertPending(await start(overrides)).id, approval.id, "equivalent pending start reuses the exact permission");
    await approve(approval);
    const task = assertOneCreatedTask(await start(overrides));
    assert.equal(task.title, step.title);
    assert.equal(task.prompt, step.prompt);
    assert.equal(facts.step.metadata.preStepApprovalMarker.consumedByTaskId, task.id);
    assert.equal(facts.counts.approval_requests, 1);
  } else if (scenario === "ungated-overrides" || scenario === "select-empty-no-builtin") {
    const overrides = scenario === "ungated-overrides" ? { taskTitle: "Ungated changed title", taskPrompt: "Ungated changed prompt",
      providerPresetId: channelProviderId, runnerId: "b013-create-task-only-runner" } : {};
    const task = assertOneCreatedTask(await start(overrides));
    assert.equal(task.title, overrides.taskTitle ?? step.title);
    assert.equal(task.prompt, overrides.taskPrompt ?? step.prompt);
    assert.equal(facts.counts.approval_requests, 0);
  } else if (scenario.startsWith("select-")) {
    const approval = assertPending(await start());
    assert.ok(expectedGate, "selection cases must declare a specific expected persisted gate");
    assert.equal(approval.title, expectedGate.builtinTitle ? `Approve workflow step: ${step.title}` : expectedGate.title);
    assert.equal(approval.risk, expectedGate.risk);
    assert.equal(approval.payload.approvalMode, expectedGate.mode);
    assert.deepEqual([...approval.payload.requiredForTools].sort(), [...expectedGate.tools].sort());
    assert.deepEqual([...approval.payload.requiredForActions].sort(), [...expectedGate.actions].sort());
    assert.equal(approval.description, [expectedGate.builtinReason
      ? `Approve starting workflow step "${step.title}" for workflow "${workflow.title}".` : undefined,
    expectedGate.declarativeReason].filter(Boolean).join("\n"));
  } else if (scenario === "tool-deny-after-pre") {
    const policy = await request("/approval-policy", { toolDecisions: { read: "deny" } }, "PATCH");
    assert.equal(policy.status, 200, JSON.stringify(policy));
    const approval = assertPending(await start({}, "create_and_run_task"));
    await approve(approval);
    const response = await start({}, "create_and_run_task");
    assert.equal(response.status, 200, JSON.stringify(response));
    await eventually(() => {
      const current = store.getChannelWorkflowStep(step.id);
      return current.runId && ["succeeded", "failed", "cancelled"].includes(store.getRun(current.runId)?.status);
    }, "tool-denial terminal Run");
    facts = snapshot(step.id);
    assert.equal(observations.runnerCalls, 1);
    assert.equal(observations.physicalReads, 0, "pre approval cannot authorize the denied physical read");
    assert.equal(observations.decisions.length, 1);
    assert.equal(observations.decisions[0].approved, false);
    assert.match(observations.decisions[0].reason, /policy denied read/);
    assert.equal(store.getRun(facts.step.runId).status, "failed");
    assert.equal(store.getApprovalRequest(approval.id).status, "approved");
    const toolApprovals = store.listApprovalRequests({ runId: facts.step.runId });
    assert.equal(toolApprovals.length, 1);
    assert.equal(toolApprovals[0].status, "denied");
    assert.notEqual(toolApprovals[0].id, approval.id);
    assert.equal(observations.decisions[0].approvalId, toolApprovals[0].id);
    assert.equal(facts.counts.tasks, 1);
    assert.equal(facts.counts.run_sessions, 1);
    assert.equal(facts.counts.approval_requests, 2);
    assert.equal(facts.step.metadata.preStepApprovalMarker.consumedByTaskId, facts.step.taskId);
    assert.ok(store.listEvents(facts.step.runId).some(event => event.type === "approval_denied"));
    assert.ok(store.listEvents(facts.step.runId).some(event => event.type === "tool_end" && event.data.isError === true));
  } else if (recoveryCase) {
    const approval = assertPending(await start());
    const originalMarker = store.getChannelWorkflowStep(step.id).metadata.preStepApprovalMarker;
    await stopDaemon();
    // Crash-window fixture uses the genuine decision API, never SQL status edits or a fake approved object.
    store = openOwnedStore();
    if (recoveryCase.stale === "definition") store.updateChannelWorkflowStep(step.id, { prompt: "Changed definition before startup" }, new Date().toISOString());
    if (recoveryCase.stale === "basis") {
      const { preStepApprovalMarker, ...oldMetadata } = store.getChannelWorkflowStep(step.id).metadata;
      store.updateChannelWorkflowStep(step.id, { metadata: oldMetadata }, new Date().toISOString());
      assert.equal(store.getChannelWorkflowStep(step.id).metadata.preStepApprovalMarker, undefined,
        "the real Store metadata replacement must create an actual missing-basis fixture");
    }
    const decidedAt = recoveryCase.decision === "expire"
      ? new Date(Date.parse(approval.expiresAt) + 1).toISOString() : new Date().toISOString();
    const decisionInput = { reason: `B013 ${recoveryCase.decision} committed before startup`, resolvedBy: "local-user" };
    const decision = recoveryCase.decision === "approve"
      ? store.approveApprovalRequest(approval.id, { ...decisionInput, decisionKind: "approve_once" }, decidedAt)
      : recoveryCase.decision === "deny" ? store.denyApprovalRequest(approval.id, decisionInput, decidedAt)
        : recoveryCase.decision === "expire" ? store.expireApprovalRequest(approval.id, decisionInput, decidedAt)
          : recoveryCase.decision === "cancel" ? store.cancelApprovalRequest(approval.id, decisionInput, decidedAt)
            : store.getApprovalRequest(approval.id);
    const approvalStatus = { approve: "approved", deny: "denied", expire: "expired", cancel: "cancelled", pending: "pending" }[recoveryCase.decision];
    assert.equal(decision?.status, approvalStatus);
    if (recoveryCase.resolvedBeforeStart) {
      const resolved = store.resolveChannelWorkflowStepPreApproval({ workflowStepId: step.id, approvalId: approval.id,
        actor: "system", now: new Date().toISOString() });
      assert.equal(resolved.status, "approved");
      assert.equal(store.getChannelWorkflowStep(step.id).status, "running");
    } else assert.equal(store.getChannelWorkflowStep(step.id).status, "waiting_for_approval", "owner callback was not executed before crash");
    const pendingEffects = store.listApprovalPostCommitEffects({ approvalId: approval.id });
    // Only Run-owned approvals have a decision_event; a pre gate has no Run yet.
    const effectIdentities = effects => effects.map(({ approvalId, effectKind, ownerKind, ownerId }) =>
      ({ approvalId, effectKind, ownerKind, ownerId }));
    const expectedEffects = recoveryCase.decision === "pending" ? []
      : [{ approvalId: approval.id, effectKind: "owner", ownerKind: "workflow_step", ownerId: step.id },
        { approvalId: approval.id, effectKind: "control_plane_event", ownerKind: undefined, ownerId: undefined }];
    assert.deepEqual(effectIdentities(pendingEffects), expectedEffects);
    assert.ok(pendingEffects.every(effect => effect.status === "pending"));
    const beforeStartup = snapshot(step.id);
    store.close();
    store = undefined;
    await startDaemon();
    assertUnexecuted(step.id);
    assert.equal(facts.step.status, recoveryCase.step);
    assert.equal(facts.workflow.status, recoveryCase.workflow);
    assert.equal(store.getApprovalRequest(approval.id).status, approvalStatus);
    assert.equal(facts.step.metadata.preStepApprovalId, approval.id, "startup never replaces the pending cycle");
    assert.deepEqual(facts.step.metadata.preStepApprovalMarker, recoveryCase.stale === "basis" ? undefined : originalMarker,
      "startup cannot consume or fabricate a pre permit");
    const priorTransitionIds = new Set(beforeStartup.transitions.map(event => event.id));
    const newTransitions = facts.transitions.filter(event => !priorTransitionIds.has(event.id));
    const transitionFacts = transitions => transitions.map(({ entityId, fromStatus, toStatus, event }) =>
      ({ entityId, fromStatus, toStatus, event })).sort((left, right) => left.entityId.localeCompare(right.entityId));
    const expectedTransitions = recoveryCase.stepEvent ? [
      { entityId: step.id, fromStatus: "waiting_for_approval", toStatus: recoveryCase.step, event: recoveryCase.stepEvent },
      { entityId: workflow.id, fromStatus: "waiting_for_approval", toStatus: recoveryCase.workflow, event: recoveryCase.workflowEvent },
    ] : [];
    assert.deepEqual(transitionFacts(newTransitions), transitionFacts(expectedTransitions),
      "startup must not write transient legacy block/fail/success states before resolving the real pre cycle");
    const settledEffects = store.listApprovalPostCommitEffects({ approvalId: approval.id });
    assert.deepEqual(effectIdentities(settledEffects), expectedEffects);
    assert.ok(settledEffects.every(effect => effect.status === "completed"), JSON.stringify(settledEffects));
    observations.recoveryEffects = { before: pendingEffects, after: settledEffects };
    const firstRecovery = snapshot(step.id);
    await stopDaemon();
    await startDaemon();
    assert.deepEqual(snapshot(step.id), firstRecovery, "second genuine startup must not duplicate or execute the admission");
    assert.deepEqual(store.listApprovalPostCommitEffects({ approvalId: approval.id }), settledEffects);
    assert.equal(observations.starts, 3);
    if (recoveryCase.decision === "approve" && !recoveryCase.stale) {
      const task = assertOneCreatedTask(await start());
      assert.equal(facts.step.metadata.preStepApprovalMarker.consumedByTaskId, task.id);
    } else if (recoveryCase.decision === "pending") {
      assert.equal(assertPending(await start()).id, approval.id);
    } else if (recoveryCase.step === "blocked") {
      const response = await start();
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.ok(response.body.blocker, "denial remains blocked on explicit start");
      assertUnexecuted(step.id);
    } else if (recoveryCase.stale) {
      const response = await start();
      assert.equal(response.status, 409, JSON.stringify(response));
      assert.equal(response.body.error, "workflow_pre_approval_basis_stale");
      assertUnexecuted(step.id);
      assert.equal(facts.step.status, "blocked", "only explicit admission retires a stale active cycle");
    }
    assert.equal(counts().approval_requests, 1);
  } else throw new Error(`Unknown B013 boundary scenario: ${scenario}`);
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  if (daemon) {
    try { await daemon.stop(); } catch (error) { failure ??= { name: error.name, message: `cleanup: ${error.message}` }; }
  } else if (store) store.close();
}
process.stdout.write(`B013_BOUNDARY_RESULT ${JSON.stringify({ ok: !failure, phase, scenario, ...observations, facts, failure })}\n`);

async function request(path, body, method = "POST") {
  const response = await fetch(`${origin}${path}?cwd=${encodeURIComponent(cwd)}`, { method,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await response.text(), contentType = response.headers.get("content-type") ?? "";
  return { status: response.status, contentType, body: contentType.includes("text/event-stream") ? { sse: text } : JSON.parse(text) };
}

async function eventually(check, label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`B013 boundary timed out observing ${label}`);
}
