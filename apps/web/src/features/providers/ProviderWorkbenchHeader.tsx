import { CheckCircle2, Plus, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
} from "../../shared/ui/index.js";
import type {
  ProviderCapabilityFilter,
  ProviderStatusFilter,
  ProviderWorkbenchSummary,
} from "./provider-workbench-view-models.js";
import {
  DesktopTitlebarSurface,
  useDesktopTitlebarPlacement,
} from "../../app/DesktopTitlebarSurface.js";

export function ProviderWorkbenchHeader({
  summary,
  providerSearch,
  providerStatusFilter,
  providerCapabilityFilter,
  isCheckingProviders,
  isBatchChecking,
  onProviderSearchChange,
  onProviderStatusFilterChange,
  onProviderCapabilityFilterChange,
  onAddModel,
  onCheckBatch,
  showBatchCheckAction = true,
  settingsToolMode = false,
}: {
  readonly summary: ProviderWorkbenchSummary;
  readonly providerSearch: string;
  readonly providerStatusFilter: ProviderStatusFilter;
  readonly providerCapabilityFilter: ProviderCapabilityFilter;
  readonly isCheckingProviders: boolean;
  readonly isBatchChecking: boolean;
  readonly onProviderSearchChange: (value: string) => void;
  readonly onProviderStatusFilterChange: (value: ProviderStatusFilter) => void;
  readonly onProviderCapabilityFilterChange: (value: ProviderCapabilityFilter) => void;
  readonly onAddModel: () => void;
  readonly onCheckBatch: () => void;
  readonly showBatchCheckAction?: boolean;
  readonly settingsToolMode?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const titlebarPlacement = useDesktopTitlebarPlacement();
  const hasModels = summary.totalCount > 0;
  const filterControls = (
    <>
      <Input
        aria-label={t("Search model presets")}
        containerClassName="provider-search-field"
        prefix={<Search />}
        size="sm"
        value={providerSearch}
        placeholder={t("Search name, model, or endpoint")}
        onChange={(event) => onProviderSearchChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && providerSearch) {
            event.preventDefault();
            onProviderSearchChange("");
          }
        }}
      />
      <Select
        aria-label={t("Filter model presets")}
        containerClassName="provider-status-filter"
        size="sm"
        value={providerStatusFilter}
        onChange={(event) => onProviderStatusFilterChange(event.target.value as ProviderStatusFilter)}
      >
        <option value="all">{t("All presets")}</option>
        <option value="ready">{t("Ready presets")}</option>
        <option value="needsAttention">{t("Needs attention")}</option>
        <option value="missingKey">{t("Missing key")}</option>
        <option value="disabled">{t("Disabled providers")}</option>
      </Select>
      <SegmentedControl
        aria-label={t("Model capability filters")}
        className="provider-capability-filter"
        size="sm"
        value={providerCapabilityFilter}
        onValueChange={(value) => onProviderCapabilityFilterChange(value as ProviderCapabilityFilter)}
      >
        <SegmentedControlItem value="all">{t("All models")}</SegmentedControlItem>
        <SegmentedControlItem value="video">{t("Video")}</SegmentedControlItem>
        <SegmentedControlItem value="image">{t("Image")}</SegmentedControlItem>
        <SegmentedControlItem value="chat">{t("Chat")}</SegmentedControlItem>
      </SegmentedControl>
    </>
  );
  const actionControls = (
    <>
      {hasModels ? (
        <Button className="provider-add-model-action" size="sm" variant="primary" leadingIcon={<Plus />} onClick={onAddModel}>{t("Add model")}</Button>
      ) : null}
      {hasModels && showBatchCheckAction ? (
        <Button
          className="provider-check-all-action"
          size="sm"
          leadingIcon={<CheckCircle2 />}
          loading={isBatchChecking}
          loadingLabel={t("Checking")}
          disabled={isCheckingProviders || summary.batchCheckProviderCount === 0}
          onClick={onCheckBatch}
        >
          {t("Check all")}
        </Button>
      ) : null}
    </>
  );
  return (
    <>
      <DesktopTitlebarSurface>
        <header
          className={settingsToolMode ? "provider-workbench-header settings-return-mode" : "provider-workbench-header"}
          data-desktop-window-drag-region="true"
        >
          {!settingsToolMode || titlebarPlacement === "window" ? (
            <div className="provider-workbench-title-block">
              <h1 id="provider-workbench-title">{t("Model Workbench")}</h1>
            </div>
          ) : null}
          <div className="provider-header-tools provider-toolbar-controls" aria-label={t("Model preset filters")}>
            {titlebarPlacement === "inline" && hasModels ? filterControls : null}
            {actionControls}
          </div>
        </header>
      </DesktopTitlebarSurface>
      {titlebarPlacement === "window" && hasModels ? (
        <div className="provider-workbench-inline-tools">
          <div className="provider-toolbar-controls" aria-label={t("Model preset filters")}>{filterControls}</div>
        </div>
      ) : null}
    </>
  );
}
