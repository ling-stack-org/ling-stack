import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { ApprovalRequest, MediaOperation, ProviderPreset } from "../../types.js";
import {
  type MediaJobsDomainActions,
  type MediaJobsDomainState,
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
  readonly domainState: MediaJobsDomainState;
  readonly domainActions: MediaJobsDomainActions;
  readonly approvals?: readonly ApprovalRequest[];
  readonly onOpenProviders: () => void;
  readonly onOpenProviderRepair?: (providerPresetId: string | undefined, operation: MediaOperation) => void;
  readonly onOpenApproval?: (approvalId: string) => void;
  readonly onRefreshApprovals?: () => Promise<void>;
  readonly jobContext?: MediaJobDisplayContextMap;
  readonly hostActions?: MediaJobHostActions;
}

export function MediaJobsPage(props: MediaJobsPageProps): React.JSX.Element {
  const { t } = useI18n();
  const controller = useMediaJobsPageController({
    cwd: props.cwd,
    state: props.domainState,
    actions: props.domainActions,
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
  const initialLoading = props.domainState.loadPhase === "initial";
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
            selectedJobId={props.domainState.selectedMediaJobId}
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
        busy={props.domainState.createPhase === "submitting"}
        form={props.domainState.form}
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
