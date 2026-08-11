import { CircleAlert, GitBranch, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  EmptyState,
  IconButton,
  InspectorSection,
  Skeleton,
} from "../../shared/ui/index.js";
import type { Channel, ExternalWorkStatusResponse } from "../../types.js";
import { ExternalWorkDetailList } from "./ExternalWorkDetailList.js";
import { ExternalWorkReadySurface, type ExternalWorkSettingsError } from "./ExternalWorkReadySurface.js";

export function ExternalWorkSettingsPanel({
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
  onRefreshExternalWork,
  selectedChannel,
}: {
  readonly error?: ExternalWorkSettingsError;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
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
  readonly onRefreshExternalWork: () => void;
  readonly selectedChannel: Channel | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const statusError = error?.kind === "status" || error?.kind === "triage" ? error : undefined;

  return (
    <section
      className="settings-external-work"
      aria-label={t("External work")}
      data-ui2-external-work
    >
      <header className="settings-external-work-header">
        <span>
          <GitBranch aria-hidden="true" />
          <strong>{t("Connection status")}</strong>
        </span>
        {selectedChannel ? (
          <IconButton
            icon={RefreshCw}
            label={t("Check status")}
            loading={externalWorkStatusLoading}
            onClick={onRefreshExternalWork}
          />
        ) : null}
      </header>

      {!selectedChannel ? (
        <EmptyState
          compact
          icon={<GitBranch />}
          title={t("Select a channel")}
          description={t("Choose a channel in the app before configuring external work.")}
        />
      ) : externalWorkStatusLoading && !externalWorkStatus ? (
        <ExternalWorkLoadingState label={t("Loading external work status")} />
      ) : !externalWorkStatus ? (
        <EmptyState
          compact
          icon={<CircleAlert />}
          title={t("External work status is unavailable")}
          description={t("Check the selected channel's workflow and credential state.")}
          action={(
            <Button leadingIcon={<RefreshCw />} onClick={onRefreshExternalWork}>
              {t("Check status")}
            </Button>
          )}
        />
      ) : (
        <ExternalWorkReadySurface
          error={error}
          externalWorkSecretAction={externalWorkSecretAction}
          externalWorkStatus={externalWorkStatus}
          externalWorkStatusAction={externalWorkStatusAction}
          externalWorkStatusLoading={externalWorkStatusLoading}
          externalWorkWorkflowAction={externalWorkWorkflowAction}
          onConfigureExternalWorkSecret={onConfigureExternalWorkSecret}
          onConfigureExternalWorkWorkflow={onConfigureExternalWorkWorkflow}
          onDeleteExternalWorkSecret={onDeleteExternalWorkSecret}
          onExternalWorkAction={onExternalWorkAction}
          selectedChannel={selectedChannel}
        />
      )}

      {statusError ? (
        <InspectorSection
          className="settings-external-work-details"
          title={t("Status error details")}
          summary={t("Needs attention")}
        >
          <ExternalWorkDetailList items={[{ label: t("Last operation error"), value: statusError.message }]} />
        </InspectorSection>
      ) : null}
    </section>
  );
}

function ExternalWorkLoadingState({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <div className="settings-external-work-loading" role="status" aria-label={label}>
      <Skeleton shape="block" height={62} width="100%" />
      <Skeleton shape="block" height={104} width="100%" />
      <Skeleton shape="block" height={82} width="100%" />
    </div>
  );
}
