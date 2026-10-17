import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const scenario = process.argv[2], root = process.env.B013_OWNED_ROOT;
const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
assert.ok(root && isAbsolute(root) && resolve(root) === root && root !== "/");
assert.equal(cwd, join(root, "workspace"));
assert.equal(home, join(root, "home"));
assert.equal(process.env.HOME, home);
const observations = { externalFetches: 0, keychainAccesses: 0, runnerCalls: 0 };
let origin, daemon, store, phase = "fixture_setup", facts, failure;

// Installed before product imports. A fixture defect must never reach credentials or a remote model.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!origin || url.origin !== origin) {
    observations.externalFetches++;
    throw new Error(`B013 refuses non-loopback Daemon fetch: ${url.origin}`);
  }
  return originalFetch(input, init);
};
for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, ...args) {
    if (String(file) === "/usr/bin/security" || String(file) === "security") {
      observations.keychainAccesses++;
      throw new Error("B013 refuses system Keychain access");
    }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();

try {
  const core = await import("../../../core/dist/index.js");
  const contracts = await import("../../../contracts/dist/index.js");
  const { createDaemonServer } = await import("../../dist/index.js");
  const { b013Gate, b013FactCounts, b013ParticipantId: participantId } = await import("../../../core/test/support/b013-pre-gate-fixture.mjs");
  const { appendChannelItemFixture } = await import("../../../core/test/channel-conversation-fixture.mjs");
  const { confirmChannelExecutionProposalWorkflow } = await import("../../dist/features/channels/proposal-workflows.js");
  const { resolveProviderForRun } = await import("../../dist/features/runs/providers.js");
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  const denySecretAccess = () => { observations.keychainAccesses++; throw new Error("B013 has no external credentials"); };
  const paths = core.resolveStoragePaths(cwd, { userRootDir: home, env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  await fs.writeFile(join(cwd, "evidence.txt"), "B013 owned local evidence\n");
  const runner = { async runTask(options) {
    observations.runnerCalls++;
    const toolCallId = `b013_read_${options.task.id}`;
    options.onEvent?.({ type: "tool_start", toolName: "read", toolCallId, args: { path: "evidence.txt" } });
    const text = await fs.readFile(join(cwd, "evidence.txt"), "utf8");
    options.onEvent?.({ type: "tool_end", toolName: "read", toolCallId, isError: false,
      result: { path: "evidence.txt", content: [{ type: "text", text }] } });
    const message = "Read B013 owned evidence successfully.";
    options.onEvent?.({ type: "assistant_text_delta", text: message });
    return { taskId: options.task.id, messages: [message], events: [] };
  } };
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
    harness: { evaluations: { mode: "off" } },
    cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
  }, { runner, secretResolver, chromeBrowserNativeMessagingEnabled: false,
    externalSecretStore: { status: denySecretAccess, resolve: denySecretAccess, setSecret: denySecretAccess, deleteSecret: denySecretAccess },
    storeFactory(storeCwd) {
      assert.equal(resolve(storeCwd), cwd, "B013 cannot open any daily or other workspace Store");
      store = core.createSqliteRunStore(cwd, paths);
      return store;
    },
  });
  // Startup recovery sees no fixture work; all workflows below are created only after startup.
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const provider = await request("/providers", { kind: "glm", displayName: "B013 static nontransport",
    providerId: "b013-static", model: "b013-static", api: "google-generative-ai", authHeader: false,
    capabilities: ["chat", "reasoning", "tool_call"], input: ["text"], enabled: true });
  assert.equal(provider.status, 201, JSON.stringify(provider));
  const providerId = provider.body.provider.id;
  const checked = await request(`/providers/${providerId}/check`, {});
  assert.equal(checked.status, 200, JSON.stringify(checked));
  const channelResponse = await request("/channels", { name: `B013 ${scenario}`, status: "active", boundPath: cwd,
    defaultProviderPresetId: providerId, allowedTools: ["read"], runtimePolicy: { maxConcurrentRuns: 1,
      schedulingMode: "smart", writeLockScope: "boundPath", allowReadOnlyParallel: true, queueOnConflict: true } });
  assert.equal(channelResponse.status, 201, JSON.stringify(channelResponse));
  const channel = channelResponse.body.channel, now = new Date().toISOString();
  store.updateWorkspaceSettings({ defaultProviderPresetId: providerId }, now);
  store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  assert.ok(store.getAiTeammate(participantId), "fixture requires the actual builtin participant");

  function snapshot(stepId) {
    return { counts: b013FactCounts(store), step: store.getChannelWorkflowStep(stepId),
      leases: store.listResourceLeases({ resourceType: "workflow_step", resourceKey: stepId, limit: 100 }),
      runnerCalls: observations.runnerCalls };
  }
  async function compile(body) {
    const response = await request(`/channels/${channel.id}/workflows`, body);
    assert.equal(response.status, 201, JSON.stringify(response));
    assert.ok(response.body.workflow?.id);
    assert.ok(response.body.workflowSteps?.length);
    return response.body;
  }
  function assertPending(response, stepId) {
    facts = snapshot(stepId);
    assert.equal(facts.counts.tasks, 0, `pre approval bypass created a Task: ${JSON.stringify({ response, facts })}`);
    assert.equal(facts.counts.run_sessions, 0);
    assert.equal(facts.runnerCalls, 0);
    assert.equal(facts.step.taskId, undefined);
    assert.equal(facts.step.runId, undefined);
    assert.equal(facts.step.metadata?.startOwner, undefined);
    assert.deepEqual(facts.leases, [], "pending must not acquire an execution lease even temporarily");
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body.status, "waiting_for_approval", JSON.stringify(response));
    assert.equal(facts.step.status, "waiting_for_approval");
    assert.equal(store.getChannelWorkflow(facts.step.workflowId).status, "waiting_for_approval");
    assert.equal(facts.counts.approval_requests, 1);
    const approvalId = facts.step.metadata.preStepApprovalId;
    const approval = store.getApprovalRequest(approvalId);
    assert.equal(response.body.approval.id, approvalId);
    assert.equal(approval.status, "pending");
    assert.equal(approval.channelId, channel.id);
    assert.equal(approval.workflowStepId, stepId);
    assert.equal(approval.payload.workflowStepId, stepId);
    assert.equal(approval.payload.workflowId, facts.step.workflowId);
    assert.equal(approval.payload.gateStage, "pre");
    return approvalId;
  }

  if (scenario === "proposal-confirm") {
    // Exercise the actual confirmation compiler, which owns confirmUnsafeAutoStart:true internally.
    // This positive does not claim a whole delegated workflow or GUI acceptance has completed.
    const source = appendChannelItemFixture(store, { channelId: channel.id,
      authorType: "local-user", body: "Read evidence.txt with Engineer" }, now);
    const proposal = store.createChannelExecutionProposal({ channelId: channel.id, sourceMessageId: source.id,
      proposedByTeammateId: "ling_agent", title: "B013 read proposal", prompt: "Read evidence.txt",
      assigneeTeammateId: participantId, collaborationSteps: [{ teammateId: participantId,
        action: "coordinated", summary: "Read the owned evidence" }], requiredTools: ["read"], status: "draft" }, now);
    const item = store.getConversationItem(source.id), assignment = store.getEffectiveTurnContextAssignment(item.turnId);
    assert.ok(assignment);
    store.createChannelIntentDecision({ channelId: channel.id, sourceItemId: item.id, contextProjection: {
      projectionVersion: `projection:${item.id}:${assignment.revision}`,
      sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
      threadId: item.threadId, turnId: item.turnId, segmentId: assignment.segmentId,
      throughItemSequence: item.sequence, summaryIds: [], sourceRefs: [{ type: "thread", id: item.threadId },
        { type: "turn", id: item.turnId }, { type: "conversation_item", id: item.id }],
      policyVersion: "b013-fixture-v1", visibilityFingerprint: "channel_shared",
    }, action: "workflow_proposal", selectedTeammateIds: [participantId],
    participantManifest: contracts.createRequiredParticipantManifestV1([{ participantId, role: "engineer",
      requirement: "required", expectedOutcome: "execution", requiredOperationIds: [], requestedBy: "explicit_role" }]),
    proposalId: proposal.id, reason: "B013 explicit participant", status: "accepted", createdBy: "deterministic" }, now);
    phase = "product_assertion";
    const confirmed = confirmChannelExecutionProposalWorkflow({ store, cwd, proposalId: proposal.id,
      validateRunRequest: candidate => { resolveProviderForRun(store, candidate, secretResolver); }, now });
    facts = snapshot(confirmed.workflowSteps[0].id);
    assert.equal(confirmed.proposal.status, "accepted");
    assert.equal(confirmed.proposal.linkedWorkflowId, confirmed.workflow.id);
    assert.equal(confirmed.workflow.metadata.sourceProposalId, proposal.id);
    assert.equal(confirmed.workflowSteps[0].metadata.autoStart, true);
    assert.equal(confirmed.workflowSteps[0].metadata.providerBinding.providerPresetId, providerId);
    assert.equal(facts.counts.tasks, 0);
    assert.equal(facts.counts.run_sessions, 0);
    assert.equal(observations.runnerCalls, 0);
  } else {
    let compiled;
    if (scenario === "builtin-legacy-pre") {
      const builtin = await compile({ templateId: "autoplan-lite", objective: "B013 builtin profile provenance", autoStart: false });
      const original = builtin.workflowSteps.find(step => step.metadata.templateStepId === "implementation");
      assert.ok(original?.metadata.approvalGate);
      // Single-step fixture reuses the unmodified real compiler profile, not fake success of builtin predecessors.
      const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "B013 builtin profile only",
        objective: "Read with the actual builtin pre profile", status: "ready", createdBy: "local-user" }, now);
      const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Inspect", prompt: "Read evidence.txt",
        toParticipantId: participantId, toParticipantLabel: "Engineer", participantAuthority: original.participantAuthority,
        metadata: { approvalGate: original.metadata.approvalGate, autoStart: true, requiredTools: ["read"], providerPresetId: providerId,
          policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true } } }, now);
      assert.deepEqual(step.metadata.approvalGate, original.metadata.approvalGate);
      compiled = { workflow, workflowSteps: [step] };
    } else {
      const options = scenario === "manual-none" ? { mode: "none" }
        : scenario === "advance-post" ? { stage: "post" }
        : scenario === "advance-inapplicable" ? { statuses: ["blocked"] }
        : scenario === "advance-empty" ? { statuses: [] }
        : ["advance-queued-pre", "advance-approve-queued-pre"].includes(scenario) ? { statuses: ["queued"] }
        : ["retry-blocked-pre", "retry-approve-blocked-pre"].includes(scenario) ? { statuses: ["blocked"] } : {};
      compiled = await compile({ objective: "B013 real pre-gate public entry", autoStart: true, confirmUnsafeAutoStart: true,
        providerPresetId: providerId, workflowGraph: { schemaVersion: 1, id: "b013-http-graph", name: "B013 HTTP graph",
          entryNodeId: "inspect", nodes: [{ id: "inspect", kind: "step", name: "Inspect", prompt: "Read evidence.txt",
            teammateId: participantId, requiredTools: ["read"], gates: [b013Gate(options)] }], edges: [],
          termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } } });
    }
    const step = compiled.workflowSteps[0];
    if (scenario.startsWith("retry-")) {
      // A valid unexecuted blocked definition, formed through the real step state machine; no invented Run outcome.
      for (const [expectedStatus, event] of [["queued", "claim"], ["claimed", "start"], ["running", "blocked"]]) {
        const moved = store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus, event,
          actor: "system", reason: "B013 unexecuted retry fixture", now: new Date().toISOString() });
        assert.equal(moved.ok, true, JSON.stringify(moved));
      }
    }
    const call = () => scenario.startsWith("manual-")
      ? request(`/workflow-steps/${step.id}/start`, { mode: scenario === "manual-task-pre" ? "create_task" : "create_and_run_task",
          providerPresetId: providerId, idempotencyKey: `b013:${scenario}` })
      : scenario.startsWith("retry-") ? request(`/workflow-steps/${step.id}/retry`, {})
        : request(`/workflows/${compiled.workflow.id}/orchestrate`, {});
    phase = "product_assertion";
    const response = await call();
    facts = snapshot(step.id);
    const positive = ["manual-none", "advance-post", "advance-inapplicable", "advance-empty"].includes(scenario);
    if (positive) {
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(facts.counts.tasks, 1, JSON.stringify({ response, facts }));
      assert.equal(facts.counts.run_sessions, 1, JSON.stringify({ response, facts }));
      const runId = store.getChannelWorkflowStep(step.id).runId;
      await eventually(() => observations.runnerCalls === 1 && ["succeeded", "failed", "cancelled"].includes(store.getRun(runId)?.status), "local read runner terminal");
      const run = store.getRun(runId);
      assert.equal(run.status, "succeeded", JSON.stringify(run));
      assert.ok(store.listEvents(run.id).some(event => event.type === "tool_end"), "positive control needs real local-read execution evidence");
      facts = snapshot(step.id);
    } else {
      const approvalId = assertPending(response, step.id);
      if (scenario === "advance-pre-repeat") {
        const repeated = await call();
        assert.equal(assertPending(repeated, step.id), approvalId, "same pending request must not mint another approval");
      }
      if (scenario.includes("-approve-")) {
        const approved = await request(`/approvals/${approvalId}/approve`, { reason: "B013 explicit local approval" });
        assert.equal(approved.status, 200, JSON.stringify(approved));
        assert.equal(store.getApprovalRequest(approvalId).status, "approved");
        // Resolution is not execution. A subsequent explicit Start/Advance consumes this exact permit.
        const allowed = scenario.startsWith("retry-")
          ? await request(`/workflow-steps/${step.id}/start`, { mode: "create_and_run_task", providerPresetId: providerId,
              idempotencyKey: `b013:${scenario}:approved` })
          : await call();
        assert.equal(allowed.status, 200, JSON.stringify(allowed));
        await eventually(() => observations.runnerCalls === 1 && Boolean(store.getChannelWorkflowStep(step.id)?.runId), "approved Run linkage");
        const runId = store.getChannelWorkflowStep(step.id).runId;
        await eventually(() => ["succeeded", "failed", "cancelled"].includes(store.getRun(runId)?.status), "approved local read terminal");
        const current = store.getChannelWorkflowStep(step.id), run = store.getRun(runId);
        assert.equal(run.status, "succeeded", JSON.stringify(run));
        assert.equal(current.metadata.preStepApprovalId, approvalId);
        assert.equal(current.metadata.preStepApprovalMarker?.consumedByTaskId, current.taskId,
          "the persisted permit must identify the one Task that consumed it");
        assert.equal(store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id, limit: 100 })
          .some(event => event.event === "approval_approved" && event.actor === "local-user"), true,
        "an explicit local approval must remain a local-user audit fact");
        assert.equal(b013FactCounts(store).tasks, 1);
        assert.equal(b013FactCounts(store).run_sessions, 1);
        assert.equal(b013FactCounts(store).approval_requests, 1);
        assert.equal(observations.runnerCalls, 1);
        assert.ok(store.listEvents(runId).some(event => event.type === "tool_end"), "approved path needs actual owned-file evidence");
        facts = snapshot(step.id);
      }
      if (scenario.includes("-deny-")) {
        const denied = await request(`/approvals/${approvalId}/deny`, { reason: "B013 explicit local denial" });
        assert.equal(denied.status, 200, JSON.stringify(denied));
        assert.equal(store.getApprovalRequest(approvalId).status, "denied");
        const current = store.getChannelWorkflowStep(step.id);
        assert.equal(current.status, "blocked");
        assert.equal(current.taskId, undefined);
        assert.equal(current.runId, undefined);
        assert.equal(current.metadata?.startOwner, undefined);
        assert.equal(store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id, limit: 100 })
          .some(event => event.event === "blocked" && event.actor === "local-user"), true,
        "an explicit local denial must remain a local-user audit fact");
        assert.equal(b013FactCounts(store).tasks, 0);
        assert.equal(b013FactCounts(store).run_sessions, 0);
        assert.equal(b013FactCounts(store).approval_requests, 1);
        assert.equal(observations.runnerCalls, 0);
        assert.deepEqual(snapshot(step.id).leases, []);
        facts = snapshot(step.id);
      }
      if (scenario === "manual-stale-definition-pre") {
        store.updateChannelWorkflowStep(step.id, { prompt: "Changed definition: do not reuse the old pre approval" }, new Date().toISOString());
        await request(`/approvals/${approvalId}/approve`, { reason: "B013 decision refers only to the original definition" });
        const repeated = await call();
        assert.notEqual(repeated.body.status, "started");
        assert.equal(b013FactCounts(store).tasks, 0, "an approval for the old definition cannot create a Task");
        assert.equal(b013FactCounts(store).run_sessions, 0);
        assert.equal(observations.runnerCalls, 0);
        assert.equal(store.getChannelWorkflowStep(step.id).metadata?.startOwner, undefined);
        facts = snapshot(step.id);
      }
    }
  }
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  if (daemon) {
    try { await daemon.stop(); } catch (error) { failure ??= { name: error.name, message: `cleanup: ${error.message}` }; }
  } else if (store) store.close();
}
process.stdout.write(`B013_RESULT ${JSON.stringify({ ok: !failure, phase, scenario, ...observations, facts, failure })}\n`);

async function request(path, body) {
  const response = await fetch(`${origin}${path}?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text(), contentType = response.headers.get("content-type") ?? "";
  return { status: response.status, contentType,
    body: contentType.includes("text/event-stream") ? { sse: text } : JSON.parse(text) };
}

async function eventually(check, label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`B013 timed out observing ${label}`);
}
