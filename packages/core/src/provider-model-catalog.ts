import { mediaModelKind } from "./provider-adapters.js";
import type {
  ProviderApi,
  ProviderCapability,
  ProviderKind,
  ProviderModelOption,
  ProviderModelOptionCapabilityConfidence,
  ProviderModelOptionCapabilitySource,
  ProviderThinkingMode,
  ProviderThinkingSupport,
} from "./provider-types.js";

export interface ProviderModelCatalogContext {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
}

interface ProviderModelCatalogEntry {
  readonly modelPattern: RegExp;
  readonly providerIds?: readonly string[];
  readonly kinds?: readonly ProviderKind[];
  readonly api?: ProviderApi;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly input?: readonly ("text" | "image")[];
  readonly capabilities: readonly ProviderCapability[];
  readonly thinkingSupport?: ProviderThinkingSupport;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly supportedParameters?: readonly string[];
  readonly source?: ProviderModelOptionCapabilitySource;
  readonly confidence?: ProviderModelOptionCapabilityConfidence;
}

const FULL_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ProviderThinkingMode[];
const STANDARD_REASONING_LEVELS = ["off", "low", "medium", "high"] as const satisfies readonly ProviderThinkingMode[];
const AUTO_REASONING_LEVELS = ["off", "auto", "low", "medium", "high"] as const satisfies readonly ProviderThinkingMode[];
const CHAT_CAPABILITIES = ["chat", "tool_call"] as const satisfies readonly ProviderCapability[];
const REASONING_CAPABILITIES = ["chat", "tool_call", "reasoning"] as const satisfies readonly ProviderCapability[];
const VISION_REASONING_CAPABILITIES = ["chat", "tool_call", "reasoning", "vision"] as const satisfies readonly ProviderCapability[];

const defaultThinkingSupport: ProviderThinkingSupport = {
  levels: STANDARD_REASONING_LEVELS,
};

const fullThinkingSupport: ProviderThinkingSupport = {
  levels: FULL_REASONING_LEVELS,
};

const autoThinkingSupport: ProviderThinkingSupport = {
  levels: AUTO_REASONING_LEVELS,
  dynamicAllowed: true,
};

const providerModelCatalog: readonly ProviderModelCatalogEntry[] = [
  {
    modelPattern: /(^|[-_/])(?:gpt-5|o1|o3|o4)(?=$|[-_/.])|codex/i,
    providerIds: ["openai", "openai-codex"],
    kinds: ["openai", "openai-compatible"],
    input: ["text", "image"],
    capabilities: VISION_REASONING_CAPABILITIES,
    thinkingSupport: fullThinkingSupport,
    contextWindow: 128_000,
    maxTokens: 16_384,
    supportedParameters: ["reasoning_effort", "tools", "response_format"],
  },
  {
    modelPattern: /claude-(?:3-7|4|sonnet-4|opus-4)/i,
    providerIds: ["anthropic"],
    kinds: ["anthropic", "openai-compatible"],
    input: ["text", "image"],
    capabilities: VISION_REASONING_CAPABILITIES,
    thinkingSupport: autoThinkingSupport,
    contextWindow: 200_000,
    maxTokens: 16_384,
    supportedParameters: ["thinking", "tools"],
  },
  {
    modelPattern: /gemini-(?:2\.5|3)/i,
    providerIds: ["google", "google-gemini", "gemini"],
    kinds: ["google", "openai-compatible"],
    input: ["text", "image"],
    capabilities: VISION_REASONING_CAPABILITIES,
    thinkingSupport: autoThinkingSupport,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    supportedParameters: ["thinkingConfig", "tools"],
  },
  {
    modelPattern: /deepseek-(?:r1|reasoner)/i,
    providerIds: ["deepseek"],
    kinds: ["deepseek", "openai-compatible"],
    input: ["text"],
    capabilities: REASONING_CAPABILITIES,
    thinkingSupport: defaultThinkingSupport,
    contextWindow: 64_000,
    maxTokens: 8_192,
    supportedParameters: ["reasoning_effort"],
  },
  {
    modelPattern: /(?:qwen3|qwq|kimi.*thinking|moonshot.*thinking|glm.*(?:thinking|reasoning))/i,
    kinds: ["openai-compatible", "glm"],
    input: ["text"],
    capabilities: REASONING_CAPABILITIES,
    thinkingSupport: defaultThinkingSupport,
    contextWindow: 128_000,
    maxTokens: 16_384,
    supportedParameters: ["reasoning_effort", "enable_thinking"],
    confidence: "estimated",
  },
  {
    modelPattern: /(?:deepseek|doubao|glm|minimax|kimi|moonshot|qwen|yi|baichuan|hunyuan|ernie)/i,
    kinds: ["openai-compatible", "doubao", "deepseek", "minimax", "glm"],
    input: ["text"],
    capabilities: CHAT_CAPABILITIES,
    contextWindow: 32_768,
    maxTokens: 4_096,
    confidence: "estimated",
  },
  {
    modelPattern: /(?:doubao-)?seedream/i,
    providerIds: ["seedream"],
    kinds: ["seedream", "openai-compatible"],
    api: "media-job",
    ownedBy: "volcengine",
    input: ["text", "image"],
    capabilities: ["image_generate", "image_edit"],
    source: "model_catalog",
  },
  {
    modelPattern: /(?:doubao-)?seedance/i,
    providerIds: ["seedance"],
    kinds: ["seedance", "openai-compatible"],
    api: "media-job",
    ownedBy: "volcengine",
    input: ["text", "image"],
    capabilities: ["video_generate"],
    source: "model_catalog",
  },
  {
    modelPattern: /jimeng/i,
    providerIds: ["jimeng"],
    kinds: ["jimeng", "openai-compatible"],
    api: "media-job",
    ownedBy: "volcengine",
    input: ["text", "image"],
    capabilities: ["image_generate", "image_edit"],
    source: "model_catalog",
  },
];

export function enrichProviderModelOption(
  model: ProviderModelOption,
  context: ProviderModelCatalogContext,
): ProviderModelOption {
  const upstreamThinkingSupport = normalizeProviderThinkingSupport(model.thinkingSupport);
  const upstreamThinkingModes = normalizeProviderThinkingModes(model.thinkingModes ?? upstreamThinkingSupport?.levels);
  const upstreamCapabilities = normalizeProviderCapabilities(model.capabilities);
  const upstreamInput = normalizeProviderInput(model.input);
  const catalogEntry = findProviderModelCatalogEntry(model.id, context);
  const mediaKind = mediaModelKind(model.id);
  const inferredMedia = mediaKind ? mediaModelOptionDefaults(mediaKind) : undefined;
  const thinkingSupport = upstreamThinkingSupport ?? catalogEntry?.thinkingSupport;
  const thinkingModes = normalizeProviderThinkingModes(upstreamThinkingModes ?? thinkingSupport?.levels);
  const api = model.api ?? inferredMedia?.api ?? catalogEntry?.api;
  const capabilities = normalizeProviderCapabilities([
    ...(upstreamCapabilities ?? []),
    ...((catalogEntry?.capabilities ?? inferredMedia?.capabilities) ?? []),
    ...(thinkingModes?.some((mode) => mode !== "off" && mode !== "auto") ? ["reasoning" as const] : []),
  ]);

  return omitUndefined({
    ...model,
    displayName: model.displayName ?? catalogEntry?.displayName ?? inferredMedia?.displayName,
    ownedBy: model.ownedBy ?? catalogEntry?.ownedBy ?? inferredMedia?.ownedBy,
    api,
    input: upstreamInput ?? catalogEntry?.input ?? inferredMedia?.input ?? defaultModelInput(api ?? context.api),
    capabilities: capabilities ?? defaultModelCapabilities(api ?? context.api),
    thinkingModes: thinkingModes ?? [],
    thinkingSupport,
    contextWindow: model.contextWindow ?? catalogEntry?.contextWindow,
    maxTokens: model.maxTokens ?? catalogEntry?.maxTokens,
    supportedParameters: mergeStringArrays(model.supportedParameters, catalogEntry?.supportedParameters),
    capabilitySource: model.capabilitySource ?? (catalogEntry ? catalogEntry.source ?? "model_catalog" : "conservative_default"),
    capabilityConfidence: model.capabilityConfidence ?? catalogEntry?.confidence ?? (catalogEntry ? "known" : "conservative"),
  });
}

export function normalizeProviderThinkingModes(value: readonly string[] | undefined): readonly ProviderThinkingMode[] | undefined {
  if (!value || value.length === 0) {
    return undefined;
  }
  const modes: ProviderThinkingMode[] = [];
  for (const rawMode of value) {
    const mode = normalizeProviderThinkingMode(rawMode);
    if (mode && !modes.includes(mode)) {
      modes.push(mode);
    }
  }
  return modes.length > 0 ? modes : undefined;
}

export function normalizeProviderThinkingSupport(value: ProviderThinkingSupport | undefined): ProviderThinkingSupport | undefined {
  const levels = normalizeProviderThinkingModes(value?.levels);
  if (!levels || levels.length === 0) {
    return undefined;
  }
  return omitUndefined({
    levels,
    minTokens: positiveInteger(value?.minTokens),
    maxTokens: positiveInteger(value?.maxTokens),
    zeroAllowed: value?.zeroAllowed,
    dynamicAllowed: value?.dynamicAllowed ?? levels.includes("auto"),
  });
}

export function providerThinkingModesToLevelMap(
  modes: readonly ProviderThinkingMode[] | undefined,
): Record<string, string | null> | undefined {
  if (!modes || modes.length === 0) {
    return undefined;
  }
  const supportedModes = new Set(modes);
  const runnerModes = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  const map: Record<string, string | null> = {};
  for (const mode of runnerModes) {
    map[mode] = supportedModes.has(mode) ? mode : null;
  }
  return map;
}

function findProviderModelCatalogEntry(modelId: string, context: ProviderModelCatalogContext): ProviderModelCatalogEntry | undefined {
  const providerId = context.providerId.toLowerCase();
  return providerModelCatalog.find((entry) => {
    if (!entry.modelPattern.test(modelId)) {
      return false;
    }
    if (entry.api && entry.api !== context.api) {
      return false;
    }
    const providerMatches = entry.providerIds?.some((candidate) => candidate.toLowerCase() === providerId) ?? false;
    const kindMatches = entry.kinds?.includes(context.kind) ?? false;
    if (entry.providerIds || entry.kinds) {
      return providerMatches || kindMatches;
    }
    return true;
  });
}

function normalizeProviderThinkingMode(value: string): ProviderThinkingMode | undefined {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "none" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "max" || normalized === "maximum") {
    return "xhigh";
  }
  if (normalized === "minimum" || normalized === "min") {
    return "minimal";
  }
  if (["off", "auto", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
    return normalized as ProviderThinkingMode;
  }
  return undefined;
}

function defaultModelInput(api: ProviderApi): readonly ("text" | "image")[] {
  return api === "media-job" ? ["text", "image"] : ["text"];
}

function defaultModelCapabilities(api: ProviderApi): readonly ProviderCapability[] {
  return api === "media-job" ? [] : ["chat"];
}

function mediaModelOptionDefaults(kind: NonNullable<ReturnType<typeof mediaModelKind>>): ProviderModelOption {
  if (kind === "seedance") {
    return {
      id: "seedance",
      displayName: "Seedance",
      ownedBy: "volcengine",
      api: "media-job",
      input: ["text", "image"],
      capabilities: ["video_generate"],
      capabilitySource: "model_catalog",
      capabilityConfidence: "known",
    };
  }
  return {
    id: kind,
    displayName: kind === "seedream" ? "Seedream" : "Jimeng Image",
    ownedBy: "volcengine",
    api: "media-job",
    input: ["text", "image"],
    capabilities: ["image_generate", "image_edit"],
    capabilitySource: "model_catalog",
    capabilityConfidence: "known",
  };
}

function normalizeProviderInput(input: readonly ("text" | "image")[] | undefined): readonly ("text" | "image")[] | undefined {
  return mergeStringArrays(input, undefined) as readonly ("text" | "image")[] | undefined;
}

function normalizeProviderCapabilities(input: readonly ProviderCapability[] | undefined): readonly ProviderCapability[] | undefined {
  return mergeStringArrays(input, undefined) as readonly ProviderCapability[] | undefined;
}

function mergeStringArrays(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): readonly string[] | undefined {
  const result: string[] = [];
  for (const item of [...(first ?? []), ...(second ?? [])]) {
    if (item && !result.includes(item)) {
      result.push(item);
    }
  }
  return result.length > 0 ? result : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
