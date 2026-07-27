import type { Dispatch, SetStateAction } from "react";
import type { RunsActions } from "../domains/runs/use-runs-domain.js";
import type { useWorkspaceCommandController } from "../domains/workspace/use-workspace-command-controller.js";
import { providerPreflightReady } from "../lib/providers.js";
import type { DomainEvent } from "./domain-events.js";
import { mergeWorkflowSteps } from "./app-shell-selectors.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelBrief,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  ProviderPreset,
  RunFormState,
  Task,
} from "../types.js";

type WorkspaceCommands = ReturnType<typeof useWorkspaceCommandController>;

export interface ChannelWorkflowController {
  readonly startAutoplanWorkflow: () => Promise<void>;
  readonly orchestrateWorkflowAction: (workflow: ChannelWorkflow) => Promise<void>;
  readonly cancelWorkflowAction: (workflow: ChannelWorkflow) => Promise<void>;
  readonly retryWorkflowStepAction: (step: ChannelWorkflowStep) => Promise<void>;
  readonly startWorkflowStepAction: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => Promise<void>;
  readonly updateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => Promise<void>;
}

export function useChannelWorkflowController(input: {
  readonly form: RunFormState;
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly selectedChannelId: string;
  readonly taskRunProviderId: string;
  readonly channelBrief: ChannelBrief | undefined;
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly daemonBaseUrl: string;
  readonly setOrchestratingWorkflowId: Dispatch<SetStateAction<string>>;
  readonly setRunningWorkflowStepId: Dispatch<SetStateAction<string>>;
  readonly setChannelWorkflows: Dispatch<SetStateAction<readonly ChannelWorkflow[]>>;
  readonly setChannelWorkflowSteps: Dispatch<SetStateAction<readonly ChannelWorkflowStep[]>>;
  readonly setSelectedTaskId: Dispatch<SetStateAction<string>>;
  readonly setTasks: Dispatch<SetStateAction<readonly Task[]>>;
  readonly reportWorkflowError: (identity: string, message: string, scope?: "validation" | "mutation" | "stream") => void;
  readonly clearWorkflowError: (identity: string) => void;
  readonly createChannelWorkflowFromTemplate: WorkspaceCommands["createChannelWorkflowFromTemplate"];
  readonly orchestrateChannelWorkflow: WorkspaceCommands["orchestrateChannelWorkflow"];
  readonly cancelChannelWorkflow: WorkspaceCommands["cancelChannelWorkflow"];
  readonly retryChannelWorkflowStep: WorkspaceCommands["retryChannelWorkflowStep"];
  readonly startChannelWorkflowStep: WorkspaceCommands["startChannelWorkflowStep"];
  readonly updateChannelWorkflowStep: WorkspaceCommands["updateChannelWorkflowStep"];
  readonly streamRunRequest: RunsActions["streamRunRequest"];
  readonly upsertApprovalRecord: (approval: ApprovalRequest) => void;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd: string) => Promise<void>;
  readonly emitDomainEvent: (event: DomainEvent) => Promise<void>;
}): ChannelWorkflowController {
  async function orchestrateWorkflowById(workflowId: string, channelId?: string): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.reportWorkflowError(workflowId, "本地工作区未就绪", "validation");
      return;
    }

    input.setOrchestratingWorkflowId(workflowId);
    try {
      input.clearWorkflowError(workflowId);
      const result = await input.orchestrateChannelWorkflow(workspaceCwd, workflowId);
      input.setChannelWorkflows((current) => [result.workflow, ...current.filter((item) => item.id !== result.workflow.id)]);
      const workflowStep = "workflowStep" in result ? result.workflowStep : undefined;
      if (workflowStep) {
        input.setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, [workflowStep]));
      }
      if ("approval" in result && result.approval) {
        input.upsertApprovalRecord(result.approval);
      }
      if (result.status === "blocked" || result.status === "failed") {
        input.reportWorkflowError(workflowId, result.blocker);
      } else if (result.status === "idle" && result.reason) {
        input.reportWorkflowError(workflowId, result.reason);
      }
      await input.emitDomainEvent({
        type: "workflow.advanced",
        workflowId,
        channelId: channelId ?? input.selectedChannelId,
      });
    } catch (error) {
      input.reportWorkflowError(workflowId, error instanceof Error ? error.message : String(error));
    } finally {
      input.setOrchestratingWorkflowId((current) => current === workflowId ? "" : current);
    }
  }

  async function startAutoplanWorkflow(): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    const feedbackIdentity = `new:${input.selectedChannelId || "unselected"}`;
    if (!workspaceCwd || !input.selectedChannelId) {
      input.reportWorkflowError(feedbackIdentity, "请先选择 channel", "validation");
      return;
    }

    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const providerPresetId =
      input.taskRunProviderId ||
      selectedChannel?.defaultProviderPresetId ||
      input.form.providerPresetId ||
      input.providers.find(providerPreflightReady)?.id;
    const objective = (input.channelBrief?.objective || selectedChannel?.name || "Run the built-in autoplan-lite workflow.").trim();
    input.setOrchestratingWorkflowId("new:autoplan-lite");
    try {
      input.clearWorkflowError(feedbackIdentity);
      const response = await input.createChannelWorkflowFromTemplate(workspaceCwd, input.selectedChannelId, {
        templateId: "autoplan-lite",
        title: `${selectedChannel?.name ?? "Channel"} autoplan`,
        objective,
        createdBy: "local-user",
        providerPresetId: providerPresetId || undefined,
        autoStart: true,
      });
      input.setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      input.setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, response.workflowSteps));
      await orchestrateWorkflowById(response.workflow.id, response.workflow.channelId);
    } catch (error) {
      input.reportWorkflowError(feedbackIdentity, error instanceof Error ? error.message : String(error));
    } finally {
      input.setOrchestratingWorkflowId((current) => current === "new:autoplan-lite" ? "" : current);
    }
  }

  async function orchestrateWorkflowAction(workflow: ChannelWorkflow): Promise<void> {
    await orchestrateWorkflowById(workflow.id, workflow.channelId);
  }

  async function cancelWorkflowAction(workflow: ChannelWorkflow): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.reportWorkflowError(workflow.id, "本地工作区未就绪", "validation");
      return;
    }

    input.setOrchestratingWorkflowId(workflow.id);
    try {
      input.clearWorkflowError(workflow.id);
      const response = await input.cancelChannelWorkflow(workspaceCwd, workflow.id);
      input.setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      input.setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, response.workflowSteps));
      await input.emitDomainEvent({
        type: "workflow.cancelled",
        workflowId: workflow.id,
        channelId: workflow.channelId,
        runIds: [],
      });
    } catch (error) {
      input.reportWorkflowError(workflow.id, error instanceof Error ? error.message : String(error));
    } finally {
      input.setOrchestratingWorkflowId((current) => current === workflow.id ? "" : current);
    }
  }

  async function retryWorkflowStepAction(step: ChannelWorkflowStep): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.reportWorkflowError(step.id, "本地工作区未就绪", "validation");
      return;
    }

    input.setRunningWorkflowStepId(step.id);
    try {
      input.clearWorkflowError(step.id);
      const result = await input.retryChannelWorkflowStep(workspaceCwd, step.id);
      input.setChannelWorkflows((current) => [result.workflow, ...current.filter((item) => item.id !== result.workflow.id)]);
      const workflowStep = "workflowStep" in result ? result.workflowStep : undefined;
      if (workflowStep) {
        input.setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, [workflowStep]));
      }
      if ("approval" in result && result.approval) {
        input.upsertApprovalRecord(result.approval);
      }
      if (result.status === "blocked" || result.status === "failed") {
        input.reportWorkflowError(step.id, result.blocker);
      } else if (result.status === "idle" && result.reason) {
        input.reportWorkflowError(step.id, result.reason);
      }
      await input.emitDomainEvent({
        type: "workflowStep.retried",
        workflowId: step.workflowId,
        workflowStepId: step.id,
        channelId: step.channelId,
      });
    } catch (error) {
      input.reportWorkflowError(step.id, error instanceof Error ? error.message : String(error));
    } finally {
      input.setRunningWorkflowStepId((current) => current === step.id ? "" : current);
    }
  }

  async function startWorkflowStepAction(step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.reportWorkflowError(step.id, "本地工作区未就绪", "validation");
      return;
    }
    const workflow = input.channelWorkflows.find((item) => item.id === step.workflowId);
    const channel = workflow ? input.channels.find((item) => item.id === workflow.channelId) : input.channels.find((item) => item.id === step.channelId);
    const providerPresetId =
      input.taskRunProviderId ||
      channel?.defaultProviderPresetId ||
      input.form.providerPresetId ||
      input.providers.find(providerPreflightReady)?.id;
    const request = {
      mode,
      providerPresetId,
      assigneeTeammateId: step.toParticipantId,
    };

    input.setRunningWorkflowStepId(step.id);
    try {
      input.clearWorkflowError(step.id);
      if (mode === "create_task") {
        const response = await input.startChannelWorkflowStep(workspaceCwd, step.id, request);
        if (response.workflow) {
          input.setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
        }
        input.setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
        const createdTask = response.task;
        if (createdTask) {
          input.setSelectedTaskId(createdTask.id);
          input.setTasks((current) => [createdTask, ...current.filter((item) => item.id !== createdTask.id)]);
        }
        if (response.blocker) {
          input.reportWorkflowError(step.id, response.blocker);
        }
        await Promise.all([input.refreshTasks(step.channelId), input.refreshChannelProtocol(step.channelId), input.refreshRuntimeState(workspaceCwd)]);
        return;
      }

      const url = `${input.daemonBaseUrl}/workflow-steps/${encodeURIComponent(step.id)}/start?cwd=${encodeURIComponent(workspaceCwd)}`;
      await input.streamRunRequest(url, request, workspaceCwd, async () => {
        await Promise.all([
          input.refreshTasks(step.channelId),
          input.refreshChannelProtocol(step.channelId),
        ]);
      });
      await Promise.all([input.refreshTasks(step.channelId), input.refreshChannelProtocol(step.channelId), input.refreshRuntimeState(workspaceCwd)]);
    } catch (error) {
      input.reportWorkflowError(step.id, error instanceof Error ? error.message : String(error));
    } finally {
      input.setRunningWorkflowStepId((current) => current === step.id ? "" : current);
    }
  }

  async function updateWorkflowStepStatus(step: ChannelWorkflowStep, status: "skipped" | "cancelled"): Promise<void> {
    try {
      input.clearWorkflowError(step.id);
      const response = await input.updateChannelWorkflowStep(input.form.cwd.trim(), step.id, { status });
      input.setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
      if (response.workflow) {
        input.setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
      }
      await input.emitDomainEvent({
        type: "workflowStep.updated",
        workflowId: step.workflowId,
        workflowStepId: step.id,
        channelId: step.channelId,
      });
    } catch (error) {
      input.reportWorkflowError(step.id, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    startAutoplanWorkflow,
    orchestrateWorkflowAction,
    cancelWorkflowAction,
    retryWorkflowStepAction,
    startWorkflowStepAction,
    updateWorkflowStepStatus,
  };
}
