import { CircleAlert, Copy, ExternalLink, Image as ImageIcon, Loader2, Play, PlugZap } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { ArtifactRow, StatusActionRow } from "../../shared/components/index.js";
import type { MediaJob, RunArtifact } from "../../types.js";
import {
  deriveMediaJobDisplayState,
  mediaJobDisplayStateLabel,
  mediaJobFailureRecoveryView,
  mediaJobResultActionView,
  mediaJobCanRun,
  mediaJobPrimaryActionView,
  mediaJobRunDisabledReason,
  mediaJobInputValue,
  mediaOperationLabel,
} from "./media-job-view-models.js";
import { MediaArtifactPreview } from "./MediaArtifactPreview.js";

export function MediaJobDetailPanel({
  cwd,
  job,
  providerName,
  artifacts,
  isLoading,
  isRunning,
  isStarting,
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
  readonly isStarting: boolean;
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
          isStarting={isStarting}
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
  isStarting,
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
  readonly isStarting: boolean;
  readonly onCopy: () => void;
  readonly onOpenProviders: () => void;
  readonly onRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const primaryArtifact = artifacts[0];
  const displayState = deriveMediaJobDisplayState({
    job,
    artifacts,
    runningJobId: isRunning ? job.id : "",
    startingJobId: isStarting ? job.id : "",
  });
  const canRun = mediaJobCanRun(job, artifacts);
  const needsRecovery = displayState === "needs_attention";
  const recoveryView = needsRecovery ? mediaJobFailureRecoveryView({ job, artifacts, t }) : undefined;
  const resultActionView = mediaJobResultActionView(artifacts);
  const size = mediaJobInputValue(job.input, ["size", "resolution", "image_size", "imageSize"]);
  const seed = mediaJobInputValue(job.input, ["seed"]);
  const steps = mediaJobInputValue(job.input, ["steps", "num_steps", "numSteps"]);
  const ratio = mediaJobInputValue(job.input, ["ratio", "aspect_ratio", "aspectRatio"]);
  const duration = mediaJobInputValue(job.input, ["duration", "duration_seconds", "durationSeconds"]);
  const jobParameters = job.operation === "video_generate"
    ? [
      [t("Model"), providerName],
      [t("Aspect ratio"), ratio],
      [t("Video duration"), duration === "--" ? duration : t("{count} seconds", { count: duration })],
    ]
    : [
      [t("Model"), providerName],
      [t("Size"), size],
      [t("Seed"), seed],
      [t("Steps"), steps],
    ].filter(([, value]) => value !== "--");
  const runDisabledReason = mediaJobRunDisabledReason({ job, artifacts, isLoading, isRunning, isStarting });
  const runDisabledTitle = runDisabledReason ? t(runDisabledReason) : t("Run generation");
  const actionView = mediaJobPrimaryActionView({ job, artifacts, isLoading, isRunning, isStarting });
  return (
    <div className="media-job-detail-content">
      <div className="media-job-detail-head">
        <span className="media-job-detail-kicker">{t("Generation task")}</span>
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
      {!needsRecovery ? (
        <p className="media-job-detail-summary">
          {displayState === "completed"
            ? t("Successfully generated {count} artifact based on the provided prompt.", { count: artifacts.length })
            : displayState === "starting"
              ? t("Generation request is starting. Results will appear here when it finishes.")
            : displayState === "generating"
              ? t("Generation is running. Results will appear here when it finishes.")
              : t("This task is ready to start when model settings are satisfied.")}
        </p>
      ) : null}

      {primaryArtifact ? (
        <MediaJobResultHero artifact={primaryArtifact} cwd={cwd} />
      ) : !needsRecovery ? (
        <span className={`media-job-detail-preview empty ${job.status} ${displayState}`}>
          {isRunning || isStarting ? <Loader2 className="spin" size={22} /> : <ImageIcon size={22} />}
          <strong>{displayState === "starting" ? t("Starting generation") : displayState === "generating" ? t("Generating") : t("No result yet")}</strong>
        </span>
      ) : null}

      {displayState === "completed" && primaryArtifact && resultActionView.hasResult ? (
        <MediaJobResultActions
          artifact={primaryArtifact}
          cwd={cwd}
          view={resultActionView}
          onCopyPrompt={onCopy}
        />
      ) : null}

      {needsRecovery && recoveryView ? (
        <MediaJobFailureSummary
          recoveryView={recoveryView}
          isLoading={isLoading}
          isRunning={isRunning}
          isStarting={isStarting}
          canRun={canRun}
          runDisabledTitle={runDisabledTitle}
          onCopy={onCopy}
          onOpenProviders={onOpenProviders}
          onRun={onRun}
        />
      ) : actionView.visible ? (
        <StatusActionRow
          className="media-job-detail-control-row"
          title={t("Generation controls")}
          description={runDisabledReason ? runDisabledTitle : t("Start or retry this task, or copy its prompt and parameters.")}
          actions={(
            <>
              <button
                className={actionView.emphasis === "primary" ? "primary-button" : "secondary-button"}
                type="button"
                onClick={onRun}
                disabled={isLoading || isRunning || isStarting || !canRun || actionView.disabled}
                title={runDisabledTitle}
                aria-label={runDisabledReason ? `${t(actionView.label)}. ${runDisabledTitle}` : undefined}
              >
                {isRunning || isStarting ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                {t(actionView.label)}
              </button>
              <button className="secondary-button" type="button" onClick={onCopy}>
                <Copy size={16} />
                {t("Copy details")}
              </button>
            </>
          )}
        />
      ) : null}

      <div className={`media-job-detail-meta stitch-params${jobParameters.length % 2 ? " odd" : ""}`} aria-label={t("Generation task parameters")}>
        {jobParameters.map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}
      </div>

      <details className="media-job-detail-disclosure" open={displayState === "ready_to_start"}>
        <summary>{t("View full prompt")}</summary>
        <p>{job.prompt}</p>
      </details>

      <div className="media-job-detail-meta runtime-meta">
        <span>{t("Provider")}<strong>{providerName}</strong></span>
        <span>{t("Status")}<strong>{t(mediaJobDisplayStateLabel(displayState))}</strong></span>
        <span>{t("Created")}<strong>{formatDateTime(job.createdAt)}</strong></span>
        <span>{t("Updated")}<strong>{formatDateTime(job.updatedAt)}</strong></span>
      </div>

      <details className="media-job-detail-disclosure media-job-raw-diagnostics">
        <summary>{t("Raw diagnostics")}</summary>
        <div className="media-job-detail-meta runtime-meta">
          <span>{t("Task ID")}<strong>{job.id}</strong></span>
          <span>{t("Provider route")}<strong>{job.providerPresetId}</strong></span>
          <span>{t("Operation")}<strong>{job.operation}</strong></span>
          <span>{t("Status")}<strong>{job.status}</strong></span>
        </div>
      </details>

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

function MediaJobFailureSummary({
  recoveryView,
  isLoading,
  isRunning,
  isStarting,
  canRun,
  runDisabledTitle,
  onCopy,
  onOpenProviders,
  onRun,
}: {
  readonly recoveryView: ReturnType<typeof mediaJobFailureRecoveryView>;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly isStarting: boolean;
  readonly canRun: boolean;
  readonly runDisabledTitle: string;
  readonly onCopy: () => void;
  readonly onOpenProviders: () => void;
  readonly onRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const isBusy = isLoading || isRunning || isStarting;
  return (
    <section className="media-job-failure-summary" aria-label={t("Generation recovery")}>
      <div className="media-job-failure-main">
        <span className="media-job-failure-icon" aria-hidden="true">
          <CircleAlert size={18} />
        </span>
        <span className="media-job-failure-copy">
          <span className="media-job-failure-state">{t("Needs attention")}</span>
          <strong>{recoveryView.title}</strong>
          <small>{recoveryView.description}</small>
        </span>
      </div>
      <div className="media-job-failure-actions">
        <button
          className="primary-button"
          type="button"
          onClick={recoveryView.actionKind === "open_providers" ? onOpenProviders : onRun}
          disabled={recoveryView.actionKind === "retry" && (isBusy || !canRun)}
          title={recoveryView.actionKind === "retry" ? runDisabledTitle : undefined}
        >
          {recoveryView.actionKind === "open_providers"
            ? <PlugZap size={16} />
            : isBusy
              ? <Loader2 className="spin" size={16} />
              : <Play size={16} />}
          {recoveryView.actionLabel}
        </button>
        <button className="secondary-button" type="button" onClick={onCopy}>
          <Copy size={16} />
          {t("Copy details")}
        </button>
      </div>
      <details className="media-job-failure-details">
        <summary>{t("Generation details")}</summary>
        <p>{recoveryView.rawDetails}</p>
      </details>
    </section>
  );
}

function MediaJobResultActions({
  artifact,
  cwd,
  view,
  onCopyPrompt,
}: {
  readonly artifact: RunArtifact;
  readonly cwd: string;
  readonly view: ReturnType<typeof mediaJobResultActionView>;
  readonly onCopyPrompt: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const resultUrl = artifactContentUrl(artifact.id, cwd);
  return (
    <div className="media-job-result-actions" aria-label={t("Generated result actions")}>
      <a className="primary-button" href={resultUrl} target="_blank" rel="noreferrer">
        <ExternalLink size={16} />
        {t(view.primaryLabel)}
      </a>
      <button className="secondary-button" type="button" onClick={onCopyPrompt}>
        <Copy size={16} />
        {t(view.copyPromptLabel)}
      </button>
      <button className="secondary-button" type="button" onClick={() => void navigator.clipboard?.writeText(resultUrl)}>
        <Copy size={16} />
        {t(view.copyResultUrlLabel)}
      </button>
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
  return <MediaArtifactPreview artifact={artifact} cwd={cwd} variant="hero" className="media-job-detail-preview" />;
}
