import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  type ChannelWorkflow,
  type ChannelHandoff,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type MemoryObject,
  type RunArtifact,
  type RunStore,
  type RunTool,
  type SkillApprovalProfile,
  type Task,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  compileWorkflowTemplate,
  isWorkflowTemplateCompileRequest,
  parseWorkflowTemplateCompileRequest,
} from "./workflow-templates.js";
import {
  buildWorkflowStepContextPack,
  renderContextPack,
  type ContextPack,
} from "./context-packs.js";
import {
  maybeCompactWorkflowStepContext,
  type WorkflowStepContextCompactionSummary,
} from "./context-compaction.js";
import {
  readWorkflowStepContextPacketArtifact,
  readWorkflowStepOutputPacketArtifact,
} from "./workflow-step-packets.js";
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
import { assertChannelWorkspaceReady } from "./workspace.js";

const WORKFLOW_STEP_RESOURCE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

interface WorkflowEvidenceDiagnostic {
  readonly kind:
    | "missing_context_packet"
    | "missing_output_packet"
    | "missing_run"
    | "bad_packet"
    | "blocked"
    | "failed";
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export interface WorkflowStepRunRequest {
  readonly workspaceCwd: string;
  readonly cwd: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
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
  readonly contextPack?: WorkflowStepRunContextPackSnapshot;
  readonly contextCompactions?: readonly WorkflowStepContextCompactionSummary[];
}

export interface WorkflowStepRunContextPackSnapshot {
  readonly kind: ContextPack["kind"];
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: ContextPack["budget"];
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly role: string;
    readonly priority: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly sourceRefs: ContextPack["sourceRefs"];
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
  runnerRegistry?: RunnerRegistry,
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
        const compiled = compileWorkflowTemplate(store, input, new Date().toISOString(), runnerRegistry);
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

export async function handleChannelWorkflowEvidence(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow evidence` });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const evidence = buildWorkflowEvidence(store, workflowId);
    writeJson(response, 200, evidence);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelWorkflowStepEvidence(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow step evidence` });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const step = store.getChannelWorkflowStep(workflowStepId);
    if (!step) {
      throw new HttpError(404, "workflow_step_not_found", `Channel workflow step not found: ${workflowStepId}`);
    }
    const evidence = buildWorkflowEvidence(store, step.workflowId);
    const workflowStep = evidence.steps.find((item) => item.step.id === workflowStepId);
    if (!workflowStep) {
      throw new HttpError(404, "workflow_step_not_found", `Channel workflow step not found: ${workflowStepId}`);
    }
    writeJson(response, 200, {
      workflow: evidence.workflow,
      workflowStep,
      selectorDecisions: evidence.selectorDecisions.filter((decision) =>
        decision.sourceWorkflowStepId === workflowStepId || decision.selectedWorkflowStepId === workflowStepId,
      ),
      handoffIntents: evidence.handoffIntents.filter((intent) => intent.sourceWorkflowStepId === workflowStepId),
      handoffs: evidence.handoffs,
      approvals: evidence.approvals.filter((approval) => approval.workflowStepId === workflowStepId),
      memoryCandidates: evidence.memoryCandidates.filter((candidate) => candidate.sourceWorkflowStepIds.includes(workflowStepId)),
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
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
  const workspace = assertChannelWorkspaceReady(channel, cwd);
  if (!workspace.ok) {
    return block(workspace.message);
  }
  const runnerId = input.runnerId;
  const taskTitle = input.taskTitle ?? step.title;
  const workflowSteps = store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
  const contextPackInput = {
    store,
    channel,
    workflow,
    step,
    prompt: input.taskPrompt ?? step.prompt,
    providerPresetId,
    workflowSteps,
  };
  const initialContextPack = buildWorkflowStepContextPack(contextPackInput);
  const compacted = maybeCompactWorkflowStepContext({
    packInput: contextPackInput,
    contextPack: initialContextPack,
    now,
  });
  const contextPack = compacted.contextPack;
  if (contextPack.overBudget) {
    return block(`Workflow step context exceeds provider budget (${contextPack.estimatedInputTokens}/${contextPack.budget.inputBudgetTokens} estimated input tokens).`);
  }
  const taskPrompt = renderWorkflowStepContextPackPrompt(contextPack);
  const assigneeTeammateId = input.assigneeTeammateId ?? step.toParticipantId;
  const runRequestBase: WorkflowStepRunRequest = {
    workspaceCwd: cwd,
    cwd: workspace.executionCwd,
    providerPresetId,
    runnerId,
    teammateId: assigneeTeammateId,
    workflowStepId: step.id,
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
    contextPack: snapshotWorkflowStepContextPack(contextPack),
    contextCompactions: compacted.compactions,
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

export function buildWorkflowEvidence(store: RunStore, workflowId: string): {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly {
    readonly step: ChannelWorkflowStep;
    readonly contextPacket?: ReturnType<typeof readWorkflowStepContextPacketArtifact>;
    readonly outputPacket?: ReturnType<typeof readWorkflowStepOutputPacketArtifact>;
    readonly linkedRun?: ReturnType<RunStore["getRun"]>;
    readonly packetArtifacts: readonly RunArtifact[];
    readonly linkedArtifacts: readonly RunArtifact[];
    readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
  }[];
  readonly selectorDecisions: ReturnType<RunStore["listWorkflowSelectorDecisions"]>;
  readonly handoffIntents: ReturnType<RunStore["listWorkflowHandoffIntents"]>;
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: ReturnType<RunStore["listApprovalRequests"]>;
  readonly artifacts: readonly RunArtifact[];
  readonly memoryCandidates: readonly {
    readonly memory: MemoryObject;
    readonly sourceWorkflowId: string;
    readonly sourceWorkflowStepIds: readonly string[];
  }[];
} {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${workflowId}`);
  }
  const steps = store.listChannelWorkflowSteps({ workflowId, limit: 500 });
  const evidenceSteps = steps.map((step) => buildWorkflowEvidenceStep(store, step));
  const selectorDecisions = store.listWorkflowSelectorDecisions({ workflowId, limit: 500 });
  const handoffIntents = store.listWorkflowHandoffIntents({ workflowId, limit: 500 });
  const handoffIds = uniqueStrings([
    workflow.sourceHandoffId,
    ...steps.map((step) => step.sourceHandoffId),
    ...handoffIntents.map((intent) => intent.channelHandoffId),
  ]);
  const handoffs = handoffIds
    .map((handoffId) => handoffId ? store.getChannelHandoff(handoffId) : undefined)
    .filter((handoff): handoff is ChannelHandoff => Boolean(handoff));
  const approvals = steps.flatMap((step) => store.listApprovalRequests({ workflowStepId: step.id, limit: 500 }));
  const artifacts = uniqueArtifacts(evidenceSteps.flatMap((step) => [...step.packetArtifacts, ...step.linkedArtifacts]));
  return {
    workflow,
    steps: evidenceSteps,
    selectorDecisions,
    handoffIntents,
    handoffs,
    approvals,
    artifacts,
    memoryCandidates: collectWorkflowMemoryCandidates(store, workflow, steps, artifacts),
  };
}

function buildWorkflowEvidenceStep(store: RunStore, step: ChannelWorkflowStep): {
  readonly step: ChannelWorkflowStep;
  readonly contextPacket?: ReturnType<typeof readWorkflowStepContextPacketArtifact>;
  readonly outputPacket?: ReturnType<typeof readWorkflowStepOutputPacketArtifact>;
  readonly linkedRun?: ReturnType<RunStore["getRun"]>;
  readonly packetArtifacts: readonly RunArtifact[];
  readonly linkedArtifacts: readonly RunArtifact[];
  readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
} {
  const diagnostics: WorkflowEvidenceDiagnostic[] = [];
  const contextArtifact = step.metadata?.contextArtifactId ? store.getArtifact(step.metadata.contextArtifactId) : undefined;
  const outputArtifact = step.metadata?.outputArtifactId ? store.getArtifact(step.metadata.outputArtifactId) : undefined;
  const contextPacket = contextArtifact
    ? readWorkflowStepContextPacketArtifact({ store, artifactId: contextArtifact.id })
    : undefined;
  const outputPacket = outputArtifact
    ? readWorkflowStepOutputPacketArtifact({ store, artifactId: outputArtifact.id })
    : undefined;
  if (step.metadata?.contextArtifactId && !contextPacket) {
    diagnostics.push({ kind: "bad_packet", severity: "warning", message: "Context packet evidence could not be read." });
  } else if ((step.status === "running" || step.status === "succeeded") && !step.metadata?.contextArtifactId) {
    diagnostics.push({ kind: "missing_context_packet", severity: "info", message: "No context packet has been captured for this step." });
  }
  if (step.metadata?.outputArtifactId && !outputPacket) {
    diagnostics.push({ kind: "bad_packet", severity: "warning", message: "Output packet evidence could not be read." });
  } else if ((step.status === "succeeded" || step.status === "failed" || step.status === "blocked") && !step.metadata?.outputArtifactId) {
    diagnostics.push({ kind: "missing_output_packet", severity: "info", message: "No output packet has been captured for this terminal step." });
  }
  const linkedRun = step.runId ? store.getRun(step.runId) : undefined;
  if (step.runId && !linkedRun) {
    diagnostics.push({ kind: "missing_run", severity: "warning", message: "Linked run was not found." });
  }
  if (step.status === "blocked") {
    diagnostics.push({ kind: "blocked", severity: "warning", message: step.blocker ?? "Workflow step is blocked." });
  }
  if (step.status === "failed") {
    diagnostics.push({ kind: "failed", severity: "critical", message: step.blocker ?? step.resultSummary ?? "Workflow step failed." });
  }
  return {
    step,
    contextPacket,
    outputPacket,
    linkedRun,
    packetArtifacts: [contextArtifact, outputArtifact].filter((artifact): artifact is RunArtifact => Boolean(artifact)),
    linkedArtifacts: linkedRun ? store.listArtifacts(linkedRun.id) : [],
    diagnostics,
  };
}

function collectWorkflowMemoryCandidates(
  store: RunStore,
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  artifacts: readonly RunArtifact[],
): readonly { readonly memory: MemoryObject; readonly sourceWorkflowId: string; readonly sourceWorkflowStepIds: readonly string[] }[] {
  const sourceIds = new Set<string>([
    workflow.id,
    ...steps.map((step) => step.id),
    ...steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)),
    ...artifacts.map((artifact) => artifact.id),
  ]);
  return store.listMemoryObjects({ workspaceId: workflow.workspaceId, reviewState: "candidate", limit: 500 })
    .filter((memory) => memory.sourceRefs.some((ref) => sourceIds.has(ref.id)))
    .map((memory) => ({
      memory,
      sourceWorkflowId: workflow.id,
      sourceWorkflowStepIds: steps
        .filter((step) => memory.sourceRefs.some((ref) => buildWorkflowStepEvidenceSourceIds(store, step).has(ref.id)))
        .map((step) => step.id),
    }));
}

function buildWorkflowStepEvidenceSourceIds(store: RunStore, step: ChannelWorkflowStep): ReadonlySet<string> {
  return new Set([
    step.id,
    step.runId,
    step.metadata?.contextArtifactId,
    step.metadata?.outputArtifactId,
    step.metadata?.fanInSummaryArtifactId,
    ...(step.metadata?.outputArtifactIds ?? []),
    ...(step.runId ? store.listArtifacts(step.runId).map((artifact) => artifact.id) : []),
  ].filter((id): id is string => Boolean(id)));
}

function renderWorkflowStepContextPackPrompt(pack: ContextPack): string {
  return [
    `Context Pack: ${pack.kind}`,
    `Provider budget mode: ${pack.budget.mode}`,
    `Provider model: ${pack.modelId ?? "unknown"}`,
    `Estimated input tokens: ${pack.estimatedInputTokens}/${pack.budget.inputBudgetTokens}`,
    `Dropped sections: ${pack.droppedSectionIds.length > 0 ? pack.droppedSectionIds.join(", ") : "none"}`,
    "Workflow context artifact: pending until run starts",
    "",
    renderContextPack(pack),
  ].join("\n");
}

function snapshotWorkflowStepContextPack(pack: ContextPack): WorkflowStepRunContextPackSnapshot {
  return {
    kind: pack.kind,
    providerPresetId: pack.providerPresetId,
    modelId: pack.modelId,
    budget: pack.budget,
    estimatedInputTokens: pack.estimatedInputTokens,
    overBudget: pack.overBudget,
    droppedSectionIds: pack.droppedSectionIds,
    compactionIds: pack.compactionIds,
    sections: pack.sections.map((section) => ({
      id: section.id,
      role: section.role,
      priority: section.priority,
      estimatedTokens: section.estimatedTokens,
      sourceRefIds: section.sourceRefIds,
      metadata: section.metadata,
    })),
    sourceRefs: pack.sourceRefs,
  };
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function uniqueArtifacts(values: readonly RunArtifact[]): readonly RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const artifact of values) {
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
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
