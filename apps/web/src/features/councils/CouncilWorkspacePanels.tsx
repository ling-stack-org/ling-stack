import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilRoutingModeLabel,
  aiCouncilSourceLabel,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
} from "../../types.js";
import {
  PageActionHeader,
} from "../../shared/components/index.js";
import {
  Button,
  EmptyState,
  IconButton,
  StatusIndicator,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/index.js";
import { CouncilChannelsPanel } from "./CouncilChannelsPanel.js";
import { CouncilHealthSummary } from "./CouncilHealthSummary.js";
import { CouncilListHealthPanel, CouncilListOverviewSummary } from "./CouncilListHealthPanel.js";
import { CouncilMembersPanel } from "./CouncilMembersPanel.js";
import { CouncilSettingsPanel } from "./CouncilSettingsPanel.js";
import { councilStatusPresentation } from "./council-status-presentation.js";
import type { CouncilListHealthController } from "./useCouncilListHealthController.js";
import type { CouncilMembersController } from "./useCouncilMembersController.js";
import type { CouncilChannelsController } from "./useCouncilChannelsController.js";
import type { CouncilSettingsArchiveController } from "./useCouncilSettingsArchiveController.js";

type CouncilDetailTab = "members" | "channels" | "settings";

export interface CouncilWorkspacePanelsProps {
  readonly cwd: string;
  readonly aiCouncilsLoading: boolean;
  readonly activeCouncils: readonly AiCouncil[];
  readonly selectedCouncil?: AiCouncil;
  readonly selectedCouncilId: string;
  readonly listHealthController: CouncilListHealthController;
  readonly onRefresh: () => void | Promise<void>;
  readonly onOpenAiTeammates: () => void;
  readonly settingsToolMode?: boolean;

  readonly createCloneBlocked: boolean;
  readonly mutationFeedback?: ReactNode;
  readonly onOpenCreateCouncil: () => void;
  readonly onOpenCloneCouncil: () => void;
  readonly canCloneCouncil: boolean;

  readonly selectedBoundaryLabels: readonly string[];
  readonly selectedCapacityLabel?: string;
  readonly membersController: CouncilMembersController;
  readonly channelsController: CouncilChannelsController;
  readonly settingsArchiveController: CouncilSettingsArchiveController;
}

export function CouncilWorkspacePanels(props: CouncilWorkspacePanelsProps): React.JSX.Element {
  const { t } = useI18n();
  const selectedCouncil = props.selectedCouncil;
  const [activeDetailTab, setActiveDetailTab] = useState<CouncilDetailTab>("members");

  useEffect(() => {
    setActiveDetailTab("members");
  }, [props.selectedCouncilId]);

  return (
    <div className={props.settingsToolMode ? "council-workspace-page settings-return-mode" : "council-workspace-page"} aria-label={t("Council Workspace")}>
      {!props.settingsToolMode ? (
        <PageActionHeader
          title={t("Council Workspace")}
          description={t("Manage councils, members, health, and channel usage from one workspace.")}
          meta={<CouncilListOverviewSummary overview={props.listHealthController.overview} />}
          primaryAction={(
            <Button
              disabled={props.createCloneBlocked}
              leadingIcon={<Plus />}
              onClick={props.onOpenCreateCouncil}
              size="sm"
              variant="primary"
            >
              {t("Create council")}
            </Button>
          )}
          secondaryActions={(
            <>
              <Button onClick={props.onOpenAiTeammates} size="sm" variant="secondary">
                {t("Open AI Teammates")}
              </Button>
            </>
          )}
          className="council-workspace-header"
        />
      ) : null}

      <div className="council-workspace-grid">
        <CouncilListHealthPanel
          createBlocked={props.createCloneBlocked}
          filter={props.listHealthController.filter}
          initialLoading={props.listHealthController.initialLoading}
          mutationFeedback={props.mutationFeedback}
          onClearFilters={props.listHealthController.clearFilters}
          onCreate={props.onOpenCreateCouncil}
          onFilterChange={props.listHealthController.setFilter}
          onQueryChange={props.listHealthController.setQuery}
          onRefresh={props.onRefresh}
          onSelect={props.listHealthController.selectCouncil}
          overview={props.listHealthController.overview}
          query={props.listHealthController.query}
          refreshBusy={props.listHealthController.refreshBusy}
          refreshError={props.listHealthController.refreshError}
          rows={props.listHealthController.rows}
          selectedCouncilId={props.selectedCouncilId}
          settingsToolMode={Boolean(props.settingsToolMode)}
          stale={props.listHealthController.stale}
          visibleRows={props.listHealthController.visibleRows}
        />

        <section className="council-workspace-detail" aria-label={t("Selected council")}>
          {selectedCouncil ? (
            <>
              <CouncilDetailHeader
                council={selectedCouncil}
                selectedCapacityLabel={props.selectedCapacityLabel}
                selectedBoundaryLabels={props.selectedBoundaryLabels}
              />
              {props.listHealthController.selectedRow ? <CouncilHealthSummary row={props.listHealthController.selectedRow} /> : null}
              <Tabs
                className="council-detail-tabs-root"
                value={activeDetailTab}
                onValueChange={(value) => setActiveDetailTab(value as CouncilDetailTab)}
              >
                <CouncilDetailTabs />
                <div className="council-detail-body">
                  {activeDetailTab === "members" ? (
                    <CouncilMembersPanel
                      cloneDisabled={!props.canCloneCouncil}
                      controller={props.membersController}
                      council={selectedCouncil}
                      cwd={props.cwd}
                      onOpenCloneCouncil={() => {
                        props.membersController.requestRemoveOpenChange(false);
                        props.onOpenCloneCouncil();
                      }}
                      onOpenTeammates={props.onOpenAiTeammates}
                    />
                  ) : null}
                  {activeDetailTab === "channels" ? <CouncilChannelsPanel controller={props.channelsController} /> : null}
                  {activeDetailTab === "settings" ? (
                    <CouncilSettingsPanel
                      canCloneCouncil={props.canCloneCouncil}
                      controller={props.settingsArchiveController}
                      onOpenCloneCouncil={props.onOpenCloneCouncil}
                      selectedBoundaryLabels={props.selectedBoundaryLabels}
                      selectedCapacityLabel={props.selectedCapacityLabel}
                    />
                  ) : null}
                </div>
              </Tabs>
            </>
          ) : (
            <EmptyState
              action={(
                <Button
                  disabled={props.createCloneBlocked}
                  leadingIcon={<Plus />}
                  onClick={props.onOpenCreateCouncil}
                  size="sm"
                  variant="primary"
                >
                  {t("Create council")}
                </Button>
              )}
              className="council-workspace-empty-selection"
              compact
              description={t("Select a council to manage members, channels, and settings.")}
              secondaryAction={(
                <Button onClick={props.onOpenAiTeammates} size="sm" variant="secondary">
                  {t("Open AI Teammates")}
                </Button>
              )}
              title={t("No council selected")}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function CouncilDetailHeader({
  council,
  selectedCapacityLabel,
  selectedBoundaryLabels,
}: {
  readonly council: AiCouncil;
  readonly selectedCapacityLabel?: string;
  readonly selectedBoundaryLabels: readonly string[];
}): React.JSX.Element {
  const { t } = useI18n();
  const visibleBoundaryLabels = selectedBoundaryLabels.slice(0, selectedCapacityLabel ? 1 : 2);
  const lifecycleStatus = councilStatusPresentation(council.status);

  return (
    <div className="council-detail-head">
      <div>
        <strong>{council.displayName}</strong>
      </div>
      <StatusIndicator
        className="council-detail-status"
        label={t(lifecycleStatus.labelKey)}
        tone={lifecycleStatus.tone}
      />
      <div className="council-chip-row" aria-label={t("Council boundaries")}>
        <span>{aiCouncilSourceLabel(council.source, t)}</span>
        <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
        {selectedCapacityLabel ? <span>{selectedCapacityLabel}</span> : null}
        {visibleBoundaryLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

function CouncilDetailTabs(): React.JSX.Element {
  const { t } = useI18n();
  const tabs: readonly { readonly id: CouncilDetailTab; readonly label: string }[] = [
    { id: "members", label: t("Council members") },
    { id: "channels", label: t("Channel usage") },
    { id: "settings", label: t("Council settings") },
  ];

  return (
    <TabsList className="council-detail-tabs council-detail-tabs-list" appearance="contained" size="sm" aria-label={t("Council detail sections")}>
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.id}
          value={tab.id}
        >
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
