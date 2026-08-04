import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { ApprovalRequest, MediaJob, MediaJobFormState, MediaOperation, ProviderPreset, RunArtifact } from "../../types.js";
import {
  readMediaJobsDomainBridge,
  type MediaJobArtifactState,
  type MediaJobArtifactsCompatMap,
  type MediaJobsDomainActions,
  type MediaJobsDomainState,
  type MediaMutationResult,
} from "../../domains/media/media-domain-types.js";
import { useI18n } from "../../i18n.js";
import { MediaJobCreateDialog } from "./MediaJobCreateDialog.js";
import { MediaJobInspector } from "./MediaJobInspector.js";
import { MediaJobList } from "./MediaJobList.js";
import { MediaJobsHeader } from "./MediaJobsHeader.js";
import type { MediaJobDisplayContextMap } from "./media-job-display-context.js";
import type { MediaJobHostActions } from "./media-job-display-context.js";
import { useMediaJobsPageController } from "./useMediaJobsPageController.js";

export interface MediaJobsPageProps {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: MediaJobArtifactsCompatMap;
  readonly form: MediaJobFormState;
  readonly selectedJobId: string;
  readonly isLoading: boolean;
  readonly runningJobId: string;
  readonly approvals?: readonly ApprovalRequest[];
  readonly onFormChange: (form: MediaJobFormState) => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onCreate: () => void | Promise<void | MediaMutationResult>;
  readonly onSelectJob: (jobId: string) => void;
  readonly onRun: (jobId: string) => void | Promise<void | MediaMutationResult>;
  readonly onOpenProviders: () => void;
  readonly onOpenProviderRepair?: (providerPresetId: string | undefined, operation: MediaOperation) => void;
  readonly onOpenApproval?: (approvalId: string) => void;
  readonly onRefreshApprovals?: () => Promise<void>;
  readonly jobContext?: MediaJobDisplayContextMap;
  readonly hostActions?: MediaJobHostActions;
  readonly domainState?: MediaJobsDomainState;
  readonly domainActions?: MediaJobsDomainActions;
}

export function MediaJobsPage(props: MediaJobsPageProps): JSX.Element {
  const { t } = useI18n();
  const bridge = readMediaJobsDomainBridge(props.artifactsByJob);
  const state = props.domainState ?? bridge?.state ?? legacyState(props);
  const actions = props.domainActions ?? bridge?.actions ?? legacyActions(props);
  const controller = useMediaJobsPageController({
    cwd: props.cwd,
    state,
    actions,
    providers: props.providers,
    approvals: props.approvals ?? [],
    jobContext: props.jobContext ?? {},
    hostActions: props.hostActions,
    navigation: {
      openApproval: props.onOpenApproval,
      openProviderRepair: props.onOpenProviderRepair,
      refreshApprovals: props.onRefreshApprovals,
    },
    onOpenProviders: props.onOpenProviders,
  });
  const initialLoading = state.loadPhase === "initial";
  return (
    <section className="media-jobs-page" aria-labelledby="media-jobs-title" data-media-jobs-surface>
      <MediaJobsHeader
        {...controller.summary}
        statusFilter={controller.statusFilter}
        hasRunnableModel={controller.runnableProviders.length > 0}
        onFilterChange={controller.setStatusFilter}
        onPrimaryAction={controller.openCreate}
      />
      {controller.loadError ? (
        <InlineFeedback className="media-jobs-feedback" tone="danger" title={t("Could not load generation tasks")}>
          <Button size="sm" onClick={() => void controller.refresh()}>{t("Retry")}</Button>
        </InlineFeedback>
      ) : controller.refreshError ? (
        <InlineFeedback className="media-jobs-feedback" tone="warning" title={t("Could not refresh generation tasks. Showing the last loaded data.")}>
          <Button size="sm" onClick={() => void controller.refresh()}>{t("Retry")}</Button>
        </InlineFeedback>
      ) : null}
      <div className="media-jobs-layout">
        <div className="media-jobs-list-pane">
          <MediaJobList
            cwd={props.cwd}
            projections={controller.visibleProjections}
            rows={controller.rows}
            selectedJobId={state.selectedMediaJobId}
            statusFilter={controller.statusFilter}
            initialLoading={initialLoading}
            loadFailed={Boolean(controller.loadError)}
            hasRunnableModel={controller.runnableProviders.length > 0}
            onAction={(action, projection) => void controller.dispatchAction(action, projection)}
            onCreate={controller.openCreate}
            onSelect={controller.selectJob}
            onShowAll={() => controller.setStatusFilter("all")}
          />
        </div>
        <MediaJobInspector
          cwd={props.cwd}
          projection={controller.selectedProjection}
          repair={controller.selectedRepair}
          initialLoading={initialLoading}
          copyError={controller.copyError}
          onAction={(action, projection) => void controller.dispatchAction(action, projection)}
          onRetryArtifacts={(jobId) => void controller.retryArtifacts(jobId)}
        />
      </div>
      <MediaJobCreateDialog
        open={controller.createOpen}
        busy={state.createPhase === "submitting"}
        form={state.form}
        errors={controller.formErrors}
        providers={controller.generationProviders}
        serverError={Boolean(controller.createError)}
        videoGeneration={controller.selectedRuntime?.videoGeneration}
        onOpenChange={(open) => open ? controller.openCreate() : controller.closeCreate()}
        onOperationChange={controller.changeOperation}
        onPatch={controller.patchForm}
        onSubmit={controller.submitCreate}
      />
    </section>
  );
}

function legacyState(props: MediaJobsPageProps): MediaJobsDomainState {
  const artifactsByJob = Object.fromEntries(Object.entries(props.artifactsByJob).map(([jobId, artifacts]) => [jobId, {
    signature: artifacts.map((item) => item.id).join("\u001f"), phase: "ready", artifacts,
  } satisfies MediaJobArtifactState]));
  return {
    mediaJobs: props.jobs, artifactsByJob, loadPhase: props.isLoading ? (props.jobs.length ? "refreshing" : "initial") : "idle",
    createPhase: "idle", runningJobIds: new Set(props.runningJobId ? [props.runningJobId] : []),
    selectedMediaJobId: props.selectedJobId, form: props.form, errors: [],
  };
}

function legacyActions(props: MediaJobsPageProps): MediaJobsDomainActions {
  return {
    setMediaJobForm: (value) => props.onFormChange(typeof value === "function" ? value(props.form) : value),
    setSelectedMediaJobId: (value) => props.onSelectJob(typeof value === "function" ? value(props.selectedJobId) : value),
    refreshMediaJobs: async () => { await props.onRefresh(); },
    createMediaJobFromForm: async () => { const result = await props.onCreate(); return result && typeof result === "object" ? result : { ok: false }; },
    executeMediaJob: async (jobId) => { const result = await props.onRun(jobId); return result && typeof result === "object" ? result : { ok: false, jobId }; },
    retryMediaJobArtifacts: async () => undefined, clearMediaError: () => undefined, resetForCwd: () => undefined,
  };
}
