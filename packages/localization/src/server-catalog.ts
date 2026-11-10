import { formatCatalogMessage, type TranslationValues } from "./catalog.js";
import { synchronousCatalogs } from "./generated/server-catalogs.js";
import type { SupportedLocale } from "./locale-registry.js";

export function formatSynchronousCatalogMessage(
  locale: SupportedLocale,
  key: `daemon.${string}` | `terminal_report.${string}`,
  values?: TranslationValues,
): string {
  return formatCatalogMessage(
    synchronousCatalogs[locale] ?? {},
    synchronousCatalogs["en-US"] ?? {},
    key,
    values,
  );
}

export function formatServerCatalogMessage(
  locale: SupportedLocale,
  key: `daemon.${string}`,
  values?: TranslationValues,
): string {
  return formatSynchronousCatalogMessage(locale, key, values);
}
