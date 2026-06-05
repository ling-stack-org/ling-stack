import { useRef, useState } from "react";
import {
  approveApproval,
  cancelExternalWorkAction,
  denyApproval,
  executeExternalWorkAction,
  getExternalWorkAction,
  listApprovals,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { DomainEvent } from "../../app/domain-events.js";
import { mergeApprovalsForRun, upsertApproval } from "../../lib/approvals.js";
import { removeRecordKey } from "../../lib/records.js";
import type {
  ApprovalRequest,
  ExternalWorkActionMutationResponse,
  ExternalWorkActionView,
} from "../../types.js";
import type { ApprovalResolution } from "../../features/approvals/types.js";
import type { ExternalActionBusyState } from "../../features/approvals/ApprovalCard.js";

export interface ApprovalsState {
  readonly approvals: readonly ApprovalRequest[];
  readonly selectedApprovalId: string;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly isLoading: boolean;
}

export interface ApprovalsActions {
  readonly setSelectedApprovalId: (approvalId: string) => void;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
  readonly refreshExternalActionDetails: (cwd: string, sourceApprovals: readonly ApprovalRequest[]) => Promise<void>;
  readonly refreshExternalActionDetailsByIds: (cwd: string, actionIds: readonly string[]) => Promise<void>;
  readonly upsertApproval: (approval: ApprovalRequest) => void;
  readonly resolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => Promise<void>;
  readonly executeExternalAction: (actionId: string) => Promise<void>;
  readonly cancelExternalAction: (actionId: string, reason?: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type ApprovalsController = DomainController<ApprovalsState, ApprovalsActions>;

export function useApprovalsDomain(input: {
  readonly cwd: string;
  readonly emitEvent: (event: DomainEvent) => Promise<void>;
  readonly setErrorMessage: (message: string) => void;
}): ApprovalsController {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resolvingApprovals, setResolvingApprovals] = useState<Record<string, ApprovalResolution>>({});
  const [externalActionDetails, setExternalActionDetails] = useState<Readonly<Record<string, ExternalWorkActionView>>>({});
  const [externalActionBusy, setExternalActionBusy] = useState<Record<string, ExternalActionBusyState>>({});
  const [error, setError] = useState<DomainError | undefined>();
  const resolvingApprovalsRef = useRef<Set<string>>(new Set());

  async function refreshApprovals(cwd = input.cwd, runId?: string): Promise<void> {
    if (!cwd.trim()) {
      setApprovals([]);
      return;
    }

    setIsLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await listApprovals(cwd.trim(), { runId });
      setApprovals((current) => (runId ? mergeApprovalsForRun(current, response.approvals, runId) : response.approvals));
      await refreshExternalActionDetails(cwd.trim(), response.approvals);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshExternalActionDetails(cwd: string, sourceApprovals: readonly ApprovalRequest[]): Promise<void> {
    const actionIds = [...new Set(sourceApprovals.map((approval) => approval.externalWorkActionId).filter(Boolean))] as string[];
    await refreshExternalActionDetailsByIds(cwd, actionIds);
  }

  async function refreshExternalActionDetailsByIds(cwd: string, actionIds: readonly string[]): Promise<void> {
    if (actionIds.length === 0) {
      return;
    }

    const loaded = await Promise.all(
      actionIds.map(async (actionId) => {
        try {
          const response = await getExternalWorkAction(cwd, actionId);
          return response.action;
        } catch {
          return undefined;
        }
      }),
    );
    const nextEntries = loaded.filter((item): item is ExternalWorkActionView => Boolean(item));
    if (nextEntries.length === 0) {
      return;
    }
    setExternalActionDetails((current) => ({
      ...current,
      ...Object.fromEntries(nextEntries.map((item) => [item.action.id, item])),
    }));
  }

  function applyExternalActionMutation(response: ExternalWorkActionMutationResponse): void {
    setExternalActionDetails((current) => {
      const existing = current[response.action.id];
      return {
        ...current,
        [response.action.id]: {
          action: response.action,
          externalWork: existing?.externalWork,
          approval: response.approval ?? existing?.approval,
          artifacts: response.artifacts,
        },
      };
    });
    const approval = response.approval;
    if (approval) {
      upsertApprovalAction(approval);
    }
  }

  async function executeExternalAction(actionId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || externalActionBusy[actionId]) {
      return;
    }

    setExternalActionBusy((current) => ({ ...current, [actionId]: "execute" }));
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await executeExternalWorkAction(cwd, actionId);
      applyExternalActionMutation(response);
      await refreshApprovals(cwd);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setExternalActionBusy((current) => removeRecordKey(current, actionId));
    }
  }

  async function cancelExternalAction(actionId: string, reason?: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || externalActionBusy[actionId]) {
      return;
    }

    setExternalActionBusy((current) => ({ ...current, [actionId]: "cancel" }));
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await cancelExternalWorkAction(cwd, actionId, { reason });
      applyExternalActionMutation(response);
      await refreshApprovals(cwd);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setExternalActionBusy((current) => removeRecordKey(current, actionId));
    }
  }

  async function resolveApproval(approvalId: string, decision: ApprovalResolution, reason?: string): Promise<void> {
    if (resolvingApprovalsRef.current.has(approvalId)) {
      return;
    }

    resolvingApprovalsRef.current.add(approvalId);
    setResolvingApprovals((current) => ({ ...current, [approvalId]: decision }));
    try {
      input.setErrorMessage("");
      setError(undefined);
      const approvalBeforeResolution = approvals.find((approval) => approval.id === approvalId);
      const response =
        decision === "approve"
          ? await approveApproval(input.cwd.trim(), approvalId, reason)
          : await denyApproval(input.cwd.trim(), approvalId, reason);
      setSelectedApprovalId(response.approval.id);
      setApprovals((current) => upsertApproval(current, response.approval));

      await input.emitEvent({
        type: "approval.resolved",
        approvalId,
        runId: response.approval.runId || approvalBeforeResolution?.runId,
        mediaJobId: response.approval.mediaJobId || approvalBeforeResolution?.mediaJobId,
        externalWorkActionId: response.approval.externalWorkActionId || approvalBeforeResolution?.externalWorkActionId,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      resolvingApprovalsRef.current.delete(approvalId);
      setResolvingApprovals((current) => removeRecordKey(current, approvalId));
    }
  }

  function upsertApprovalAction(approval: ApprovalRequest): void {
    setApprovals((current) => upsertApproval(current, approval));
    setSelectedApprovalId(approval.id);
  }

  function resetForCwd(): void {
    resolvingApprovalsRef.current.clear();
    setApprovals([]);
    setSelectedApprovalId("");
    setResolvingApprovals({});
    setExternalActionDetails({});
    setExternalActionBusy({});
    setIsLoading(false);
    setError(undefined);
  }

  return {
    state: {
      approvals,
      selectedApprovalId,
      resolvingApprovals,
      externalActionDetails,
      externalActionBusy,
      isLoading,
    },
    actions: {
      setSelectedApprovalId,
      refreshApprovals,
      refreshExternalActionDetails,
      refreshExternalActionDetailsByIds,
      upsertApproval: upsertApprovalAction,
      resolveApproval,
      executeExternalAction,
      cancelExternalAction,
      resetForCwd,
    },
    refresh: refreshApprovals,
    isLoading,
    error,
    clearError: () => setError(undefined),
  };
}
