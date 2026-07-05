import {
  CheckCircle2,
  CircleAlert,
  History,
  Loader2,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { listProviderModels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import {
  canUseProviderForRun,
  customOpenAICompatibleForm,
  normalizeProviderModelForImport,
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerFormToTemplate,
  providerFormWithSelectedModel,
  providerModelRouteLabel,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { readRunProviderPresetId } from "../../lib/run-evidence.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
  RunSession,
} from "../../types.js";
import type { ProviderBatchResult, ProviderCheckScope } from "./types.js";
import { ProviderEditorPanel } from "./ProviderEditorPanel.js";
import { ProviderModelImportPanel } from "./ProviderModelImportPanel.js";
import { ProviderRouteList } from "./ProviderRouteList.js";
import { ProviderWorkbenchHeader } from "./ProviderWorkbenchHeader.js";
import {
  filterProviderWorkbenchRoutes,
  normalizeProviderEndpoint,
  providerModelSourceLabel,
  readProviderWorkbenchSummary,
  type ProviderStatusFilter,
} from "./provider-workbench-view-models.js";

const customOpenAICompatibleTemplateId = "custom-openai-compatible";

export interface ProviderSaveResult {
  readonly ok: boolean;
  readonly errorMessage?: string;
  readonly warningMessage?: string;
}

export function ProviderSettings({
  cwd,
  providers,
  templates,
  form,
  editingProviderId,
  isLoading,
  checkingProviderIds,
  errorMessage,
  checkResult,
  checkedProviderId,
  checkScope,
  batchResult,
  successMessage,
  successMessageTone,
  selectedProviderId,
  selectedTemplateId,
  repairRun,
  isRunning,
  onFormChange,
  onTemplateSelect,
  onNew,
  onSave,
  onImportModels,
  onRefresh,
  onEdit,
  onDelete,
  onCheck,
  onCheckBatch,
  onUse,
  onStopUse,
  onToggleEnabled,
  onRerun,
  onOpenRun,
  onClearCheckFeedback,
  onClearRepair,
  settingsToolMode = false,
}: {
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
  readonly successMessage: string;
  readonly successMessageTone: "ok" | "warning";
  readonly selectedProviderId: string;
  readonly selectedTemplateId: string;
  readonly repairRun: RunSession | undefined;
  readonly isRunning: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: () => void;
  readonly onSave: () => Promise<ProviderSaveResult>;
  readonly onImportModels: (models: readonly ProviderModelOption[]) => Promise<{ readonly ok: boolean; readonly errorMessage?: string }>;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onCheckBatch: () => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onStopUse: (provider: ProviderPreset) => void;
  readonly onToggleEnabled: (provider: ProviderPreset, enabled: boolean) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearCheckFeedback: (providerId: string) => void;
  readonly onClearRepair: () => void;
  readonly settingsToolMode?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const workbenchSummary = useMemo(() => readProviderWorkbenchSummary(providers), [providers]);
  const supplierTemplates = useMemo(
    () => dedupeProviderTemplates([providerFormToTemplate(customOpenAICompatibleForm), ...templates]),
    [templates],
  );
  const editingProvider = editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerStatusFilter, setProviderStatusFilter] = useState<ProviderStatusFilter>("all");
  const [showApiKey, setShowApiKey] = useState(true);
  const [modelOptions, setModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [modelOptionsContext, setModelOptionsContext] = useState<ProviderFormState | undefined>(undefined);
  const [modelOptionsSource, setModelOptionsSource] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<readonly string[]>([]);
  const [modelFetchError, setModelFetchError] = useState("");
  const [modelSelectionNotice, setModelSelectionNotice] = useState("");
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [editorErrorMessage, setEditorErrorMessage] = useState("");
  const [editorWarningMessage, setEditorWarningMessage] = useState("");
  const skipNextModelDiscoveryResetRef = useRef(false);
  const nextActionProvider =
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.api !== "media-job" &&
        provider.capabilities.includes("chat") &&
        providerNeedsSecret(provider) &&
        !provider.apiKeyConfigured,
    ) ??
    providers.find(canUseProviderForRun) ??
    providers.find((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured);
  const checkedProvider = checkedProviderId ? providers.find((provider) => provider.id === checkedProviderId) : undefined;
  const editorCheckProvider = checkedProvider ?? (editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined);
  const editorCheckSource = editorCheckProvider ?? (form.api === "media-job" ? { api: "media-job" as const } : undefined);

  const editorCheckMessage = checkResult ? providerCheckDisplayMessage(checkResult, editorCheckSource, t) : "";
  const editorCheckGuidance = checkResult ? providerCheckDisplayGuidance(checkResult, editorCheckSource, t) : "";
  const isCheckingProviders = checkingProviderIds.length > 0;
  const isBatchChecking = isCheckingProviders && checkScope === "batch";
  const isSaveChecking = isCheckingProviders && checkScope === "save";
  const selectedTemplateIsCustom = selectedTemplateId === customOpenAICompatibleTemplateId;
  const matchingFixedTemplate = templates.find((template) =>
    template.providerId === form.providerId &&
    template.kind === form.kind &&
    template.templateId !== customOpenAICompatibleTemplateId
  );
  const fixedTemplateMatchesCurrentShape =
    matchingFixedTemplate &&
    matchingFixedTemplate.api === form.api &&
    normalizeProviderEndpoint(matchingFixedTemplate.baseUrl ?? "") === normalizeProviderEndpoint(form.baseUrl);
  const canEditCustomProviderFields = selectedTemplateIsCustom || !fixedTemplateMatchesCurrentShape;
  const repairProviderId = repairRun ? readRunProviderPresetId(repairRun) : "";
  const repairProvider = repairProviderId ? providers.find((provider) => provider.id === repairProviderId) : undefined;
  const filteredProviders = useMemo(
    () => filterProviderWorkbenchRoutes({
      providers,
      query: providerSearch,
      statusFilter: providerStatusFilter,
      selectedProviderId,
    }),
    [providerSearch, providerStatusFilter, providers, selectedProviderId],
  );
  const visibleModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return modelOptions;
    }
    return modelOptions.filter((model) =>
      [model.id, model.displayName ?? "", model.ownedBy ?? ""].some((value) => value.toLowerCase().includes(query)),
    );
  }, [modelOptions, modelSearch]);
  const selectedImportModels = useMemo(
    () => modelOptions
      .filter((model) => selectedModelIds.includes(model.id))
      .map((model) => normalizeProviderModelForImport(model, modelOptionsContext ?? form)),
    [form, modelOptions, modelOptionsContext, selectedModelIds],
  );

  useEffect(() => {
    if (repairRun && editingProviderId) {
      setIsEditorOpen(true);
    }
  }, [editingProviderId, repairRun]);

  useEffect(() => {
    if (checkScope !== "row" || !checkedProviderId || !checkResult) {
      return undefined;
    }
    const timeout = window.setTimeout(() => onClearCheckFeedback(checkedProviderId), 2000);
    return () => window.clearTimeout(timeout);
  }, [checkResult, checkScope, checkedProviderId, onClearCheckFeedback]);

  useEffect(() => {
    if (!isEditorOpen) {
      return;
    }
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [isEditorOpen]);

  function resetModelDiscovery(): void {
    setModelOptions([]);
    setModelOptionsContext(undefined);
    setModelOptionsSource("");
    setModelSearch("");
    setSelectedModelIds([]);
    setModelFetchError("");
    setModelSelectionNotice("");
    setEditorWarningMessage("");
  }

  useEffect(() => {
    if (skipNextModelDiscoveryResetRef.current) {
      skipNextModelDiscoveryResetRef.current = false;
      return;
    }
    resetModelDiscovery();
  }, [form.providerId, form.api, form.baseUrl, form.apiKey]);

  function openNewProviderSheet(): void {
    onNew();
    setShowApiKey(true);
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    resetModelDiscovery();
    setIsEditorOpen(true);
  }

  function openEditProviderSheet(provider: ProviderPreset): void {
    onEdit(provider);
    setShowApiKey(true);
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    resetModelDiscovery();
    setIsEditorOpen(true);
  }

  function closeProviderSheet(): void {
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    setIsEditorOpen(false);
  }

  async function handleImportSelectedModels(): Promise<void> {
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    if (selectedImportModels.length === 0) {
      setEditorErrorMessage("Select at least one model.");
      return;
    }
    const result = await onImportModels(selectedImportModels);
    if (result.ok) {
      closeProviderSheet();
      return;
    }
    setEditorErrorMessage(result.errorMessage ?? "Import failed.");
  }

  async function handleSaveProvider(): Promise<void> {
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    const result = await onSave();
    if (result.ok) {
      closeProviderSheet();
      return;
    }
    setEditorErrorMessage(result.errorMessage ?? "Save failed.");
  }

  async function handlePrimaryProviderAction(): Promise<void> {
    if (selectedImportModels.length > 0) {
      await handleImportSelectedModels();
      return;
    }
    await handleSaveProvider();
  }

  async function fetchProviderModels(): Promise<void> {
    try {
      setIsFetchingModels(true);
      setModelFetchError("");
      const response = await listProviderModels(cwd.trim(), form);
      const nextModels = response.models.map((model) => normalizeProviderModelForImport(model, form));
      setModelOptions(nextModels);
      setModelOptionsContext({ ...form });
      setModelOptionsSource(providerModelSourceLabel(response.source, t));
      setSelectedModelIds([]);
      setModelSelectionNotice(response.source === "builtin:generation-models" || response.source === "builtin:media-models"
        ? t("Could not read models from the provider. Built-in model candidates are shown.")
        : "");
      if (nextModels.length === 0) {
        setModelFetchError(t("No models returned by this endpoint."));
      }
    } catch (error) {
      setModelOptions([]);
      setModelOptionsContext(undefined);
      setModelOptionsSource("");
      setModelFetchError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFetchingModels(false);
    }
  }

  function selectProviderModel(model: ProviderModelOption): void {
    const result = providerFormWithSelectedModel(form, model, modelOptionsContext);
    skipNextModelDiscoveryResetRef.current =
      result.form.providerId !== form.providerId ||
      result.form.api !== form.api ||
      result.form.baseUrl !== form.baseUrl ||
      result.form.apiKey !== form.apiKey;
    onFormChange(result.form);
    setModelSelectionNotice(result.notice ? t(result.notice) : "");
  }

  function toggleImportModel(model: ProviderModelOption): void {
    setSelectedModelIds((current) =>
      current.includes(model.id)
        ? current.filter((id) => id !== model.id)
        : [...current, model.id],
    );
  }

  function selectAllVisibleModels(): void {
    const next = new Set(selectedModelIds);
    for (const model of visibleModelOptions) {
      next.add(model.id);
    }
    setSelectedModelIds([...next]);
  }

  function clearSelectedModels(): void {
    setSelectedModelIds([]);
  }

  return (
    <div className={settingsToolMode ? "provider-layout provider-management-layout provider-workbench-surface settings-return-mode" : "provider-layout provider-management-layout provider-workbench-surface"}>
      <section
        className="provider-list-panel provider-workbench"
        aria-label={settingsToolMode ? t("Model Workbench") : undefined}
        aria-labelledby={settingsToolMode ? undefined : "provider-workbench-title"}
      >
        <ProviderWorkbenchHeader
          summary={workbenchSummary}
          providerSearch={providerSearch}
          providerStatusFilter={providerStatusFilter}
          isLoading={isLoading}
          isCheckingProviders={isCheckingProviders}
          isBatchChecking={isBatchChecking}
          onProviderSearchChange={setProviderSearch}
          onProviderStatusFilterChange={setProviderStatusFilter}
          onAddModel={openNewProviderSheet}
          onCheckBatch={onCheckBatch}
          onRefresh={onRefresh}
          settingsToolMode={settingsToolMode}
        />

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <ProviderNextAction providers={providers} nextActionProvider={nextActionProvider} isLoading={isLoading} />
        {repairRun ? (
          <ProviderRunRepairPanel
            run={repairRun}
            provider={repairProvider}
            isChecking={repairProvider ? checkingProviderIds.includes(repairProvider.id) : false}
            isRunning={isRunning}
            onEdit={openEditProviderSheet}
            onCheck={onCheck}
            onRerun={onRerun}
            onOpenRun={onOpenRun}
            onClear={onClearRepair}
          />
        ) : null}
        {batchResult ? (
          <div className={batchResult.failedCount === 0 ? "provider-batch-result ok" : "provider-batch-result bad"}>
            {batchResult.failedCount === 0 ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span>{t(batchResult.message)}</span>
          </div>
        ) : null}
        {successMessage ? (
          <div className={successMessageTone === "warning" ? "provider-batch-result warning" : "provider-batch-result ok"}>
            {successMessageTone === "warning" ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{successMessage}</span>
          </div>
        ) : null}

        <ProviderRouteList
          providers={providers}
          filteredProviders={filteredProviders}
          templates={templates}
          selectedProviderId={selectedProviderId}
          isLoading={isLoading}
          isCheckingProviders={isCheckingProviders}
          checkingProviderIds={checkingProviderIds}
          checkedProviderId={checkedProviderId}
          checkResult={checkResult}
          checkScope={checkScope}
          onAddModel={openNewProviderSheet}
          onEdit={openEditProviderSheet}
          onDelete={onDelete}
          onCheck={onCheck}
          onUse={onUse}
          onStopUse={onStopUse}
          onToggleEnabled={onToggleEnabled}
        />
        {filteredProviders.length > 0 ? (
          <div className="provider-table-footer" aria-label={t("Model preset table summary")}>
            <span>{t("{count} model presets", { count: filteredProviders.length })}</span>
          </div>
        ) : null}
      </section>

      {isEditorOpen ? (
        <ProviderEditorPanel
          supplierTemplates={supplierTemplates}
          selectedTemplateId={selectedTemplateId}
          form={form}
          editingProvider={editingProvider}
          editingProviderId={editingProviderId}
          showApiKey={showApiKey}
          canEditCustomProviderFields={canEditCustomProviderFields}
          modelImportPanel={(
            <ProviderModelImportPanel
              modelOptions={modelOptions}
              visibleModelOptions={visibleModelOptions}
              modelOptionsSource={modelOptionsSource}
              modelSearch={modelSearch}
              selectedModelIds={selectedModelIds}
              editingProviderId={editingProviderId}
              currentModel={form.model}
              isFetchingModels={isFetchingModels}
              modelFetchError={modelFetchError}
              modelSelectionNotice={modelSelectionNotice}
              onFetchModels={() => void fetchProviderModels()}
              onModelSearchChange={setModelSearch}
              onSelectAllVisible={selectAllVisibleModels}
              onClearSelection={clearSelectedModels}
              onSelectProviderModel={selectProviderModel}
              onToggleImportModel={toggleImportModel}
            />
          )}
          editorErrorMessage={editorErrorMessage}
          editorWarningMessage={editorWarningMessage}
          checkResult={checkResult}
          editorCheckProviderName={editorCheckProvider?.displayName ?? ""}
          editorCheckMessage={editorCheckMessage}
          editorCheckGuidance={editorCheckGuidance}
          selectedImportCount={selectedImportModels.length}
          isCheckingProviders={isCheckingProviders}
          isSaveChecking={isSaveChecking}
          onClose={closeProviderSheet}
          onTemplateSelect={onTemplateSelect}
          onResetModelDiscovery={resetModelDiscovery}
          onFormChange={onFormChange}
          onShowApiKeyChange={setShowApiKey}
          onSaveCurrentPreset={() => void handleSaveProvider()}
          onPrimaryAction={() => void handlePrimaryProviderAction()}
        />
      ) : null}
    </div>
  );
}

function dedupeProviderTemplates(templates: readonly ProviderTemplate[]): readonly ProviderTemplate[] {
  const seen = new Set<string>();
  const result: ProviderTemplate[] = [];
  for (const template of templates) {
    if (seen.has(template.templateId)) {
      continue;
    }
    seen.add(template.templateId);
    result.push(template);
  }
  return result;
}

function ProviderNextAction({
  providers,
  nextActionProvider,
  isLoading,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly nextActionProvider: ProviderPreset | undefined;
  readonly isLoading: boolean;
}): JSX.Element | null {
  const { t } = useI18n();

  if (isLoading) {
    return null;
  }

  if (providers.length === 0) {
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>{t("Next: choose a template, add an API key, then Save before using it.")}</span>
      </div>
    );
  }

  const readyProvider = providers.find(providerPreflightReady);
  if (readyProvider) {
    return null;
  }

  if (nextActionProvider && providerNeedsSecret(nextActionProvider) && !nextActionProvider.apiKeyConfigured) {
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>
          {t("Next: add an API key for {providerName}, then Save.", { providerName: nextActionProvider.displayName })}
        </span>
      </div>
    );
  }

  if (nextActionProvider && canUseProviderForRun(nextActionProvider)) {
    if (!nextActionProvider.lastCheck) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>{t("Next: Save {providerName} before using it in Workspace.", { providerName: nextActionProvider.displayName })}</span>
        </div>
      );
    }
    if (!nextActionProvider.lastCheck.ok) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>
            {t("Next: repair {providerName} check failure ({status}), then run Check again.", {
              providerName: nextActionProvider.displayName,
              status: providerCheckStatusLabel(nextActionProvider.lastCheck, t),
            })}
          </span>
        </div>
      );
    }
  }

  return (
    <div className="provider-next-action">
      <CircleAlert size={16} />
      <span>{t("Next: enable a chat provider with a supported API protocol, then Save.")}</span>
    </div>
  );
}

function ProviderRunRepairPanel({
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
  const providerReady = provider ? providerPreflightReady(provider) : false;
  const providerCheckText = provider
    ? provider.lastCheck
      ? `${providerCheckStatusLabel(provider.lastCheck, t)}: ${providerCheckMessage(provider.lastCheck, t)}`
      : t("Provider has not been checked yet.")
    : t("The provider preset used by this run is missing.");

  return (
    <div className="provider-run-repair" aria-label={t("Provider run repair")}>
      <div className="provider-run-repair-head">
        <span>
          <CircleAlert size={16} />
          <strong>{t("Repair failed run provider")}</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          {t("Clear")}
        </button>
      </div>
      <div className="provider-run-repair-copy">
        <span>
          {t("Run")} <code>{run.id}</code> {t("failed with")} <strong>{provider?.displayName ?? (readRunProviderPresetId(run) || t("missing provider"))}</strong>.
        </span>
        {run.errorMessage ? <small>{run.errorMessage}</small> : null}
        <small>{providerCheckText}</small>
      </div>
      <div className="provider-run-repair-steps">
        <span className={provider ? "provider-state check-ok" : "provider-state check-bad"}>{provider ? t("provider found") : t("provider missing")}</span>
        <span className={providerReady ? "provider-state run-ready" : "provider-state run-blocked"}>
          {providerReady ? t("preflight ready") : provider ? providerRunPreflightBlocker(provider, t) : t("cannot rerun")}
        </span>
      </div>
      <div className="provider-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onEdit(provider)} disabled={!provider}>
          <Pencil size={14} />
          {t("Edit provider")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onCheck(provider.id)} disabled={!provider || isChecking || isRunning}>
          {isChecking ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Check provider")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRerun(run)} disabled={!providerReady || isChecking || isRunning}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
          {t("Rerun")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          {t("Back to run")}
        </button>
      </div>
    </div>
  );
}
