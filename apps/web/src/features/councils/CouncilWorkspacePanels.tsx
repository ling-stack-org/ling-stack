import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  PauseCircle,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilHealthFilterLabel,
  aiCouncilHealthFilters,
  aiCouncilRoutingModeLabel,
  aiCouncilSourceLabel,
  type AiCouncilHealthFilter,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
  AiCouncilMember,
  AiTeammate,
  Channel,
  ChannelCouncilPolicy,
} from "../../types.js";
import {
  CreateDialogShell,
  DialogSection,
  OperationEmptyState,
  PageActionHeader,
} from "../../shared/components/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

type CouncilActionKind = "create" | "clone" | "archive" | "";
type CouncilDetailTab = "members" | "channels" | "settings";

export interface CouncilWorkspacePanelsProps {
  readonly cwd: string;
  readonly aiCouncilsLoading: boolean;
  readonly activeCouncils: readonly AiCouncil[];
  readonly filteredCouncils: readonly AiCouncil[];
  readonly selectedCouncil?: AiCouncil;
  readonly selectedCouncilId: string;
  readonly totalCouncilCount: number;
  readonly activeCouncilCount: number;
  readonly needsAttentionCount: number;
  readonly userCouncilCount: number;
  readonly councilHealthLabelById: ReadonlyMap<string, readonly string[]>;
  readonly councilHealthFilter: AiCouncilHealthFilter;
  readonly onCouncilHealthFilterChange: (filter: AiCouncilHealthFilter) => void;
  readonly onSelectCouncil: (councilId: string) => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onOpenAiTeammates: () => void;
  readonly settingsToolMode?: boolean;

  readonly createCouncilOpen: boolean;
  readonly onCreateCouncilOpenChange: (open: boolean) => void;
  readonly newCouncilName: string;
  readonly newCouncilDescription: string;
  readonly onNewCouncilNameChange: (value: string) => void;
  readonly onNewCouncilDescriptionChange: (value: string) => void;
  readonly canCreateCouncil: boolean;
  readonly actionSaving: CouncilActionKind;
  readonly actionError: string;
  readonly onCreateCouncil: () => void | Promise<void>;
  readonly onCloneCouncil: () => void | Promise<void>;
  readonly onArchiveCouncil: () => void | Promise<void>;
  readonly canCloneCouncil: boolean;
  readonly canArchiveCouncil: boolean;

  readonly selectedHealthLabels: readonly string[];
  readonly selectedHealthFindings: readonly string[];
  readonly selectedBoundaryLabels: readonly string[];
  readonly selectedCapacityLabel?: string;
  readonly members: readonly AiCouncilMember[];
  readonly membersLoading: boolean;
  readonly membersSaving: boolean;
  readonly membersError: string;
  readonly availableTeammates: readonly AiTeammate[];
  readonly teammateById: ReadonlyMap<string, AiTeammate>;
  readonly pendingTeammateId: string;
  readonly onPendingTeammateChange: (teammateId: string) => void;
  readonly onAddMember: () => void;
  readonly onRemoveMember: (teammateId: string) => void;
  readonly onToggleMember: (teammateId: string) => void;
  readonly onMoveMember: (teammateId: string, delta: -1 | 1) => void;

  readonly settingsName: string;
  readonly settingsDescription: string;
  readonly settingsPinned: boolean;
  readonly settingsSaving: "save" | "status" | "";
  readonly settingsError: string;
  readonly canEditSelectedCouncil: boolean;
  readonly canSaveCouncilSettings: boolean;
  readonly canToggleCouncilStatus: boolean;
  readonly onSettingsNameChange: (value: string) => void;
  readonly onSettingsDescriptionChange: (value: string) => void;
  readonly onSettingsPinnedChange: (value: boolean) => void;
  readonly onSaveCouncilSettings: () => void | Promise<void>;
  readonly onToggleCouncilStatus: () => void | Promise<void>;

  readonly visibleChannels: readonly Channel[];
  readonly selectedChannel?: Channel;
  readonly selectedChannelId: string;
  readonly onSelectedChannelChange: (channelId: string) => void;
  readonly channelPolicy?: ChannelCouncilPolicy;
  readonly channelPolicyLoading: boolean;
  readonly channelPolicySaving: boolean;
  readonly channelPolicyError: string;
  readonly attachedCouncils: readonly AiCouncil[];
  readonly selectedCouncilAttached: boolean;
  readonly canAttachSelectedCouncil: boolean;
  readonly onAttachSelectedCouncilToChannel: () => void;
  readonly onSetPreferredChannelCouncil: (councilId: string) => void;
  readonly onDetachChannelCouncil: (councilId: string) => void;
  readonly onOpenChannel: (channelId: string) => void;
}

export function CouncilWorkspacePanels(props: CouncilWorkspacePanelsProps): JSX.Element {
  const { t } = useI18n();
  const selectedCouncil = props.selectedCouncil;
  const mutationDisabled = props.membersSaving || Boolean(props.actionSaving) || Boolean(props.settingsSaving) || props.aiCouncilsLoading;
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
          meta={<CouncilWorkspaceSummary {...props} />}
          primaryAction={(
            <button className="primary-button compact-button" type="button" onClick={() => props.onCreateCouncilOpenChange(true)}>
              <Plus size={14} />
              {t("Create council")}
            </button>
          )}
          secondaryActions={(
            <>
              <button className="secondary-button compact-button" type="button" onClick={() => void props.onRefresh()} aria-label={t("Refresh councils")}>
                <span>{t("Refresh")}</span>
              </button>
              <button className="secondary-button compact-button" type="button" onClick={props.onOpenAiTeammates} aria-label={t("Open AI Teammates")}>
                <span>{t("Open AI Teammates")}</span>
              </button>
            </>
          )}
          className="council-workspace-header"
        />
      ) : null}

      <div className="council-workspace-grid">
        <section className="council-workspace-list" aria-label={t("AI Councils")}>
          <div className="council-panel-title">
            <strong>{t("AI Councils")}</strong>
            <span className="council-panel-title-actions">
              {props.aiCouncilsLoading ? <small>{t("Loading")}</small> : <small>{t("{count} council(s)", { count: props.filteredCouncils.length })}</small>}
              <button
                className="icon-button compact-icon-button"
                type="button"
                onClick={() => void props.onRefresh()}
                aria-label={t("Refresh councils")}
                title={t("Refresh councils")}
                disabled={props.aiCouncilsLoading}
              >
                <RefreshCw size={14} />
              </button>
            </span>
          </div>

          {props.settingsToolMode ? <CouncilWorkspaceSummary {...props} compact /> : null}

          <div className="council-list-toolbar">
            <label className="field council-filter-field">
              <SelectControl
              variant="compact"
                aria-label={t("Filter councils by health")}
                value={props.councilHealthFilter}
                onChange={(event) => props.onCouncilHealthFilterChange(event.target.value as AiCouncilHealthFilter)}
                disabled={props.aiCouncilsLoading || props.membersSaving}
              >
                {aiCouncilHealthFilters.map((filter) => (
                  <option key={filter} value={filter}>{aiCouncilHealthFilterLabel(filter, t)}</option>
                ))}
              </SelectControl>
            </label>
            <button className="secondary-button compact-button" type="button" onClick={() => props.onCreateCouncilOpenChange(!props.createCouncilOpen)}>
              <Plus size={14} />
              {t("Create council")}
            </button>
          </div>

          {props.createCouncilOpen ? (
            <CouncilCreateDialog
              newCouncilName={props.newCouncilName}
              newCouncilDescription={props.newCouncilDescription}
              mutationDisabled={mutationDisabled}
              canCreateCouncil={props.canCreateCouncil}
              actionSaving={props.actionSaving}
              actionError={props.actionError}
              onNameChange={props.onNewCouncilNameChange}
              onDescriptionChange={props.onNewCouncilDescriptionChange}
              onClose={() => props.onCreateCouncilOpenChange(false)}
              onCreate={props.onCreateCouncil}
            />
          ) : null}

          {props.activeCouncils.length === 0 ? (
            <OperationEmptyState compact title={t("No councils available")} description={t("Create a council to group teammates for shared channel work.")} />
          ) : props.filteredCouncils.length === 0 ? (
            <OperationEmptyState compact title={t("No councils match this health filter")} description={t("Try another health filter to inspect other councils.")} />
          ) : (
            <div className="council-list-stack">
              {props.filteredCouncils.map((council) => (
                <button
                  key={council.id}
                  className={council.id === props.selectedCouncilId ? "council-list-row selected" : "council-list-row"}
                  type="button"
                  onClick={() => props.onSelectCouncil(council.id)}
                >
                  <span className="council-row-main">
                    <strong>{council.displayName}</strong>
                  </span>
                  <span className="council-row-meta">
                    <span className="council-row-health"><i aria-hidden="true" />{props.councilHealthLabelById.get(council.id)?.[0] ?? t("Health pending")}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="council-workspace-detail" aria-label={t("Selected council")}>
          {selectedCouncil ? (
            <>
              <CouncilDetailHeader
                council={selectedCouncil}
                selectedCapacityLabel={props.selectedCapacityLabel}
                selectedBoundaryLabels={props.selectedBoundaryLabels}
              />
              <CouncilHealthStrip healthLabels={props.selectedHealthLabels} findings={props.selectedHealthFindings} />
              <CouncilDetailTabs activeTab={activeDetailTab} onChange={setActiveDetailTab} />
              <div className="council-detail-body">
                {activeDetailTab === "members" ? <CouncilMembersPanel {...props} mutationDisabled={mutationDisabled} /> : null}
                {activeDetailTab === "channels" ? <CouncilChannelPanel {...props} /> : null}
                {activeDetailTab === "settings" ? <CouncilSettingsPanel {...props} mutationDisabled={mutationDisabled} /> : null}
              </div>
            </>
          ) : (
            <OperationEmptyState compact title={t("No council selected")} description={t("Select a council to manage members, channels, and settings.")} />
          )}
        </section>
      </div>
    </div>
  );
}

function CouncilWorkspaceSummary({
  totalCouncilCount,
  activeCouncilCount,
  needsAttentionCount,
  userCouncilCount,
  compact = false,
}: Pick<CouncilWorkspacePanelsProps, "totalCouncilCount" | "activeCouncilCount" | "needsAttentionCount" | "userCouncilCount"> & {
  readonly compact?: boolean;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className={compact ? "council-workspace-summary compact" : "council-workspace-summary"} aria-label={t("Council summary")}>
      <span>{t("{count} council(s)", { count: totalCouncilCount })}</span>
      <span>{t("{count} active", { count: activeCouncilCount })}</span>
      <span>{t("{count} need attention", { count: needsAttentionCount })}</span>
      <span>{t("{count} custom", { count: userCouncilCount })}</span>
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
}): JSX.Element {
  const { t } = useI18n();
  const visibleBoundaryLabels = selectedBoundaryLabels.slice(0, selectedCapacityLabel ? 1 : 2);

  return (
    <div className="council-detail-head">
      <div>
        <strong>{council.displayName}</strong>
      </div>
      <span className={`status-badge ${council.status}`}>{council.status}</span>
      <div className="council-chip-row" aria-label={t("Council boundaries")}>
        <span>{aiCouncilSourceLabel(council.source, t)}</span>
        <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
        {selectedCapacityLabel ? <span>{selectedCapacityLabel}</span> : null}
        {visibleBoundaryLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

function CouncilCreateDialog({
  newCouncilName,
  newCouncilDescription,
  mutationDisabled,
  canCreateCouncil,
  actionSaving,
  actionError,
  onNameChange,
  onDescriptionChange,
  onClose,
  onCreate,
}: {
  readonly newCouncilName: string;
  readonly newCouncilDescription: string;
  readonly mutationDisabled: boolean;
  readonly canCreateCouncil: boolean;
  readonly actionSaving: CouncilActionKind;
  readonly actionError: string;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onCreate: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <CreateDialogShell
      ariaLabel={t("Create council")}
      title={t("Create council")}
      description={t("Name the council first. Members and channel usage can be adjusted after creation.")}
      onClose={onClose}
      closeLabel={t("Cancel")}
      footer={(
        <>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!canCreateCouncil}
            onClick={() => void onCreate()}
          >
            {actionSaving === "create" ? t("Creating council...") : t("Create council")}
          </button>
        </>
      )}
    >
      <DialogSection title={t("Basic information")} description={t("Keep it short and easy to recognize in channel settings.")}>
        <label className="field">
          <span>{t("New council name")}</span>
          <input
            aria-label={t("New council name")}
            value={newCouncilName}
            onChange={(event) => onNameChange(event.target.value)}
            disabled={mutationDisabled}
          />
        </label>
        <label className="field">
          <span>{t("New council description")}</span>
          <input
            aria-label={t("New council description")}
            value={newCouncilDescription}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder={t("Optional council description")}
            disabled={mutationDisabled}
          />
        </label>
      </DialogSection>
      {actionSaving === "create" && actionError ? <p className="inline-error">{actionError}</p> : null}
    </CreateDialogShell>
  );
}

function CouncilHealthStrip({
  healthLabels,
  findings,
}: {
  readonly healthLabels: readonly string[];
  readonly findings: readonly string[];
}): JSX.Element {
  const { t } = useI18n();
  const summary = healthLabels.length > 0 ? healthLabels.join(" / ") : t("Health pending");

  return (
    <div className={findings.length > 0 ? "council-health-strip warning" : "council-health-strip"} aria-label={t("Council health")}>
      <span>{summary}</span>
      {findings.length > 0 ? <small>{findings[0]}{findings.length > 1 ? `, +${findings.length - 1}` : ""}</small> : <small>{t("No health findings")}</small>}
    </div>
  );
}

function CouncilDetailTabs({
  activeTab,
  onChange,
}: {
  readonly activeTab: CouncilDetailTab;
  readonly onChange: (tab: CouncilDetailTab) => void;
}): JSX.Element {
  const { t } = useI18n();
  const tabs: readonly { readonly id: CouncilDetailTab; readonly label: string }[] = [
    { id: "members", label: t("Council members") },
    { id: "channels", label: t("Channel usage") },
    { id: "settings", label: t("Council settings") },
  ];

  return (
    <div className="council-detail-tabs" role="tablist" aria-label={t("Council detail sections")}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? "selected" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function CouncilMembersPanel(props: CouncilWorkspacePanelsProps & { readonly mutationDisabled: boolean }): JSX.Element {
  const { t } = useI18n();

  return (
    <section aria-label={t("Council members")} className="council-detail-section council-members-panel">
      <div className="council-panel-title">
        <strong>{t("Council members")}</strong>
        <span className="council-panel-title-actions">
          <small>{props.membersLoading ? t("Loading council members...") : t("{count} enabled members", { count: props.members.filter((member) => member.enabled).length })}</small>
          <button className="secondary-button compact-button" type="button" onClick={props.onOpenAiTeammates}>
            <ArrowRight size={14} />
            {t("Manage teammates")}
          </button>
        </span>
      </div>
      {props.membersError ? <p className="inline-error">{props.membersError}</p> : null}
      {props.availableTeammates.length === 0 ? (
        <OperationEmptyState compact className="council-member-add-empty" title={t("No teammates available to add")} description={t("Create or unhide teammates before adding them to this council.")} />
      ) : (
        <div className="council-member-add-row">
          <SelectControl
              variant="compact"
            aria-label={t("Add teammate to council")}
            value={props.pendingTeammateId}
            onChange={(event) => props.onPendingTeammateChange(event.target.value)}
            disabled={props.membersLoading || props.membersSaving}
          >
            <option value="">{t("Select teammate")}</option>
            {props.availableTeammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
            ))}
          </SelectControl>
          <button className="secondary-button compact-button" type="button" onClick={props.onAddMember} disabled={!props.pendingTeammateId || props.membersLoading || props.membersSaving}>
            <Plus size={14} />
            {t("Add member")}
          </button>
        </div>
      )}
      {props.membersLoading ? (
        <OperationEmptyState compact title={t("Loading council members...")} />
      ) : props.members.length === 0 ? (
        <OperationEmptyState compact title={t("No council members")} description={t("Add teammates to make this council useful in channel work.")} />
      ) : (
        <div className="council-member-list">
          {props.members.map((member, memberIndex) => {
            const teammate = props.teammateById.get(member.teammateId);
            const displayName = teammate?.displayName ?? member.teammateId;
            const subtitle = councilMemberSubtitle(displayName, member.label ?? member.slotKey ?? t("Member unavailable"));
            return (
              <div key={`${member.councilId}:${member.teammateId}:${member.position}`} className={member.enabled ? "council-member-row" : "council-member-row disabled has-status"}>
                <TeammateAvatarView teammate={teammate ?? { displayName }} cwd={props.cwd} compact />
                <span>
                  <strong>{displayName}</strong>
                  {subtitle ? <small>{subtitle}</small> : null}
                </span>
                {member.enabled ? null : <span className="teammate-council-status disabled">{t("Disabled")}</span>}
                <span className="council-member-actions">
                  <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member up")} title={t("Move council member up")} onClick={() => props.onMoveMember(member.teammateId, -1)} disabled={memberIndex <= 0 || props.membersSaving}>
                    <ArrowUp size={13} />
                  </button>
                  <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member down")} title={t("Move council member down")} onClick={() => props.onMoveMember(member.teammateId, 1)} disabled={memberIndex === props.members.length - 1 || props.membersSaving}>
                    <ArrowDown size={13} />
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => props.onToggleMember(member.teammateId)} disabled={props.membersSaving}>
                    {member.enabled ? t("Disable") : t("Enable")}
                  </button>
                  <button className="icon-button compact-icon-button" type="button" aria-label={t("Remove council member")} title={t("Remove council member")} onClick={() => props.onRemoveMember(member.teammateId)} disabled={props.membersSaving}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CouncilChannelPanel(props: CouncilWorkspacePanelsProps): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="council-detail-section council-workspace-channels" aria-label={t("Channel usage")}>
      <div className="council-panel-title">
        <strong>{t("Channel usage")}</strong>
        <small>
          {props.channelPolicyLoading
            ? t("Loading councils...")
            : t("{count} council(s) attached", { count: props.attachedCouncils.length })}
        </small>
      </div>
      {props.visibleChannels.length === 0 ? (
        <div className="council-channel-empty">
          <OperationEmptyState compact title={t("No channels available")} description={t("Create a channel before attaching councils to channel work.")} />
        </div>
      ) : (
        <div className="council-channel-policy">
          <label className="field council-channel-select-field">
            <span>{t("Selected channel")}</span>
            <SelectControl
              aria-label={t("Select channel for council")}
              value={props.selectedChannel?.id ?? props.selectedChannelId}
              onChange={(event) => props.onSelectedChannelChange(event.target.value)}
              disabled={props.channelPolicyLoading || props.channelPolicySaving}
            >
              {props.visibleChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
            </SelectControl>
          </label>

          {props.channelPolicyError ? <p className="inline-error">{props.channelPolicyError}</p> : null}

          <div className="council-channel-policy-actions">
            <button className="primary-button compact-button" type="button" onClick={props.onAttachSelectedCouncilToChannel} disabled={!props.canAttachSelectedCouncil}>
              <Plus size={14} />
              {props.selectedCouncilAttached ? t("Selected council attached") : t("Attach selected council")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => props.selectedChannel ? props.onOpenChannel(props.selectedChannel.id) : undefined} disabled={!props.selectedChannel}>
              <ArrowRight size={14} />
              {t("Open channel in app")}
            </button>
          </div>

          {props.attachedCouncils.length === 0 ? (
            <div className="council-channel-empty">
              <OperationEmptyState compact title={t("No AI councils attached")} description={t("Attach the selected council when this channel should use it.")} />
            </div>
          ) : (
            <div className="council-channel-list" role="list" aria-label={t("Attached councils")}>
              {props.attachedCouncils.map((council) => {
                const preferred = props.channelPolicy?.preferredCouncilId === council.id;
                return (
                  <article key={council.id} className={preferred ? "council-channel-row preferred" : "council-channel-row"} role="listitem">
                    <span>
                      <strong>{council.displayName}</strong>
                      <small>{preferred ? t("Preferred") : aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</small>
                    </span>
                    <span className="council-channel-row-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => props.onSetPreferredChannelCouncil(council.id)} disabled={preferred || props.channelPolicySaving}>
                        {preferred ? t("Preferred") : t("Prefer")}
                      </button>
                      <button className="icon-button compact-icon-button" type="button" aria-label={t("Detach council")} title={t("Detach council")} onClick={() => props.onDetachChannelCouncil(council.id)} disabled={props.channelPolicySaving}>
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CouncilSettingsPanel(props: CouncilWorkspacePanelsProps & { readonly mutationDisabled: boolean }): JSX.Element {
  const { t } = useI18n();
  const selectedCouncil = props.selectedCouncil;

  return (
    <section className="council-detail-section council-workspace-settings" aria-label={t("Council settings")}>
      <div className="council-panel-title">
        <strong>{t("Council settings")}</strong>
        <small>{selectedCouncil ? aiCouncilSourceLabel(selectedCouncil.source, t) : t("Select a council")}</small>
      </div>
      <div className="council-settings-fields">
        {selectedCouncil ? (
          <details className="settings-compact-details council-settings-boundary-details">
            <summary>{t("Council boundaries")}</summary>
            <div className="council-settings-summary" aria-label={t("Council boundaries")}>
              <span>{aiCouncilSourceLabel(selectedCouncil.source, t)}</span>
              <span>{aiCouncilRoutingModeLabel(selectedCouncil.routingPolicy.defaultMode, t)}</span>
              {props.selectedCapacityLabel ? <span>{props.selectedCapacityLabel}</span> : null}
              {props.selectedBoundaryLabels.map((label) => <span key={label}>{label}</span>)}
            </div>
          </details>
        ) : null}
        <label className="field">
          <span>{t("Council name")}</span>
          <input
            aria-label={t("Council name")}
            value={props.settingsName}
            onChange={(event) => props.onSettingsNameChange(event.target.value)}
            disabled={!props.canEditSelectedCouncil || props.mutationDisabled}
          />
        </label>
        <label className="field council-settings-description-field">
          <span>{t("Council description")}</span>
          <textarea
            aria-label={t("Council description")}
            value={props.settingsDescription}
            onChange={(event) => props.onSettingsDescriptionChange(event.target.value)}
            disabled={!props.canEditSelectedCouncil || props.mutationDisabled}
          />
        </label>
        <label className="council-settings-toggle">
          <input
            type="checkbox"
            checked={props.settingsPinned}
            onChange={(event) => props.onSettingsPinnedChange(event.target.checked)}
            disabled={!props.canEditSelectedCouncil || props.mutationDisabled}
          />
          <span>
            <Pin size={14} />
            {t("Pin council")}
          </span>
        </label>
      </div>
      <div className="council-settings-actions">
        <button className="primary-button compact-button" type="button" onClick={() => void props.onSaveCouncilSettings()} disabled={!props.canSaveCouncilSettings}>
          <Save size={14} />
          {props.settingsSaving === "save" ? t("Saving settings...") : t("Save council settings")}
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => void props.onToggleCouncilStatus()}
          disabled={!props.canToggleCouncilStatus}
          title={props.canEditSelectedCouncil ? (selectedCouncil?.status === "paused" ? t("Resume council") : t("Pause council")) : t("Built-in councils must be cloned before editing")}
        >
          {selectedCouncil?.status === "paused" ? <Play size={14} /> : <PauseCircle size={14} />}
          {props.settingsSaving === "status"
            ? (selectedCouncil?.status === "paused" ? t("Resuming council...") : t("Pausing council..."))
            : (selectedCouncil?.status === "paused" ? t("Resume council") : t("Pause council"))}
        </button>
      </div>
      {props.settingsError ? <p className="inline-error">{props.settingsError}</p> : null}
      <details className="settings-compact-details council-low-frequency-actions">
        <summary>{t("More council actions")}</summary>
        <div className="council-action-row" aria-label={t("Council actions")}>
          <button className="secondary-button compact-button" type="button" onClick={() => void props.onCloneCouncil()} disabled={!props.canCloneCouncil}>
            <Copy size={14} />
            {props.actionSaving === "clone" ? t("Cloning council...") : t("Clone council")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => void props.onArchiveCouncil()}
            disabled={!props.canArchiveCouncil}
            title={selectedCouncil?.source === "user" ? t("Archive council") : t("Clone built-in councils before editing")}
          >
            <Archive size={14} />
            {props.actionSaving === "archive" ? t("Archiving council...") : t("Archive council")}
          </button>
        </div>
      </details>
      {props.actionSaving !== "create" && props.actionError ? <p className="inline-error">{props.actionError}</p> : null}
    </section>
  );
}

function councilMemberSubtitle(displayName: string, label: string): string {
  return displayName.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase() ? "" : label;
}
