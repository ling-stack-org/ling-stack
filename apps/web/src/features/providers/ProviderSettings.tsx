import { useEffect, useMemo } from "react";
import { useI18n } from "../../i18n.js";
import {
  canUseProviderForRun,
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerNeedsSecret,
} from "../../lib/providers.js";
import { readRunProviderPresetId } from "../../lib/run-evidence.js";
import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
  RunSession,
} from "../../types.js";
import { ProviderDeleteDialog } from "./ProviderDeleteDialog.js";
import { ProviderEditorPanel } from "./ProviderEditorPanel.js";
import { ProviderModelImportPanel } from "./ProviderModelImportPanel.js";
import { ProviderRouteList } from "./ProviderRouteList.js";
import { ProviderWorkbenchHeader } from "./ProviderWorkbenchHeader.js";
import {
  ProviderNextAction,
  ProviderOperationFeedback,
  ProviderRunRepairPanel,
} from "./ProviderWorkbenchFeedback.js";
import type {
  ProviderBatchResult,
  ProviderCheckScope,
  ProviderImportResult,
  ProviderSaveResult,
} from "./types.js";
import { readProviderWorkbenchSummary, type ProviderSetupIntent } from "./provider-workbench-view-models.js";
import { useProviderEditorController } from "./useProviderEditorController.js";
import { useProviderFeedbackController } from "./useProviderFeedbackController.js";
import { useProviderRowCheckFeedback } from "./useProviderRowCheckFeedback.js";
import { useProviderWorkbenchController } from "./useProviderWorkbenchController.js";

export interface ProviderSettingsProps {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly templates: readonly ProviderTemplate[];
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isLoading: boolean;
  readonly checkingProviderIds: readonly string[];
  readonly errorMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkedProviderId: string;
  readonly checkScope: ProviderCheckScope | undefined;
  readonly batchResult: ProviderBatchResult | undefined;
  readonly operationWarning: string;
  readonly selectedProviderId: string;
  readonly selectedTemplateId: string;
  readonly repairRun: RunSession | undefined;
  readonly isRunning: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: (template: ProviderTemplate) => void;
  readonly onSave: () => Promise<ProviderSaveResult>;
  readonly onImportModels: (models: readonly ProviderModelOption[]) => Promise<ProviderImportResult>;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onCheckBatch: () => Promise<ProviderBatchResult | undefined>;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onStopUse: (provider: ProviderPreset) => void;
  readonly onToggleEnabled: (provider: ProviderPreset, enabled: boolean) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearCheckFeedback: (providerId: string) => void;
  readonly onClearRepair: () => void;
  readonly setupIntent?: ProviderSetupIntent | "";
  readonly onSetupIntentConsumed?: () => void;
  readonly settingsToolMode?: boolean;
}

export function ProviderSettings(props: ProviderSettingsProps): JSX.Element {
  const { t } = useI18n();
  const {
    providers, form, templates, editingProviderId, selectedTemplateId, checkingProviderIds,
    checkedProviderId, checkResult, checkScope, selectedProviderId, repairRun,
  } = props;
  const summary = useMemo(() => readProviderWorkbenchSummary(providers), [providers]);
  const isCheckingProviders = checkingProviderIds.length > 0;
  const isBatchChecking = isCheckingProviders && checkScope === "batch";
  const isSaveChecking = isCheckingProviders && checkScope === "save";
  const checkedProvider = checkedProviderId ? providers.find((provider) => provider.id === checkedProviderId) : undefined;
  const editorCheckProvider = checkedProvider ?? (editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined);
  const editorCheckSource = editorCheckProvider ?? (form.api === "media-job" ? { api: "media-job" as const } : undefined);
  const editorCheckMessage = checkResult ? providerCheckDisplayMessage(checkResult, editorCheckSource, t) : "";
  const editorCheckGuidance = checkResult ? providerCheckDisplayGuidance(checkResult, editorCheckSource, t) : "";
  const nextActionProvider = providers.find((provider) =>
    provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat") &&
    providerNeedsSecret(provider) && !provider.apiKeyConfigured
  ) ?? providers.find(canUseProviderForRun) ?? providers.find((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured);
  const repairProviderId = repairRun ? readRunProviderPresetId(repairRun) : "";
  const repairProvider = repairProviderId ? providers.find((provider) => provider.id === repairProviderId) : undefined;
  const workbench = useProviderWorkbenchController({
    providers,
    selectedProviderId,
    errorMessage: props.errorMessage,
    onDelete: props.onDelete,
  });
  const feedback = useProviderFeedbackController({
    onSave: props.onSave,
    onImportModels: props.onImportModels,
    onCheckBatch: props.onCheckBatch,
  });
  const rowCheckFeedback = useProviderRowCheckFeedback({
    providers,
    checkedProviderId,
    checkResult,
    checkScope,
    onCheck: props.onCheck,
    onClearCheckFeedback: props.onClearCheckFeedback,
  });
  const editor = useProviderEditorController({
    cwd: props.cwd,
    providers,
    templates,
    form,
    editingProviderId,
    selectedTemplateId,
    setupIntent: props.setupIntent ?? "",
    onSetupIntentConsumed: props.onSetupIntentConsumed,
    onFormChange: props.onFormChange,
    onTemplateSelect: props.onTemplateSelect,
    onNew: props.onNew,
    onEdit: props.onEdit,
    onSave: feedback.save,
    onImportModels: feedback.importModels,
  });

  useEffect(() => {
    if (repairRun && editingProviderId) editor.openCurrent();
  }, [editingProviderId, repairRun]);

  return (
    <div className={`provider-management-layout provider-workbench-surface${props.settingsToolMode ? " settings-return-mode" : ""}`}>
      <section
        className="provider-workbench"
        aria-label={props.settingsToolMode ? t("Model Workbench") : undefined}
        aria-labelledby={props.settingsToolMode ? undefined : "provider-workbench-title"}
      >
        <ProviderWorkbenchHeader
          summary={summary}
          providerSearch={workbench.query}
          providerStatusFilter={workbench.statusFilter}
          isLoading={props.isLoading}
          isCheckingProviders={isCheckingProviders}
          isBatchChecking={isBatchChecking}
          isStale={Boolean(props.errorMessage && providers.length)}
          onProviderSearchChange={workbench.setQuery}
          onProviderStatusFilterChange={workbench.setStatusFilter}
          onAddModel={() => editor.openNew()}
          onCheckBatch={() => void feedback.checkBatch()}
          settingsToolMode={props.settingsToolMode}
        />
        {props.errorMessage ? (
          <InlineFeedback className="provider-page-error inline-error" tone="danger" title={t("Error")}>
            <span>{props.errorMessage}</span>
            <Button size="sm" variant="secondary" onClick={props.onRefresh}>{t("Retry")}</Button>
          </InlineFeedback>
        ) : null}
        <ProviderNextAction providers={providers} nextActionProvider={nextActionProvider} isLoading={props.isLoading} />
        {repairRun ? (
          <ProviderRunRepairPanel
            run={repairRun}
            provider={repairProvider}
            isChecking={repairProvider ? checkingProviderIds.includes(repairProvider.id) : false}
            isRunning={props.isRunning}
            onEdit={editor.openEdit}
            onCheck={rowCheckFeedback.check}
            onRerun={props.onRerun}
            onOpenRun={props.onOpenRun}
            onClear={props.onClearRepair}
          />
        ) : null}
        <ProviderOperationFeedback
          batchResult={props.batchResult}
          operationWarning={props.operationWarning}
        />
        <ProviderRouteList
          providers={providers}
          filteredProviders={workbench.filteredProviders}
          selectedProviderId={selectedProviderId}
          isLoading={props.isLoading}
          isCheckingProviders={isCheckingProviders}
          checkingProviderIds={checkingProviderIds}
          checkedProviderId={checkedProviderId}
          checkResult={rowCheckFeedback.listCheckResult}
          checkScope={checkScope}
          hasActiveFilters={Boolean(workbench.query || workbench.statusFilter !== "all")}
          onClearFilters={workbench.clearFilters}
          onAddModel={editor.openNew}
          onEdit={editor.openEdit}
          onDelete={workbench.requestDelete}
          onCheck={rowCheckFeedback.check}
          onUse={props.onUse}
          onStopUse={props.onStopUse}
          onToggleEnabled={props.onToggleEnabled}
        />
        {workbench.filteredProviders.length > 0 ? (
          <div className="provider-table-footer" aria-label={t("Model preset table summary")}>
            {t("{count} model presets", { count: workbench.filteredProviders.length })}
          </div>
        ) : null}
      </section>
      {editor.isOpen ? (
        <ProviderEditorPanel
          supplierTemplates={editor.visibleSupplierTemplates}
          setupIntent={editor.setupIntent}
          selectedTemplateId={selectedTemplateId}
          form={form}
          editingProvider={editor.editingProvider}
          editingProviderId={editingProviderId}
          showApiKey={editor.showApiKey}
          canEditCustomProviderFields={editor.canEditCustomProviderFields}
          modelImportPanel={(
            <ProviderModelImportPanel
              modelOptions={editor.setupModelOptions}
              visibleModelOptions={editor.visibleModelOptions}
              modelOptionsSource={editor.modelOptionsSource}
              modelSearch={editor.modelSearch}
              selectedModelIds={editor.selectedModelIds}
              editingProviderId={editingProviderId}
              currentModel={form.model}
              isFetchingModels={editor.isFetchingModels}
              modelFetchError={editor.modelFetchError}
              modelSelectionNotice={editor.modelSelectionNotice}
              onFetchModels={() => void editor.fetchModels()}
              onModelSearchChange={editor.setModelSearch}
              onSelectAllVisible={editor.selectAllVisible}
              onClearSelection={editor.clearSelection}
              onSelectProviderModel={editor.selectModel}
              onToggleImportModel={editor.toggleModel}
            />
          )}
          editorErrorMessage={editor.editorErrorMessage}
          editorWarningMessage={editor.editorWarningMessage}
          checkResult={checkResult}
          editorCheckProviderName={editorCheckProvider?.displayName ?? ""}
          editorCheckMessage={editorCheckMessage}
          editorCheckGuidance={editorCheckGuidance}
          selectedImportCount={editor.selectedImportCount}
          isCheckingProviders={isCheckingProviders}
          isSaveChecking={isSaveChecking}
          onClose={editor.close}
          onTemplateSelect={props.onTemplateSelect}
          onResetModelDiscovery={editor.resetDiscovery}
          onFormChange={props.onFormChange}
          onShowApiKeyChange={editor.setShowApiKey}
          onSaveCurrentPreset={() => void editor.saveCurrent()}
          onPrimaryAction={() => void editor.submit()}
        />
      ) : null}
      <ProviderDeleteDialog
        busy={workbench.deleteBusy}
        errorMessage={workbench.deleteErrorMessage}
        target={workbench.deleteTarget}
        onCancel={workbench.closeDelete}
        onConfirm={workbench.confirmDelete}
      />
    </div>
  );
}
