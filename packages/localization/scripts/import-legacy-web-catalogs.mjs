import fs from "node:fs";
import path from "node:path";

import { assertCatalogImportRetainsMessages, catalogRoot, readCatalog, sourceRevision, writeCatalog } from "./catalog-utils.mjs";
import { readAdditionalMessages, readWebLocaleSources } from "./web-locale-sources.mjs";

const { english, chinese } = readWebLocaleSources();
const keys = [...new Set([...Object.keys(english), ...Object.keys(chinese)])].sort();
const additionalEnglish = readAdditionalMessages("additional-source.json");
const additionalChinese = readAdditionalMessages("additional-zh-CN.json");
const englishMessages = {
  ...Object.fromEntries(keys.map((key) => [key, english[key] ?? key])),
  ...additionalEnglish,
};
const chineseMessages = {
  ...Object.fromEntries(keys.map((key) => [key, chinese[key] ?? english[key] ?? key])),
  ...additionalChinese,
};
const revision = sourceRevision(englishMessages);

if (fs.existsSync(path.join(catalogRoot, "en-US.json"))) {
  assertCatalogImportRetainsMessages(readCatalog("en-US").messages, englishMessages);
}

migrateExistingCatalogSourceHashes();
writeCatalog("en-US", revision, englishMessages, englishMessages);
writeCatalog("zh-CN", revision, chineseMessages, englishMessages);

console.log(`Imported legacy Web catalogs: keys=${keys.length}, sourceRevision=${revision}`);

function migrateExistingCatalogSourceHashes() {
  const previousSourceFile = path.join(catalogRoot, "en-US.json");
  if (!fs.existsSync(previousSourceFile)) return;
  const previousSource = readCatalog("en-US");
  for (const file of fs.readdirSync(catalogRoot).filter((name) => /^[-A-Za-z0-9]+\.json$/u.test(name) && !name.startsWith("additional-"))) {
    const locale = path.basename(file, ".json");
    if (locale === "en-US") continue;
    const catalog = readCatalog(locale);
    if (catalog.sourceRevision !== previousSource.sourceRevision) continue;
    writeCatalog(locale, catalog.sourceRevision, catalog.messages, previousSource.messages);
  }
}
