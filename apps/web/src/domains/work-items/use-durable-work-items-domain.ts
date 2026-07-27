import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { routeExternalWork } from "../../api/external-work.js";
import { claimWorkItem, completeWorkItem, failWorkItem, heartbeatWorkItem, listWorkItems, releaseWorkItem } from "../../api/work-items.js";
import type { WorkItemClaimBlocker, WorkItemView } from "../../types.js";
import type { WorkBoardActionFailure, WorkBoardMutation } from "../../features/work-board/work-board-types.js";

export interface DurableWorkItemsState {
  readonly durableWorkItems: readonly WorkItemView[];
  readonly durableWorkItemsLoading: boolean;
  readonly busyByWorkItemId: ReadonlyMap<string, WorkBoardMutation>;
  readonly failureByWorkItemId: ReadonlyMap<string, WorkBoardActionFailure>;
  readonly blockerByWorkItemId: ReadonlyMap<string, WorkItemClaimBlocker>;
  readonly routingByExternalWorkId: ReadonlySet<string>;
  readonly busyWorkItemId: string;
  readonly routingExternalWorkId: string;
}

export interface DurableWorkItemsActions {
  readonly refreshWorkItems: (cwd?: string) => Promise<boolean>;
  readonly claimDurableWorkItem: (workItemId: string) => Promise<boolean>;
  readonly heartbeatDurableWorkItem: (workItemId: string, claimToken: string) => Promise<boolean>;
  readonly releaseDurableWorkItem: (workItemId: string, claimToken: string) => Promise<boolean>;
  readonly completeDurableWorkItem: (workItemId: string, claimToken: string) => Promise<boolean>;
  readonly failDurableWorkItem: (workItemId: string, claimToken: string, reason?: string) => Promise<boolean>;
  readonly routeExternalWorkToChannel: (externalWorkId: string, channelId: string) => Promise<boolean>;
  readonly resetForCwd: () => void;
}

export function useDurableWorkItemsDomain(input: {
  readonly cwd: string;
  readonly refreshExternalActionDetailsByIds: (cwd: string, actionIds: readonly string[]) => Promise<void>;
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshExternalWorkStatus: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
}): { readonly state: DurableWorkItemsState; readonly actions: DurableWorkItemsActions } {
  const [durableWorkItems, setDurableWorkItems] = useState<readonly WorkItemView[]>([]);
  const [durableWorkItemsLoading, setDurableWorkItemsLoading] = useState(false);
  const [busyByWorkItemId, setBusyByWorkItemId] = useState<ReadonlyMap<string, WorkBoardMutation>>(new Map());
  const [failureByWorkItemId, setFailureByWorkItemId] = useState<ReadonlyMap<string, WorkBoardActionFailure>>(new Map());
  const [blockerByWorkItemId, setBlockerByWorkItemId] = useState<ReadonlyMap<string, WorkItemClaimBlocker>>(new Map());
  const [routingByExternalWorkId, setRoutingByExternalWorkId] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Map<string, WorkBoardMutation>());
  const routeBusyRef = useRef(new Set<string>());
  const requestRef = useRef(new Map<string, number>());
  const cwdRef = useRef(input.cwd.trim());
  cwdRef.current = input.cwd.trim();

  async function refreshWorkItems(cwd = input.cwd): Promise<boolean> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setDurableWorkItems([]);
      return false;
    }
    setDurableWorkItemsLoading(true);
    try {
      const response = await listWorkItems(workspaceCwd, { limit: 500 });
      if (cwdRef.current !== workspaceCwd || response.cwd !== workspaceCwd) return false;
      setDurableWorkItems(response.workItems);
      return true;
    } catch (caught) {
      setItemFailure("__list__", "route", caught);
      return false;
    } finally {
      if (cwdRef.current === workspaceCwd) setDurableWorkItemsLoading(false);
    }
  }

  async function claimDurableWorkItem(workItemId: string): Promise<boolean> {
    return runMutation(workItemId, "claim", async (cwd) => {
      const response = await claimWorkItem(cwd, workItemId, { ownerId: "web-user", leaseMs: 5 * 60_000 });
      if (response.blocker) setMapValue(setBlockerByWorkItemId, workItemId, response.blocker);
      else setMapValue(setBlockerByWorkItemId, workItemId, undefined);
      return { item: response.workItem, ok: !response.blocker };
    });
  }

  async function heartbeatDurableWorkItem(workItemId: string, claimToken: string): Promise<boolean> {
    if (!claimToken) return false;
    return runMutation(workItemId, "heartbeat", async (cwd) => ({ item: (await heartbeatWorkItem(cwd, workItemId, { claimToken, leaseMs: 5 * 60_000 })).workItem, ok: true }));
  }

  async function releaseDurableWorkItem(workItemId: string, claimToken: string): Promise<boolean> {
    if (!claimToken) return false;
    return runMutation(workItemId, "release", async (cwd) => ({ item: (await releaseWorkItem(cwd, workItemId, { claimToken })).workItem, ok: true }));
  }

  async function completeDurableWorkItem(workItemId: string, claimToken: string): Promise<boolean> {
    if (!claimToken) return false;
    return runMutation(workItemId, "complete", async (cwd) => ({ item: (await completeWorkItem(cwd, workItemId, { claimToken })).workItem, ok: true }));
  }

  async function failDurableWorkItem(workItemId: string, claimToken: string, reason = "Marked failed from work board"): Promise<boolean> {
    if (!claimToken || !reason.trim()) return false;
    return runMutation(workItemId, "fail", async (cwd) => ({ item: (await failWorkItem(cwd, workItemId, { claimToken, reason: reason.trim(), retry: false })).workItem, ok: true }));
  }

  async function runMutation(workItemId: string, action: WorkBoardMutation, request: (cwd: string) => Promise<{ readonly item: WorkItemView; readonly ok: boolean }>): Promise<boolean> {
    const workspaceCwd = cwdRef.current;
    if (!workspaceCwd || !workItemId || busyRef.current.has(workItemId)) return false;
    const requestId = (requestRef.current.get(workItemId) ?? 0) + 1;
    requestRef.current.set(workItemId, requestId);
    busyRef.current.set(workItemId, action);
    setBusyByWorkItemId(new Map(busyRef.current));
    try {
      const outcome = await request(workspaceCwd);
      if (!requestIsCurrent(workItemId, requestId, workspaceCwd)) return false;
      if (outcome.item.id !== workItemId) throw new Error("Work item mutation returned a different item.");
      setDurableWorkItems((current) => [outcome.item, ...current.filter((item) => item.id !== workItemId)]);
      if (outcome.ok) setMapValue(setFailureByWorkItemId, workItemId, undefined);
      return outcome.ok;
    } catch (caught) {
      if (requestIsCurrent(workItemId, requestId, workspaceCwd)) setItemFailure(workItemId, action, caught);
      return false;
    } finally {
      if (requestRef.current.get(workItemId) === requestId) {
        busyRef.current.delete(workItemId);
        setBusyByWorkItemId(new Map(busyRef.current));
      }
    }
  }

  async function routeExternalWorkToChannel(externalWorkId: string, channelId: string): Promise<boolean> {
    const workspaceCwd = cwdRef.current;
    if (!workspaceCwd || !externalWorkId || !channelId || routeBusyRef.current.has(externalWorkId)) return false;
    routeBusyRef.current.add(externalWorkId);
    setRoutingByExternalWorkId(new Set(routeBusyRef.current));
    try {
      const response = await routeExternalWork(workspaceCwd, externalWorkId, { channelId });
      if (cwdRef.current !== workspaceCwd) return false;
      await Promise.all([
        input.refreshExternalActionDetailsByIds(workspaceCwd, response.actions.map((item) => item.action.id)),
        input.refreshExternalWorkCiTriage(workspaceCwd, channelId), input.refreshExternalWorkStatus(workspaceCwd, channelId),
        input.refreshChannelProtocol(channelId), input.refreshApprovals(workspaceCwd), refreshWorkItems(workspaceCwd),
      ]);
      setMapValue(setFailureByWorkItemId, externalWorkId, undefined);
      return true;
    } catch (caught) {
      setItemFailure(externalWorkId, "route", caught);
      return false;
    } finally {
      routeBusyRef.current.delete(externalWorkId);
      setRoutingByExternalWorkId(new Set(routeBusyRef.current));
    }
  }

  function setItemFailure(itemId: string, action: WorkBoardMutation, caught: unknown): void {
    const technicalMessage = caught instanceof Error ? caught.message : String(caught);
    setMapValue<WorkBoardActionFailure>(setFailureByWorkItemId, itemId, { action, itemId, message: "The action could not be completed", technicalMessage });
  }

  function requestIsCurrent(itemId: string, requestId: number, cwd: string): boolean {
    return cwdRef.current === cwd && requestRef.current.get(itemId) === requestId;
  }

  function resetForCwd(): void {
    requestRef.current.clear();
    busyRef.current.clear();
    routeBusyRef.current.clear();
    setDurableWorkItems([]); setDurableWorkItemsLoading(false); setBusyByWorkItemId(new Map());
    setFailureByWorkItemId(new Map()); setBlockerByWorkItemId(new Map()); setRoutingByExternalWorkId(new Set());
  }

  return {
    state: {
      durableWorkItems, durableWorkItemsLoading, busyByWorkItemId, failureByWorkItemId, blockerByWorkItemId, routingByExternalWorkId,
      busyWorkItemId: busyByWorkItemId.keys().next().value ?? "",
      routingExternalWorkId: routingByExternalWorkId.values().next().value ?? "",
    },
    actions: { refreshWorkItems, claimDurableWorkItem, heartbeatDurableWorkItem, releaseDurableWorkItem, completeDurableWorkItem, failDurableWorkItem, routeExternalWorkToChannel, resetForCwd },
  };
}

function setMapValue<T>(setter: Dispatch<SetStateAction<ReadonlyMap<string, T>>>, key: string, value: T | undefined): void {
  setter((current) => {
    const next = new Map(current);
    if (value === undefined) next.delete(key); else next.set(key, value);
    return next;
  });
}
