import fs from "node:fs";
import path from "node:path";

import { catalogRoot, messageSourceHash, placeholders, readCatalog, sourceRevision } from "./catalog-utils.mjs";
import { SUPPORTED_CATALOG_LOCALES } from "./catalog-locales.mjs";
import { protectedMarkerPattern } from "./protected-tokens.mjs";

const source = readCatalog("en-US");
const expectedRevision = sourceRevision(source.messages);
const expectedKeys = Object.keys(source.messages).sort();
const files = fs.readdirSync(catalogRoot)
  .filter((name) => name.endsWith(".json") && !name.startsWith("additional-"))
  .sort();
const failures = [];
const actualLocales = files.map((file) => path.basename(file, ".json"));
const missingCatalogs = SUPPORTED_CATALOG_LOCALES.filter((locale) => !actualLocales.includes(locale));
const unexpectedCatalogs = actualLocales.filter((locale) => !SUPPORTED_CATALOG_LOCALES.includes(locale));

if (missingCatalogs.length > 0) failures.push(`missing locale catalogs: ${missingCatalogs.join(", ")}`);
if (unexpectedCatalogs.length > 0) failures.push(`unexpected locale catalogs: ${unexpectedCatalogs.join(", ")}`);

if (source.sourceRevision !== expectedRevision) {
  failures.push(`en-US sourceRevision is stale: expected ${expectedRevision}, received ${source.sourceRevision}`);
}

for (const file of files) {
  const locale = path.basename(file, ".json");
  let catalog;
  try {
    catalog = readCatalog(locale);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    continue;
  }
  const keys = Object.keys(catalog.messages).sort();
  const missing = expectedKeys.filter((key) => !Object.hasOwn(catalog.messages, key));
  const extra = keys.filter((key) => !Object.hasOwn(source.messages, key));
  const sameAsSource = expectedKeys.filter((key) => catalog.messages[key] === source.messages[key]);
  if (missing.length > 0) failures.push(`${locale} missing keys: ${missing.slice(0, 20).join(", ")}`);
  if (extra.length > 0) failures.push(`${locale} extra keys: ${extra.slice(0, 20).join(", ")}`);
  if (catalog.sourceRevision !== expectedRevision) failures.push(`${locale} sourceRevision is stale`);
  if (locale !== "en-US" && sameAsSource.length / expectedKeys.length > 0.15) {
    failures.push(`${locale} matches the English source for ${sameAsSource.length}/${expectedKeys.length} messages`);
  }
  for (const key of expectedKeys) {
    const translated = catalog.messages[key];
    if (typeof translated !== "string" || !translated.trim()) {
      failures.push(`${locale} has an empty translation for ${key}`);
      continue;
    }
    if (catalog.sourceHashes?.[key] !== messageSourceHash(source.messages[key])) {
      failures.push(`${locale} has a stale source hash for ${key}`);
    }
    if (JSON.stringify(placeholders(translated)) !== JSON.stringify(placeholders(source.messages[key]))) {
      failures.push(`${locale} placeholder mismatch for ${key}`);
    }
    if (protectedMarkerPattern.test(translated)) {
      failures.push(`${locale} has an unresolved protected marker for ${key}`);
    }
  }
}

console.log(`Catalog audit: locales=${files.length}/${SUPPORTED_CATALOG_LOCALES.length}, keys=${expectedKeys.length}, sourceRevision=${expectedRevision}`);
if (failures.length > 0) {
  console.error(failures.slice(0, 100).join("\n"));
  process.exit(1);
}
