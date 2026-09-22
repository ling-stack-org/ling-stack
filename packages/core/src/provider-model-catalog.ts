import { inferGenerationModelFamily } from "./provider-generation-models.js";
import {
  providerModelCatalogManifest,
  providerModelCatalogRecords,
} from "./provider-model-catalog.generated.js";
import type {
  ProviderApi,
  ProviderCapability,
  ProviderKind,
  ProviderModelCatalogInfo,
  ProviderModelCatalogRecord,
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
  readonly modelPattern?: RegExp;
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

const CATALOG_STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1_000;
const catalogProviderAliases: Readonly<Record<string, readonly string[]>> = {
  "alibaba-bailian": ["alibaba"],
  anthropic: ["anthropic"],
  deepseek: ["deepseek"],
  doubao: ["volcengine"],
  gemini: ["google"],
  glm: ["zhipuai", "zai"],
  google: ["google"],
  "google-gemini": ["google"],
  minimax: ["minimax"],
  mistral: ["mistral"],
  moonshot: ["moonshotai"],
  openai: ["openai"],
  "openai-codex": ["openai"],
  siliconflow: ["siliconflow"],
  stepfun: ["stepfun"],
  xai: ["xai"],
};
const kindCatalogProviderAliases: Partial<Record<ProviderKind, readonly string[]>> = {
  anthropic: ["anthropic"],
  deepseek: ["deepseek"],
  doubao: ["volcengine"],
  glm: ["zhipuai", "zai"],
  google: ["google"],
  minimax: ["minimax"],
  openai: ["openai"],
};
const generatedCatalogByProviderAndModel = new Map<string, ProviderModelCatalogRecord>(
  providerModelCatalogRecords.map((record) => [catalogRecordKey(record.providerId, record.id), record]),
);
const generatedCatalogByModel = buildGeneratedCatalogModelIndex(providerModelCatalogRecords);

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
];

export function enrichProviderModelOption(
  model: ProviderModelOption,
  context: ProviderModelCatalogContext,
): ProviderModelOption {
  const upstreamThinkingSupport = normalizeProviderThinkingSupport(model.thinkingSupport);
  const upstreamThinkingModes = normalizeProviderThinkingModes(model.thinkingModes ?? upstreamThinkingSupport?.levels);
  const upstreamCapabilities = normalizeProviderCapabilities(model.capabilities);
  const hasExplicitCapabilities = model.capabilities !== undefined;
  const upstreamInput = normalizeProviderInput(model.input);
  const generationFamily = inferGenerationModelFamily(model.id, context);
  const catalogEntry = generationFamily
    ? undefined
    : findExactProviderModelCatalogEntry(model.id, context) ?? findProviderModelFamilyEntry(model.id, context);
  const thinkingSupport = upstreamThinkingSupport ?? catalogEntry?.thinkingSupport;
  const thinkingModes = normalizeProviderThinkingModes(upstreamThinkingModes ?? thinkingSupport?.levels);
  const api = model.api ?? generationFamily?.api ?? catalogEntry?.api;
  const inferredCapabilities = normalizeProviderCapabilities([
    ...((generationFamily?.capabilities ?? catalogEntry?.capabilities) ?? []),
    ...(thinkingModes?.some((mode) => mode !== "off" && mode !== "auto") ? ["reasoning" as const] : []),
  ]);
  const capabilities = hasExplicitCapabilities ? upstreamCapabilities ?? [] : inferredCapabilities;

  return omitUndefined({
    ...model,
    displayName: model.displayName ?? generationFamily?.displayName ?? catalogEntry?.displayName,
    ownedBy: model.ownedBy ?? generationFamily?.ownedBy ?? catalogEntry?.ownedBy,
    api,
    input: upstreamInput ?? generationFamily?.input ?? catalogEntry?.input ?? defaultModelInput(api ?? context.api),
    capabilities: capabilities ?? defaultModelCapabilities(api ?? context.api),
    thinkingModes: thinkingModes ?? [],
    thinkingSupport,
    contextWindow: model.contextWindow ?? catalogEntry?.contextWindow,
    maxTokens: model.maxTokens ?? catalogEntry?.maxTokens,
    supportedParameters: mergeStringArrays(model.supportedParameters, generationFamily?.supportedParameters, catalogEntry?.supportedParameters),
    capabilitySource: model.capabilitySource ?? generationFamily?.capabilitySource ?? (catalogEntry ? catalogEntry.source ?? "model_catalog" : "conservative_default"),
    capabilityConfidence: model.capabilityConfidence ?? generationFamily?.capabilityConfidence ?? catalogEntry?.confidence ?? (catalogEntry ? "known" : "conservative"),
  });
}

export function providerModelCatalogInfo(now: Date = new Date()): ProviderModelCatalogInfo {
  return {
    source: providerModelCatalogManifest.source,
    version: providerModelCatalogManifest.version,
    updatedAt: providerModelCatalogManifest.updatedAt,
    stale: isProviderModelCatalogStale(providerModelCatalogManifest.updatedAt, now),
  };
}

export function isProviderModelCatalogStale(updatedAt: string, now: Date = new Date()): boolean {
  const catalogTime = Date.parse(updatedAt);
  return !Number.isFinite(catalogTime) || now.getTime() - catalogTime > CATALOG_STALE_AFTER_MS;
}

export function findProviderModelCatalogRecord(
  modelId: string,
  context: ProviderModelCatalogContext,
): ProviderModelCatalogRecord | undefined {
  const aliases = catalogProviderIds(context);
  for (const providerId of aliases) {
    const record = generatedCatalogByProviderAndModel.get(catalogRecordKey(providerId, modelId));
    if (record) return record;
  }
  if (aliases.length > 0) return undefined;
  const uniqueMatches = generatedCatalogByModel.get(normalizeCatalogLookupValue(modelId));
  return uniqueMatches?.length === 1 ? uniqueMatches[0] : undefined;
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

function findExactProviderModelCatalogEntry(modelId: string, context: ProviderModelCatalogContext): ProviderModelCatalogEntry | undefined {
  const record = findProviderModelCatalogRecord(modelId, context);
  if (!record) return undefined;
  const thinkingModes = normalizeProviderThinkingModes(record.thinkingModes);
  return omitUndefined({
    displayName: record.displayName,
    input: record.input,
    capabilities: record.capabilities,
    thinkingSupport: thinkingModes ? { levels: thinkingModes, dynamicAllowed: thinkingModes.includes("auto") } : undefined,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    source: "model_catalog" as const,
    confidence: "known" as const,
  });
}

function findProviderModelFamilyEntry(modelId: string, context: ProviderModelCatalogContext): ProviderModelCatalogEntry | undefined {
  const providerId = context.providerId.toLowerCase();
  const entry = providerModelCatalog.find((candidate) => {
    if (!candidate.modelPattern?.test(modelId)) {
      return false;
    }
    if (candidate.api && candidate.api !== context.api && candidate.api !== "media-job") {
      return false;
    }
    const providerMatches = candidate.providerIds?.some((id) => id.toLowerCase() === providerId) ?? false;
    const kindMatches = candidate.kinds?.includes(context.kind) ?? false;
    if (candidate.providerIds || candidate.kinds) {
      return providerMatches || kindMatches;
    }
    return true;
  });
  return entry ? { ...entry, source: entry.source ?? "provider_template" } : undefined;
}

function catalogProviderIds(context: ProviderModelCatalogContext): readonly string[] {
  const providerId = normalizeCatalogLookupValue(context.providerId);
  return catalogProviderAliases[providerId] ?? kindCatalogProviderAliases[context.kind] ?? [];
}

function buildGeneratedCatalogModelIndex(
  records: readonly ProviderModelCatalogRecord[],
): Map<string, readonly ProviderModelCatalogRecord[]> {
  const index = new Map<string, ProviderModelCatalogRecord[]>();
  for (const record of records) {
    const key = normalizeCatalogLookupValue(record.id);
    const matches = index.get(key) ?? [];
    matches.push(record);
    index.set(key, matches);
  }
  return index;
}

function catalogRecordKey(providerId: string, modelId: string): string {
  return `${normalizeCatalogLookupValue(providerId)}\u0000${normalizeCatalogLookupValue(modelId)}`;
}

function normalizeCatalogLookupValue(value: string): string {
  return value.trim().toLowerCase();
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

function normalizeProviderInput(input: readonly ("text" | "image")[] | undefined): readonly ("text" | "image")[] | undefined {
  return mergeStringArrays(input, undefined) as readonly ("text" | "image")[] | undefined;
}

function normalizeProviderCapabilities(input: readonly ProviderCapability[] | undefined): readonly ProviderCapability[] | undefined {
  return mergeStringArrays(input, undefined) as readonly ProviderCapability[] | undefined;
}

function mergeStringArrays(
  ...arrays: readonly (readonly string[] | undefined)[]
): readonly string[] | undefined {
  const result: string[] = [];
  for (const array of arrays) {
    for (const item of array ?? []) {
      if (item && !result.includes(item)) {
        result.push(item);
      }
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
