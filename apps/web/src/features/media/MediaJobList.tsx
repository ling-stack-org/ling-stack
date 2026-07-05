import { CircleAlert, Database, Image as ImageIcon, Loader2, Play } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName, isImageArtifact } from "../../lib/artifacts.js";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusActionRow } from "../../shared/components/index.js";
import type { MediaJob, MediaJobStatus, ProviderPreset, RunArtifact } from "../../types.js";
import {
  mediaArtifactsForJob,
  mediaJobCanRun,
  mediaJobMatchesFilter,
  mediaJobNeedsRecovery,
  mediaJobRunDisabledReason,
  mediaJobStatusBadgeClass,
  mediaJobStatusFilters,
  mediaJobStatusLabel,
  mediaOperationLabel,
  type MediaJobStatusFilter,
} from "./media-job-view-models.js";

export function MediaJobList({
  cwd,
  jobs,
  providers,
  artifactsByJob,
  selectedJobId,
  runningJobId,
  isLoading,
  statusFilter,
  onStatusFilterChange,
  onSelectJob,
  onRun,
}: {
  readonly cwd: string;
  readonly jobs: readonly MediaJob[];
  readonly providers: readonly ProviderPreset[];
  readonly artifactsByJob: Record<string, readonly RunArtifact[]>;
  readonly selectedJobId: string;
  readonly runningJobId: string;
  readonly isLoading: boolean;
  readonly statusFilter: MediaJobStatusFilter;
  readonly onStatusFilterChange: (filter: MediaJobStatusFilter) => void;
  readonly onSelectJob: (jobId: string) => void;
  readonly onRun: (jobId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const filteredJobs = jobs.filter((job) => mediaJobMatchesFilter(job, statusFilter));

  return (
    <section className="media-job-list-panel" aria-labelledby="media-jobs-title">
      <div className="media-job-filter-bar" aria-label={t("Generation task status")}>
        {mediaJobStatusFilters.map((filter) => (
          <button
            key={filter}
            className={statusFilter === filter ? "active" : ""}
            type="button"
            onClick={() => onStatusFilterChange(filter)}
          >
            {t(mediaJobFilterLabel(filter))}
          </button>
        ))}
      </div>

      <div className="media-job-list">
        {filteredJobs.length === 0 ? (
          <div className="empty-state compact-empty">
            {isLoading ? <Loader2 className="spin" /> : <Database />}
            <span>{isLoading ? t("Loading generation tasks...") : t("No generation tasks recorded for this workspace")}</span>
          </div>
        ) : (
          filteredJobs.map((job) => {
            const provider = providers.find((item) => item.id === job.providerPresetId);
            const jobArtifacts = artifactsByJob[job.id] ?? [];
            const mediaArtifacts = mediaArtifactsForJob(jobArtifacts);
            const needsRecovery = mediaJobNeedsRecovery(job, jobArtifacts);
            const isRunnable = mediaJobCanRun(job, jobArtifacts);
            const isRunningJob = runningJobId === job.id;
            const operationLabel = t(mediaOperationLabel(job.operation));
            const statusLabel = t(mediaJobStatusLabel(job.status));
            const actionLabel = job.status === "failed" || job.status === "cancelled" ? t("Run again") : t("Run");
            const disabledReason = mediaJobRunDisabledReason({
              job,
              artifacts: jobArtifacts,
              isLoading,
              isRunning: isRunningJob,
            });
            const disabledTitle = disabledReason ? t(disabledReason, { status: statusLabel }) : t("Run generation");
            return (
              <article
                key={job.id}
                className={`media-job-row ${job.status}${needsRecovery ? " needs-recovery" : ""}${selectedJobId === job.id ? " selected" : ""}`}
                onClick={() => onSelectJob(job.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectJob(job.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <StatusActionRow
                  className="media-job-row-content"
                  leading={<MediaJobResultPreview artifact={mediaArtifacts[0]} count={mediaArtifacts.length} cwd={cwd} status={job.status} />}
                  title={<strong>{operationLabel}</strong>}
                  description={`${provider?.displayName ?? t("Unknown provider")} · ${formatDateTime(job.createdAt)}`}
                  meta={(
                    <>
                      <span>{t("{count} generated results", { count: mediaArtifacts.length })}</span>
                      <time>{formatDateTime(job.updatedAt)}</time>
                    </>
                  )}
                  status={<span className={`status-badge ${mediaJobStatusBadgeClass(job.status)}`}>{statusLabel}</span>}
                  actions={(
                    <button
                      className={needsRecovery ? "primary-button compact-button" : "secondary-button compact-button"}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectJob(job.id);
                        onRun(job.id);
                      }}
                      disabled={isLoading || isRunningJob || !isRunnable}
                      title={disabledTitle}
                      aria-label={disabledReason ? `${actionLabel}. ${disabledTitle}` : actionLabel}
                    >
                      {isRunningJob ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                      {isRunningJob ? t("Running") : actionLabel}
                    </button>
                  )}
                />
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function MediaJobResultPreview({
  artifact,
  count,
  cwd,
  status,
}: {
  readonly artifact?: RunArtifact;
  readonly count: number;
  readonly cwd: string;
  readonly status: MediaJobStatus;
}): JSX.Element {
  const { t } = useI18n();
  if (artifact && isImageArtifact(artifact)) {
    const title = artifact.title || artifactDownloadName(artifact);
    return (
      <a className="media-job-result-preview image" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
        <img src={artifactContentUrl(artifact.id, cwd)} alt={title} />
        <span>{t("Result")}</span>
      </a>
    );
  }
  if (artifact) {
    return (
      <a className="media-job-result-preview file" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label={t("{count} generated results", { count })}>
        <ImageIcon size={20} />
      </a>
    );
  }
  return (
    <span className={`media-job-result-preview empty ${status}`} aria-label={t(mediaJobStatusLabel(status))}>
      {status === "running" ? <Loader2 className="spin" size={20} /> : <CircleAlert size={20} />}
    </span>
  );
}

function mediaJobFilterLabel(filter: MediaJobStatusFilter): string {
  if (filter === "all") {
    return "All";
  }
  if (filter === "succeeded") {
    return "Succeeded";
  }
  if (filter === "failed") {
    return "Failed";
  }
  return "Active";
}
