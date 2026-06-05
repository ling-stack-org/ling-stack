import {
  CheckCircle2,
  CircleAlert,
  CircleSlash,
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
import { useEffect, useMemo, useState } from "react";
import { listProviderModels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  canBatchCheckProvider,
  customOpenAICompatibleForm,
  groupProviderTemplates,
  providerCheckGuidance,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerFormToTemplate,
  providerNeedsSecret,
  providerPreflightReady,
  providerEffectiveBaseUrl,
  providerRunPreflightBlocker,
  providerTemplateKindLabel,
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
import type { ProviderBatchResult } from "./types.js";

const customOpenAICompatibleTemplateId = "custom-openai-compatible";
type ProviderStatusFilter = "all" | "ready" | "needsAttention" | "missingKey" | "disabled";

export interface ProviderSaveResult {
  readonly ok: boolean;
  readonly errorMessage?: string;
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
  batchResult,
  successMessage,
  selectedProviderId,
  selectedTemplateId,
  repairRun,
  isRunning,
  onFormChange,
  onTemplateSelect,
  onNew,
  onSave,
  onRefresh,
  onEdit,
  onDelete,
  onCheck,
  onCheckBatch,
  onUse,
  onStopUse,
  onRerun,
  onOpenRun,
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
  readonly batchResult: ProviderBatchResult | undefined;
  readonly successMessage: string;
  readonly selectedProviderId: string;
  readonly selectedTemplateId: string;
  readonly repairRun: RunSession | undefined;
  readonly isRunning: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: () => void;
  readonly onSave: () => Promise<ProviderSaveResult>;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onCheckBatch: () => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onStopUse: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const preflightReadyProviderCount = providers.filter(providerPreflightReady).length;
  const batchCheckProviderCount = providers.filter(canBatchCheckProvider).length;
  const missingSecretCount = providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length;
  const disabledProviderCount = providers.filter((provider) => !provider.enabled).length;
  const needsAttentionProviderCount = providers.filter((provider) => provider.enabled && !providerPreflightReady(provider)).length;
  const templateGroups = useMemo(() => groupProviderTemplates(templates), [templates]);
  const templateTabs = useMemo(() => {
    const groupedTemplates = new Map<string, ProviderTemplate[]>();
    groupedTemplates.set("Custom access", [providerFormToTemplate(customOpenAICompatibleForm)]);
    for (const group of templateGroups) {
      groupedTemplates.set(group.label, [...(groupedTemplates.get(group.label) ?? []), ...group.templates]);
    }
    return ["Custom access", "GPT", "Claude", "Domestic AI", "Media"].flatMap((label) => {
      const groupTemplates = groupedTemplates.get(label) ?? [];
      return groupTemplates.length > 0 ? [{ label, templates: groupTemplates }] : [];
    });
  }, [templateGroups]);
  const editingProvider = editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerStatusFilter, setProviderStatusFilter] = useState<ProviderStatusFilter>("all");
  const [activeTemplateGroupLabel, setActiveTemplateGroupLabel] = useState("Custom access");
  const [showApiKey, setShowApiKey] = useState(true);
  const [modelOptions, setModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [modelOptionsSource, setModelOptionsSource] = useState("");
  const [modelFetchError, setModelFetchError] = useState("");
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [editorErrorMessage, setEditorErrorMessage] = useState("");
  const activeTemplateGroup = templateTabs.find((group) => group.label === activeTemplateGroupLabel) ?? templateTabs[0];
  const checkedProvider = checkedProviderId ? providers.find((provider) => provider.id === checkedProviderId) : undefined;
  const isCheckingProviders = checkingProviderIds.length > 0;
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
      providers.filter((provider) => {
        const query = providerSearch.trim().toLowerCase();
        const matchesQuery =
          !query ||
          [provider.displayName, provider.providerId, provider.model, provider.api, provider.baseUrl ?? ""]
            .some((value) => value.toLowerCase().includes(query));
        const matchesStatus =
          providerStatusFilter === "all" ||
          (providerStatusFilter === "ready" && providerPreflightReady(provider)) ||
          (providerStatusFilter === "missingKey" && providerNeedsSecret(provider) && !provider.apiKeyConfigured) ||
          (providerStatusFilter === "needsAttention" && provider.enabled && !providerPreflightReady(provider)) ||
          (providerStatusFilter === "disabled" && !provider.enabled);
        return matchesQuery && matchesStatus;
      }),
    [providerSearch, providerStatusFilter, providers],
  );

  useEffect(() => {
    if (repairRun && editingProviderId) {
      setIsEditorOpen(true);
    }
  }, [editingProviderId, repairRun]);

  useEffect(() => {
    if (!templateTabs.some((group) => group.label === activeTemplateGroupLabel) && templateTabs[0]) {
      setActiveTemplateGroupLabel(templateTabs[0].label);
    }
  }, [activeTemplateGroupLabel, templateTabs]);

  useEffect(() => {
    if (!selectedTemplateId) {
      return;
    }
    const matchingGroup = templateTabs.find((group) =>
      group.templates.some((template) => template.templateId === selectedTemplateId),
    );
    if (matchingGroup) {
      setActiveTemplateGroupLabel(matchingGroup.label);
    }
  }, [selectedTemplateId, templateTabs]);

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

  useEffect(() => {
    setModelOptions([]);
    setModelOptionsSource("");
    setModelFetchError("");
  }, [form.providerId, form.api, form.baseUrl, form.apiKey]);

  function openNewProviderSheet(): void {
    onNew();
    setActiveTemplateGroupLabel("Custom access");
    setShowApiKey(true);
    setEditorErrorMessage("");
    setIsEditorOpen(true);
  }

  function openEditProviderSheet(provider: ProviderPreset): void {
    onEdit(provider);
    setShowApiKey(true);
    setEditorErrorMessage("");
    setIsEditorOpen(true);
  }

  function selectTemplateGroup(label: string): void {
    const group = templateTabs.find((item) => item.label === label);
    setActiveTemplateGroupLabel(label);
    setEditorErrorMessage("");
    if (group?.templates[0]) {
      onTemplateSelect(group.templates[0]);
    }
  }

  function closeProviderSheet(): void {
    setEditorErrorMessage("");
    setIsEditorOpen(false);
  }

  async function handleSaveProvider(): Promise<void> {
    setEditorErrorMessage("");
    const result = await onSave();
    if (result.ok) {
      closeProviderSheet();
      return;
    }
    setEditorErrorMessage(result.errorMessage ?? "Save failed.");
  }

  async function fetchProviderModels(): Promise<void> {
    if (form.api === "media-job") {
      setModelFetchError(t("Model discovery is available for chat providers only."));
      return;
    }
    try {
      setIsFetchingModels(true);
      setModelFetchError("");
      const response = await listProviderModels(cwd.trim(), form);
      setModelOptions(response.models);
      setModelOptionsSource(response.source);
      if (response.models.length === 0) {
        setModelFetchError(t("No models returned by this endpoint."));
      }
    } catch (error) {
      setModelOptions([]);
      setModelOptionsSource("");
      setModelFetchError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFetchingModels(false);
    }
  }

  return (
    <div className="provider-layout provider-management-layout provider-workbench-surface">
      <section className="provider-list-panel provider-workbench" aria-labelledby="provider-workbench-title">
        <header className="provider-workbench-header">
          <div>
            <h1 id="provider-workbench-title">{t("Model Workbench")}</h1>
            <p>{t("Manage model presets, key references, connectivity checks, and task availability.")}</p>
          </div>
          <div className="provider-title-actions">
            <button className="primary-button compact-button" type="button" onClick={openNewProviderSheet}>
              <Plus size={15} />
              {t("Add model")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onCheckBatch} disabled={isCheckingProviders || batchCheckProviderCount === 0}>
              {isCheckingProviders ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
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
              className={providerStatusFilter === "all" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("all")}
            >
              {t("All presets")} <strong>{providers.length}</strong>
            </button>
            <button
              className={providerStatusFilter === "ready" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("ready")}
            >
              <span className="provider-status-dot ready" />
              {t("Available")} <strong>{preflightReadyProviderCount}</strong>
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
              className={providerStatusFilter === "missingKey" ? "selected" : ""}
              type="button"
              onClick={() => setProviderStatusFilter("missingKey")}
            >
              <span className="provider-status-dot warning" />
              {t("Missing key")} <strong>{missingSecretCount}</strong>
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
                placeholder={t("Search model, provider, or Base URL")}
                onChange={(event) => setProviderSearch(event.target.value)}
              />
            </label>
          </div>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

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
          <div className="provider-batch-result ok">
            <CheckCircle2 size={16} />
            <span>{successMessage}</span>
          </div>
        ) : null}

        <div className="provider-table-shell">
          {providers.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <PlugZap />}
              <span>{isLoading ? t("Loading providers...") : t("Create a model preset from GPT, Claude, domestic, relay, or custom OpenAI-compatible entries")}</span>
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
                  <th>{t("Status")}</th>
                  <th>{t("Name")}</th>
                  <th>{t("Model")}</th>
                  <th>{t("Key")}</th>
                  <th className="provider-table-action-head">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredProviders.map((provider) => {
                  const providerMissingApiKey = providerNeedsSecret(provider) && !provider.apiKeyConfigured;
                  const providerSelectedForRun = provider.id === selectedProviderId;
                  const providerReadyForRun = providerPreflightReady(provider);
                  const effectiveBaseUrl = providerEffectiveBaseUrl(provider, templates) || t("default endpoint");
                  const providerUseActionLabel = providerSelectedForRun ? t("Stop using") : t("Use");
                  const providerUseActionTooltip = providerSelectedForRun ? t("Stop using this preset") : t("Use this preset");
                  const providerStatusLabel = !provider.enabled ? t("disabled") : providerReadyForRun ? t("ready") : t("Needs config");
                  const providerStatusClassName = !provider.enabled
                    ? "provider-status-indicator disabled"
                    : providerReadyForRun
                      ? "provider-status-indicator ready"
                      : "provider-status-indicator attention";
                  const providerRowClassName = [
                    "provider-row",
                    providerSelectedForRun ? "selected" : "",
                    !provider.enabled ? "disabled-provider-row" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <tr key={provider.id} className={providerRowClassName}>
                      <td className="provider-status-cell">
                        <span className={providerStatusClassName} aria-label={providerStatusLabel} title={providerStatusLabel}>
                          {!provider.enabled ? (
                            <CircleSlash size={16} />
                          ) : providerReadyForRun ? (
                            <CheckCircle2 size={16} />
                          ) : (
                            <CircleAlert size={16} />
                          )}
                        </span>
                      </td>
                      <td className="provider-name-cell">
                        <span className="provider-name-copy">
                          <strong>{provider.displayName}</strong>
                          <small>{provider.providerId} · {effectiveBaseUrl}</small>
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
                        {providerMissingApiKey ? (
                          <span className="provider-state key-missing">{t("Missing key")}</span>
                        ) : (
                          <span className={providerNeedsSecret(provider) ? "provider-state key-ok" : "provider-state check-unknown"}>
                            {providerNeedsSecret(provider) ? t("key ready") : t("no key required")}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="provider-actions">
                          <button
                            className="secondary-button compact-button"
                            type="button"
                            aria-label={providerUseActionLabel}
                            title={providerUseActionLabel}
                            data-tooltip={providerUseActionTooltip}
                            disabled={!providerSelectedForRun && !providerReadyForRun}
                            onClick={() => {
                              if (providerSelectedForRun) {
                                onStopUse();
                                return;
                              }
                              onUse(provider);
                            }}
                          >
                            {providerSelectedForRun ? <X size={14} /> : <Play size={14} />}
                          </button>
                          <button className="secondary-button compact-button" type="button" aria-label={t("Edit")} title={t("Edit")} data-tooltip={t("Edit this preset")} onClick={() => openEditProviderSheet(provider)}>
                            <Pencil size={14} />
                          </button>
                          <button className="secondary-button compact-button" type="button" aria-label={t("Check")} title={t("Check")} data-tooltip={t("Check this preset")} disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                            {checkingProviderIds.includes(provider.id) ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                          </button>
                          <button className="secondary-button compact-button danger" type="button" aria-label={t("Delete")} title={t("Delete")} data-tooltip={t("Delete this preset")} onClick={() => onDelete(provider.id)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
              <section className="provider-inspector-section" aria-label={t("Basic information")}>
                <div className="provider-inspector-section-title">
                  <strong>{t("Basic information")}</strong>
                </div>
                <div className="provider-template-board" aria-label={t("Model templates")}>
                  <div className="provider-template-tabs" role="tablist" aria-label={t("Choose model supplier")}>
                    {templateTabs.map((group) => (
                      <button
                        key={group.label}
                        className={group.label === activeTemplateGroup?.label ? "provider-template-tab selected" : "provider-template-tab"}
                        type="button"
                        role="tab"
                        aria-selected={group.label === activeTemplateGroup?.label}
                        onClick={() => selectTemplateGroup(group.label)}
                      >
                        <span>{t(group.label)}</span>
                        <small>{group.templates.length}</small>
                      </button>
                    ))}
                  </div>
                  {!activeTemplateGroup ? (
                    <div className="empty-state compact-empty">
                      <PlugZap />
                      <span>{t("No templates available.")}</span>
                    </div>
                  ) : (
                    <div className="provider-template-panel" role="tabpanel" aria-label={t(activeTemplateGroup.label)}>
                      <div className="provider-template-grid">
                        {activeTemplateGroup.templates.map((template) => (
                          <button
                            key={template.templateId}
                            className={[
                              "provider-template-card",
                              template.templateId === customOpenAICompatibleTemplateId ? "custom-provider-card" : "",
                              selectedTemplateId === template.templateId ? "selected" : "",
                            ].filter(Boolean).join(" ")}
                            type="button"
                            onClick={() => onTemplateSelect(template)}
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
              </section>

              <section className="provider-inspector-section" aria-label={t("Connection")}>
                <div className="provider-inspector-section-title">
                  <strong>{t("Connection")}</strong>
                </div>
                <div className="field-row provider-connection-row">
                  <label className="field">
                    <span>{t("Base URL")}</span>
                    <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
                  </label>
                </div>
                <div className="field-row provider-number-row">
                  <label className="field">
                    <span>{t("API protocol")}</span>
                    <select
                      value={form.api}
                      disabled={!canEditCustomProviderFields}
                      onChange={(event) => onFormChange({ ...form, api: event.target.value as ProviderFormState["api"] })}
                    >
                      <option value="openai-completions">{t("OpenAI completions")}</option>
                      <option value="openai-responses">{t("OpenAI responses")}</option>
                      <option value="anthropic-messages">{t("Anthropic messages")}</option>
                      <option value="google-generative-ai">{t("Google generative AI")}</option>
                      <option value="mistral-conversations">{t("Mistral conversations")}</option>
                      <option value="media-job">{t("Media job")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("Context")}</span>
                    <input value={form.contextWindow} inputMode="numeric" onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t("Max tokens")}</span>
                    <input value={form.maxTokens} inputMode="numeric" onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} />
                  </label>
                </div>
                <label className="field wide">
                  <span>{t("Capabilities")}</span>
                  <input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} />
                </label>
              </section>

              <section className="provider-inspector-section" aria-label={t("Secrets")}>
                <div className="provider-inspector-section-title">
                  <strong>{t("Secrets")}</strong>
                </div>
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
              </section>

              <section className="provider-inspector-section" aria-label={t("Model discovery")}>
                <div className="provider-model-discovery">
                  <div className="provider-model-discovery-header">
                    <span>
                      <strong>{t("Model discovery")}</strong>
                      <small>{modelOptionsSource ? t("Loaded from {source}", { source: modelOptionsSource }) : t("Fetch models from the configured endpoint.")}</small>
                    </span>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      disabled={isFetchingModels || form.api === "media-job"}
                      onClick={() => void fetchProviderModels()}
                    >
                      {isFetchingModels ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                      {t("Fetch models")}
                    </button>
                  </div>
                  {modelOptions.length > 0 ? (
                    <div className="provider-model-grid" aria-label={t("Available models")}>
                      {modelOptions.map((model) => (
                        <button
                          key={model.id}
                          className={model.id === form.model ? "provider-model-card selected" : "provider-model-card"}
                          type="button"
                          onClick={() => onFormChange({ ...form, model: model.id })}
                        >
                          <strong>{model.displayName ?? model.id}</strong>
                          <small>{model.ownedBy ?? model.id}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {modelFetchError ? (
                    <div className="model-fetch-error">
                      <CircleAlert size={15} />
                      <span>{t(modelFetchError)}</span>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="provider-inspector-section" aria-label={t("Run preflight")}>
                <div className="provider-inspector-section-title">
                  <strong>{t("Run preflight")}</strong>
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

                {checkResult && !editorErrorMessage ? (
                  <div className={checkResult.ok ? "check-result ok" : "check-result bad"}>
                    {checkResult.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                    <div className="check-result-copy">
                      <span className="check-result-status">{providerCheckStatusLabel(checkResult, t)}</span>
                      <strong>{checkedProvider ? checkedProvider.displayName : t("Provider check")}</strong>
                      <span>{providerCheckMessage(checkResult, t)}</span>
                      <small>{providerCheckGuidance(checkResult, checkedProvider ?? (editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined), t)}</small>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>

            <div className="provider-sheet-footer">
              <div className="action-row">
                <button className="secondary-button" type="button" onClick={closeProviderSheet}>
                  {t("Cancel")}
                </button>
                {editingProviderId ? (
                  <button className="secondary-button" type="button" disabled={isCheckingProviders} onClick={() => onCheck(editingProviderId)}>
                    {checkingProviderIds.includes(editingProviderId) ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                    {t("Check")}
                  </button>
                ) : null}
                <button className="primary-button" type="button" disabled={isCheckingProviders} onClick={() => void handleSaveProvider()}>
                  {isCheckingProviders ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                  {t("Save")}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function normalizeProviderEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
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
