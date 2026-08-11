import { Clapperboard, FolderPlus, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  EmptyState,
  InlineFeedback,
  InspectorSection,
  Skeleton,
} from "../../shared/ui/index.js";
import { selectMediaProductionFailure } from "./media-production-project-view-models.js";
import type { MediaProductionActions, MediaProductionFailure, MediaProductionState } from "./media-production-types.js";

export function MediaProductionLoadState({
  actions,
  state,
}: {
  readonly actions: MediaProductionActions;
  readonly state: MediaProductionState;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const loadFailure = selectMediaProductionFailure(state.failures, ["project-list", "project-detail"]);
  const createFailure = selectMediaProductionFailure(state.failures, ["project-create"]);
  const waitingForInitialData = state.listPhase === "initial"
    || state.listPhase === "loading"
    || (!state.project && state.projects.length > 0 && (state.detailPhase === "loading" || state.detailPhase === "refreshing"));

  if (waitingForInitialData) {
    return (
      <div className="media-production-load-state" role="status" aria-label={t("Loading media projects")}>
        <Skeleton shape="block" height={42} width="100%" />
        <Skeleton shape="block" height={180} width="100%" />
        <span className="ling-ui-sr-only">{t("Loading media projects")}</span>
      </div>
    );
  }

  if (!state.project && loadFailure && (state.listPhase === "error" || state.detailPhase === "error")) {
    return (
      <div className="media-production-load-state media-production-load-error">
        <FailureFeedback
          failure={loadFailure}
          tone="danger"
          onClear={undefined}
          onRetry={() => void actions.retryFailure(loadFailure)}
        />
      </div>
    );
  }

  if (state.listPhase === "ready" && state.projects.length === 0) {
    return (
      <div className="media-production-empty-state" data-media-production-empty="authoritative">
        {createFailure ? (
          <FailureFeedback
            failure={createFailure}
            tone="danger"
            onClear={() => actions.clearFailure(createFailure.owner, createFailure.subjectId)}
            onRetry={() => void actions.retryFailure(createFailure)}
          />
        ) : null}
        <EmptyState
          description={t("Split a video into ordered scenes, then generate and choose each clip independently.")}
          icon={<Clapperboard size={30} strokeWidth={1.6} />}
          title={t("Create your first media project")}
          action={(
            <Button
              leadingIcon={<FolderPlus size={16} />}
              loading={state.busy.projectCreate}
              loadingLabel={t("Creating media project")}
              variant="primary"
              onClick={() => void actions.createProject()}
            >
              {t("New project")}
            </Button>
          )}
        />
      </div>
    );
  }

  if (loadFailure) {
    return (
      <FailureFeedback
        failure={loadFailure}
        tone="warning"
        onClear={() => actions.clearFailure(loadFailure.owner, loadFailure.subjectId)}
        onRetry={() => void actions.retryFailure(loadFailure)}
      />
    );
  }

  return null;
}

function FailureFeedback({
  failure,
  onClear,
  onRetry,
  tone,
}: {
  readonly failure: MediaProductionFailure;
  readonly onClear: (() => void) | undefined;
  readonly onRetry: () => void;
  readonly tone: "danger" | "warning";
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <InlineFeedback
      className="media-production-load-feedback"
      role={tone === "danger" ? "alert" : "status"}
      title={t(failure.productMessageKey)}
      tone={tone}
    >
      <div className="media-production-load-feedback-actions">
        <Button leadingIcon={<RefreshCw size={15} />} size="sm" variant="secondary" onClick={onRetry}>
          {t("Retry")}
        </Button>
        {onClear ? (
          <Button leadingIcon={<X size={15} />} size="sm" variant="ghost" onClick={onClear}>
            {t("Clear")}
          </Button>
        ) : null}
      </div>
      {failure.technicalMessage ? (
        <InspectorSection title={t("Technical details")} summary={t("Error details")}>
          <code>{failure.technicalMessage}</code>
        </InspectorSection>
      ) : null}
    </InlineFeedback>
  );
}
