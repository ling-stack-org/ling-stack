import { Link2, RefreshCw, Workflow, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MediaJob, RunArtifact } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import { useFocusRevalidationToken } from "../../../shared/hooks/use-focus-revalidation-token.js";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  InlineFeedback,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../shared/ui/index.js";
import type {
  MediaWorkflowControllerActions,
  MediaWorkflowControllerState,
  MediaWorkflowFailure,
  MediaWorkflowLibraryTab,
} from "./media-workflow-types.js";
import {
  hasMediaWorkflowMutationBusy,
  selectMediaWorkflowFailure,
} from "./media-workflow-view-models.js";
import { WorkflowConnectionWorkspace } from "./WorkflowConnectionWorkspace.js";
import { WorkflowLibraryWorkspace } from "./WorkflowLibraryWorkspace.js";

export function MediaWorkflowLibraryDialog({
  open,
  tab,
  state,
  actions,
  mediaJobs,
  imageArtifacts,
  onTabChange,
  onClose,
}: {
  readonly open: boolean;
  readonly tab: MediaWorkflowLibraryTab;
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly onTabChange: (tab: MediaWorkflowLibraryTab) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const focusRevalidationToken = useFocusRevalidationToken({ enabled: open });
  const loadFailure = selectMediaWorkflowFailure(state.failures, "load");
  const initialLoading = state.phase === "initial-loading";
  const initialError = state.phase === "initial-error";
  const busy = hasMediaWorkflowMutationBusy(state);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || focusRevalidationToken === 0) return;
    void actions.refresh();
    // The focus token owns cadence; the controller owns request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRevalidationToken, open]);

  return (
    <Dialog busy={busy} open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        className={`media-workflow-dialog ${tab === "connections" ? "connections-view" : "workflows-view"}`}
        data-media-production-dialog="workflow-library"
        size="lg"
        onOpenAutoFocus={() => {
          if (document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          className="media-workflow-dialog-head"
          closeLabel={t("Close production workflows")}
          description={t("Connect or import a ComfyUI workflow")}
          title={t("Production workflow library")}
        />
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as MediaWorkflowLibraryTab)}>
          <TabsList className="media-workflow-tabs" aria-label={t("Production workflows")}>
            <TabsTrigger value="workflows"><Workflow aria-hidden="true" size={15} />{t("Workflows")}</TabsTrigger>
            <TabsTrigger value="connections"><Link2 aria-hidden="true" size={15} />{t("Connections")}</TabsTrigger>
          </TabsList>
          {loadFailure ? (
            <WorkflowLoadFailure
              failure={loadFailure}
              initial={initialError}
              onClear={() => actions.clearFailure("load")}
              onRetry={() => void actions.refresh()}
            />
          ) : null}
          <DialogBody className="media-workflow-dialog-body">
            {initialLoading || initialError ? (
              initialLoading ? <WorkflowDialogSkeleton /> : null
            ) : (
              <>
                <TabsContent value="workflows">
                  <WorkflowLibraryWorkspace
                    state={state}
                    actions={actions}
                    mediaJobs={mediaJobs}
                    imageArtifacts={imageArtifacts}
                    onOpenConnections={() => onTabChange("connections")}
                  />
                </TabsContent>
                <TabsContent value="connections">
                  <WorkflowConnectionWorkspace state={state} actions={actions} />
                </TabsContent>
              </>
            )}
          </DialogBody>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowDialogSkeleton(): JSX.Element {
  return (
    <div className="media-workflow-split-view" data-media-workflow-loading="initial">
      <div className="media-workflow-list-pane">
        <Skeleton height={32} width="70%" />
        <Skeleton height={52} shape="block" />
        <Skeleton height={52} shape="block" />
      </div>
      <div className="media-workflow-detail-pane">
        <Skeleton height={32} width="55%" />
        <Skeleton height={120} shape="block" />
      </div>
    </div>
  );
}

function WorkflowLoadFailure({
  failure,
  initial,
  onClear,
  onRetry,
}: {
  readonly failure: MediaWorkflowFailure;
  readonly initial: boolean;
  readonly onClear: () => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <InlineFeedback className="media-workflow-error" role="alert" title={t(failure.productMessageKey, failure.productMessageValues)} tone={initial ? "danger" : "warning"}>
      <div className="media-workflow-feedback-actions">
        <Button leadingIcon={<RefreshCw size={14} />} size="sm" variant="secondary" onClick={onRetry}>{t("Retry")}</Button>
        {!initial ? <Button leadingIcon={<X size={14} />} size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button> : null}
      </div>
      {failure.technicalMessage ? (
        <Collapsible>
          <CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger>
          <CollapsibleContent><code>{failure.technicalMessage}</code></CollapsibleContent>
        </Collapsible>
      ) : null}
    </InlineFeedback>
  );
}
