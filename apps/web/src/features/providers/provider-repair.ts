import type { ProviderPreset } from "../../types.js";
import {
  isMediaProvider,
  providerCheckGuidance,
  providerCheckStatusLabel,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunBlockerLabel,
  secretRefSetupGuidance,
} from "../../lib/providers.js";

export interface ProviderRepairItem {
  readonly provider: ProviderPreset;
  readonly title: string;
  readonly detail: string;
  readonly status: "attention" | "warning";
  readonly action: "check" | "edit";
  readonly actionLabel: string;
}

export function buildProviderRepairItems(providers: readonly ProviderPreset[]): readonly ProviderRepairItem[] {
  return providers
    .map(buildProviderRepairItem)
    .filter((item): item is ProviderRepairItem => item !== undefined)
    .slice(0, 4);
}

function buildProviderRepairItem(provider: ProviderPreset): ProviderRepairItem | undefined {
  if (isMediaProvider(provider)) {
    return undefined;
  }

  if (providerPreflightReady(provider)) {
    return undefined;
  }

  if (providerNeedsSecret(provider) && !provider.apiKeyConfigured) {
    return {
      provider,
      title: `${provider.displayName}: API key missing`,
      detail: secretRefSetupGuidance(provider.apiKeyRef),
      status: "attention",
      action: "edit",
      actionLabel: "Edit",
    };
  }

  if (!provider.enabled || provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return {
      provider,
      title: `${provider.displayName}: not chat-compatible`,
      detail: provider.api === "media-job" ? "Media providers are not runnable for coding tasks yet." : `Current blocker: ${providerRunBlockerLabel(provider)}.`,
      status: "attention",
      action: "edit",
      actionLabel: "Edit",
    };
  }

  if (!provider.lastCheck) {
    return {
      provider,
      title: `${provider.displayName}: needs check`,
      detail: "Validate API key, base URL, protocol, and model before using it in Workspace.",
      status: "warning",
      action: "check",
      actionLabel: "Check",
    };
  }

  return {
    provider,
    title: `${provider.displayName}: ${providerCheckStatusLabel(provider.lastCheck)}`,
    detail: `${provider.lastCheck.message} ${providerCheckGuidance(provider.lastCheck, provider)}`,
    status: "attention",
    action: "check",
    actionLabel: "Retry",
  };
}
