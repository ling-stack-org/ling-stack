import { CircleAlert, Loader2, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { providerCapabilityChipLabels } from "../../lib/providers.js";
import { OperationEmptyState } from "../../shared/components/index.js";
import type { ProviderModelOption } from "../../types.js";
import {
  modelThinkingModes,
  providerModelCapabilitySourceLabel,
  providerModelThinkingLabel,
} from "./provider-workbench-view-models.js";

export function ProviderModelImportPanel({
  modelOptions,
  visibleModelOptions,
  modelOptionsSource,
  modelSearch,
  selectedModelIds,
  editingProviderId,
  currentModel,
  isFetchingModels,
  modelFetchError,
  modelSelectionNotice,
  onFetchModels,
  onModelSearchChange,
  onSelectAllVisible,
  onClearSelection,
  onSelectProviderModel,
  onToggleImportModel,
}: {
  readonly modelOptions: readonly ProviderModelOption[];
  readonly visibleModelOptions: readonly ProviderModelOption[];
  readonly modelOptionsSource: string;
  readonly modelSearch: string;
  readonly selectedModelIds: readonly string[];
  readonly editingProviderId: string;
  readonly currentModel: string;
  readonly isFetchingModels: boolean;
  readonly modelFetchError: string;
  readonly modelSelectionNotice: string;
  readonly onFetchModels: () => void;
  readonly onModelSearchChange: (value: string) => void;
  readonly onSelectAllVisible: () => void;
  readonly onClearSelection: () => void;
  readonly onSelectProviderModel: (model: ProviderModelOption) => void;
  readonly onToggleImportModel: (model: ProviderModelOption) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="provider-model-discovery">
      <div className="provider-model-discovery-header">
        <span>
          <strong>{t("Available models")}</strong>
          <small>{modelOptionsSource ? t("Loaded from {source}", { source: modelOptionsSource }) : t("Fetch models from the configured supplier endpoint.")}</small>
        </span>
        <span className="provider-model-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={isFetchingModels}
            onClick={onFetchModels}
          >
            {isFetchingModels ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Fetch models")}
          </button>
        </span>
      </div>
      {modelOptions.length > 0 ? (
        <div className="provider-model-search-row">
          <label className="provider-model-search">
            <Search size={14} />
            <input
              aria-label={t("Search provider models")}
              value={modelSearch}
              placeholder={t("Search provider models")}
              onChange={(event) => onModelSearchChange(event.target.value)}
            />
          </label>
          <span className="provider-model-bulk-actions">
            <small className="provider-model-selection-count">{t("{count} selected", { count: selectedModelIds.length })}</small>
            <button className="secondary-button compact-button" type="button" onClick={onSelectAllVisible}>
              {t("Select visible")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onClearSelection} disabled={selectedModelIds.length === 0}>
              {t("Clear selection")}
            </button>
          </span>
        </div>
      ) : null}
      {modelOptions.length > 0 ? (
        <div className="provider-model-grid" aria-label={t("Available models")}>
          {visibleModelOptions.map((model) => {
            const modelCurrent = model.id === currentModel;
            const importSelected = selectedModelIds.includes(model.id);
            const modelSelected = editingProviderId ? modelCurrent : importSelected;
            const cardClassName = [
              "provider-model-card",
              modelSelected ? "selected" : "",
              editingProviderId && importSelected ? "import-selected" : "",
            ].filter(Boolean).join(" ");
            const activateModelRow = (): void => {
              if (editingProviderId) {
                onSelectProviderModel(model);
                return;
              }
              onToggleImportModel(model);
            };
            return (
              <div
                key={model.id}
                className={cardClassName}
                role="button"
                tabIndex={0}
                onClick={activateModelRow}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  activateModelRow();
                }}
              >
                <label className="provider-model-select-control" onClick={(event) => event.stopPropagation()}>
                  <input
                    aria-label={t("Select {model}", { model: model.displayName ?? model.id })}
                    type="checkbox"
                    checked={importSelected}
                    onChange={() => onToggleImportModel(model)}
                  />
                </label>
                <span className="provider-model-card-copy">
                  <strong>{model.displayName ?? model.id}</strong>
                  <small>{model.ownedBy ?? model.id}</small>
                  <em>{`${providerCapabilityChipLabels(model, t).join(" / ")} · ${providerModelCapabilitySourceLabel(model, t)}`}</em>
                </span>
                <span className={modelThinkingModes(model).length > 0 ? "provider-model-thinking-chip" : "provider-model-thinking-chip unsupported"}>
                  {providerModelThinkingLabel(model, t)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {modelOptions.length > 0 && visibleModelOptions.length === 0 ? (
        <OperationEmptyState
          compact
          icon={<Search />}
          title={t("No provider models match the current search")}
        />
      ) : null}
      {modelFetchError ? (
        <div className="model-fetch-error">
          <CircleAlert size={15} />
          <span>{t(modelFetchError)}</span>
        </div>
      ) : null}
      {modelSelectionNotice ? (
        <div className="model-fetch-error neutral">
          <CircleAlert size={15} />
          <span>{modelSelectionNotice}</span>
        </div>
      ) : null}
    </div>
  );
}
