import {
  CheckCircle2,
  CircleAlert,
  Database,
  Loader2,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { canUseMediaProviderForOperation, isLiveMediaProvider, isMediaProvider } from "../../lib/providers.js";
import { ArtifactRow, MetaRow, StatusBadge } from "../../shared/components/index.js";
import type {
  MediaJob,
  MediaJobFormState,
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
  const mediaProviders = providers.filter(isMediaProvider);
  const enabledMediaProviders = mediaProviders.filter((provider) => provider.enabled);
  const liveMediaProviders = mediaProviders.filter(isLiveMediaProvider);
  const runnableProvidersForOperation = mediaProviders.filter((provider) => canUseMediaProviderForOperation(provider, form.operation));
  const selectedProvider = providers.find((provider) => provider.id === form.providerPresetId);
  const providerSupportsOperation = Boolean(selectedProvider?.capabilities.includes(form.operation));
  const selectedProviderCanRun = Boolean(selectedProvider && canUseMediaProviderForOperation(selectedProvider, form.operation));
  const canCreate = Boolean(selectedProviderCanRun && form.prompt.trim());

  return (
    <div className="media-jobs-layout">
      <section className="panel media-job-list-panel" aria-labelledby="media-jobs-title">
        <div className="panel-title split">
          <span>
            <Database size={18} />
            <h2 id="media-jobs-title">{t("Media jobs")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="provider-onboarding-strip" aria-label="Media job status">
          <MetaRow label={t("Media providers")} value={String(mediaProviders.length)} compact />
          <MetaRow label={t("Enabled")} value={String(enabledMediaProviders.length)} compact />
          <MetaRow label={t("Live ready")} value={String(liveMediaProviders.length)} compact />
          <MetaRow label={t("Queued jobs")} value={String(jobs.filter((job) => job.status === "queued").length)} compact />
        </div>

        <div className="media-job-list">
          {jobs.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <Database />}
              <span>{isLoading ? t("Loading media jobs...") : t("No media jobs recorded for this workspace")}</span>
            </div>
          ) : (
            jobs.map((job) => {
              const provider = providers.find((item) => item.id === job.providerPresetId);
              const jobArtifacts = artifactsByJob[job.id] ?? [];
              const mediaArtifacts = jobArtifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");
              const isRunnable = job.status === "queued" || job.status === "waiting_for_approval" || job.status === "failed" || job.status === "cancelled";
              const isRunningJob = runningJobId === job.id;
              return (
                <article
                  key={job.id}
                  className={selectedJobId === job.id ? "media-job-row selected" : "media-job-row"}
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
                  <div className="media-job-row-head">
                    <strong>{job.operation}</strong>
                    <span className="media-job-actions">
                      <StatusBadge status={job.status} />
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectJob(job.id);
                          onRun(job.id);
                        }}
                        disabled={isLoading || isRunningJob || !isRunnable}
                        title={isRunnable ? t("Run media adapter") : t("Cannot run from {status}", { status: job.status })}
                      >
                        {isRunningJob ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                        {t("Run")}
                      </button>
                    </span>
                  </div>
                  <p>{job.prompt}</p>
                  <div className="provider-meta-line">
                    <span>{provider?.displayName ?? t("Unknown provider")}</span>
                    <span>{t("{count} media results", { count: mediaArtifacts.length })}</span>
                    <time>{formatDateTime(job.createdAt)}</time>
                  </div>
                  {job.status === "waiting_for_approval" ? <small className="media-job-approval">{t("Approval required before live execution")}</small> : null}
                  {job.errorMessage ? <small className="media-job-error">{job.errorMessage}</small> : null}
                  {mediaArtifacts.length > 0 ? (
                    <div className="media-job-artifacts artifact-list" aria-label={`Artifacts for ${job.id}`}>
                      {mediaArtifacts.map((artifact) => (
                        <ArtifactRow artifact={artifact} cwd={cwd} key={artifact.id} />
                      ))}
                    </div>
                  ) : job.artifactIds.length > 0 ? (
                    <small className="media-job-error">{t("No generated media artifact was returned.")}</small>
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
            <h2 id="media-job-form-title">{t("Create media job")}</h2>
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
              ? t("Ready media models can generate real results. Coding task runs still require chat providers.")
              : t("当前没有可真实生成的媒体模型，请先在模型工作台配置媒体模型。")}
          </span>
        </div>

        <label className="field wide">
          <span>{t("Media provider")}</span>
          <select
            value={selectedProviderCanRun ? form.providerPresetId : ""}
            onChange={(event) => onFormChange({ ...form, providerPresetId: event.target.value })}
            disabled={runnableProvidersForOperation.length === 0}
          >
            <option value="">{t("Select media provider")}</option>
            {runnableProvidersForOperation.map((provider) => (
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
              const nextProvider = mediaProviders.find((provider) => canUseMediaProviderForOperation(provider, operation));
              onFormChange({ ...form, operation, providerPresetId: nextProvider?.id ?? "" });
            }}
          >
            <option value="image_generate">{t("Image generate")}</option>
            <option value="image_edit">{t("Image edit")}</option>
            <option value="video_generate">{t("Video generate")}</option>
          </select>
        </label>

        {selectedProvider && !providerSupportsOperation ? (
          <div className="provider-run-notice">
            <CircleAlert size={16} />
            <span>{t("{providerName} does not support {operation}.", { providerName: selectedProvider.displayName, operation: form.operation })}</span>
          </div>
        ) : null}

        {selectedProvider && providerSupportsOperation && !selectedProviderCanRun ? (
          <div className="provider-run-notice">
            <CircleAlert size={16} />
            <span>{t("当前没有可真实生成的媒体模型，请先在模型工作台配置媒体模型。")}</span>
          </div>
        ) : null}

        <label className="field wide">
          <span>{t("Prompt")}</span>
          <textarea value={form.prompt} rows={6} onChange={(event) => onFormChange({ ...form, prompt: event.target.value })} />
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
          {t("Create media job")}
        </button>
      </section>
    </div>
  );
}
