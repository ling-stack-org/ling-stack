import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_MODEL_CATALOG_PATH,
  PROVIDER_MODEL_CATALOG_SOURCE,
  providerModelCatalogVersion,
  renderProviderModelCatalog,
} from "./provider-model-catalog-format.mjs";
import { normalizeModelTokenLimits, normalizeThinkingModes } from "./provider-model-catalog-normalization.mjs";

const TRUSTED_PROVIDER_IDS = [
  "alibaba",
  "anthropic",
  "deepseek",
  "google",
  "minimax",
  "mistral",
  "moonshotai",
  "openai",
  "siliconflow",
  "stepfun",
  "volcengine",
  "xai",
  "zai",
  "zhipuai",
];

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(rootDir, PROVIDER_MODEL_CATALOG_PATH);
const checkOnly = process.argv.includes("--check");

const response = await fetch(PROVIDER_MODEL_CATALOG_SOURCE, {
  headers: { Accept: "application/json", "User-Agent": "ling-stack-model-catalog-sync" },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) {
  throw new Error(`models.dev catalog request failed with HTTP ${response.status}.`);
}

const payload = await response.json();
if (!isRecord(payload)) {
  throw new Error("models.dev catalog response must be an object.");
}

const records = TRUSTED_PROVIDER_IDS.flatMap((providerId) => normalizeProviderModels(payload, providerId))
  .sort((left, right) => left.providerId.localeCompare(right.providerId) || left.id.localeCompare(right.id));
if (records.length === 0) {
  throw new Error("models.dev catalog did not contain any trusted model records.");
}

const duplicateKeys = records
  .map((record) => `${record.providerId}\u0000${record.id.toLowerCase()}`)
  .filter((key, index, values) => values.indexOf(key) !== index);
if (duplicateKeys.length > 0) {
  throw new Error(`models.dev catalog contains duplicate trusted records: ${[...new Set(duplicateKeys)].join(", ")}`);
}

const version = providerModelCatalogVersion(records);
const updatedAt = records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
const previous = await readExistingOutput();
const generatedAt = previous?.version === version ? previous.generatedAt : new Date().toISOString();
const output = renderProviderModelCatalog({ generatedAt, records, updatedAt, version });

if (checkOnly) {
  if (previous?.content !== output) {
    console.error("Provider model catalog is out of date. Run: node scripts/sync-provider-model-catalog.mjs");
    process.exit(1);
  }
  console.log(`Provider model catalog is current (${version}, ${records.length} records).`);
} else {
  if (previous?.content === output) {
    console.log(`Provider model catalog is unchanged (${version}, ${records.length} records).`);
  } else {
    await writeFile(outputPath, output, "utf8");
    console.log(`Wrote ${records.length} provider model records (${version}).`);
  }
}

function normalizeProviderModels(payload, providerId) {
  const provider = payload[providerId];
  if (!isRecord(provider) || !isRecord(provider.models)) {
    throw new Error(`Trusted provider ${providerId} is missing a models object.`);
  }
  return Object.values(provider.models).map((model) => normalizeModel(providerId, model)).filter(Boolean);
}

function normalizeModel(providerId, value) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return undefined;
  }
  const id = value.id.trim();
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const input = stringArray(modalities?.input).filter((item) => item === "text" || item === "image");
  const output = stringArray(modalities?.output);
  const capabilities = [];
  if (output.includes("text")) capabilities.push("chat");
  if (value.tool_call === true) capabilities.push("tool_call");
  if (value.reasoning === true) capabilities.push("reasoning");
  if (input.includes("image")) capabilities.push("vision");

  const thinkingModes = normalizeThinkingModes(value.reasoning_options);
  const limit = isRecord(value.limit) ? value.limit : undefined;
  const tokenLimits = normalizeModelTokenLimits(limit, providerId, id);
  return omitUndefined({
    providerId,
    id,
    displayName: typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined,
    input: input.length > 0 ? input : undefined,
    capabilities,
    thinkingModes: thinkingModes.length > 0 ? thinkingModes : undefined,
    contextWindow: tokenLimits.contextWindow,
    maxTokens: tokenLimits.maxTokens,
    updatedAt: normalizedDate(value.last_updated),
  });
}

async function readExistingOutput() {
  try {
    const content = await readFile(outputPath, "utf8");
    const version = content.match(/"version": "([^"]+)"/)?.[1];
    const generatedAt = content.match(/"generatedAt": "([^"]+)"/)?.[1];
    return { content, generatedAt, version };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizedDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function appendUnique(target, ...values) {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
