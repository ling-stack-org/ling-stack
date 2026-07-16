import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  Loader2,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { SelectControl } from "../../shared/components/SelectControl.js";
import {
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
  aiCouncilHealthLabels,
  aiCouncilRoutingModeLabel,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
  AiCouncilHealthReport,
  ChannelCouncilPolicy,
  ChannelFormState,
  ChannelWorkspaceBinding,
  ChannelWorkspaceMode,
  EffectiveChannelCouncilProjection,
  ProviderPreset,
} from "../../types.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelSettingsGeneralPanel, type ChannelNotificationLevel } from "./ChannelSettingsGeneralPanel.js";
import { ChannelSettingsNavigation, type ChannelSettingsSection } from "./ChannelSettingsNavigation.js";
import { ChannelSettingsWorkspacePanel } from "./ChannelSettingsWorkspacePanel.js";

export type { ChannelNotificationLevel } from "./ChannelSettingsGeneralPanel.js";
export { channelWorkspaceModeIcon, channelWorkspaceModeLabel, shortWorkspacePath } from "./ChannelSettingsWorkspacePanel.js";

interface ChannelTeammateManagerPanelProps {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelTeammateMembershipsLoading: boolean;
  readonly channelTeammates: readonly { readonly teammate: LocalTeammateDraft }[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly availableChannelTeammates: readonly LocalTeammateDraft[];
  readonly pendingChannelTeammateId: string;
  readonly channelTeammateSavingId: string;
  readonly onPendingChannelTeammateIdChange: (value: string) => void;
  readonly onAddSelectedChannelTeammate: () => void;
  readonly onRemoveChannelTeammate: (teammateId: string) => void | Promise<void>;
  readonly onOpenTeammates: () => void;
}

export function ChannelTeammateManagerPanel({
  cwd,
  selectedChannelId,
  channelTeammateMembershipsLoading,
  channelTeammates,
  localTeammates,
  availableChannelTeammates,
  pendingChannelTeammateId,
  channelTeammateSavingId,
  onPendingChannelTeammateIdChange,
  onAddSelectedChannelTeammate,
  onRemoveChannelTeammate,
  onOpenTeammates,
}: ChannelTeammateManagerPanelProps): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="channel-settings-card channel-teammate-manager" aria-label={t("Channel teammates")}>
      <div className="channel-settings-section-head">
        <div>
          <strong>{t("Current channel teammates")}</strong>
          <small>
            {channelTeammateMembershipsLoading
              ? t("Loading teammates...")
              : t("{count} teammates collaborate in this channel. Manage add and remove teammates here.", { count: channelTeammates.length })}
          </small>
        </div>
      </div>
      {channelTeammates.length === 0 ? (
        <div className="client-empty-state channel-teammate-empty">
          <MessageSquare size={18} />
          <span>{localTeammates.length === 0 ? t("Create a workspace teammate before assigning channel members.") : t("No teammates in this channel")}</span>
        </div>
      ) : (
        <div className="channel-teammate-list" role="list">
          {channelTeammates.map(({ teammate }) => {
            const saving = channelTeammateSavingId === teammate.id;
            return (
              <article key={teammate.id} className="channel-teammate-chip" role="listitem">
                <div
                  className="channel-teammate-chip-main"
                >
                  <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                  <strong>{teammate.displayName}</strong>
                </div>
                <button className="channel-teammate-remove-button" type="button" aria-label={t("Remove from channel")} title={t("Remove from channel")} onClick={() => void onRemoveChannelTeammate(teammate.id)} disabled={saving}>
                  {saving ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                </button>
              </article>
            );
          })}
        </div>
      )}
      <div className="channel-teammate-add-row">
        <label className="channel-teammate-select">
          <SelectControl
            aria-label={t("Add teammate")}
            value={pendingChannelTeammateId}
            disabled={!selectedChannelId || availableChannelTeammates.length === 0 || Boolean(channelTeammateSavingId)}
            onChange={(event) => onPendingChannelTeammateIdChange(event.target.value)}
          >
            <option value="">{availableChannelTeammates.length > 0 ? t("Select teammate to add") : t("No teammates available")}</option>
            {availableChannelTeammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
            ))}
          </SelectControl>
        </label>
        <button className="primary-button compact-button" type="button" onClick={onAddSelectedChannelTeammate} disabled={!pendingChannelTeammateId || Boolean(channelTeammateSavingId)}>
          {channelTeammateSavingId === pendingChannelTeammateId ? <Loader2 className="spin" size={14} /> : <UserPlus size={14} />}
          {t("Add")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={onOpenTeammates}>
          <Plus size={14} />
          {t("Open AI Teammates")}
        </button>
      </div>
    </section>
  );
}

export function ChannelSettingsPanels({
  cwd,
  selectedChannelId,
  channelNotificationLevel,
  onUpdateChannelNotificationLevel,
  channelTeammateMembershipsLoading,
  channelTeammates,
  localTeammates,
  availableChannelTeammates,
  pendingChannelTeammateId,
  channelTeammateSavingId,
  onPendingChannelTeammateIdChange,
  onAddSelectedChannelTeammate,
  onRemoveChannelTeammate,
  onOpenTeammates,
  aiCouncils,
  aiCouncilsLoading,
  aiCouncilHealthReport,
  channelCouncilPolicy,
  channelEffectiveCouncil,
  channelCouncilLoading,
  channelCouncilSaving,
  attachedAiCouncils,
  availableAiCouncils,
  projectedCouncilSpecialists,
  pendingChannelCouncilId,
  onPendingChannelCouncilIdChange,
  onAddSelectedChannelCouncil,
  onRemoveChannelCouncil,
  onSetPreferredChannelCouncil,
  onRefreshAiCouncils,
  onRefreshChannelCouncil,
  channelTeamMetricsPanel,
  channelEditForm,
  onChannelEditFormChange,
  onSaveChannelName,
  onChangeChannelWorkspacePath,
  providersLoading,
  providers,
  taskReadyProviders,
  setupChatProviders,
  selectedChannelWorkspace,
  selectedChannelExecutionPath,
  channelWorkspaceBusyAction,
  channelWorkspaceExternalPath,
  channelWorkspaceNotice,
  channelWorkspaceError,
  onChannelWorkspaceExternalPathChange,
  onCreateManagedChannelWorktree,
  onRefreshChannelWorkspace,
  onOpenChannelWorkspacePath,
  onHandoffChannelWorkspace,
}: {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelNotificationLevel: ChannelNotificationLevel;
  readonly onUpdateChannelNotificationLevel: (level: ChannelNotificationLevel) => void;
  readonly channelTeammateMembershipsLoading: boolean;
  readonly channelTeammates: readonly { readonly teammate: LocalTeammateDraft }[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly availableChannelTeammates: readonly LocalTeammateDraft[];
  readonly pendingChannelTeammateId: string;
  readonly channelTeammateSavingId: string;
  readonly onPendingChannelTeammateIdChange: (value: string) => void;
  readonly onAddSelectedChannelTeammate: () => void;
  readonly onRemoveChannelTeammate: (teammateId: string) => void | Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilsLoading: boolean;
  readonly aiCouncilHealthReport: AiCouncilHealthReport | undefined;
  readonly channelCouncilPolicy: ChannelCouncilPolicy | undefined;
  readonly channelEffectiveCouncil: EffectiveChannelCouncilProjection | undefined;
  readonly channelCouncilLoading: boolean;
  readonly channelCouncilSaving: boolean;
  readonly attachedAiCouncils: readonly AiCouncil[];
  readonly availableAiCouncils: readonly AiCouncil[];
  readonly projectedCouncilSpecialists: readonly EffectiveChannelCouncilProjection["specialists"][number][];
  readonly pendingChannelCouncilId: string;
  readonly onPendingChannelCouncilIdChange: (value: string) => void;
  readonly onAddSelectedChannelCouncil: () => void;
  readonly onRemoveChannelCouncil: (councilId: string) => void;
  readonly onSetPreferredChannelCouncil: (councilId: string) => void;
  readonly onRefreshAiCouncils: () => void;
  readonly onRefreshChannelCouncil: () => void;
  readonly channelTeamMetricsPanel: ReactNode;
  readonly channelEditForm: ChannelFormState;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onSaveChannelName: (name: string) => Promise<void>;
  readonly onChangeChannelWorkspacePath: (path: string) => Promise<void>;
  readonly providersLoading: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly selectedChannelWorkspace: ChannelWorkspaceBinding | undefined;
  readonly selectedChannelExecutionPath: string;
  readonly channelWorkspaceBusyAction: string;
  readonly channelWorkspaceExternalPath: string;
  readonly channelWorkspaceNotice: string;
  readonly channelWorkspaceError: string;
  readonly onChannelWorkspaceExternalPathChange: (value: string) => void;
  readonly onCreateManagedChannelWorktree: () => void;
  readonly onRefreshChannelWorkspace: () => void;
  readonly onOpenChannelWorkspacePath: () => void;
  readonly onHandoffChannelWorkspace: (mode: ChannelWorkspaceMode) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<ChannelSettingsSection>("general");

  useEffect(() => {
    setActiveSection("general");
  }, [selectedChannelId]);

  return (
    <div className="channel-settings-stack">
      <ChannelSettingsNavigation activeSection={activeSection} onChange={setActiveSection} />

      <div className="channel-settings-tab-content">
        {activeSection === "general" ? (
          <div
            id="channel-settings-panel-general"
            className="channel-settings-tab-panel channel-settings-general-panel"
            role="tabpanel"
            aria-labelledby="channel-settings-tab-general"
          >
            <ChannelSettingsGeneralPanel
              selectedChannelId={selectedChannelId}
              channelNotificationLevel={channelNotificationLevel}
              onUpdateChannelNotificationLevel={onUpdateChannelNotificationLevel}
              channelEditForm={channelEditForm}
              onChannelEditFormChange={onChannelEditFormChange}
              onSaveChannelName={onSaveChannelName}
              providersLoading={providersLoading}
              providers={providers}
              taskReadyProviders={taskReadyProviders}
              setupChatProviders={setupChatProviders}
            />
          </div>
        ) : null}

        {activeSection === "workspace" ? (
          <div
            id="channel-settings-panel-workspace"
            className="channel-settings-tab-panel channel-settings-workspace-panel"
            role="tabpanel"
            aria-labelledby="channel-settings-tab-workspace"
          >
            <ChannelSettingsWorkspacePanel
              cwd={cwd}
              selectedChannelId={selectedChannelId}
              channelEditForm={channelEditForm}
              onChannelEditFormChange={onChannelEditFormChange}
              onChangeChannelWorkspacePath={onChangeChannelWorkspacePath}
              selectedChannelWorkspace={selectedChannelWorkspace}
              selectedChannelExecutionPath={selectedChannelExecutionPath}
              channelWorkspaceBusyAction={channelWorkspaceBusyAction}
              channelWorkspaceExternalPath={channelWorkspaceExternalPath}
              channelWorkspaceNotice={channelWorkspaceNotice}
              channelWorkspaceError={channelWorkspaceError}
              onChannelWorkspaceExternalPathChange={onChannelWorkspaceExternalPathChange}
              onCreateManagedChannelWorktree={onCreateManagedChannelWorktree}
              onRefreshChannelWorkspace={onRefreshChannelWorkspace}
              onOpenChannelWorkspacePath={onOpenChannelWorkspacePath}
              onHandoffChannelWorkspace={onHandoffChannelWorkspace}
            />
          </div>
        ) : null}

        {activeSection === "members" ? (
          <div
            id="channel-settings-panel-members"
            className="channel-settings-tab-panel channel-settings-members-panel"
            role="tabpanel"
            aria-labelledby="channel-settings-tab-members"
          >
            <ChannelTeammateManagerPanel
              cwd={cwd}
              selectedChannelId={selectedChannelId}
              channelTeammateMembershipsLoading={channelTeammateMembershipsLoading}
              channelTeammates={channelTeammates}
              localTeammates={localTeammates}
              availableChannelTeammates={availableChannelTeammates}
              pendingChannelTeammateId={pendingChannelTeammateId}
              channelTeammateSavingId={channelTeammateSavingId}
              onPendingChannelTeammateIdChange={onPendingChannelTeammateIdChange}
              onAddSelectedChannelTeammate={onAddSelectedChannelTeammate}
              onRemoveChannelTeammate={onRemoveChannelTeammate}
              onOpenTeammates={onOpenTeammates}
            />
          </div>
        ) : null}

        {activeSection === "councils" ? (
          <div
            id="channel-settings-panel-councils"
            className="channel-settings-tab-panel channel-settings-councils-panel"
            role="tabpanel"
            aria-labelledby="channel-settings-tab-councils"
          >
            <section className="channel-settings-card channel-council-panel" aria-label={t("Channel AI councils")}>
              <div className="channel-settings-section-head">
                <span>
                  <UsersRound size={15} />
                  <strong>{t("Channel councils")}</strong>
                </span>
                <small>
                  {channelCouncilLoading || aiCouncilsLoading
                    ? t("Loading councils...")
                    : t("{count} council(s) attached", { count: attachedAiCouncils.length })}
                </small>
              </div>
              {attachedAiCouncils.length === 0 ? (
                <div className="client-empty-state channel-teammate-empty channel-council-empty">
                  <UsersRound size={18} />
                  <span>{aiCouncils.length === 0 ? t("No AI councils available") : t("No AI councils attached")}</span>
                </div>
              ) : (
                <div className="channel-council-list" role="list">
                  {attachedAiCouncils.map((council) => {
                    const preferred = channelCouncilPolicy?.preferredCouncilId === council.id;
                    const memberCount = channelEffectiveCouncil?.councils
                      .find((item) => item.council.id === council.id)
                      ?.members.filter((item) => item.enabled && item.teammate && !isLingAgentTeammate(item.teammate)).length ?? 0;
                    const capacityLabel = aiCouncilCapacityLabel(council, t);
                    const healthLabels = aiCouncilHealthLabels(aiCouncilHealthReport, council.id, t);
                    return (
                      <article key={council.id} className={preferred ? "channel-council-card preferred" : "channel-council-card"} role="listitem">
                        <div className="channel-council-card-main">
                          <span className="channel-council-icon" aria-hidden="true">
                            <UsersRound size={16} />
                          </span>
                          <span>
                            <strong>{council.displayName}</strong>
                            <small>{t("{count} projected specialist(s)", { count: memberCount })}</small>
                          </span>
                        </div>
                        <div className="context-packet muted" aria-label={t("Council boundaries")}>
                          <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
                          {capacityLabel ? <span>{capacityLabel}</span> : null}
                          {aiCouncilBoundaryLabels(council, t).map((label) => (
                            <span key={label}>{label}</span>
                          ))}
                        </div>
                        {healthLabels.length > 0 ? (
                          <div className="context-packet muted" aria-label={t("Council health")}>
                            {healthLabels.map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </div>
                        ) : null}
                        <div className="channel-council-actions">
                          <button className="secondary-button compact-button" type="button" onClick={() => onSetPreferredChannelCouncil(council.id)} disabled={preferred || channelCouncilSaving}>
                            {preferred ? <Check size={13} /> : <Pin size={13} />}
                            {preferred ? t("Preferred") : t("Prefer")}
                          </button>
                          <button className="icon-button compact-icon-button" type="button" aria-label={t("Detach council")} title={t("Detach council")} onClick={() => onRemoveChannelCouncil(council.id)} disabled={channelCouncilSaving}>
                            {channelCouncilSaving ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <div className="channel-teammate-add-row channel-council-add-row">
                <label className="channel-teammate-select">
                  <SelectControl
                    aria-label={t("Attach AI council")}
                    value={pendingChannelCouncilId}
                    disabled={!selectedChannelId || availableAiCouncils.length === 0 || channelCouncilSaving}
                    onChange={(event) => onPendingChannelCouncilIdChange(event.target.value)}
                  >
                    <option value="">{availableAiCouncils.length > 0 ? t("Select AI council") : t("No councils available")}</option>
                    {availableAiCouncils.map((council) => (
                      <option key={council.id} value={council.id}>{council.displayName}</option>
                    ))}
                  </SelectControl>
                </label>
                <button className="primary-button compact-button" type="button" onClick={onAddSelectedChannelCouncil} disabled={!pendingChannelCouncilId || channelCouncilSaving}>
                  {channelCouncilSaving ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                  {t("Attach")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => {
                  onRefreshAiCouncils();
                  onRefreshChannelCouncil();
                }} disabled={aiCouncilsLoading || channelCouncilLoading}>
                  {aiCouncilsLoading || channelCouncilLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Refresh")}
                </button>
              </div>
              {projectedCouncilSpecialists.length > 0 ? (
                <div className="channel-council-projection" aria-label={t("Projected council specialists")}>
                  <strong>{t("Projected specialists")}</strong>
                  <div className="channel-council-specialist-list" role="list">
                    {projectedCouncilSpecialists.map((specialist) => {
                      const councilSource = specialist.sources.find((source) => source.kind === "council");
                      const sourceDetails = [councilSource?.councilDisplayName ?? t("AI council"), councilSource?.label ?? councilSource?.slotKey].filter(Boolean).join(" · ");
                      return (
                        <article key={specialist.teammateId} className="channel-council-specialist" role="listitem">
                          <TeammateAvatarView teammate={specialist.teammate} cwd={cwd} compact />
                          <span>
                            <strong>{specialist.teammate.displayName}</strong>
                            <small>{sourceDetails}</small>
                          </span>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {activeSection === "health" ? (
          <div
            id="channel-settings-panel-health"
            className="channel-settings-tab-panel channel-settings-health-panel"
            role="tabpanel"
            aria-labelledby="channel-settings-tab-health"
          >
            {channelTeamMetricsPanel}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function isLingAgentTeammate(teammate: { readonly id: string; readonly systemRole?: string }): boolean {
  return teammate.id === "ling_agent" || teammate.systemRole === "ling_agent";
}
