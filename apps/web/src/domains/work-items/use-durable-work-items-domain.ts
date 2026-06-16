import { useState } from "react";
import { routeExternalWork } from "../../api/external-work.js";
import { claimWorkItem, completeWorkItem, failWorkItem, heartbeatWorkItem, listWorkItems, releaseWorkItem } from "../../api/work-items.js";
import type { WorkItemView } from "../../types.js";

export interface DurableWorkItemsState {
  readonly durableWorkItems: readonly WorkItemView[];
  readonly durableWorkItemsLoading: boolean;
  readonly busyWorkItemId: string;
  readonly routingExternalWorkId: string;
}

export interface DurableWorkItemsActions {
  readonly refreshWorkItems: (cwd?: string) => Promise<void>;
  readonly claimDurableWorkItem: (workItemId: string) => Promise<void>;
  readonly heartbeatDurableWorkItem: (workItemId: string, claimToken: string) => Promise<void>;
  readonly releaseDurableWorkItem: (workItemId: string, claimToken: string) => Promise<void>;
  readonly completeDurableWorkItem: (workItemId: string, claimToken: string) => Promise<void>;
  readonly failDurableWorkItem: (workItemId: string, claimToken: string, reason?: string) => Promise<void>;
  readonly routeExternalWorkToChannel: (externalWorkId: string, channelId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export function useDurableWorkItemsDomain(input: {
  readonly cwd: string;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshExternalActionDetailsByIds: (cwd: string, actionIds: readonly string[]) => Promise<void>;
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshExternalWorkStatus: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
}): { readonly state: DurableWorkItemsState; readonly actions: DurableWorkItemsActions } {
  const [durableWorkItems, setDurableWorkItems] = useState<readonly WorkItemView[]>([]);
  const [durableWorkItemsLoading, setDurableWorkItemsLoading] = useState(false);
  const [busyWorkItemId, setBusyWorkItemId] = useState("");
  const [routingExternalWorkId, setRoutingExternalWorkId] = useState("");

  async function refreshWorkItems(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setDurableWorkItems([]);
      return;
    }
    setDurableWorkItemsLoading(true);
    try {
      const response = await listWorkItems(cwd);
      setDurableWorkItems(response.workItems);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDurableWorkItemsLoading(false);
    }
  }

  async function claimDurableWorkItem(workItemId: string): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !workItemId || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await claimWorkItem(workspaceCwd, workItemId, {
        ownerId: "web-user",
        leaseMs: 5 * 60_000,
      });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      if (response.blocker) {
        input.setErrorMessage(response.blocker.message);
      } else {
        input.setErrorMessage("");
      }
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function heartbeatDurableWorkItem(workItemId: string, claimToken: string): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !workItemId || !claimToken || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await heartbeatWorkItem(workspaceCwd, workItemId, {
        claimToken,
        leaseMs: 5 * 60_000,
      });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      input.setErrorMessage("");
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function releaseDurableWorkItem(workItemId: string, claimToken: string): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !workItemId || !claimToken || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await releaseWorkItem(workspaceCwd, workItemId, { claimToken });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      input.setErrorMessage("");
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function completeDurableWorkItem(workItemId: string, claimToken: string): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !workItemId || !claimToken || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await completeWorkItem(workspaceCwd, workItemId, { claimToken });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      input.setErrorMessage("");
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function failDurableWorkItem(workItemId: string, claimToken: string, reason = "Marked failed from work board"): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !workItemId || !claimToken || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await failWorkItem(workspaceCwd, workItemId, { claimToken, reason, retry: false });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      input.setErrorMessage("");
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function routeExternalWorkToChannel(externalWorkId: string, channelId: string): Promise<void> {
    const workspaceCwd = input.cwd;
    if (!workspaceCwd || !externalWorkId || !channelId || routingExternalWorkId) {
      return;
    }
    setRoutingExternalWorkId(externalWorkId);
    try {
      input.setErrorMessage("");
      const response = await routeExternalWork(workspaceCwd, externalWorkId, { channelId });
      const actionIds = response.actions.map((item) => item.action.id);
      await Promise.all([
        input.refreshExternalActionDetailsByIds(workspaceCwd, actionIds),
        input.refreshExternalWorkCiTriage(workspaceCwd, channelId),
        input.refreshExternalWorkStatus(workspaceCwd, channelId),
        input.refreshChannelProtocol(channelId),
        input.refreshApprovals(workspaceCwd),
        refreshWorkItems(workspaceCwd),
      ]);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRoutingExternalWorkId("");
    }
  }

  function resetForCwd(): void {
    setDurableWorkItems([]);
    setBusyWorkItemId("");
    setRoutingExternalWorkId("");
  }

  return {
    state: {
      durableWorkItems,
      durableWorkItemsLoading,
      busyWorkItemId,
      routingExternalWorkId,
    },
    actions: {
      refreshWorkItems,
      claimDurableWorkItem,
      heartbeatDurableWorkItem,
      releaseDurableWorkItem,
      completeDurableWorkItem,
      failDurableWorkItem,
      routeExternalWorkToChannel,
      resetForCwd,
    },
  };
}
