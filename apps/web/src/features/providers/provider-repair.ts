import type { ProviderPreset } from "../../types.js";
import {
  isMediaProvider,
  providerCheckGuidance,
  providerCheckMessage,
  providerCheckStatusLabel,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunBlockerLabel,
  secretRefSetupGuidance,
} from "../../lib/providers.js";

type ProviderTranslate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export interface ProviderRepairItem {
  readonly provider: ProviderPreset;
  readonly title: string;
  readonly detail: string;
  readonly status: "attention" | "warning";
  readonly action: "check" | "edit";
  readonly actionLabel: string;
}

export function buildProviderRepairItems(providers: readonly ProviderPreset[], t?: ProviderTranslate): readonly ProviderRepairItem[] {
  return providers
    .map((provider) => buildProviderRepairItem(provider, t))
    .filter((item): item is ProviderRepairItem => item !== undefined)
    .slice(0, 4);
}

function buildProviderRepairItem(provider: ProviderPreset, t?: ProviderTranslate): ProviderRepairItem | undefined {
  if (isMediaProvider(provider)) {
    return undefined;
  }

  if (providerPreflightReady(provider)) {
    return undefined;
  }

  if (providerNeedsSecret(provider) && !provider.apiKeyConfigured) {
    return {
      provider,
      title: translateProviderText(t, "{providerName}: API key missing", { providerName: provider.displayName }),
      detail: secretRefSetupGuidance(provider.apiKeyRef, t),
      status: "attention",
      action: "edit",
      actionLabel: translateProviderText(t, "Edit"),
    };
  }

  if (!provider.enabled || provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return {
      provider,
      title: translateProviderText(t, "{providerName}: not chat-compatible", { providerName: provider.displayName }),
      detail: provider.api === "media-job"
        ? translateProviderText(t, "Generation-only models are not runnable for coding tasks.")
        : translateProviderText(t, "Current blocker: {reason}.", { reason: providerRunBlockerLabel(provider, t) }),
      status: "attention",
      action: "edit",
      actionLabel: translateProviderText(t, "Edit"),
    };
  }

  if (!provider.lastCheck) {
    return {
      provider,
      title: translateProviderText(t, "{providerName}: needs check", { providerName: provider.displayName }),
      detail: translateProviderText(t, "Validate API key, Base URL, protocol, and model before using it in Workspace."),
      status: "warning",
      action: "check",
      actionLabel: translateProviderText(t, "Check"),
    };
  }

  return {
    provider,
    title: translateProviderText(t, "{providerName}: {status}", {
      providerName: provider.displayName,
      status: providerCheckStatusLabel(provider.lastCheck, t),
    }),
    detail: `${providerCheckMessage(provider.lastCheck, t)} ${providerCheckGuidance(provider.lastCheck, provider, t)}`,
    status: "attention",
    action: "check",
    actionLabel: translateProviderText(t, "Retry"),
  };
}

function translateProviderText(
  t: ProviderTranslate | undefined,
  key: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  if (t) {
    return t(key, values);
  }
  if (!values) {
    return key;
  }
  return key.replace(/\{([A-Za-z0-9_]+)\}/g, (match, valueKey) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}
