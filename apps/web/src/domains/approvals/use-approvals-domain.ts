import { useEffect, useRef, useState } from "react";
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
import type {
  ApprovalResolution,
  ExternalActionBusyState,
  ExternalActionOperation,
} from "./approval-domain-types.js";

export interface ApprovalsState {
  readonly approvals: readonly ApprovalRequest[];
  readonly selectedApprovalId: string;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly approvalErrors: Readonly<Record<string, string>>;
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
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => Promise<void>;
  readonly executeExternalAction: (actionId: string) => Promise<void>;
  readonly cancelExternalAction: (actionId: string, reason?: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type ApprovalsController = DomainController<ApprovalsState, ApprovalsActions>;

export function useApprovalsDomain(input: {
  readonly cwd: string;
  readonly emitEvent: (event: DomainEvent) => Promise<void>;
}): ApprovalsController {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resolvingApprovals, setResolvingApprovals] = useState<Record<string, ApprovalResolution>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [externalActionDetails, setExternalActionDetails] = useState<Readonly<Record<string, ExternalWorkActionView>>>({});
  const [externalActionBusy, setExternalActionBusy] = useState<Record<string, ExternalActionBusyState>>({});
  const [error, setError] = useState<DomainError | undefined>();
  const resolvingApprovalsRef = useRef<Set<string>>(new Set());
  const cwdRef = useRef(input.cwd.trim());
  const previousCwdRef = useRef(input.cwd.trim());
  const listRequestSequenceRef = useRef(0);
  const externalDetailRequestRef = useRef(new Map<string, number>());
  const externalMutationRequestRef = useRef(new Map<string, number>());
  const externalActionBusyRef = useRef(new Map<string, ExternalActionOperation>());

  cwdRef.current = input.cwd.trim();

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (previousCwdRef.current === cwd) return;
    previousCwdRef.current = cwd;
    resolvingApprovalsRef.current.clear();
    externalActionBusyRef.current.clear();
    externalDetailRequestRef.current.clear();
    externalMutationRequestRef.current.clear();
    setApprovals([]);
    setSelectedApprovalId("");
    setResolvingApprovals({});
    setApprovalErrors({});
    setExternalActionDetails({});
    setExternalActionBusy({});
    setIsLoading(false);
    setError(undefined);
  }, [input.cwd]);

  async function refreshApprovals(cwd = input.cwd, runId?: string): Promise<void> {
    const workspaceCwd = cwd.trim();
    const requestId = ++listRequestSequenceRef.current;
    if (!workspaceCwd) {
      setApprovals([]);
      return;
    }

    setIsLoading(true);
    try {
      setError(undefined);
      const response = await listApprovals(workspaceCwd, { runId });
      if (!isCurrentListRequest(workspaceCwd, requestId) || response.cwd !== workspaceCwd) return;
      setApprovals((current) => (runId ? mergeApprovalsForRun(current, response.approvals, runId) : response.approvals));
      await refreshExternalActionDetails(workspaceCwd, response.approvals);
    } catch (caught) {
      if (!isCurrentListRequest(workspaceCwd, requestId)) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
    } finally {
      if (isCurrentListRequest(workspaceCwd, requestId)) setIsLoading(false);
    }
  }

  async function refreshExternalActionDetails(cwd: string, sourceApprovals: readonly ApprovalRequest[]): Promise<void> {
    const actionIds = [...new Set(sourceApprovals.map((approval) => approval.externalWorkActionId).filter(Boolean))] as string[];
    await refreshExternalActionDetailsByIds(cwd, actionIds);
  }

  async function refreshExternalActionDetailsByIds(cwd: string, actionIds: readonly string[]): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || actionIds.length === 0) return;

    await Promise.all(
      [...new Set(actionIds)].map(async (actionId) => {
        const requestId = (externalDetailRequestRef.current.get(actionId) ?? 0) + 1;
        externalDetailRequestRef.current.set(actionId, requestId);
        try {
          const response = await getExternalWorkAction(workspaceCwd, actionId);
          if (!isCurrentExternalRequest(actionId, requestId, workspaceCwd, externalDetailRequestRef.current)) return;
          setExternalActionDetails((current) => ({ ...current, [actionId]: response.action }));
          clearExternalActionFailure(actionId, "detail");
        } catch (caught) {
          if (!isCurrentExternalRequest(actionId, requestId, workspaceCwd, externalDetailRequestRef.current)) return;
          setExternalActionFailure(actionId, "detail", caught);
        }
      }),
    );
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
    const cwd = cwdRef.current;
    if (!cwd || externalActionBusyRef.current.has(actionId)) return;

    const requestId = beginExternalAction(actionId, "execute");
    try {
      const response = await executeExternalWorkAction(cwd, actionId);
      if (!isCurrentExternalRequest(actionId, requestId, cwd, externalMutationRequestRef.current)) return;
      applyExternalActionMutation(response);
      clearExternalActionFailure(actionId, "execute");
      await refreshApprovals(cwd);
    } catch (caught) {
      if (!isCurrentExternalRequest(actionId, requestId, cwd, externalMutationRequestRef.current)) return;
      setExternalActionFailure(actionId, "execute", caught);
    } finally {
      finishExternalAction(actionId, requestId, cwd);
    }
  }

  async function cancelExternalAction(actionId: string, reason?: string): Promise<void> {
    const cwd = cwdRef.current;
    if (!cwd || externalActionBusyRef.current.has(actionId)) return;

    const requestId = beginExternalAction(actionId, "cancel");
    try {
      const response = await cancelExternalWorkAction(cwd, actionId, { reason });
      if (!isCurrentExternalRequest(actionId, requestId, cwd, externalMutationRequestRef.current)) return;
      applyExternalActionMutation(response);
      clearExternalActionFailure(actionId, "cancel");
      await refreshApprovals(cwd);
    } catch (caught) {
      if (!isCurrentExternalRequest(actionId, requestId, cwd, externalMutationRequestRef.current)) return;
      setExternalActionFailure(actionId, "cancel", caught);
    } finally {
      finishExternalAction(actionId, requestId, cwd);
    }
  }

  async function resolveApproval(
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ): Promise<void> {
    if (resolvingApprovalsRef.current.has(approvalId)) {
      return;
    }

    const cwd = cwdRef.current;
    const requestId = (externalMutationRequestRef.current.get(`approval:${approvalId}`) ?? 0) + 1;
    externalMutationRequestRef.current.set(`approval:${approvalId}`, requestId);
    resolvingApprovalsRef.current.add(approvalId);
    setResolvingApprovals((current) => ({ ...current, [approvalId]: decision }));
    setApprovalErrors((current) => removeRecordKey(current, approvalId));
    try {
      const approvalBeforeResolution = approvals.find((approval) => approval.id === approvalId);
      const response =
        decision !== "deny"
          ? await approveApproval(cwd, approvalId, {
              reason,
              decisionKind: decision === "approve_command_rule" ? "approve_command_rule" : "approve_once",
              proposedRuleFingerprint,
            })
          : await denyApproval(cwd, approvalId, reason);
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      setSelectedApprovalId(response.approval.id);
      setApprovals((current) => upsertApproval(current, response.approval));
      setApprovalErrors((current) => removeRecordKey(current, approvalId));
      if (response.approval.externalWorkActionId) {
        await refreshExternalActionDetailsByIds(cwd, [response.approval.externalWorkActionId]);
      }

      await input.emitEvent({
        type: "approval.resolved",
        approvalId,
        runId: response.approval.runId || approvalBeforeResolution?.runId,
        mediaJobId: response.approval.mediaJobId || approvalBeforeResolution?.mediaJobId,
        externalWorkActionId: response.approval.externalWorkActionId || approvalBeforeResolution?.externalWorkActionId,
        reconciliationPending: response.postCommit?.status === "deferred",
      });
    } catch (caught) {
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      await refreshApprovals(cwd);
      if (isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) {
        setApprovalErrors((current) => ({ ...current, [approvalId]: message }));
      }
    } finally {
      resolvingApprovalsRef.current.delete(approvalId);
      if (cwdRef.current === cwd && externalMutationRequestRef.current.get(`approval:${approvalId}`) === requestId) {
        setResolvingApprovals((current) => removeRecordKey(current, approvalId));
      }
    }
  }

  function upsertApprovalAction(approval: ApprovalRequest): void {
    setApprovals((current) => upsertApproval(current, approval));
    setSelectedApprovalId(approval.id);
  }

  function resetForCwd(): void {
    listRequestSequenceRef.current += 1;
    resolvingApprovalsRef.current.clear();
    externalActionBusyRef.current.clear();
    externalDetailRequestRef.current.clear();
    externalMutationRequestRef.current.clear();
    setApprovals([]);
    setSelectedApprovalId("");
    setResolvingApprovals({});
    setApprovalErrors({});
    setExternalActionDetails({});
    setExternalActionBusy({});
    setIsLoading(false);
    setError(undefined);
  }

  function isCurrentListRequest(cwd: string, requestId: number): boolean {
    return cwdRef.current === cwd && listRequestSequenceRef.current === requestId;
  }

  function isCurrentExternalRequest(
    id: string,
    requestId: number,
    cwd: string,
    requests: ReadonlyMap<string, number>,
  ): boolean {
    return cwdRef.current === cwd && requests.get(id) === requestId;
  }

  function beginExternalAction(actionId: string, operation: ExternalActionOperation): number {
    const requestId = (externalMutationRequestRef.current.get(actionId) ?? 0) + 1;
    externalMutationRequestRef.current.set(actionId, requestId);
    externalActionBusyRef.current.set(actionId, operation);
    setExternalActionBusy((current) => ({ ...current, [actionId]: { busy: operation } }));
    return requestId;
  }

  function finishExternalAction(actionId: string, requestId: number, cwd: string): void {
    if (externalMutationRequestRef.current.get(actionId) !== requestId) return;
    externalActionBusyRef.current.delete(actionId);
    if (cwdRef.current !== cwd) return;
    setExternalActionBusy((current) => {
      const operation = current[actionId];
      if (operation?.error) return { ...current, [actionId]: { error: operation.error, failedOperation: operation.failedOperation } };
      return removeRecordKey(current, actionId);
    });
  }

  function setExternalActionFailure(
    actionId: string,
    failedOperation: ExternalActionBusyState["failedOperation"],
    caught: unknown,
  ): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    setExternalActionBusy((current) => ({
      ...current,
      [actionId]: { ...current[actionId], error: message, failedOperation },
    }));
  }

  function clearExternalActionFailure(
    actionId: string,
    failedOperation: ExternalActionBusyState["failedOperation"],
  ): void {
    setExternalActionBusy((current) => {
      const operation = current[actionId];
      if (!operation || operation.failedOperation !== failedOperation) return current;
      if (operation.busy) return { ...current, [actionId]: { busy: operation.busy } };
      return removeRecordKey(current, actionId);
    });
  }

  return {
    state: {
      approvals,
      selectedApprovalId,
      resolvingApprovals,
      approvalErrors,
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
