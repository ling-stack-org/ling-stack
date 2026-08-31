import fs from "node:fs";
import path from "node:path";

import { catalogRoot, packageRoot, readCatalog } from "./catalog-utils.mjs";

const generatedRoot = path.join(packageRoot, "src/generated");
const generatedCatalogRoot = path.join(generatedRoot, "catalogs");
fs.mkdirSync(generatedCatalogRoot, { recursive: true });

function writeFileAtomic(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

const locales = fs.existsSync(catalogRoot)
  ? fs.readdirSync(catalogRoot)
      .filter((name) => name.endsWith(".json") && !name.startsWith("additional-"))
      .map((name) => name.slice(0, -5))
      .sort()
  : [];

if (!locales.includes("en-US")) {
  throw new Error("The en-US source catalog is required before compilation");
}

for (const locale of locales) {
  const catalog = readCatalog(locale);
  const compiledCatalog = {
    locale: catalog.locale,
    sourceRevision: catalog.sourceRevision,
    messages: catalog.messages,
  };
  const source = [
    `import type { CompiledCatalogModule } from \"../../catalog.js\";`,
    `export const catalog = ${JSON.stringify(compiledCatalog)} as const satisfies CompiledCatalogModule;`,
    "",
  ].join("\n");
  writeFileAtomic(path.join(generatedCatalogRoot, `${locale}.ts`), source);
}

for (const file of fs.readdirSync(generatedCatalogRoot)) {
  if (file.endsWith(".ts") && !locales.includes(file.slice(0, -3))) {
    fs.rmSync(path.join(generatedCatalogRoot, file), { force: true });
  }
}

const loaderEntries = locales.map((locale) => `  ${JSON.stringify(locale)}: () => import(\"./catalogs/${locale}.js\"),`);
writeFileAtomic(path.join(generatedRoot, "catalog-loaders.ts"), [
  `import type { SupportedLocale } from \"../locale-registry.js\";`,
  `import type { CompiledCatalogModule } from \"../catalog.js\";`,
  "",
  "type CatalogLoader = () => Promise<{ readonly catalog: CompiledCatalogModule }>;",
  "",
  "const availableCatalogLoaders = {",
  ...loaderEntries,
  "} as const;",
  "",
  "export const catalogLoaders: Readonly<Partial<Record<SupportedLocale, CatalogLoader>>> = availableCatalogLoaders;",
  "",
].join("\n"));

const synchronousCatalogEntries = locales.map((locale) => {
  const messages = Object.fromEntries(
    Object.entries(readCatalog(locale).messages).filter(([key]) =>
      key.startsWith("daemon.") || key.startsWith("terminal_report.")),
  );
  return `  ${JSON.stringify(locale)}: ${JSON.stringify(messages)},`;
});
writeFileAtomic(path.join(generatedRoot, "server-catalogs.ts"), [
  `import type { SupportedLocale } from "../locale-registry.js";`,
  `import type { TranslationCatalog } from "../catalog.js";`,
  "",
  "export const synchronousCatalogs: Readonly<Partial<Record<SupportedLocale, TranslationCatalog>>> = {",
  ...synchronousCatalogEntries,
  "};",
  "",
].join("\n"));

console.log(`Compiled ${locales.length} localization catalogs`);
