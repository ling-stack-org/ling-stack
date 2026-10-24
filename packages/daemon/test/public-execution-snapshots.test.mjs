import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { projectPublicRunSession, projectPublicWorkUnit } from "../dist/features/runs/public-execution-snapshots.js";
import { handleGetRun, handleListRuns, handleCancelRunRequest } from "../dist/features/runs/routes.js";
import { handleListWorkUnits, handleListRuntimeActive, handleListRuntimeStuck, handleWorkUnitRoute } from "../dist/runtime/routes.js";
import { userInputTranscriptFixture, claimedAt } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { prepareUserInputContinuationRequest } from "../dist/features/runs/user-input-prepared-request.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";
import { handleTeammateDirectRuntime, handleTeammateDirectInterventions,
  handleTeammateDirectInterventionPromote, handleTeammateDirectReplyCancel } from "../dist/features/teammates/direct-controls.js";

const privateCanary = "owner-only-memory-body-public-projection-canary";
const timestamp = "2026-01-01T00:00:00.000Z";

function fixtures() {
  const request = {
    task: { id: "task_one", title: "Public task", prompt: "Accepted objective" },
    workflowStepId: "step_one",
    runnerResolution: { effectiveRunnerId: "pi" },
    contextProjection: { sourceRefs: [{ type: "message", id: "message_one" }] },
    systemPrompt: privateCanary,
    appendSystemPrompt: [privateCanary],
    runnerExecutionInput: {
      input: { appendSystemPrompt: [privateCanary] },
      preparedInput: { systemPrompt: privateCanary },
    },
    preselectedMemoryUse: { memoryIds: ["memory_one"], renderedPrompt: privateCanary },
    // These are public domain data, not recovery input. Do not filter by key recursively.
    userPayload: { runnerExecutionInput: "ordinary user field", preselectedMemoryUse: "ordinary user field",
      systemPrompt: "ordinary user field", appendSystemPrompt: ["ordinary user field"],
      task: { prompt: "ordinary user field" } },
  };
  const run = {
    id: "run_one", taskId: "task_one", cwd: "/isolated-workspace", workflowStepId: "step_one",
    status: "running", workUnitId: "work_one", taskSnapshot: request.task,
    requestSnapshot: request, providerSnapshot: { model: "fixture" },
    createdAt: timestamp, updatedAt: timestamp,
  };
  const workUnit = {
    id: "work_one", kind: "task_run", status: "running", request,
    linkedRunId: run.id, timeoutPolicy: { heartbeatTimeoutMs: 1, idleTimeoutMs: 1, hardTimeoutMs: 1 },
    createdAt: timestamp, updatedAt: timestamp,
  };
  return { request, run, workUnit };
}

test("public snapshots omit only internal recovery input without mutating accepted execution", () => {
  const { request, run, workUnit } = fixtures();
  const before = structuredClone({ run, workUnit });
  const publicRun = projectPublicRunSession(run);
  const publicWorkUnit = projectPublicWorkUnit(workUnit);
  assert.doesNotMatch(JSON.stringify({ publicRun, publicWorkUnit }), new RegExp(privateCanary, "u"));
  assert.equal(publicRun.requestSnapshot.runnerExecutionInput, undefined);
  assert.equal(publicRun.requestSnapshot.preselectedMemoryUse, undefined);
  assert.equal(publicRun.requestSnapshot.systemPrompt, undefined);
  assert.equal(publicRun.requestSnapshot.appendSystemPrompt, undefined);
  assert.equal(publicWorkUnit.request.runnerExecutionInput, undefined);
  assert.deepEqual(publicRun.taskSnapshot, { id: request.task.id, title: request.task.title });
  assert.deepEqual(publicRun.requestSnapshot.task, publicRun.taskSnapshot);
  assert.deepEqual(publicWorkUnit.request.task, publicRun.taskSnapshot);
  assert.deepEqual(publicRun.requestSnapshot.runnerResolution, request.runnerResolution);
  assert.deepEqual(publicRun.requestSnapshot.contextProjection, request.contextProjection);
  assert.deepEqual(publicRun.requestSnapshot.userPayload, request.userPayload);
  assert.deepEqual({ run, workUnit }, before);
  assert.match(JSON.stringify(run.requestSnapshot.runnerExecutionInput), new RegExp(privateCanary, "u"));
  assert.notEqual(publicRun, run);
  assert.notEqual(publicRun.requestSnapshot, run.requestSnapshot);
  assert.notEqual(publicWorkUnit.request, workUnit.request);
  assert.deepEqual(projectPublicRunSession(publicRun), publicRun);
  assert.deepEqual(projectPublicWorkUnit(publicWorkUnit), publicWorkUnit);
});

test("historical workflow prompt bodies are private in all three task views, not in ordinary or nested user tasks", () => {
  const { request, run, workUnit } = fixtures();
  const historicalTask = { id: "historical-task", title: "Historical workflow", channelId: "channel_one",
    prompt: `Objective plus owner-scoped role evidence: ${privateCanary}` };
  request.task = historicalTask;
  run.taskSnapshot = historicalTask;
  const before = structuredClone({ run, workUnit });
  const publicRun = projectPublicRunSession(run);
  const publicWorkUnit = projectPublicWorkUnit(workUnit);
  const publicTask = { id: historicalTask.id, title: historicalTask.title, channelId: historicalTask.channelId };
  assert.deepEqual(publicRun.taskSnapshot, publicTask);
  assert.deepEqual(publicRun.requestSnapshot.task, publicTask);
  assert.deepEqual(publicWorkUnit.request.task, publicTask);
  assert.doesNotMatch(JSON.stringify({ publicRun, publicWorkUnit }), new RegExp(privateCanary, "u"));
  assert.deepEqual({ run, workUnit }, before);
  assert.deepEqual(publicRun.requestSnapshot.userPayload.task, { prompt: "ordinary user field" });

  // Only trusted Run ownership triggers this projection, not caller-shaped request data or a channel ID.
  const ordinaryTask = { ...historicalTask, prompt: "Ordinary accepted user prompt" };
  const ordinaryRun = { ...run, workflowStepId: undefined, taskSnapshot: ordinaryTask,
    requestSnapshot: { ...request, task: ordinaryTask } };
  assert.deepEqual(projectPublicRunSession(ordinaryRun).taskSnapshot, ordinaryTask);
  assert.deepEqual(projectPublicRunSession(ordinaryRun).requestSnapshot.task, ordinaryTask);
  const ordinaryUnit = { ...workUnit, request: { ...request, workflowStepId: undefined, task: ordinaryTask } };
  assert.deepEqual(projectPublicWorkUnit(ordinaryUnit).request.task, ordinaryTask);
  assert.equal(projectPublicWorkUnit({ ...workUnit, kind: "external_work_action" }).request, request);
});

test("a real prepared answer continuation retains private system input internally but not in successor DTOs", async t => {
  const f = await userInputTranscriptFixture(t);
  const task = { id: f.run.taskId, title: "Continue task", prompt: "Continue the accepted task." };
  const provider = { provider: "fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only-not-a-credential" };
  const options = { cwd: f.cwd, task, provider, tools: ["read"],
    systemPrompt: privateCanary, appendSystemPrompt: [privateCanary] };
  const execution = capturePreparedRunnerInput({ runnerId: f.attempt.runnerId, options,
    preparedInput: await prepareFixtureTaskInput(options) });
  const sourceRequest = { cwd: f.cwd, workspaceCwd: f.cwd, task, provider,
    threadId: f.thread.id, turnId: f.turn.turnId, teammateId: f.participantId,
    sourceMessageId: f.turn.item.id, runnerId: "pi", tools: ["read"], runnerExecutionInput: execution };
  f.db.prepare("UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,provider_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(task), JSON.stringify(sourceRequest), JSON.stringify(provider), f.run.id);
  f.submit();
  const delivery = f.claim();
  const prepared = prepareUserInputContinuationRequest(f.store, {
    threadId: f.thread.id, deliveryId: delivery.deliveryId, expectedRevision: delivery.revision,
    ownerId: delivery.claim.ownerId, claimToken: delivery.claim.token,
  }, claimedAt);
  assert.equal(prepared.request.systemPrompt, privateCanary);
  assert.deepEqual(prepared.request.appendSystemPrompt, [privateCanary]);
  assert.equal(prepared.request.runnerExecutionInput, undefined);
  assert.equal(prepared.request.continuationReason, "user_input_answer");
  const successor = { ...f.run, id: delivery.successorRunId, taskSnapshot: prepared.request.task,
    requestSnapshot: prepared.request };
  const publicRun = projectPublicRunSession(successor);
  const publicUnit = projectPublicWorkUnit({ ...f.unit, kind: "conversation_run", request: prepared.request });
  assert.doesNotMatch(JSON.stringify({ run: publicRun, workUnit: publicUnit }), new RegExp(privateCanary, "u"));
  assert.deepEqual(publicRun.taskSnapshot, prepared.request.task);
  assert.match(publicRun.taskSnapshot.prompt, /Continue the accepted task/u);
  assert.equal(prepared.request.systemPrompt, privateCanary);
  assert.deepEqual(prepared.request.appendSystemPrompt, [privateCanary]);
  assert.deepEqual(f.store.getUserInputContinuationPreparation(f.thread.id, delivery.deliveryId, "request").payload,
    prepared.request);
});

test("public projection preserves non-Run requests, absent inputs, and nested user/tool keys", () => {
  const { workUnit } = fixtures();
  for (const kind of ["media_job", "external_work_action", "external_work_step", "approval_review", "channel_turn_dispatch", "channel_terminal_report"]) {
    const other = { ...workUnit, kind };
    assert.equal(projectPublicWorkUnit(other), other);
  }
  for (const requestSnapshot of [undefined, null, "plain", ["array"], 0]) {
    assert.equal(projectPublicRunSession({ requestSnapshot }).requestSnapshot, requestSnapshot);
  }
  for (const kind of ["task_run", "conversation_run", "channel_ai_reply", "teammate_direct_reply"]) {
    assert.equal(projectPublicWorkUnit({ ...workUnit, kind }).request.runnerExecutionInput, undefined);
  }
  assert.equal(projectPublicRunSession(undefined), undefined);
  assert.equal(projectPublicWorkUnit(undefined), undefined);
});

test("Run and WorkUnit HTTP views and terminal control responses never serialize frozen private input", async () => {
  const { run, workUnit } = fixtures();
  run.taskSnapshot.prompt = `${privateCanary} retained in a historical workflow task`;
  const original = structuredClone({ run, workUnit });
  const store = {
    getRun: id => id === run.id ? run : undefined,
    listRuns: () => [run],
    getWorkUnit: id => id === workUnit.id ? workUnit : undefined,
    listWorkUnits: input => !input?.status || input.status === workUnit.status ? [workUnit] : [],
    listWorkUnitAttempts: () => [], listRuntimeEvents: () => [],
    listResourceLeases: () => [], listRuntimeSemaphoreSlots: () => [],
  };
  const registry = { getStore: () => store, findStoreForRun: () => store };
  const supervisor = { getRuntime() {} };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/runs") handleListRuns(response, url, registry);
      else if (url.pathname === "/runs/run_one") handleGetRun(response, url, registry, run.id);
      else if (url.pathname === "/runs/run_one/cancel") {
        await handleCancelRunRequest(request, response, {}, url, registry, {}, run.id, () => {});
      } else if (url.pathname === "/work-units") handleListWorkUnits(response, url, registry);
      else if (url.pathname === "/runtime/active") handleListRuntimeActive(response, url, registry);
      else if (url.pathname === "/runtime/stuck") handleListRuntimeStuck(response, url, registry);
      else await handleWorkUnitRoute(request, response, url, registry, {}, supervisor,
        { kind: url.pathname.endsWith("/retry") ? "retry" : "detail", workUnitId: workUnit.id }, () => {}, {}, () => {});
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/runs", "/runs/run_one", "/work-units", "/runtime/active", "/runtime/stuck", "/work-units/work_one"]) {
      const response = await fetch(`${base}${path}?cwd=fixture`);
      const body = await response.text();
      assert.equal(response.status, 200, `${path}: ${body}`);
      assert.doesNotMatch(body, new RegExp(privateCanary, "u"), path);
      assert.match(body, /ordinary user field/u, path);
    }
    run.status = "succeeded";
    let response = await fetch(`${base}/runs/run_one/cancel?cwd=fixture`, { method: "POST" });
    let body = await response.text();
    assert.equal(response.status, 409, body);
    assert.doesNotMatch(body, new RegExp(privateCanary, "u"));
    run.status = "cancelled";
    response = await fetch(`${base}/runs/run_one/cancel?cwd=fixture`, { method: "POST" });
    body = await response.text();
    assert.equal(response.status, 200, body);
    assert.doesNotMatch(body, new RegExp(privateCanary, "u"));
    workUnit.status = "cancelled";
    response = await fetch(`${base}/work-units/work_one/retry?cwd=fixture`, { method: "POST" });
    body = await response.text();
    assert.equal(response.status, 409, body);
    assert.doesNotMatch(body, new RegExp(privateCanary, "u"));
    assert.deepEqual(run.requestSnapshot, original.run.requestSnapshot);
    assert.deepEqual(workUnit.request, original.workUnit.request);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("direct control HTTP runtime, intervention, promote, and cancel responses project WorkUnits without changing services", async () => {
  const { workUnit } = fixtures();
  const directUnit = { ...workUnit, kind: "teammate_direct_reply",
    request: { ...workUnit.request, workflowStepId: undefined } };
  const runtime = { teammateId: "teammate_one", thread: { id: "direct_thread_one" },
    activeReply: { status: "running", workUnitId: directUnit.id, messageId: "reply_one",
      sourceMessageId: "source_one", workUnit: directUnit, message: { body: "Visible direct message" } },
    interventions: [], approvals: [] };
  const before = structuredClone(runtime);
  const store = { getRun: () => undefined, getLingThread: () => undefined };
  const calls = [];
  const intervention = { id: "intervention_one", teammateId: runtime.teammateId };
  const service = {
    getRuntime(input) { assert.equal(input.store, store); calls.push("get"); return runtime; },
    createIntervention(input) { assert.equal(input.store, store); calls.push("create"); return intervention; },
    promoteIntervention(input) { assert.equal(input.store, store); calls.push("promote"); return { intervention, message: "Accepted" }; },
    cancelReply(input) { assert.equal(input.store, store); calls.push("cancel"); return { workUnit: directUnit, message: runtime.activeReply.message }; },
  };
  const registry = { getStore: () => store };
  const config = { host: "127.0.0.1", port: 0, maxBodyBytes: 65536 };
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/runtime")) await handleTeammateDirectRuntime(request, response, config, registry, runtime.teammateId, service);
      else if (request.url.startsWith("/promote")) await handleTeammateDirectInterventionPromote(request, response, config, registry, intervention.id, service);
      else if (request.url.startsWith("/cancel")) await handleTeammateDirectReplyCancel(request, response, config, registry, directUnit.id, service);
      else await handleTeammateDirectInterventions(request, response, config, registry, runtime.teammateId, service);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, status, payload] of [["/runtime", 200], ["/interventions", 201,
      { mode: "queue_followup", instruction: "Continue the accepted task" }], ["/promote", 200, {}], ["/cancel", 200, {}]]) {
      const response = await fetch(`${base}${path}?cwd=fixture`, payload ? {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      } : undefined);
      const body = await response.text();
      assert.equal(response.status, status, `${path}: ${body}`);
      assert.doesNotMatch(body, new RegExp(privateCanary, "u"), path);
      const parsed = JSON.parse(body);
      const publicUnit = path === "/cancel" ? parsed.workUnit : (parsed.runtime ?? parsed).activeReply.workUnit;
      assert.deepEqual(publicUnit.request.task, directUnit.request.task);
      assert.deepEqual(publicUnit.request.userPayload, directUnit.request.userPayload);
      assert.deepEqual(runtime, before);
    }
    assert.deepEqual(calls, ["get", "create", "get", "promote", "get", "cancel"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
