import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  checkProvider,
  checkProviderDraft,
  createProvider,
  deleteProvider,
  getProviderSecret,
  importProviderModels,
  listProviderTemplates,
  listProviders,
  updateProvider,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { ProviderBatchResult, ProviderCheckScope } from "../../features/providers/index.js";
import {
  canBatchCheckProvider,
  canWorkbenchBatchCheckProvider,
  defaultProviderForm,
  isMediaProvider,
  providerCheckDisplayMessage,
  providerCheckGuidance,
  providerCheckStatusLabel,
  providerFormToTemplate,
  providerMatchingTemplate,
  providerRunBlockerLabel,
  providerSecretReady,
  providerTemplateToForm,
  providerToForm,
} from "../../lib/providers.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelImportResponse,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
} from "../../types.js";

export interface ProvidersState {
  readonly providers: readonly ProviderPreset[];
  readonly providerTemplates: readonly ProviderTemplate[];
  readonly providersLoading: boolean;
  readonly providerForm: ProviderFormState;
  readonly editingProviderId: string;
  readonly selectedProviderTemplateId: string;
  readonly providerCheck: ProviderCheckResult | undefined;
  readonly providerCheckTargetId: string;
  readonly providerCheckScope: ProviderCheckScope | undefined;
  readonly checkingProviderIds: readonly string[];
  readonly providerBatchResult: ProviderBatchResult | undefined;
  readonly providerSaveMessage: string;
  readonly providerSaveMessageTone: "ok" | "warning";
  readonly providerRepairRunId: string;
}

export interface ProvidersActions {
  readonly setProviders: Dispatch<SetStateAction<readonly ProviderPreset[]>>;
  readonly setProviderForm: Dispatch<SetStateAction<ProviderFormState>>;
  readonly setEditingProviderId: Dispatch<SetStateAction<string>>;
  readonly setSelectedProviderTemplateId: Dispatch<SetStateAction<string>>;
  readonly setProviderCheck: Dispatch<SetStateAction<ProviderCheckResult | undefined>>;
  readonly setProviderCheckTargetId: Dispatch<SetStateAction<string>>;
  readonly setProviderCheckScope: Dispatch<SetStateAction<ProviderCheckScope | undefined>>;
  readonly setProviderBatchResult: Dispatch<SetStateAction<ProviderBatchResult | undefined>>;
  readonly setProviderRepairRunId: Dispatch<SetStateAction<string>>;
  readonly refreshProviders: (cwd?: string) => Promise<void>;
  readonly refreshProviderTemplates: () => Promise<void>;
  readonly checkProviderForRun: (provider: ProviderPreset) => Promise<boolean>;
  readonly saveProviderWithPreflight: () => Promise<{ readonly ok: boolean; readonly errorMessage?: string; readonly warningMessage?: string }>;
  readonly importModelsFromProviderForm: (models: readonly ProviderModelOption[]) => Promise<{ readonly ok: boolean; readonly response?: ProviderModelImportResponse; readonly errorMessage?: string }>;
  readonly removeProvider: (providerId: string) => Promise<void>;
  readonly runProviderCheck: (providerId: string) => Promise<void>;
  readonly runProviderBatchCheck: () => Promise<void>;
  readonly editProvider: (provider: ProviderPreset) => void;
  readonly selectProviderTemplate: (template: ProviderTemplate) => void;
  readonly startNewProviderFromTemplate: (template: ProviderTemplate) => void;
  readonly toggleProviderEnabled: (provider: ProviderPreset, enabled: boolean) => Promise<void>;
  readonly clearProviderCheckFeedback: (providerId: string) => void;
  readonly loadProviderSecretIntoForm: (providerId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type ProvidersController = DomainController<ProvidersState, ProvidersActions>;

export function useProvidersDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string, params?: Record<string, string | number>) => string;
  readonly setErrorMessage: (message: string) => void;
  readonly clearSelectedProvider: (providerId: string) => void;
  readonly clearProviderUsage: (providerId: string) => Promise<void>;
}): ProvidersController {
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerTemplates, setProviderTemplates] = useState<readonly ProviderTemplate[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [selectedProviderTemplateId, setSelectedProviderTemplateId] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheckResult | undefined>();
  const [providerCheckTargetId, setProviderCheckTargetId] = useState("");
  const [providerCheckScope, setProviderCheckScope] = useState<ProviderCheckScope | undefined>();
  const [checkingProviderIds, setCheckingProviderIds] = useState<readonly string[]>([]);
  const [providerBatchResult, setProviderBatchResult] = useState<ProviderBatchResult | undefined>();
  const [providerSaveMessage, setProviderSaveMessage] = useState("");
  const [providerSaveMessageTone, setProviderSaveMessageTone] = useState<"ok" | "warning">("ok");
  const [providerRepairRunId, setProviderRepairRunId] = useState("");
  const [error, setError] = useState<DomainError | undefined>();

  useEffect(() => {
    if (!providerSaveMessage) {
      return;
    }
    const timeout = window.setTimeout(() => setProviderSaveMessage(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [providerSaveMessage]);

  async function refreshProviders(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setProviders([]);
      return;
    }

    setProvidersLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await listProviders(cwd);
      setProviders(response.providers);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setProvidersLoading(false);
    }
  }

  async function refreshProviderTemplates(): Promise<void> {
    try {
      setError(undefined);
      const response = await listProviderTemplates();
      setProviderTemplates(response.templates);
    } catch (caught) {
      setError({ scope: "load", message: caught instanceof Error ? caught.message : String(caught) });
      setProviderTemplates([]);
    }
  }

  async function checkProviderForRun(provider: ProviderPreset): Promise<boolean> {
    if (!canBatchCheckProvider(provider)) {
      input.setErrorMessage(input.translate("Provider preset is not runnable: {reason}", { reason: providerRunBlockerLabel(provider, input.translate) }));
      return false;
    }

    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderBatchResult(undefined);
      setCheckingProviderIds([provider.id]);
      setProviderCheckTargetId(provider.id);
      const result = await checkProvider(input.cwd.trim(), provider.id);
      setProviderCheck(result);
      await refreshProviders();
      if (!result.ok) {
        input.setErrorMessage(`${provider.displayName}: provider check failed (${providerCheckStatusLabel(result)}). ${providerCheckGuidance(result, provider)}`);
        return false;
      }
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      return false;
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function saveProviderWithPreflight(): Promise<{ readonly ok: boolean; readonly errorMessage?: string; readonly warningMessage?: string }> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      return { ok: false, errorMessage: "本地工作区未就绪" };
    }

    const nextProviderForm = { ...providerForm, enabled: true };
    const checkingId = editingProviderId || "provider_draft_check";
    try {
      setProviderSaveMessage("");
      setProviderCheck(undefined);
      setProviderCheckScope("save");
      setProviderCheckTargetId(checkingId);
      setProviderBatchResult(undefined);
      setCheckingProviderIds([checkingId]);
      setError(undefined);

      const draftCheck = await checkProviderDraft(workspaceCwd, nextProviderForm);
      setProviderCheck(draftCheck);
      if (!draftCheck.ok && providerCheckBlocksSave(draftCheck)) {
        return { ok: false, errorMessage: providerCheckDisplayMessage(draftCheck, { api: nextProviderForm.api }, input.translate) };
      }

      const response = editingProviderId
        ? await updateProvider(workspaceCwd, editingProviderId, nextProviderForm)
        : await createProvider(workspaceCwd, nextProviderForm);
      const savedProvider = response.provider;
      setEditingProviderId(savedProvider.id);
      setProviderForm({
        ...providerToForm(savedProvider, providerTemplates),
        apiKey: nextProviderForm.clearApiKey ? "" : nextProviderForm.apiKey,
      });

      if (savedProvider.api === "media-job") {
        await refreshProviders();
        setProviderSaveMessageTone("ok");
        setProviderSaveMessage(input.translate("Model preset saved successfully."));
        return { ok: true };
      }
      setProviderCheckTargetId(savedProvider.id);
      const savedCheck = await checkProvider(workspaceCwd, savedProvider.id);
      setProviderCheck(savedCheck);
      await refreshProviders();
      if (!savedCheck.ok) {
        const warningMessage = input.translate(providerSaveWarningMessage(savedCheck));
        setProviderSaveMessageTone("warning");
        setProviderSaveMessage(warningMessage);
        return { ok: true, warningMessage };
      }

      setProviderSaveMessageTone("ok");
      setProviderSaveMessage(input.translate("Model preset saved successfully."));
      return { ok: true };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      return { ok: false, errorMessage: message };
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function importModelsFromProviderForm(
    models: readonly ProviderModelOption[],
  ): Promise<{ readonly ok: boolean; readonly response?: ProviderModelImportResponse; readonly errorMessage?: string }> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      return { ok: false, errorMessage: "本地工作区未就绪" };
    }
    if (models.length === 0) {
      return { ok: false, errorMessage: input.translate("Select at least one model.") };
    }

    try {
      setProviderSaveMessage("");
      setProviderCheck(undefined);
      setProviderCheckScope("save");
      setProviderCheckTargetId("provider_model_import");
      setProviderBatchResult(undefined);
      setCheckingProviderIds(["provider_model_import"]);
      setError(undefined);
      const response = await importProviderModels(workspaceCwd, { ...providerForm, enabled: true }, models);
      await refreshProviders();
      setProviderSaveMessageTone(response.warnings.length > 0 ? "warning" : "ok");
      setProviderSaveMessage(input.translate("Imported {count} model presets.", { count: response.createdCount + response.updatedCount }));
      return { ok: true, response };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      return { ok: false, errorMessage: message };
    } finally {
      setCheckingProviderIds([]);
      setProviderCheckScope(undefined);
      setProviderCheckTargetId("");
    }
  }

  function providerCheckBlocksSave(result: ProviderCheckResult): boolean {
    return [
      "bad_request",
      "provider_disabled",
      "secret_missing",
      "secret_store_unavailable",
      "model_api_mismatch",
      "unsupported_capability",
    ].includes(result.code ?? "");
  }

  function providerSaveWarningMessage(result: ProviderCheckResult): string {
    if (result.code === "model_unsupported") {
      return "Saved, but model check failed. Verify Base URL, model access, or inference endpoint.";
    }
    if (result.code === "auth_failed") {
      return "Saved, but authentication check failed. Verify the API key and account permission.";
    }
    return "Saved, but provider check failed. Review the configuration and run Check again.";
  }

  async function removeProvider(providerId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderCheck(undefined);
      setProviderCheckScope(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      await deleteProvider(input.cwd.trim(), providerId);
      if (editingProviderId === providerId) {
        setEditingProviderId("");
        setProviderForm(defaultProviderForm);
      }
      input.clearSelectedProvider(providerId);
      await refreshProviders();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    }
  }

  async function runProviderCheck(providerId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderBatchResult(undefined);
      setProviderCheck(undefined);
      setProviderCheckScope("row");
      setCheckingProviderIds([providerId]);
      setProviderCheckTargetId(providerId);
      const provider = providers.find((item) => item.id === providerId);
      if (provider && !provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat") && providerSecretReady(provider)) {
        await updateProvider(input.cwd.trim(), providerId, { ...providerToForm(provider), enabled: true });
        if (editingProviderId === providerId) {
          setProviderForm((current) => ({ ...current, enabled: true }));
        }
      }
      const result = await checkProvider(input.cwd.trim(), providerId);
      setProviderCheck(result);
      await refreshProviders();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function runProviderBatchCheck(): Promise<void> {
    const candidates = providers.filter(canWorkbenchBatchCheckProvider);
    if (candidates.length === 0) {
      input.setErrorMessage(input.translate("No enabled model presets to check."));
      return;
    }

    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderCheck(undefined);
      setProviderCheckScope("batch");
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds(candidates.map((provider) => provider.id));

      let readyCount = 0;
      let failedCount = 0;
      let chatCount = 0;
      let mediaCount = 0;
      for (const provider of candidates) {
        if (isMediaProvider(provider)) {
          mediaCount += 1;
        } else {
          chatCount += 1;
        }
        const result = await checkProvider(input.cwd.trim(), provider.id);
        if (result.ok) {
          readyCount += 1;
        } else {
          failedCount += 1;
        }
      }

      await refreshProviders();
      const nextBatchResult = {
        message: input.translate("Checked {count} model presets: {readyCount} ready, {failedCount} failed. Chat {chatCount} / media {mediaCount}.", {
          count: candidates.length,
          readyCount,
          failedCount,
          chatCount,
          mediaCount,
        }),
        failedCount,
      };
      setProviderBatchResult(nextBatchResult);
      window.setTimeout(() => {
        setProviderBatchResult((current) => current === nextBatchResult ? undefined : current);
      }, 2000);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setCheckingProviderIds([]);
    }
  }

  function editProvider(provider: ProviderPreset): void {
    setEditingProviderId(provider.id);
    setSelectedProviderTemplateId(providerMatchingTemplate(provider, providerTemplates)?.templateId ?? "custom-openai-compatible");
    setProviderCheck(undefined);
    setProviderCheckScope(undefined);
    setProviderCheckTargetId("");
    setProviderBatchResult(undefined);
    setProviderRepairRunId("");
    setProviderForm(providerToForm(provider, providerTemplates));
    if (provider.apiKeyRef?.startsWith("local:")) {
      void loadProviderSecretIntoForm(provider.id);
    }
  }

  function selectProviderTemplate(template: ProviderTemplate): void {
    setProviderRepairRunId("");
    setEditingProviderId("");
    setSelectedProviderTemplateId(template.templateId);
    setProviderCheck(undefined);
    setProviderCheckScope(undefined);
    setProviderCheckTargetId("");
    setProviderForm((current) => {
      const nextForm = providerTemplateToForm(template, input.translate);
      if (current.api !== "media-job" || template.api !== "media-job") {
        return nextForm;
      }
      return {
        ...nextForm,
        apiKey: current.apiKey,
        clearApiKey: current.clearApiKey,
        baseUrl: nextForm.baseUrl || current.baseUrl,
      };
    });
  }

  function startNewProviderFromTemplate(template: ProviderTemplate): void {
    setProviderRepairRunId("");
    setEditingProviderId("");
    setSelectedProviderTemplateId(template.templateId);
    setProviderCheck(undefined);
    setProviderCheckScope(undefined);
    setProviderCheckTargetId("");
    setProviderForm(providerTemplateToForm(template, input.translate));
  }

  async function toggleProviderEnabled(provider: ProviderPreset, enabled: boolean): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return;
    }

    const shouldClearDefault = !enabled;
    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderBatchResult(undefined);
      const response = await updateProvider(workspaceCwd, provider.id, { ...providerToForm(provider, providerTemplates), enabled });
      if (editingProviderId === provider.id) {
        setProviderForm((current) => ({ ...current, enabled: response.provider.enabled }));
      }
      setProviders((current) => current.map((item) => (item.id === provider.id ? response.provider : item)));
      if (shouldClearDefault) {
        await input.clearProviderUsage(provider.id);
      }
      await refreshProviders();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      await refreshProviders(workspaceCwd);
    }
  }

  function clearProviderCheckFeedback(providerId: string): void {
    if (providerCheckScope !== "row" || providerCheckTargetId !== providerId) {
      return;
    }
    setProviderCheck(undefined);
    setProviderCheckScope(undefined);
    setProviderCheckTargetId("");
  }

  async function loadProviderSecretIntoForm(providerId: string): Promise<void> {
    try {
      const secret = await getProviderSecret(input.cwd.trim(), providerId);
      setProviderForm((current) => ({ ...current, apiKey: secret.apiKey, clearApiKey: false }));
    } catch {
      setProviderForm((current) => current);
    }
  }

  function resetForCwd(): void {
    setProviders([]);
    setProvidersLoading(false);
    setProviderForm(defaultProviderForm);
    setEditingProviderId("");
    setSelectedProviderTemplateId("");
    setProviderCheck(undefined);
    setProviderCheckTargetId("");
    setProviderCheckScope(undefined);
    setCheckingProviderIds([]);
    setProviderBatchResult(undefined);
    setProviderSaveMessage("");
    setProviderSaveMessageTone("ok");
    setProviderRepairRunId("");
    setError(undefined);
  }

  return {
    state: {
      providers,
      providerTemplates,
      providersLoading,
      providerForm,
      editingProviderId,
      selectedProviderTemplateId,
      providerCheck,
      providerCheckTargetId,
      providerCheckScope,
      checkingProviderIds,
      providerBatchResult,
      providerSaveMessage,
      providerSaveMessageTone,
      providerRepairRunId,
    },
    actions: {
      setProviders,
      setProviderForm,
      setEditingProviderId,
      setSelectedProviderTemplateId,
      setProviderCheck,
      setProviderCheckTargetId,
      setProviderCheckScope,
      setProviderBatchResult,
      setProviderRepairRunId,
      refreshProviders,
      refreshProviderTemplates,
      checkProviderForRun,
      saveProviderWithPreflight,
      importModelsFromProviderForm,
      removeProvider,
      runProviderCheck,
      runProviderBatchCheck,
      editProvider,
      selectProviderTemplate,
      startNewProviderFromTemplate,
      toggleProviderEnabled,
      clearProviderCheckFeedback,
      loadProviderSecretIntoForm,
      resetForCwd,
    },
    refresh: refreshProviders,
    isLoading: providersLoading,
    error,
    clearError: () => setError(undefined),
  };
}
