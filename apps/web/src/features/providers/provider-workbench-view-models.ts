import { formatDateTime } from "../../lib/formatting.js";
import {
  canWorkbenchBatchCheckProvider,
  canUseGenerationProviderForOperation,
  canUseProviderForRun,
  isWorkbenchNeedsConfigProvider,
  isWorkbenchReadyProvider,
  providerCapabilityChipLabels,
  providerEffectiveBaseUrl,
  providerGenerationRuntimeSummary,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerSecretHeaderSummary,
  sortProvidersForWorkbench,
} from "../../lib/providers.js";
import type {
  ProviderCheckResult,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
  ProviderThinkingMode,
} from "../../types.js";

export type ProviderStatusFilter = "all" | "ready" | "needsAttention" | "missingKey" | "disabled";

export type ProviderWorkbenchTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export interface ProviderWorkbenchSummary {
  readonly readyCount: number;
  readonly needsAttentionCount: number;
  readonly missingSecretCount: number;
  readonly disabledCount: number;
  readonly batchCheckProviderCount: number;
}

export interface ProviderRouteRowView {
  readonly missingApiKey: boolean;
  readonly selectedForRun: boolean;
  readonly canBeDefault: boolean;
  readonly chatCapable: boolean;
  readonly generationCapable: boolean;
  readonly canGenerate: boolean;
  readonly ready: boolean;
  readonly effectiveBaseUrl: string;
  readonly primaryStatusLabel: string;
  readonly primaryStatusClass: string;
  readonly statusHint: string;
  readonly mainActionIsCheck: boolean;
  readonly generationRuntimeSummary: string;
  readonly secretHeaderSummary: string;
  readonly capabilitySummary: string;
  readonly lastCheckSummary: string;
}

export function readProviderWorkbenchSummary(providers: readonly ProviderPreset[]): ProviderWorkbenchSummary {
  return {
    readyCount: providers.filter(isWorkbenchReadyProvider).length,
    needsAttentionCount: providers.filter(isWorkbenchNeedsConfigProvider).length,
    missingSecretCount: providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length,
    disabledCount: providers.filter((provider) => !provider.enabled).length,
    batchCheckProviderCount: providers.filter(canWorkbenchBatchCheckProvider).length,
  };
}

export function filterProviderWorkbenchRoutes({
  providers,
  query,
  statusFilter,
  selectedProviderId,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly query: string;
  readonly statusFilter: ProviderStatusFilter;
  readonly selectedProviderId: string;
}): readonly ProviderPreset[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sortProvidersForWorkbench(providers.filter((provider) => {
    const matchesQuery =
      !normalizedQuery ||
      [provider.displayName, provider.providerId, provider.model, provider.api, provider.baseUrl ?? ""]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "ready" && isWorkbenchReadyProvider(provider)) ||
      (statusFilter === "missingKey" && providerNeedsSecret(provider) && !provider.apiKeyConfigured) ||
      (statusFilter === "needsAttention" && isWorkbenchNeedsConfigProvider(provider)) ||
      (statusFilter === "disabled" && !provider.enabled);
    return matchesQuery && matchesStatus;
  }), selectedProviderId);
}

export function readProviderRouteRowView({
  provider,
  templates,
  selectedProviderId,
  rowCheckGuidance,
  t,
}: {
  readonly provider: ProviderPreset;
  readonly templates: readonly ProviderTemplate[];
  readonly selectedProviderId: string;
  readonly rowCheckGuidance: string;
  readonly t: ProviderWorkbenchTranslate;
}): ProviderRouteRowView {
  const missingApiKey = providerNeedsSecret(provider) && !provider.apiKeyConfigured;
  const selectedForRun = provider.id === selectedProviderId;
  const canBeDefault = providerPreflightReady(provider);
  const chatCapable = provider.capabilities.includes("chat") && provider.api !== "media-job";
  const generationCapable = provider.capabilities.some((capability) =>
    capability === "image_generate" || capability === "image_edit" || capability === "video_generate"
  );
  const canGenerate = (["image_generate", "image_edit", "video_generate"] as const).some((operation) =>
    canUseGenerationProviderForOperation(provider, operation)
  );
  const ready = providerPreflightReady(provider);
  const primaryStatusLabel = missingApiKey
    ? t("Needs config")
    : !provider.enabled
      ? t("disabled")
      : selectedForRun
        ? t("Current default")
        : ready
          ? t("Ready to use")
          : generationCapable && !chatCapable
            ? canGenerate ? t("Ready to generate") : t("Generation model")
            : canUseProviderForRun(provider)
              ? t("needs check")
              : providerRunBlockerLabel(provider, t);
  const primaryStatusClass = missingApiKey
    ? "provider-state check-unknown"
    : selectedForRun || ready || (generationCapable && !chatCapable && canGenerate)
      ? "provider-state run-ready"
      : generationCapable && !chatCapable
        ? "provider-state check-unknown"
        : provider.enabled
          ? "provider-state run-blocked"
          : "provider-state disabled";
  const statusHint =
    missingApiKey || !provider.enabled || (!ready && chatCapable)
      ? (providerRunPreflightBlocker(provider, t) ?? rowCheckGuidance)
      : generationCapable && !canGenerate
        ? t("Real generation is not connected yet.")
        : "";
  const capabilitySummary = providerCapabilityChipLabels(provider, t).join(" / ");
  const lastCheckSummary = provider.lastCheck
    ? t("last check {time}", { time: formatDateTime(provider.lastCheck.checkedAt) })
    : t("not checked");

  return {
    missingApiKey,
    selectedForRun,
    canBeDefault,
    chatCapable,
    generationCapable,
    canGenerate,
    ready,
    effectiveBaseUrl: providerEffectiveBaseUrl(provider, templates) || t("default endpoint"),
    primaryStatusLabel,
    primaryStatusClass,
    statusHint,
    mainActionIsCheck: !missingApiKey && !ready && canUseProviderForRun(provider),
    generationRuntimeSummary: providerGenerationRuntimeSummary(provider, t) ?? "",
    secretHeaderSummary: providerSecretHeaderSummary(provider, t) ?? "",
    capabilitySummary,
    lastCheckSummary,
  };
}

export function providerModelSourceLabel(source: string, t: ProviderWorkbenchTranslate): string {
  if (source === "builtin:generation-models" || source === "builtin:media-models") {
    return t("Built-in generation model candidates");
  }
  return source;
}

export function providerInitial(displayName: string): string {
  const normalizedName = displayName.trim();
  if (!normalizedName) {
    return "#";
  }
  return normalizedName.slice(0, 1).toUpperCase();
}

export function normalizeProviderEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function providerModelThinkingLabel(
  model: ProviderModelOption,
  t: ProviderWorkbenchTranslate,
): string {
  const modes = modelThinkingModes(model);
  if (modes.length === 0) {
    return t("No thinking");
  }
  return t("Thinking: {modes}", { modes: modes.map((mode) => providerThinkingModeLabel(mode, t)).join(" / ") });
}

export function providerModelCapabilitySourceLabel(
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

export function modelThinkingModes(model: ProviderModelOption): readonly ProviderThinkingMode[] {
  const modes = model.thinkingModes ?? [];
  return providerOrderedThinkingModes(modes).filter((mode) => mode !== "off");
}

export function providerOrderedThinkingModes(modes: readonly ProviderThinkingMode[]): readonly ProviderThinkingMode[] {
  const selectedModes = new Set(modes);
  const order: readonly ProviderThinkingMode[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh"];
  return order.filter((mode) => selectedModes.has(mode));
}

export function providerThinkingModeLabel(
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

export function readProviderCheckFeedback(
  result: ProviderCheckResult | undefined,
  provider: ProviderPreset,
  t: ProviderWorkbenchTranslate,
  readMessage: (result: ProviderCheckResult, provider: ProviderPreset, t: ProviderWorkbenchTranslate) => string,
  readGuidance: (result: ProviderCheckResult, provider: ProviderPreset, t: ProviderWorkbenchTranslate) => string,
): { readonly message: string; readonly guidance: string } {
  if (!result) {
    return { message: "", guidance: "" };
  }
  return {
    message: readMessage(result, provider, t),
    guidance: readGuidance(result, provider, t),
  };
}
