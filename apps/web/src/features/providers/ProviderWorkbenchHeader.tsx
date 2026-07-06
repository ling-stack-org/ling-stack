import { CheckCircle2, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { PageActionHeader } from "../../shared/components/index.js";
import type { ProviderStatusFilter, ProviderWorkbenchSummary } from "./provider-workbench-view-models.js";

export function ProviderWorkbenchHeader({
  summary,
  providerSearch,
  providerStatusFilter,
  isLoading,
  isCheckingProviders,
  isBatchChecking,
  onProviderSearchChange,
  onProviderStatusFilterChange,
  onAddModel,
  onCheckBatch,
  onRefresh,
  settingsToolMode = false,
}: {
  readonly summary: ProviderWorkbenchSummary;
  readonly providerSearch: string;
  readonly providerStatusFilter: ProviderStatusFilter;
  readonly isLoading: boolean;
  readonly isCheckingProviders: boolean;
  readonly isBatchChecking: boolean;
  readonly onProviderSearchChange: (value: string) => void;
  readonly onProviderStatusFilterChange: (value: ProviderStatusFilter) => void;
  readonly onAddModel: () => void;
  readonly onCheckBatch: () => void;
  readonly onRefresh: () => void;
  readonly settingsToolMode?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const meta = (
    <div className="provider-page-meta" aria-label={t("Provider workbench action summary")}>
      <span>{t("Ready to use")} {summary.readyCount}</span>
      <span>{t("Needs config")} {summary.needsAttentionCount}</span>
      <span>{t("Missing key")} {summary.missingSecretCount}</span>
      <span>{t("Disabled")} {summary.disabledCount}</span>
    </div>
  );
  const readinessSummary = (
    <div className="provider-readiness-strip" aria-label={t("Model readiness summary")}>
      <span className={summary.chatReadyCount > 0 ? "ready" : "attention"}>
        <strong>{summary.chatReadyCount}</strong>
        <small>{t("Chat ready")}</small>
      </span>
      <span className={summary.generationReadyCount > 0 ? "ready" : "attention"}>
        <strong>{summary.generationReadyCount}</strong>
        <small>{t("Image generation ready")}</small>
      </span>
      <span className={summary.missingSecretCount > 0 ? "attention" : "quiet"}>
        <strong>{summary.missingSecretCount}</strong>
        <small>{t("Need API key")}</small>
      </span>
      <span className={summary.disabledCount > 0 ? "quiet" : "ready"}>
        <strong>{summary.disabledCount}</strong>
        <small>{t("Disabled")}</small>
      </span>
    </div>
  );
  const secondaryActions = (
    <>
      <button className="secondary-button compact-button" type="button" onClick={onCheckBatch} disabled={isCheckingProviders || summary.batchCheckProviderCount === 0}>
        {isBatchChecking ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
        {t("Check all")}
      </button>
      <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading || isCheckingProviders}>
        {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
        {t("Refresh")}
      </button>
    </>
  );
  const primaryAction = (
    <button className="primary-button compact-button" type="button" onClick={onAddModel}>
      <Plus size={15} />
      {t("Add model")}
    </button>
  );
  const toolbarControls = (
    <div className="provider-toolbar-controls" aria-label={t("Model preset filters")}>
      <label className="provider-search-field">
        <Search size={15} />
        <input
          aria-label={t("Search model presets")}
          value={providerSearch}
          placeholder={t("Search name, model, or endpoint")}
          onChange={(event) => onProviderSearchChange(event.target.value)}
        />
      </label>
      <select
        aria-label={t("Filter model presets")}
        value={providerStatusFilter}
        onChange={(event) => onProviderStatusFilterChange(event.target.value as ProviderStatusFilter)}
      >
        <option value="all">{t("All presets")}</option>
        <option value="ready">{t("Ready presets")}</option>
        <option value="needsAttention">{t("Needs attention")}</option>
        <option value="missingKey">{t("Missing key")}</option>
        <option value="disabled">{t("Disabled providers")}</option>
      </select>
    </div>
  );

  if (settingsToolMode) {
    return (
      <header className="provider-workbench-header settings-return-mode">
        {readinessSummary}
        <div className="provider-header-tools">
          <div className="provider-title-actions">
            {primaryAction}
            {secondaryActions}
          </div>
          {toolbarControls}
        </div>
      </header>
    );
  }

  return (
    <header className="provider-workbench-header">
      <PageActionHeader
        title={<span id="provider-workbench-title">{t("Model Workbench")}</span>}
        description={t("Manage and configure all available model presets.")}
        meta={meta}
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        className="provider-page-action-header"
      />
      {readinessSummary}
      {toolbarControls}
    </header>
  );
}
