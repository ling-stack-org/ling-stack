import { formatCatalogMessage, loadCatalog, normalizeLocale, type TranslationValues } from "@ling-stack/localization";

export type BrowserNativeTranslate = (key: string, values?: TranslationValues) => string;

export async function loadBrowserNativeMessages(locale: string): Promise<BrowserNativeTranslate> {
  const selectedLocale = normalizeLocale(locale) ?? "en-US";
  const fallback = await loadCatalog("en-US");
  const selected = selectedLocale === "en-US" ? fallback : await loadCatalog(selectedLocale).catch(() => fallback);
  return (key, values) => formatCatalogMessage(selected.messages, fallback.messages, key, values);
}
