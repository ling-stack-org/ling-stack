import type { Dispatch, SetStateAction } from "react";
import type { RunsActions } from "../domains/runs/use-runs-domain.js";
import type { useRunCommandController } from "../domains/runs/use-run-command-controller.js";
import type { useWorkspaceCommandController } from "../domains/workspace/use-workspace-command-controller.js";
import { channelToForm } from "../lib/channels.js";
import {
  canUseProviderForRun,
  providerEffectiveBaseUrl,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
} from "../lib/providers.js";
import { readRunWorkspaceCwd } from "../lib/run-evidence.js";
import { mergeWorkflowSteps } from "./app-shell-selectors.js";
import type {
  AiTeammate,
  Channel,
  ChannelExecutionProposal,
  ChannelFormState,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ProviderPreset,
  ProviderTemplate,
  RunFormState,
  RunSession,
  Task,
  TaskEditFormState,
  TaskRunActionState,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettings,
} from "../types.js";

type RunCommands = ReturnType<typeof useRunCommandController>;
type WorkspaceCommands = ReturnType<typeof useWorkspaceCommandController>;

export interface TaskRunController {
  readonly removeTask: (taskId: string) => Promise<void>;
  readonly moveTaskToReview: (taskId: string) => Promise<void>;
  readonly saveTaskEdit: (taskId: string) => Promise<Task | undefined>;
  readonly resolveChannelMessageProviderPresetId: (channel: Channel | undefined, teammateId: string | undefined) => string;
  readonly markChannelExecutionProposal: (
    proposal: ChannelExecutionProposal,
    request: Parameters<WorkspaceCommands["updateChannelExecutionProposal"]>[2],
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly confirmChannelExecutionProposal: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly cancelChannelExecutionProposal: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly runPersistedTask: (task: Task, options?: RunPersistedTaskOptions) => Promise<boolean>;
  readonly checkThenRunPersistedTask: (task: Task) => Promise<boolean>;
  readonly runUpdatedTaskFromRepair: (task: Task) => Promise<void>;
  readonly checkThenRunUpdatedTaskFromRepair: (task: Task) => Promise<void>;
  readonly rerunRun: (sourceRun: RunSession) => Promise<void>;
  readonly applyProviderToRun: (provider: ProviderPreset, options?: ProviderDefaultScopeOptions) => Promise<void>;
  readonly clearProviderFromRun: (provider?: ProviderPreset, options?: ProviderDefaultScopeOptions) => Promise<void>;
}

type ProviderDefaultScope = "workspace" | "channel";

interface ProviderDefaultScopeOptions {
  readonly scope?: ProviderDefaultScope;
}

interface RunPersistedTaskOptions {
  readonly skipPreflight?: boolean;
  readonly action?: TaskRunActionState["action"];
  readonly providerPresetIdOverride?: string;
  readonly toolsOverride?: readonly Channel["allowedTools"][number][];
  readonly approvalProfileOverride?: AiTeammate["approvalProfile"];
  readonly afterRunLoaded?: (runId: string) => Promise<void>;
}

export function useTaskRunController(input: {
  readonly form: RunFormState;
  readonly taskEditForm: TaskEditFormState;
  readonly taskRunProviderId: string;
  readonly selectedChannelId: string;
  readonly selectedTaskId: string;
  readonly channels: readonly Channel[];
  readonly aiTeammates: readonly AiTeammate[];
  readonly providers: readonly ProviderPreset[];
  readonly providerTemplates: readonly ProviderTemplate[];
  readonly setForm: Dispatch<SetStateAction<RunFormState>>;
  readonly setTaskRepairRunId: Dispatch<SetStateAction<string>>;
  readonly setTaskRunProviderId: Dispatch<SetStateAction<string>>;
  readonly setActiveTaskRunAction: Dispatch<SetStateAction<TaskRunActionState | undefined>>;
  readonly setSelectedTaskId: Dispatch<SetStateAction<string>>;
  readonly setTasks: Dispatch<SetStateAction<readonly Task[]>>;
  readonly setChannels: Dispatch<SetStateAction<readonly Channel[]>>;
  readonly setChannelEditForm: Dispatch<SetStateAction<ChannelFormState>>;
  readonly setChannelWorkflows: Dispatch<SetStateAction<readonly ChannelWorkflow[]>>;
  readonly setChannelWorkflowSteps: Dispatch<SetStateAction<readonly ChannelWorkflowStep[]>>;
  readonly setErrorMessage: (message: string) => void;
  readonly t: (value: string, values?: Record<string, string | number>) => string;
  readonly patchWorkspaceSettings: (patch: UpdateWorkspaceSettingsRequest) => Promise<WorkspaceSettings | undefined>;
  readonly buildRerunRequest: RunCommands["buildRerunRequest"];
  readonly buildTaskRunRequest: RunCommands["buildTaskRunRequest"];
  readonly runWithRequest: RunsActions["runWithRequest"];
  readonly checkProviderForRun: (provider: ProviderPreset) => Promise<boolean>;
  readonly confirmChannelExecutionProposalWorkflow: WorkspaceCommands["confirmChannelExecutionProposalWorkflow"];
  readonly deleteTask: WorkspaceCommands["deleteTask"];
  readonly updateChannel: WorkspaceCommands["updateChannel"];
  readonly updateChannelExecutionProposal: WorkspaceCommands["updateChannelExecutionProposal"];
  readonly updateTask: WorkspaceCommands["updateTask"];
  readonly updateTaskStatus: WorkspaceCommands["updateTaskStatus"];
  readonly upsertChannelExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly refreshRuns: (cwd?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshChannelExecutionProposals: (channelId?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
}): TaskRunController {
  function resolveTaskRunProviderPresetId(channel: Channel | undefined): string {
    return input.taskRunProviderId || channel?.defaultProviderPresetId || input.form.providerPresetId || input.providers.find(providerPreflightReady)?.id || "";
  }

  function resolveChannelMessageProviderPresetId(channel: Channel | undefined, teammateId: string | undefined): string {
    const teammateProviderPresetId = findAiTeammateByReference(teammateId)?.providerPresetId;
    return teammateProviderPresetId || input.taskRunProviderId || channel?.defaultProviderPresetId || input.form.providerPresetId || input.providers.find(providerPreflightReady)?.id || "";
  }

  function findAiTeammateByReference(teammateId: string | undefined): AiTeammate | undefined {
    if (!teammateId) {
      return undefined;
    }
    return input.aiTeammates.find((teammate) => teammate.id === teammateId || teammate.templateId === teammateId);
  }

  async function removeTask(taskId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      await input.deleteTask(input.form.cwd.trim(), taskId);
      if (input.selectedTaskId === taskId) {
        input.setSelectedTaskId("");
      }
      await input.refreshTasks();
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveTaskToReview(taskId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      await input.updateTaskStatus(input.form.cwd.trim(), taskId, "review");
      await input.refreshTasks();
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTaskEdit(taskId: string): Promise<Task | undefined> {
    if (!input.taskEditForm.title.trim()) {
      input.setErrorMessage("请输入 task title");
      return undefined;
    }
    if (!input.taskEditForm.prompt.trim()) {
      input.setErrorMessage("请输入 task prompt");
      return undefined;
    }

    try {
      input.setErrorMessage("");
      const response = await input.updateTask(input.form.cwd.trim(), taskId, {
        ...input.taskEditForm,
        title: input.taskEditForm.title.trim(),
        prompt: input.taskEditForm.prompt.trim(),
      });
      await input.refreshTasks();
      return response.task;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function markChannelExecutionProposal(
    proposal: ChannelExecutionProposal,
    request: Parameters<WorkspaceCommands["updateChannelExecutionProposal"]>[2],
  ): Promise<ChannelExecutionProposal | undefined> {
    try {
      const response = await input.updateChannelExecutionProposal(input.form.cwd.trim(), proposal.id, request);
      input.upsertChannelExecutionProposal(response.proposal);
      return response.proposal;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function blockChannelExecutionProposal(proposal: ChannelExecutionProposal, message: string): Promise<void> {
    input.setErrorMessage(message);
    await markChannelExecutionProposal(proposal, { status: "blocked", errorMessage: message });
  }

  async function confirmChannelExecutionProposal(proposal: ChannelExecutionProposal): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.t("Local workspace is not ready."));
      return;
    }
    try {
      input.setErrorMessage("");
      const response = await input.confirmChannelExecutionProposalWorkflow(workspaceCwd, proposal.id);
      input.upsertChannelExecutionProposal(response.proposal);
      input.setChannelWorkflows((current) => [response.workflow, ...current.filter((workflow) => workflow.id !== response.workflow.id)]);
      input.setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, response.workflowSteps));
      await Promise.all([
        input.refreshRuns(workspaceCwd),
        input.refreshChannelProtocol(proposal.channelId),
        input.refreshChannelExecutionProposals(proposal.channelId),
        input.refreshUsedMemoryAudit(workspaceCwd),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.setErrorMessage(message);
      await blockChannelExecutionProposal(proposal, message);
    }
  }

  async function cancelChannelExecutionProposal(proposal: ChannelExecutionProposal): Promise<void> {
    await markChannelExecutionProposal(proposal, {
      status: "cancelled",
      ...(proposal.shaping ? { shaping: { ...proposal.shaping, status: "dismissed", updatedAt: new Date().toISOString() } } : {}),
    });
  }

  async function runPersistedTask(
    task: Task,
    options: RunPersistedTaskOptions = {},
  ): Promise<boolean> {
    const action = options.action ?? "run";
    input.setActiveTaskRunAction({ taskId: task.id, action });
    try {
      const channel = input.channels.find((item) => item.id === task.channelId);
      if (!channel) {
        input.setErrorMessage(input.t("Task channel not found."));
        return false;
      }
      if (channel.status !== "active") {
        input.setErrorMessage(input.t("Channel is {status}; resume it before starting a new run.", { status: input.t(channel.status) }));
        return false;
      }
      const providerPresetId = options.providerPresetIdOverride || resolveTaskRunProviderPresetId(channel);
      if (!providerPresetId) {
        input.setErrorMessage(input.t("No provider preset is selected for this task run."));
        return false;
      }
      const provider = input.providers.find((item) => item.id === providerPresetId);
      if (!provider || !canUseProviderForRun(provider)) {
        input.setErrorMessage(provider
          ? input.t("Provider preset is not runnable: {reason}", { reason: providerRunBlockerLabel(provider, input.t) })
          : input.t("Provider preset not found"));
        return false;
      }
      if (!options.skipPreflight) {
        const blocker = providerRunPreflightBlocker(provider, input.t);
        if (blocker) {
          input.setErrorMessage(blocker);
          return false;
        }
      }

      const runCwd = input.form.cwd.trim();
      await input.runWithRequest(input.buildTaskRunRequest(runCwd, task, channel, providerPresetId, {
        tools: options.toolsOverride,
        approvalProfile: options.approvalProfileOverride,
        authorizationMode: input.form.authorizationMode,
        workspaceAccessMode: input.form.workspaceAccessMode,
        permissionPreset: input.form.permissionPreset,
        permissionMode: input.form.permissionMode,
      }), runCwd, async (runId) => {
        await input.refreshTasks(task.channelId);
        await options.afterRunLoaded?.(runId);
      });
      return true;
    } finally {
      input.setActiveTaskRunAction((current) =>
        current?.taskId === task.id && current.action === action ? undefined : current,
      );
    }
  }

  async function checkThenRunPersistedTask(task: Task): Promise<boolean> {
    input.setActiveTaskRunAction({ taskId: task.id, action: "check" });
    const channel = input.channels.find((item) => item.id === task.channelId);
    const providerPresetId = resolveTaskRunProviderPresetId(channel);
    const provider = providerPresetId ? input.providers.find((item) => item.id === providerPresetId) : undefined;
    if (!provider) {
      input.setErrorMessage(providerPresetId ? input.t("Provider preset not found") : input.t("No provider preset is selected for this task run."));
      input.setActiveTaskRunAction(undefined);
      return false;
    }
    if (!(await input.checkProviderForRun(provider))) {
      input.setActiveTaskRunAction(undefined);
      return false;
    }
    return await runPersistedTask(task, { skipPreflight: true, action: "check" });
  }

  async function runUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await runPersistedTask(updatedTask)) {
      input.setTaskRepairRunId("");
    }
  }

  async function checkThenRunUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await checkThenRunPersistedTask(updatedTask)) {
      input.setTaskRepairRunId("");
    }
  }

  async function rerunRun(sourceRun: RunSession): Promise<void> {
    try {
      const workspaceCwd = readRunWorkspaceCwd(sourceRun, input.form.cwd.trim());
      await input.runWithRequest(input.buildRerunRequest(sourceRun), workspaceCwd);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function applyProviderToRun(provider: ProviderPreset, options: ProviderDefaultScopeOptions = {}): Promise<void> {
    const scope = options.scope ?? (input.selectedChannelId ? "channel" : "workspace");
    input.setTaskRunProviderId(scope === "channel" ? provider.id : "");
    input.setForm((current) => ({
      ...current,
      providerPresetId: provider.id,
      provider: provider.providerId,
      model: provider.model,
      baseUrl: providerEffectiveBaseUrl(provider, input.providerTemplates),
      api: provider.api,
    }));

    const workspaceCwd = input.form.cwd.trim();
    if (scope === "workspace") {
      if (workspaceCwd) {
        await input.patchWorkspaceSettings({ defaultProviderPresetId: provider.id });
      }
      return;
    }

    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    if (!workspaceCwd || !selectedChannel) {
      return;
    }

    const nextChannelForm = {
      ...channelToForm(selectedChannel, workspaceCwd),
      defaultProviderPresetId: provider.id,
    };
    input.setChannels((current) =>
      current.map((channel) =>
        channel.id === selectedChannel.id ? { ...channel, defaultProviderPresetId: provider.id } : channel
      )
    );
    input.setChannelEditForm((current) =>
      input.selectedChannelId === selectedChannel.id ? { ...current, defaultProviderPresetId: provider.id } : current
    );
    try {
      await input.updateChannel(workspaceCwd, selectedChannel.id, nextChannelForm);
      await input.refreshChannels(workspaceCwd);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      await input.refreshChannels(workspaceCwd);
    }
  }

  async function clearProviderFromRun(_provider?: ProviderPreset, options: ProviderDefaultScopeOptions = {}): Promise<void> {
    const scope = options.scope ?? (input.selectedChannelId ? "channel" : "workspace");
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    input.setForm((current) => ({
      ...current,
      providerPresetId: "",
    }));
    input.setTaskRunProviderId("");
    if (scope === "workspace") {
      if (input.form.cwd.trim()) {
        await input.patchWorkspaceSettings({ defaultProviderPresetId: null });
      }
      return;
    }
    if (!selectedChannel?.defaultProviderPresetId || !input.form.cwd.trim()) {
      return;
    }

    const clearedChannelForm = {
      ...channelToForm(selectedChannel, input.form.cwd),
      defaultProviderPresetId: "",
    };
    input.setChannels((current) =>
      current.map((channel) =>
        channel.id === selectedChannel.id ? { ...channel, defaultProviderPresetId: undefined } : channel
      )
    );
    input.setChannelEditForm((current) =>
      input.selectedChannelId === selectedChannel.id ? { ...current, defaultProviderPresetId: "" } : current
    );
    try {
      await input.updateChannel(input.form.cwd.trim(), selectedChannel.id, clearedChannelForm);
      await input.refreshChannels();
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      await input.refreshChannels();
    }
  }

  return {
    removeTask,
    moveTaskToReview,
    saveTaskEdit,
    resolveChannelMessageProviderPresetId,
    markChannelExecutionProposal,
    confirmChannelExecutionProposal,
    cancelChannelExecutionProposal,
    runPersistedTask,
    checkThenRunPersistedTask,
    runUpdatedTaskFromRepair,
    checkThenRunUpdatedTaskFromRepair,
    rerunRun,
    applyProviderToRun,
    clearProviderFromRun,
  };
}
