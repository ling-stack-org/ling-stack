import { Bell, BellOff, Box, Globe2, SquareTerminal, UserRound } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ChannelFormState, ProviderPreset } from "../../types.js";
import { ChannelNameField } from "./ChannelNameField.js";
import { ChannelExecutionModeSummary, ProviderPresetOptions } from "./WorkspaceControls.js";

export type ChannelNotificationLevel = "all" | "mentions" | "muted";

const channelNotificationLevels: readonly ChannelNotificationLevel[] = ["all", "mentions", "muted"];

export function ChannelSettingsGeneralPanel({
  selectedChannelId,
  channelNotificationLevel,
  onUpdateChannelNotificationLevel,
  channelEditForm,
  onChannelEditFormChange,
  onSaveChannelName,
  providersLoading,
  providers,
  taskReadyProviders,
  setupChatProviders,
}: {
  readonly selectedChannelId: string;
  readonly channelNotificationLevel: ChannelNotificationLevel;
  readonly onUpdateChannelNotificationLevel: (level: ChannelNotificationLevel) => void;
  readonly channelEditForm: ChannelFormState;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onSaveChannelName: (name: string) => Promise<void>;
  readonly providersLoading: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="channel-settings-general-grid">
      <section className="channel-settings-surface channel-settings-information" aria-label={t("Channel management")}>
        <div className="channel-settings-surface-heading">
          <strong>{t("Channel information")}</strong>
        </div>

        <div className="channel-settings-row-list">
          <div className="channel-settings-row channel-settings-control-row">
            <span className="channel-settings-row-icon" aria-hidden="true"><UserRound size={18} /></span>
            <ChannelNameField
              value={channelEditForm.name}
              disabled={!selectedChannelId}
              onSave={onSaveChannelName}
            />
          </div>

          <label className="channel-settings-row channel-settings-select-row">
            <span className="channel-settings-row-icon" aria-hidden="true"><Box size={18} /></span>
            <span className="channel-settings-row-label">{t("Channel run provider")}</span>
            <select
              aria-label={t("Channel run provider")}
              value={channelEditForm.defaultProviderPresetId}
              onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })}
              disabled={providersLoading || providers.length === 0 || !selectedChannelId}
            >
              <option value="">{t("Select provider preset")}</option>
              <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
            </select>
          </label>

          <label className="channel-settings-row channel-settings-select-row">
            <span className="channel-settings-row-icon" aria-hidden="true"><Globe2 size={18} /></span>
            <span className="channel-settings-row-label">{t("AI response language")}</span>
            <select
              aria-label={t("AI response language")}
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

          <div className="channel-settings-row channel-settings-runtime-row" aria-label={t("Channel runtime policy")}>
            <span className="channel-settings-row-icon" aria-hidden="true"><SquareTerminal size={18} /></span>
            <ChannelExecutionModeSummary />
          </div>
        </div>
      </section>

      <section className="channel-settings-surface channel-notification-panel" aria-label={t("Channel notifications")}>
        <div className="channel-settings-surface-heading">
          <strong>{t("Notifications")}</strong>
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
              {level === "muted" ? <BellOff size={15} /> : <Bell size={15} />}
              <strong>{t(channelNotificationLevelLabel(level))}</strong>
            </button>
          ))}
        </div>
        <p className="channel-notification-description">{t(channelNotificationLevelDescription(channelNotificationLevel))}</p>
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
