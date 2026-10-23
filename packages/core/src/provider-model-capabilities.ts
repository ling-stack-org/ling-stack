import { defaultProviderTemplates, type ProviderTemplate } from "./provider-templates.js";
import type { ProviderApi, ProviderCapability, ProviderKind, ProviderPreset, ProviderThinkingMode } from "./provider-types.js";

export type ProviderModelCapabilitySource =
  | "user_override"
  | "model_registry"
  | "provider_template"
  | "provider_metadata"
  | "health_check"
  | "runtime_observed"
  | "conservative_default"
  | "non_chat";

export type ProviderModelCapabilityConfidence = "known" | "estimated" | "conservative";
export type ProviderModelTokenizer = "openai-compatible" | "anthropic-compatible" | "estimated";

export interface ProviderModelCapabilityBase {
  readonly providerPresetId?: string;
  readonly providerKind?: ProviderKind;
  readonly providerApi?: ProviderApi;
  readonly modelId?: string;
  readonly source: ProviderModelCapabilitySource;
  readonly confidence: ProviderModelCapabilityConfidence;
  readonly tokenizer: ProviderModelTokenizer;
  readonly supportsStructuredOutput: boolean;
  readonly observedAt?: string;
  readonly reason?: string;
}

export interface ProviderModelChatCapabilitySnapshot extends ProviderModelCapabilityBase {
  readonly chatEligible: true;
  readonly source: Exclude<ProviderModelCapabilitySource, "non_chat">;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export interface ProviderModelNonChatCapabilitySnapshot extends ProviderModelCapabilityBase {
  readonly chatEligible: false;
  readonly source: "non_chat";
  readonly contextWindowTokens?: undefined;
  readonly maxOutputTokens?: undefined;
}

export type ProviderModelCapabilitySnapshot =
  | ProviderModelChatCapabilitySnapshot
  | ProviderModelNonChatCapabilitySnapshot;

export interface ResolveProviderModelCapabilitySnapshotOptions {
  readonly templates?: readonly ProviderTemplate[];
  readonly runtimeObservation?: ProviderModelRuntimeObservation;
}

type ProviderModelCapabilityPreset = Pick<
  ProviderPreset,
  | "id"
  | "kind"
  | "providerId"
  | "model"
  | "api"
  | "contextWindow"
  | "maxTokens"
  | "capabilities"
>;

export type ProviderModelThinkingModeInput = Pick<
  ProviderPreset,
  "api" | "kind" | "providerId" | "model"
> & {
  readonly capabilities?: readonly ProviderCapability[];
};

interface ProviderFamilyEstimate {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export interface ProviderModelRuntimeObservation {
  readonly providerPresetId?: string;
  readonly providerKind?: ProviderKind;
  readonly providerApi?: ProviderApi;
  readonly modelId?: string;
  readonly previousContextWindowTokens: number;
  readonly observedContextWindowTokens: number;
  readonly failureCode: string;
  readonly observedAt: string;
}

const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 8_192;
const ESTIMATED_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 1_024;
const STRUCTURED_OUTPUT_APIS = new Set<ProviderApi>(["openai-responses", "openai-completions"]);
const ESTIMATED_PROVIDER_FAMILIES = new Set<ProviderKind>(["openai", "anthropic", "google", "doubao", "deepseek", "minimax", "glm"]);
const FULL_THINKING_MODES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ProviderThinkingMode[];

export function resolveProviderModelCapabilitySnapshot(
  providerPreset: ProviderModelCapabilityPreset | undefined,
  options: ResolveProviderModelCapabilitySnapshotOptions = {},
): ProviderModelCapabilitySnapshot {
  if (!providerPreset) {
    return conservativeSnapshot(undefined, "No provider preset was selected.");
  }

  const base = snapshotBase(providerPreset);
  const chatEligible = providerPreset.api !== "media-job" && providerPreset.capabilities.includes("chat");
  if (!chatEligible) {
    return {
      ...base,
      chatEligible: false,
      source: "non_chat",
      confidence: "conservative",
      tokenizer: "estimated",
      supportsStructuredOutput: false,
      reason: "Provider does not expose chat context budgeting.",
    };
  }

  const userContextWindowTokens = positiveInteger(providerPreset.contextWindow);
  const userMaxOutputTokens = positiveInteger(providerPreset.maxTokens);
  const template = matchingProviderTemplate(providerPreset, options.templates ?? defaultProviderTemplates());
  const templateContextWindowTokens = positiveInteger(template?.contextWindow);
  const templateMaxOutputTokens = positiveInteger(template?.maxTokens);
  const familyEstimate = providerFamilyEstimate(providerPreset);

  // An output limit says nothing about the model's context capacity. Only an
  // explicit context override may bypass observed context-window downgrades.
  if (userContextWindowTokens) {
    return chatSnapshot(providerPreset, {
      source: "user_override",
      confidence: "known",
      contextWindowTokens: userContextWindowTokens,
      maxOutputTokens:
        userMaxOutputTokens ??
        templateMaxOutputTokens ??
        familyEstimate.maxOutputTokens,
      reason: "Advanced provider token fields override automatic capability detection.",
    });
  }

  if (templateContextWindowTokens || templateMaxOutputTokens) {
    return applyRuntimeObservation(chatSnapshot(providerPreset, {
      source: "provider_template",
      confidence: "known",
      contextWindowTokens: templateContextWindowTokens ?? familyEstimate.contextWindowTokens,
      maxOutputTokens: userMaxOutputTokens ?? templateMaxOutputTokens ?? familyEstimate.maxOutputTokens,
      reason: `Matched bundled provider template ${template?.templateId ?? "unknown"}.`,
    }), options.runtimeObservation);
  }

  if (ESTIMATED_PROVIDER_FAMILIES.has(providerPreset.kind)) {
    return applyRuntimeObservation(chatSnapshot(providerPreset, {
      source: "provider_metadata",
      confidence: "estimated",
      contextWindowTokens: familyEstimate.contextWindowTokens,
      maxOutputTokens: userMaxOutputTokens ?? familyEstimate.maxOutputTokens,
      reason: "Known provider family without exact model capability metadata.",
    }), options.runtimeObservation);
  }

  return applyRuntimeObservation(
    {
      ...conservativeSnapshot(providerPreset, "Unknown compatible provider uses conservative context defaults."),
      maxOutputTokens: userMaxOutputTokens ?? familyEstimate.maxOutputTokens,
    },
    options.runtimeObservation,
  );
}

export function resolveProviderModelThinkingModes(input: ProviderModelThinkingModeInput): readonly ProviderThinkingMode[] {
  if (input.api === "media-job") {
    return [];
  }
  if (input.capabilities?.includes("reasoning")) {
    return FULL_THINKING_MODES;
  }
  if (input.capabilities && input.capabilities.length > 0) {
    return [];
  }

  const model = input.model.toLowerCase();
  const providerId = input.providerId.toLowerCase();
  if (isKnownOpenAiReasoningModel(model, input.kind, providerId)) {
    return FULL_THINKING_MODES;
  }
  if (isKnownAnthropicThinkingModel(model, input.kind, providerId)) {
    return FULL_THINKING_MODES;
  }
  if (isKnownGeminiThinkingModel(model, input.kind, providerId)) {
    return FULL_THINKING_MODES;
  }
  if (isKnownDeepSeekReasoningModel(model, input.kind, providerId)) {
    return FULL_THINKING_MODES;
  }
  return [];
}

function isKnownOpenAiReasoningModel(model: string, kind: ProviderKind, providerId: string): boolean {
  if (kind !== "openai" && kind !== "openai-compatible" && providerId !== "openai") {
    return false;
  }
  return /(^|[-_/])(?:gpt-(?:5|6|daybreak)|o1|o3|o4)(?=$|[-_/.])/u.test(model) || model.includes("codex");
}

function isKnownAnthropicThinkingModel(model: string, kind: ProviderKind, providerId: string): boolean {
  if (kind !== "anthropic" && kind !== "openai-compatible" && providerId !== "anthropic") {
    return false;
  }
  return /claude-(?:3-7|4|5|(?:fable|haiku|opus|sonnet)-(?:4|5))(?=$|[-_/.])/u.test(model);
}

function isKnownGeminiThinkingModel(model: string, kind: ProviderKind, providerId: string): boolean {
  if (kind !== "google" && kind !== "openai-compatible" && providerId !== "google" && providerId !== "gemini") {
    return false;
  }
  return /gemini-(?:2\.5|3|4)(?=$|[-_/.])/u.test(model);
}

function isKnownDeepSeekReasoningModel(model: string, kind: ProviderKind, providerId: string): boolean {
  if (kind !== "deepseek" && kind !== "openai-compatible" && providerId !== "deepseek") {
    return false;
  }
  return model.includes("deepseek-r1") || model.includes("deepseek-reasoner");
}

export function providerCapabilitySourceLabel(source: ProviderModelCapabilitySource): "Auto" | "Estimated" | "Conservative" | "Custom override" {
  if (source === "user_override") {
    return "Custom override";
  }
  if (source === "conservative_default") {
    return "Conservative";
  }
  if (source === "non_chat") {
    return "Auto";
  }
  return source === "provider_metadata" || source === "health_check" || source === "runtime_observed" ? "Estimated" : "Auto";
}

function chatSnapshot(
  providerPreset: ProviderModelCapabilityPreset,
  input: Pick<ProviderModelChatCapabilitySnapshot, "source" | "confidence" | "contextWindowTokens" | "maxOutputTokens" | "reason">,
): ProviderModelChatCapabilitySnapshot {
  return {
    ...snapshotBase(providerPreset),
    chatEligible: true,
    ...input,
  };
}

function conservativeSnapshot(
  providerPreset: ProviderModelCapabilityPreset | undefined,
  reason: string,
): ProviderModelChatCapabilitySnapshot {
  return {
    ...snapshotBase(providerPreset),
    chatEligible: true,
    source: "conservative_default",
    confidence: "conservative",
    contextWindowTokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
    reason,
  };
}

function applyRuntimeObservation(
  snapshot: ProviderModelChatCapabilitySnapshot,
  observation: ProviderModelRuntimeObservation | undefined,
): ProviderModelChatCapabilitySnapshot {
  const observedContextWindowTokens = positiveInteger(observation?.observedContextWindowTokens);
  if (!observation || !observedContextWindowTokens || observedContextWindowTokens >= snapshot.contextWindowTokens) {
    return snapshot;
  }
  if (!runtimeObservationMatchesSnapshot(snapshot, observation)) {
    return snapshot;
  }
  return {
    ...snapshot,
    source: "runtime_observed",
    confidence: "estimated",
    contextWindowTokens: observedContextWindowTokens,
    observedAt: observation.observedAt,
    reason: `Runtime context-length failure lowered the effective context window from ${snapshot.contextWindowTokens} to ${observedContextWindowTokens}.`,
  };
}

function runtimeObservationMatchesSnapshot(
  snapshot: ProviderModelChatCapabilitySnapshot,
  observation: ProviderModelRuntimeObservation,
): boolean {
  return (
    (!observation.providerPresetId || observation.providerPresetId === snapshot.providerPresetId) &&
    (!observation.providerKind || observation.providerKind === snapshot.providerKind) &&
    (!observation.providerApi || observation.providerApi === snapshot.providerApi) &&
    (!observation.modelId || observation.modelId === snapshot.modelId)
  );
}

function snapshotBase(providerPreset: ProviderModelCapabilityPreset | undefined): ProviderModelCapabilityBase {
  return {
    providerPresetId: providerPreset?.id,
    providerKind: providerPreset?.kind,
    providerApi: providerPreset?.api,
    modelId: providerPreset?.model,
    source: "conservative_default",
    confidence: "conservative",
    tokenizer: providerTokenizer(providerPreset),
    supportsStructuredOutput: providerPreset ? STRUCTURED_OUTPUT_APIS.has(providerPreset.api) : false,
  };
}

function providerTokenizer(providerPreset: ProviderModelCapabilityPreset | undefined): ProviderModelTokenizer {
  if (!providerPreset) {
    return "estimated";
  }
  if (providerPreset.api === "anthropic-messages" || providerPreset.kind === "anthropic") {
    return "anthropic-compatible";
  }
  return providerPreset.api === "media-job" ? "estimated" : "openai-compatible";
}

function providerFamilyEstimate(providerPreset: ProviderModelCapabilityPreset): ProviderFamilyEstimate {
  if (ESTIMATED_PROVIDER_FAMILIES.has(providerPreset.kind)) {
    return {
      contextWindowTokens: ESTIMATED_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
    };
  }
  return {
    contextWindowTokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
  };
}

function matchingProviderTemplate(
  providerPreset: ProviderModelCapabilityPreset,
  templates: readonly ProviderTemplate[],
): ProviderTemplate | undefined {
  return (
    templates.find(
      (template) =>
        template.providerId === providerPreset.providerId &&
        template.kind === providerPreset.kind &&
        template.api === providerPreset.api &&
        template.model === providerPreset.model,
    ) ??
    templates.find(
      (template) =>
        template.providerId === providerPreset.providerId &&
        template.kind === providerPreset.kind &&
        template.model === providerPreset.model,
    )
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
