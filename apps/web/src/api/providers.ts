import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderListResponse,
  ProviderModelListResponse,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";
import { providerFormToPayload } from "./provider-payloads.js";

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

export async function deleteProvider(cwd: string, providerId: string): Promise<void> {
  await daemonClient.deleteProvider(cwd, providerId);
}

export async function checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
  return daemonClient.checkProvider(cwd, providerId);
}

export async function checkProviderDraft(cwd: string, form: ProviderFormState): Promise<ProviderCheckResult> {
  return daemonClient.checkProviderDraft(cwd, providerFormToPayload(form));
}

export async function listProviderModels(cwd: string, form: ProviderFormState): Promise<ProviderModelListResponse> {
  return daemonClient.listProviderModels(cwd, {
    kind: form.kind,
    providerId: form.providerId,
    api: form.api,
    providerTransport: form.providerTransport || undefined,
    baseUrl: form.baseUrl || undefined,
    apiKey: form.apiKey.trim() || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    authHeader: form.authHeader,
  });
}
