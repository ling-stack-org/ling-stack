import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  channelWorkflowStatuses, channelWorkflowStepStatuses, createSqliteRunStore,
  DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence,
} from "../../core/dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { finalizeOrchestratedWorkflowStepRun } from "../dist/features/channels/orchestrator.js";
import {
  readOptionalChannelWorkflowStatusQuery, readOptionalChannelWorkflowStepStatusQuery,
} from "../dist/features/channels/schemas.js";
import {
  handleChannelWorkflowsCollection, handleChannelWorkflowStepsCollection,
} from "../dist/features/channels/workflows.js";
import {
  compileWorkflowTemplate, parseWorkflowTemplateCompileRequest,
} from "../dist/features/channels/workflow-templates.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const participantId = "teammate_builtin_engineer";
const stepStatuses = ["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input",
  "blocked", "succeeded", "failed", "skipped", "cancelled"];
const workflowStatuses = ["draft", "ready", "running", "waiting_for_approval", "waiting_for_input",
  "blocked", "succeeded", "failed", "cancelled"];

/** Owned explicit paths and an in-process registry; no HTTP server or model transport. */
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b008-status-gate-")));
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  const stores = new RunStoreRegistry(storeCwd => {
    assert.equal(storeCwd, cwd);
    return createSqliteRunStore(cwd, paths);
  });
  const store = stores.getStore(cwd);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd });
  const supervisor = new RuntimeSupervisor(config);
  // Initialize before constructing active fixture work, not as a simulated restart.
  supervisor.getRuntime(cwd, store);
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b008-status-gate-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "B008 status gate", boundPath: cwd, allowedTools: ["read"] }, new Date().toISOString());
  return { cwd, paths, stores, store, config, supervisor, channel };
}

function gate(requiredForStatuses) {
  return { stage: "post", approvalProfile: { mode: "standard", risk: "medium" },
    title: "Review a matching result", reason: "B008 explicit post gate",
    ...(requiredForStatuses === undefined ? {} : { requiredForStatuses }) };
}

function definition(kind, requiredForStatuses) {
  const step = { id: "inspect", name: "Inspect", prompt: "Read evidence.txt", teammateId: participantId,
    gates: [gate(requiredForStatuses)] };
  return { objective: "Read the owned B008 evidence", autoStart: false,
    ...(kind === "graph" ? { workflowGraph: { schemaVersion: 1, id: "b008-graph", name: "B008 graph",
      entryNodeId: step.id, nodes: [{ ...step, kind: "step", requiredTools: ["read"] }], edges: [],
      termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } } }
      : { customTemplate: { schemaVersion: 1, id: "b008-template", name: "B008 template", steps: [step] } }) };
}

function compile(f, kind, statuses) {
  return compileWorkflowTemplate(f.store,
    parseWorkflowTemplateCompileRequest(definition(kind, statuses), f.channel.id), new Date().toISOString());
}

function durableState(store) {
  return Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions",
    "approval_requests", "artifacts", "state_transition_events", "conversation_items"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

/** Actual GET handler with a response sink, not a replacement schema or fake Store. */
async function getCollection(f, kind, workflowId, status) {
  const response = { statusCode: undefined, body: undefined, setHeader() {},
    writeHead(code) { this.statusCode = code; }, end(text) { this.body = JSON.parse(text); } };
  const query = new URLSearchParams({ cwd: f.cwd, ...(status === undefined ? {} : { status }) });
  const request = { method: "GET", headers: { host: "b008.invalid" }, url: `/?${query}` };
  if (kind === "workflow") await handleChannelWorkflowsCollection(request, response, f.config, f.stores, f.channel.id);
  else await handleChannelWorkflowStepsCollection(request, response, f.config, f.stores, workflowId);
  return response;
}

test("B008 runtime status lists and query readers include the exact legal closed sets", () => {
  assert.deepEqual(channelWorkflowStatuses, workflowStatuses);
  assert.deepEqual(channelWorkflowStepStatuses, stepStatuses);
  for (const [read, statuses] of [[readOptionalChannelWorkflowStatusQuery, workflowStatuses],
    [readOptionalChannelWorkflowStepStatusQuery, stepStatuses]]) {
    assert.equal(read(new URL("http://b008.invalid"), "status"), undefined);
    for (const status of statuses) assert.equal(read(new URL(`http://b008.invalid/?status=${status}`), "status"), status);
    for (const status of ["", "unknown", "WAITING_FOR_INPUT", "waiting_for_inputs"]) {
      assert.throws(() => read(new URL(`http://b008.invalid/?status=${status}`), "status"), /must be one of/u);
    }
  }
});

test("B008 real Host yield remains queryable as waiting_for_input through both collection handlers", async t => {
  const f = await fixture(t), now = new Date().toISOString();
  const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Await a choice", objective: "Ask safely",
    status: "running", createdBy: "local-user" }, now);
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Ask", prompt: "Ask safely",
    toParticipantId: participantId, toParticipantLabel: "Engineer", status: "running" }, now);
  const thread = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: f.channel.id,
    title: "B008 waiting", objective: "Ask safely" }, now).thread;
  const turn = f.store.appendConversationUserTurn({ threadId: thread.id, channelId: f.channel.id,
    title: "B008 waiting", userInstruction: "Ask safely", idempotencyKey: "b008-source",
    payload: { body: "Ask safely", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", channelId: f.channel.id,
    teammateId: participantId, ownerType: "run", ownerId: "b008-wait-run", status: "running",
    idempotencyKey: "b008-wait-unit", createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "b008-wait-runtime", runnerId: "runner_fixture", status: "started", now });
  const run = f.store.createRun({ id: "b008-wait-run", cwd: f.cwd, taskId: "b008-unstored-task", channelId: f.channel.id,
    threadId: thread.id, turnId: turn.turnId, teammateId: participantId, workflowStepId: step.id, workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now }).ok, true);
  f.store.updateChannelWorkflowStep(step.id, { runId: run.id }, now);
  const input = f.store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id,
    sourceFence: toRuntimeAttemptFence(attempt), toolCallId: "b008-ask", idempotencyKey: "b008-ask",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [{ questionId: "choice", prompt: "Choose",
      required: true, allowFreeText: true, options: [] }] } }, now).request;
  f.store.commitUserInputYield({ threadId: thread.id, requestId: input.requestId, expectedRequestVersion: 1,
    sourceFence: toRuntimeAttemptFence(attempt), quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId,
      stoppedAt: now, lastRunEventSeq: 0 } }, now);
  assert.equal(f.store.getRun(run.id).status, "yielded");
  assert.equal(f.store.getChannelWorkflowStep(step.id).status, "waiting_for_input");
  // Parent aggregation is not part of commitUserInputYield; use its lawful state-machine transition.
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: workflow.id, expectedStatus: "running",
    event: "user_input_requested", actor: "system", now }).ok, true);
  for (const [kind, key, id] of [["workflow", "workflows", workflow.id], ["step", "workflowSteps", step.id]]) {
    const before = durableState(f.store);
    const response = await getCollection(f, kind, workflow.id, "waiting_for_input");
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body[key].map(item => item.id), [id]);
    const invalid = await getCollection(f, kind, workflow.id, "not_a_status");
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.error, "bad_request");
    assert.deepEqual(durableState(f.store), before, "GET validation must not mutate the wait");
  }
});

for (const kind of ["graph", "custom"]) {
  for (const [label, statuses] of [["waiting", ["waiting_for_input"]], ["complete legal set", stepStatuses],
    ["absent", undefined], ["empty", []]]) {
    test(`B008 ${kind} compile and SQLite reopen preserve ${label} gate scope`, async t => {
      const f = await fixture(t), compiled = compile(f, kind, statuses), step = compiled.workflowSteps[0];
      assert.deepEqual(step.metadata.gates[0].requiredForStatuses, statuses);
      const reopened = createSqliteRunStore(f.cwd, f.paths);
      try { assert.deepEqual(reopened.getChannelWorkflowStep(step.id).metadata.gates[0].requiredForStatuses, statuses); }
      finally { reopened.close(); }
    });
  }
  for (const [label, statuses] of [["unknown", ["not_a_status"]], ["mixed", ["succeeded", "not_a_status"]],
    ["non-string", ["succeeded", 7]], ["null", null], ["scalar", "succeeded"], ["blank", [""]]]) {
    test(`B008 ${kind} rejects ${label} gate scope before compile writes`, async t => {
      const f = await fixture(t), before = durableState(f.store);
      assert.throws(() => {
        const input = parseWorkflowTemplateCompileRequest(definition(kind, statuses), f.channel.id);
        compileWorkflowTemplate(f.store, input, new Date().toISOString());
      }, /requiredForStatuses/u);
      assert.deepEqual(durableState(f.store), before);
    });
  }
}

/** Real Host execution; the fixture runner actually reads the owned local file. */
async function successfulGeneration(f, compiled) {
  const now = new Date().toISOString(), step = compiled.workflowSteps[0];
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: compiled.workflow.id, expectedStatus: "ready",
    event: "start", actor: "system", now }).ok, true);
  const lease = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workflow_step", resourceKey: step.id,
    ownerType: "workflow_step", ownerId: step.id, acquiredAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const begun = f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id, expected: f.store.getChannelWorkflowStep(step.id),
    leaseId: lease.id, task: { channelId: f.channel.id, assigneeTeammateId: participantId, title: "Read B008", prompt: "Read evidence.txt" }, now });
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  await fs.writeFile(join(f.cwd, "evidence.txt"), "B008 owned read evidence\n");
  let runnerCalls = 0;
  const runners = createRunnerRegistry([{ id: "runner_fixture", aliases: ["pi"], displayName: "B008 local read fixture", status: "enabled",
    adapter: { async runTask(options) {
      runnerCalls++;
      options.onEvent?.({ type: "tool_start", toolName: "read", toolCallId: "b008-read", args: { path: "evidence.txt" } });
      const text = await fs.readFile(join(f.cwd, "evidence.txt"), "utf8");
      options.onEvent?.({ type: "tool_end", toolName: "read", toolCallId: "b008-read", isError: false,
        result: { content: [{ type: "text", text }] } });
      const message = "Read the owned evidence file successfully.";
      options.onEvent?.({ type: "assistant_text_delta", text: message });
      return { taskId: options.task.id, messages: [message], events: [] };
    } } }]);
  const runId = await executeRunRequest({ cwd: f.cwd, workspaceCwd: f.cwd, channelId: f.channel.id,
    teammateId: participantId, workflowStepId: step.id, workflowStartOwner: begun.owner, task: begun.task,
    tools: ["read"], workspaceAccessMode: "read_only", authorizationMode: "always",
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://b008.invalid/v1", apiKey: "fixture-no-network" },
    idempotencyKey: "b008-run", createdByActor: "local-user" }, createDetachedRunExecutionSink(), runners,
    f.stores, new ActiveRunRegistry(), f.supervisor, { resolve: () => undefined }, {});
  assert.ok(runId, "fixture Host execution must return a Run id");
  const run = f.store.getRun(runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  assert.equal(runnerCalls, 1);
  assert.ok(f.store.listEvents(runId).some(event => event.type === "tool_end"));
  return { step, task: begun.task, run };
}

for (const [label, statuses, expectedApproval] of [["waiting only", ["waiting_for_input"], false],
  ["empty", [], false], ["absent", undefined, true], ["succeeded only", ["succeeded"], true]]) {
  test(`B008 compile → SQLite → actual Host success → post selector keeps ${label} scope`, async t => {
    const f = await fixture(t), compiled = compile(f, "graph", statuses);
    const generation = await successfulGeneration(f, compiled);
    const final = finalizeOrchestratedWorkflowStepRun(f.store, generation.step.id, generation.task.id, generation.run, new Date().toISOString());
    assert.equal(final.status, expectedApproval ? "waiting_for_approval" : "succeeded");
    assert.equal(Boolean(final.metadata.postStepApprovalId), expectedApproval);
    const approvals = f.store.database.prepare("SELECT * FROM approval_requests WHERE workflow_step_id=?").all(final.id);
    assert.equal(approvals.length, expectedApproval ? 1 : 0);
  });
}

for (const [label, statuses] of [["unknown", ["not_a_status"]], ["mixed", ["succeeded", "not_a_status"]],
  ["non-string", [7]], ["null", null], ["scalar", "succeeded"]]) {
  test(`B008 persisted ${label} scope is observable and cannot broaden a post gate`, async t => {
    const f = await fixture(t), compiled = compile(f, "graph", ["succeeded"]);
    const generation = await successfulGeneration(f, compiled);
    const raw = f.store.database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id=?").get(generation.step.id);
    const metadata = JSON.parse(raw.metadata_json);
    metadata.gates[0].requiredForStatuses = statuses;
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), generation.step.id);
    const before = durableState(f.store);
    assert.throws(() => f.store.getChannelWorkflowStep(generation.step.id), /workflow_step_gate_statuses_invalid/u);
    assert.throws(() => finalizeOrchestratedWorkflowStepRun(f.store, generation.step.id, generation.task.id,
      generation.run, new Date().toISOString()), /workflow_step_gate_statuses_invalid/u);
    assert.deepEqual(durableState(f.store), before, "invalid scope cannot add approval, state or audit facts");
    const reopened = createSqliteRunStore(f.cwd, f.paths);
    try { assert.throws(() => reopened.getChannelWorkflowStep(generation.step.id), /workflow_step_gate_statuses_invalid/u); }
    finally { reopened.close(); }
  });
}
