import { Check, Pin, Plus, UsersRound, X } from "lucide-react";
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
  StatusIndicator,
} from "../../shared/ui/index.js";
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
  EffectiveChannelCouncilProjection,
} from "../../types.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";

export interface ChannelCouncilSettingsPanelProps {
  readonly cwd: string;
  readonly selectedChannelId: string;
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
}

export function ChannelCouncilSettingsPanel({
  cwd,
  selectedChannelId,
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
}: ChannelCouncilSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const loading = aiCouncilsLoading || channelCouncilLoading;
  return (
    <section className="channel-settings-surface channel-settings-card channel-council-panel" aria-label={t("Channel AI councils")}>
      <div className="channel-settings-section-head">
        <span>
          <UsersRound size={15} />
          <strong>{t("Channel councils")}</strong>
        </span>
        <StatusIndicator
          compact
          label={loading ? t("Loading") : t("{count} council(s) attached", { count: attachedAiCouncils.length })}
          tone="neutral"
        />
      </div>

      {loading && attachedAiCouncils.length === 0 ? (
        <div className="channel-settings-loading-list" aria-label={t("Loading councils...")}>
          <Skeleton height={56} shape="block" />
          <Skeleton height={56} shape="block" />
        </div>
      ) : attachedAiCouncils.length === 0 ? (
        <EmptyState
          className="channel-teammate-empty channel-council-empty"
          compact
          icon={<UsersRound size={18} />}
          title={aiCouncils.length === 0 ? t("No AI councils available") : t("No AI councils attached")}
        />
      ) : (
        <div className="channel-council-list" role="list">
          {attachedAiCouncils.map((council) => {
            const preferred = channelCouncilPolicy?.preferredCouncilId === council.id;
            const memberCount = channelEffectiveCouncil?.councils
              .find((item) => item.council.id === council.id)
              ?.members.filter((item) => item.enabled && item.teammate && !isLingAgentTeammate(item.teammate)).length ?? 0;
            const capacityLabel = aiCouncilCapacityLabel(council, t);
            const boundaryLabels = aiCouncilBoundaryLabels(council, t);
            const healthLabels = aiCouncilHealthLabels(aiCouncilHealthReport, council.id, t);
            return (
              <DataRow
                key={council.id}
                className={preferred ? "channel-council-card preferred" : "channel-council-card"}
                role="listitem"
                loading={channelCouncilSaving}
                identity={(
                  <span className="channel-council-card-main">
                    <span className="channel-council-icon" aria-hidden="true"><UsersRound size={16} /></span>
                    <span>
                      <strong>{council.displayName}</strong>
                      <small>{t("{count} projected specialist(s)", { count: memberCount })}</small>
                    </span>
                  </span>
                )}
                summary={(
                  <span className="channel-council-summary">
                    <span className="context-packet muted" aria-label={t("Council boundaries")}>
                      <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
                      {capacityLabel ? <span>{capacityLabel}</span> : null}
                      {boundaryLabels.map((label) => <span key={label}>{label}</span>)}
                    </span>
                    {healthLabels.length > 0 ? (
                      <InlineFeedback className="channel-council-health" tone="warning" aria-label={t("Council health")}>
                        {healthLabels.join(" · ")}
                      </InlineFeedback>
                    ) : null}
                  </span>
                )}
                status={preferred ? <StatusIndicator compact label={t("Preferred")} tone="info" /> : undefined}
                actions={(
                  <span className="channel-council-actions">
                    <Button
                      size="sm"
                      leadingIcon={preferred ? <Check size={13} /> : <Pin size={13} />}
                      onClick={() => onSetPreferredChannelCouncil(council.id)}
                      disabled={preferred || channelCouncilSaving}
                    >
                      {preferred ? t("Preferred") : t("Prefer")}
                    </Button>
                    <IconButton
                      icon={X}
                      label={t("Detach council")}
                      onClick={() => onRemoveChannelCouncil(council.id)}
                      disabled={channelCouncilSaving}
                      size="sm"
                    />
                  </span>
                )}
              />
            );
          })}
        </div>
      )}

      <div className="channel-teammate-add-row channel-council-add-row">
        <Field className="channel-teammate-select" label={t("Attach AI council")}>
          <Select
            aria-label={t("Attach AI council")}
            value={pendingChannelCouncilId}
            disabled={!selectedChannelId || availableAiCouncils.length === 0 || channelCouncilSaving}
            onChange={(event) => onPendingChannelCouncilIdChange(event.target.value)}
            size="sm"
          >
            <option value="">{availableAiCouncils.length > 0 ? t("Select AI council") : t("No councils available")}</option>
            {availableAiCouncils.map((council) => <option key={council.id} value={council.id}>{council.displayName}</option>)}
          </Select>
        </Field>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Plus size={14} />}
          loading={channelCouncilSaving}
          loadingLabel={t("Attach")}
          onClick={onAddSelectedChannelCouncil}
          disabled={!pendingChannelCouncilId || channelCouncilSaving}
        >
          {t("Attach")}
        </Button>
      </div>

      {projectedCouncilSpecialists.length > 0 ? (
        <section className="channel-council-projection" aria-label={t("Projected council specialists")}>
          <strong>{t("Projected specialists")}</strong>
          <div className="channel-council-specialist-list" role="list">
            {projectedCouncilSpecialists.map((specialist) => {
              const councilSource = specialist.sources.find((source) => source.kind === "council");
              const sourceDetails = [
                councilSource?.councilDisplayName ?? t("AI council"),
                councilSource?.label ?? councilSource?.slotKey,
              ].filter(Boolean).join(" · ");
              return (
                <DataRow
                  key={specialist.teammateId}
                  className="channel-council-specialist"
                  role="listitem"
                  compact
                  identity={(
                    <span className="channel-council-card-main">
                      <TeammateAvatarView teammate={specialist.teammate} cwd={cwd} compact />
                      <span><strong>{specialist.teammate.displayName}</strong><small>{sourceDetails}</small></span>
                    </span>
                  )}
                />
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
}

export function isLingAgentTeammate(teammate: { readonly id: string; readonly systemRole?: string }): boolean {
  return teammate.id === "ling_agent" || teammate.systemRole === "ling_agent";
}
