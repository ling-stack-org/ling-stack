import { useEffect, useReducer, useRef, useState } from "react";
import {
  approveApproval,
  cancelExternalWorkAction,
  denyApproval,
  executeExternalWorkAction,
  getApproval,
  getExternalWorkAction,
  listApprovals,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { DomainEvent } from "../../app/domain-events.js";
import { useI18n } from "../../i18n.js";
import { mergeApprovalSnapshot, mergeApprovalsForRun, upsertApproval } from "../../lib/approvals.js";
import { removeRecordKey } from "../../lib/records.js";
import { daemonBaseUrl } from "../../api/client.js";
import { approvalDecisionLookupJournal } from "../../lib/approval-decision-lookup-journal.js";
import type {
  ApprovalMutationResponse,
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

interface ApprovalObservation {
  readonly visible: readonly ApprovalRequest[];
  readonly resolved: ReadonlyMap<string, ApprovalRequest>;
}

type ApprovalObservationUpdate =
  | { readonly type: "reset" }
  | { readonly type: "snapshot"; readonly approvals: readonly ApprovalRequest[]; readonly runId?: string }
  | { readonly type: "upsert"; readonly approval: ApprovalRequest };

function emptyApprovalObservation(): ApprovalObservation {
  return { visible: [], resolved: new Map() };
}

function observeApprovals(current: ApprovalObservation, update: ApprovalObservationUpdate): ApprovalObservation {
  if (update.type === "reset") return emptyApprovalObservation();
  // List omission may hide a row, but cannot undo an observed durable decision.
  const incoming = mergeApprovalSnapshot([...current.visible, ...current.resolved.values()],
    update.type === "snapshot" ? update.approvals : [update.approval]);
  const visible = update.type === "upsert" ? upsertApproval(current.visible, incoming[0]!)
    : update.runId ? mergeApprovalsForRun(current.visible, incoming, update.runId) : incoming;
  const resolved = new Map(current.resolved);
  for (const approval of incoming) {
    if (approval.status !== "pending") resolved.set(approval.id, approval);
  }
  return { visible, resolved };
}

export function useApprovalsDomain(input: {
  readonly cwd: string;
  readonly emitEvent: (event: DomainEvent) => Promise<void>;
}): ApprovalsController {
  const { t } = useI18n();
  const [approvalObservation, updateApprovals] = useReducer(observeApprovals, undefined, emptyApprovalObservation);
  const approvals = approvalObservation.visible;
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resolvingApprovals, setResolvingApprovals] = useState<Record<string, ApprovalResolution>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [externalActionDetails, setExternalActionDetails] = useState<Readonly<Record<string, ExternalWorkActionView>>>({});
  const [externalActionBusy, setExternalActionBusy] = useState<Record<string, ExternalActionBusyState>>({});
  const [error, setError] = useState<DomainError | undefined>();
  const resolvingApprovalsRef = useRef<Set<string>>(new Set());
  const emitEventRef = useRef(input.emitEvent);
  const cwdRef = useRef(input.cwd.trim());
  const previousCwdRef = useRef(input.cwd.trim());
  const listRequestSequenceRef = useRef(0);
  const listRequestCwdRef = useRef("");
  const externalRequestSequenceRef = useRef(0);
  const externalDetailRequestRef = useRef(new Map<string, number>());
  const externalMutationRequestRef = useRef(new Map<string, number>());
  const externalActionBusyRef = useRef(new Map<string, ExternalActionOperation>());

  cwdRef.current = input.cwd.trim();
  emitEventRef.current = input.emitEvent;

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (previousCwdRef.current === cwd) return;
    previousCwdRef.current = cwd;
    // Startup may request the selected workspace before its render commits.
    if (listRequestCwdRef.current !== cwd) listRequestSequenceRef.current += 1;
    resolvingApprovalsRef.current.clear();
    externalActionBusyRef.current.clear();
    externalDetailRequestRef.current.clear();
    externalMutationRequestRef.current.clear();
    updateApprovals({ type: "reset" });
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
    listRequestCwdRef.current = workspaceCwd;
    if (!workspaceCwd) {
      updateApprovals({ type: "reset" });
      return;
    }

    setIsLoading(true);
    try {
      setError(undefined);
      const response = await listApprovals(workspaceCwd, { runId });
      if (!isCurrentListRequest(workspaceCwd, requestId) || response.cwd !== workspaceCwd) return;
      updateApprovals({ type: "snapshot", approvals: response.approvals, runId });
      await recoverDecisionLookups(workspaceCwd, requestId);
      if (!isCurrentListRequest(workspaceCwd, requestId)) return;
      await refreshExternalActionDetails(workspaceCwd, response.approvals);
    } catch (caught) {
      if (!isCurrentListRequest(workspaceCwd, requestId)) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
    } finally {
      if (isCurrentListRequest(workspaceCwd, requestId)) setIsLoading(false);
    }
  }

  async function recoverDecisionLookups(cwd: string, requestId: number): Promise<void> {
    const scope = { daemonBaseUrl, cwd };
    for (const lookup of approvalDecisionLookupJournal.read(scope)) {
      if (!isCurrentListRequest(cwd, requestId)) return;
      const mutationKey = `approval:${lookup.approvalId}`;
      const originalMutation = externalMutationRequestRef.current.get(mutationKey);
      if (resolvingApprovalsRef.current.has(lookup.approvalId)) continue;
      let receipt: Awaited<ReturnType<typeof getApproval>>;
      try {
        receipt = await getApproval(cwd, lookup.approvalId);
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        if (receipt?.approval?.id !== lookup.approvalId
          || !["pending", "approved", "denied", "expired", "cancelled"].includes(receipt.approval.status)) {
          throw new Error(t("Pending confirmation"));
        }
      } catch {
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        setApprovalErrors(current => ({ ...current, [lookup.approvalId]: t("Pending confirmation") }));
        continue;
      }
      try {
        updateApprovals({ type: "upsert", approval: receipt.approval });
        approvalDecisionLookupJournal.forget(scope, lookup);
        if (receipt.approval.status === "pending") continue;
        setApprovalErrors(current => removeRecordKey(current, lookup.approvalId));
        await emitEventRef.current({ type: "approval.resolved", approvalId: lookup.approvalId,
          runId: receipt.approval.runId, mediaJobId: receipt.approval.mediaJobId,
          externalWorkActionId: receipt.approval.externalWorkActionId,
          reconciliationPending: !Array.isArray(receipt.postCommitEffects)
            || receipt.postCommitEffects.some(effect => !effect || effect.approvalId !== lookup.approvalId
              || effect.status !== "completed"),
        });
      } catch (caught) {
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        setError({ scope: "load", message: caught instanceof Error ? caught.message : String(caught) });
      }
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
        const requestId = ++externalRequestSequenceRef.current;
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
    const requestId = ++externalRequestSequenceRef.current;
    const lookupScope = { daemonBaseUrl, cwd };
    const lookup = { approvalId, token: crypto.randomUUID() };
    externalMutationRequestRef.current.set(`approval:${approvalId}`, requestId);
    resolvingApprovalsRef.current.add(approvalId);
    setResolvingApprovals((current) => ({ ...current, [approvalId]: decision }));
    setApprovalErrors((current) => removeRecordKey(current, approvalId));
    const approvalBeforeResolution = approvals.find((approval) => approval.id === approvalId);
    async function applyResolution(response: ApprovalMutationResponse): Promise<void> {
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      setSelectedApprovalId(response.approval.id);
      updateApprovals({ type: "upsert", approval: response.approval });
      approvalDecisionLookupJournal.forget(lookupScope, lookup);
      setApprovalErrors((current) => removeRecordKey(current, approvalId));
      if (response.approval.externalWorkActionId) {
        await refreshExternalActionDetailsByIds(cwd, [response.approval.externalWorkActionId]);
      }
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      await emitEventRef.current({
        type: "approval.resolved",
        approvalId,
        runId: response.approval.runId || approvalBeforeResolution?.runId,
        mediaJobId: response.approval.mediaJobId || approvalBeforeResolution?.mediaJobId,
        externalWorkActionId: response.approval.externalWorkActionId || approvalBeforeResolution?.externalWorkActionId,
        reconciliationPending: response.postCommit?.status === "deferred",
      });
    }
    try {
      approvalDecisionLookupJournal.remember(lookupScope, lookup);
      let response: ApprovalMutationResponse;
      try {
        response = decision !== "deny"
          ? await approveApproval(cwd, approvalId, {
              reason,
              decisionKind: decision === "approve_command_rule" ? "approve_command_rule" : "approve_once",
              proposedRuleFingerprint,
            })
          : await denyApproval(cwd, approvalId, reason);
        if (response?.approval?.id !== approvalId
          || !["approved", "denied", "expired", "cancelled"].includes(response.approval.status)) {
          throw new Error(t("Pending confirmation"));
        }
      } catch (caught) {
        if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
        // A missing or unusable response is not a rejection. Read the original receipt, never replay it.
        const receipt = await getApproval(cwd, approvalId).catch(() => undefined);
        if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
        if (receipt?.approval?.id === approvalId
          && ["approved", "denied", "expired", "cancelled"].includes(receipt.approval.status)) {
          response = {
            approval: receipt.approval,
            ...(!Array.isArray(receipt.postCommitEffects)
              || receipt.postCommitEffects.some(effect => !effect || effect.approvalId !== approvalId || effect.status !== "completed") ? {
              postCommit: { status: "deferred", code: "approval_postcommit_reconciliation_required" },
            } as const : {}),
          };
        } else {
          const message = caught instanceof Error ? caught.message : String(caught);
          await refreshApprovals(cwd);
          if (isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) {
            setApprovalErrors((current) => ({ ...current, [approvalId]: message }));
          }
          return;
        }
      }
      try {
        await applyResolution(response);
      } catch (caught) {
        if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setError({ scope: "load", message });
      }
    } catch (caught) {
      if (isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) {
        setApprovalErrors(current => ({ ...current, [approvalId]: caught instanceof Error ? caught.message : String(caught) }));
      }
    } finally {
      if (isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) {
        resolvingApprovalsRef.current.delete(approvalId);
        setResolvingApprovals((current) => removeRecordKey(current, approvalId));
      }
    }
  }

  function upsertApprovalAction(approval: ApprovalRequest): void {
    updateApprovals({ type: "upsert", approval });
    setSelectedApprovalId(approval.id);
  }

  function resetForCwd(): void {
    listRequestSequenceRef.current += 1;
    resolvingApprovalsRef.current.clear();
    externalActionBusyRef.current.clear();
    externalDetailRequestRef.current.clear();
    externalMutationRequestRef.current.clear();
    updateApprovals({ type: "reset" });
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
    const requestId = ++externalRequestSequenceRef.current;
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
