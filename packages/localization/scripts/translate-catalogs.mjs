import fs from "node:fs";
import path from "node:path";

import {
  catalogRoot,
  messageSourceHash,
  parseArgs,
  placeholders,
  readCatalog,
  sourceRevision,
  writeCatalog,
} from "./catalog-utils.mjs";
import { TRANSLATION_TARGETS } from "./catalog-locales.mjs";
import {
  protectMessage,
  protectedMessageParts,
  protectedMarkerPattern,
  restoreProtectedTokens,
  splitTranslatableText,
} from "./protected-tokens.mjs";

const supportedLocales = Object.keys(TRANSLATION_TARGETS);

const args = parseArgs(process.argv.slice(2));
const requested = args.get("locales") ?? "all";
const batchSize = Math.max(1, Math.min(40, Number(args.get("batch-size") ?? 24)));
const concurrency = Math.max(1, Math.min(8, Number(args.get("concurrency") ?? 4)));
const delayMs = Math.max(0, Number(args.get("delay-ms") ?? 250));
const locales = requested === "all"
  ? supportedLocales
  : requested.split(",").map((value) => value.trim()).filter(Boolean);

for (const locale of locales) {
  if (!supportedLocales.includes(locale)) throw new Error(`Unsupported translation target: ${locale}`);
}

const source = readCatalog("en-US");
const revision = sourceRevision(source.messages);
const entries = Object.entries(source.messages);

await runPool(locales, concurrency, async (locale) => {
  const existingFile = path.join(catalogRoot, `${locale}.json`);
  const existingCatalog = fs.existsSync(existingFile) ? readCatalog(locale) : undefined;
  const existing = existingCatalog?.messages ?? {};
  const output = {};
  const unique = new Map();
  for (const [key, value] of entries) {
    if (isReusableTranslation(source.messages[key], existing[key], existingCatalog?.sourceHashes?.[key])) {
      output[key] = existing[key];
      continue;
    }
    const protectedValue = protectMessage(value);
    const identity = JSON.stringify([protectedValue.text, protectedValue.tokens]);
    const bucket = unique.get(identity) ?? {
      keys: [],
      text: protectedValue.text,
      tokens: protectedValue.tokens,
    };
    bucket.keys.push(key);
    unique.set(identity, bucket);
  }

  const pending = [...unique.values()];
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const translated = await translateBatch(batch.map((entry) => entry.text), TRANSLATION_TARGETS[locale]);
    if (translated.length !== batch.length) throw new Error(`${locale} returned ${translated.length} translations for ${batch.length} inputs`);
    for (let index = 0; index < batch.length; index += 1) {
      const metadata = batch[index];
      const restored = await restoreValidTranslation(locale, metadata, translated[index], TRANSLATION_TARGETS[locale]);
      for (const key of metadata.keys) {
        output[key] = restored;
      }
    }
    writeCatalog(locale, revision, output, source.messages);
    process.stdout.write(`${locale}: ${Math.min(offset + batch.length, pending.length)}/${pending.length}\r`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  writeCatalog(locale, revision, output, source.messages);
  process.stdout.write(`${locale}: ${entries.length} keys written\n`);
});

async function translateBatch(texts, target) {
  const query = new URLSearchParams({ client: "dict-chrome-ex", sl: "en", tl: target });
  for (const text of texts) query.append("q", text);
  const url = `https://clients5.google.com/translate_a/t?${query}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (response.ok) {
      const value = await response.json();
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
      throw new Error(`Unexpected translation response for ${target}`);
    }
    if (attempt === 10) throw new Error(`Translation request failed for ${target}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 1_000));
  }
  return [];
}

function isReusableTranslation(sourceValue, translatedValue, translatedSourceHash) {
  return typeof translatedValue === "string"
    && translatedValue.trim().length > 0
    && translatedSourceHash === messageSourceHash(sourceValue)
    && !protectedMarkerPattern.test(translatedValue)
    && JSON.stringify(placeholders(translatedValue)) === JSON.stringify(placeholders(sourceValue));
}

function validateTranslation(locale, key, sourceValue, translatedValue, protectedTokens) {
  if (!translatedValue.trim()) {
    throw new Error(`${locale} returned an empty translation for ${key}`);
  }
  if (protectedMarkerPattern.test(translatedValue)) {
    throw new Error(`${locale} left a protected marker in ${key}`);
  }
  if (JSON.stringify(placeholders(translatedValue)) !== JSON.stringify(placeholders(sourceValue))) {
    throw new Error(`${locale} returned a placeholder mismatch for ${key}`);
  }
  for (const token of new Set(protectedTokens)) {
    if (countOccurrences(translatedValue, token) !== countOccurrences(sourceValue, token)) {
      throw new Error(`${locale} changed protected token ${token} in ${key}`);
    }
  }
}

async function restoreValidTranslation(locale, metadata, initialValue, target) {
  let candidate = initialValue;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const restored = restoreProtectedTokens(candidate, metadata.tokens);
    try {
      for (const key of metadata.keys) {
        validateTranslation(locale, key, source.messages[key], restored, metadata.tokens);
      }
      return restored;
    } catch (error) {
      lastError = error;
    }
    const retried = await translateBatch([metadata.text], target);
    candidate = retried[0] ?? "";
  }
  const segmented = await translateProtectedSegments(metadata, target);
  try {
    for (const key of metadata.keys) {
      validateTranslation(locale, key, source.messages[key], segmented, metadata.tokens);
    }
    return segmented;
  } catch (error) {
    throw error ?? lastError ?? new Error(`${locale} could not produce a valid translation`);
  }
}

async function translateProtectedSegments(metadata, target) {
  const parts = protectedMessageParts(metadata.text, metadata.tokens);
  const translatable = parts.flatMap((part, index) => {
    if (part.kind !== "text" || !part.value.trim()) return [];
    return [{ index, text: part.value.trim() }];
  });
  const translated = await Promise.all(
    translatable.map((part) => translateNonEmptyText(part.text, target)),
  );
  const translatedByIndex = new Map(translatable.map((part, index) => [part.index, translated[index]]));
  return parts.map((part, index) => {
    if (part.kind === "token") return part.value;
    const translatedPart = translatedByIndex.get(index);
    if (translatedPart === undefined) return part.value;
    const leading = part.value.match(/^\s*/u)?.[0] ?? "";
    const trailing = part.value.match(/\s*$/u)?.[0] ?? "";
    return `${leading}${translatedPart}${trailing}`;
  }).join("");
}

async function translateNonEmptyText(text, target) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const translated = await translateBatch([text], target);
    const candidate = translated[0];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  const split = splitTranslatableText(text);
  if (!split) {
    throw new Error(`${target} repeatedly returned an empty translation for ${JSON.stringify(text)}`);
  }
  const [left, right] = await Promise.all([
    translateNonEmptyText(split.left, target),
    translateNonEmptyText(split.right, target),
  ]);
  return `${left}${split.separator}${right}`;
}

function countOccurrences(value, token) {
  return value.split(token).length - 1;
}

async function runPool(values, size, task) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      await task(value);
    }
  }));
}
