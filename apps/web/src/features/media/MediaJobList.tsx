import { Image as ImageIcon } from "lucide-react";
import { Button, EmptyState, Skeleton } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobActionId, MediaJobProjectionInput, MediaJobRowView, MediaJobStatusFilter } from "./media-job-types.js";
import { MediaJobRow } from "./MediaJobRow.js";

export function MediaJobList({
  cwd,
  projections,
  rows,
  selectedJobId,
  statusFilter,
  initialLoading,
  loadFailed,
  hasRunnableModel,
  onAction,
  onCreate,
  onSelect,
  onShowAll,
}: {
  readonly cwd: string;
  readonly projections: readonly MediaJobProjectionInput[];
  readonly rows: readonly MediaJobRowView[];
  readonly selectedJobId: string;
  readonly statusFilter: MediaJobStatusFilter;
  readonly initialLoading: boolean;
  readonly loadFailed: boolean;
  readonly hasRunnableModel: boolean;
  readonly onAction: (action: MediaJobActionId, projection: MediaJobProjectionInput) => void;
  readonly onCreate: () => void;
  readonly onSelect: (jobId: string) => void;
  readonly onShowAll: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (initialLoading) return <MediaJobListSkeleton />;
  if (loadFailed) return <div className="media-job-list-state" data-media-jobs-list-state="load-error" />;
  if (projections.length === 0 && statusFilter === "all") {
    return (
      <EmptyState
        className="media-job-list-state"
        data-media-jobs-list-state="empty"
        icon={<ImageIcon size={24} />}
        title={t("No generation tasks yet")}
        description={t("Create a task to generate an image or video for this workspace.")}
        action={<Button variant="primary" onClick={onCreate}>{hasRunnableModel ? t("New generation task") : t("Configure generation model")}</Button>}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        className="media-job-list-state"
        compact
        data-media-jobs-list-state="no-result"
        title={t("No tasks match this status")}
        action={<Button size="sm" onClick={onShowAll}>{t("Show all")}</Button>}
      />
    );
  }
  const projectionById = new Map(projections.map((item) => [item.job.id, item]));
  return (
    <div className="media-job-list" role="listbox" aria-label={t("Generation tasks")}>
      {rows.map((row) => {
        const projection = projectionById.get(row.jobId);
        return projection ? (
          <MediaJobRow
            key={row.jobId}
            cwd={cwd}
            projection={projection}
            row={row}
            selected={row.jobId === selectedJobId}
            onAction={onAction}
            onSelect={onSelect}
          />
        ) : null;
      })}
    </div>
  );
}

function MediaJobListSkeleton(): React.JSX.Element {
  return (
    <div className="media-job-list media-job-list-skeleton" aria-busy="true" data-media-jobs-list-state="loading">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="media-job-row-skeleton" key={index}>
          <Skeleton shape="block" width={72} height={48} />
          <span><Skeleton width="72%" /><Skeleton width="92%" /></span>
          <Skeleton width={88} />
        </div>
      ))}
    </div>
  );
}
