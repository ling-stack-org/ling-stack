import type { SupportedLocale } from "./locale-registry.js";
import { catalogLoaders } from "./generated/catalog-loaders.js";

export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationValues = Readonly<Record<string, string | number>>;

export interface CompiledCatalogModule {
  readonly locale: SupportedLocale;
  readonly sourceRevision: string;
  readonly messages: TranslationCatalog;
}

export async function loadCatalog(locale: SupportedLocale): Promise<CompiledCatalogModule> {
  const loader = catalogLoaders[locale];
  if (!loader) {
    throw new Error(`Localization catalog is not available: ${locale}`);
  }
  const module = await loader();
  return module.catalog;
}

export function formatCatalogMessage(
  catalog: TranslationCatalog,
  fallbackCatalog: TranslationCatalog,
  key: string,
  values?: TranslationValues,
): string {
  const template = catalog[key] ?? fallbackCatalog[key] ?? key;
  if (!values) {
    return template;
  }
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
