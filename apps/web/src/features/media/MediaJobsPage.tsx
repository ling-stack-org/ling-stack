import { useState } from "react";
import { CircleAlert, Loader2, PlugZap, Plus, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  canUseGenerationProviderForOperation,
  providerHasGenerationCapability,
  providerModelRouteLabel,
  providerSupportsGenerationOperation,
} from "../../lib/providers.js";
import type {
  MediaJob,
  MediaJobFormState,
  MediaOperation,
  ProviderPreset,
  RunArtifact,
} from "../../types.js";
import { MediaJobAdvancedFields } from "./MediaJobAdvancedFields.js";
import { MediaJobDetailPanel } from "./MediaJobDetailPanel.js";
import { MediaJobList } from "./MediaJobList.js";
import {
  isMediaJobActiveStatus,
  mediaArtifactsForJob,
  mediaOperationLabel,
  type MediaJobStatusFilter,
} from "./media-job-view-models.js";

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
  const [statusFilter, setStatusFilter] = useState<MediaJobStatusFilter>("all");
  const generationProviders = providers.filter(providerHasGenerationCapability);
  const generationProvidersForOperation = generationProviders.filter((provider) => providerSupportsGenerationOperation(provider, form.operation));
  const runnableProvidersForOperation = generationProvidersForOperation.filter((provider) => canUseGenerationProviderForOperation(provider, form.operation));
  const selectedProvider = providers.find((provider) => provider.id === form.providerPresetId);
  const providerSupportsOperation = Boolean(selectedProvider?.capabilities.includes(form.operation));
  const selectedProviderCanRun = Boolean(selectedProvider && canUseGenerationProviderForOperation(selectedProvider, form.operation));
  const hasRunnableGenerationModel = runnableProvidersForOperation.length > 0;
  const canCreate = Boolean(selectedProviderCanRun && form.prompt.trim());
  const queuedCount = jobs.filter((job) => isMediaJobActiveStatus(job.status)).length;
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  const selectedProviderForJob = selectedJob ? providers.find((provider) => provider.id === selectedJob.providerPresetId) : undefined;
  const selectedJobArtifacts = selectedJob ? artifactsByJob[selectedJob.id] ?? [] : [];
  const selectedMediaArtifacts = mediaArtifactsForJob(selectedJobArtifacts);

  function createGenerationTask(): void {
    if (!canCreate) {
      return;
    }
    onCreate();
    setCreateOpen(false);
  }

  function openPrimaryAction(): void {
    if (!hasRunnableGenerationModel) {
      onOpenProviders();
      return;
    }
    setCreateOpen(true);
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
            onClick={openPrimaryAction}
            title={hasRunnableGenerationModel
              ? t("Choose a generation model in the task dialog.")
              : t("Open Model Workbench to configure an image or video generation model.")}
          >
            {hasRunnableGenerationModel ? <Plus size={16} /> : <PlugZap size={16} />}
            {hasRunnableGenerationModel ? t("Create generation task") : t("Configure generation model")}
          </button>
        </div>
      </header>

      {errorMessage ? (
        <div className="inline-error media-page-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {!hasRunnableGenerationModel ? (
        <div className="provider-next-action media-model-alert">
          <CircleAlert size={16} />
          <span>{t("当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。")}</span>
        </div>
      ) : null}

      <div className="media-jobs-layout">
        <MediaJobList
          cwd={cwd}
          jobs={jobs}
          providers={providers}
          artifactsByJob={artifactsByJob}
          selectedJobId={selectedJobId}
          runningJobId={runningJobId}
          isLoading={isLoading}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onSelectJob={onSelectJob}
          onRun={onRun}
        />

        <MediaJobDetailPanel
          cwd={cwd}
          job={selectedJob}
          providerName={selectedProviderForJob?.displayName ?? t("Unknown provider")}
          artifacts={selectedMediaArtifacts}
          isLoading={isLoading}
          isRunning={Boolean(selectedJob && runningJobId === selectedJob.id)}
          onCopy={() => {
            if (selectedJob) {
              void navigator.clipboard?.writeText(selectedJob.prompt);
            }
          }}
          onOpenProviders={onOpenProviders}
          onRun={() => {
            if (selectedJob) {
              onRun(selectedJob.id);
            }
          }}
        />
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
                        {providerModelRouteLabel(provider)}
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

              <details className="advanced-settings media-create-advanced" open>
                <summary>
                  <span>{t("Advanced parameters")}</span>
                  <small>{t(mediaAdvancedSummary(form.operation))}</small>
                </summary>
                <MediaJobAdvancedFields form={form} onFormChange={onFormChange} />
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

function mediaAdvancedSummary(operation: MediaOperation): string {
  if (operation === "video_generate") {
    return "Ratio, duration, watermark";
  }
  if (operation === "image_edit") {
    return "Source image and mask URL";
  }
  return "Size, count, seed, watermark";
}
