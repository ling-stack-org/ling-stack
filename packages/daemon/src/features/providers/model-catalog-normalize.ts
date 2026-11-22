import { createHash } from "node:crypto";
import type { ProviderCapability, ProviderModelCatalogRecord, ProviderModelCatalogSnapshot, ProviderThinkingMode } from "@ling-stack/core";

export const MODEL_CATALOG_URL = "https://models.dev/api.json";
const providerIds = ["alibaba", "anthropic", "deepseek", "google", "minimax", "mistral", "moonshotai", "openai", "siliconflow", "stepfun", "volcengine", "xai", "zai", "zhipuai"] as const;
const thinkingOrder: readonly ProviderThinkingMode[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function normalizeModelCatalog(payload: unknown, fetchedAt: string): ProviderModelCatalogSnapshot {
  if (!isRecord(payload) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("invalid_catalog");
  const records: ProviderModelCatalogRecord[] = [];
  const seen = new Set<string>();
  for (const providerId of providerIds) {
    const provider = payload[providerId];
    if (!isRecord(provider) || !isRecord(provider.models) || !Object.keys(provider.models).length) throw new Error("incomplete_catalog");
    for (const value of Object.values(provider.models)) {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || value.id.length > 256) throw new Error("invalid_model");
      const id = value.id.trim();
      const key = `${providerId}\0${id.toLowerCase()}`;
      if (seen.has(key)) throw new Error("duplicate_model");
      seen.add(key);
      const modalities = isRecord(value.modalities) ? value.modalities : {};
      const input = strings(modalities.input).filter((v): v is "text" | "image" => v === "text" || v === "image");
      const output = strings(modalities.output);
      const capabilities: ProviderCapability[] = [];
      if (output.includes("text")) capabilities.push("chat");
      if (value.tool_call === true) capabilities.push("tool_call");
      if (value.reasoning === true) capabilities.push("reasoning");
      if (input.includes("image")) capabilities.push("vision");
      const thinkingModes = normalizeThinkingModes(value.reasoning_options);
      const { contextWindow, maxTokens } = normalizeModelTokenLimits(isRecord(value.limit) ? value.limit : {}, providerId, id);
      records.push({ providerId, id, capabilities,
        ...(typeof value.name === "string" && value.name.trim() && value.name.length <= 512 ? { displayName: value.name.trim() } : {}),
        ...(input.length ? { input } : {}), ...(thinkingModes.length ? { thinkingModes } : {}),
        ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
        ...(typeof value.last_updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.last_updated) && Number.isFinite(Date.parse(value.last_updated)) ? { updatedAt: value.last_updated } : {}),
      });
    }
  }
  records.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  const version = `models.dev:${createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 12)}`;
  return { manifest: { schemaVersion: 1, version, source: "models.dev", sourceUrl: MODEL_CATALOG_URL, license: "MIT", generatedAt: fetchedAt, updatedAt: fetchedAt.slice(0, 10) }, records };
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function positive(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function normalizeThinkingModes(value: unknown): ProviderThinkingMode[] {
  const modes = new Set<string>();
  if (Array.isArray(value)) for (const option of value) {
    if (!isRecord(option)) continue;
    if (option.type === "toggle") { modes.add("off"); modes.add("auto"); }
    if (option.type === "effort") for (const raw of strings(option.values)) {
      const mode = raw.trim().toLowerCase();
      modes.add(mode === "none" || mode === "disabled" ? "off" : mode === "maximum" ? "max" : mode);
    }
  }
  return thinkingOrder.filter(mode => modes.has(mode));
}

export function normalizeModelTokenLimits(limit: { context?: unknown; output?: unknown } = {}, providerId?: string, id?: string) {
  let contextWindow = positive(limit.context);
  if (providerId === "volcengine" && id === "doubao-seed-2-1-pro-260628" && contextWindow) contextWindow = Math.min(contextWindow, 256_000);
  const outputLimit = positive(limit.output);
  let maxTokens = outputLimit;
  if (!contextWindow && outputLimit && outputLimit > 126_464) maxTokens = Math.min(outputLimit, 16_384, 126_464);
  if (contextWindow) {
    const safe = contextWindow - 1536;
    if (safe <= 0) { contextWindow = undefined; maxTokens = undefined; }
    else if (!outputLimit) maxTokens = 16_384 > safe ? safe : undefined;
    else if (outputLimit > safe) maxTokens = Math.min(outputLimit, 16_384, safe);
  }
  return { contextWindow, maxTokens };
}
