import { recallMemory } from "../memory/recall-service.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  type ChannelWorkflow,
  type ChannelHandoff,
  type ChannelMessage,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type RunStore,
  type RunTool,
  type SecretResolver,
  type SkillApprovalProfile,
  type Task,
  type WorkflowStepStartOwnerV1,
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
import { getWorkflowPlanModeBlocker } from "./plan-mode-guard.js";
import {
  maybeCompactWorkflowStepContext,
  type WorkflowStepContextCompactionSummary,
} from "./context-compaction.js";
import {
  buildChannelCollaborationCardsFromStore,
  buildWorkflowCollaborationCardFromStore,
} from "./collaboration-cards.js";
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
import {
  maybeScheduleWorkflowTerminalReport,
  terminalReportsEnabledForStore,
} from "./terminal-report-coordinator.js";
import { buildWorkflowEvidence } from "./workflow-evidence.js";
import { renderUsedMemoryPromptForView } from "../memory/prompt.js";
import { reviewWorkflowFanInContext } from "./workflow-fanin.js";
import type { PreselectedMemoryUse } from "../runs/schemas.js";
import { createWorkflowOperationExecutionSnapshot, type WorkflowOperationExecutionSnapshot } from "../runs/workflow-operation-snapshot.js";
import type {
  ChannelIntentExecutionOperationV1,
  DelegatedBlockCodeV1,
  DelegatedStepRequirementV1,
  WorkflowParticipantProviderBindingV1,
} from "@ling-stack/contracts";
import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import { resolveWorkflowHandoffExecutionContext } from "./workflow-handoffs.js";
import { evaluateWorkflowCompletionGate } from "./workflow-completion-gate.js";
import { completeWorkflowIfStepsFinished } from "./workflow-completion.js";
import { projectWorkflowStepNarration } from "./workflow-step-narration.js";
import { workflowStepExecutionOperationBindings } from "./workflow-operation-evidence.js";
import {
  resolveWorkflowParticipantRunProfile,
} from "./workflow-participant-run-profile.js";
import { mergeWorkflowApprovalProfiles } from "./workflow-step-run-policy.js";
import { preflightWorkflowParticipantProvider } from "./workflow-participant-provider.js";
export { completeWorkflowIfStepsFinished } from "./workflow-completion.js";

const WORKFLOW_STEP_RESOURCE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface WorkflowStepRunRequest {
  readonly workspaceCwd: string;
  readonly cwd: string;
  readonly providerPresetId?: string;
  readonly providerBinding?: WorkflowParticipantProviderBindingV1;
  readonly runnerId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly workflowStartOwner?: WorkflowStepStartOwnerV1;
  /** Canonical channel message that owns this workflow step's evidence. */
  readonly sourceMessageId?: string;
  readonly delegatedRequirement?: DelegatedStepRequirementV1;
  /** Internal-only Host execution bindings for workflow-owned operations. */
  readonly executionOperationBindings?: readonly ChannelIntentExecutionOperationV1[];
  readonly workflowOperationExecution?: WorkflowOperationExecutionSnapshot;
  readonly requestedSkillId?: string;
  readonly skipProviderPreflight?: boolean;
  readonly skipMemoryRecall?: boolean;
  readonly preselectedMemoryUse?: PreselectedMemoryUse;
  readonly idempotencyKey?: string;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly channelId?: string;
  };
  readonly tools?: readonly RunTool[];
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  readonly contextPack?: WorkflowStepRunContextPackSnapshot;
  readonly contextProjection?: ContextPack["contextProjection"];
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
    readonly compactionSurvival?: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly sourceRefs: ContextPack["sourceRefs"];
  readonly contextProjection?: ContextPack["contextProjection"];
  readonly agentContext?: ContextPack["agentContext"];
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

export async function handleChannelCollaborationCardsCollection(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel collaboration cards` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    writeJson(response, 200, {
      cwd,
      channelId,
      cards: buildChannelCollaborationCardsFromStore({
        store,
        channelId,
        limit: readOptionalIntegerQuery(url, "limit", 50),
      }),
    });
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
    const existingWorkflow = store.getChannelWorkflowForHandoff(handoff.channelId, handoff.id);
    const existingWorkflowStep = existingWorkflow
      ? store.listChannelWorkflowSteps({ workflowId: existingWorkflow.id, complete: true })
        .find((step) => step.sourceHandoffId === handoff.id)
      : undefined;
    if (existingWorkflow && existingWorkflowStep) {
      writeJson(response, 200, { workflow: existingWorkflow, workflowStep: existingWorkflowStep });
      return;
    }
    const createdAt = new Date().toISOString();
    const continuityContext = resolveWorkflowHandoffExecutionContext({
      store,
      channelHandoffId: handoff.id,
      now: createdAt,
    });
    if (continuityContext.blocker) {
      throw new Error(`Workflow handoff cannot start: ${continuityContext.blocker}`);
    }
    const sourceItemId = continuityContext.sourceItemId ?? handoff.sourceMessageId;
    const result = store.createOrReuseChannelHandoffWorkflow(
      {
        channelId: handoff.channelId,
        sourceHandoffId: handoff.id,
        workflow: {
          title: input.title ?? `Handoff to ${handoff.toParticipantLabel}`,
          objective: input.objective ?? (handoff.expectedOutput || handoff.reason || "Complete handoff workflow."),
          createdBy: input.createdBy,
          metadata: sourceItemId ? { sourceMessageId: sourceItemId } : undefined,
        },
        workflowStep: {
          contextSummaryId: input.contextSummaryId,
          title: `Complete handoff: ${handoff.expectedOutput || handoff.reason || handoff.toParticipantLabel}`,
          prompt: formatHandoffStepPrompt(handoff),
          toParticipantId: handoff.toParticipantId,
          toParticipantLabel: handoff.toParticipantLabel,
          participantAuthority: createWorkflowParticipantAuthorityV1({
            kind: "workflow_definition",
            origin: "channel_handoff",
            participantId: handoff.toParticipantId,
            sourceId: handoff.id,
          }),
          metadata: sourceItemId ? { sourceMessageId: sourceItemId } : undefined,
        },
      },
      createdAt,
    );
    writeJson(response, result.reused ? 200 : 201, {
      workflow: result.workflow,
      workflowStep: result.workflowStep,
    });
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
        }).map(step => projectWorkflowStepNarration(store, step)),
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
      writeJson(response, 200, { workflowStep: projectWorkflowStepNarration(store, existing) });
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

export async function handleChannelWorkflowCollaborationCard(
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
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow collaboration card` });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const workflow = store.getChannelWorkflow(workflowId);
    if (!workflow) {
      throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${workflowId}`);
    }
    writeJson(response, 200, {
      cwd,
      workflowId,
      card: buildWorkflowCollaborationCardFromStore({ store, workflow }),
    });
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
      approvalCheckpoints: evidence.approvalCheckpoints.filter((checkpoint) => checkpoint.workflowStepId === workflowStepId),
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
  secretResolver?: SecretResolver,
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
    await handleChannelWorkflowStepStart(request, response, config, storeRegistry, cwd, existing.id, validateRunRequest, startRun, secretResolver);
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
  secretResolver?: SecretResolver,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow step start` });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const body = await readJsonBody(request, config.maxBodyBytes);
  const input = parseChannelWorkflowStepStartRequest(body);
  const started = await prepareWorkflowStepStart(store, workflowStepId, input, cwd, validateRunRequest, secretResolver);
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
    if (store.getChannelWorkflowStep(workflowStepId)?.status !== "succeeded") {
      writeJson(response, 409, {
        error: "workflow_task_creation_stale",
        message: "An execution-backed workflow step cannot complete by creating a task without verified operation evidence.",
      });
      return;
    }
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
    const owner = started.runRequest.workflowStartOwner;
    if (owner) store.settleChannelWorkflowStepStartFailure({ workflowStepId, owner,
      leaseId: owner.leaseId, blocker: "Run did not start.", now: completedAt });
    return;
  }
}

export type PreparedWorkflowStepStart =
  | { readonly kind: "ready"; readonly workflowId: string; readonly task: Task; readonly runRequest: WorkflowStepRunRequest }
  | { readonly kind: "blocked"; readonly workflowId: string; readonly blocker: string }
  | { readonly kind: "error"; readonly statusCode: number; readonly code: string; readonly message: string };

export async function prepareWorkflowStepStart(
  store: RunStore,
  workflowStepId: string,
  input: ChannelWorkflowStepStartRequest,
  cwd: string,
  validateRunRequest: ValidateWorkflowStepRunRequest,
  secretResolver?: SecretResolver,
): Promise<PreparedWorkflowStepStart> {
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
  const planModeBlocker = getWorkflowPlanModeBlocker(store, workflow);
  if (planModeBlocker) {
    return { kind: "error", statusCode: 409, code: "plan_mode_workflow_blocked", message: planModeBlocker };
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
    store.releaseResourceLease(lease.id, "workflow_step", step.id, new Date().toISOString());
    return { kind: "error", statusCode, code, message };
  };
  const block = (
    message: string,
    participantProfileBlocker?: {
      readonly code: DelegatedBlockCodeV1;
      readonly reason: string;
      readonly missingRequirements: readonly string[];
    },
  ): PreparedWorkflowStepStart => {
    const blockedAt = new Date().toISOString();
    const settled = store.settleChannelWorkflowStepStartFailure({ workflowStepId: step.id, expected: step,
      leaseId: lease.id, blocker: message, delegatedBlock: participantProfileBlocker,
      fanInContextReviews: fanInContext.reviews, now: blockedAt });
    if (settled.status === "stale" || settled.status === "invalid") return fail(409, "workflow_step_preflight_stale", message);
    return { kind: "blocked", workflowId: workflow.id, blocker: message };
  };

  const fanInContext = reviewWorkflowFanInContext({ store, workflow, step });
  if (fanInContext.blocker) {
    return block(fanInContext.blocker);
  }

  let providerPresetId = input.providerPresetId ?? step.metadata?.providerPresetId ?? channel.defaultProviderPresetId;
  let providerBinding = step.metadata?.providerBinding;
  const workspace = assertChannelWorkspaceReady(channel, cwd);
  if (!workspace.ok) {
    return block(workspace.message);
  }
  const runnerId = input.runnerId;
  const taskTitle = input.taskTitle ?? step.title;
  const requestedAssigneeTeammateId = input.assigneeTeammateId ?? step.toParticipantId;
  const runTools = workflowStepRunTools(step.metadata?.requiredTools);
  const participantProfile = input.mode === "create_and_run_task"
    ? resolveWorkflowParticipantRunProfile({
        store,
        channel,
        step,
        requestedAssigneeTeammateId,
        requiredTools: step.metadata?.requiredTools ?? [],
      })
    : undefined;
  if (participantProfile?.kind === "blocked") {
    return block(participantProfile.reason, participantProfile);
  }
  const assigneeTeammateId = participantProfile?.teammateId ?? requestedAssigneeTeammateId;
  if (participantProfile?.kind === "ready" && step.metadata?.delegatedRequirement && !providerBinding) {
    const reason = `Manifest-backed workflow step ${step.id} has no valid frozen provider binding.`;
    return block(reason, {
      code: "workflow_participant_provider_binding_missing",
      reason,
      missingRequirements: ["provider_binding"],
    });
  }
  if (participantProfile?.kind === "ready" && providerBinding) {
    if (input.providerPresetId && input.providerPresetId !== providerBinding.providerPresetId) {
      const reason = `Workflow participant provider binding is ${providerBinding.providerPresetId}; override ${input.providerPresetId} is forbidden.`;
      return block(reason, {
        code: "workflow_participant_provider_override_forbidden",
        reason,
        missingRequirements: ["provider_binding"],
      });
    }
    const providerPreflight = preflightWorkflowParticipantProvider({
      store,
      channel,
      teammate: participantProfile.teammate,
      cwd,
      validateRunRequest,
      requiredTools: runTools,
      frozenBinding: providerBinding,
    });
    if (providerPreflight.kind === "blocked") {
      return block(providerPreflight.blocker.message, {
        code: providerPreflight.blocker.code,
        reason: providerPreflight.blocker.message,
        missingRequirements: [
          `provider:${providerPreflight.blocker.reasonCode}`,
          `repair:${providerPreflight.blocker.repairTarget}`,
        ],
      });
    }
    providerBinding = providerPreflight.binding;
    providerPresetId = providerBinding.providerPresetId;
  }
  const workflowSteps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  const memoryRecallQuery = `${workflow.objective}\n${step.title}\n${input.taskPrompt ?? step.prompt}`;
  const memoryRecall = await recallMemory(store, {
    teammateId: assigneeTeammateId,
    channelId: channel.id,
    intent: "task-run",
    query: memoryRecallQuery,
    maxResults: 6,
  });
  const renderedMemory = renderUsedMemoryPromptForView({
    memories: memoryRecall.memories,
    recallPolicyVersion: memoryRecall.policyVersion,
    viewKind: "workflow_step_view",
    workspaceId: workflow.workspaceId,
    channelId: channel.id,
    consumerTeammateId: assigneeTeammateId,
  });
  const contextPackInput = {
    store,
    secretResolver,
    channel,
    workflow,
    step,
    prompt: input.taskPrompt ?? step.prompt,
    providerPresetId,
    consumerTeammateId: assigneeTeammateId,
    workflowSteps,
    roleEvidence: {
      section: renderedMemory.prompt ? {
        id: "workflow_role_evidence",
        role: "memory" as const,
        priority: "medium" as const,
        compactionSurvival: "summarize" as const,
        title: "workflow_role_evidence",
        text: renderedMemory.prompt,
        sourceRefIds: renderedMemory.memoryIds,
        visibility: "prompt" as const,
        quotePolicy: "influence_only" as const,
        metadata: {
          policyVersion: renderedMemory.policyVersion,
          consumerTeammateId: assigneeTeammateId,
        },
      } : undefined,
      sourceRefs: renderedMemory.memoryIds.map((memoryId) => ({
        type: "memory",
        id: memoryId,
        label: "role-scoped memory",
      })),
      sources: renderedMemory.sources,
      dropped: [],
    },
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
  const unavailableRequiredTools = workflowStepUnavailableRequiredTools(channel.allowedTools, step.metadata);
  if (unavailableRequiredTools.length > 0) {
    return block(`Workflow step requires tools not allowed in this channel: ${unavailableRequiredTools.join(", ")}.`);
  }
  const runRequestBase: WorkflowStepRunRequest = {
    workspaceCwd: cwd,
    cwd: workspace.executionCwd,
    providerPresetId,
    providerBinding,
    runnerId,
    teammateId: assigneeTeammateId,
    workflowStepId: step.id,
    sourceMessageId: step.metadata?.sourceMessageId ?? workflow.metadata?.sourceMessageId,
    delegatedRequirement: step.metadata?.delegatedRequirement,
    executionOperationBindings: workflowStepExecutionOperationBindings(step),
    workflowOperationExecution: createWorkflowOperationExecutionSnapshot(step),
    skipProviderPreflight: input.skipProviderPreflight ?? false,
    skipMemoryRecall: true,
    preselectedMemoryUse: renderedMemory.memoryIds.length > 0
      ? {
          memoryIds: renderedMemory.memoryIds,
          recallQuery: memoryRecallQuery,
          policyVersion: renderedMemory.policyVersion,
        }
      : undefined,
    idempotencyKey: input.idempotencyKey ?? `workflow-step:${step.id}`,
    systemPrompt: participantProfile?.systemPrompt,
    appendSystemPrompt: participantProfile?.appendSystemPrompt,
    approvalProfile: mergeWorkflowApprovalProfiles(
      participantProfile?.approvalProfile,
      step.metadata?.approvalGate,
    ),
    task: {
      id: "pending",
      title: taskTitle,
      prompt: taskPrompt,
      channelId: channel.id,
    },
    tools: runTools,
    thinkingLevel: "medium",
    contextPack: snapshotWorkflowStepContextPack(contextPack),
    contextProjection: contextPack.contextProjection,
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

  const begun = store.beginChannelWorkflowStepStart({
    workflowStepId: step.id, expected: step, leaseId: lease.id, now: new Date().toISOString(),
    createTaskOnly: input.mode === "create_task",
    fanInContextReviews: fanInContext.reviews,
    task: {
      channelId: channel.id,
      title: taskTitle,
      prompt: input.taskPrompt ?? step.prompt,
      assigneeTeammateId,
    },
  });
  if (begun.status !== "begun") return fail(409, begun.code, "Workflow start ownership changed during preparation.");
  const task = begun.task;
  return {
    kind: "ready",
    workflowId: workflow.id,
    task,
    runRequest: {
      ...runRequestBase,
      workflowStartOwner: begun.owner,
      task: {
        id: task.id,
        title: task.title,
        prompt: taskPrompt,
        channelId: task.channelId,
      },
    },
  };
}

function workflowStepUnavailableRequiredTools(
  channelAllowedTools: readonly RunTool[],
  stepMetadata: ChannelWorkflowStep["metadata"] | undefined,
): readonly RunTool[] {
  const stepRequiredTools = stepMetadata?.requiredTools;
  if (!stepRequiredTools || stepRequiredTools.length === 0) {
    return [];
  }
  return stepRequiredTools.filter((tool) => !channelAllowedTools.includes(tool));
}

function workflowStepRunTools(
  stepRequiredTools: readonly RunTool[] | undefined,
): readonly RunTool[] {
  if (stepRequiredTools === undefined) {
    return [];
  }
  return [...new Set(stepRequiredTools)];
}

export function reconcileContinuityWorkflowCompletion(store: RunStore, now = new Date().toISOString()): number {
  let reconciled = 0;
  const channelIds = new Set(store.listChannels({ limit: 500 }).map((channel) => channel.id));
  for (const channelId of channelIds) {
    const workflows = store.listChannelWorkflows({ channelId, limit: 500 });
    for (const workflow of workflows) {
      if (!workflow.metadata?.requiredParticipantManifest) continue;
      if (workflow.status === "running") {
        const before = workflow.status;
        completeWorkflowIfStepsFinished(store, workflow.id, now);
        if (store.getChannelWorkflow(workflow.id)?.status !== before) reconciled += 1;
        continue;
      }
      if (workflow.status === "succeeded") {
        const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
        const gate = evaluateWorkflowCompletionGate({ store, workflow, steps, now });
        if (gate?.status === "verified" && gate.basisFingerprint !== workflow.metadata.completionGate?.basisFingerprint) {
          store.updateChannelWorkflow(workflow.id, { metadata: { ...workflow.metadata, completionGate: gate } }, now);
          reconciled += 1;
        }
      }
    }
  }
  return reconciled;
}

export function maybeCreateWorkflowTerminalCoordinatorReply(
  store: RunStore,
  workflowId: string,
  input: {
    readonly now?: string;
    readonly linkedRunId?: string;
  } = {},
): ChannelMessage | undefined {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow || !workflowCoordinatorReplyStatusIsTerminal(workflow.status)) {
    return undefined;
  }
  if (!terminalReportsEnabledForStore(store)) return undefined;
  return maybeScheduleWorkflowTerminalReport(store, workflowId, input);
}

function workflowCoordinatorReplyStatusIsTerminal(status: ChannelWorkflowStatus): boolean {
  return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled";
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
      compactionSurvival: section.compactionSurvival,
      estimatedTokens: section.estimatedTokens,
      sourceRefIds: section.sourceRefIds,
      metadata: section.metadata,
    })),
    sourceRefs: pack.sourceRefs,
    contextProjection: pack.contextProjection,
    agentContext: pack.agentContext,
  };
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
