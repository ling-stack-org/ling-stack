import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dictionaries } from "./i18n/dictionaries.js";

export type Locale = "en-US" | "zh-CN";

type TranslationValues = Readonly<Record<string, string | number>>;
export type Translate = (key: string, values?: TranslationValues) => string;

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const storageKey = "ling-stack.locale";
const defaultLocale: Locale = "zh-CN";
const fallbackLocale: Locale = "en-US";

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: (key) => key,
});

export function I18nProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale());

  useEffect(() => {
    if (globalThis.document) {
      globalThis.document.documentElement.lang = locale;
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (key, values) => formatTranslation(dictionaries[locale][key] ?? dictionaries[fallbackLocale][key] ?? key, values),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function readSavedLocale(): Locale | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey);
    return saved === "zh-CN" || saved === "en-US" ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function clearSavedLocale(): void {
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function resolveInitialLocale(): Locale {
  const saved = readSavedLocale();
  if (saved) {
    return saved;
  }
  const browserLanguage = globalThis.navigator?.language?.toLowerCase() ?? "";
  return browserLanguage.startsWith("zh") ? "zh-CN" : defaultLocale;
}

function formatTranslation(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}
