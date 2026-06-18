import { useRef } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Image as ImageIcon,
  Loader2,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
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
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const generationProviders = providers.filter(providerHasGenerationCapability);
  const enabledGenerationProviders = generationProviders.filter((provider) => provider.enabled);
  const generationProvidersForOperation = generationProviders.filter((provider) => providerSupportsGenerationOperation(provider, form.operation));
  const runnableProvidersForOperation = generationProvidersForOperation.filter((provider) => canUseGenerationProviderForOperation(provider, form.operation));
  const selectedProvider = providers.find((provider) => provider.id === form.providerPresetId);
  const providerSupportsOperation = Boolean(selectedProvider?.capabilities.includes(form.operation));
  const selectedProviderCanRun = Boolean(selectedProvider && canUseGenerationProviderForOperation(selectedProvider, form.operation));
  const canCreate = Boolean(selectedProviderCanRun && form.prompt.trim());

  return (
    <div className="media-jobs-layout">
      <section className="panel media-job-list-panel" aria-labelledby="media-jobs-title">
        <div className="panel-title split">
          <span>
            <Database size={18} />
            <h2 id="media-jobs-title">{t("Generation tasks")}</h2>
          </span>
          <span className="media-job-title-actions">
            <button
              className="primary-button compact-button"
              type="button"
              aria-label={t("Jump to generation form")}
              onClick={() => promptRef.current?.focus()}
            >
              <Plus size={14} />
              {t("Create generation task")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
              {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {t("Refresh")}
            </button>
          </span>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="media-job-page-meta" aria-label={t("Generation task status")}>
          <span>{t("Generation models")} {generationProviders.length}</span>
          <span>{t("Enabled")} {enabledGenerationProviders.length}</span>
          <span>{t("Ready to generate")} {runnableProvidersForOperation.length}</span>
          <span>{t("Queued tasks")} {jobs.filter((job) => job.status === "queued").length}</span>
        </div>

        <div className="media-job-list">
          {jobs.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <Database />}
              <span>{isLoading ? t("Loading generation tasks...") : t("No generation tasks recorded for this workspace")}</span>
            </div>
          ) : (
            jobs.map((job) => {
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
                      <details className="media-job-prompt-disclosure">
                        <summary>{t("View prompt")}</summary>
                        <p>{job.prompt}</p>
                      </details>
                    </div>
                  </div>
                  {job.status === "waiting_for_approval" ? <small className="media-job-approval">{t("Approval required before live execution")}</small> : null}
                  {needsRecovery ? (
                    <div className="media-job-recovery">
                      <CircleAlert size={15} />
                      <span>
                        <strong>{hasMissingResult ? t("Result is missing") : t("Generation needs attention")}</strong>
                        <small>{job.errorMessage ? formatMediaJobError(job.errorMessage, t) : t("No usable result was returned. Try another run or choose a different model.")}</small>
                      </span>
                      <div>
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectJob(job.id);
                            onRun(job.id);
                          }}
                          disabled={isLoading || isRunningJob || !isRunnable}
                        >
                          {isRunningJob ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                          {t("Run again")}
                        </button>
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenProviders();
                          }}
                        >
                          <PlugZap size={14} />
                          {t("Change model")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {mediaArtifacts.length > 0 ? (
                    <div className="media-job-artifacts artifact-list" aria-label={`Artifacts for ${job.id}`}>
                      {mediaArtifacts.map((artifact) => (
                        <ArtifactRow artifact={artifact} cwd={cwd} key={artifact.id} />
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </section>

      <section className="panel media-job-form-panel" aria-labelledby="media-job-form-title">
        <div className="panel-title split">
          <span>
            <Plus size={18} />
            <h2 id="media-job-form-title">{t("Create generation task")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
            <PlugZap size={14} />
            {t("Model Workbench")}
          </button>
        </div>

        <div className={runnableProvidersForOperation.length > 0 ? "provider-next-action ok" : "provider-next-action"}>
          {runnableProvidersForOperation.length > 0 ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          <span>
            {runnableProvidersForOperation.length > 0
              ? t("Ready generation models can produce real results. Coding runs still require chat-capable models.")
              : t("当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。")}
          </span>
          {runnableProvidersForOperation.length === 0 ? (
            <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
              <PlugZap size={14} />
              {t("Open generation model settings")}
            </button>
          ) : null}
        </div>

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
            ref={promptRef}
            value={form.prompt}
            rows={8}
            placeholder={t("Describe the scene, style, ratio, and intended use...")}
            onChange={(event) => onFormChange({ ...form, prompt: event.target.value })}
          />
        </label>

        <details className="advanced-settings">
          <summary>{t("Advanced input")}</summary>
          <label className="field wide">
            <span>{t("Input JSON")}</span>
            <textarea value={form.inputText} rows={6} onChange={(event) => onFormChange({ ...form, inputText: event.target.value })} />
          </label>
        </details>

        <button className="primary-button" type="button" onClick={onCreate} disabled={isLoading || !canCreate}>
          {isLoading ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
          {t("Create generation task")}
        </button>
      </section>
    </div>
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
      <a className="media-job-result-preview file" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
        <ImageIcon size={20} />
        <strong>{t("{count} generated results", { count })}</strong>
      </a>
    );
  }
  return (
    <span className={`media-job-result-preview empty ${status}`}>
      {status === "failed" || status === "cancelled" ? <CircleAlert size={20} /> : <ImageIcon size={20} />}
      <strong>{status === "failed" || status === "cancelled" ? t("Needs recovery") : t("No result yet")}</strong>
    </span>
  );
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
