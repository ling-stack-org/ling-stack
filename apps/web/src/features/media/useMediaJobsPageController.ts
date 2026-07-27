import { useEffect, useMemo, useState } from "react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { useLingToast } from "../../shared/ui/index.js";
import type { ApprovalRequest, MediaJob, MediaJobFormState, ProviderPreset } from "../../types.js";
import type { MediaJobsDomainActions, MediaJobsDomainState } from "../../domains/media/media-domain-types.js";
import { canUseGenerationProviderForOperation, providerSupportsGenerationOperation } from "../../lib/providers.js";
import { useI18n } from "../../i18n.js";
import { artifactContentUrl } from "../../api.js";
import type { MediaJobDisplayContextMap, MediaJobHostActions } from "./media-job-display-context.js";
import { mediaJobToReusableForm, validateMediaJobForm } from "./media-job-form-view-models.js";
import { deriveMediaJobSourceView, deriveMediaJobRepairView } from "./media-job-repair-view-models.js";
import { deriveMediaJobResultView } from "./media-job-result-view-models.js";
import {
  deriveMediaJobApprovalView,
  deriveMediaJobRowView,
  mediaJobMatchesProductFilter,
  summarizeMediaJobs,
} from "./media-job-state-view-models.js";
import type {
  MediaJobActionId,
  MediaJobFormErrors,
  MediaJobNavigationIntents,
  MediaJobProjectionInput,
  MediaJobStatusFilter,
} from "./media-job-types.js";

export function useMediaJobsPageController(input: {
  readonly cwd: string;
  readonly state: MediaJobsDomainState;
  readonly actions: MediaJobsDomainActions;
  readonly providers: readonly ProviderPreset[];
  readonly approvals: readonly ApprovalRequest[];
  readonly jobContext: MediaJobDisplayContextMap;
  readonly hostActions?: MediaJobHostActions;
  readonly navigation: MediaJobNavigationIntents;
  readonly onOpenProviders: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [statusFilter, setStatusFilter] = useState<MediaJobStatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [reuseMode, setReuseMode] = useState(false);
  const [formErrors, setFormErrors] = useState<MediaJobFormErrors>({});
  const [copyError, setCopyError] = useState("");
  const loadError = input.state.errors.find((item) => item.owner === "load");
  const refreshError = input.state.errors.find((item) => item.owner === "refresh");
  const createError = input.state.errors.find((item) => item.owner === "create");
  const projections = useMemo(() => input.state.mediaJobs.map((job) => projectJob(job)), [
    input.approvals,
    input.jobContext,
    input.providers,
    input.state.artifactsByJob,
    input.state.errors,
    input.state.mediaJobs,
    input.state.runningJobIds,
  ]);
  const visibleProjections = useMemo(
    () => projections.filter((projection) => mediaJobMatchesProductFilter(projection, statusFilter)),
    [projections, statusFilter],
  );
  const rows = useMemo(() => visibleProjections.map(deriveMediaJobRowView), [visibleProjections]);
  const summary = useMemo(() => summarizeMediaJobs(projections), [projections]);
  const selectedProjection = visibleProjections.find((item) => item.job.id === input.state.selectedMediaJobId) ?? visibleProjections[0];
  const selectedRepair = selectedProjection ? deriveMediaJobRepairView(selectedProjection) : undefined;
  const generationProviders = input.providers.filter((provider) => provider.api === "media-job" &&
    providerSupportsGenerationOperation(provider, input.state.form.operation));
  const runnableProviders = generationProviders.filter((provider) => canUseGenerationProviderForOperation(provider, input.state.form.operation));
  const selectedProvider = input.providers.find((provider) => provider.id === input.state.form.providerPresetId);
  const selectedRuntime = selectedProvider ? resolveMediaProviderRuntimeState(selectedProvider, input.state.form.operation) : undefined;

  useEffect(() => {
    const selectedStillVisible = visibleProjections.some((item) => item.job.id === input.state.selectedMediaJobId);
    if (!selectedStillVisible) input.actions.setSelectedMediaJobId(visibleProjections[0]?.job.id ?? "");
  }, [statusFilter, visibleProjections.map((item) => item.job.id).join("\u001f")]);

  useEffect(() => {
    setCreateOpen(false);
    setFormErrors({});
    setCopyError("");
  }, [input.cwd]);

  function projectJob(job: MediaJob): MediaJobProjectionInput {
    const result = deriveMediaJobResultView(job, input.state.artifactsByJob[job.id]);
    const source = deriveMediaJobSourceView(job, input.providers, input.jobContext[job.id]);
    return {
      job,
      result,
      source,
      approval: deriveMediaJobApprovalView(job, input.approvals),
      isRunning: input.state.runningJobIds.has(job.id),
      stale: Boolean(refreshError),
      context: input.jobContext[job.id],
    };
  }

  function openCreate(): void {
    if (runnableProviders.length === 0) {
      input.onOpenProviders();
      return;
    }
    setReuseMode(false);
    setFormErrors({});
    input.actions.clearMediaError("create");
    if (!input.state.form.providerPresetId || !runnableProviders.some((provider) => provider.id === input.state.form.providerPresetId)) {
      input.actions.setMediaJobForm((current) => ({ ...current, providerPresetId: runnableProviders[0]?.id ?? "" }));
    }
    setCreateOpen(true);
  }

  function closeCreate(): void {
    if (input.state.createPhase === "submitting") return;
    setCreateOpen(false);
    setFormErrors({});
    input.actions.clearMediaError("create");
  }

  function patchForm(patch: Partial<MediaJobFormState>, field?: keyof MediaJobFormErrors): void {
    input.actions.setMediaJobForm((current) => ({ ...current, ...patch }));
    if (field) setFormErrors((current) => ({ ...current, [field]: undefined }));
    input.actions.clearMediaError("create");
  }

  function changeOperation(operation: MediaJobFormState["operation"]): void {
    const providers = input.providers.filter((provider) => canUseGenerationProviderForOperation(provider, operation));
    patchForm({ operation, providerPresetId: reuseMode ? input.state.form.providerPresetId : providers[0]?.id ?? "" }, "operation");
  }

  async function submitCreate(): Promise<void> {
    const errors = validateMediaJobForm(input.state.form, {
      cwd: input.cwd,
      providerAvailable: Boolean(selectedRuntime?.canRun),
      allowedRatios: selectedRuntime?.videoGeneration?.aspectRatios,
      allowedDurations: selectedRuntime?.videoGeneration?.durationsSeconds,
    });
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const result = await input.actions.createMediaJobFromForm();
    if (!result.ok) return;
    setCreateOpen(false);
    showToast({ message: t("Generation task created"), scope: `media-job:${result.jobId}:create`, tone: "success" });
  }

  async function refresh(reason: "manual" | "repair-return" = "manual"): Promise<void> {
    if (reason === "manual" && input.navigation.refreshApprovals) {
      await Promise.all([input.actions.refreshMediaJobs(input.cwd, reason), input.navigation.refreshApprovals()]);
      return;
    }
    await input.actions.refreshMediaJobs(input.cwd, reason);
  }

  async function dispatchAction(actionId: MediaJobActionId, projection: MediaJobProjectionInput): Promise<void> {
    const job = projection.job;
    if (actionId === "start" || actionId === "retry") await input.actions.executeMediaJob(job.id);
    else if (actionId === "refresh") await refresh();
    else if (actionId === "open_approval" && projection.approval.kind === "pending") input.navigation.openApproval?.(projection.approval.id);
    else if (actionId === "repair_provider") input.navigation.openProviderRepair?.(job.providerPresetId, job.operation) ?? input.onOpenProviders();
    else if (actionId === "repair_workflow") openWorkflow(projection);
    else if (actionId === "repair_connection") openConnection(projection);
    else if (actionId === "copy_prompt") await copy(job.prompt, job.id, "copy-prompt");
    else if (actionId === "copy_result_link" && projection.result.primary) await copy(artifactContentUrl(projection.result.primary.id, input.cwd), job.id, "copy-result");
    else if (actionId === "reuse_settings") reuse(projection);
  }

  async function copy(value: string, jobId: string, scope: string): Promise<void> {
    setCopyError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(value);
      showToast({ message: t(scope === "copy-prompt" ? "Copy prompt" : "Copy result URL"), scope: `media-job:${jobId}:${scope}`, tone: "success" });
    } catch {
      setCopyError(t("Could not copy to the clipboard"));
    }
  }

  function reuse(projection: MediaJobProjectionInput): void {
    const providerExists = Boolean(projection.job.providerPresetId && input.providers.some((item) => item.id === projection.job.providerPresetId));
    input.actions.setMediaJobForm(mediaJobToReusableForm(projection.job, providerExists));
    setReuseMode(true);
    setFormErrors({});
    setCreateOpen(true);
    showToast({ message: t("Settings copied to a new task"), scope: `media-job:${projection.job.id}:reuse`, tone: "success" });
  }

  function openWorkflow(projection: MediaJobProjectionInput): void {
    input.hostActions?.openWorkflow(projection.source.kind === "workflow" ? projection.source.definitionId : undefined);
  }

  function openConnection(projection: MediaJobProjectionInput): void {
    if (projection.source.kind === "workflow") {
      input.hostActions?.openWorkflowConnection(projection.source.connection.id || undefined);
    }
  }

  return {
    copyError, createError, createOpen, formErrors, generationProviders, loadError, refreshError,
    rows, runnableProviders, selectedProjection, selectedRepair, selectedRuntime, statusFilter, summary, visibleProjections,
    changeOperation, closeCreate, dispatchAction, openCreate, patchForm, refresh, setStatusFilter, submitCreate,
    selectJob: input.actions.setSelectedMediaJobId,
    retryArtifacts: input.actions.retryMediaJobArtifacts,
  };
}
