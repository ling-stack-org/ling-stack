import { useState } from "react";
import {
  CircleAlert,
  Copy,
  Database,
  Image as ImageIcon,
  Loader2,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName, isImageArtifact } from "../../lib/artifacts.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  canUseGenerationProviderForOperation,
  providerHasGenerationCapability,
  providerSupportsGenerationOperation,
} from "../../lib/providers.js";
import { ArtifactRow, StatusBadge } from "../../shared/components/index.js";
import type {
  MediaJob,
  MediaJobFormState,
  MediaJobStatus,
  MediaOperation,
  ProviderPreset,
  RunArtifact,
} from "../../types.js";

export function MediaJobsPage({
  cwd,
  providers,
  jobs,
  artifactsByJob,
  form,
  selectedJobId,
  isLoading,
  runningJobId,
  errorMessage,
  onFormChange,
  onRefresh,
  onCreate,
  onSelectJob,
  onRun,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Record<string, readonly RunArtifact[]>;
  readonly form: MediaJobFormState;
  readonly selectedJobId: string;
  readonly isLoading: boolean;
  readonly runningJobId: string;
  readonly errorMessage: string;
  readonly onFormChange: (form: MediaJobFormState) => void;
  readonly onRefresh: () => void;
  readonly onCreate: () => void;
  readonly onSelectJob: (jobId: string) => void;
  readonly onRun: (jobId: string) => void;
  readonly onOpenProviders: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "succeeded" | "failed" | "queued">("all");
  const generationProviders = providers.filter(providerHasGenerationCapability);
  const enabledGenerationProviders = generationProviders.filter((provider) => provider.enabled);
  const generationProvidersForOperation = generationProviders.filter((provider) => providerSupportsGenerationOperation(provider, form.operation));
  const runnableProvidersForOperation = generationProvidersForOperation.filter((provider) => canUseGenerationProviderForOperation(provider, form.operation));
  const selectedProvider = providers.find((provider) => provider.id === form.providerPresetId);
  const providerSupportsOperation = Boolean(selectedProvider?.capabilities.includes(form.operation));
  const selectedProviderCanRun = Boolean(selectedProvider && canUseGenerationProviderForOperation(selectedProvider, form.operation));
  const canCreate = Boolean(selectedProviderCanRun && form.prompt.trim());
  const queuedCount = jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "waiting_for_approval").length;
  const filteredJobs = jobs.filter((job) => {
    if (statusFilter === "all") {
      return true;
    }
    if (statusFilter === "queued") {
      return job.status === "queued" || job.status === "running" || job.status === "waiting_for_approval";
    }
    return job.status === statusFilter;
  });
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  const selectedProviderForJob = selectedJob ? providers.find((provider) => provider.id === selectedJob.providerPresetId) : undefined;
  const selectedJobArtifacts = selectedJob ? artifactsByJob[selectedJob.id] ?? [] : [];
  const selectedMediaArtifacts = selectedJobArtifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");

  function createGenerationTask(): void {
    if (!canCreate) {
      return;
    }
    onCreate();
    setCreateOpen(false);
  }

  return (
    <div className="media-jobs-page">
      <header className="media-jobs-page-header">
        <div>
          <h1 id="media-jobs-title">{t("Generation tasks")}</h1>
          <p>
            {t("{modelCount} available generation models · {taskCount} history tasks · {queuedCount} queued", {
              modelCount: runnableProvidersForOperation.length,
              taskCount: jobs.length,
              queuedCount,
            })}
          </p>
        </div>
        <div className="media-job-title-actions">
          <button className="secondary-button compact-button media-refresh-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            {isLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          <button
            className="primary-button media-create-button"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} />
            {t("Create generation task")}
          </button>
        </div>
      </header>

      {errorMessage ? (
        <div className="inline-error media-page-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {runnableProvidersForOperation.length === 0 ? (
        <div className="provider-next-action media-model-alert">
          <CircleAlert size={16} />
          <span>{t("当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。")}</span>
          <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
            <PlugZap size={14} />
            {t("Open generation model settings")}
          </button>
        </div>
      ) : null}

      <div className="media-jobs-layout">
        <section className="media-job-list-panel" aria-labelledby="media-jobs-title">
          <div className="media-job-filter-bar" aria-label={t("Generation task status")}>
            {([
              ["all", t("All")],
              ["succeeded", t("Succeeded")],
              ["failed", t("Failed")],
              ["queued", t("Queued")],
            ] as const).map(([filter, label]) => (
              <button
                key={filter}
                className={statusFilter === filter ? "active" : ""}
                type="button"
                onClick={() => setStatusFilter(filter)}
              >
                {label}
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
              const mediaArtifacts = jobArtifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");
              const hasMissingResult = job.artifactIds.length > 0 && mediaArtifacts.length === 0;
              const isRunnable = job.status === "queued" || job.status === "waiting_for_approval" || job.status === "failed" || job.status === "cancelled" || hasMissingResult;
              const isRunningJob = runningJobId === job.id;
              const operationLabel = t(mediaOperationLabel(job.operation));
              const statusLabel = t(mediaJobStatusLabel(job.status));
              const primaryArtifact = mediaArtifacts[0];
              const needsRecovery = Boolean(job.errorMessage || hasMissingResult);
              const actionLabel = job.status === "failed" || job.status === "cancelled" ? t("Run again") : t("Run");
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
                  <div className="media-job-result-layout">
                    <MediaJobResultPreview artifact={primaryArtifact} count={mediaArtifacts.length} cwd={cwd} status={job.status} />
                    <div className="media-job-summary">
                      <div className="media-job-row-head">
                        <span className="media-job-title">
                          <strong>{operationLabel}</strong>
                          <small>{provider?.displayName ?? t("Unknown provider")} · {formatDateTime(job.createdAt)}</small>
                        </span>
                        <span className="media-job-actions">
                          <StatusBadge status={job.status} />
                          <button
                            className={needsRecovery ? "primary-button compact-button" : "secondary-button compact-button"}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectJob(job.id);
                              onRun(job.id);
                            }}
                            disabled={isLoading || isRunningJob || !isRunnable}
                            title={isRunnable ? t("Run generation") : t("Cannot run while task is {status}", { status: statusLabel })}
                          >
                            {isRunningJob ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                            {isRunningJob ? t("Running") : actionLabel}
                          </button>
                        </span>
                      </div>
                      <div className="provider-meta-line">
                        <span>{statusLabel}</span>
                        <span>{t("{count} generated results", { count: mediaArtifacts.length })}</span>
                        <time>{formatDateTime(job.updatedAt)}</time>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
          </div>
        </section>

        <aside className="media-job-detail-panel" aria-label={t("Generation task details")}>
          {selectedJob ? (
            <MediaJobDetail
              cwd={cwd}
              job={selectedJob}
              providerName={selectedProviderForJob?.displayName ?? t("Unknown provider")}
              artifacts={selectedMediaArtifacts}
              isLoading={isLoading}
              isRunning={runningJobId === selectedJob.id}
              onCopy={() => void navigator.clipboard?.writeText(selectedJob.prompt)}
              onOpenProviders={onOpenProviders}
              onRun={() => onRun(selectedJob.id)}
            />
          ) : (
            <div className="media-job-detail-empty">
              <ImageIcon size={20} />
              <strong>{t("No generation task selected")}</strong>
              <span>{t("Create or select a task to inspect its prompt and artifacts.")}</span>
            </div>
          )}
        </aside>
      </div>

      {isCreateOpen ? (
        <div className="media-create-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setCreateOpen(false);
          }
        }}>
          <section className="media-create-dialog" role="dialog" aria-modal="true" aria-label={t("Create generation task")}>
            <header className="media-create-header">
              <div>
                <h2>{t("Create generation task")}</h2>
                <p>{t("Choose a model, write a prompt, then submit a generation task")}</p>
              </div>
              <button className="ghost-icon-button" type="button" onClick={() => setCreateOpen(false)} aria-label={t("Cancel")} title={t("Cancel")}>
                <X size={18} />
              </button>
            </header>

            <div className="media-create-body">
              {runnableProvidersForOperation.length === 0 ? (
                <div className="provider-next-action compact">
                  <CircleAlert size={16} />
                  <span>{t("当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。")}</span>
                  <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
                    <PlugZap size={14} />
                    {t("Open generation model settings")}
                  </button>
                </div>
              ) : null}

              <div className="media-job-form-toolbar" aria-label={t("Generation task controls")}>
                <label className="field wide">
                  <span>{t("Generation model")}</span>
                  <select
                    value={selectedProvider && providerSupportsOperation ? form.providerPresetId : ""}
                    onChange={(event) => onFormChange({ ...form, providerPresetId: event.target.value })}
                    disabled={generationProvidersForOperation.length === 0}
                  >
                    <option value="">{t("Select generation model")}</option>
                    {generationProvidersForOperation.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName} / {provider.model}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field wide">
                  <span>{t("Operation")}</span>
                  <select
                    value={form.operation}
                    onChange={(event) => {
                      const operation = event.target.value as MediaOperation;
                      const nextProvider = generationProviders.find((provider) => canUseGenerationProviderForOperation(provider, operation)) ??
                        generationProviders.find((provider) => providerSupportsGenerationOperation(provider, operation));
                      onFormChange({ ...form, operation, providerPresetId: nextProvider?.id ?? "" });
                    }}
                  >
                    <option value="image_generate">{t("Image generate")}</option>
                    <option value="image_edit">{t("Image edit")}</option>
                    <option value="video_generate">{t("Video generate")}</option>
                  </select>
                </label>
              </div>

              {selectedProvider && !providerSupportsOperation ? (
                <div className="provider-run-notice">
                  <CircleAlert size={16} />
                  <span>{t("{providerName} does not support {operation}.", { providerName: selectedProvider.displayName, operation: t(mediaOperationLabel(form.operation)) })}</span>
                </div>
              ) : null}

              {selectedProvider && providerSupportsOperation && !selectedProviderCanRun ? (
                <div className="provider-run-notice">
                  <CircleAlert size={16} />
                  <span>{t("当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。")}</span>
                </div>
              ) : null}

              <label className="field wide media-job-prompt-composer">
                <span>{t("Prompt")}</span>
                <textarea
                  value={form.prompt}
                  rows={8}
                  maxLength={2000}
                  placeholder={t("Describe the scene, style, ratio, and intended use...")}
                  onChange={(event) => onFormChange({ ...form, prompt: event.target.value })}
                />
                <small>{form.prompt.length} / 2000</small>
              </label>

              <details className="advanced-settings media-create-advanced">
                <summary>
                  <span>{t("Advanced settings")}</span>
                  <small>{t("Seed: random, negative prompt: none")}</small>
                </summary>
                <label className="field wide">
                  <span>{t("Input JSON")}</span>
                  <textarea value={form.inputText} rows={6} onChange={(event) => onFormChange({ ...form, inputText: event.target.value })} />
                </label>
              </details>
            </div>

            <footer className="media-create-footer">
              <span>
                <CircleAlert size={15} />
                {t("This will create a queued task")}
              </span>
              <button className="secondary-button" type="button" onClick={() => setCreateOpen(false)}>
                {t("Cancel")}
              </button>
              <button className="primary-button" type="button" onClick={createGenerationTask} disabled={isLoading || !canCreate}>
                {isLoading ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                {t("Create generation task")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
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
  const canRun = job.status === "queued" || job.status === "waiting_for_approval" || job.status === "failed" || job.status === "cancelled" || (job.artifactIds.length > 0 && artifacts.length === 0);
  const hasMissingResult = job.artifactIds.length > 0 && artifacts.length === 0;
  const needsRecovery = Boolean(job.errorMessage || hasMissingResult);
  const size = mediaJobInputValue(job.input, ["size", "resolution", "image_size", "imageSize"]);
  const seed = mediaJobInputValue(job.input, ["seed"]);
  const steps = mediaJobInputValue(job.input, ["steps", "num_steps", "numSteps"]);
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
            : t("This task is ready to run when approvals and model settings are satisfied.")}
      </p>

      {primaryArtifact ? (
        <MediaJobResultHero artifact={primaryArtifact} cwd={cwd} />
      ) : (
        <span className={`media-job-detail-preview empty ${job.status}`}>
          {isRunning ? <Loader2 className="spin" size={22} /> : needsRecovery ? <CircleAlert size={22} /> : <ImageIcon size={22} />}
          <strong>{isRunning ? t("Running") : needsRecovery ? t("Needs recovery") : t("No result yet")}</strong>
        </span>
      )}

      <div className="media-job-detail-actions">
        <button className={needsRecovery ? "primary-button" : "secondary-button"} type="button" onClick={onRun} disabled={isLoading || isRunning || !canRun}>
          {isRunning ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
          {isRunning ? t("Running") : needsRecovery ? t("Run again") : t("Run")}
        </button>
        <button className="secondary-button" type="button" onClick={onCopy}>
          <Copy size={16} />
          {t("Copy details")}
        </button>
      </div>

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
        <CircleAlert size={20} />
      </a>
    );
  }
  return (
    <span className={`media-job-result-preview empty ${status}`} aria-label={t(mediaJobStatusLabel(status))}>
      {status === "running" ? <Loader2 className="spin" size={20} /> : <CircleAlert size={20} />}
    </span>
  );
}

function mediaJobInputValue(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "--";
}

function mediaOperationLabel(operation: MediaOperation): string {
  if (operation === "image_generate") {
    return "Image generation";
  }
  if (operation === "image_edit") {
    return "Image editing";
  }
  return "Video generation";
}

function mediaJobStatusLabel(status: MediaJobStatus): string {
  if (status === "queued") {
    return "Queued";
  }
  if (status === "running") {
    return "Running";
  }
  if (status === "waiting_for_approval") {
    return "Waiting for approval";
  }
  if (status === "succeeded") {
    return "Succeeded";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Cancelled";
}

function formatMediaJobError(errorMessage: string, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  const normalized = errorMessage.trim();
  if (!normalized) {
    return t("Generation task failed.");
  }
  if (normalized === "This operation was aborted" || normalized === "This operation was aborted." || normalized === "The operation was aborted.") {
    return t("Generation task was cancelled.");
  }
  if (normalized === "No generated media artifact was returned." || normalized.includes("No returned image") || normalized.includes("No returned video")) {
    return t("No generated media artifact was returned.");
  }
  if (normalized.includes("invalid_request")) {
    return t("The provider rejected this generation request. Check the model, prompt, and account permissions.");
  }
  return t(normalized);
}
