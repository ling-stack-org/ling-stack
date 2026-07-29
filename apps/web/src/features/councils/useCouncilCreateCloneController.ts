import { useMemo, useRef, useState } from "react";
import {
  cloneAiCouncil,
  createAiCouncil,
  getAiCouncil,
  listAiCouncilMembers,
} from "../../api/ai-councils.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiCouncil, AiCouncilMember, AiTeammate } from "../../types.js";
import {
  buildCloneAiCouncilRequest,
  buildCloneMemberSummaries,
  buildCouncilCloneSourceSignature,
  buildCreateAiCouncilRequest,
  createInitialCloneDraft,
  createInitialCouncilDraft,
  listEligibleCouncilTeammates,
  toggleCouncilDraftMember,
  type CouncilCloneDraft,
  type CouncilCloneMemberSummary,
  type CouncilCreateDraft,
} from "./council-create-clone-view-model.js";

export type CouncilMutationKind = "create" | "clone";
export type CouncilProjectionPhase = "refreshing" | "checking" | "stale";

export interface CouncilMutationProjection {
  readonly councilId: string;
  readonly displayName: string;
  readonly kind: CouncilMutationKind;
  readonly phase: CouncilProjectionPhase;
}

export interface CouncilCloneReview {
  readonly source: AiCouncil;
  readonly members: readonly CouncilCloneMemberSummary[];
  readonly memberSummaryAvailable: boolean;
  readonly snapshotSignature: string;
  readonly changedSinceReview: boolean;
  readonly draft: CouncilCloneDraft;
}

export interface CouncilCreateCloneController {
  readonly eligibleTeammates: readonly AiTeammate[];
  readonly createDraft: CouncilCreateDraft;
  readonly createOpen: boolean;
  readonly createBusy: boolean;
  readonly createError: string;
  readonly confirmEmptyCreate: boolean;
  readonly cloneReview?: CouncilCloneReview;
  readonly cloneOpen: boolean;
  readonly cloneBusy: boolean;
  readonly cloneError: string;
  readonly projection?: CouncilMutationProjection;
  readonly projectionRepairBusy: boolean;
  readonly operationsBlocked: boolean;
  readonly canOpenClone: boolean;
  readonly openCreate: () => void;
  readonly requestCreateOpenChange: (open: boolean) => void;
  readonly restoreCreateFocus: () => void;
  readonly updateCreateDraft: (patch: Partial<CouncilCreateDraft>) => void;
  readonly toggleCreateMember: (teammateId: string) => void;
  readonly submitCreate: () => Promise<void>;
  readonly openClone: () => void;
  readonly requestCloneOpenChange: (open: boolean) => void;
  readonly restoreCloneFocus: () => void;
  readonly updateCloneDraft: (patch: Partial<CouncilCloneDraft>) => void;
  readonly submitClone: () => Promise<void>;
  readonly repairProjection: () => Promise<void>;
}

export function useCouncilCreateCloneController({
  cwd,
  aiCouncilsLoading,
  teammates,
  selectedCouncil,
  selectedMembers,
  selectedMembersLoading,
  selectedMembersError,
  onRefresh,
  onProjectCouncil,
}: {
  readonly cwd: string;
  readonly aiCouncilsLoading: boolean;
  readonly teammates: readonly AiTeammate[];
  readonly selectedCouncil?: AiCouncil;
  readonly selectedMembers: readonly AiCouncilMember[];
  readonly selectedMembersLoading: boolean;
  readonly selectedMembersError: string;
  readonly onRefresh: () => void | Promise<void>;
  readonly onProjectCouncil: (council: AiCouncil) => void;
}): CouncilCreateCloneController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const eligibleTeammates = useMemo(() => listEligibleCouncilTeammates(teammates), [teammates]);
  const [createDraft, setCreateDraft] = useState<CouncilCreateDraft>(() => createInitialCouncilDraft(t("Custom council")));
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [confirmEmptyCreate, setConfirmEmptyCreate] = useState(false);
  const [cloneReview, setCloneReview] = useState<CouncilCloneReview>();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [projection, setProjection] = useState<CouncilMutationProjection>();
  const [projectionRepairBusy, setProjectionRepairBusy] = useState(false);
  const createFlightRef = useRef(false);
  const cloneFlightRef = useRef(false);
  const projectionFlightRef = useRef(false);
  const createTriggerRef = useRef<HTMLElement | null>(null);
  const cloneTriggerRef = useRef<HTMLElement | null>(null);

  function openCreate(): void {
    if (operationsBlocked) return;
    createTriggerRef.current = activeElement();
    setCreateDraft(createInitialCouncilDraft(t("Custom council")));
    setCreateError("");
    setConfirmEmptyCreate(false);
    setCreateOpen(true);
  }

  function requestCreateOpenChange(open: boolean): void {
    if (createFlightRef.current || createBusy) return;
    if (open) {
      openCreate();
      return;
    }
    setCreateOpen(false);
    setCreateError("");
    setConfirmEmptyCreate(false);
  }

  function restoreCreateFocus(): void {
    createTriggerRef.current?.focus({ preventScroll: true });
  }

  function updateCreateDraft(patch: Partial<CouncilCreateDraft>): void {
    setCreateDraft((current) => ({ ...current, ...patch }));
    setCreateError("");
    if (patch.memberIds && patch.memberIds.length > 0) setConfirmEmptyCreate(false);
  }

  function toggleCreateMember(teammateId: string): void {
    setCreateDraft((current) => ({
      ...current,
      memberIds: toggleCouncilDraftMember(current.memberIds, teammateId),
    }));
    setCreateError("");
    setConfirmEmptyCreate(false);
  }

  async function submitCreate(): Promise<void> {
    if (createFlightRef.current) return;
    const trimmedCwd = cwd.trim();
    const request = buildCreateAiCouncilRequest(createDraft, eligibleTeammates);
    if (!trimmedCwd || !request.displayName) return;
    if (request.members?.length === 0 && !confirmEmptyCreate) {
      setConfirmEmptyCreate(true);
      return;
    }

    createFlightRef.current = true;
    setCreateBusy(true);
    setCreateError("");
    try {
      const response = await createAiCouncil(trimmedCwd, request);
      showToast({
        message: t("{name} created", { name: response.council.displayName }),
        scope: "council:create",
        tone: "success",
      });
      setCreateOpen(false);
      setCreateDraft(createInitialCouncilDraft(t("Custom council")));
      setConfirmEmptyCreate(false);
      await refreshProjection({
        councilId: response.council.id,
        displayName: response.council.displayName,
        kind: "create",
      });
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      createFlightRef.current = false;
      setCreateBusy(false);
    }
  }

  function openClone(): void {
    if (!selectedCouncil || operationsBlocked) return;
    cloneTriggerRef.current = activeElement();
    setCloneReview({
      source: selectedCouncil,
      members: buildCloneMemberSummaries(selectedMembers, teammates),
      memberSummaryAvailable: !selectedMembersError,
      snapshotSignature: buildCouncilCloneSourceSignature(selectedCouncil, selectedMembers),
      changedSinceReview: false,
      draft: createInitialCloneDraft(
        selectedCouncil,
        t("Copy of {name}", { name: selectedCouncil.displayName }),
      ),
    });
    setCloneError("");
    setCloneOpen(true);
  }

  function requestCloneOpenChange(open: boolean): void {
    if (cloneFlightRef.current || cloneBusy) return;
    if (open) {
      openClone();
      return;
    }
    setCloneOpen(false);
    setCloneError("");
  }

  function restoreCloneFocus(): void {
    cloneTriggerRef.current?.focus({ preventScroll: true });
  }

  function updateCloneDraft(patch: Partial<CouncilCloneDraft>): void {
    setCloneReview((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
    setCloneError("");
  }

  async function submitClone(): Promise<void> {
    if (cloneFlightRef.current || !cloneReview) return;
    const trimmedCwd = cwd.trim();
    const request = buildCloneAiCouncilRequest(cloneReview.draft);
    if (!trimmedCwd || !request.displayName) return;

    cloneFlightRef.current = true;
    setCloneBusy(true);
    setCloneError("");
    try {
      const [sourceResponse, membersResponse] = await Promise.all([
        getAiCouncil(trimmedCwd, cloneReview.source.id),
        listAiCouncilMembers(trimmedCwd, cloneReview.source.id),
      ]);
      const snapshotSignature = buildCouncilCloneSourceSignature(sourceResponse.council, membersResponse.members);
      if (snapshotSignature !== cloneReview.snapshotSignature) {
        setCloneReview((current) => current?.source.id === cloneReview.source.id
          ? {
              ...current,
              source: sourceResponse.council,
              members: buildCloneMemberSummaries(membersResponse.members, teammates),
              memberSummaryAvailable: true,
              snapshotSignature,
              changedSinceReview: true,
            }
          : current);
        return;
      }
      const response = await cloneAiCouncil(trimmedCwd, cloneReview.source.id, request);
      showToast({
        message: t("{name} cloned", { name: response.council.displayName }),
        scope: "council:clone",
        tone: "success",
      });
      setCloneOpen(false);
      await refreshProjection({
        councilId: response.council.id,
        displayName: response.council.displayName,
        kind: "clone",
      });
    } catch (caught) {
      setCloneError(errorMessage(caught));
    } finally {
      cloneFlightRef.current = false;
      setCloneBusy(false);
    }
  }

  async function refreshProjection(input: Omit<CouncilMutationProjection, "phase">): Promise<void> {
    setProjection({ ...input, phase: "refreshing" });
    try {
      await onRefresh();
    } catch {
      // The detail read below remains authoritative even when the paged list refresh fails.
    }
    setProjection((current) => current?.councilId === input.councilId
      ? { ...current, phase: "checking" }
      : current);
    try {
      const response = await getAiCouncil(cwd.trim(), input.councilId);
      onProjectCouncil(response.council);
      setProjection((current) => current?.councilId === input.councilId ? undefined : current);
    } catch {
      setProjection((current) => current?.councilId === input.councilId
        ? { ...current, phase: "stale" }
        : current);
    }
  }

  async function repairProjection(): Promise<void> {
    if (!projection || projectionFlightRef.current) return;
    projectionFlightRef.current = true;
    setProjectionRepairBusy(true);
    try {
      await refreshProjection(projection);
    } finally {
      projectionFlightRef.current = false;
      setProjectionRepairBusy(false);
    }
  }

  const operationsBlocked = !cwd.trim() || aiCouncilsLoading || createBusy || cloneBusy || Boolean(projection);
  return {
    eligibleTeammates,
    createDraft,
    createOpen,
    createBusy,
    createError,
    confirmEmptyCreate,
    cloneReview,
    cloneOpen,
    cloneBusy,
    cloneError,
    projection,
    projectionRepairBusy,
    operationsBlocked,
    canOpenClone: Boolean(selectedCouncil) && !selectedMembersLoading && !operationsBlocked,
    openCreate,
    requestCreateOpenChange,
    restoreCreateFocus,
    updateCreateDraft,
    toggleCreateMember,
    submitCreate,
    openClone,
    requestCloneOpenChange,
    restoreCloneFocus,
    updateCloneDraft,
    submitClone,
    repairProjection,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function activeElement(): HTMLElement | null {
  return typeof document !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}
