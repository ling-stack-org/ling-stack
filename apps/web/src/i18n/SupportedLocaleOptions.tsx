import { LOCALE_DESCRIPTORS, SUPPORTED_LOCALES } from "@ling-stack/localization";

export function SupportedLocaleOptions(): React.JSX.Element {
  return (
    <>
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {LOCALE_DESCRIPTORS[locale].nativeName}
        </option>
      ))}
    </>
  );
}
