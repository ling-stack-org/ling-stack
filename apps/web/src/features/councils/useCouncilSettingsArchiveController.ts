import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { updateAiCouncil } from "../../api/ai-councils.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiCouncil } from "../../types.js";
import {
  buildCouncilSettingsArchiveViewModel,
  councilSettingsDraftChanged,
  councilSettingsRequest,
  councilSettingsSnapshot,
  createCouncilSettingsDraft,
  type CouncilSettingsDraft,
  type CouncilSettingsMutationKind,
} from "./council-settings-archive-view-model.js";

export function useCouncilSettingsArchiveController({
  council,
  cwd,
  externallyBlocked,
  onProjectCouncil,
  onRefresh,
}: {
  readonly council?: AiCouncil;
  readonly cwd: string;
  readonly externallyBlocked: boolean;
  readonly onProjectCouncil: (council: AiCouncil) => void;
  readonly onRefresh: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const initialCouncil = council ?? emptyCouncil;
  const [authority, setAuthority] = useState<AiCouncil>(initialCouncil);
  const [draft, setDraftState] = useState<CouncilSettingsDraft>(() => createCouncilSettingsDraft(initialCouncil));
  const [mutationKind, setMutationKind] = useState<CouncilSettingsMutationKind>();
  const [settingsError, setSettingsError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);
  const identityRef = useRef(identity(cwd, council));
  const synchronizedIdentityRef = useRef(identity(cwd, council));
  const authorityRef = useRef(authority);
  const draftRef = useRef(draft);
  const mutationFlightRef = useRef(false);
  const archiveFlightRef = useRef(false);
  const mountedRef = useRef(true);
  authorityRef.current = authority;
  draftRef.current = draft;
  identityRef.current = identity(cwd, council);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const next = council ?? emptyCouncil;
    const nextIdentity = identity(cwd, council);
    if (!council || nextIdentity !== synchronizedIdentityRef.current) {
      synchronizedIdentityRef.current = nextIdentity;
      authorityRef.current = next;
      draftRef.current = createCouncilSettingsDraft(next);
      setAuthority(next);
      setDraftState(draftRef.current);
      resetTransientState();
      return;
    }

    if (councilSettingsSnapshot(next) === councilSettingsSnapshot(authorityRef.current)) return;
    const retainDraft = councilSettingsDraftChanged(draftRef.current, authorityRef.current);
    authorityRef.current = next;
    setAuthority(next);
    if (!retainDraft) {
      draftRef.current = createCouncilSettingsDraft(next);
      setDraftState(draftRef.current);
    }
  }, [council, cwd]);

  const viewModel = useMemo(() => buildCouncilSettingsArchiveViewModel({
    archiveBusy,
    council: authority,
    draft,
    externallyBlocked,
    mutationKind,
  }), [archiveBusy, authority, draft, externallyBlocked, mutationKind]);

  function resetTransientState(): void {
    mutationFlightRef.current = false;
    archiveFlightRef.current = false;
    setMutationKind(undefined);
    setSettingsError("");
    setStatusError("");
    setArchiveOpen(false);
    setArchiveBusy(false);
    setArchiveError("");
  }

  function setDraft(patch: Partial<CouncilSettingsDraft>): void {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraftState(next);
    setSettingsError("");
  }

  function resetDraft(): void {
    if (!viewModel.canReset) return;
    const next = createCouncilSettingsDraft(authorityRef.current);
    draftRef.current = next;
    setDraftState(next);
    setSettingsError("");
  }

  async function save(): Promise<void> {
    const operationCouncil = authorityRef.current;
    const operationIdentity = identityRef.current;
    if (!viewModel.canSave || mutationFlightRef.current || operationCouncil === emptyCouncil) return;
    mutationFlightRef.current = true;
    setMutationKind("save");
    setSettingsError("");
    try {
      const response = await updateAiCouncil(cwd.trim(), operationCouncil.id, councilSettingsRequest(draftRef.current));
      if (!isCurrent(operationIdentity)) return;
      adoptAuthority(response.council);
      onProjectCouncil(response.council);
      showToast({ message: t("Saved"), scope: `council:${response.council.id}:settings`, tone: "success" });
      await repairProjection();
    } catch (caught) {
      if (isCurrent(operationIdentity)) setSettingsError(errorMessage(caught));
    } finally {
      mutationFlightRef.current = false;
      if (isCurrent(operationIdentity)) setMutationKind(undefined);
    }
  }

  async function toggleStatus(): Promise<void> {
    const operationCouncil = authorityRef.current;
    const operationIdentity = identityRef.current;
    if (!viewModel.canToggleStatus || mutationFlightRef.current || operationCouncil === emptyCouncil) return;
    mutationFlightRef.current = true;
    setMutationKind("status");
    setStatusError("");
    try {
      const response = await updateAiCouncil(cwd.trim(), operationCouncil.id, {
        status: operationCouncil.status === "paused" ? "active" : "paused",
      });
      if (!isCurrent(operationIdentity)) return;
      adoptAuthority(response.council, true);
      onProjectCouncil(response.council);
      await repairProjection();
    } catch (caught) {
      if (isCurrent(operationIdentity)) setStatusError(errorMessage(caught));
    } finally {
      mutationFlightRef.current = false;
      if (isCurrent(operationIdentity)) setMutationKind(undefined);
    }
  }

  function requestArchive(): void {
    if (!viewModel.canArchive || archiveFlightRef.current) return;
    setArchiveError("");
    setArchiveOpen(true);
  }

  function setArchiveDialogOpen(open: boolean): void {
    if (!open && archiveFlightRef.current) return;
    if (open) requestArchive();
    else {
      setArchiveOpen(false);
      setArchiveError("");
    }
  }

  async function confirmArchive(): Promise<void> {
    const operationCouncil = authorityRef.current;
    const operationIdentity = identityRef.current;
    if (!viewModel.archiveAllowed || archiveFlightRef.current || operationCouncil === emptyCouncil) return;
    archiveFlightRef.current = true;
    setArchiveBusy(true);
    setArchiveError("");
    try {
      const response = await updateAiCouncil(cwd.trim(), operationCouncil.id, { status: "archived" });
      if (!isCurrent(operationIdentity)) return;
      adoptAuthority(response.council, true);
      onProjectCouncil(response.council);
      setArchiveOpen(false);
      await repairProjection();
    } catch (caught) {
      if (isCurrent(operationIdentity)) setArchiveError(errorMessage(caught));
    } finally {
      archiveFlightRef.current = false;
      if (isCurrent(operationIdentity)) setArchiveBusy(false);
    }
  }

  function restoreArchiveFocus(): void {
    window.requestAnimationFrame(() => {
      if (archiveTriggerRef.current?.isConnected) {
        archiveTriggerRef.current.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLElement>(
        '[data-settings-workspace-tool="councils"] [data-ling-input-native="true"], .council-workspace-page [data-ling-input-native="true"]',
      )?.focus({ preventScroll: true });
    });
  }

  async function repairProjection(): Promise<void> {
    try {
      await onRefresh();
    } catch {
      // The authoritative mutation response remains valid; refresh owns stale feedback.
    }
  }

  function adoptAuthority(next: AiCouncil, retainDirtyDraft = false): void {
    const retainDraft = retainDirtyDraft && councilSettingsDraftChanged(draftRef.current, authorityRef.current);
    authorityRef.current = next;
    setAuthority(next);
    if (!retainDraft) {
      draftRef.current = createCouncilSettingsDraft(next);
      setDraftState(draftRef.current);
    }
  }

  function isCurrent(operationIdentity: string): boolean {
    return mountedRef.current && identityRef.current === operationIdentity;
  }

  return {
    archiveBusy,
    archiveError,
    archiveOpen,
    archiveTriggerRef: archiveTriggerRef as RefObject<HTMLButtonElement | null>,
    authority,
    draft,
    mutationKind,
    settingsError,
    statusError,
    viewModel,
    confirmArchive,
    requestArchive,
    resetDraft,
    restoreArchiveFocus,
    save,
    setArchiveDialogOpen,
    setDraft,
    toggleStatus,
  };
}

export type CouncilSettingsArchiveController = ReturnType<typeof useCouncilSettingsArchiveController>;

function identity(cwd: string, council: AiCouncil | undefined): string {
  return `${cwd.trim()}::${council?.id ?? ""}`;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message.trim() ? caught.message : String(caught);
}

const emptyCouncil: AiCouncil = {
  id: "",
  workspaceId: "",
  source: "builtin",
  displayName: "",
  description: "",
  routingPolicy: { defaultMode: "advisory", notes: [] },
  governanceProfile: {
    permissionBoundary: "restrict_only",
    approvalBoundary: "cannot_bypass",
    toolGrantBoundary: "cannot_grant",
    credentialBoundary: "cannot_grant",
    notes: [],
  },
  status: "archived",
  pinned: false,
  createdAt: "",
  updatedAt: "",
};
