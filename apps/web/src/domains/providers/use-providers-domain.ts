import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  checkProvider,
  checkProviderDraft,
  createProvider,
  deleteProvider,
  getProviderSecret,
  listProviderTemplates,
  listProviders,
  updateProvider,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { ProviderBatchResult } from "../../features/providers/index.js";
import {
  canBatchCheckProvider,
  defaultProviderForm,
  providerCheckGuidance,
  providerCheckStatusLabel,
  providerFormToTemplate,
  providerRunBlockerLabel,
  providerSecretReady,
  providerTemplateToForm,
  providerToForm,
} from "../../lib/providers.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
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
  readonly checkingProviderIds: readonly string[];
  readonly providerBatchResult: ProviderBatchResult | undefined;
  readonly providerSaveMessage: string;
  readonly providerRepairRunId: string;
}

export interface ProvidersActions {
  readonly setProviders: Dispatch<SetStateAction<readonly ProviderPreset[]>>;
  readonly setProviderForm: Dispatch<SetStateAction<ProviderFormState>>;
  readonly setEditingProviderId: Dispatch<SetStateAction<string>>;
  readonly setSelectedProviderTemplateId: Dispatch<SetStateAction<string>>;
  readonly setProviderCheck: Dispatch<SetStateAction<ProviderCheckResult | undefined>>;
  readonly setProviderCheckTargetId: Dispatch<SetStateAction<string>>;
  readonly setProviderBatchResult: Dispatch<SetStateAction<ProviderBatchResult | undefined>>;
  readonly setProviderRepairRunId: Dispatch<SetStateAction<string>>;
  readonly refreshProviders: (cwd?: string) => Promise<void>;
  readonly refreshProviderTemplates: () => Promise<void>;
  readonly checkProviderForRun: (provider: ProviderPreset) => Promise<boolean>;
  readonly saveProviderWithPreflight: () => Promise<{ readonly ok: boolean; readonly errorMessage?: string }>;
  readonly removeProvider: (providerId: string) => Promise<void>;
  readonly runProviderCheck: (providerId: string) => Promise<void>;
  readonly runProviderBatchCheck: () => Promise<void>;
  readonly editProvider: (provider: ProviderPreset) => void;
  readonly selectProviderTemplate: (template: ProviderTemplate) => void;
  readonly startNewProviderFromTemplate: (template: ProviderTemplate) => void;
  readonly loadProviderSecretIntoForm: (providerId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type ProvidersController = DomainController<ProvidersState, ProvidersActions>;

export function useProvidersDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string, params?: Record<string, string | number>) => string;
  readonly setErrorMessage: (message: string) => void;
  readonly applyProviderToRun: (provider: ProviderPreset) => Promise<void>;
  readonly clearSelectedProvider: (providerId: string) => void;
}): ProvidersController {
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerTemplates, setProviderTemplates] = useState<readonly ProviderTemplate[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [selectedProviderTemplateId, setSelectedProviderTemplateId] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheckResult | undefined>();
  const [providerCheckTargetId, setProviderCheckTargetId] = useState("");
  const [checkingProviderIds, setCheckingProviderIds] = useState<readonly string[]>([]);
  const [providerBatchResult, setProviderBatchResult] = useState<ProviderBatchResult | undefined>();
  const [providerSaveMessage, setProviderSaveMessage] = useState("");
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

  async function saveProviderWithPreflight(): Promise<{ readonly ok: boolean; readonly errorMessage?: string }> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      return { ok: false, errorMessage: "本地工作区未就绪" };
    }

    const nextProviderForm = { ...providerForm, enabled: true };
    const checkingId = editingProviderId || "provider_draft_check";
    try {
      setProviderSaveMessage("");
      setProviderCheck(undefined);
      setProviderCheckTargetId(checkingId);
      setProviderBatchResult(undefined);
      setCheckingProviderIds([checkingId]);
      setError(undefined);

      const draftCheck = await checkProviderDraft(workspaceCwd, nextProviderForm);
      setProviderCheck(draftCheck);
      if (!draftCheck.ok) {
        return { ok: false, errorMessage: draftCheck.message };
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
      await input.applyProviderToRun(savedProvider);

      setProviderCheckTargetId(savedProvider.id);
      const savedCheck = await checkProvider(workspaceCwd, savedProvider.id);
      setProviderCheck(savedCheck);
      await refreshProviders();
      if (!savedCheck.ok) {
        return { ok: false, errorMessage: savedCheck.message };
      }

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

  async function removeProvider(providerId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderCheck(undefined);
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
    const candidates = providers.filter(canBatchCheckProvider);
    if (candidates.length === 0) {
      input.setErrorMessage(input.translate("No enabled chat providers to check."));
      return;
    }

    try {
      input.setErrorMessage("");
      setError(undefined);
      setProviderCheck(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds(candidates.map((provider) => provider.id));

      let readyCount = 0;
      let failedCount = 0;
      for (const provider of candidates) {
        const result = await checkProvider(input.cwd.trim(), provider.id);
        if (result.ok) {
          readyCount += 1;
        } else {
          failedCount += 1;
        }
      }

      await refreshProviders();
      setProviderBatchResult({
        message: input.translate("Checked {count} chat providers: {readyCount} ready, {failedCount} failed.", {
          count: candidates.length,
          readyCount,
          failedCount,
        }),
        failedCount,
      });
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
    setSelectedProviderTemplateId("");
    setProviderCheck(undefined);
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
    setProviderCheckTargetId("");
    setProviderForm(providerTemplateToForm(template, input.translate));
  }

  function startNewProviderFromTemplate(template: ProviderTemplate): void {
    setProviderRepairRunId("");
    setEditingProviderId("");
    setSelectedProviderTemplateId(template.templateId);
    setProviderCheck(undefined);
    setProviderCheckTargetId("");
    setProviderForm(providerTemplateToForm(template, input.translate));
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
    setCheckingProviderIds([]);
    setProviderBatchResult(undefined);
    setProviderSaveMessage("");
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
      checkingProviderIds,
      providerBatchResult,
      providerSaveMessage,
      providerRepairRunId,
    },
    actions: {
      setProviders,
      setProviderForm,
      setEditingProviderId,
      setSelectedProviderTemplateId,
      setProviderCheck,
      setProviderCheckTargetId,
      setProviderBatchResult,
      setProviderRepairRunId,
      refreshProviders,
      refreshProviderTemplates,
      checkProviderForRun,
      saveProviderWithPreflight,
      removeProvider,
      runProviderCheck,
      runProviderBatchCheck,
      editProvider,
      selectProviderTemplate,
      startNewProviderFromTemplate,
      loadProviderSecretIntoForm,
      resetForCwd,
    },
    refresh: refreshProviders,
    isLoading: providersLoading,
    error,
    clearError: () => setError(undefined),
  };
}
