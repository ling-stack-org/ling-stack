import {
  canWorkbenchBatchCheckProvider,
  canUseGenerationProviderForOperation,
  isWorkbenchNeedsConfigProvider,
  isWorkbenchReadyProvider,
  providerCheckIsPending,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunPreflightBlocker,
  sortProvidersForWorkbench,
} from "../../lib/providers.js";
import type {
  ProviderCheckResult,
  ProviderPreset,
  ProviderTemplate,
} from "../../types.js";

export {
  modelThinkingModes,
  providerModelCapabilitySourceLabel,
  providerModelSourceLabel,
  providerModelThinkingLabel,
  providerOrderedThinkingModes,
  providerThinkingModeLabel,
} from "./provider-discovery-view-models.js";

export type ProviderStatusFilter = "all" | "ready" | "needsAttention" | "missingKey" | "disabled";
export type ProviderCapabilityFilter = "all" | "video" | "image" | "chat";
export type ProviderSetupIntent = "chat" | "generation" | "video_generation";
export type ProviderPrimaryState =
  | "disabled"
  | "missing_api_key"
  | "checking"
  | "check_failed"
  | "needs_check"
  | "current_default"
  | "ready";
export type ProviderPrimaryAction = "enable" | "add_api_key" | "check" | "set_default" | undefined;
export type ProviderStatusTone = "neutral" | "success" | "attention" | "danger";

export type ProviderWorkbenchTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export interface ProviderWorkbenchSummary {
  readonly totalCount: number;
  readonly chatReadyCount: number;
  readonly generationReadyCount: number;
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
  readonly usageLabels: readonly string[];
  readonly primaryState: ProviderPrimaryState;
  readonly primaryAction: ProviderPrimaryAction;
  readonly primaryStatusLabel: string;
  readonly primaryStatusClass: string;
  readonly primaryStatusTone: ProviderStatusTone;
  readonly statusHint: string;
  readonly modelLabel: string;
  readonly sourceLabel: string;
  readonly sourceInitial: string;
  readonly secondaryLabel: string;
  readonly showInlineCheck: boolean;
  readonly showInlineEdit: boolean;
  readonly showDisableMenuAction: boolean;
}

export function providerTemplateMatchesSetupIntent(
  template: ProviderTemplate,
  intent: ProviderSetupIntent,
): boolean {
  if (intent === "video_generation") {
    return template.capabilities.includes("video_generate");
  }
  if (intent === "generation") {
    return template.api === "media-job" || hasGenerationCapability(template.capabilities);
  }
  return template.api !== "media-job" && template.capabilities.includes("chat");
}

export function filterProviderTemplatesForSetupIntent(
  templates: readonly ProviderTemplate[],
  intent: ProviderSetupIntent | "",
): readonly ProviderTemplate[] {
  if (!intent) {
    return templates;
  }
  const focusedTemplates = templates.filter((template) => providerTemplateMatchesSetupIntent(template, intent));
  return focusedTemplates.length > 0 ? focusedTemplates : templates;
}

export function selectProviderTemplateForSetupIntent({
  templates,
  intent,
  fallbackTemplate,
}: {
  readonly templates: readonly ProviderTemplate[];
  readonly intent: ProviderSetupIntent | "";
  readonly fallbackTemplate: ProviderTemplate;
}): ProviderTemplate {
  if (!intent) {
    return fallbackTemplate;
  }
  const preferredTemplateId = intent === "video_generation"
    ? "seedance-video"
    : intent === "generation"
      ? "seedream-image"
      : "openai-gpt";
  return (
    templates.find((template) => template.templateId === preferredTemplateId) ??
    templates.find((template) => providerTemplateMatchesSetupIntent(template, intent)) ??
    fallbackTemplate
  );
}

export function readProviderWorkbenchSummary(providers: readonly ProviderPreset[]): ProviderWorkbenchSummary {
  const generationOperations = ["image_generate", "image_edit", "video_generate"] as const;
  return {
    totalCount: providers.length,
    chatReadyCount: providers.filter((provider) =>
      provider.api !== "media-job" &&
      provider.capabilities.includes("chat") &&
      providerPreflightReady(provider)
    ).length,
    generationReadyCount: providers.filter((provider) =>
      generationOperations.some((operation) => canUseGenerationProviderForOperation(provider, operation))
    ).length,
    readyCount: providers.filter(isWorkbenchReadyProvider).length,
    needsAttentionCount: providers.filter(isWorkbenchNeedsConfigProvider).length,
    missingSecretCount: providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length,
    disabledCount: providers.filter((provider) => !provider.enabled).length,
    batchCheckProviderCount: providers.filter(canWorkbenchBatchCheckProvider).length,
  };
}

function hasGenerationCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) =>
    capability === "image_generate" || capability === "image_edit" || capability === "video_generate"
  );
}

export function filterProviderWorkbenchRoutes({
  providers,
  query,
  statusFilter,
  capabilityFilter,
  selectedProviderId,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly query: string;
  readonly statusFilter: ProviderStatusFilter;
  readonly capabilityFilter: ProviderCapabilityFilter;
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
    const matchesCapability =
      capabilityFilter === "all" ||
      (capabilityFilter === "video" && provider.capabilities.includes("video_generate")) ||
      (capabilityFilter === "image" && provider.capabilities.some((capability) => capability === "image_generate" || capability === "image_edit")) ||
      (capabilityFilter === "chat" && provider.api !== "media-job" && provider.capabilities.includes("chat"));
    return matchesQuery && matchesStatus && matchesCapability;
  }), selectedProviderId);
}

export function readProviderRouteRowView({
  provider,
  selectedProviderId,
  rowCheckGuidance,
  t,
}: {
  readonly provider: ProviderPreset;
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
  const ready = providerPreflightReady(provider) || canGenerate;
  const checking = providerCheckIsPending(provider.lastCheck);
  const primaryState: ProviderPrimaryState = !provider.enabled
    ? "disabled"
    : missingApiKey
      ? "missing_api_key"
      : checking
        ? "checking"
        : provider.lastCheck && !provider.lastCheck.ok
          ? "check_failed"
          : !ready
            ? "needs_check"
            : selectedForRun
              ? "current_default"
              : "ready";
  const primaryStatusLabel = primaryState === "disabled"
    ? t("Disabled")
    : primaryState === "missing_api_key"
      ? t("Needs API key")
      : primaryState === "checking"
        ? t("Checking")
        : primaryState === "check_failed"
          ? t("Needs attention")
          : primaryState === "needs_check"
            ? t("Needs check")
            : primaryState === "current_default"
              ? t("Current default")
              : t("Ready");
  const primaryStatusTone: ProviderStatusTone = primaryState === "check_failed"
    ? "danger"
    : primaryState === "missing_api_key" || primaryState === "needs_check"
      ? "attention"
      : primaryState === "ready"
        ? "success"
        : "neutral";
  const primaryStatusClass = [
    "provider-state",
    "provider-primary-status",
    `status-${primaryStatusTone}`,
    primaryState === "disabled"
      ? "disabled"
      : primaryState === "missing_api_key"
        ? "key-missing"
        : primaryState === "checking"
          ? "check-unknown"
          : primaryState === "check_failed"
            ? "check-bad"
            : primaryState === "needs_check"
              ? "check-unknown"
              : "run-ready",
  ].join(" ");
  const primaryAction: ProviderPrimaryAction = primaryState === "disabled"
    ? "enable"
    : primaryState === "missing_api_key"
      ? "add_api_key"
      : primaryState === "check_failed" || primaryState === "needs_check"
        ? "check"
        : primaryState === "ready" && chatCapable && canBeDefault
          ? "set_default"
          : undefined;
  const usageLabels = [
    chatCapable ? t("Chat") : "",
    provider.capabilities.some((capability) => capability === "image_generate" || capability === "image_edit") ? t("Image") : "",
    provider.capabilities.includes("video_generate") ? t("Video") : "",
  ].filter(Boolean);
  const statusHint = primaryState === "ready" || primaryState === "current_default" || primaryState === "checking"
    ? ""
    : providerRunPreflightBlocker(provider, t) ?? rowCheckGuidance;
  const isCustomRoute = provider.providerId === "custom-openai-compatible";
  const sourceLabel = isCustomRoute
    ? t("Custom access")
    : providerDisplaySourceLabel(provider.displayName, provider.model);
  const modelLabel = provider.model.trim() || provider.displayName.trim();
  const secondaryLabel = isCustomRoute || !sourceLabel || sourceLabel.toLowerCase() === modelLabel.toLowerCase()
    ? ""
    : sourceLabel;

  return {
    missingApiKey,
    selectedForRun,
    canBeDefault,
    chatCapable,
    generationCapable,
    canGenerate,
    ready,
    usageLabels,
    primaryState,
    primaryAction,
    primaryStatusLabel,
    primaryStatusClass,
    primaryStatusTone,
    statusHint,
    modelLabel,
    sourceLabel,
    sourceInitial: providerInitial(sourceLabel || provider.displayName),
    secondaryLabel,
    showInlineCheck: provider.enabled && !missingApiKey && !checking && primaryAction !== "check",
    showInlineEdit: primaryAction !== "add_api_key",
    showDisableMenuAction: provider.enabled,
  };
}

function providerDisplaySourceLabel(displayName: string, model: string): string {
  const normalizedDisplayName = displayName.trim();
  const normalizedModel = model.trim();
  if (!normalizedDisplayName || !normalizedModel) {
    return normalizedDisplayName;
  }
  const suffixes = [` · ${normalizedModel}`, ` / ${normalizedModel}`, ` - ${normalizedModel}`];
  const matchingSuffix = suffixes.find((suffix) =>
    normalizedDisplayName.toLowerCase().endsWith(suffix.toLowerCase())
  );
  return matchingSuffix
    ? normalizedDisplayName.slice(0, -matchingSuffix.length).trim()
    : normalizedDisplayName;
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
