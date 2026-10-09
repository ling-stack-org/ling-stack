import { useEffect, useMemo, useRef, useState } from "react";
import { listProviderModels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import {
  customOpenAICompatibleForm,
  normalizeProviderModelForImport,
  providerFormToTemplate,
  providerFormWithSelectedModel,
  providerModelDiscoveryErrorMessage,
} from "../../lib/providers.js";
import type {
  ProviderFormState,
  ProviderModelCatalogInfo,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
} from "../../types.js";
import { providerModelSourceLabel } from "./provider-discovery-view-models.js";
import {
  createProviderDiscoveryRequestFence,
  type ProviderDiscoveryRequestReceipt,
  type ProviderDiscoveryScopeReceipt,
} from "./provider-discovery-request-identity.js";
import type { ProviderImportResult, ProviderSaveResult } from "./types.js";
import {
  filterProviderTemplatesForSetupIntent,
  normalizeProviderEndpoint,
  selectProviderTemplateForSetupIntent,
  type ProviderSetupIntent,
} from "./provider-workbench-view-models.js";

const customTemplateId = "custom-openai-compatible";

export function useProviderEditorController(input: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly templates: readonly ProviderTemplate[];
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly selectedTemplateId: string;
  readonly setupIntent: ProviderSetupIntent | "";
  readonly onSetupIntentConsumed?: () => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: (template: ProviderTemplate) => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onSave: () => Promise<ProviderSaveResult>;
  readonly onImportModels: (models: readonly ProviderModelOption[]) => Promise<ProviderImportResult>;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [setupIntent, setSetupIntent] = useState<ProviderSetupIntent | "">("");
  const [storedModelOptions, setModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const modelOptionsContextRef = useRef<ProviderFormState | undefined>(undefined);
  const modelOptionsScopeRef = useRef<ProviderDiscoveryScopeReceipt | undefined>(undefined);
  const pendingRequestRef = useRef<ProviderDiscoveryRequestReceipt | undefined>(undefined);
  const [modelOptionsSource, setModelOptionsSource] = useState("");
  const [modelOptionsFetchedAt, setModelOptionsFetchedAt] = useState("");
  const [modelOptionsCatalog, setModelOptionsCatalog] = useState<ProviderModelCatalogInfo>();
  const [modelSearch, setModelSearch] = useState("");
  const [storedSelectedModelIds, setSelectedModelIds] = useState<readonly string[]>([]);
  const [modelFetchError, setModelFetchError] = useState("");
  const [modelSelectionNotice, setModelSelectionNotice] = useState("");
  const [storedIsFetchingModels, setIsFetchingModels] = useState(false);
  const [editorErrorMessage, setEditorErrorMessage] = useState("");
  const [editorWarningMessage, setEditorWarningMessage] = useState("");
  const requestFenceRef = useRef<ReturnType<typeof createProviderDiscoveryRequestFence> | undefined>(undefined);
  if (!requestFenceRef.current) requestFenceRef.current = createProviderDiscoveryRequestFence();
  const requestFence = requestFenceRef.current;
  const discoveryScope = requestFence.reconcile(input);
  if (discoveryScope.preserveResult && modelOptionsScopeRef.current !== discoveryScope) {
    modelOptionsScopeRef.current = discoveryScope;
  }
  const hasCurrentDiscovery = modelOptionsScopeRef.current === discoveryScope;
  const modelOptions = hasCurrentDiscovery ? storedModelOptions : [];
  const modelOptionsContext = hasCurrentDiscovery ? modelOptionsContextRef.current : undefined;
  const selectedModelIds = hasCurrentDiscovery ? storedSelectedModelIds : [];
  const isFetchingModels = storedIsFetchingModels && pendingRequestRef.current !== undefined &&
    requestFence.isCurrent(pendingRequestRef.current);

  const supplierTemplates = useMemo(
    () => dedupeTemplates([providerFormToTemplate(customOpenAICompatibleForm), ...input.templates]),
    [input.templates],
  );
  const visibleSupplierTemplates = useMemo(
    () => filterProviderTemplatesForSetupIntent(supplierTemplates, setupIntent),
    [setupIntent, supplierTemplates],
  );
  const setupModelOptions = useMemo(
    () => setupIntent === "video_generation"
      ? modelOptions.filter((model) => model.capabilities?.includes("video_generate"))
      : modelOptions,
    [modelOptions, setupIntent],
  );
  const visibleModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return query
      ? setupModelOptions.filter((model) => [model.id, model.displayName ?? "", model.ownedBy ?? ""]
        .some((value) => value.toLowerCase().includes(query)))
      : setupModelOptions;
  }, [modelSearch, setupModelOptions]);
  const selectedImportModels = useMemo(
    () => modelOptions
      .filter((model) => selectedModelIds.includes(model.id))
      .map((model) => normalizeProviderModelForImport(model, modelOptionsContext ?? input.form)),
    [input.form, modelOptions, modelOptionsContext, selectedModelIds],
  );
  const editingProvider = input.editingProviderId
    ? input.providers.find((provider) => provider.id === input.editingProviderId)
    : undefined;
  const selectedTemplateIsCustom = input.selectedTemplateId === customTemplateId;
  const matchingFixedTemplate = input.templates.find((template) =>
    template.providerId === input.form.providerId &&
    template.kind === input.form.kind &&
    template.templateId !== customTemplateId
  );
  const fixedTemplateMatchesCurrentShape = Boolean(
    matchingFixedTemplate &&
    matchingFixedTemplate.api === input.form.api &&
    normalizeProviderEndpoint(matchingFixedTemplate.baseUrl ?? "") === normalizeProviderEndpoint(input.form.baseUrl),
  );

  function clearDiscoveryResult(): void {
    modelOptionsScopeRef.current = undefined;
    modelOptionsContextRef.current = undefined;
    setModelOptions([]);
    setModelOptionsSource("");
    setModelOptionsFetchedAt("");
    setModelOptionsCatalog(undefined);
    setModelSearch("");
    setSelectedModelIds([]);
    setModelFetchError("");
    setModelSelectionNotice("");
    setEditorWarningMessage("");
  }

  function resetDiscovery(): void {
    requestFence.invalidate();
    pendingRequestRef.current = undefined;
    clearDiscoveryResult();
    setIsFetchingModels(false);
  }

  useEffect(() => {
    // Render already fenced the old scope. A layout consumer may have admitted
    // fresh work before this passive cleanup, so clear only obsolete state.
    if (!discoveryScope.preserveResult && modelOptionsScopeRef.current !== discoveryScope) {
      clearDiscoveryResult();
    }
    if (!pendingRequestRef.current || !requestFence.isCurrent(pendingRequestRef.current)) {
      pendingRequestRef.current = undefined;
      setIsFetchingModels(false);
    }
  }, [discoveryScope]);

  useEffect(() => {
    requestFence.activate();
    return () => requestFence.deactivate();
  }, [requestFence]);

  function openNew(intent: ProviderSetupIntent | "" = ""): void {
    const nextTemplate = selectProviderTemplateForSetupIntent({
      templates: supplierTemplates,
      intent,
      fallbackTemplate: providerFormToTemplate(customOpenAICompatibleForm),
    });
    input.onNew(nextTemplate);
    setSetupIntent(intent);
    setShowApiKey(false);
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    resetDiscovery();
    setIsOpen(true);
  }

  function openEdit(provider: ProviderPreset): void {
    input.onEdit(provider);
    setSetupIntent("");
    setShowApiKey(false);
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    resetDiscovery();
    setIsOpen(true);
  }

  function close(): void {
    resetDiscovery();
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    setSetupIntent("");
    setIsOpen(false);
  }

  useEffect(() => {
    if (!input.setupIntent || isOpen) return;
    if (input.setupIntent === "generation" && input.templates.length === 0) return;
    openNew(input.setupIntent);
    input.onSetupIntentConsumed?.();
  }, [input.setupIntent, input.templates.length, isOpen]);

  async function fetchModels(): Promise<void> {
    const receipt = requestFence.begin(discoveryScope);
    if (!receipt) return;
    const sourceForm: ProviderFormState = { ...input.form, thinkingModes: [...input.form.thinkingModes] };
    pendingRequestRef.current = receipt;
    setIsFetchingModels(true);
    setModelFetchError("");
    try {
      const response = await listProviderModels(input.cwd.trim(), sourceForm, input.editingProviderId || undefined);
      if (!requestFence.isCurrent(receipt)) return;
      const nextModels = response.models.map((model) => normalizeProviderModelForImport(model, sourceForm));
      modelOptionsScopeRef.current = receipt.scope;
      modelOptionsContextRef.current = sourceForm;
      setModelOptions(nextModels);
      setModelOptionsSource(providerModelSourceLabel(response.source, t));
      setModelOptionsFetchedAt(response.fetchedAt);
      setModelOptionsCatalog(response.catalog);
      setSelectedModelIds([]);
      setModelSelectionNotice(response.source === "builtin:generation-models" || response.source === "builtin:media-models"
        ? t("Could not read models from the provider. Built-in model candidates are shown.")
        : "");
      if (nextModels.length === 0) setModelFetchError(t("No models returned by this endpoint."));
    } catch (error) {
      if (!requestFence.isCurrent(receipt)) return;
      modelOptionsScopeRef.current = receipt.scope;
      modelOptionsContextRef.current = undefined;
      setModelOptions([]);
      setModelOptionsSource("");
      setModelOptionsFetchedAt("");
      setModelOptionsCatalog(undefined);
      setModelFetchError(providerModelDiscoveryErrorMessage(error, t));
    } finally {
      if (requestFence.isCurrent(receipt)) {
        pendingRequestRef.current = undefined;
        setIsFetchingModels(false);
      }
    }
  }

  function selectModel(model: ProviderModelOption): void {
    const result = providerFormWithSelectedModel(input.form, model, modelOptionsContext);
    requestFence.retainNextScope({ ...input, form: result.form });
    input.onFormChange(result.form);
    setModelSelectionNotice(result.notice ? t(result.notice) : "");
  }

  function toggleModel(model: ProviderModelOption): void {
    setSelectedModelIds((current) => current.includes(model.id)
      ? current.filter((id) => id !== model.id)
      : [...current, model.id]);
  }

  async function saveCurrent(): Promise<void> {
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    const result = await input.onSave();
    if (result.ok) close();
    else setEditorErrorMessage(result.errorMessage ?? "Save failed.");
  }

  async function submit(): Promise<void> {
    if (selectedImportModels.length === 0) {
      await saveCurrent();
      return;
    }
    setEditorErrorMessage("");
    setEditorWarningMessage("");
    const result = await input.onImportModels(selectedImportModels);
    if (result.ok) close();
    else setEditorErrorMessage(result.errorMessage ?? "Import failed.");
  }

  return {
    canEditCustomProviderFields: selectedTemplateIsCustom || !fixedTemplateMatchesCurrentShape,
    close,
    editingProvider,
    editorErrorMessage,
    editorWarningMessage,
    fetchModels,
    isFetchingModels,
    isOpen,
    modelFetchError: hasCurrentDiscovery ? modelFetchError : "",
    modelOptions,
    modelOptionsCatalog: hasCurrentDiscovery ? modelOptionsCatalog : undefined,
    modelOptionsFetchedAt: hasCurrentDiscovery ? modelOptionsFetchedAt : "",
    modelOptionsSource: hasCurrentDiscovery ? modelOptionsSource : "",
    modelSearch: hasCurrentDiscovery ? modelSearch : "",
    modelSelectionNotice: hasCurrentDiscovery ? modelSelectionNotice : "",
    openEdit,
    openCurrent: () => setIsOpen(true),
    openNew,
    resetDiscovery,
    selectAllVisible: () => setSelectedModelIds((current) => [...new Set([...current, ...visibleModelOptions.map((model) => model.id)])]),
    selectModel,
    selectedImportCount: selectedImportModels.length,
    selectedModelIds,
    setModelSearch,
    setShowApiKey,
    setupIntent,
    setupModelOptions,
    showApiKey,
    submit,
    saveCurrent,
    toggleModel,
    clearSelection: () => setSelectedModelIds([]),
    visibleModelOptions,
    visibleSupplierTemplates,
  } as const;
}

function dedupeTemplates(templates: readonly ProviderTemplate[]): readonly ProviderTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    if (seen.has(template.templateId)) return false;
    seen.add(template.templateId);
    return true;
  });
}
