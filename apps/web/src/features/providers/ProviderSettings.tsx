import {
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listProviderModels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  canWorkbenchBatchCheckProvider,
  canUseGenerationProviderForOperation,
  canUseProviderForRun,
  customOpenAICompatibleForm,
  isWorkbenchNeedsConfigProvider,
  isWorkbenchReadyProvider,
  normalizeProviderModelForImport,
  providerCapabilityChipLabels,
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckGuidance,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerFormToTemplate,
  providerFormWithSelectedModel,
  providerGenerationRuntimeSummary,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerLastCheckTitle,
  providerModelRouteLabel,
  providerNeedsSecret,
  providerPreflightReady,
  providerEffectiveBaseUrl,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerSecretHeaderSummary,
  providerSecretStatusClass,
  providerSecretStatusLabel,
  sortProvidersForWorkbench,
} from "../../lib/providers.js";
import { readRunProviderPresetId } from "../../lib/run-evidence.js";
import { SettingsToolReturnRow } from "../../shared/components/index.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelOption,
  ProviderPreset,
  ProviderThinkingMode,
  ProviderTemplate,
  RunSession,
} from "../../types.js";
import type { ProviderBatchResult, ProviderCheckScope } from "./types.js";

const customOpenAICompatibleTemplateId = "custom-openai-compatible";
type ProviderStatusFilter = "all" | "ready" | "needsAttention" | "missingKey" | "disabled";
type ProviderMenuAnchor = { readonly id: string; readonly top: number; readonly right: number };

const providerRowMenuEstimatedHeight = 132;

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
  onBackToWorkspaceTools,
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
  readonly onBackToWorkspaceTools?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const workbenchReadyProviderCount = providers.filter(isWorkbenchReadyProvider).length;
  const batchCheckProviderCount = providers.filter(canWorkbenchBatchCheckProvider).length;
  const missingSecretCount = providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length;
  const disabledProviderCount = providers.filter((provider) => !provider.enabled).length;
  const needsAttentionProviderCount = providers.filter(isWorkbenchNeedsConfigProvider).length;
  const supplierTemplates = useMemo(
    () => dedupeProviderTemplates([providerFormToTemplate(customOpenAICompatibleForm), ...templates]),
    [templates],
  );
  const editingProvider = editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerStatusFilter, setProviderStatusFilter] = useState<ProviderStatusFilter>("all");
  const [openProviderMenu, setOpenProviderMenu] = useState<ProviderMenuAnchor>({ id: "", top: 0, right: 0 });
  const openProviderMenuId = openProviderMenu.id;
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

  function openProviderRowMenu(providerId: string, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const viewportPadding = 8;
    const shouldOpenUp = rect.bottom + providerRowMenuEstimatedHeight > window.innerHeight - viewportPadding;
    setOpenProviderMenu({
      id: providerId,
      top: shouldOpenUp
        ? Math.max(viewportPadding, rect.top - providerRowMenuEstimatedHeight)
        : rect.bottom,
      right: Math.max(viewportPadding, window.innerWidth - rect.right),
    });
  }

  function closeProviderRowMenu(): void {
    setOpenProviderMenu({ id: "", top: 0, right: 0 });
  }
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
    () =>
      sortProvidersForWorkbench(providers.filter((provider) => {
        const query = providerSearch.trim().toLowerCase();
        const matchesQuery =
          !query ||
          [provider.displayName, provider.providerId, provider.model, provider.api, provider.baseUrl ?? ""]
            .some((value) => value.toLowerCase().includes(query));
        const matchesStatus =
          providerStatusFilter === "all" ||
          (providerStatusFilter === "ready" && isWorkbenchReadyProvider(provider)) ||
          (providerStatusFilter === "missingKey" && providerNeedsSecret(provider) && !provider.apiKeyConfigured) ||
          (providerStatusFilter === "needsAttention" && isWorkbenchNeedsConfigProvider(provider)) ||
          (providerStatusFilter === "disabled" && !provider.enabled);
        return matchesQuery && matchesStatus;
      }), selectedProviderId),
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
    <div className={onBackToWorkspaceTools ? "provider-layout provider-management-layout provider-workbench-surface settings-return-mode" : "provider-layout provider-management-layout provider-workbench-surface"}>
      <section
        className="provider-list-panel provider-workbench"
        aria-label={onBackToWorkspaceTools ? t("Model Workbench") : undefined}
        aria-labelledby={onBackToWorkspaceTools ? undefined : "provider-workbench-title"}
      >
        <header className={onBackToWorkspaceTools ? "provider-workbench-header settings-return-mode" : "provider-workbench-header"}>
          {onBackToWorkspaceTools ? <SettingsToolReturnRow onBack={onBackToWorkspaceTools} /> : null}
          {!onBackToWorkspaceTools ? (
            <div>
              <h1 id="provider-workbench-title">{t("Model Workbench")}</h1>
              <p>{t("Manage and configure all available model presets.")}</p>
              <div className="provider-page-meta" aria-label={t("Provider workbench action summary")}>
                <span>{t("Ready to use")} {workbenchReadyProviderCount}</span>
                <span>{t("Needs config")} {needsAttentionProviderCount}</span>
                <span>{t("Missing key")} {missingSecretCount}</span>
                <span>{t("Disabled")} {disabledProviderCount}</span>
              </div>
            </div>
          ) : null}
          <div className="provider-header-tools">
            <div className="provider-title-actions">
              <button className="primary-button compact-button" type="button" onClick={openNewProviderSheet}>
                <Plus size={15} />
                {t("Add model")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onCheckBatch} disabled={isCheckingProviders || batchCheckProviderCount === 0}>
                {isBatchChecking ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
                {t("Check all")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading || isCheckingProviders}>
                {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                {t("Refresh")}
              </button>
            </div>
            <div className="provider-toolbar-controls" aria-label={t("Model preset filters")}>
              <label className="provider-search-field">
                <Search size={15} />
                <input
                  aria-label={t("Search model presets")}
                  value={providerSearch}
                  placeholder={t("Search name, model, or endpoint")}
                  onChange={(event) => setProviderSearch(event.target.value)}
                />
              </label>
              <select
                aria-label={t("Filter model presets")}
                value={providerStatusFilter}
                onChange={(event) => setProviderStatusFilter(event.target.value as ProviderStatusFilter)}
              >
                <option value="all">{t("All presets")}</option>
                <option value="ready">{t("Ready presets")}</option>
                <option value="needsAttention">{t("Needs attention")}</option>
                <option value="missingKey">{t("Missing key")}</option>
                <option value="disabled">{t("Disabled providers")}</option>
              </select>
            </div>
          </div>
        </header>

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

        <div className="provider-table-shell">
          {providers.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <PlugZap />}
              <span>{isLoading ? t("Loading providers...") : t("Configure a supplier endpoint, fetch its exposed models, and save selected presets.")}</span>
              {!isLoading ? (
                <button className="primary-button compact-button" type="button" onClick={openNewProviderSheet}>
                  <Plus size={14} />
                  {t("Add model")}
                </button>
              ) : null}
            </div>
          ) : filteredProviders.length === 0 ? (
            <div className="empty-state compact-empty">
              <Search />
              <span>{t("No model presets match the current filters")}</span>
            </div>
          ) : (
            <table className="provider-table">
              <thead>
                <tr>
                  <th>{t("Supplier")}</th>
                  <th>{t("Model")}</th>
                  <th>{t("Base URL")}</th>
                  <th>{t("API key status")}</th>
                  <th>{t("Check status")}</th>
                  <th>{t("Status")}</th>
                  <th className="provider-table-action-head">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredProviders.map((provider) => {
                  const providerMissingApiKey = providerNeedsSecret(provider) && !provider.apiKeyConfigured;
                  const providerSelectedForRun = provider.id === selectedProviderId;
                  const providerCanBeDefault = providerPreflightReady(provider);
                  const providerIsChatCapable = provider.capabilities.includes("chat") && provider.api !== "media-job";
                  const providerIsGenerationCapable = provider.capabilities.some((capability) =>
                    capability === "image_generate" || capability === "image_edit" || capability === "video_generate"
                  );
                  const providerCanGenerate = (["image_generate", "image_edit", "video_generate"] as const).some((operation) =>
                    canUseGenerationProviderForOperation(provider, operation)
                  );
                  const providerIsChecking = checkingProviderIds.includes(provider.id);
                  const rowCheckResult = checkScope === "row" && checkedProviderId === provider.id ? checkResult : undefined;
                  const rowCheckMessage = rowCheckResult ? providerCheckDisplayMessage(rowCheckResult, provider, t) : "";
                  const rowCheckGuidance = rowCheckResult ? providerCheckDisplayGuidance(rowCheckResult, provider, t) : "";
                  const effectiveBaseUrl = providerEffectiveBaseUrl(provider, templates) || t("default endpoint");
                  const providerReady = providerPreflightReady(provider);
                  const providerPrimaryStatusLabel = providerMissingApiKey
                    ? t("Needs config")
                    : !provider.enabled
                      ? t("disabled")
                      : providerSelectedForRun
                        ? t("Current default")
                        : providerReady
                          ? t("Ready to use")
                          : providerIsGenerationCapable && !providerIsChatCapable
                            ? providerCanGenerate ? t("Ready to generate") : t("Generation model")
                          : canUseProviderForRun(provider)
                            ? t("needs check")
                            : providerRunBlockerLabel(provider, t);
                  const providerPrimaryStatusClass = providerMissingApiKey
                    ? "provider-state check-unknown"
                    : providerSelectedForRun || providerReady || (providerIsGenerationCapable && !providerIsChatCapable && providerCanGenerate)
                      ? "provider-state run-ready"
                      : providerIsGenerationCapable && !providerIsChatCapable
                        ? "provider-state check-unknown"
                        : provider.enabled
                        ? "provider-state run-blocked"
                        : "provider-state disabled";
                  const providerStatusHint =
                    providerMissingApiKey || !provider.enabled || (!providerReady && providerIsChatCapable)
                      ? (providerRunPreflightBlocker(provider, t) ?? rowCheckGuidance)
                      : providerIsGenerationCapable && !providerCanGenerate
                        ? t("Real generation is not connected yet.")
                      : "";
                  const providerMainActionIsCheck = !providerMissingApiKey && !providerReady && canUseProviderForRun(provider);
                  const generationRuntimeSummary = providerGenerationRuntimeSummary(provider, t);
                  const secretHeaderSummary = providerSecretHeaderSummary(provider, t);
                  return (
                    <Fragment key={provider.id}>
                      <tr className={provider.id === selectedProviderId ? "provider-row selected" : "provider-row"}>
                        <td className="provider-name-cell">
                          <span className="provider-name-main">
                            <span className="provider-avatar" aria-hidden="true">{providerInitial(provider.displayName)}</span>
                            <span className="provider-name-copy">
                              <strong>{provider.displayName}</strong>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="provider-model-name">{providerModelRouteLabel(provider, templates)}</span>
                          <div className="provider-meta-line provider-table-compat-line">
                            <span>{t("Capabilities")}: {providerCapabilityChipLabels(provider, t).join(" / ")}</span>
                            <span>{provider.lastCheck ? t("last check {time}", { time: formatDateTime(provider.lastCheck.checkedAt) }) : t("not checked")}</span>
                          </div>
                          {generationRuntimeSummary ? (
                            <div className="provider-meta-line provider-generation-status-line">
                              <span>{generationRuntimeSummary}</span>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div className="provider-meta-line mono provider-endpoint-cell">
                            <span><span className="provider-endpoint-label">{t("Base URL")}: </span>{effectiveBaseUrl}</span>
                          </div>
                        </td>
                        <td>
                          <span className="provider-key-status-stack">
                            <span className={providerSecretStatusClass(provider)}>{providerSecretStatusLabel(provider, t)}</span>
                            {secretHeaderSummary ? <small>{secretHeaderSummary}</small> : null}
                          </span>
                        </td>
                        <td>
                          <span className={providerLastCheckClass(provider)} title={providerLastCheckTitle(provider, t)}>
                            {providerLastCheckLabel(provider, t)}
                          </span>
                        </td>
                        <td className="provider-status-cell">
                          <span className="provider-status-stack">
                            <span className={providerPrimaryStatusClass}>{providerPrimaryStatusLabel}</span>
                            {providerStatusHint ? (
                              <span
                                className="provider-status-hint"
                                data-tooltip={providerStatusHint}
                                title={providerStatusHint}
                                aria-label={providerStatusHint}
                                tabIndex={0}
                              >
                                <CircleAlert size={12} />
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          <div className="provider-actions">
                            {providerMissingApiKey ? (
                              <button className="secondary-button compact-button provider-main-action" type="button" onClick={() => openEditProviderSheet(provider)}>
                                <Pencil size={14} />
                                {t("Fix config")}
                              </button>
                            ) : !providerReady && canUseProviderForRun(provider) ? (
                              <button className="secondary-button compact-button provider-main-action" type="button" disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                                {providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                                {t("Check")}
                              </button>
                            ) : providerIsChatCapable ? (
                              <button
                                className="secondary-button compact-button provider-main-action"
                                type="button"
                                disabled={!providerSelectedForRun && !providerCanBeDefault}
                                onClick={() => {
                                  if (providerSelectedForRun) {
                                    onStopUse(provider);
                                    return;
                                  }
                                  onUse(provider);
                                }}
                              >
                                {providerSelectedForRun ? <X size={14} /> : <Play size={14} />}
                                {providerSelectedForRun ? t("Clear default") : t("Set default")}
                              </button>
                            ) : (
                              <span className={providerIsGenerationCapable ? "provider-action-note" : "provider-action-note muted"}>
                                {providerIsGenerationCapable ? t("Generation model") : t("Not for chat")}
                              </span>
                            )}
                            <span
                              className={openProviderMenuId === provider.id ? "provider-row-menu hover-action-menu open" : "provider-row-menu hover-action-menu"}
                              onMouseEnter={(event) => openProviderRowMenu(provider.id, event.currentTarget)}
                              onMouseLeave={closeProviderRowMenu}
                              onFocus={(event) => openProviderRowMenu(provider.id, event.currentTarget)}
                              onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                  closeProviderRowMenu();
                                }
                              }}
                            >
                              <button
                                className="provider-row-menu-trigger hover-action-menu-trigger"
                                type="button"
                                aria-label={t("More")}
                                title={t("More")}
                                aria-haspopup="menu"
                                onMouseDown={(event) => event.preventDefault()}
                              >
                                <MoreHorizontal size={15} />
                              </button>
                              <span
                                className="provider-row-menu-popover hover-action-menu-popover"
                                role="menu"
                                hidden={openProviderMenuId !== provider.id}
                                style={{
                                  "--provider-row-menu-top": `${openProviderMenu.top}px`,
                                  "--provider-row-menu-right": `${openProviderMenu.right}px`,
                                } as CSSProperties}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    closeProviderRowMenu();
                                    openEditProviderSheet(provider);
                                  }}
                                >
                                  <Pencil size={14} />
                                  {t("Edit")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={isCheckingProviders}
                                  onClick={() => {
                                    closeProviderRowMenu();
                                    onToggleEnabled(provider, !provider.enabled);
                                  }}
                                >
                                  {provider.enabled ? <X size={14} /> : <CheckCircle2 size={14} />}
                                  {provider.enabled ? t("Disable") : t("Enable")}
                                </button>
                                {!providerMainActionIsCheck ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    disabled={isCheckingProviders || providerMissingApiKey}
                                    onClick={() => {
                                      closeProviderRowMenu();
                                      onCheck(provider.id);
                                    }}
                                  >
                                    {providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                                    {t("Check")}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => {
                                    closeProviderRowMenu();
                                    onDelete(provider.id);
                                  }}
                                >
                                  <Trash2 size={14} />
                                  {t("Delete")}
                                </button>
                              </span>
                            </span>
                          </div>
                        </td>
                      </tr>
                      {rowCheckResult ? (
                        <tr className={rowCheckResult.ok ? "provider-check-feedback-row ok" : "provider-check-feedback-row bad"}>
                          <td colSpan={7}>
                            <div className="provider-check-feedback">
                              {rowCheckResult.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                              <div className="provider-check-feedback-copy">
                                <span>
                                  <strong>{t(rowCheckResult.ok ? "Check passed" : "Check failed")}</strong>
                                  <em>{providerCheckStatusLabel(rowCheckResult, t)}</em>
                                </span>
                                <p>{rowCheckMessage}</p>
                                {rowCheckGuidance ? <small>{rowCheckGuidance}</small> : null}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {filteredProviders.length > 0 ? (
          <div className="provider-table-footer" aria-label={t("Model preset table summary")}>
            <span>{t("{count} model presets", { count: filteredProviders.length })}</span>
          </div>
        ) : null}
      </section>

      {isEditorOpen ? (
        <div className="provider-sheet-backdrop" role="presentation">
          <section className="panel provider-form-panel provider-sheet" aria-labelledby="provider-form-title" role="dialog" aria-modal="true">
        <div className="panel-title split provider-sheet-header">
          <span>
            <h2 id="provider-form-title">{editingProviderId ? t("Edit preset") : t("New preset")}</h2>
          </span>
          <button className="icon-button" type="button" onClick={closeProviderSheet} aria-label={t("Close model preset editor")}>
            <X size={16} />
          </button>
        </div>

        <div className="provider-sheet-body">
        <div className="provider-template-board">
          {supplierTemplates.length === 0 ? (
            <div className="empty-state compact-empty">
              <PlugZap />
              <span>{t("No templates available.")}</span>
            </div>
          ) : (
            <label className="field wide provider-template-select-field">
              <span>{t("Model supplier")}</span>
              <select
                value={selectedTemplateId}
                onChange={(event) => {
                  const template = supplierTemplates.find((item) => item.templateId === event.target.value);
                  if (!template) {
                    return;
                  }
                  resetModelDiscovery();
                  onTemplateSelect(template);
                }}
              >
                {supplierTemplates.map((template) => (
                  <option key={template.templateId} value={template.templateId}>
                    {t(template.displayName)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="field-row provider-identity-row">
          <label className="field">
            <span>{t("Provider name")}</span>
            <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Model")}</span>
            <input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
          </label>
        </div>

        <div className="field-row provider-connection-row">
          <label className="field">
            <span>{t("Base URL")}</span>
            <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
          </label>
          <div className="field provider-api-key-field">
            <span>{t("API key")}</span>
            <div className="provider-secret-input">
              <input
                aria-label={t("API key")}
                type={showApiKey ? "text" : "password"}
                autoComplete="new-password"
                value={form.apiKey}
                placeholder={t("Paste API key")}
                onChange={(event) => onFormChange({ ...form, apiKey: event.target.value, clearApiKey: false })}
              />
              {form.apiKey ? (
                <span className="provider-secret-actions">
                  <button
                    className="icon-button provider-secret-toggle"
                    type="button"
                    aria-label={showApiKey ? t("Hide API key") : t("Show API key")}
                    onClick={() => setShowApiKey((current) => !current)}
                  >
                    {showApiKey ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  <button
                    className="icon-button provider-secret-clear"
                    type="button"
                    aria-label={t("Clear input")}
                    onClick={() => onFormChange({ ...form, apiKey: "", clearApiKey: Boolean(editingProvider?.apiKeyConfigured) })}
                  >
                    <X size={15} />
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <details className="provider-secret-headers-detail">
          <summary>
            <span>{t("Secret headers")}</span>
            <small>{t("Optional header refs")}</small>
          </summary>
          <label className="field wide provider-secret-headers-field">
            <span>{t("Header secret refs")}</span>
            <textarea
              rows={3}
              spellCheck={false}
              value={form.secretHeaderRefsText}
              placeholder={"X-Api-Token: env:PROVIDER_TOKEN"}
              onChange={(event) => onFormChange({ ...form, secretHeaderRefsText: event.target.value })}
            />
            <small>{t("One per line. Store env: or keychain: refs only, not secret values.")}</small>
          </label>
        </details>

        <div className="field-row provider-number-row">
          {form.api === "media-job" ? (
            <div className="field provider-readonly-field">
              <span>{t("Runtime adapter")}</span>
              <strong>{t("Generation adapter")}</strong>
              <small>{t("Selected automatically from this model capability.")}</small>
            </div>
          ) : (
            <label className="field">
              <span>{t("API protocol")}</span>
              <select
                value={form.api}
                disabled={!canEditCustomProviderFields}
                onChange={(event) => {
                  const api = event.target.value as ProviderFormState["api"];
                  onFormChange({ ...form, api, providerTransport: api === "openai-codex-responses" ? form.providerTransport || "auto" : "" });
                }}
              >
                <option value="openai-completions">{t("OpenAI completions")}</option>
                <option value="openai-responses">{t("OpenAI responses")}</option>
                <option value="openai-codex-responses">{t("OpenAI Codex Responses")}</option>
                <option value="anthropic-messages">{t("Anthropic messages")}</option>
                <option value="google-generative-ai">{t("Google generative AI")}</option>
                <option value="mistral-conversations">{t("Mistral conversations")}</option>
              </select>
            </label>
          )}
          {form.api === "openai-codex-responses" ? (
            <label className="field">
              <span>{t("Transport")}</span>
              <select
                value={form.providerTransport || "auto"}
                disabled={!canEditCustomProviderFields}
                onChange={(event) => onFormChange({ ...form, providerTransport: event.target.value as ProviderFormState["providerTransport"] })}
              >
                <option value="auto">{t("Auto")}</option>
                <option value="websocket">{t("WebSocket")}</option>
                <option value="websocket-cached">{t("WebSocket cached")}</option>
                <option value="sse">{t("SSE")}</option>
              </select>
            </label>
          ) : null}
        </div>

        <details className="provider-advanced-detail">
          <summary>
            <span>{t("Advanced model limits")}</span>
            <small>{t("Optional manual override")}</small>
          </summary>
          <div className="provider-advanced-grid">
            <label className="field">
              <span>{t("Context")}</span>
              <input value={form.contextWindow} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Max tokens")}</span>
              <input value={form.maxTokens} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} />
            </label>
          </div>
        </details>

        <label className="field wide">
          <span>{t("Capabilities")}</span>
          <input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} />
        </label>

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
                onClick={() => void fetchProviderModels()}
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
                  onChange={(event) => setModelSearch(event.target.value)}
                />
              </label>
              <span className="provider-model-bulk-actions">
                <small className="provider-model-selection-count">{t("{count} selected", { count: selectedModelIds.length })}</small>
                <button className="secondary-button compact-button" type="button" onClick={selectAllVisibleModels}>
                  {t("Select visible")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={clearSelectedModels} disabled={selectedModelIds.length === 0}>
                  {t("Clear selection")}
                </button>
              </span>
            </div>
          ) : null}
          {modelOptions.length > 0 ? (
            <div className="provider-model-grid" aria-label={t("Available models")}>
              {visibleModelOptions.map((model) => {
                const modelCurrent = model.id === form.model;
                const importSelected = selectedModelIds.includes(model.id);
                const modelSelected = editingProviderId ? modelCurrent : importSelected;
                const cardClassName = [
                  "provider-model-card",
                  modelSelected ? "selected" : "",
                  editingProviderId && importSelected ? "import-selected" : "",
                ].filter(Boolean).join(" ");
                const activateModelRow = (): void => {
                  if (editingProviderId) {
                    selectProviderModel(model);
                    return;
                  }
                  toggleImportModel(model);
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
                      onChange={() => toggleImportModel(model)}
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
            <div className="empty-state compact-empty">
              <Search />
              <span>{t("No provider models match the current search")}</span>
            </div>
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

        <div className="provider-toggle-row">
          <label className="settings-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />
            <span>{t("Enabled")}</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.authHeader} onChange={(event) => onFormChange({ ...form, authHeader: event.target.checked })} />
            <span>{t("Auth header")}</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => onFormChange({ ...form, reasoning: event.target.checked })} />
            <span>{t("Reasoning")}</span>
          </label>
        </div>

        {editorErrorMessage ? (
          <div className="inline-error provider-editor-error">
            <CircleAlert size={16} />
            <span>{t(editorErrorMessage)}</span>
          </div>
        ) : null}
        {editorWarningMessage ? (
          <div className="model-fetch-error neutral provider-editor-warning">
            <CircleAlert size={16} />
            <span>{t(editorWarningMessage)}</span>
          </div>
        ) : null}

        {checkResult && !editorErrorMessage ? (
          <div className={checkResult.ok ? "check-result ok" : "check-result bad"}>
            {checkResult.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <div className="check-result-copy">
              <span className="check-result-status">{providerCheckStatusLabel(checkResult, t)}</span>
              <strong>{editorCheckProvider ? editorCheckProvider.displayName : t("Provider check")}</strong>
              <span>{editorCheckMessage}</span>
              {editorCheckGuidance ? <small>{editorCheckGuidance}</small> : null}
            </div>
          </div>
        ) : null}
        </div>

        <div className="provider-sheet-footer">
        <div className="action-row">
          <button className="secondary-button" type="button" onClick={closeProviderSheet}>
            {t("Cancel")}
          </button>
          {editingProviderId && selectedImportModels.length > 0 ? (
            <button
              className="secondary-button"
              type="button"
              disabled={isCheckingProviders}
              onClick={() => void handleSaveProvider()}
            >
              <Save size={16} />
              {t("Save current preset")}
            </button>
          ) : null}
          <button
            className="primary-button"
            type="button"
            disabled={isCheckingProviders}
            onClick={() => void handlePrimaryProviderAction()}
          >
            {isSaveChecking ? <Loader2 className="spin" size={16} /> : selectedImportModels.length > 0 ? <Plus size={16} /> : <Save size={16} />}
            {selectedImportModels.length > 0
              ? t("Import selected models ({count})", { count: selectedImportModels.length })
              : t("Save")}
          </button>
        </div>
        </div>
          </section>
        </div>
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

function normalizeProviderEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function providerModelSourceLabel(source: string, t: (key: string) => string): string {
  if (source === "builtin:generation-models" || source === "builtin:media-models") {
    return t("Built-in generation model candidates");
  }
  return source;
}

function providerInitial(displayName: string): string {
  const normalizedName = displayName.trim();
  if (!normalizedName) {
    return "#";
  }
  return normalizedName.slice(0, 1).toUpperCase();
}

function providerModelThinkingLabel(
  model: ProviderModelOption,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const modes = modelThinkingModes(model);
  if (modes.length === 0) {
    return t("No thinking");
  }
  return t("Thinking: {modes}", { modes: modes.map((mode) => providerThinkingModeLabel(mode, t)).join(" / ") });
}

function providerModelCapabilitySourceLabel(
  model: ProviderModelOption,
  t: (key: string) => string,
): string {
  if (model.capabilitySource === "upstream") {
    return t("Capability: provider");
  }
  if (model.capabilitySource === "model_catalog") {
    return t("Capability: Ling catalog");
  }
  if (model.capabilitySource === "provider_template") {
    return t("Capability: template");
  }
  if (model.capabilitySource === "user_override") {
    return t("Capability: custom");
  }
  return t("Capability: unknown");
}

function modelThinkingModes(model: ProviderModelOption): readonly ProviderThinkingMode[] {
  const modes = model.thinkingModes ?? [];
  return providerOrderedThinkingModes(modes).filter((mode) => mode !== "off");
}

function providerOrderedThinkingModes(modes: readonly ProviderThinkingMode[]): readonly ProviderThinkingMode[] {
  const selectedModes = new Set(modes);
  const order: readonly ProviderThinkingMode[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh"];
  return order.filter((mode) => selectedModes.has(mode));
}

function providerThinkingModeLabel(
  mode: ProviderThinkingMode,
  t: (key: string) => string,
): string {
  switch (mode) {
    case "off":
      return t("Off");
    case "auto":
      return t("Auto");
    case "minimal":
      return t("Minimal");
    case "low":
      return t("Low");
    case "medium":
      return t("Medium");
    case "high":
      return t("High");
    case "xhigh":
      return t("XHigh");
  }
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
