import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";
import { listAiCouncilMembers, replaceAiCouncilMembers } from "../../api/ai-councils.js";
import type { Translate } from "../../i18n.js";
import type { AiCouncil, AiCouncilHealthReport, AiCouncilMember, AiTeammate } from "../../types.js";
import {
  applyCouncilMemberIntent,
  buildCouncilMemberCandidates,
  buildCouncilMemberRows,
  buildCouncilMembersEvidence,
  buildCouncilMembersSummary,
  councilMembersFingerprint,
  sortCouncilMembers,
  type CouncilMemberCandidateView,
  type CouncilMemberHealthPending,
  type CouncilMemberIntent,
  type CouncilMemberRowView,
  type CouncilMembersEvidenceView,
  type CouncilMembersSummaryView,
} from "./council-members-view-model.js";

export interface CouncilMembersController {
  readonly addSelectRef: RefCallback<HTMLSelectElement>;
  readonly candidates: readonly CouncilMemberCandidateView[];
  readonly conflict: string;
  readonly evidence: CouncilMembersEvidenceView;
  readonly initialLoading: boolean;
  readonly loadError: string;
  readonly managed: boolean;
  readonly members: readonly AiCouncilMember[];
  readonly mutationBusy: boolean;
  readonly mutationDisabled: boolean;
  readonly mutationError: string;
  readonly mutationKind?: CouncilMemberIntent["kind"];
  readonly mutationTargetId?: string;
  readonly pendingTeammateId: string;
  readonly readinessBusy: boolean;
  readonly readinessError: string;
  readonly refreshBusy: boolean;
  readonly removeError: string;
  readonly removeLastEnabled: boolean;
  readonly removeTarget?: CouncilMemberRowView;
  readonly rows: readonly CouncilMemberRowView[];
  readonly stale: boolean;
  readonly summary: CouncilMembersSummaryView;
  readonly addMember: () => void;
  readonly confirmRemove: () => void;
  readonly moveMember: (teammateId: string, delta: -1 | 1) => void;
  readonly refreshMembers: () => Promise<void>;
  readonly refreshReadiness: () => Promise<void>;
  readonly requestRemove: (teammateId: string, trigger: HTMLButtonElement) => void;
  readonly requestRemoveOpenChange: (open: boolean) => void;
  readonly restoreRemoveFocus: () => void;
  readonly setPendingTeammateId: (teammateId: string) => void;
  readonly toggleMember: (teammateId: string) => void;
}

export function useCouncilMembersController({
  cwd,
  healthReport,
  healthRefreshError,
  onRefreshCouncilHealth,
  selectedCouncil,
  t,
  teammates,
}: {
  readonly cwd: string;
  readonly healthReport?: AiCouncilHealthReport;
  readonly healthRefreshError?: string;
  readonly onRefreshCouncilHealth: () => void | Promise<void>;
  readonly selectedCouncil?: AiCouncil;
  readonly t: Translate;
  readonly teammates: readonly AiTeammate[];
}): CouncilMembersController {
  const [members, setMembersState] = useState<readonly AiCouncilMember[]>([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [stale, setStale] = useState(false);
  const [pendingTeammateId, setPendingTeammateId] = useState("");
  const [mutationKind, setMutationKind] = useState<CouncilMemberIntent["kind"]>();
  const [mutationTargetId, setMutationTargetId] = useState<string>();
  const [mutationError, setMutationError] = useState("");
  const [conflict, setConflict] = useState("");
  const [removeTargetId, setRemoveTargetId] = useState<string>();
  const [removeError, setRemoveError] = useState("");
  const [healthPending, setHealthPending] = useState<CouncilMemberHealthPending>();
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [readinessError, setReadinessError] = useState("");
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const mutationFlightRef = useRef<symbol>();
  const readinessFlightRef = useRef<symbol>();
  const membersRef = useRef(members);
  const councilRef = useRef(selectedCouncil);
  const healthReportRef = useRef(healthReport);
  const addSelectElementRef = useRef<HTMLSelectElement | null>(null);
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);
  membersRef.current = members;
  councilRef.current = selectedCouncil;
  healthReportRef.current = healthReport;

  const setMembers = useCallback((next: readonly AiCouncilMember[]) => {
    const sorted = sortCouncilMembers(next);
    membersRef.current = sorted;
    setMembersState(sorted);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    mutationFlightRef.current = undefined;
    readinessFlightRef.current = undefined;
    setMembers([]);
    setInitialLoading(false);
    setRefreshBusy(false);
    setLoadError("");
    setStale(false);
    setPendingTeammateId("");
    setMutationKind(undefined);
    setMutationTargetId(undefined);
    setMutationError("");
    setConflict("");
    setRemoveTargetId(undefined);
    setRemoveError("");
    setHealthPending(undefined);
    setReadinessBusy(false);
    setReadinessError("");
    const trimmedCwd = cwd.trim();
    const councilId = selectedCouncil?.id;
    if (!trimmedCwd || !councilId) return;

    setInitialLoading(true);
    void listAiCouncilMembers(trimmedCwd, councilId)
      .then((response) => {
        if (isCurrentRequest(sequence, councilId)) setMembers(response.members);
      })
      .catch((caught: unknown) => {
        if (isCurrentRequest(sequence, councilId)) setLoadError(errorMessage(caught));
      })
      .finally(() => {
        if (isCurrentRequest(sequence, councilId)) setInitialLoading(false);
      });
  }, [cwd, selectedCouncil?.id, setMembers]);

  useEffect(() => {
    if (!healthPending || healthPending.councilId !== selectedCouncil?.id || !healthReport) return;
    const generatedAt = timestampValue(healthReport.generatedAt);
    const baseline = timestampValue(healthPending.baselineGeneratedAt);
    if (generatedAt !== undefined && (baseline === undefined || generatedAt > baseline)) {
      setHealthPending(undefined);
      setReadinessError("");
    }
  }, [healthPending, healthReport, selectedCouncil?.id]);

  useEffect(() => {
    if (healthPending && healthRefreshError) setReadinessError(healthRefreshError);
  }, [healthPending, healthRefreshError]);

  const evidence = useMemo(
    () => selectedCouncil
      ? buildCouncilMembersEvidence(selectedCouncil, members, healthReport, healthPending, t)
      : { complete: false, reason: t("Health pending") },
    [healthPending, healthReport, members, selectedCouncil, t],
  );
  const rows = useMemo(
    () => selectedCouncil ? buildCouncilMemberRows(selectedCouncil, members, teammates, healthReport, evidence, t) : [],
    [evidence, healthReport, members, selectedCouncil, t, teammates],
  );
  const candidates = useMemo(
    () => buildCouncilMemberCandidates(teammates, members, t),
    [members, t, teammates],
  );
  const summary = useMemo(() => buildCouncilMembersSummary(rows, evidence, t), [evidence, rows, t]);
  const removeTarget = rows.find((row) => row.member.teammateId === removeTargetId);
  const managed = Boolean(selectedCouncil && selectedCouncil.source !== "user");
  const mutationBusy = Boolean(mutationKind);
  const mutationDisabled = !selectedCouncil || managed || initialLoading || refreshBusy || stale || mutationBusy || !cwd.trim();
  const removeLastEnabled = Boolean(
    removeTarget?.member.enabled && members.filter((member) => member.enabled).length === 1,
  );

  const refreshMembers = useCallback(async (): Promise<void> => {
    const council = councilRef.current;
    const trimmedCwd = cwd.trim();
    if (!council || !trimmedCwd || refreshBusy || mutationFlightRef.current) return;
    const sequence = requestSequenceRef.current;
    const retainRows = membersRef.current.length > 0;
    if (retainRows) setRefreshBusy(true);
    else setInitialLoading(true);
    setLoadError("");
    setStale(false);
    try {
      const response = await listAiCouncilMembers(trimmedCwd, council.id);
      if (isCurrentRequest(sequence, council.id)) setMembers(response.members);
    } catch (caught) {
      if (isCurrentRequest(sequence, council.id)) {
        setLoadError(errorMessage(caught));
        setStale(retainRows);
      }
    } finally {
      if (isCurrentRequest(sequence, council.id)) {
        setRefreshBusy(false);
        setInitialLoading(false);
      }
    }
  }, [cwd, refreshBusy, setMembers]);

  const refreshReadiness = useCallback(async (): Promise<void> => {
    const councilId = selectedCouncil?.id;
    if (readinessFlightRef.current || !councilId) return;
    const flight = Symbol("council-members-readiness");
    readinessFlightRef.current = flight;
    setReadinessBusy(true);
    setReadinessError("");
    try {
      await onRefreshCouncilHealth();
    } catch (caught) {
      if (mountedRef.current && councilRef.current?.id === councilId) setReadinessError(errorMessage(caught));
    } finally {
      if (readinessFlightRef.current === flight) {
        readinessFlightRef.current = undefined;
        if (mountedRef.current && councilRef.current?.id === councilId) setReadinessBusy(false);
      }
    }
  }, [onRefreshCouncilHealth, selectedCouncil?.id]);

  const runIntent = useCallback(async (intent: CouncilMemberIntent): Promise<void> => {
    const council = councilRef.current;
    const trimmedCwd = cwd.trim();
    if (!council || council.source !== "user" || !trimmedCwd || mutationFlightRef.current || stale) return;
    const sequence = requestSequenceRef.current;
    const flight = Symbol("council-members-mutation");
    const expectedFingerprint = councilMembersFingerprint(membersRef.current);
    mutationFlightRef.current = flight;
    setMutationKind(intent.kind);
    setMutationTargetId(intent.kind === "add" ? intent.teammate.id : intent.teammateId);
    setMutationError("");
    setConflict("");
    setRemoveError("");
    try {
      const preflight = await listAiCouncilMembers(trimmedCwd, council.id);
      if (!isCurrentRequest(sequence, council.id)) return;
      if (councilMembersFingerprint(preflight.members) !== expectedFingerprint) {
        setMembers(preflight.members);
        setConflict(t("Review changes"));
        if (intent.kind === "add" && preflight.members.some((member) => member.teammateId === intent.teammate.id)) {
          setPendingTeammateId("");
        }
        if (intent.kind === "remove") setRemoveTargetId(undefined);
        return;
      }
      const next = applyCouncilMemberIntent(preflight.members, intent);
      if (!next.changed) {
        setMembers(preflight.members);
        setConflict(t("Review changes"));
        if (intent.kind === "add") setPendingTeammateId("");
        if (intent.kind === "remove") setRemoveTargetId(undefined);
        return;
      }
      const response = await replaceAiCouncilMembers(trimmedCwd, council.id, { members: next.members });
      if (!isCurrentRequest(sequence, council.id)) return;
      setMembers(response.members);
      setHealthPending({ councilId: council.id, baselineGeneratedAt: healthReportRef.current?.generatedAt });
      if (intent.kind === "add") {
        setPendingTeammateId("");
      }
      if (intent.kind === "remove") setRemoveTargetId(undefined);
      try {
        await onRefreshCouncilHealth();
      } catch (caught) {
        if (isCurrentRequest(sequence, council.id)) setReadinessError(errorMessage(caught));
      }
      if (intent.kind === "add" && isCurrentRequest(sequence, council.id)) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => addSelectElementRef.current?.focus());
        });
      }
    } catch (caught) {
      if (!isCurrentRequest(sequence, council.id)) return;
      if (intent.kind === "remove") setRemoveError(errorMessage(caught));
      else setMutationError(errorMessage(caught));
    } finally {
      if (mutationFlightRef.current === flight) mutationFlightRef.current = undefined;
      if (isCurrentRequest(sequence, council.id)) {
        setMutationKind(undefined);
        setMutationTargetId(undefined);
      }
    }
  }, [cwd, onRefreshCouncilHealth, setMembers, stale, t]);

  const addMember = useCallback(() => {
    const candidate = candidates.find((item) => item.teammate.id === pendingTeammateId);
    if (candidate) void runIntent({ kind: "add", teammate: candidate.teammate });
  }, [candidates, pendingTeammateId, runIntent]);

  return {
    addSelectRef: (element) => { addSelectElementRef.current = element; },
    candidates,
    conflict,
    evidence,
    initialLoading,
    loadError,
    managed,
    members,
    mutationBusy,
    mutationDisabled,
    mutationError,
    mutationKind,
    mutationTargetId,
    pendingTeammateId,
    readinessBusy,
    readinessError,
    refreshBusy,
    removeError,
    removeLastEnabled,
    removeTarget,
    rows,
    stale,
    summary,
    addMember,
    confirmRemove: () => removeTargetId && void runIntent({ kind: "remove", teammateId: removeTargetId }),
    moveMember: (teammateId, delta) => void runIntent({ kind: "move", teammateId, delta }),
    refreshMembers,
    refreshReadiness,
    requestRemove: (teammateId, trigger) => {
      if (mutationDisabled) return;
      removeTriggerRef.current = trigger;
      setRemoveError("");
      setRemoveTargetId(teammateId);
    },
    requestRemoveOpenChange: (open) => {
      if (!open && mutationKind !== "remove") {
        setRemoveError("");
        setRemoveTargetId(undefined);
      }
    },
    restoreRemoveFocus: () => {
      if (removeTriggerRef.current?.isConnected) removeTriggerRef.current.focus();
    },
    setPendingTeammateId,
    toggleMember: (teammateId) => void runIntent({ kind: "toggle", teammateId }),
  };

  function isCurrentRequest(sequence: number, councilId: string): boolean {
    return mountedRef.current && requestSequenceRef.current === sequence && councilRef.current?.id === councilId;
  }
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function timestampValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
