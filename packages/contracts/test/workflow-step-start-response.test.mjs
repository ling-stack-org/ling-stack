import assert from "node:assert/strict";
import test from "node:test";

import { parseChannelWorkflowStepStartResponse } from "../dist/index.js";

const trustedStep = {
  id: "step-1",
  workflowId: "workflow-1",
  channelId: "channel-1",
  title: "Inspect",
  prompt: "Read evidence.txt",
  toParticipantId: "engineer",
};
const workflow = { id: trustedStep.workflowId, channelId: trustedStep.channelId, status: "waiting_for_approval" };
const executionPermit = {
  schemaVersion: 1,
  mode: "create_and_run_task",
  taskTitle: trustedStep.title,
  taskPrompt: trustedStep.prompt,
  providerPresetId: "provider-frozen",
  runnerId: "runner-frozen",
  assigneeTeammateId: trustedStep.toParticipantId,
  skipProviderPreflight: false,
  fingerprint: `wpgpermit1_${"1".repeat(64)}`,
};
const approval = {
  id: "approval-1",
  workflowStepId: trustedStep.id,
  channelId: trustedStep.channelId,
  actionType: "workflow_step",
  status: "pending",
  payload: {
    type: "workflow_step",
    gateStage: "pre",
    workflowId: trustedStep.workflowId,
    workflowStepId: trustedStep.id,
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
};
const waitingResponse = {
  status: "waiting_for_approval",
  mode: "create_and_run_task",
  workflow,
  workflowStep: { ...trustedStep, status: "waiting_for_approval" },
  approval,
};
const waitingExpected = {
  mode: "create_and_run_task",
  workflowId: trustedStep.workflowId,
  channelId: trustedStep.channelId,
  workflowStep: trustedStep,
  taskTitle: trustedStep.title,
  taskPrompt: trustedStep.prompt,
  providerPresetId: executionPermit.providerPresetId,
  runnerId: executionPermit.runnerId,
  assigneeTeammateId: trustedStep.toParticipantId,
  skipProviderPreflight: false,
};

test("workflow-step admission accepts only the caller's frozen step and execution permit", () => {
  assert.deepEqual(parseChannelWorkflowStepStartResponse(waitingResponse, waitingExpected), waitingResponse);

  const cases = [
    ["response mode", (value) => { value.mode = "create_task"; }],
    ["workflow id", (value) => { value.workflow.id = "foreign-workflow"; }],
    ["workflow channel", (value) => { value.workflow.channelId = "foreign-channel"; }],
    ["step title", (value) => { value.workflowStep.title = "Foreign title"; }],
    ["step prompt", (value) => { value.workflowStep.prompt = "Foreign prompt"; }],
    ["step participant", (value) => { value.workflowStep.toParticipantId = "foreign-participant"; }],
    ["permit mode", (value) => { value.approval.payload.preGateBasis.executionPermit.mode = "create_task"; }],
    ["permit title", (value) => { value.approval.payload.preGateBasis.executionPermit.taskTitle = "Foreign title"; }],
    ["permit prompt", (value) => { value.approval.payload.preGateBasis.executionPermit.taskPrompt = "Foreign prompt"; }],
    ["permit participant", (value) => { value.approval.payload.preGateBasis.executionPermit.assigneeTeammateId = "foreign-participant"; }],
    ["permit provider", (value) => { value.approval.payload.preGateBasis.executionPermit.providerPresetId = "foreign-provider"; }],
    ["permit runner", (value) => { value.approval.payload.preGateBasis.executionPermit.runnerId = "foreign-runner"; }],
    ["permit preflight", (value) => { value.approval.payload.preGateBasis.executionPermit.skipProviderPreflight = true; }],
    ["approval run", (value) => { value.approval.runId = "run-foreign"; }],
    ["approval task", (value) => { value.approval.taskId = "task-foreign"; }],
    ["payload run", (value) => { value.approval.payload.runId = "run-foreign"; }],
    ["payload gate stage", (value) => { value.approval.payload.gateStage = "post"; }],
  ];
  for (const [label, mutate] of cases) {
    const response = structuredClone(waitingResponse);
    mutate(response);
    assert.equal(parseChannelWorkflowStepStartResponse(response, waitingExpected), undefined, label);
  }
});

test("workflow-step admission rejects provider or runner injection when the trusted request omitted them", () => {
  const expected = { ...waitingExpected, providerPresetId: undefined, runnerId: undefined };
  const withoutRuntimeSelection = structuredClone(waitingResponse);
  delete withoutRuntimeSelection.approval.payload.preGateBasis.executionPermit.providerPresetId;
  delete withoutRuntimeSelection.approval.payload.preGateBasis.executionPermit.runnerId;
  assert.deepEqual(parseChannelWorkflowStepStartResponse(withoutRuntimeSelection, expected), withoutRuntimeSelection);

  for (const field of ["providerPresetId", "runnerId"]) {
    const injected = structuredClone(withoutRuntimeSelection);
    injected.approval.payload.preGateBasis.executionPermit[field] = `foreign-${field}`;
    assert.equal(parseChannelWorkflowStepStartResponse(injected, expected), undefined, field);
  }
});

test("create-task success requires one task, no run, and exact task semantics", () => {
  const expected = { ...waitingExpected, mode: "create_task", providerPresetId: undefined, runnerId: undefined };
  const response = {
    status: "started",
    mode: "create_task",
    workflow: { ...workflow, status: "succeeded" },
    workflowStep: { ...trustedStep, status: "succeeded", taskId: "task-1" },
    task: {
      id: "task-1",
      channelId: trustedStep.channelId,
      title: trustedStep.title,
      prompt: trustedStep.prompt,
      assigneeTeammateId: trustedStep.toParticipantId,
    },
  };
  assert.deepEqual(parseChannelWorkflowStepStartResponse(response, expected), response);

  const cases = [
    ["missing task", (value) => { delete value.task; }],
    ["top-level run", (value) => { value.run = { id: "run-1" }; }],
    ["step run", (value) => { value.workflowStep.runId = "run-1"; }],
    ["task title", (value) => { value.task.title = "Foreign title"; }],
    ["task prompt", (value) => { value.task.prompt = "Foreign prompt"; }],
    ["task participant", (value) => { value.task.assigneeTeammateId = "foreign-participant"; }],
  ];
  for (const [label, mutate] of cases) {
    const changed = structuredClone(response);
    mutate(changed);
    assert.equal(parseChannelWorkflowStepStartResponse(changed, expected), undefined, label);
  }
});

test("workflow-step response context must be internally bound to its frozen step", () => {
  assert.equal(parseChannelWorkflowStepStartResponse(waitingResponse, {
    ...waitingExpected,
    workflowStep: { ...trustedStep, workflowId: "foreign-workflow" },
  }), undefined);
});
