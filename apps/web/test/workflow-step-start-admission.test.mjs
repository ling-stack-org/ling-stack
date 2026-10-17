import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

import { parseChannelWorkflowStepStartResponse } from "../../../packages/contracts/dist/index.js";
import { streamRun } from "../src/sse.ts";

const controllerPath = new URL("../src/app/use-channel-workflow-controller.ts", import.meta.url);
const controllerSource = readFileSync(controllerPath, "utf8");
const helpersStart = controllerSource.indexOf("export function publishChannelWorkflowStepStartResponse(");
const helpersEnd = controllerSource.indexOf("\nexport interface ChannelWorkflowController", helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
const mergeWorkflowSteps = (current, next) => [
  ...next,
  ...current.filter((item) => !next.some((candidate) => candidate.id === item.id)),
];
const helpersCode = stripTypeScriptTypes(
  `(() => {${controllerSource.slice(helpersStart, helpersEnd).replaceAll("export function", "function")}
    return { publishChannelWorkflowStepStartResponse };
  })()`,
  { mode: "transform" },
);
const { publishChannelWorkflowStepStartResponse } = vm.runInNewContext(helpersCode, { mergeWorkflowSteps, Error });
const handlerStartMarker = "  async function startWorkflowStepAction(";
const handlerStart = controllerSource.indexOf(handlerStartMarker);
const handlerEnd = controllerSource.indexOf("\n  async function updateWorkflowStepStatus(", handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
assert.equal(controllerSource.indexOf(handlerStartMarker, handlerStart + 1), -1);
const handlerCode = stripTypeScriptTypes(
  `(${controllerSource.slice(handlerStart, handlerEnd).trim()})`,
  { mode: "transform" },
);
const runsDomainPath = new URL("../src/domains/runs/use-runs-domain.ts", import.meta.url);
const runsDomainSource = readFileSync(runsDomainPath, "utf8");
const streamRequestStartMarker = "  async function streamRunRequest";
const streamRequestStart = runsDomainSource.indexOf(streamRequestStartMarker);
const streamRequestEnd = runsDomainSource.indexOf("\n  const { cancellingRunId", streamRequestStart);
assert.ok(streamRequestStart >= 0 && streamRequestEnd > streamRequestStart);
const streamRequestCode = stripTypeScriptTypes(
  `(${runsDomainSource.slice(streamRequestStart, streamRequestEnd).trim()})`,
  { mode: "transform" },
);

const workflow = {
  id: "workflow-1",
  channelId: "channel-1",
  status: "waiting_for_approval",
};
const workflowStep = {
  id: "step-1",
  workflowId: workflow.id,
  channelId: workflow.channelId,
  status: "waiting_for_approval",
  toParticipantId: "engineer",
  title: "Inspect",
  prompt: "Read evidence.txt",
};
const executionPermit = {
  schemaVersion: 1,
  mode: "create_and_run_task",
  taskTitle: workflowStep.title,
  taskPrompt: workflowStep.prompt,
  assigneeTeammateId: workflowStep.toParticipantId,
  skipProviderPreflight: false,
  fingerprint: `wpgpermit1_${"1".repeat(64)}`,
};
const approval = {
  id: "approval-1",
  workflowStepId: workflowStep.id,
  channelId: workflow.channelId,
  actionType: "workflow_step",
  risk: "medium",
  title: "Approve step",
  description: "Approve the gated workflow step.",
  payload: {
    type: "workflow_step",
    gateStage: "pre",
    workflowId: workflow.id,
    workflowStepId: workflowStep.id,
    title: "Approve step",
    approvalMode: "standard",
    requiredForTools: [],
    requiredForActions: [],
    preGateBasis: {
      schemaVersion: 1,
      startNonce: "nonce-1",
      authorityBasis: `wso1_${"2".repeat(64)}`,
      requestedStatus: "queued",
      gateFingerprint: `wpgate1_${"3".repeat(64)}`,
      executionPermit,
      fingerprint: `wpg1_${"4".repeat(64)}`,
    },
  },
  status: "pending",
  createdAt: "2026-10-17T00:00:00.000Z",
};

function installHttpResponse(response) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = async () => response;
  globalThis.WebSocket = undefined;
  return () => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  };
}

async function startLoopbackServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("workflow manual start returns typed JSON admission instead of silently parsing it as SSE", async () => {
  const requests = [];
  const server = await startLoopbackServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, contentType: request.headers["content-type"], body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "waiting_for_approval", mode: "create_and_run_task", workflow, workflowStep, approval }));
  });
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try {
    const messages = [];
    const result = await streamRun(
      `${server.origin}/workflow-steps/step-1/start?cwd=%2Frepo`,
      { mode: "create_and_run_task" },
      (message) => messages.push(message),
      undefined,
      (value) => parseChannelWorkflowStepStartResponse(value, {
        mode: "create_and_run_task",
        workflowId: workflow.id,
        channelId: workflow.channelId,
        workflowStep,
        taskTitle: workflowStep.title,
        taskPrompt: workflowStep.prompt,
        assigneeTeammateId: workflowStep.toParticipantId,
        providerPresetId: undefined,
        runnerId: undefined,
        skipProviderPreflight: false,
      }),
    );
    assert.deepEqual(result, {
      status: "waiting_for_approval",
      mode: "create_and_run_task",
      workflow,
      workflowStep,
      approval,
    });
    assert.deepEqual(messages, []);
    assert.deepEqual(requests, [{
      url: "/workflow-steps/step-1/start?cwd=%2Frepo",
      contentType: "application/json",
      body: { mode: "create_and_run_task" },
    }]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    await server.close();
  }
});

test("workflow admission cannot use a self-consistent response to replace the caller's frozen execution permit", () => {
  const foreignStep = { ...workflowStep, title: "Foreign title" };
  const foreignApproval = {
    ...approval,
    payload: {
      ...approval.payload,
      preGateBasis: {
        ...approval.payload.preGateBasis,
        executionPermit: { ...executionPermit, taskTitle: foreignStep.title },
      },
    },
  };
  assert.equal(parseChannelWorkflowStepStartResponse({
    status: "waiting_for_approval",
    mode: "create_and_run_task",
    workflow,
    workflowStep: foreignStep,
    approval: foreignApproval,
  }, {
    mode: "create_and_run_task",
    workflowId: workflow.id,
    channelId: workflow.channelId,
    workflowStep,
    taskTitle: workflowStep.title,
    taskPrompt: workflowStep.prompt,
    assigneeTeammateId: workflowStep.toParticipantId,
    providerPresetId: undefined,
    runnerId: undefined,
    skipProviderPreflight: false,
  }), undefined);
});

test("unexpected JSON from a normal run stream fails closed instead of disappearing", async () => {
  const restore = installHttpResponse(new Response(JSON.stringify({ status: "waiting_for_approval" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  try {
    await assert.rejects(
      streamRun("http://daemon.test/runs", { prompt: "test" }, () => {}),
      /Unexpected JSON response/u,
    );
  } finally {
    restore();
  }
});

test("ordinary SSE ready and event frames retain their existing stream behavior", async () => {
  const restore = installHttpResponse(new Response([
    "event: ready",
    'data: {"runId":"run-1"}',
    "",
    "event: message",
    'data: {"id":"event-1","runId":"run-1","sequence":1,"type":"run_start","timestamp":"2026-10-17T00:00:00.000Z","data":{}}',
    "",
  ].join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  }));
  try {
    const messages = [];
    const result = await streamRun(
      "http://daemon.test/runs",
      { prompt: "test" },
      (message) => messages.push(message),
    );
    assert.equal(result, undefined);
    assert.equal(messages[0].kind, "ready");
    assert.equal(messages[0].runId, "run-1");
    assert.equal(messages[1].kind, "event");
    assert.equal(messages[1].event.type, "run_start");
  } finally {
    restore();
  }
});

function runsDomainStreamFixture(streamRunImplementation) {
  const state = { errors: [], healthRefreshes: 0, loadRuns: 0, refreshRuns: 0 };
  const run = vm.runInNewContext(streamRequestCode, {
    input: {
      confirmFullAccessRunIfNeeded: async (body) => body,
      setSelectedWorkUnitDetail: () => {},
      refreshApprovals: async () => {},
      refreshUsedMemoryAudit: async () => {},
      refreshHealth: async () => { state.healthRefreshes++; },
    },
    abortRef: { current: undefined },
    setError: (error) => { if (error) state.errors.push(error); },
    setEvents: () => {},
    setArtifacts: () => {},
    setRun: () => {},
    setActiveRunId: () => {},
    setLookupRunId: () => {},
    setIsRunning: () => {},
    loadRun: async () => { state.loadRuns++; },
    refreshRunList: async () => { state.refreshRuns++; },
    streamRun: streamRunImplementation,
    AbortController,
    Error,
  });
  return { run, state };
}

test("runs domain returns the typed admission without trying to load a nonexistent run", async () => {
  const fixture = runsDomainStreamFixture(async (_url, _body, _onMessage, _signal, parseJsonResponse) =>
    parseJsonResponse({ status: "waiting_for_approval" }));

  const result = await fixture.run(
    "http://daemon.test/workflow-steps/step-1/start?cwd=%2Frepo",
    { mode: "create_and_run_task" },
    "/repo",
    async () => {},
    (value) => value,
  );

  assert.deepEqual(result, { status: "waiting_for_approval" });
  assert.equal(fixture.state.loadRuns, 0);
  assert.equal(fixture.state.refreshRuns, 0);
  assert.equal(fixture.state.healthRefreshes, 1);
});

test("runs domain leaves admission errors to the single workflow owner", async () => {
  const fixture = runsDomainStreamFixture(async () => { throw new Error("admission rejected"); });

  await assert.rejects(
    fixture.run(
      "http://daemon.test/workflow-steps/step-1/start?cwd=%2Frepo",
      { mode: "create_and_run_task" },
      "/repo",
      undefined,
      (value) => value,
    ),
    /admission rejected/u,
  );

  assert.deepEqual(fixture.state.errors, []);
  assert.equal(fixture.state.healthRefreshes, 1);
});

function controllerFixture(rawAdmission, options = {}) {
  const activeStep = options.step ?? workflowStep;
  const state = {
    workflows: options.workflows ?? [{ ...workflow, status: "running" }],
    steps: [{ ...activeStep, status: "running" }],
    approvals: [],
    errors: [],
    streamCalls: [],
    refreshes: [],
  };
  const applyState = (key, update) => {
    state[key] = typeof update === "function" ? update(state[key]) : update;
  };
  const input = {
    form: options.form ?? { cwd: "/repo", providerPresetId: "" },
    channels: options.channels ?? [{ id: "channel-1" }],
    providers: options.providers ?? [],
    selectedChannelId: "channel-1",
    taskRunProviderId: options.taskRunProviderId ?? "",
    channelWorkflows: state.workflows,
    daemonBaseUrl: "http://daemon.test",
    setRunningWorkflowStepId: () => {},
    clearWorkflowError: () => {},
    reportWorkflowError: (identity, message) => state.errors.push({ identity, message }),
    startChannelWorkflowStep: async () => { throw new Error("unexpected JSON client start"); },
    streamRunRequest: async (...args) => {
      state.streamCalls.push(args);
      const parseAdmission = args[4];
      assert.equal(typeof parseAdmission, "function");
      if (options.streamError) throw options.streamError;
      return parseAdmission(rawAdmission);
    },
    setChannelWorkflows: (update) => applyState("workflows", update),
    setChannelWorkflowSteps: (update) => applyState("steps", update),
    upsertApprovalRecord: (next) => state.approvals.push(next),
    setSelectedTaskId: () => {},
    setTasks: () => {},
    refreshTasks: async () => state.refreshes.push("tasks"),
    refreshChannelProtocol: async () => state.refreshes.push("protocol"),
    refreshRuntimeState: async () => state.refreshes.push("runtime"),
  };
  const run = vm.runInNewContext(handlerCode, {
    input,
    providerPreflightReady: () => false,
    mergeWorkflowSteps,
    parseChannelWorkflowStepStartResponse,
    publishChannelWorkflowStepStartResponse,
    Error,
  });
  return { run, state };
}

test("workflow controller publishes waiting admission into workflow, step, and approval state", async () => {
  const waitingWorkflow = { ...workflow, title: "Waiting workflow" };
  const waitingStep = { ...workflowStep, status: "waiting_for_approval" };
  const waitingApproval = {
    ...approval,
    payload: {
      ...approval.payload,
      preGateBasis: {
        ...approval.payload.preGateBasis,
        executionPermit: { ...executionPermit },
      },
    },
  };
  const fixture = controllerFixture({
    status: "waiting_for_approval",
    mode: "create_and_run_task",
    workflow: waitingWorkflow,
    workflowStep: waitingStep,
    approval: waitingApproval,
  }, {
    workflows: [
      { id: "workflow-before", channelId: "channel-1", status: "running" },
      { ...workflow, status: "running" },
      { id: "workflow-after", channelId: "channel-1", status: "draft" },
    ],
  });

  await fixture.run(workflowStep, "create_and_run_task");

  assert.equal(fixture.state.streamCalls.length, 1);
  assert.equal(fixture.state.streamCalls[0][0], "http://daemon.test/workflow-steps/step-1/start?cwd=%2Frepo");
  assert.deepEqual(fixture.state.workflows.map((item) => item.id), ["workflow-before", "workflow-1", "workflow-after"]);
  assert.equal(fixture.state.workflows[1].title, waitingWorkflow.title);
  assert.equal(fixture.state.steps[0].status, "waiting_for_approval");
  assert.deepEqual(fixture.state.approvals, [waitingApproval]);
  assert.deepEqual(fixture.state.errors, []);
});

test("workflow controller uses the frozen step provider and runner before a changed channel default", async () => {
  const frozenStep = {
    ...workflowStep,
    metadata: {
      providerBinding: { providerPresetId: "provider-frozen" },
      providerPresetId: "provider-legacy",
      requestedRunnerId: "runner-frozen",
    },
  };
  const waitingStep = { ...frozenStep, status: "waiting_for_approval" };
  const waitingApproval = {
    ...approval,
    payload: {
      ...approval.payload,
      preGateBasis: {
        ...approval.payload.preGateBasis,
        executionPermit: {
          ...executionPermit,
          providerPresetId: "provider-frozen",
          runnerId: "runner-frozen",
        },
      },
    },
  };
  const fixture = controllerFixture({
    status: "waiting_for_approval",
    mode: "create_and_run_task",
    workflow,
    workflowStep: waitingStep,
    approval: waitingApproval,
  }, {
    step: frozenStep,
    channels: [{ id: "channel-1", defaultProviderPresetId: "provider-new-default" }],
  });

  await fixture.run(frozenStep, "create_and_run_task");

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.streamCalls[0][1])), {
    mode: "create_and_run_task",
    providerPresetId: "provider-frozen",
    runnerId: "runner-frozen",
    assigneeTeammateId: "engineer",
  });
  assert.deepEqual(fixture.state.approvals, [waitingApproval]);
  assert.deepEqual(fixture.state.errors, []);
});

test("workflow controller publishes blocked admission and its canonical blocker", async () => {
  const blockedWorkflow = { ...workflow, status: "blocked" };
  const blockedStep = { ...workflowStep, status: "blocked", blocker: "Approval was denied." };
  const fixture = controllerFixture({
    status: "blocked",
    mode: "create_and_run_task",
    workflow: blockedWorkflow,
    workflowStep: blockedStep,
    blocker: "Approval was denied.",
  });

  await fixture.run(workflowStep, "create_and_run_task");

  assert.equal(fixture.state.workflows[0].status, "blocked");
  assert.equal(fixture.state.steps[0].status, "blocked");
  assert.deepEqual(fixture.state.approvals, []);
  assert.deepEqual(fixture.state.errors, [{ identity: "step-1", message: "Approval was denied." }]);
});

test("workflow controller rejects foreign approval lineage without publishing untrusted state", async () => {
  const fixture = controllerFixture({
    status: "waiting_for_approval",
    mode: "create_and_run_task",
    workflow,
    workflowStep,
    approval: { ...approval, workflowStepId: "foreign-step" },
  });

  await fixture.run(workflowStep, "create_and_run_task");

  assert.equal(fixture.state.workflows[0].status, "running");
  assert.equal(fixture.state.steps[0].status, "running");
  assert.deepEqual(fixture.state.approvals, []);
  assert.deepEqual(fixture.state.errors, [{
    identity: "step-1",
    message: "Workflow step start returned an invalid admission response or foreign lineage.",
  }]);
});

test("workflow controller reports an HTTP admission error instead of treating it as a completed start", async () => {
  const fixture = controllerFixture(undefined, { streamError: new Error("Workflow pre-approval basis is stale.") });

  await fixture.run(workflowStep, "create_and_run_task");

  assert.deepEqual(fixture.state.approvals, []);
  assert.deepEqual(fixture.state.errors, [{
    identity: "step-1",
    message: "Workflow pre-approval basis is stale.",
  }]);
});
