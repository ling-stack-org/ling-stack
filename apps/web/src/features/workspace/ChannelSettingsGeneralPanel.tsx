import { Box, Globe2, SquareTerminal, UserRound } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { SupportedLocaleOptions } from "../../i18n/SupportedLocaleOptions.js";
import {
  DataRow,
  Field,
  SegmentedControl,
  SegmentedControlItem,
  Select,
} from "../../shared/ui/index.js";
import type { ChannelNotificationLevel } from "../../lib/channel-notifications.js";
import type { ChannelFormState, ProviderPreset } from "../../types.js";
import { ChannelNameField } from "./ChannelNameField.js";
import { ChannelExecutionModeSummary, ProviderPresetOptions } from "./WorkspaceControls.js";

export type { ChannelNotificationLevel } from "../../lib/channel-notifications.js";

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
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="channel-settings-general-grid">
      <section className="channel-settings-surface channel-settings-information" aria-label={t("Channel management")}>
        <div className="channel-settings-surface-heading">
          <strong>{t("Channel information")}</strong>
        </div>

        <div className="channel-settings-row-list">
          <DataRow
            className="channel-settings-row channel-settings-control-row"
            identity={<span className="channel-settings-row-icon" aria-hidden="true"><UserRound size={18} /></span>}
            summary={(
              <ChannelNameField
                value={channelEditForm.name}
                disabled={!selectedChannelId}
                onSave={onSaveChannelName}
              />
            )}
          />

          <DataRow
            className="channel-settings-row channel-settings-select-row"
            identity={<span className="channel-settings-row-icon" aria-hidden="true"><Box size={18} /></span>}
            summary={(
              <Field label={t("Ling Agent model")}>
                <Select
                  aria-label={t("Ling Agent model")}
                  value={channelEditForm.defaultProviderPresetId}
                  onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })}
                  disabled={providersLoading || providers.length === 0 || !selectedChannelId}
                  loading={providersLoading}
                >
                  <option value="">{t("Select provider preset")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </Select>
              </Field>
            )}
          />

          <DataRow
            className="channel-settings-row channel-settings-select-row"
            identity={<span className="channel-settings-row-icon" aria-hidden="true"><Globe2 size={18} /></span>}
            summary={(
              <Field label={t("AI response language")}>
                <Select
                  aria-label={t("AI response language")}
                  value={channelEditForm.responseLanguage}
                  onChange={(event) => onChannelEditFormChange({ ...channelEditForm, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
                  disabled={!selectedChannelId}
                >
                  <option value="workspace">{t("Workspace default")}</option>
                  <option value="follow_user">{t("Follow user message")}</option>
                  <SupportedLocaleOptions />
                </Select>
              </Field>
            )}
          />

          <DataRow
            className="channel-settings-row channel-settings-runtime-row"
            aria-label={t("Channel runtime policy")}
            identity={<span className="channel-settings-row-icon" aria-hidden="true"><SquareTerminal size={18} /></span>}
            summary={<ChannelExecutionModeSummary />}
          />
        </div>
      </section>

      <section className="channel-settings-surface channel-notification-panel" aria-label={t("Channel notifications")}>
        <div className="channel-settings-surface-heading">
          <strong>{t("Notifications")}</strong>
        </div>
        <SegmentedControl
          className="channel-notification-options"
          aria-label={t("Channel notifications")}
          role="radiogroup"
          value={channelNotificationLevel}
          onValueChange={(value) => onUpdateChannelNotificationLevel(value as ChannelNotificationLevel)}
          size="sm"
        >
          {channelNotificationLevels.map((level) => {
            const label = t(channelNotificationLevelLabel(level));
            return (
              <SegmentedControlItem
                key={level}
                className="channel-notification-option"
                role="radio"
                aria-checked={channelNotificationLevel === level}
                title={label}
                value={level}
              >
                <strong>{label}</strong>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
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
