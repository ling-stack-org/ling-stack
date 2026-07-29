import { Activity, Play, Power, PowerOff, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { ExternalWorkStatusResponse } from "../../types.js";
import { ExternalWorkDetailList } from "./ExternalWorkDetailList.js";
import {
  externalWorkBackgroundState,
  externalWorkLastError,
} from "./external-work-settings-view-models.js";

type ExternalWorkStatusAction = "poll" | "reconcile" | "start" | "stop";

export function ExternalWorkOperationsSection({
  action,
  errorMessage,
  onAction,
  status,
}: {
  readonly action: ExternalWorkStatusAction | undefined;
  readonly errorMessage?: string;
  readonly onAction: (action: ExternalWorkStatusAction) => Promise<boolean>;
  readonly status: ExternalWorkStatusResponse;
}): JSX.Element {
  const { t } = useI18n();
  const background = externalWorkBackgroundState(status);
  const recordedError = externalWorkLastError(status);
  const busy = action !== undefined;
  const canStart = status.workflow.sourceKind === "github" && status.background.status !== "running";
  const canStop = status.background.status === "running";

  return (
    <section className="settings-external-work-section" aria-labelledby="settings-external-work-operations-title">
      <h2 id="settings-external-work-operations-title">{t("Operations")}</h2>
      <DataRow
        className="settings-external-work-row"
        identity={(
          <span className="settings-external-work-identity">
            <Activity aria-hidden="true" />
            <span>
              <strong>{t("Background polling")}</strong>
              <small>{backgroundSummary(status.background.status, t)}</small>
            </span>
          </span>
        )}
        status={<StatusIndicator compact label={t(background.label)} tone={background.tone} />}
        actions={canStart || canStop ? (
          canStop ? (
            <Button
              size="sm"
              leadingIcon={<PowerOff />}
              loading={action === "stop"}
              loadingLabel={t("Stopping background polling")}
              disabled={busy && action !== "stop"}
              onClick={() => void onAction("stop")}
            >
              {t("Stop background")}
            </Button>
          ) : (
            <Button
              size="sm"
              leadingIcon={<Power />}
              loading={action === "start"}
              loadingLabel={t("Starting background polling")}
              disabled={!status.workflow.valid || (busy && action !== "start")}
              onClick={() => void onAction("start")}
            >
              {t("Start background")}
            </Button>
          )
        ) : undefined}
      />

      <div className="settings-external-work-operation-actions">
        <Button
          leadingIcon={<Play />}
          loading={action === "poll"}
          loadingLabel={t("Polling external work")}
          disabled={!status.workflow.valid || (busy && action !== "poll")}
          onClick={() => void onAction("poll")}
        >
          {t("Poll once")}
        </Button>
        <Button
          variant="ghost"
          leadingIcon={<RefreshCw />}
          loading={action === "reconcile"}
          loadingLabel={t("Reconciling external work")}
          disabled={busy && action !== "reconcile"}
          onClick={() => void onAction("reconcile")}
        >
          {t("Reconcile")}
        </Button>
      </div>

      {recordedError || errorMessage ? (
        <InlineFeedback tone="danger">
          {t("An external work operation failed. Review details and retry when ready.")}
        </InlineFeedback>
      ) : null}

      <InspectorSection
        className="settings-external-work-details"
        title={t("Operation details")}
        summary={t(background.label)}
      >
        <ExternalWorkDetailList
          items={[
            { label: t("Background status"), value: t(background.label) },
            ...(status.background.schedulerId
              ? [{ label: t("Scheduler ID"), value: status.background.schedulerId }]
              : []),
            ...(status.background.lastTickAt
              ? [{ label: t("Last poll"), value: status.background.lastTickAt }]
              : []),
            ...(status.background.nextPollAt
              ? [{ label: t("Next poll"), value: status.background.nextPollAt }]
              : []),
            ...(recordedError ? [{ label: t("Recorded error"), value: recordedError }] : []),
            ...(errorMessage ? [{ label: t("Last operation error"), value: errorMessage }] : []),
          ]}
        />
      </InspectorSection>
    </section>
  );
}

function backgroundSummary(
  status: ExternalWorkStatusResponse["background"]["status"],
  t: (key: string) => string,
): string {
  if (status === "running") return t("New external items are checked in the background.");
  if (status === "failed") return t("Background polling needs attention before it can continue.");
  if (status === "unsupported") return t("Background polling is not available for this source.");
  return t("Run a one-time poll or start background polling when needed.");
}
