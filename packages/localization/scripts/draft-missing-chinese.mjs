import fs from "node:fs";
import path from "node:path";

import { catalogRoot, parseArgs, placeholders } from "./catalog-utils.mjs";
import { translateBatch } from "./google-translate.mjs";
import {
  protectMessage,
  protectedMarkerPattern,
  restoreProtectedTokens,
} from "./protected-tokens.mjs";
import { readWebLocaleSources } from "./web-locale-sources.mjs";

// Tests inject LING_DRAFT_TRANSLATE_STUB (base64 JSON object of text -> translation)
// so the drafting logic is exercised without the network.
const stubbedTranslations = process.env.LING_DRAFT_TRANSLATE_STUB
  ? JSON.parse(Buffer.from(process.env.LING_DRAFT_TRANSLATE_STUB, "base64").toString("utf8"))
  : undefined;

async function translateForDraft(texts, target) {
  if (stubbedTranslations !== undefined) {
    return texts.map((text) => stubbedTranslations[text] ?? "");
  }
  return translateBatch(texts, target);
}

/**
 * Fill machine-translated zh-CN drafts for keys that exist in the English
 * source but not in any Chinese source. Drafts land in the real sources
 * (zh-CN.ts for dictionary keys, additional-zh-CN.json for additional-only
 * keys) so the parity check, the import, and PR review all see them.
 *
 * Prints a JSON summary to stdout: {"drafted": ["key", ...]}.
 */

const args = parseArgs(process.argv.slice(2));
const batchSize = Math.max(1, Math.min(40, Number(args.get("batch-size") ?? 24)));

const { english, chinese, chineseFile, additionalEnglish, additionalChinese } = readWebLocaleSources({
  localeRoot: args.get("locale-root"),
  additionalRoot: args.get("additional-root"),
});

const chineseKeys = new Set([...Object.keys(chinese), ...Object.keys(additionalChinese)]);
const missing = [];
for (const [key, value] of [...Object.entries(english), ...Object.entries(additionalEnglish)]) {
  if (!chineseKeys.has(key)) missing.push([key, value]);
}

if (missing.length === 0) {
  console.log(JSON.stringify({ drafted: [] }));
  process.exit(0);
}

// Deduplicate identical English text so repeated sources translate once.
const unique = new Map();
for (const [key, value] of missing) {
  const protectedValue = protectMessage(value);
  const identity = JSON.stringify([protectedValue.text, protectedValue.tokens]);
  const bucket = unique.get(identity) ?? { keys: [], text: protectedValue.text, tokens: protectedValue.tokens };
  bucket.keys.push(key);
  unique.set(identity, bucket);
}

const drafts = new Map();
const pending = [...unique.values()];
for (let offset = 0; offset < pending.length; offset += batchSize) {
  const batch = pending.slice(offset, offset + batchSize);
  const translated = await translateForDraft(batch.map((entry) => entry.text), "zh-CN");
  if (translated.length !== batch.length) throw new Error(`zh-CN returned ${translated.length} translations for ${batch.length} inputs`);
  for (let index = 0; index < batch.length; index += 1) {
    const metadata = batch[index];
    const restored = restoreProtectedTokens(translated[index], metadata.tokens);
    for (const key of metadata.keys) {
      const sourceValue = english[key] ?? additionalEnglish[key];
      if (!restored.trim()) throw new Error(`zh-CN draft is empty for ${key}`);
      if (protectedMarkerPattern.test(restored)) throw new Error(`zh-CN draft kept a protected marker for ${key}`);
      if (JSON.stringify(placeholders(restored)) !== JSON.stringify(placeholders(sourceValue))) {
        throw new Error(`zh-CN draft changed placeholders for ${key}`);
      }
      drafts.set(key, restored);
    }
  }
  process.stdout.write(`drafted ${Math.min(offset + batch.length, pending.length)}/${pending.length} unique strings\n`);
}

const tsDrafts = [...drafts.entries()].filter(([key]) => Object.hasOwn(english, key));
const additionalDrafts = [...drafts.entries()].filter(([key]) => !Object.hasOwn(english, key));

if (tsDrafts.length > 0) {
  const source = fs.readFileSync(chineseFile, "utf8");
  const closing = "\n} as const satisfies";
  const closeAt = source.indexOf(closing);
  if (closeAt === -1 || source.indexOf(closing, closeAt + 1) !== -1) {
    throw new Error(`Expected exactly one root closing marker in ${chineseFile}`);
  }
  const lines = tsDrafts.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join("\n");
  writeFileAtomic(chineseFile, `${source.slice(0, closeAt)}\n${lines}${source.slice(closeAt)}`);
}

if (additionalDrafts.length > 0) {
  const file = path.join(args.get("additional-root") ?? catalogRoot, "additional-zh-CN.json");
  const merged = Object.fromEntries(
    [...Object.entries(additionalChinese), ...additionalDrafts].sort(([left], [right]) => left.localeCompare(right)),
  );
  writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
}

console.log(JSON.stringify({ drafted: [...drafts.keys()] }));

function writeFileAtomic(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}
