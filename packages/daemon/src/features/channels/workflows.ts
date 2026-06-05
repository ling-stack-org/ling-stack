import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  type ChannelHandoff,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStepStatus,
  type RunStore,
  type RunTool,
  type SkillApprovalProfile,
  type Task,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  compileWorkflowTemplate,
  isWorkflowTemplateCompileRequest,
  parseWorkflowTemplateCompileRequest,
} from "./workflow-templates.js";
import {
  parseChannelWorkflowFromHandoffRequest,
  parseChannelWorkflowRequest,
  parseChannelWorkflowStepRequest,
  parseChannelWorkflowStepStartRequest,
  parseChannelWorkflowStepUpdateRequest,
  parseChannelWorkflowUpdateRequest,
  type ChannelWorkflowStepStartRequest,
  readOptionalChannelWorkflowStatusQuery,
  readOptionalChannelWorkflowStepStatusQuery,
} from "./schemas.js";

const WORKFLOW_STEP_RESOURCE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface WorkflowStepRunRequest {
  readonly workspaceCwd: string;
  readonly cwd: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly skipProviderPreflight?: boolean;
  readonly idempotencyKey?: string;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly channelId?: string;
  };
  readonly tools?: readonly RunTool[];
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export type ValidateWorkflowStepRunRequest = (runRequest: WorkflowStepRunRequest) => void;

export type StartWorkflowStepRun = (input: {
  readonly runRequest: WorkflowStepRunRequest;
  readonly response: ServerResponse;
}) => Promise<string | undefined>;

export async function handleChannelWorkflowsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        workflows: store.listChannelWorkflows({
          channelId,
          status: readOptionalChannelWorkflowStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      if (isWorkflowTemplateCompileRequest(body)) {
        const input = parseWorkflowTemplateCompileRequest(body, channelId);
        const compiled = compileWorkflowTemplate(store, input);
        writeJson(response, 201, compiled);
        return;
      }
      const input = parseChannelWorkflowRequest(body);
      const workflow = store.createChannelWorkflow({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { workflow });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflows` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelWorkflowFromHandoff(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  handoffId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for handoff workflow creation` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const handoff = store.getChannelHandoff(handoffId);
    if (!handoff) {
      writeJson(response, 404, { error: "handoff_not_found", message: `Channel handoff not found: ${handoffId}` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowFromHandoffRequest(body);
    const workflow = store.createChannelWorkflow(
      {
        channelId: handoff.channelId,
        sourceHandoffId: handoff.id,
        title: input.title ?? `Handoff to ${handoff.toParticipantLabel}`,
        objective: input.objective ?? (handoff.expectedOutput || handoff.reason || "Complete handoff workflow."),
        createdBy: input.createdBy,
      },
      new Date().toISOString(),
    );
    const workflowStep = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        sourceHandoffId: handoff.id,
        contextSummaryId: input.contextSummaryId,
        title: `Complete handoff: ${handoff.expectedOutput || handoff.reason || handoff.toParticipantLabel}`,
        prompt: formatHandoffStepPrompt(handoff),
        toParticipantId: handoff.toParticipantId,
        toParticipantLabel: handoff.toParticipantLabel,
      },
      new Date().toISOString(),
    );
    writeJson(response, 201, { workflow, workflowStep });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelWorkflowItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelWorkflow(workflowId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_not_found", message: `Channel workflow not found: ${workflowId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { workflow: existing });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowUpdateRequest(body);
    if (input.status && input.status !== existing.status) {
      const transition = transitionWorkflowToStatus(store, existing.id, existing.status, input.status, new Date().toISOString());
      if (!transition.ok) {
        writeJson(response, 409, { error: transition.code, message: `Workflow transition failed: ${transition.code}` });
        return;
      }
    }
    const workflow = store.updateChannelWorkflow(workflowId, { title: input.title, objective: input.objective }, new Date().toISOString());
    writeJson(response, 200, { workflow: workflow ?? store.getChannelWorkflow(workflowId) ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelWorkflowStepsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannelWorkflow(workflowId)) {
      writeJson(response, 404, { error: "workflow_not_found", message: `Channel workflow not found: ${workflowId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        workflowId,
        workflowSteps: store.listChannelWorkflowSteps({
          workflowId,
          status: readOptionalChannelWorkflowStepStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelWorkflowStepRequest(body);
      const workflowStep = store.createChannelWorkflowStep({ ...input, workflowId }, new Date().toISOString());
      writeJson(response, 201, { workflowStep });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow steps` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelWorkflowStepItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowStepId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelWorkflowStep(workflowStepId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_step_not_found", message: `Channel workflow step not found: ${workflowStepId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { workflowStep: existing });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow step` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowStepUpdateRequest(body);
    if (input.status && input.status !== existing.status) {
      const transition = transitionWorkflowStepToStatus(store, existing.id, existing.status, input.status, new Date().toISOString(), {
        taskId: input.taskId,
        runId: input.runId,
        blocker: input.blocker,
        resultSummary: input.resultSummary,
      });
      if (!transition.ok) {
        writeJson(response, 409, { error: transition.code, message: `Workflow step transition failed: ${transition.code}` });
        return;
      }
    }
    const workflowStep = store.updateChannelWorkflowStep(
      workflowStepId,
      { ...input, status: undefined },
      new Date().toISOString(),
    );
    writeJson(response, 200, { workflowStep: workflowStep ?? store.getChannelWorkflowStep(workflowStepId) ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelWorkflowStepStartRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowStepId: string,
  validateRunRequest: ValidateWorkflowStepRunRequest,
  startRun: StartWorkflowStepRun,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelWorkflowStep(workflowStepId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_step_not_found", message: `Channel workflow step not found: ${workflowStepId}` });
      return;
    }
    await handleChannelWorkflowStepStart(request, response, config, storeRegistry, cwd, existing.id, validateRunRequest, startRun);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowStepStart(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  cwd: string,
  workflowStepId: string,
  validateRunRequest: ValidateWorkflowStepRunRequest,
  startRun: StartWorkflowStepRun,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow step start` });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const body = await readJsonBody(request, config.maxBodyBytes);
  const input = parseChannelWorkflowStepStartRequest(body);
  const started = prepareWorkflowStepStart(store, workflowStepId, input, cwd, validateRunRequest);
  if (started.kind === "blocked") {
    writeJson(response, 200, {
      workflow: store.getChannelWorkflow(started.workflowId),
      workflowStep: store.getChannelWorkflowStep(workflowStepId),
      blocker: started.blocker,
    });
    return;
  }
  if (started.kind === "error") {
    writeJson(response, started.statusCode, { error: started.code, message: started.message });
    return;
  }

  if (input.mode === "create_task") {
    const finishedAt = new Date().toISOString();
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      reason: `task:${started.task.id}`,
      now: finishedAt,
      taskId: started.task.id,
      resultSummary: "Task created from workflow step.",
    });
    completeWorkflowIfStepsFinished(store, started.workflowId, finishedAt);
    writeJson(response, 200, {
      workflow: store.getChannelWorkflow(started.workflowId),
      workflowStep: store.getChannelWorkflowStep(workflowStepId),
      task: started.task,
    });
    return;
  }

  const runId = await startRun({ runRequest: started.runRequest, response });
  const completedAt = new Date().toISOString();
  if (!runId) {
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "blocked",
      actor: "system",
      reason: "Run did not start.",
      now: completedAt,
      taskId: started.task.id,
      blocker: "Run did not start.",
    });
    store.transitionChannelWorkflowStatus({
      workflowId: started.workflowId,
      event: "step_blocked",
      actor: "system",
      reason: "Run did not start.",
      now: completedAt,
    });
    return;
  }
  const run = store.getRun(runId);
  if (run?.status === "succeeded") {
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "succeed",
      actor: "runner",
      reason: `run:${runId}`,
      now: completedAt,
      taskId: started.task.id,
      runId,
      resultSummary: "Run succeeded.",
    });
    completeWorkflowIfStepsFinished(store, started.workflowId, completedAt);
    return;
  }
  store.transitionChannelWorkflowStepStatus({
    workflowStepId,
    expectedStatus: "running",
    event: "fail",
    actor: "runner",
    reason: run?.errorMessage ?? `run:${runId}`,
    now: completedAt,
    taskId: started.task.id,
    runId,
    blocker: run?.errorMessage,
  });
  store.transitionChannelWorkflowStatus({
    workflowId: started.workflowId,
    event: "step_failed",
    actor: "runner",
    reason: run?.errorMessage ?? `run:${runId}`,
    now: completedAt,
  });
}

export type PreparedWorkflowStepStart =
  | { readonly kind: "ready"; readonly workflowId: string; readonly task: Task; readonly runRequest: WorkflowStepRunRequest }
  | { readonly kind: "blocked"; readonly workflowId: string; readonly blocker: string }
  | { readonly kind: "error"; readonly statusCode: number; readonly code: string; readonly message: string };

export function prepareWorkflowStepStart(
  store: RunStore,
  workflowStepId: string,
  input: ChannelWorkflowStepStartRequest,
  cwd: string,
  validateRunRequest: ValidateWorkflowStepRunRequest,
): PreparedWorkflowStepStart {
  const step = store.getChannelWorkflowStep(workflowStepId);
  if (!step) {
    return { kind: "error", statusCode: 404, code: "workflow_step_not_found", message: `Channel workflow step not found: ${workflowStepId}` };
  }
  const workflow = store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    return { kind: "error", statusCode: 404, code: "workflow_not_found", message: `Channel workflow not found: ${step.workflowId}` };
  }
  const channel = store.getChannel(step.channelId);
  if (!channel) {
    return { kind: "error", statusCode: 404, code: "channel_not_found", message: `Channel not found: ${step.channelId}` };
  }

  const now = new Date().toISOString();
  store.expireResourceLeases(now);
  const lease = store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "workflow_step",
    resourceKey: step.id,
    ownerType: "workflow_step",
    ownerId: step.id,
    acquiredAt: now,
    expiresAt: new Date(new Date(now).getTime() + WORKFLOW_STEP_RESOURCE_LEASE_TTL_MS).toISOString(),
  });
  if (!lease) {
    const blockingLease = store.getBlockingResourceLease("workflow_step", step.id);
    return {
      kind: "error",
      statusCode: 409,
      code: "resource_conflict",
      message: blockingLease ? `Workflow step is locked by ${blockingLease.ownerType}:${blockingLease.ownerId}` : `Workflow step is locked: ${step.id}`,
    };
  }

  const fail = (statusCode: number, code: string, message: string): PreparedWorkflowStepStart => {
    store.releaseResourceLeasesForOwner("workflow_step", step.id, new Date().toISOString());
    return { kind: "error", statusCode, code, message };
  };
  const block = (message: string): PreparedWorkflowStepStart => {
    const blockedAt = new Date().toISOString();
    store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "blocked",
      actor: "system",
      reason: message,
      now: blockedAt,
      blocker: message,
    });
    store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      event: "step_blocked",
      actor: "system",
      reason: message,
      now: blockedAt,
    });
    store.releaseResourceLeasesForOwner("workflow_step", step.id, blockedAt);
    return { kind: "blocked", workflowId: workflow.id, blocker: message };
  };

  const workflowTransition = ensureWorkflowRunning(store, workflow.id, workflow.status, now);
  if (!workflowTransition.ok) {
    return fail(409, workflowTransition.code, `Workflow transition failed: ${workflowTransition.code}`);
  }
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  const stepTransition = ensureWorkflowStepRunning(store, step.id, latestStep.status, now);
  if (!stepTransition.ok) {
    return fail(409, stepTransition.code, `Workflow step transition failed: ${stepTransition.code}`);
  }

  const providerPresetId = input.providerPresetId ?? channel.defaultProviderPresetId;
  const runnerId = input.runnerId;
  const taskTitle = input.taskTitle ?? step.title;
  const taskPrompt = input.taskPrompt ?? formatWorkflowStepTaskPrompt(step.prompt, workflow.objective);
  const assigneeTeammateId = input.assigneeTeammateId ?? step.toParticipantId;
  const runRequestBase: WorkflowStepRunRequest = {
    workspaceCwd: cwd,
    cwd: channel.boundPath ?? cwd,
    providerPresetId,
    runnerId,
    teammateId: assigneeTeammateId,
    skipProviderPreflight: input.skipProviderPreflight ?? false,
    idempotencyKey: input.idempotencyKey ?? `workflow-step:${step.id}`,
    task: {
      id: "pending",
      title: taskTitle,
      prompt: taskPrompt,
      channelId: channel.id,
    },
    tools: channel.allowedTools,
    thinkingLevel: "medium",
  };

  if (input.mode === "create_and_run_task") {
    if (!providerPresetId) {
      return block("No provider preset is selected for this workflow step.");
    }
    try {
      validateRunRequest(runRequestBase);
    } catch (error) {
      return block(error instanceof Error ? error.message : String(error));
    }
  }

  const task = store.createTask(
    {
      channelId: channel.id,
      title: taskTitle,
      prompt: taskPrompt,
      assigneeTeammateId,
    },
    new Date().toISOString(),
  );
  store.updateChannelWorkflowStep(step.id, { taskId: task.id }, new Date().toISOString());

  return {
    kind: "ready",
    workflowId: workflow.id,
    task,
    runRequest: {
      ...runRequestBase,
      task: {
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        channelId: task.channelId,
      },
    },
  };
}

function ensureWorkflowRunning(
  store: RunStore,
  workflowId: string,
  status: ChannelWorkflowStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStatus"]> {
  if (status === "running") {
    return { ok: true, from: status, to: status };
  }
  if (status === "draft") {
    const prepared = store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "draft",
      event: "prepare",
      actor: "system",
      now,
    });
    if (!prepared.ok) {
      return prepared;
    }
    return store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "ready",
      event: "start",
      actor: "system",
      now,
    });
  }
  if (status === "ready" || status === "blocked") {
    return store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: status,
      event: "start",
      actor: "system",
      now,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: status };
}

function ensureWorkflowStepRunning(
  store: RunStore,
  workflowStepId: string,
  status: ChannelWorkflowStepStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStepStatus"]> {
  if (status === "running") {
    return { ok: true, from: status, to: status };
  }
  if (status === "queued") {
    const claimed = store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now,
    });
    if (!claimed.ok) {
      return claimed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (status === "blocked") {
    const resumed = store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "blocked",
      event: "resume",
      actor: "system",
      now,
      blocker: null,
    });
    if (!resumed.ok) {
      return resumed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (status === "claimed") {
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: status };
}

export function completeWorkflowIfStepsFinished(store: RunStore, workflowId: string, now: string): void {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow || workflow.status !== "running") {
    return;
  }
  const steps = store.listChannelWorkflowSteps({ workflowId, limit: 500 });
  if (steps.length === 0 || steps.some((step) => step.status !== "succeeded" && step.status !== "skipped")) {
    return;
  }
  store.transitionChannelWorkflowStatus({
    workflowId,
    expectedStatus: "running",
    event: "all_steps_succeeded",
    actor: "system",
    now,
  });
}

function formatWorkflowStepTaskPrompt(prompt: string, workflowObjective: string): string {
  return [`Workflow objective: ${workflowObjective || "No objective provided."}`, "", prompt].join("\n");
}

function transitionWorkflowToStatus(
  store: RunStore,
  workflowId: string,
  currentStatus: ChannelWorkflowStatus,
  nextStatus: ChannelWorkflowStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStatus"]> {
  if (currentStatus === nextStatus) {
    return { ok: true, from: currentStatus, to: nextStatus };
  }
  const event =
    currentStatus === "draft" && nextStatus === "ready" ? "prepare"
      : (currentStatus === "ready" || currentStatus === "blocked") && nextStatus === "running" ? "start"
        : currentStatus === "running" && nextStatus === "waiting_for_approval" ? "approval_requested"
          : currentStatus === "waiting_for_approval" && nextStatus === "running" ? "approval_approved"
            : currentStatus === "running" && nextStatus === "blocked" ? "step_blocked"
              : (currentStatus === "running" || currentStatus === "blocked") && nextStatus === "failed" ? "step_failed"
                : currentStatus === "running" && nextStatus === "succeeded" ? "all_steps_succeeded"
                  : nextStatus === "cancelled" ? "cancel"
                    : undefined;
  if (!event) {
    return { ok: false, code: "invalid_transition", currentStatus };
  }
  return store.transitionChannelWorkflowStatus({
    workflowId,
    expectedStatus: currentStatus,
    event,
    actor: "local-user",
    now,
  });
}

function transitionWorkflowStepToStatus(
  store: RunStore,
  workflowStepId: string,
  currentStatus: ChannelWorkflowStepStatus,
  nextStatus: ChannelWorkflowStepStatus,
  now: string,
  metadata: {
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  } = {},
): ReturnType<RunStore["transitionChannelWorkflowStepStatus"]> {
  if (currentStatus === nextStatus) {
    return { ok: true, from: currentStatus, to: nextStatus };
  }
  const event =
    currentStatus === "queued" && nextStatus === "claimed" ? "claim"
      : currentStatus === "queued" && nextStatus === "skipped" ? "skip"
        : currentStatus === "claimed" && nextStatus === "running" ? "start"
          : currentStatus === "running" && nextStatus === "waiting_for_approval" ? "approval_requested"
            : currentStatus === "waiting_for_approval" && nextStatus === "running" ? "approval_approved"
              : currentStatus === "running" && nextStatus === "blocked" ? "blocked"
                : currentStatus === "blocked" && nextStatus === "claimed" ? "resume"
                  : currentStatus === "running" && nextStatus === "succeeded" ? "succeed"
                    : (currentStatus === "running" || currentStatus === "waiting_for_approval" || currentStatus === "blocked") && nextStatus === "failed" ? "fail"
                      : nextStatus === "cancelled" ? "cancel"
                        : undefined;
  if (!event) {
    return { ok: false, code: "invalid_transition", currentStatus };
  }
  return store.transitionChannelWorkflowStepStatus({
    workflowStepId,
    expectedStatus: currentStatus,
    event,
    actor: "local-user",
    now,
    taskId: metadata.taskId,
    runId: metadata.runId,
    blocker: metadata.blocker,
    resultSummary: metadata.resultSummary,
  });
}

function formatHandoffStepPrompt(handoff: ChannelHandoff): string {
  return [
    `Reason: ${handoff.reason || "No reason provided."}`,
    `Required input: ${handoff.requiredInput || "No required input provided."}`,
    `Expected output: ${handoff.expectedOutput || "No expected output provided."}`,
    "",
    "Use the visible channel Brief, active decisions, and linked context summary before starting work.",
  ].join("\n");
}
