import type { ReactNode } from "react";
import {
  Bell,
  BellOff,
  Check,
  CircleAlert,
  Command,
  FileCheck2,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
  aiCouncilHealthLabels,
  aiCouncilRoutingModeLabel,
} from "../../lib/ai-councils.js";
import { StatusBadge } from "../../shared/components/index.js";
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
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

export type ChannelNotificationLevel = "all" | "mentions" | "muted";

const channelNotificationLevels: readonly ChannelNotificationLevel[] = ["all", "mentions", "muted"];

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
          <select
            aria-label={t("Add teammate")}
            value={pendingChannelTeammateId}
            disabled={!selectedChannelId || availableChannelTeammates.length === 0 || Boolean(channelTeammateSavingId)}
            onChange={(event) => onPendingChannelTeammateIdChange(event.target.value)}
          >
            <option value="">{availableChannelTeammates.length > 0 ? t("Select teammate to add") : t("No teammates available")}</option>
            {availableChannelTeammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
            ))}
          </select>
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
  channelsLoading,
  onRefreshChannels,
  onSaveChannel,
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
  readonly channelsLoading: boolean;
  readonly onRefreshChannels: () => void;
  readonly onSaveChannel: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="channel-settings-stack">
      <section className="channel-settings-card channel-notification-panel" aria-label={t("Channel notifications")}>
        <div className="channel-settings-section-head">
          <span>
            {channelNotificationLevel === "muted" ? <BellOff size={15} /> : <Bell size={15} />}
            <strong>{t("Notifications")}</strong>
          </span>
          <small>{t(channelNotificationLevelLabel(channelNotificationLevel))}</small>
        </div>
        <div className="channel-notification-options" role="radiogroup" aria-label={t("Channel notifications")}>
          {channelNotificationLevels.map((level) => (
            <button
              key={level}
              className={channelNotificationLevel === level ? "channel-notification-option active" : "channel-notification-option"}
              type="button"
              role="radio"
              aria-checked={channelNotificationLevel === level}
              onClick={() => onUpdateChannelNotificationLevel(level)}
            >
              <span>
                {level === "muted" ? <BellOff size={14} /> : <Bell size={14} />}
                <strong>{t(channelNotificationLevelLabel(level))}</strong>
              </span>
              <small>{t(channelNotificationLevelDescription(level))}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="channel-settings-card channel-council-panel" aria-label={t("Channel AI councils")}>
        <div className="channel-settings-section-head">
          <span>
            <UsersRound size={15} />
            <strong>{t("AI Councils")}</strong>
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
            <select
              aria-label={t("Attach AI council")}
              value={pendingChannelCouncilId}
              disabled={!selectedChannelId || availableAiCouncils.length === 0 || channelCouncilSaving}
              onChange={(event) => onPendingChannelCouncilIdChange(event.target.value)}
            >
              <option value="">{availableAiCouncils.length > 0 ? t("Select AI council") : t("No councils available")}</option>
              {availableAiCouncils.map((council) => (
                <option key={council.id} value={council.id}>{council.displayName}</option>
              ))}
            </select>
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

      {channelTeamMetricsPanel}

      <section className="channel-settings-card channel-management-panel" aria-label={t("Channel management")}>
        <div className="channel-settings-section-head">
          <span>
            <SlidersHorizontal size={15} />
            <strong>{t("Current channel")}</strong>
          </span>
          <small>{t("Provider, path, and runtime")}</small>
        </div>
        <div className="channel-options-grid">
          <label className="field wide">
            <span>{t("Run provider")}</span>
            <select value={channelEditForm.defaultProviderPresetId} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0 || !selectedChannelId}>
              <option value="">{t("Select provider preset")}</option>
              <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
            </select>
          </label>
          <label className="field wide">
            <span>{t("Name")}</span>
            <input value={channelEditForm.name} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, name: event.target.value })} disabled={!selectedChannelId} />
          </label>
          <label className="field wide">
            <span>{t("Execution path")}</span>
            <input value={channelEditForm.boundPath} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, boundPath: event.target.value })} disabled={!selectedChannelId} />
          </label>
          {selectedChannelWorkspace ? (
            <section className="channel-workspace-control field wide" aria-label={t("Channel workspace")}>
              <div className="channel-workspace-control-head">
                <span>
                  {channelWorkspaceModeIcon(selectedChannelWorkspace.mode, 15)}
                  <strong>{t("Workspace")}</strong>
                </span>
                <StatusBadge status={selectedChannelWorkspace.status === "ready" ? "done" : selectedChannelWorkspace.status === "missing" ? "blocked" : "todo"} />
              </div>
              <div className="channel-workspace-summary">
                <strong>{t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode))}</strong>
                <small title={selectedChannelExecutionPath}>{shortWorkspacePath(selectedChannelExecutionPath, cwd)}</small>
                {selectedChannelWorkspace.errorMessage ? <small className="danger-text">{selectedChannelWorkspace.errorMessage}</small> : null}
              </div>
              <div className="channel-workspace-actions">
                <button className="secondary-button compact-button" type="button" onClick={onCreateManagedChannelWorktree} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
                  {channelWorkspaceBusyAction === "create-worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                  {t("Create worktree")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={onRefreshChannelWorkspace} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
                  {channelWorkspaceBusyAction === "refresh" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Refresh status")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={onOpenChannelWorkspacePath} disabled={!selectedChannelExecutionPath}>
                  <FolderOpen size={14} />
                  {t("Open path")}
                </button>
              </div>
              <div className="channel-workspace-actions">
                <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("local")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || selectedChannelWorkspace.mode === "local"}>
                  {channelWorkspaceBusyAction === "handoff-local" ? <Loader2 className="spin" size={14} /> : <Command size={14} />}
                  {t("Hand off to Local")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("managed_worktree")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !selectedChannelWorkspace.worktreePath}>
                  {channelWorkspaceBusyAction === "handoff-managed_worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                  {t("Hand off to Worktree")}
                </button>
              </div>
              <div className="channel-workspace-external-row">
                <input
                  value={channelWorkspaceExternalPath}
                  onChange={(event) => onChannelWorkspaceExternalPathChange(event.target.value)}
                  placeholder={t("External workspace path")}
                  disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
                />
                <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("external_path")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !channelWorkspaceExternalPath.trim()}>
                  {channelWorkspaceBusyAction === "handoff-external_path" ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />}
                  {t("Hand off to External")}
                </button>
              </div>
              {channelWorkspaceNotice ? <div className="inline-success compact">{channelWorkspaceNotice}</div> : null}
              {channelWorkspaceError ? (
                <div className="inline-error compact">
                  <CircleAlert size={14} />
                  {channelWorkspaceError}
                </div>
              ) : null}
            </section>
          ) : null}
          <label className="field wide">
            <span>{t("AI response language")}</span>
            <select
              value={channelEditForm.responseLanguage}
              onChange={(event) => onChannelEditFormChange({ ...channelEditForm, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
              disabled={!selectedChannelId}
            >
              <option value="workspace">{t("Workspace default")}</option>
              <option value="follow_user">{t("Follow user message")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </select>
          </label>
          <ChannelRuntimePolicyFields form={channelEditForm} onChange={onChannelEditFormChange} />
          <div className="channel-option-actions">
            <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
              {channelsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh channels")}
            </button>
            <button className="primary-button compact-button" type="button" onClick={() => void onSaveChannel()} disabled={!selectedChannelId}>
              <FileCheck2 size={14} />
              {t("Save channel")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function channelNotificationLevelLabel(level: ChannelNotificationLevel): string {
  if (level === "all") {
    return "All activity";
  }
  if (level === "muted") {
    return "Muted";
  }
  return "Mentions and approvals";
}

function channelNotificationLevelDescription(level: ChannelNotificationLevel): string {
  if (level === "all") {
    return "Notify for messages, tasks, runs, files, and approvals.";
  }
  if (level === "muted") {
    return "Only critical approval blockers can surface.";
  }
  return "Notify for @mentions, approval requests, and blockers.";
}

export function channelWorkspaceModeLabel(mode: ChannelWorkspaceMode): string {
  if (mode === "managed_worktree") {
    return "Worktree";
  }
  if (mode === "external_path") {
    return "External";
  }
  return "Local";
}

export function channelWorkspaceModeIcon(mode: ChannelWorkspaceMode, size: number): JSX.Element {
  if (mode === "managed_worktree") {
    return <GitBranch size={size} />;
  }
  if (mode === "external_path") {
    return <FolderOpen size={size} />;
  }
  return <Command size={size} />;
}

export function shortWorkspacePath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  const workspace = cwd.trim().replace(/\/$/, "");
  if (workspace && trimmed === workspace) {
    return ".";
  }
  if (workspace && trimmed.startsWith(`${workspace}/`)) {
    return `.${trimmed.slice(workspace.length)}`;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return trimmed;
  }
  return `.../${parts.slice(-3).join("/")}`;
}

export function isLingAgentTeammate(teammate: { readonly id: string; readonly systemRole?: string }): boolean {
  return teammate.id === "ling_agent" || teammate.systemRole === "ling_agent";
}
