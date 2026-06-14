import {
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  History,
  Loader2,
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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { listProviderModels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  canWorkbenchBatchCheckProvider,
  canUseProviderForRun,
  customOpenAICompatibleForm,
  isMediaProvider,
  isWorkbenchNeedsConfigProvider,
  isWorkbenchReadyProvider,
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckGuidance,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerCodingTaskLabel,
  providerCapabilityUiStateDescription,
  providerCapabilityUiStateLabel,
  providerFormToTemplate,
  providerFormWithSelectedModel,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerLastCheckTitle,
  providerNeedsSecret,
  providerPreflightReady,
  providerEffectiveBaseUrl,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerTemplateKindLabel,
  deriveProviderCapabilityUiState,
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

const customOpenAICompatibleTemplateId = "custom-openai-compatible";
type ProviderStatusFilter = "all" | "ready" | "needsAttention" | "missingKey" | "disabled";

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
}): JSX.Element {
  const { t } = useI18n();
  const savedProviderCount = providers.length;
  const workbenchReadyProviderCount = providers.filter(isWorkbenchReadyProvider).length;
  const preflightReadyProviderCount = providers.filter(providerPreflightReady).length;
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
  const providerCapabilityState = deriveProviderCapabilityUiState(form, templates);
  const repairProviderId = repairRun ? readRunProviderPresetId(repairRun) : "";
  const repairProvider = repairProviderId ? providers.find((provider) => provider.id === repairProviderId) : undefined;
  const filteredProviders = useMemo(
    () =>
      providers.filter((provider) => {
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
      }),
    [providerSearch, providerStatusFilter, providers],
  );
  const providerGroups = useMemo(() => groupProvidersBySupplier(filteredProviders, templates), [filteredProviders, templates]);
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
    () => modelOptions.filter((model) => selectedModelIds.includes(model.id)),
    [modelOptions, selectedModelIds],
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

  async function handleSaveProvider(): Promise<void> {
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    if (!editingProviderId && modelOptions.length > 0) {
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
      return;
    }
    const result = await onSave();
    if (result.ok) {
      closeProviderSheet();
      return;
    }
    setEditorErrorMessage(result.errorMessage ?? "Save failed.");
  }

  async function fetchProviderModels(): Promise<void> {
    try {
      setIsFetchingModels(true);
      setModelFetchError("");
      const response = await listProviderModels(cwd.trim(), form);
      const nextModels = response.models;
      setModelOptions(nextModels);
      setModelOptionsContext({ ...form });
      setModelOptionsSource(response.source);
      setSelectedModelIds([]);
      setModelSelectionNotice(response.source === "builtin:media-models"
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
    <div className="provider-layout provider-management-layout provider-workbench-surface">
      <section className="provider-list-panel provider-workbench" aria-labelledby="provider-workbench-title">
        <header className="provider-workbench-header">
          <div>
            <h1 id="provider-workbench-title">{t("Model Workbench")}</h1>
            <p>{t("Manage and configure all available model presets.")}</p>
          </div>
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
        </header>

        <div className="provider-toolbar" aria-label={t("Model preset filters")}>
          <div className="provider-status-tabs" aria-label={t("Provider workbench status")}>
            <button
              className={providerStatusFilter === "ready" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("ready")}
            >
              <span className="provider-status-dot ready" />
              {t("Available")} <strong>{workbenchReadyProviderCount}</strong>
            </button>
            <button
              className={providerStatusFilter === "needsAttention" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("needsAttention")}
            >
              <span className="provider-status-dot warning" />
              {t("Needs config")} <strong>{needsAttentionProviderCount}</strong>
            </button>
            <button
              className={providerStatusFilter === "disabled" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("disabled")}
            >
              <span className="provider-status-dot muted" />
              {t("Disabled providers")} <strong>{disabledProviderCount}</strong>
            </button>
          </div>
          <div className="provider-toolbar-controls">
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

        <div className="provider-capability-summary" aria-label={t("Provider workbench status")}>
          <span>{t("Saved presets")} <strong>{savedProviderCount}</strong></span>
          <span>{t("Suppliers")} <strong>{providerGroups.length}</strong></span>
          <span>{t("Coding ready")} <strong>{preflightReadyProviderCount}</strong></span>
          <span>{t("Missing secrets")} <strong>{missingSecretCount}</strong></span>
        </div>

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
                {providerGroups.map((group) => (
                  <Fragment key={group.key}>
                    <tr className="provider-group-row">
                      <td colSpan={7}>
                        <div className="provider-group-summary">
                          <span className="provider-avatar" aria-hidden="true">{providerInitial(group.label)}</span>
                          <span>
                            <strong>{group.label}</strong>
                            <small>{group.providerId} · {group.modelCount} {t("models")} · {group.api}</small>
                          </span>
                          <em>{group.endpoint || t("default endpoint")}</em>
                        </div>
                      </td>
                    </tr>
                    {group.providers.map((provider) => {
                  const providerMissingApiKey = providerNeedsSecret(provider) && !provider.apiKeyConfigured;
                  const providerSelectedForRun = provider.id === selectedProviderId;
                  const providerIsMedia = provider.api === "media-job";
                  const providerCanBeDefault = providerPreflightReady(provider);
                  const providerIsChecking = checkingProviderIds.includes(provider.id);
                  const rowCheckResult = checkScope === "row" && checkedProviderId === provider.id ? checkResult : undefined;
                  const rowCheckMessage = rowCheckResult ? providerCheckDisplayMessage(rowCheckResult, provider, t) : "";
                  const rowCheckGuidance = rowCheckResult ? providerCheckDisplayGuidance(rowCheckResult, provider, t) : "";
                  const effectiveBaseUrl = providerEffectiveBaseUrl(provider, templates) || t("default endpoint");
                  return (
                    <Fragment key={provider.id}>
                      <tr className={provider.id === selectedProviderId ? "provider-row selected" : "provider-row"}>
                        <td className="provider-name-cell">
                          <span className="provider-name-main">
                            <span className="provider-avatar" aria-hidden="true">{providerInitial(provider.displayName)}</span>
                            <span className="provider-name-copy">
                              <strong>{provider.displayName}</strong>
                              <small>{provider.providerId}</small>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="provider-model-name">{provider.model}</span>
                          <div className="provider-meta-line provider-table-compat-line">
                            <span>{t("Model")}: {provider.model}</span>
                            <span>{t("API protocol")}: {provider.api}</span>
                            <span>{provider.lastCheck ? t("last check {time}", { time: formatDateTime(provider.lastCheck.checkedAt) }) : t("not checked")}</span>
                          </div>
                        </td>
                        <td>
                          <div className="provider-meta-line mono provider-endpoint-cell">
                            <span><span className="provider-endpoint-label">{t("Base URL")}: </span>{effectiveBaseUrl}</span>
                          </div>
                        </td>
                        <td>
                          {providerMissingApiKey ? (
                            <span className="provider-state key-missing">{t("API key missing")}</span>
                          ) : (
                            <span className={providerNeedsSecret(provider) ? "provider-state key-ok" : "provider-state check-unknown"}>
                              {providerNeedsSecret(provider) ? t("key ready") : t("no key required")}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={providerLastCheckClass(provider)} title={providerLastCheckTitle(provider, t)}>
                            {providerLastCheckLabel(provider, t)}
                          </span>
                        </td>
                        <td className="provider-status-cell">
                          <span className="provider-status-stack">
                            {providerMissingApiKey ? (
                              <span className="provider-state check-unknown">{t("Needs config")}</span>
                            ) : null}
                            {!providerMissingApiKey ? (
                              <span className={provider.enabled ? "provider-state enabled" : "provider-state disabled"}>
                                {provider.enabled ? t("enabled") : t("disabled")}
                              </span>
                            ) : null}
                            {providerSelectedForRun && !providerIsMedia ? (
                              <span className="provider-state default">
                                {t("Current default")}
                              </span>
                            ) : null}
                            {providerIsMedia ? (
                              <span className="provider-state media-only">
                                {t("Media task")}
                              </span>
                            ) : null}
                            {!providerMissingApiKey ? (
                              <span className={providerPreflightReady(provider) ? "provider-state run-ready provider-compat-only" : "provider-state run-blocked provider-compat-only"}>
                                {providerPreflightReady(provider) ? t("preflight ready") : canUseProviderForRun(provider) ? t("needs check") : providerRunBlockerLabel(provider, t)}
                              </span>
                            ) : null}
                            {!providerMissingApiKey ? (
                              <span className={providerPreflightReady(provider) ? "provider-state run-ready provider-compat-only" : "provider-state run-blocked provider-compat-only"}>
                                {t("Coding task")}: {providerCodingTaskLabel(provider, t)}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          <div className="provider-actions">
                            <button
                              className="secondary-button compact-button"
                              type="button"
                              disabled={providerIsMedia || (!providerSelectedForRun && !providerCanBeDefault)}
                              onClick={() => {
                                if (providerSelectedForRun) {
                                  onStopUse(provider);
                                  return;
                                }
                                onUse(provider);
                              }}
                            >
                              {providerSelectedForRun ? <X size={14} /> : <Play size={14} />}
                              {providerIsMedia ? t("Media task") : providerSelectedForRun ? t("Clear default") : t("Set default")}
                            </button>
                            <button
                              className="secondary-button compact-button icon-button"
                              type="button"
                              disabled={isCheckingProviders}
                              aria-label={provider.enabled ? t("Disable") : t("Enable")}
                              title={provider.enabled ? t("Disable") : t("Enable")}
                              onClick={() => onToggleEnabled(provider, !provider.enabled)}
                            >
                              {provider.enabled ? <X size={14} /> : <CheckCircle2 size={14} />}
                            </button>
                            <button
                              className="secondary-button compact-button icon-button"
                              type="button"
                              aria-label={t("Edit")}
                              title={t("Edit")}
                              onClick={() => openEditProviderSheet(provider)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="secondary-button compact-button icon-button"
                              type="button"
                              disabled={isCheckingProviders}
                              aria-label={t("Check")}
                              title={t("Check")}
                              onClick={() => onCheck(provider.id)}
                            >
                              {providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                            </button>
                            <button
                              className="secondary-button compact-button icon-button danger"
                              type="button"
                              aria-label={t("Delete")}
                              title={t("Delete")}
                              onClick={() => onDelete(provider.id)}
                            >
                              <Trash2 size={14} />
                            </button>
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
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {filteredProviders.length > 0 ? (
          <div className="provider-table-footer" aria-label={t("Model preset table summary")}>
            <span>{t("{count} model presets", { count: filteredProviders.length })}</span>
            <span className="provider-table-pagination">
              <button type="button" disabled>{t("Previous page")}</button>
              <button type="button" disabled>{t("Next page")}</button>
            </span>
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
        <div className="provider-template-board" aria-label={t("Choose model supplier")}>
          <div className="provider-template-board-header">
            <span>
              <strong>{t("Choose model supplier")}</strong>
              <small>{t("Configure a supplier first, then fetch the models exposed by its endpoint.")}</small>
            </span>
          </div>
          {supplierTemplates.length === 0 ? (
            <div className="empty-state compact-empty">
              <PlugZap />
              <span>{t("No templates available.")}</span>
            </div>
          ) : (
            <div className="provider-template-panel">
              <div className="provider-template-grid">
                {supplierTemplates.map((template) => (
                  <button
                    key={template.templateId}
                    className={[
                      "provider-template-card",
                      template.templateId === customOpenAICompatibleTemplateId ? "custom-provider-card" : "",
                      selectedTemplateId === template.templateId ? "selected" : "",
                    ].filter(Boolean).join(" ")}
                    type="button"
                    onClick={() => {
                      resetModelDiscovery();
                      onTemplateSelect(template);
                    }}
                  >
                    <span className="provider-template-kind">{t(providerTemplateKindLabel(template))}</span>
                    <strong>{t(template.displayName)}</strong>
                    <span className="provider-template-model">{template.templateId === customOpenAICompatibleTemplateId ? t("Base URL + model + API Key") : template.model}</span>
                    <small>{t(template.description)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="field-row provider-identity-row">
          <label className="field">
            <span>{t("Provider name")}</span>
            <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Provider ID")}</span>
            <input
              value={form.providerId}
              disabled={!canEditCustomProviderFields}
              onChange={(event) => onFormChange({ ...form, providerId: event.target.value })}
            />
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

        <div className="field-row provider-number-row">
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
              <option value="media-job">{t("Media job")}</option>
            </select>
          </label>
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

        <div className={`provider-capability-state ${providerCapabilityState}`}>
          <span>
            <strong>{t("Model capability")}</strong>
            <small>{t(providerCapabilityUiStateDescription(providerCapabilityState))}</small>
          </span>
          <em>{t(providerCapabilityUiStateLabel(providerCapabilityState))}</em>
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
              {modelOptions.length > 0 && !editingProviderId ? (
                <>
                  <button className="secondary-button compact-button" type="button" onClick={selectAllVisibleModels}>
                    {t("Select visible")}
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={clearSelectedModels} disabled={selectedModelIds.length === 0}>
                    {t("Clear selection")}
                  </button>
                </>
              ) : null}
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
            <label className="provider-model-search">
              <Search size={14} />
              <input
                aria-label={t("Search provider models")}
                value={modelSearch}
                placeholder={t("Search provider models")}
                onChange={(event) => setModelSearch(event.target.value)}
              />
              {!editingProviderId ? <small>{t("{count} selected", { count: selectedModelIds.length })}</small> : null}
            </label>
          ) : null}
          {modelOptions.length > 0 ? (
            <div className="provider-model-grid" aria-label={t("Available models")}>
              {visibleModelOptions.map((model) => {
                const modelSelected = editingProviderId ? model.id === form.model : selectedModelIds.includes(model.id);
                return (
                <button
                  key={model.id}
                  className={modelSelected ? "provider-model-card selected" : "provider-model-card"}
                  type="button"
                  onClick={() => {
                    if (editingProviderId) {
                      selectProviderModel(model);
                      return;
                    }
                    toggleImportModel(model);
                  }}
                >
                  <strong>{model.displayName ?? model.id}</strong>
                  <small>{model.ownedBy ?? model.id}</small>
                  {model.capabilities?.length ? <em>{model.capabilities.join(", ")}</em> : null}
                </button>
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
          <button
            className="primary-button"
            type="button"
            disabled={isCheckingProviders || (!editingProviderId && modelOptions.length > 0 && selectedImportModels.length === 0)}
            onClick={() => void handleSaveProvider()}
          >
            {isSaveChecking ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t(!editingProviderId && modelOptions.length > 0 ? "Save selected models" : "Save")}
          </button>
        </div>
        </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

interface ProviderWorkbenchGroup {
  readonly key: string;
  readonly label: string;
  readonly providerId: string;
  readonly api: string;
  readonly endpoint: string;
  readonly modelCount: number;
  readonly providers: readonly ProviderPreset[];
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

function groupProvidersBySupplier(
  providers: readonly ProviderPreset[],
  templates: readonly ProviderTemplate[],
): readonly ProviderWorkbenchGroup[] {
  const groups = new Map<string, ProviderPreset[]>();
  for (const provider of providers) {
    const key = [
      provider.providerId,
      provider.api,
      normalizeProviderEndpoint(providerEffectiveBaseUrl(provider, templates)),
      provider.apiKeyRef ?? "",
    ].join("\u0000");
    const entries = groups.get(key) ?? [];
    entries.push(provider);
    groups.set(key, entries);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const first = entries[0];
    return {
      key,
      label: providerSupplierLabel(first),
      providerId: first.providerId,
      api: first.api,
      endpoint: providerEffectiveBaseUrl(first, templates),
      modelCount: entries.length,
      providers: entries,
    };
  });
}

function providerSupplierLabel(provider: ProviderPreset): string {
  const displayName = provider.displayName.trim();
  const separator = displayName.indexOf(" · ");
  return separator > 0 ? displayName.slice(0, separator) : displayName || provider.providerId;
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

function providerInitial(displayName: string): string {
  const normalizedName = displayName.trim();
  if (!normalizedName) {
    return "#";
  }
  return normalizedName.slice(0, 1).toUpperCase();
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
