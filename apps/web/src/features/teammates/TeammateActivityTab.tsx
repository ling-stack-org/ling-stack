import {
  Activity as ActivityIcon,
  AtSign,
  ListTodo,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  Button,
  DataRow,
  EmptyState,
  IconButton,
  InlineFeedback,
  Input,
  Select,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import {
  activityFilterLabelKey,
  type TeammateActivityFilter,
  type TeammateActivityRowViewModel,
} from "./teammate-activity-view-models.js";
import type { TeammateActivityController } from "./useTeammateActivityController.js";

const activityFilters: readonly TeammateActivityFilter[] = [
  "all",
  "direct-message",
  "task",
  "run",
  "approval",
  "channel-message",
];

export function TeammateActivityTab({
  controller,
  onOpenRun,
}: {
  readonly controller: TeammateActivityController;
  readonly onOpenRun?: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const {
    error,
    filter,
    loading,
    refreshing,
    rows,
    searchQuery,
    stale,
    visibleRows,
  } = controller;

  return (
    <section className="teammate-activity-panel" data-ui2-teammate-activity="true" aria-label={t("Recent activity")}>
      <header className="teammate-activity-heading">
        <div>
          <ActivityIcon aria-hidden="true" />
          <h2>{t("Recent activity")}</h2>
        </div>
        <StatusIndicator
          label={loading ? t("Loading") : t("{count} recent items", { count: rows.length })}
          tone={error ? (stale ? "warning" : "danger") : "neutral"}
        />
      </header>

      <div className="teammate-activity-toolbar">
        <Input
          aria-label={t("Search recent activity")}
          containerClassName="teammate-activity-search"
          prefix={<Search aria-hidden="true" />}
          placeholder={t("Search recent activity")}
          type="search"
          value={searchQuery}
          onChange={(event) => controller.setSearchQuery(event.target.value)}
        />
        <Select
          aria-label={t("Activity type")}
          className="teammate-activity-filter"
          value={filter}
          onChange={(event) => controller.setFilter(event.target.value as TeammateActivityFilter)}
        >
          {activityFilters.map((item) => (
            <option key={item} value={item}>{t(activityFilterLabelKey(item))}</option>
          ))}
        </Select>
        <IconButton
          icon={RefreshCw}
          label={t("Refresh activity")}
          loading={refreshing}
          disabled={loading}
          onClick={() => void controller.refresh("refresh")}
        />
      </div>

      {error ? (
        <div className="teammate-activity-error">
          <InlineFeedback tone={stale ? "warning" : "danger"}>{error}</InlineFeedback>
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void controller.refresh("refresh")}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="teammate-activity-loading" aria-label={t("Loading recent activity")}>
          <Skeleton height={54} />
          <Skeleton height={54} />
          <Skeleton height={54} />
          <Skeleton height={54} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-activity-empty"
          icon={<ActivityIcon />}
          title={t("No recent activity")}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-activity-empty"
          icon={<Search />}
          title={t("No activity matches these filters")}
          action={<Button size="sm" variant="secondary" onClick={controller.clearFilters}>{t("Clear filters")}</Button>}
        />
      ) : (
        <div className="teammate-activity-list" data-ui2-teammate-activity-list="true" role="list" aria-label={t("Recent activity")}>
          {visibleRows.map((row) => (
            <ActivityRow key={row.item.id} row={row} onOpenRun={onOpenRun} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityRow({
  row,
  onOpenRun,
}: {
  readonly row: TeammateActivityRowViewModel;
  readonly onOpenRun?: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const openRun = row.runId && onOpenRun ? () => onOpenRun(row.runId as string) : undefined;
  return (
    <DataRow
      compact
      className="teammate-activity-row"
      data-activity-id={row.item.id}
      role="listitem"
      onClick={openRun}
      identity={(
        <span className="teammate-activity-row-identity">
          <span className="teammate-activity-kind-icon" aria-hidden="true">{activityIcon(row.item.kind)}</span>
          <span>
            <strong title={row.title}>{row.title}</strong>
            <small title={row.subtitle}>{row.subtitle}</small>
          </span>
        </span>
      )}
      summary={(
        <span className="teammate-activity-row-meta">
          <span>{row.kindLabel}</span>
          <time dateTime={row.item.createdAt}>{formatDateTime(row.item.createdAt)}</time>
        </span>
      )}
      status={<StatusIndicator label={row.statusLabel} tone={row.statusTone} />}
      actions={openRun ? (
        <IconButton
          icon={SquareTerminal}
          label={t("Open run")}
          onClick={(event) => {
            event.stopPropagation();
            openRun();
          }}
        />
      ) : undefined}
    />
  );
}

function activityIcon(kind: TeammateActivityRowViewModel["item"]["kind"]): JSX.Element {
  if (kind === "direct-message") return <MessageSquareText />;
  if (kind === "task") return <ListTodo />;
  if (kind === "run") return <SquareTerminal />;
  if (kind === "approval") return <ShieldCheck />;
  return <AtSign />;
}
