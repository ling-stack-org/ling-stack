import { ArrowRight, Hash, Link2, RefreshCw, Star, Unlink } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { aiCouncilSourceLabel } from "../../lib/ai-councils.js";
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
import type { CouncilChannelRelationshipRow } from "./council-channels-view-model.js";
import type { CouncilChannelsController } from "./useCouncilChannelsController.js";

export function CouncilChannelsPanel({
  controller,
}: {
  readonly controller: CouncilChannelsController;
}): JSX.Element {
  const { t } = useI18n();
  const selectedCouncilId = controller.selectedCouncilId;

  return (
    <section
      className="council-channels-panel"
      data-ui2-council-channels="true"
      aria-label={t("Channel usage")}
    >
      <header className="council-channels-heading">
        <div className="council-channels-heading-copy">
          <Hash aria-hidden="true" />
          <strong>{t("Channel usage")}</strong>
        </div>
        <span className="council-channels-heading-actions">
          <StatusIndicator
            label={controller.loading
              ? t("Loading councils")
              : t("{count} council(s) attached", { count: controller.rows.length })}
            tone={controller.loadError ? (controller.stale ? "warning" : "danger") : "neutral"}
          />
          <IconButton
            disabled={!controller.selectedChannel || controller.loading}
            icon={RefreshCw}
            label={t("Refresh")}
            loading={controller.refreshing}
            onClick={() => void controller.refresh("refresh")}
          />
        </span>
      </header>

      {controller.catalog.length === 0 ? (
        <EmptyState
          compact
          className="council-channels-empty"
          icon={<Hash />}
          title={t("No channels available")}
          description={t("Create a channel before attaching councils to channel work.")}
        />
      ) : (
        <>
          <div className="council-channels-toolbar">
            <Field label={t("Selected channel")}>
              <Select
                aria-label={t("Select channel for council")}
                value={controller.selectedChannelId}
                onChange={(event) => controller.selectChannel(event.target.value)}
              >
                {controller.catalog.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.status === "active" ? channel.name : `${channel.name} (${t(channel.status)})`}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="council-channels-selected-status">
              {controller.selectedChannel ? (
                <StatusIndicator
                  label={t(controller.selectedChannel.status)}
                  tone={controller.selectedChannel.status === "active" ? "neutral" : "warning"}
                />
              ) : null}
              <Button
                disabled={!controller.canOpenSelectedChannel}
                leadingIcon={<ArrowRight />}
                onClick={() => void controller.openSelectedChannel()}
                size="sm"
                title={controller.restrictionLabelKey ? t(controller.restrictionLabelKey) : t("Open channel in app")}
                variant="secondary"
              >
                {t("Open channel in app")}
              </Button>
            </span>
          </div>

          {controller.restrictionLabelKey ? (
            <InlineFeedback className="council-channels-restriction" tone="warning">
              {t(controller.restrictionLabelKey)}
            </InlineFeedback>
          ) : null}

          {controller.loadError ? (
            <div className="council-channels-load-error">
              <InlineFeedback tone={controller.stale ? "warning" : "danger"}>{controller.loadError}</InlineFeedback>
              <Button
                loading={controller.refreshing}
                onClick={() => void controller.refresh("refresh")}
                size="sm"
                variant="secondary"
              >
                {t("Retry")}
              </Button>
            </div>
          ) : null}

          {controller.loading && !controller.policy ? (
            <div className="council-channels-loading" aria-label={t("Loading councils")}>
              <Skeleton height={52} />
              <Skeleton height={52} />
              <Skeleton height={52} />
              <Skeleton height={52} />
            </div>
          ) : controller.loadError && !controller.stale ? null : (
            <>
              <div className="council-channels-attach-surface" data-council-id={selectedCouncilId}>
                <span className="council-channels-attach-copy">
                  <Link2 aria-hidden="true" />
                  <span>
                    <strong>{t("Attach selected council")}</strong>
                    <small title={controller.selectedCouncilName}>{controller.selectedCouncilName}</small>
                  </span>
                </span>
                <Button
                  disabled={!controller.canAttachSelectedCouncil}
                  leadingIcon={<Link2 />}
                  loading={controller.attachBusy}
                  loadingLabel={t("Saving...")}
                  onClick={() => void controller.attachSelectedCouncil()}
                  size="sm"
                  title={controller.restrictionLabelKey
                    ? t(controller.restrictionLabelKey)
                    : controller.selectedCouncilAttached
                      ? t("Selected council attached")
                      : t("Attach selected council")}
                  variant="primary"
                >
                  {controller.selectedCouncilAttached ? t("Selected council attached") : t("Attach selected council")}
                </Button>
                {selectedCouncilId && controller.rowErrors[selectedCouncilId] ? (
                  <InlineFeedback className="council-channels-row-error" tone="danger">
                    {controller.rowErrors[selectedCouncilId]}
                  </InlineFeedback>
                ) : null}
              </div>

              {controller.rows.length === 0 ? (
                <EmptyState
                  compact
                  className="council-channels-empty"
                  icon={<Link2 />}
                  title={t("No AI councils attached")}
                  description={t("Attach the selected council when this channel should use it.")}
                />
              ) : (
                <div
                  className="council-channels-list"
                  data-ui2-council-channels-list="true"
                  role="list"
                  aria-label={t("Attached councils")}
                >
                  {controller.rows.map((row) => (
                    <CouncilChannelRow key={row.councilId} controller={controller} row={row} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function CouncilChannelRow({
  controller,
  row,
}: {
  readonly controller: CouncilChannelsController;
  readonly row: CouncilChannelRelationshipRow;
}): JSX.Element {
  const { t } = useI18n();
  const busyAction = controller.busyActions[row.councilId];
  const restriction = row.restrictionLabelKey ? t(row.restrictionLabelKey) : undefined;
  const displayName = row.council?.displayName ?? t("Unavailable");

  return (
    <div className="council-channels-row-shell" data-council-id={row.councilId}>
      <DataRow
        compact
        className="council-channels-row"
        role="listitem"
        identity={(
          <span className="council-channels-identity">
            <span className="council-channels-icon" aria-hidden="true"><Hash /></span>
            <span>
              <strong title={displayName}>{displayName}</strong>
              {row.council ? <small>{aiCouncilSourceLabel(row.council.source, t)}</small> : null}
            </span>
          </span>
        )}
        summary={row.council ? <span>{t(row.council.status)}</span> : <span>{t("Unavailable")}</span>}
        status={<StatusIndicator label={t(row.relationshipLabelKey)} tone={row.relationshipTone} />}
        actions={(
          <span className="council-channels-row-actions">
            {row.council && !row.preferred ? (
              <Button
                disabled={!row.canPrefer || controller.mutationsBlocked || Boolean(busyAction)}
                leadingIcon={<Star />}
                loading={busyAction === "prefer"}
                loadingLabel={t("Saving...")}
                onClick={() => void controller.preferCouncil(row.councilId)}
                size="sm"
                title={restriction ?? t("Prefer")}
                variant="secondary"
              >
                {t("Prefer")}
              </Button>
            ) : null}
            <IconButton
              disabled={!row.canDetach || controller.mutationsBlocked || Boolean(busyAction)}
              icon={Unlink}
              label={t("Detach council")}
              loading={busyAction === "detach"}
              loadingLabel={t("Saving...")}
              onClick={() => void controller.detachCouncil(row.councilId)}
            />
          </span>
        )}
      />
      {controller.rowErrors[row.councilId] ? (
        <InlineFeedback className="council-channels-row-error" tone="danger">
          {controller.rowErrors[row.councilId]}
        </InlineFeedback>
      ) : null}
    </div>
  );
}
