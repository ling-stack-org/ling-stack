export const SUPPORTED_LOCALES = [
  "en-US",
  "bg-BG",
  "bn-BD",
  "bs-BA",
  "ca-ES",
  "cs-CZ",
  "da-DK",
  "de-DE",
  "el-GR",
  "es-419",
  "es-ES",
  "et-EE",
  "fi-FI",
  "fr-CA",
  "fr-FR",
  "gu-IN",
  "hi-IN",
  "hr-HR",
  "hu-HU",
  "hy-AM",
  "id-ID",
  "is-IS",
  "it-IT",
  "ja-JP",
  "ka-GE",
  "kn-IN",
  "ko-KR",
  "lv-LV",
  "mk-MK",
  "mr-IN",
  "ms-MY",
  "my-MM",
  "nb-NO",
  "nl-NL",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "ru-RU",
  "sk-SK",
  "sl-SI",
  "so-SO",
  "sq-AL",
  "sr-RS",
  "sv-SE",
  "sw-TZ",
  "ta-IN",
  "te-IN",
  "th-TH",
  "tr-TR",
  "uk-UA",
  "vi-VN",
  "zh-CN",
  "zh-HK",
  "zh-TW",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type InterfaceLocale = SupportedLocale;
export type ExplicitResponseLanguage = SupportedLocale;
export type ResponseLanguagePreference = "follow_user" | ExplicitResponseLanguage;

export interface LocaleDescriptor {
  readonly locale: SupportedLocale;
  readonly nativeName: string;
  readonly englishName: string;
  readonly direction: "ltr" | "rtl";
  readonly aliases: readonly string[];
}

const descriptors = [
  descriptor("en-US", "English (US)", "English", ["en", "en-GB", "en-AU", "en-CA", "en-NZ"]),
  descriptor("bg-BG", "Български", "Bulgarian", ["bg"]),
  descriptor("bn-BD", "বাংলা", "Bengali", ["bn"]),
  descriptor("bs-BA", "Bosanski", "Bosnian", ["bs"]),
  descriptor("ca-ES", "Català", "Catalan", ["ca"]),
  descriptor("cs-CZ", "Čeština", "Czech", ["cs"]),
  descriptor("da-DK", "Dansk", "Danish", ["da"]),
  descriptor("de-DE", "Deutsch", "German", ["de"]),
  descriptor("el-GR", "Ελληνικά", "Greek", ["el"]),
  descriptor("es-419", "Español (Latinoamérica)", "Latin American Spanish", ["es-MX", "es-AR", "es-CL", "es-CO", "es-PE", "es-US"]),
  descriptor("es-ES", "Español (España)", "Spanish", ["es"]),
  descriptor("et-EE", "Eesti", "Estonian", ["et"]),
  descriptor("fi-FI", "Suomi", "Finnish", ["fi"]),
  descriptor("fr-CA", "Français (Canada)", "Canadian French", ["fr-CA"]),
  descriptor("fr-FR", "Français", "French", ["fr"]),
  descriptor("gu-IN", "ગુજરાતી", "Gujarati", ["gu"]),
  descriptor("hi-IN", "हिन्दी", "Hindi", ["hi"]),
  descriptor("hr-HR", "Hrvatski", "Croatian", ["hr"]),
  descriptor("hu-HU", "Magyar", "Hungarian", ["hu"]),
  descriptor("hy-AM", "Հայերեն", "Armenian", ["hy"]),
  descriptor("id-ID", "Bahasa Indonesia", "Indonesian", ["id"]),
  descriptor("is-IS", "Íslenska", "Icelandic", ["is"]),
  descriptor("it-IT", "Italiano", "Italian", ["it"]),
  descriptor("ja-JP", "日本語", "Japanese", ["ja"]),
  descriptor("ka-GE", "ქართული", "Georgian", ["ka"]),
  descriptor("kn-IN", "ಕನ್ನಡ", "Kannada", ["kn"]),
  descriptor("ko-KR", "한국어", "Korean", ["ko"]),
  descriptor("lv-LV", "Latviešu", "Latvian", ["lv"]),
  descriptor("mk-MK", "Македонски", "Macedonian", ["mk"]),
  descriptor("mr-IN", "मराठी", "Marathi", ["mr"]),
  descriptor("ms-MY", "Bahasa Melayu", "Malay", ["ms"]),
  descriptor("my-MM", "မြန်မာဘာသာ", "Burmese", ["my"]),
  descriptor("nb-NO", "Norsk bokmål", "Norwegian Bokmål", ["nb", "no"]),
  descriptor("nl-NL", "Nederlands", "Dutch", ["nl"]),
  descriptor("pl-PL", "Polski", "Polish", ["pl"]),
  descriptor("pt-BR", "Português (Brasil)", "Brazilian Portuguese", ["pt", "pt-AO", "pt-MZ"]),
  descriptor("pt-PT", "Português (Portugal)", "European Portuguese", ["pt-PT"]),
  descriptor("ro-RO", "Română", "Romanian", ["ro"]),
  descriptor("ru-RU", "Русский", "Russian", ["ru"]),
  descriptor("sk-SK", "Slovenčina", "Slovak", ["sk"]),
  descriptor("sl-SI", "Slovenščina", "Slovenian", ["sl"]),
  descriptor("so-SO", "Soomaali", "Somali", ["so"]),
  descriptor("sq-AL", "Shqip", "Albanian", ["sq"]),
  descriptor("sr-RS", "Српски", "Serbian", ["sr"]),
  descriptor("sv-SE", "Svenska", "Swedish", ["sv"]),
  descriptor("sw-TZ", "Kiswahili", "Swahili", ["sw"]),
  descriptor("ta-IN", "தமிழ்", "Tamil", ["ta"]),
  descriptor("te-IN", "తెలుగు", "Telugu", ["te"]),
  descriptor("th-TH", "ไทย", "Thai", ["th"]),
  descriptor("tr-TR", "Türkçe", "Turkish", ["tr"]),
  descriptor("uk-UA", "Українська", "Ukrainian", ["uk"]),
  descriptor("vi-VN", "Tiếng Việt", "Vietnamese", ["vi"]),
  descriptor("zh-CN", "简体中文", "Simplified Chinese", ["zh", "zh-Hans", "zh-SG", "zh-MY"]),
  descriptor("zh-HK", "中文（香港）", "Hong Kong Chinese", ["zh-HK"]),
  descriptor("zh-TW", "繁體中文", "Traditional Chinese", ["zh-Hant", "zh-TW", "zh-MO"]),
] as const satisfies readonly LocaleDescriptor[];

export const LOCALE_DESCRIPTORS: Readonly<Record<SupportedLocale, LocaleDescriptor>> = Object.freeze(
  Object.fromEntries(descriptors.map((value) => [value.locale, value])) as Record<SupportedLocale, LocaleDescriptor>,
);

const normalizedLocaleMap = new Map<string, SupportedLocale>();
for (const value of descriptors) {
  normalizedLocaleMap.set(normalizedTag(value.locale), value.locale);
  for (const alias of value.aliases) {
    normalizedLocaleMap.set(normalizedTag(alias), value.locale);
  }
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function normalizeLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = normalizedTag(value);
  const exact = normalizedLocaleMap.get(normalized);
  if (exact) {
    return exact;
  }
  const language = normalized.split("-")[0];
  if (!language) {
    return undefined;
  }
  return descriptors.find((candidate) => normalizedTag(candidate.locale).split("-")[0] === language)?.locale;
}

export function matchSupportedLocale(
  values: readonly string[],
  fallback: SupportedLocale = "zh-CN",
): SupportedLocale {
  for (const value of values) {
    const locale = normalizeLocale(value);
    if (locale) {
      return locale;
    }
  }
  return fallback;
}

export function localeDescriptor(locale: SupportedLocale): LocaleDescriptor {
  return LOCALE_DESCRIPTORS[locale];
}

export function responseLanguageInstruction(locale: SupportedLocale): string {
  return `Use ${LOCALE_DESCRIPTORS[locale].englishName} for user-visible output; keep code, logs, command output, errors, file names, API fields, and evidence excerpts in their original language.`;
}

function descriptor(
  locale: SupportedLocale,
  nativeName: string,
  englishName: string,
  aliases: readonly string[],
): LocaleDescriptor {
  return Object.freeze({ locale, nativeName, englishName, direction: "ltr", aliases: Object.freeze([...aliases]) });
}

function normalizedTag(value: string): string {
  const trimmed = value.trim().replaceAll("_", "-");
  try {
    return Intl.getCanonicalLocales(trimmed)[0]?.toLowerCase() ?? trimmed.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}
