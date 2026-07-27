import { Info, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { providerCapabilityChipLabels } from "../../lib/providers.js";
import {
  Badge,
  Button,
  Checkbox,
  DataRow,
  EmptyState,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
} from "../../shared/ui/index.js";
import type { ProviderModelOption } from "../../types.js";
import {
  providerModelCapabilitySourceLabel,
  providerModelThinkingLabel,
} from "./provider-discovery-view-models.js";

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
    <section className="provider-model-discovery" aria-label={t("Available models")}>
      <div className="provider-model-discovery-header">
        <strong>{t("Available models")}</strong>
        <span className="provider-model-actions">
          <Button
            className="provider-model-fetch"
            size="sm"
            leadingIcon={<RefreshCw />}
            loading={isFetchingModels}
            loadingLabel={t("Loading")}
            onClick={onFetchModels}
          >
            {t("Fetch models")}
          </Button>
        </span>
      </div>
      {modelOptionsSource ? (
        <InspectorSection className="provider-model-source-details" title={t("Source")}>
          <small>{t("Loaded from {source}", { source: modelOptionsSource })}</small>
        </InspectorSection>
      ) : null}
      {modelOptions.length > 0 ? (
        <div className="provider-model-search-row">
          <Input
            aria-label={t("Search provider models")}
            containerClassName="provider-model-search"
            prefix={<Search />}
            size="sm"
            value={modelSearch}
            placeholder={t("Search provider models")}
            onChange={(event) => onModelSearchChange(event.target.value)}
          />
          <span className="provider-model-bulk-actions">
            <small className="provider-model-selection-count">{t("{count} selected", { count: selectedModelIds.length })}</small>
            <Button size="sm" onClick={onSelectAllVisible}>{t("Select visible")}</Button>
            <Button size="sm" disabled={selectedModelIds.length === 0} onClick={onClearSelection}>{t("Clear selection")}</Button>
          </span>
        </div>
      ) : null}
      {modelOptions.length > 0 ? (
        <div className="provider-model-grid" role="listbox" aria-multiselectable={!editingProviderId}>
          {visibleModelOptions.map((model) => {
            const current = model.id === currentModel;
            const importSelected = selectedModelIds.includes(model.id);
            const selected = editingProviderId ? current : importSelected;
            const capabilityLabel = providerCapabilityChipLabels(model, t).join(" / ");
            const modelInfo = [
              model.ownedBy,
              providerModelCapabilitySourceLabel(model, t),
              providerModelThinkingLabel(model, t),
            ].filter(Boolean).join(" · ");
            const activate = (): void => editingProviderId ? onSelectProviderModel(model) : onToggleImportModel(model);
            return (
              <DataRow
                key={model.id}
                className={`provider-model-card${selected ? " selected" : ""}${editingProviderId && importSelected ? " import-selected" : ""}`}
                selected={selected}
                onClick={activate}
                identity={(
                  <span className="provider-model-card-copy">
                    <strong>{model.displayName ?? model.id}</strong>
                    {model.displayName && model.displayName !== model.id ? <small>{model.id}</small> : null}
                  </span>
                )}
                summary={<Badge className="provider-model-usage-label" tone="neutral">{capabilityLabel}</Badge>}
                actions={(
                  <span className="provider-model-row-actions" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={t("Select {model}", { model: model.displayName ?? model.id })}
                      checked={importSelected}
                      onChange={() => onToggleImportModel(model)}
                    />
                    <IconButton className="provider-model-info" icon={Info} label={modelInfo} />
                  </span>
                )}
              />
            );
          })}
        </div>
      ) : null}
      {modelOptions.length > 0 && visibleModelOptions.length === 0 ? (
        <EmptyState compact icon={<Search />} title={t("No provider models match the current search")} />
      ) : null}
      {modelFetchError ? <InlineFeedback className="model-fetch-error" tone="danger">{t(modelFetchError)}</InlineFeedback> : null}
      {modelSelectionNotice ? <InlineFeedback className="model-fetch-error neutral" tone="info">{modelSelectionNotice}</InlineFeedback> : null}
    </section>
  );
}
