import { CheckCircle2, History, Pencil, RotateCcw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  canUseProviderForRun,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { readRunProviderPresetId } from "../../lib/run-evidence.js";
import { Button, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ProviderPreset, RunSession } from "../../types.js";
import type { ProviderBatchResult } from "./types.js";

export function ProviderOperationFeedback({
  batchResult,
  operationWarning,
}: {
  readonly batchResult: ProviderBatchResult | undefined;
  readonly operationWarning: string;
}): JSX.Element | null {
  const { t } = useI18n();
  if (!batchResult && !operationWarning) return null;

  return (
    <>
      {batchResult && batchResult.failedCount > 0 ? (
        <InlineFeedback className="provider-batch-result bad" tone="danger" title={t("Needs attention")}>
          <span>{t(batchResult.message)}</span>
          <small>{t("Review the failed provider checks, fix the affected capability, then check again.")}</small>
        </InlineFeedback>
      ) : null}
      {operationWarning ? (
        <InlineFeedback className="provider-operation-warning" tone="warning" title={t("Needs attention")}>
          {operationWarning}
        </InlineFeedback>
      ) : null}
    </>
  );
}

export function ProviderNextAction({
  providers,
  nextActionProvider,
  isLoading,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly nextActionProvider: ProviderPreset | undefined;
  readonly isLoading: boolean;
}): JSX.Element | null {
  const { t } = useI18n();
  if (isLoading || providers.some(providerPreflightReady)) return null;
  let message = providers.length === 0
    ? t("Next: add a chat model for conversations or a generation model for image tasks.")
    : t("Next: enable a chat provider with a supported API protocol, then Save.");
  if (nextActionProvider && providerNeedsSecret(nextActionProvider) && !nextActionProvider.apiKeyConfigured) {
    message = t("Next: add an API key for {providerName}, then Save.", { providerName: nextActionProvider.displayName });
  } else if (nextActionProvider && canUseProviderForRun(nextActionProvider)) {
    message = !nextActionProvider.lastCheck
      ? t("Next: Save {providerName} before using it in Workspace.", { providerName: nextActionProvider.displayName })
      : !nextActionProvider.lastCheck.ok
        ? t("Next: repair {providerName} check failure ({status}), then run Check again.", {
          providerName: nextActionProvider.displayName,
          status: providerCheckStatusLabel(nextActionProvider.lastCheck, t),
        })
        : message;
  }
  return <InlineFeedback className="provider-next-action" tone="warning">{message}</InlineFeedback>;
}

export function ProviderRunRepairPanel({
  run,
  provider,
  isChecking,
  isRunning,
  onEdit,
  onCheck,
  onRerun,
  onOpenRun,
  onClear,
}: {
  readonly run: RunSession;
  readonly provider: ProviderPreset | undefined;
  readonly isChecking: boolean;
  readonly isRunning: boolean;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const ready = provider ? providerPreflightReady(provider) : false;
  const checkText = provider
    ? provider.lastCheck
      ? `${providerCheckStatusLabel(provider.lastCheck, t)}: ${providerCheckMessage(provider.lastCheck, t)}`
      : t("Provider has not been checked yet.")
    : t("The provider preset used by this run is missing.");
  return (
    <InlineFeedback className="provider-run-repair" tone="warning" title={t("Repair failed run provider")}>
      <div className="provider-run-repair-copy">
        <span>{t("Run")} <code>{run.id}</code> {t("failed with")} <strong>{provider?.displayName ?? (readRunProviderPresetId(run) || t("missing provider"))}</strong>.</span>
        {run.errorMessage ? <small>{run.errorMessage}</small> : null}
      </div>
      <div className="provider-run-repair-steps">
        <StatusIndicator label={provider ? t("provider found") : t("provider missing")} tone={provider ? "success" : "danger"} />
        <StatusIndicator label={ready ? t("preflight ready") : provider ? providerRunPreflightBlocker(provider, t) : t("cannot rerun")} tone={ready ? "success" : "warning"} />
      </div>
      <InspectorSection title={t("Check details")}><small>{checkText}</small></InspectorSection>
      <div className="provider-run-repair-actions">
        <Button size="sm" leadingIcon={<Pencil />} disabled={!provider} onClick={() => provider && onEdit(provider)}>{t("Edit provider")}</Button>
        <Button size="sm" leadingIcon={<CheckCircle2 />} loading={isChecking} disabled={!provider || isRunning} onClick={() => provider && onCheck(provider.id)}>{t("Check provider")}</Button>
        <Button size="sm" variant="primary" leadingIcon={<RotateCcw />} loading={isRunning} disabled={!ready || isChecking} onClick={() => onRerun(run)}>{t("Rerun")}</Button>
        <Button size="sm" leadingIcon={<History />} onClick={() => onOpenRun(run.id)}>{t("Back to run")}</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button>
      </div>
    </InlineFeedback>
  );
}
