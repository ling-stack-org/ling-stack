import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
  AiCouncilHealthReport,
  AiTeammate,
  Channel,
} from "../../types.js";
import { CouncilCloneDialog } from "./CouncilCloneDialog.js";
import { CouncilCreateDialog } from "./CouncilCreateDialog.js";
import { CouncilArchiveDialog } from "./CouncilArchiveDialog.js";
import { CouncilMutationProjectionStatus } from "./CouncilMutationProjectionStatus.js";
import { CouncilWorkspacePanels } from "./CouncilWorkspacePanels.js";
import { useCouncilCreateCloneController } from "./useCouncilCreateCloneController.js";
import { useCouncilChannelsController } from "./useCouncilChannelsController.js";
import { useCouncilListHealthController } from "./useCouncilListHealthController.js";
import { useCouncilMembersController } from "./useCouncilMembersController.js";
import { useCouncilSettingsArchiveController } from "./useCouncilSettingsArchiveController.js";

export interface CouncilWorkspacePageProps {
  readonly cwd: string;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilHealthReport?: AiCouncilHealthReport;
  readonly aiCouncilsLoading: boolean;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly onRefresh: () => void | Promise<void>;
  readonly onOpenAiTeammates: () => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly settingsToolMode?: boolean;
}

export function CouncilWorkspacePage({
  cwd,
  aiCouncils,
  aiCouncilHealthReport,
  aiCouncilsLoading,
  channels,
  teammates,
  onRefresh,
  onOpenAiTeammates,
  onOpenChannel,
  settingsToolMode = false,
}: CouncilWorkspacePageProps): JSX.Element {
  const { t } = useI18n();
  const [authoritativeProjectedCouncil, setAuthoritativeProjectedCouncil] = useState<AiCouncil>();

  const projectedCouncils = useMemo(() => {
    if (!authoritativeProjectedCouncil) return aiCouncils;
    const existingIndex = aiCouncils.findIndex((council) => council.id === authoritativeProjectedCouncil.id);
    if (existingIndex < 0) return [...aiCouncils, authoritativeProjectedCouncil];
    const next = [...aiCouncils];
    next[existingIndex] = authoritativeProjectedCouncil;
    return next;
  }, [aiCouncils, authoritativeProjectedCouncil]);

  useEffect(() => {
    if (!authoritativeProjectedCouncil) return;
    const upstream = aiCouncils.find((council) => council.id === authoritativeProjectedCouncil.id);
    if (upstream && councilProjectionCaughtUp(upstream, authoritativeProjectedCouncil)) {
      setAuthoritativeProjectedCouncil(undefined);
    }
  }, [aiCouncils, authoritativeProjectedCouncil]);

  const listHealthController = useCouncilListHealthController({
    councils: projectedCouncils,
    healthReport: aiCouncilHealthReport,
    loading: aiCouncilsLoading,
    onRefresh,
    t,
  });
  const activeCouncils = useMemo(
    () => listHealthController.rows.map((row) => row.council),
    [listHealthController.rows],
  );
  const selectedCouncil = listHealthController.selectedRow?.council;
  const membersController = useCouncilMembersController({
    cwd,
    healthReport: aiCouncilHealthReport,
    healthRefreshError: listHealthController.refreshError,
    onRefreshCouncilHealth: refreshCouncils,
    selectedCouncil,
    t,
    teammates,
  });
  const channelsController = useCouncilChannelsController({
    channels,
    councils: activeCouncils,
    cwd,
    onOpenChannel,
    selectedCouncil,
  });
  const createCloneController = useCouncilCreateCloneController({
    cwd,
    aiCouncilsLoading,
    teammates,
    selectedCouncil,
    selectedMembers: membersController.members,
    selectedMembersLoading: membersController.initialLoading,
    selectedMembersError: membersController.loadError,
    onRefresh: refreshCouncils,
    onProjectCouncil: selectProjectedCouncil,
  });
  const settingsArchiveController = useCouncilSettingsArchiveController({
    council: selectedCouncil,
    cwd,
    externallyBlocked: membersController.mutationBusy || createCloneController.operationsBlocked || aiCouncilsLoading,
    onProjectCouncil: selectProjectedCouncil,
    onRefresh: refreshCouncils,
  });
  const mutationDisabled = membersController.mutationBusy || createCloneController.operationsBlocked || settingsArchiveController.archiveBusy || Boolean(settingsArchiveController.mutationKind) || aiCouncilsLoading;

  const selectedBoundaryLabels = selectedCouncil ? aiCouncilBoundaryLabels(selectedCouncil, t) : [];
  const selectedCapacityLabel = selectedCouncil ? aiCouncilCapacityLabel(selectedCouncil, t) : undefined;

  async function refreshCouncils(): Promise<void> {
    await listHealthController.refresh();
  }

  function selectProjectedCouncil(council: AiCouncil): void {
    setAuthoritativeProjectedCouncil(council);
    listHealthController.selectProjectedCouncil(council.id);
  }

  return (
    <>
      <CouncilWorkspacePanels
      cwd={cwd}
      aiCouncilsLoading={aiCouncilsLoading}
      activeCouncils={activeCouncils}
      selectedCouncil={selectedCouncil}
      selectedCouncilId={selectedCouncil?.id ?? ""}
      listHealthController={listHealthController}
      onRefresh={refreshCouncils}
      onOpenAiTeammates={onOpenAiTeammates}
      settingsToolMode={settingsToolMode}
      createCloneBlocked={createCloneController.operationsBlocked}
      mutationFeedback={(
        <CouncilMutationProjectionStatus
          projection={createCloneController.projection}
          repairBusy={createCloneController.projectionRepairBusy}
          onRepair={createCloneController.repairProjection}
        />
      )}
      onOpenCreateCouncil={createCloneController.openCreate}
      onOpenCloneCouncil={createCloneController.openClone}
      canCloneCouncil={createCloneController.canOpenClone && !mutationDisabled}
      selectedBoundaryLabels={selectedBoundaryLabels}
      selectedCapacityLabel={selectedCapacityLabel}
      membersController={membersController}
      channelsController={channelsController}
      settingsArchiveController={settingsArchiveController}
      />
      <CouncilArchiveDialog controller={settingsArchiveController} />
      <CouncilCreateDialog
        busy={createCloneController.createBusy}
        confirmEmpty={createCloneController.confirmEmptyCreate}
        draft={createCloneController.createDraft}
        eligibleTeammates={createCloneController.eligibleTeammates}
        error={createCloneController.createError}
        open={createCloneController.createOpen}
        onDraftChange={createCloneController.updateCreateDraft}
        onOpenChange={createCloneController.requestCreateOpenChange}
        onRestoreFocus={createCloneController.restoreCreateFocus}
        onSubmit={createCloneController.submitCreate}
        onToggleMember={createCloneController.toggleCreateMember}
      />
      <CouncilCloneDialog
        busy={createCloneController.cloneBusy}
        error={createCloneController.cloneError}
        open={createCloneController.cloneOpen}
        review={createCloneController.cloneReview}
        onDraftChange={createCloneController.updateCloneDraft}
        onOpenChange={createCloneController.requestCloneOpenChange}
        onRestoreFocus={createCloneController.restoreCloneFocus}
        onSubmit={createCloneController.submitClone}
      />
    </>
  );
}

function councilProjectionCaughtUp(upstream: AiCouncil, projected: AiCouncil): boolean {
  if (upstream.id !== projected.id) return false;
  if (
    upstream.displayName === projected.displayName &&
    upstream.description === projected.description &&
    upstream.pinned === projected.pinned &&
    upstream.status === projected.status &&
    upstream.updatedAt === projected.updatedAt
  ) return true;
  const upstreamTime = Date.parse(upstream.updatedAt);
  const projectedTime = Date.parse(projected.updatedAt);
  return Number.isFinite(upstreamTime) && Number.isFinite(projectedTime) && upstreamTime > projectedTime;
}
