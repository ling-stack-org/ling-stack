import type { Dispatch, SetStateAction } from "react";
import type { DomainEvent } from "./domain-events.js";
import {
  channelSidebarTarget,
  teammateSidebarTarget,
  type SidebarTarget,
  type ViewId,
} from "./view-types.js";
import type { RunSession, Task } from "../types.js";
import { readRunProviderPresetId } from "../lib/run-evidence.js";

export interface AppNavigationController {
  readonly openPlainView: (view: ViewId) => void;
  readonly openRunDiagnosticsView: () => void;
  readonly selectWorkspaceChannel: (channelId: string) => void;
  readonly selectWorkspaceChannelBranch: (channelId: string, branchId: string) => void;
  readonly selectAiTeammate: (teammateId: string) => void;
  readonly openTaskFromWorkBoard: (taskId: string) => void;
  readonly openApprovalsFromWorkspace: (runId?: string) => void;
  readonly openProvidersFromRun: (runToRepair?: RunSession) => void;
  readonly openTaskFromRun: (runToRepair: RunSession) => Promise<void>;
}

export function useAppNavigationController(input: {
  readonly activeRunId: string;
  readonly formCwd: string;
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
  readonly setActiveView: Dispatch<SetStateAction<ViewId>>;
  readonly setActiveSidebarTarget: Dispatch<SetStateAction<SidebarTarget>>;
  readonly setApprovalRepairRunId: Dispatch<SetStateAction<string>>;
  readonly setChannelCreateOpen: Dispatch<SetStateAction<boolean>>;
  readonly setSelectedChannelBranchId: Dispatch<SetStateAction<string>>;
  readonly setSelectedChannelId: Dispatch<SetStateAction<string>>;
  readonly setSelectedTaskId: Dispatch<SetStateAction<string>>;
  readonly setTaskRepairRunId: Dispatch<SetStateAction<string>>;
  readonly setTaskRunProviderId: Dispatch<SetStateAction<string>>;
  readonly setThreadPageTargetId: Dispatch<SetStateAction<string>>;
  readonly setErrorMessage: (message: string) => void;
  readonly markChannelRead: (channelId: string) => void;
  readonly loadRun: (runId?: string, cwd?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly handleDomainEvent: (event: DomainEvent) => Promise<void>;
}): AppNavigationController {
  function openPlainView(view: ViewId): void {
    if (view === "approvals") {
      input.setApprovalRepairRunId("");
    }
    input.setThreadPageTargetId("");
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId("");
    input.setActiveView(view);
    input.setActiveSidebarTarget(view);
  }

  function openRunDiagnosticsView(): void {
    input.setThreadPageTargetId("");
    input.setChannelCreateOpen(false);
    input.setActiveView("runs");
    input.setActiveSidebarTarget("settings");
  }

  function selectWorkspaceChannel(channelId: string): void {
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId("");
    input.markChannelRead(channelId);
    input.setSelectedChannelId(channelId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  function selectWorkspaceChannelBranch(channelId: string, branchId: string): void {
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId(branchId);
    input.markChannelRead(channelId);
    input.setSelectedChannelId(channelId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  function selectAiTeammate(teammateId: string): void {
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId("");
    input.setActiveView("teammates");
    input.setActiveSidebarTarget(teammateSidebarTarget(teammateId));
  }

  function openTaskFromWorkBoard(taskId: string): void {
    const task = input.tasks.find((item) => item.id === taskId);
    if (task?.channelId) {
      input.setSelectedChannelId(task.channelId);
      input.setActiveSidebarTarget(channelSidebarTarget(task.channelId));
    }
    input.setSelectedTaskId(taskId);
    input.setActiveView("workspace");
  }

  function openApprovalsFromWorkspace(runId?: string): void {
    const targetRunId = runId || input.activeRunId || "";
    input.setApprovalRepairRunId(targetRunId);
    if (targetRunId) {
      void input.loadRun(targetRunId, input.formCwd);
    }
    void input.refreshApprovals(input.formCwd, targetRunId || undefined);
    input.setActiveView("approvals");
    input.setActiveSidebarTarget("approvals");
  }

  function openProvidersFromRun(runToRepair?: RunSession): void {
    void input.handleDomainEvent({
      type: "provider.repairRequested",
      providerPresetId: runToRepair ? readRunProviderPresetId(runToRepair) : undefined,
      sourceRunId: runToRepair?.id,
    });
  }

  async function openTaskFromRun(runToRepair: RunSession): Promise<void> {
    if (!runToRepair.channelId || !runToRepair.taskId) {
      input.setErrorMessage("This run is not linked to an editable channel task.");
      return;
    }

    input.setErrorMessage("");
    input.setTaskRepairRunId(runToRepair.id);
    input.setSelectedChannelId(runToRepair.channelId);
    input.setSelectedTaskId(runToRepair.taskId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(runToRepair.channelId));
    await input.refreshTasks(runToRepair.channelId);
    input.setSelectedTaskId(runToRepair.taskId);
  }

  return {
    openPlainView,
    openRunDiagnosticsView,
    selectWorkspaceChannel,
    selectWorkspaceChannelBranch,
    selectAiTeammate,
    openTaskFromWorkBoard,
    openApprovalsFromWorkspace,
    openProvidersFromRun,
    openTaskFromRun,
  };
}
