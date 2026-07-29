import { Box, Plus, RefreshCw } from "lucide-react";
import { Button, IconButton, SegmentedControl, SegmentedControlItem } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { mediaJobStatusFilters } from "./media-job-state-view-models.js";
import type { MediaJobStatusFilter } from "./media-job-types.js";

export function MediaJobsHeader({
  taskCount,
  generatingCount,
  attentionCount,
  statusFilter,
  refreshing,
  hasRunnableModel,
  onFilterChange,
  onRefresh,
  onPrimaryAction,
}: {
  readonly taskCount: number;
  readonly generatingCount: number;
  readonly attentionCount: number;
  readonly statusFilter: MediaJobStatusFilter;
  readonly refreshing: boolean;
  readonly hasRunnableModel: boolean;
  readonly onFilterChange: (filter: MediaJobStatusFilter) => void;
  readonly onRefresh: () => void;
  readonly onPrimaryAction: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const summary = [t("{taskCount} loaded tasks", { taskCount })];
  if (generatingCount) summary.push(t("{count} generating", { count: generatingCount }));
  if (attentionCount) summary.push(t("{count} need attention", { count: attentionCount }));
  return (
    <header className="media-jobs-header" data-media-jobs-header>
      <div className="media-jobs-heading-row">
        <div className="media-jobs-heading-copy">
          <strong id="media-jobs-title">{t("Generation tasks")}</strong>
          <span>{summary.join(" · ")}</span>
        </div>
        <div className="media-jobs-header-actions">
          <IconButton
            icon={RefreshCw}
            label={t("Refresh")}
            loading={refreshing}
            onClick={onRefresh}
          />
          <Button
            leadingIcon={hasRunnableModel ? <Plus aria-hidden="true" size={16} /> : <Box aria-hidden="true" size={16} />}
            variant="primary"
            onClick={onPrimaryAction}
          >
            {hasRunnableModel ? t("New generation task") : t("Configure generation model")}
          </Button>
        </div>
      </div>
      <SegmentedControl
        aria-label={t("Generation task status")}
        className="media-jobs-filter"
        size="sm"
        value={statusFilter}
        onValueChange={(value) => onFilterChange(value as MediaJobStatusFilter)}
      >
        {mediaJobStatusFilters.map((filter) => (
          <SegmentedControlItem key={filter} value={filter}>{t(filterLabel(filter))}</SegmentedControlItem>
        ))}
      </SegmentedControl>
    </header>
  );
}

function filterLabel(filter: MediaJobStatusFilter): string {
  if (filter === "all") return "All";
  if (filter === "ready_to_start") return "Ready";
  if (filter === "generating") return "Generating";
  if (filter === "needs_attention") return "Needs attention";
  return "Completed";
}
