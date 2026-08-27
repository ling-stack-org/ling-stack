import {
  LOCALE_DESCRIPTORS,
  formatCatalogMessage,
  isSupportedLocale,
  loadCatalog,
  matchSupportedLocale,
  type SupportedLocale,
  type TranslationCatalog,
} from "@ling-stack/localization";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Locale = SupportedLocale;

type TranslationValues = Readonly<Record<string, string | number>>;
export type Translate = (key: string, values?: TranslationValues) => string;

interface I18nContextValue {
  readonly locale: Locale;
  readonly pendingLocale: Locale | undefined;
  readonly localeLoadError: string | undefined;
  readonly setLocale: (locale: Locale, beforeCommit?: () => Promise<void>) => Promise<boolean>;
  readonly t: Translate;
}

const storageKey = "ling-stack.locale";
const defaultLocale: Locale = "zh-CN";
const fallbackLocale: Locale = "en-US";

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  pendingLocale: undefined,
  localeLoadError: undefined,
  setLocale: async () => false,
  t: (key) => key,
});

export function I18nProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const initialLocaleRef = useRef<Locale>(resolveInitialLocale());
  const localeRef = useRef<Locale>(initialLocaleRef.current);
  const requestGenerationRef = useRef(0);
  const [locale, setLocaleState] = useState<Locale>(initialLocaleRef.current);
  const [catalog, setCatalog] = useState<TranslationCatalog | undefined>();
  const [fallbackCatalog, setFallbackCatalog] = useState<TranslationCatalog | undefined>();
  const [pendingLocale, setPendingLocale] = useState<Locale | undefined>();
  const [localeLoadError, setLocaleLoadError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const fallbackPromise = loadCatalog(fallbackLocale);
    const selectedPromise = initialLocaleRef.current === fallbackLocale
      ? fallbackPromise
      : loadCatalog(initialLocaleRef.current);
    void Promise.all([fallbackPromise, selectedPromise])
      .then(([fallback, selected]) => {
        if (cancelled) return;
        setFallbackCatalog(fallback.messages);
        setCatalog(selected.messages);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        void fallbackPromise.then((fallback) => {
          if (cancelled) return;
          localeRef.current = fallbackLocale;
          setLocaleState(fallbackLocale);
          setFallbackCatalog(fallback.messages);
          setCatalog(fallback.messages);
          setLocaleLoadError(error instanceof Error ? error.message : String(error));
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback(async (
    nextLocale: Locale,
    beforeCommit?: () => Promise<void>,
  ): Promise<boolean> => {
    if (!isSupportedLocale(nextLocale) || nextLocale === localeRef.current) {
      return false;
    }
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setPendingLocale(nextLocale);
    setLocaleLoadError(undefined);
    try {
      const nextCatalog = await loadCatalog(nextLocale);
      if (requestGenerationRef.current !== generation) return false;
      await beforeCommit?.();
      if (requestGenerationRef.current !== generation) return false;
      localeRef.current = nextLocale;
      setCatalog(nextCatalog.messages);
      setLocaleState(nextLocale);
      setPendingLocale(undefined);
      return true;
    } catch (error: unknown) {
      if (requestGenerationRef.current !== generation) return false;
      setPendingLocale(undefined);
      setLocaleLoadError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  useEffect(() => {
    if (globalThis.document) {
      globalThis.document.documentElement.lang = locale;
      globalThis.document.documentElement.dir = LOCALE_DESCRIPTORS[locale].direction;
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      pendingLocale,
      localeLoadError,
      setLocale,
      t: (key, values) => formatCatalogMessage(catalog ?? {}, fallbackCatalog ?? {}, key, values),
    }),
    [catalog, fallbackCatalog, locale, localeLoadError, pendingLocale, setLocale],
  );

  return (
    <I18nContext.Provider value={value}>
      {catalog && fallbackCatalog ? children : <div aria-busy="true" data-i18n-bootstrap>Ling Stack</div>}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function readSavedLocale(): Locale | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey);
    return isSupportedLocale(saved) ? saved : undefined;
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

export function resolveInitialLocale(): Locale {
  const saved = readSavedLocale();
  if (saved) {
    return saved;
  }
  return matchSupportedLocale(globalThis.navigator?.languages ?? [], defaultLocale);
}
