import { GitBranch } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { Channel, ExternalWorkStatusResponse } from "../../types.js";
import { ExternalWorkActivitySummary } from "./ExternalWorkActivitySummary.js";
import { ExternalWorkCredentialSection } from "./ExternalWorkCredentialSection.js";
import { ExternalWorkOperationsSection } from "./ExternalWorkOperationsSection.js";
import { ExternalWorkWorkflowSection } from "./ExternalWorkWorkflowSection.js";
import { externalWorkOverallState, externalWorkTarget } from "./external-work-settings-view-models.js";

export interface ExternalWorkSettingsError {
  readonly kind: "background" | "credential" | "poll" | "reconcile" | "status" | "triage" | "workflow";
  readonly message: string;
}

export function ExternalWorkReadySurface({
  error,
  externalWorkSecretAction,
  externalWorkStatus,
  externalWorkStatusAction,
  externalWorkStatusLoading,
  externalWorkWorkflowAction,
  onConfigureExternalWorkSecret,
  onConfigureExternalWorkWorkflow,
  onDeleteExternalWorkSecret,
  onExternalWorkAction,
  selectedChannel,
}: {
  readonly error?: ExternalWorkSettingsError;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly onConfigureExternalWorkSecret: (token: string) => Promise<boolean>;
  readonly onConfigureExternalWorkWorkflow: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<boolean>;
  readonly onDeleteExternalWorkSecret: () => Promise<boolean>;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => Promise<boolean>;
  readonly selectedChannel: Channel;
}): React.JSX.Element {
  const { t } = useI18n();
  const overall = externalWorkOverallState(externalWorkStatus);
  const target = externalWorkTarget(externalWorkStatus);
  const operationError = error && ["background", "poll", "reconcile"].includes(error.kind)
    ? error.message
    : undefined;

  return (
    <>
      <DataRow
        className="settings-external-work-overall-row"
        loading={externalWorkStatusLoading}
        identity={(
          <span className="settings-external-work-identity">
            <GitBranch aria-hidden="true" />
            <span>
              <strong>{selectedChannel.name}</strong>
              <small>{target ?? t("No external target configured")}</small>
            </span>
          </span>
        )}
        status={<StatusIndicator label={t(overall.label)} tone={overall.tone} />}
      />

      {!selectedChannel.boundPath ? (
        <InlineFeedback tone="warning">
          {t("Bind this channel to a repository path before enabling polling.")}
        </InlineFeedback>
      ) : null}
      {error?.kind === "status" ? (
        <InlineFeedback tone="danger">
          {t("External work status could not be refreshed. The last loaded state is still shown.")}
        </InlineFeedback>
      ) : null}
      {error?.kind === "triage" ? (
        <InlineFeedback tone="warning">
          {t("The activity summary could not be refreshed. The last loaded counts are still shown.")}
        </InlineFeedback>
      ) : null}

      <ExternalWorkWorkflowSection
        busy={externalWorkWorkflowAction === "configure"}
        errorMessage={error?.kind === "workflow" ? error.message : undefined}
        status={externalWorkStatus}
        onConfigure={onConfigureExternalWorkWorkflow}
      />
      <ExternalWorkCredentialSection
        action={externalWorkSecretAction}
        errorMessage={error?.kind === "credential" ? error.message : undefined}
        status={externalWorkStatus}
        onConfigure={onConfigureExternalWorkSecret}
        onDelete={onDeleteExternalWorkSecret}
      />
      <ExternalWorkOperationsSection
        action={externalWorkStatusAction}
        errorMessage={operationError}
        status={externalWorkStatus}
        onAction={onExternalWorkAction}
      />
      <ExternalWorkActivitySummary status={externalWorkStatus} />
    </>
  );
}
