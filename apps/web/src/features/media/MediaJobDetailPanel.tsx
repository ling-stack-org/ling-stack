import { CircleAlert, Copy, Image as ImageIcon, Loader2, Play, PlugZap } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName, isImageArtifact } from "../../lib/artifacts.js";
import { formatDateTime } from "../../lib/formatting.js";
import { ArtifactRow, StatusActionRow } from "../../shared/components/index.js";
import type { MediaJob, RunArtifact } from "../../types.js";
import {
  formatMediaJobError,
  mediaJobCanRun,
  mediaJobRunDisabledReason,
  mediaJobInputValue,
  mediaJobNeedsRecovery,
  mediaOperationLabel,
  mediaJobStatusLabel,
} from "./media-job-view-models.js";

export function MediaJobDetailPanel({
  cwd,
  job,
  providerName,
  artifacts,
  isLoading,
  isRunning,
  onCopy,
  onOpenProviders,
  onRun,
}: {
  readonly cwd: string;
  readonly job?: MediaJob;
  readonly providerName: string;
  readonly artifacts: readonly RunArtifact[];
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly onCopy: () => void;
  readonly onOpenProviders: () => void;
  readonly onRun: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <aside className="media-job-detail-panel" aria-label={t("Generation task details")}>
      {job ? (
        <MediaJobDetail
          cwd={cwd}
          job={job}
          providerName={providerName}
          artifacts={artifacts}
          isLoading={isLoading}
          isRunning={isRunning}
          onCopy={onCopy}
          onOpenProviders={onOpenProviders}
          onRun={onRun}
        />
      ) : (
        <div className="media-job-detail-empty">
          <ImageIcon size={20} />
          <strong>{t("No generation task selected")}</strong>
          <span>{t("Create or select a task to inspect its prompt and artifacts.")}</span>
        </div>
      )}
    </aside>
  );
}

function MediaJobDetail({
  cwd,
  job,
  providerName,
  artifacts,
  isLoading,
  isRunning,
  onCopy,
  onOpenProviders,
  onRun,
}: {
  readonly cwd: string;
  readonly job: MediaJob;
  readonly providerName: string;
  readonly artifacts: readonly RunArtifact[];
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly onCopy: () => void;
  readonly onOpenProviders: () => void;
  readonly onRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const primaryArtifact = artifacts[0];
  const canRun = mediaJobCanRun(job, artifacts);
  const needsRecovery = mediaJobNeedsRecovery(job, artifacts);
  const size = mediaJobInputValue(job.input, ["size", "resolution", "image_size", "imageSize"]);
  const seed = mediaJobInputValue(job.input, ["seed"]);
  const steps = mediaJobInputValue(job.input, ["steps", "num_steps", "numSteps"]);
  const runDisabledReason = mediaJobRunDisabledReason({ job, artifacts, isLoading, isRunning });
  const runDisabledTitle = runDisabledReason ? t(runDisabledReason, { status: t(mediaJobStatusLabel(job.status)) }) : t("Run generation");
  return (
    <div className="media-job-detail-content">
      <div className="media-job-detail-head">
        <span className="media-job-detail-kicker">TASK · {job.id.slice(0, 8).toUpperCase()}</span>
        <span className="media-job-detail-tools">
          <button className="ghost-icon-button" type="button" onClick={onCopy} aria-label={t("Copy prompt")} title={t("Copy prompt")}>
            <Copy size={16} />
          </button>
          <button className="ghost-icon-button" type="button" onClick={onOpenProviders} aria-label={t("Model Workbench")} title={t("Model Workbench")}>
            <PlugZap size={16} />
          </button>
        </span>
      </div>
      <h2>{t(mediaOperationLabel(job.operation))}</h2>
      <p className="media-job-detail-summary">
        {job.status === "succeeded"
          ? t("Successfully generated {count} artifact based on the provided prompt.", { count: artifacts.length })
          : needsRecovery
            ? (job.errorMessage ? formatMediaJobError(job.errorMessage, t) : t("No usable result was returned. Try another run or choose a different model."))
            : t("This task is ready to run when model settings are satisfied.")}
      </p>

      {primaryArtifact ? (
        <MediaJobResultHero artifact={primaryArtifact} cwd={cwd} />
      ) : (
        <span className={`media-job-detail-preview empty ${job.status}`}>
          {isRunning ? <Loader2 className="spin" size={22} /> : needsRecovery ? <CircleAlert size={22} /> : <ImageIcon size={22} />}
          <strong>{isRunning ? t("Running") : needsRecovery ? t("Needs recovery") : t("No result yet")}</strong>
        </span>
      )}

      <StatusActionRow
        className="media-job-detail-control-row"
        title={t("Generation controls")}
        description={runDisabledReason ? runDisabledTitle : t("Run this task or copy its prompt and parameters.")}
        status={<span className={`status-badge ${job.status}`}>{t(mediaJobStatusLabel(job.status))}</span>}
        actions={(
          <>
            <button
              className={needsRecovery ? "primary-button" : "secondary-button"}
              type="button"
              onClick={onRun}
              disabled={isLoading || isRunning || !canRun}
              title={runDisabledTitle}
              aria-label={runDisabledReason ? `${needsRecovery ? t("Run again") : t("Run")}. ${runDisabledTitle}` : undefined}
            >
              {isRunning ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              {isRunning ? t("Running") : needsRecovery ? t("Run again") : t("Run")}
            </button>
            <button className="secondary-button" type="button" onClick={onCopy}>
              <Copy size={16} />
              {t("Copy details")}
            </button>
          </>
        )}
      />

      <div className="media-job-detail-meta stitch-params" aria-label={t("Generation task parameters")}>
        <span>{t("Model")}<strong>{providerName}</strong></span>
        <span>{t("Size")}<strong>{size}</strong></span>
        <span>{t("Seed")}<strong>{seed}</strong></span>
        <span>{t("Steps")}<strong>{steps}</strong></span>
      </div>

      <details className="media-job-detail-disclosure" open>
        <summary>{t("View full prompt")}</summary>
        <p>{job.prompt}</p>
      </details>

      <div className="media-job-detail-meta runtime-meta">
        <span>{t("Provider")}<strong>{providerName}</strong></span>
        <span>{t("Status")}<strong>{t(mediaJobStatusLabel(job.status))}</strong></span>
        <span>{t("Created")}<strong>{formatDateTime(job.createdAt)}</strong></span>
        <span>{t("Updated")}<strong>{formatDateTime(job.updatedAt)}</strong></span>
      </div>

      {artifacts.length > 0 ? (
        <div className="media-job-detail-artifacts artifact-list" aria-label={t("Artifacts")}>
          {artifacts.map((artifact) => (
            <ArtifactRow artifact={artifact} cwd={cwd} key={artifact.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MediaJobResultHero({
  artifact,
  cwd,
}: {
  readonly artifact: RunArtifact;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const title = artifact.title || artifactDownloadName(artifact);
  if (isImageArtifact(artifact)) {
    return (
      <a className="media-job-detail-preview image" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer">
        <img src={artifactContentUrl(artifact.id, cwd)} alt={title} />
      </a>
    );
  }
  return (
    <a className="media-job-detail-preview file" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer">
      <ImageIcon size={22} />
      <strong>{t("Open generated result")}</strong>
    </a>
  );
}
