import { MessageSquare, Plus, UserPlus, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  EmptyState,
  Field,
  IconButton,
  InlineFeedback,
  Select,
  Skeleton,
} from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { isLingAgentTeammate } from "./ChannelCouncilSettingsPanel.js";

export interface ChannelTeammateManagerPanelProps {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly lingAgentModelLabel: string;
  readonly channelTeammateMembershipsLoading: boolean;
  readonly channelTeammates: readonly { readonly teammate: LocalTeammateDraft }[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly availableChannelTeammates: readonly LocalTeammateDraft[];
  readonly pendingChannelTeammateId: string;
  readonly channelTeammateSavingId: string;
  readonly channelTeammateError: ChannelTeammateRelationFeedback | undefined;
  readonly onPendingChannelTeammateIdChange: (value: string) => void;
  readonly onAddSelectedChannelTeammate: () => void;
  readonly onRemoveChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenTeammates: () => void;
}

export interface ChannelTeammateRelationFeedback {
  readonly action: "add" | "remove" | "set-default";
  readonly message: string;
}

export function ChannelTeammateManagerPanel({
  cwd,
  selectedChannelId,
  lingAgentModelLabel,
  channelTeammateMembershipsLoading,
  channelTeammates,
  localTeammates,
  availableChannelTeammates,
  pendingChannelTeammateId,
  channelTeammateSavingId,
  channelTeammateError,
  onPendingChannelTeammateIdChange,
  onAddSelectedChannelTeammate,
  onRemoveChannelTeammate,
  onOpenTeammates,
}: ChannelTeammateManagerPanelProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section className="channel-settings-surface channel-settings-card channel-teammate-manager" aria-label={t("Channel teammates")}>
      <div className="channel-settings-section-head">
        <div>
          <strong>{t("Current channel teammates")}</strong>
          <small>{t("{count} teammates", { count: channelTeammates.length })}</small>
        </div>
      </div>

      {channelTeammateError ? (
        <InlineFeedback
          data-channel-teammate-error={channelTeammateError.action}
          tone="danger"
          role="alert"
        >
          {channelTeammateError.message}
        </InlineFeedback>
      ) : null}

      {channelTeammateMembershipsLoading && channelTeammates.length === 0 ? (
        <div className="channel-settings-loading-list" aria-label={t("Loading teammates...")}>
          <Skeleton height={42} shape="block" />
          <Skeleton height={42} shape="block" />
        </div>
      ) : channelTeammates.length === 0 ? (
        <EmptyState
          className="channel-teammate-empty"
          compact
          icon={<MessageSquare size={18} />}
          title={localTeammates.length === 0
            ? t("Create a workspace teammate before assigning channel members.")
            : t("No teammates in this channel")}
        />
      ) : (
        <div className="channel-teammate-list" role="list">
          {channelTeammates.map(({ teammate }) => {
            const saving = channelTeammateSavingId === teammate.id;
            const lingAgent = isLingAgentTeammate(teammate);
            const followsWorkspaceDefault = !lingAgent && teammate.modelBindingMode === "workspace_default";
            const effectiveModelLabel = lingAgent
              ? lingAgentModelLabel || t("Unavailable")
              : t(teammate.modelLabel || "No model selected");
            const modelBinding = lingAgent ? "ling-agent" : followsWorkspaceDefault ? "workspace-default" : "fixed";
            return (
              <DataRow
                key={teammate.id}
                className="channel-teammate-chip"
                role="listitem"
                compact
                loading={saving}
                identity={(
                  <span className="channel-teammate-chip-main">
                    <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                    <strong>{teammate.displayName}</strong>
                  </span>
                )}
                summary={(
                  <span
                    className="channel-teammate-model-source"
                    data-teammate-model-binding={modelBinding}
                    title={effectiveModelLabel}
                  >
                    {lingAgent
                      ? t("Ling Agent model · {model}", { model: effectiveModelLabel })
                      : followsWorkspaceDefault
                        ? t("Workspace default · {model}", { model: effectiveModelLabel })
                        : t("Fixed model · {model}", { model: effectiveModelLabel })}
                  </span>
                )}
                actions={(
                  <IconButton
                    className="channel-teammate-remove-button"
                    icon={X}
                    label={t("Remove from channel")}
                    onClick={() => void onRemoveChannelTeammate(teammate.id).catch(() => undefined)}
                    disabled={saving}
                    size="sm"
                  />
                )}
              />
            );
          })}
        </div>
      )}

      <div className="channel-teammate-add-row">
        <Field className="channel-teammate-select" label={t("Add teammate")}>
          <Select
            aria-label={t("Add teammate")}
            value={pendingChannelTeammateId}
            disabled={!selectedChannelId || availableChannelTeammates.length === 0 || Boolean(channelTeammateSavingId)}
            onChange={(event) => onPendingChannelTeammateIdChange(event.target.value)}
            size="sm"
          >
            <option value="">{availableChannelTeammates.length > 0 ? t("Select teammate to add") : t("No teammates available")}</option>
            {availableChannelTeammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
            ))}
          </Select>
        </Field>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<UserPlus size={14} />}
          loading={channelTeammateSavingId === pendingChannelTeammateId && Boolean(pendingChannelTeammateId)}
          loadingLabel={t("Add")}
          onClick={onAddSelectedChannelTeammate}
          disabled={!pendingChannelTeammateId || Boolean(channelTeammateSavingId)}
        >
          {t("Add")}
        </Button>
        <Button size="sm" leadingIcon={<Plus size={14} />} onClick={onOpenTeammates}>
          {t("Open AI Teammates")}
        </Button>
      </div>
    </section>
  );
}
