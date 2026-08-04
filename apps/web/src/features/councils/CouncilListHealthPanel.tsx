import { Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n.js";
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
  councilListHealthFilterLabel,
  councilListHealthFilters,
  type CouncilListHealthFilter,
  type CouncilListHealthOverviewView,
  type CouncilListHealthRowView,
} from "./council-list-health-view-model.js";

export interface CouncilListHealthPanelProps {
  readonly createBlocked: boolean;
  readonly filter: CouncilListHealthFilter;
  readonly initialLoading: boolean;
  readonly mutationFeedback?: ReactNode;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onFilterChange: (filter: CouncilListHealthFilter) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onSelect: (councilId: string) => void;
  readonly overview: CouncilListHealthOverviewView;
  readonly query: string;
  readonly refreshBusy: boolean;
  readonly refreshError: string;
  readonly rows: readonly CouncilListHealthRowView[];
  readonly selectedCouncilId: string;
  readonly settingsToolMode: boolean;
  readonly stale: boolean;
  readonly visibleRows: readonly CouncilListHealthRowView[];
}

export function CouncilListHealthPanel(props: CouncilListHealthPanelProps): JSX.Element {
  const { t } = useI18n();
  const noResults = props.rows.length > 0 && props.visibleRows.length === 0;

  return (
    <section className="council-workspace-list council-list-health-panel" aria-label={t("AI Councils")}>
      <div className="council-panel-title council-list-health-title">
        <strong>{t("AI Councils")}</strong>
        <span className="council-list-health-title-actions">
          {props.initialLoading ? <span>{t("Loading")}</span> : <span>{t("{count} council(s)", { count: props.visibleRows.length })}</span>}
          {props.stale ? <StatusIndicator compact label={t("Stale snapshot")} tone="warning" /> : null}
        </span>
      </div>

      {props.settingsToolMode ? <CouncilListOverviewSummary overview={props.overview} compact /> : null}

      <div className="council-list-health-toolbar">
        <Input
          aria-label={t("Search councils")}
          containerClassName="council-list-health-search"
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={t("Search councils")}
          prefix={<Search />}
          size="sm"
          value={props.query}
        />
        <div className="council-list-health-toolbar-actions">
          <Select
            aria-label={t("Filter councils by health")}
            containerClassName="council-list-health-filter"
            onChange={(event) => props.onFilterChange(event.target.value as CouncilListHealthFilter)}
            size="sm"
            value={props.filter}
          >
            {councilListHealthFilters.map((filter) => (
              <option key={filter} value={filter}>{councilListHealthFilterLabel(filter, t)}</option>
            ))}
          </Select>
          <IconButton
            disabled={props.createBlocked}
            icon={Plus}
            label={t("Create council")}
            onClick={props.onCreate}
            size="sm"
          />
        </div>
      </div>

      {props.refreshError ? (
        <InlineFeedback className="council-list-health-feedback" title={t("Council refresh failed")} tone="danger">
          <span className="council-list-health-feedback-body">
            <span>{props.refreshError}</span>
            <Button className="council-list-health-feedback-action" loading={props.refreshBusy} onClick={() => void props.onRefresh()} size="sm" variant="secondary">
              {t("Retry")}
            </Button>
          </span>
        </InlineFeedback>
      ) : null}

      {props.mutationFeedback}

      <div className="council-list-health-scroll" data-state={props.initialLoading ? "loading" : noResults ? "no-result" : props.rows.length === 0 ? "empty" : "ready"}>
        {props.initialLoading ? (
          <CouncilListSkeleton />
        ) : props.rows.length === 0 ? (
          <EmptyState
            action={<Button leadingIcon={<Plus />} onClick={props.onCreate} size="sm">{t("Create council")}</Button>}
            className="council-list-health-empty"
            compact
            description={t("Create a council to group teammates for shared channel work.")}
            slotClassNames={{ actions: "council-list-health-empty-actions" }}
            title={t("No councils available")}
          />
        ) : noResults ? (
          <EmptyState
            action={<Button onClick={props.onClearFilters} size="sm">{t("Clear filters")}</Button>}
            className="council-list-health-empty"
            compact
            description={t("Adjust the search or health filter to see other councils.")}
            slotClassNames={{ actions: "council-list-health-empty-actions" }}
            title={t("No councils match the current filters")}
          />
        ) : (
          <div className="council-list-stack council-list-health-rows" role="listbox" aria-label={t("Council results")}>
            {props.visibleRows.map((row) => (
              <DataRow
                aria-label={`${row.council.displayName}, ${row.statusLabel}`}
                className="council-list-health-row council-list-row"
                compact
                identity={(
                  <span className="council-list-health-identity">
                    <strong title={row.council.displayName}>{row.council.displayName}</strong>
                    <small title={`${row.sourceLabel} · ${row.routingLabel}`}>{row.sourceLabel} · {row.routingLabel}</small>
                  </span>
                )}
                key={row.council.id}
                onClick={() => props.onSelect(row.council.id)}
                selected={row.council.id === props.selectedCouncilId}
                status={<StatusIndicator label={row.statusLabel} tone={row.tone} />}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function CouncilListOverviewSummary({
  compact = false,
  overview,
}: {
  readonly compact?: boolean;
  readonly overview: CouncilListHealthOverviewView;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={compact ? "council-workspace-summary compact" : "council-workspace-summary"} aria-label={t("Council summary")}>
      <span>{t("{count} council(s)", { count: overview.total })}</span>
      <span>{t("{count} active", { count: overview.active })}</span>
      <span>{t("{count} need attention", { count: overview.attention })}</span>
      <span>{t("{count} custom", { count: overview.custom })}</span>
    </div>
  );
}

function CouncilListSkeleton(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="council-list-health-skeleton" aria-label={t("Loading councils")} role="status">
      {Array.from({ length: 5 }, (_, index) => (
        <span className="council-list-health-skeleton-row" key={index}>
          <span><Skeleton width={`${70 - index * 4}%`} /><Skeleton width={`${46 + index * 3}%`} /></span>
          <Skeleton width={72} />
        </span>
      ))}
    </div>
  );
}
