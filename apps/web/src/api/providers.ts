import type {
  ProviderCheckResult,
  ProviderCapability,
  ProviderFormState,
  ProviderKeychainSecretConfigureRequest,
  ProviderKeychainSecretDeleteRequest,
  ProviderKeychainSecretResponse,
  ProviderListResponse,
  ProviderModelImportResponse,
  ProviderModelOption,
  ProviderModelListResponse,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";
import { parseSecretHeaderRefsText, providerFormToPayload } from "./provider-payloads.js";

export async function listProviders(cwd: string): Promise<ProviderListResponse> {
  return daemonClient.listProviders(cwd);
}

export async function listProviderTemplates(): Promise<ProviderTemplateListResponse> {
  return daemonClient.listProviderTemplates();
}

export async function createProvider(cwd: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.createProvider(cwd, providerFormToPayload(form));
}

export async function updateProvider(cwd: string, providerId: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.updateProvider(cwd, providerId, providerFormToPayload(form));
}

export async function getProviderSecret(cwd: string, providerId: string): Promise<ProviderSecretResponse> {
  return daemonClient.getProviderSecret(cwd, providerId);
}

export async function configureProviderKeychainSecret(
  cwd: string,
  providerId: string,
  input: ProviderKeychainSecretConfigureRequest,
): Promise<ProviderKeychainSecretResponse> {
  return daemonClient.configureProviderKeychainSecret(cwd, providerId, input);
}

export async function deleteProviderKeychainSecret(
  cwd: string,
  providerId: string,
  input: ProviderKeychainSecretDeleteRequest = {},
): Promise<ProviderKeychainSecretResponse> {
  return daemonClient.deleteProviderKeychainSecret(cwd, providerId, input);
}

export async function deleteProvider(cwd: string, providerId: string): Promise<void> {
  await daemonClient.deleteProvider(cwd, providerId);
}

export async function checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
  return daemonClient.checkProvider(cwd, providerId);
}

export async function checkProviderDraft(cwd: string, form: ProviderFormState): Promise<ProviderCheckResult> {
  return daemonClient.checkProviderDraft(cwd, providerFormToPayload(form));
}

export async function listProviderModels(
  cwd: string,
  form: ProviderFormState,
  providerPresetId?: string,
): Promise<ProviderModelListResponse> {
  return daemonClient.listProviderModels(cwd, {
    providerPresetId,
    kind: form.kind,
    providerId: form.providerId,
    api: form.api,
    providerTransport: form.providerTransport || undefined,
    baseUrl: form.baseUrl || undefined,
    apiKey: form.apiKey.trim() || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    secretHeaderRefs: parseSecretHeaderRefsText(form.secretHeaderRefsText),
    authHeader: form.authHeader,
  });
}

export async function importProviderModels(
  cwd: string,
  form: ProviderFormState,
  models: readonly ProviderModelOption[],
): Promise<ProviderModelImportResponse> {
  const payload = providerFormToPayload(form);
  return daemonClient.importProviderModels(cwd, {
    ...payload,
    capabilities: (payload.capabilities ?? []) as readonly ProviderCapability[],
    input: (payload.input ?? ["text"]) as readonly ("text" | "image")[],
    models,
  });
}
