import type { SupportedLocale } from "./locale-registry.js";

export interface LocaleFormatters {
  readonly number: Intl.NumberFormat;
  readonly compactNumber: Intl.NumberFormat;
  readonly date: Intl.DateTimeFormat;
  readonly dateTime: Intl.DateTimeFormat;
  readonly relativeTime: Intl.RelativeTimeFormat;
  readonly list: Intl.ListFormat;
}

export function createLocaleFormatters(locale: SupportedLocale): LocaleFormatters {
  return Object.freeze({
    number: new Intl.NumberFormat(locale),
    compactNumber: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    dateTime: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    relativeTime: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
    list: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }),
  });
}
