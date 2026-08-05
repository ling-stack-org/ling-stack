import { startTransition, type Dispatch, type SetStateAction } from "react";
import type { DomainEvent } from "./domain-events.js";
import {
  channelSidebarTarget,
  teammateSidebarTarget,
  type SidebarTarget,
  type ViewId,
} from "./view-types.js";
import type { RunSession, Task, WorkItemView } from "../types.js";
import { readRunProviderPresetId } from "../lib/run-evidence.js";
import {
  domainErrorMessage,
  type FocusedDomainError,
  useFocusedDomainErrorOwner,
} from "./use-focused-domain-error-owner.js";

export type NavigationRepairError = FocusedDomainError<"navigation-repair", "open-task">;

export interface AppNavigationController {
  readonly errors: readonly NavigationRepairError[];
  readonly error: NavigationRepairError | undefined;
  readonly clearError: () => void;
  readonly openPlainView: (view: ViewId) => void;
  readonly openRunDiagnosticsView: () => void;
  readonly selectWorkspaceChannel: (channelId: string) => void;
  readonly selectWorkspaceChannelBranch: (channelId: string, branchId: string) => void;
  readonly selectAiTeammate: (teammateId: string) => void;
  readonly openTaskFromWorkBoard: (taskId: string) => Promise<void>;
  readonly openApprovalsFromWorkspace: (runId?: string) => void;
  readonly openProvidersFromRun: (runToRepair?: RunSession) => void;
  readonly openTaskFromRun: (runToRepair: RunSession) => Promise<void>;
}

export function useAppNavigationController(input: {
  readonly activeRunId: string;
  readonly formCwd: string;
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
  readonly durableWorkItems: readonly WorkItemView[];
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
  readonly markChannelRead: (channelId: string) => void;
  readonly loadRun: (runId?: string, cwd?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly handleDomainEvent: (event: DomainEvent) => Promise<void>;
}): AppNavigationController {
  const errorOwner = useFocusedDomainErrorOwner<"navigation-repair", "open-task">(
    input.formCwd || "workspace:unavailable",
  );

  function invalidatePendingRepair(): void {
    errorOwner.invalidateRequests();
  }

  function openPlainView(view: ViewId): void {
    invalidatePendingRepair();
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
    invalidatePendingRepair();
    input.setThreadPageTargetId("");
    input.setChannelCreateOpen(false);
    input.setActiveView("runs");
    input.setActiveSidebarTarget("settings");
  }

  function selectWorkspaceChannel(channelId: string): void {
    invalidatePendingRepair();
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId("");
    input.markChannelRead(channelId);
    input.setSelectedChannelId(channelId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  function selectWorkspaceChannelBranch(channelId: string, branchId: string): void {
    invalidatePendingRepair();
    input.setChannelCreateOpen(false);
    input.setSelectedChannelBranchId(branchId);
    input.markChannelRead(channelId);
    input.setSelectedChannelId(channelId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  function selectAiTeammate(teammateId: string): void {
    invalidatePendingRepair();
    startTransition(() => {
      input.setChannelCreateOpen(false);
      input.setSelectedChannelBranchId("");
      input.setActiveView("teammates");
      input.setActiveSidebarTarget(teammateSidebarTarget(teammateId));
    });
  }

  async function openTaskFromWorkBoard(taskId: string): Promise<void> {
    invalidatePendingRepair();
    const task = input.tasks.find((item) => item.id === taskId);
    const channelId = task?.channelId ?? input.durableWorkItems.find((item) => item.taskId === taskId)?.channelId;
    if (channelId) {
      input.setSelectedChannelId(channelId);
      input.setActiveSidebarTarget(channelSidebarTarget(channelId));
    }
    input.setSelectedTaskId(taskId);
    input.setActiveView("workspace");
    if (channelId && !task) {
      await input.refreshTasks(channelId);
      input.setSelectedTaskId(taskId);
    }
  }

  function openApprovalsFromWorkspace(runId?: string): void {
    invalidatePendingRepair();
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
    invalidatePendingRepair();
    void input.handleDomainEvent({
      type: "provider.repairRequested",
      providerPresetId: runToRepair ? readRunProviderPresetId(runToRepair) : undefined,
      sourceRunId: runToRepair?.id,
    });
  }

  async function openTaskFromRun(runToRepair: RunSession): Promise<void> {
    invalidatePendingRepair();
    const request = errorOwner.begin("navigation-repair", runToRepair.id, "open-task");
    if (!runToRepair.channelId || !runToRepair.taskId) {
      errorOwner.report(request, {
        scope: "mutation",
        message: "This run is not linked to an editable channel task.",
      });
      return;
    }

    errorOwner.clear(request);
    input.setTaskRepairRunId(runToRepair.id);
    input.setSelectedChannelId(runToRepair.channelId);
    input.setSelectedTaskId(runToRepair.taskId);
    input.setTaskRunProviderId("");
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(runToRepair.channelId));
    try {
      await input.refreshTasks(runToRepair.channelId);
      if (errorOwner.isCurrent(request)) {
        input.setSelectedTaskId(runToRepair.taskId);
        errorOwner.clear(request);
      }
    } catch (caught) {
      errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
    }
  }

  return {
    errors: errorOwner.errors() as readonly NavigationRepairError[],
    error: errorOwner.latest() as NavigationRepairError | undefined,
    clearError: errorOwner.clearAll,
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
