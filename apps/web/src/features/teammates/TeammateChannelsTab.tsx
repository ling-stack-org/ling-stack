import { Hash, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  EmptyState,
  InlineFeedback,
  Input,
  Select,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import {
  channelFilterLabelKey,
  type TeammateChannelAction,
  type TeammateChannelFilter,
  type TeammateChannelRowViewModel,
} from "./teammate-channels-view-models.js";
import type { TeammateChannelsController } from "./useTeammateChannelsController.js";

const channelFilters: readonly TeammateChannelFilter[] = ["all", "active", "paused"];

export function TeammateChannelsTab({
  controller,
}: {
  readonly controller: TeammateChannelsController;
}): JSX.Element {
  const { t } = useI18n();
  const {
    busyActions,
    filter,
    loadError,
    loading,
    refreshing,
    rowErrors,
    rows,
    searchQuery,
    stale,
    stats,
    visibleRows,
  } = controller;

  return (
    <section className="teammate-channels-panel" data-ui2-teammate-channels="true" aria-label={t("Channels")}>
      <header className="teammate-channels-heading">
        <div>
          <Hash aria-hidden="true" />
          <h2>{t("Channels")}</h2>
        </div>
        <StatusIndicator
          label={loading
            ? t("Loading")
            : t("{joined} of {total} channels joined", { joined: stats.joined, total: stats.total })}
          tone={loadError ? (stale ? "warning" : "danger") : "neutral"}
        />
      </header>

      <div className="teammate-channels-toolbar">
        <Input
          aria-label={t("Search channels")}
          containerClassName="teammate-channels-search"
          prefix={<Search aria-hidden="true" />}
          placeholder={t("Search channels")}
          type="search"
          value={searchQuery}
          onChange={(event) => controller.setSearchQuery(event.target.value)}
        />
        <Select
          aria-label={t("Channel status")}
          containerClassName="teammate-channels-filter"
          value={filter}
          onChange={(event) => controller.setFilter(event.target.value as TeammateChannelFilter)}
        >
          {channelFilters.map((item) => (
            <option key={item} value={item}>{t(channelFilterLabelKey(item))}</option>
          ))}
        </Select>
      </div>

      {loadError ? (
        <div className="teammate-channels-load-error">
          <InlineFeedback tone={stale ? "warning" : "danger"}>{loadError}</InlineFeedback>
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void controller.refresh("refresh")}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="teammate-channels-loading" aria-label={t("Loading channel memberships")}>
          <Skeleton height={54} />
          <Skeleton height={54} />
          <Skeleton height={54} />
          <Skeleton height={54} />
        </div>
      ) : loadError && !stale ? null : rows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-channels-empty"
          icon={<Hash />}
          title={t("No channels available")}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-channels-empty"
          icon={<Search />}
          title={t("No channels match these filters")}
          action={<Button size="sm" variant="secondary" onClick={controller.clearFilters}>{t("Clear filters")}</Button>}
        />
      ) : (
        <div className="teammate-channels-list" data-ui2-teammate-channels-list="true" role="list" aria-label={t("Channel memberships")}>
          {visibleRows.map((row) => (
            <ChannelRow
              key={row.channel.id}
              row={row}
              busyAction={busyActions[row.channel.id]}
              error={rowErrors[row.channel.id]}
              onAction={(action) => {
                if (action === "join") return controller.join(row.channel.id);
                if (action === "leave") return controller.leave(row.channel.id);
                return controller.setDefault(row.channel.id);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChannelRow({
  busyAction,
  error,
  onAction,
  row,
}: {
  readonly busyAction?: TeammateChannelAction;
  readonly error?: string;
  readonly onAction: (action: TeammateChannelAction) => Promise<void>;
  readonly row: TeammateChannelRowViewModel;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="teammate-channel-row-shell" data-channel-id={row.channel.id}>
      <DataRow
        compact
        className="teammate-channel-row"
        data-has-actions={row.actions.length > 0 || undefined}
        role="listitem"
        identity={(
          <span className="teammate-channel-identity">
            <span className="teammate-channel-icon" aria-hidden="true"><Hash /></span>
            <strong title={row.channel.name}>{row.channel.name}</strong>
          </span>
        )}
        summary={(
          <span className="teammate-channel-summary">
            <span>{t(row.lifecycleLabelKey)}</span>
            {row.restrictionLabelKey ? <small title={t(row.restrictionLabelKey)}>{t(row.restrictionLabelKey)}</small> : null}
          </span>
        )}
        status={<StatusIndicator label={t(row.relationshipLabelKey)} tone={row.relationshipTone} />}
        actions={row.actions.length > 0 ? (
          <span className="teammate-channel-actions">
            {row.actions.map((action) => {
              const rowBusy = Boolean(busyAction);
              const reason = action.disabledReasonKey ? t(action.disabledReasonKey) : undefined;
              return (
                <Button
                  key={action.id}
                  size="sm"
                  variant={action.variant}
                  loading={busyAction === action.id}
                  loadingLabel={t("Saving...")}
                  disabled={action.disabled || rowBusy}
                  title={reason ?? t(action.labelKey)}
                  onClick={() => void onAction(action.id)}
                >
                  {t(action.labelKey)}
                </Button>
              );
            })}
          </span>
        ) : undefined}
      />
      {error ? <InlineFeedback className="teammate-channel-row-error" tone="danger">{error}</InlineFeedback> : null}
    </div>
  );
}
