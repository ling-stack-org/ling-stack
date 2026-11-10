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
import { approvalReceiptRecoveryState, type ApprovalRecoveryState } from "../../lib/approval-recovery.js";
import type { ApprovalDecisionLookup } from "../../lib/approval-decision-lookup-journal.js";
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
  const recoveryTimerRef = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  const recoveryDelayRef = useRef(500);
  const recoveryReadsRef = useRef(new Set<string>());
  const recoveryStatesRef = useRef(new Map<string, { token: string; state: ApprovalRecoveryState }>());
  const mountedRef = useRef(true);

  cwdRef.current = input.cwd.trim();
  emitEventRef.current = input.emitEvent;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestSequenceRef.current += 1;
      externalMutationRequestRef.current.clear();
      clearRecoveryTracking();
    };
  }, []);

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (previousCwdRef.current === cwd) return;
    previousCwdRef.current = cwd;
    clearRecoveryTracking();
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
      const readKey = JSON.stringify([cwd, lookup.approvalId, lookup.token]);
      if (resolvingApprovalsRef.current.has(lookup.approvalId) || recoveryReadsRef.current.has(readKey)) continue;
      recoveryReadsRef.current.add(readKey);
      let receipt: Awaited<ReturnType<typeof getApproval>>;
      try {
        try {
          receipt = await getApproval(cwd, lookup.approvalId);
          if (receipt?.approval?.id !== lookup.approvalId
            || !["pending", "approved", "denied", "expired", "cancelled"].includes(receipt.approval.status)) {
            throw new Error(t("Pending confirmation"));
          }
        } catch {
          if (!isCurrentListRequest(cwd, requestId)
            || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
          await publishRecoveryState(cwd, lookup, "unknown");
          continue;
        }
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        updateApprovals({ type: "upsert", approval: receipt.approval });
        // Pending means the original decision has not been confirmed. Keep only
        // its query pointer; neither refresh nor the timer can authorize again.
        if (receipt.approval.status === "pending") continue;
        const recoveryState = approvalReceiptRecoveryState(receipt);
        await publishRecoveryState(cwd, lookup, recoveryState, receipt.approval);
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        if (recoveryState === "completed") approvalDecisionLookupJournal.forget(scope, lookup);
        setApprovalErrors(current => removeRecordKey(current, lookup.approvalId));
      } catch (caught) {
        if (!isCurrentListRequest(cwd, requestId)
          || externalMutationRequestRef.current.get(mutationKey) !== originalMutation) continue;
        setError({ scope: "load", message: caught instanceof Error ? caught.message : String(caught) });
      } finally {
        recoveryReadsRef.current.delete(readKey);
      }
    }
    scheduleRecoveryLookup(cwd);
  }

  async function publishRecoveryState(cwd: string, lookup: ApprovalDecisionLookup, state: ApprovalRecoveryState, approval?: ApprovalRequest): Promise<void> {
    if (!mountedRef.current || cwdRef.current !== cwd) return;
    const previous = recoveryStatesRef.current.get(lookup.approvalId);
    if (previous?.token === lookup.token && previous.state === state) return;
    await emitEventRef.current({ type: "approval.recoveryChanged", cwd, approvalId: lookup.approvalId, recoveryState: state,
      runId: approval?.runId, mediaJobId: approval?.mediaJobId, externalWorkActionId: approval?.externalWorkActionId,
      channelId: approval?.channelId });
    if (mountedRef.current && cwdRef.current === cwd) recoveryStatesRef.current.set(lookup.approvalId, { token: lookup.token, state });
  }

  function clearRecoveryTracking(): void {
    if (recoveryTimerRef.current !== undefined) window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = undefined;
    recoveryDelayRef.current = 500;
    recoveryReadsRef.current.clear();
    recoveryStatesRef.current.clear();
  }

  function scheduleRecoveryLookup(cwd: string): void {
    if (!mountedRef.current || cwdRef.current !== cwd) return;
    try {
      if (approvalDecisionLookupJournal.read({ daemonBaseUrl, cwd }).length === 0) {
        if (recoveryTimerRef.current !== undefined) window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = undefined;
        recoveryDelayRef.current = 500;
        return;
      }
    } catch (caught) {
      setError({ scope: "load", message: caught instanceof Error ? caught.message : String(caught) });
      return;
    }
    if (recoveryTimerRef.current !== undefined) return;
    // One GET-only, backoff-capped observer per mounted workspace. Keep durable
    // pointers on failure/reload; do not retry POSTs or infer Run completion.
    recoveryTimerRef.current = window.setTimeout(async () => {
      recoveryTimerRef.current = undefined;
      if (!mountedRef.current || cwdRef.current !== cwd) return;
      recoveryDelayRef.current = Math.min(30_000, recoveryDelayRef.current * 2);
      try {
        await recoverDecisionLookups(cwd, listRequestSequenceRef.current);
      } catch (caught) {
        if (mountedRef.current && cwdRef.current === cwd) {
          setError({ scope: "load", message: caught instanceof Error ? caught.message : String(caught) });
        }
      } finally {
        scheduleRecoveryLookup(cwd);
      }
    }, recoveryDelayRef.current);
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
    async function applyResolution(response: ApprovalMutationResponse, observedRecoveryState?: ApprovalRecoveryState): Promise<void> {
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      setSelectedApprovalId(response.approval.id);
      updateApprovals({ type: "upsert", approval: response.approval });
      const recoveryState = observedRecoveryState ?? (response.postCommit?.status === "deferred" ? "pending" : "completed");
      // The mutation emits approval.resolved below; only a later GET receipt
      // needs to invalidate the dependent views through recoveryChanged.
      await publishRecoveryState(cwd, lookup, recoveryState);
      if (!isCurrentExternalRequest(`approval:${approvalId}`, requestId, cwd, externalMutationRequestRef.current)) return;
      if (recoveryState === "completed") approvalDecisionLookupJournal.forget(lookupScope, lookup);
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
        channelId: response.approval.channelId || approvalBeforeResolution?.channelId,
      });
    }
    try {
      approvalDecisionLookupJournal.remember(lookupScope, lookup);
      let response: ApprovalMutationResponse;
      let observedRecoveryState: ApprovalRecoveryState | undefined;
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
          response = { approval: receipt.approval };
          observedRecoveryState = approvalReceiptRecoveryState(receipt);
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
        await applyResolution(response, observedRecoveryState);
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
        scheduleRecoveryLookup(cwd);
      }
    }
  }

  function upsertApprovalAction(approval: ApprovalRequest): void {
    updateApprovals({ type: "upsert", approval });
    setSelectedApprovalId(approval.id);
  }

  function resetForCwd(): void {
    clearRecoveryTracking();
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
    return mountedRef.current && cwdRef.current === cwd && listRequestSequenceRef.current === requestId;
  }

  function isCurrentExternalRequest(
    id: string,
    requestId: number,
    cwd: string,
    requests: ReadonlyMap<string, number>,
  ): boolean {
    return mountedRef.current && cwdRef.current === cwd && requests.get(id) === requestId;
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
