import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n } from "./i18n.js";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const themeStorageKey = "ling-stack.themePreference";
const defaultThemePreference: ThemePreference = "system";

const ThemeContext = createContext<ThemeContextValue>({
  preference: defaultThemePreference,
  resolvedTheme: "light",
  setPreference: () => undefined,
});

export function ThemeProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readInitialThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme());
  const resolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) {
      return undefined;
    }

    const onChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    setSystemTheme(mediaQuery.matches ? "dark" : "light");
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) {
      return;
    }

    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolvedTheme;
  }, [preference, resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      setPreference: setPreferenceState,
    }),
    [preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeSwitcher(): JSX.Element {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();
  const options: ReadonlyArray<{
    readonly value: ThemePreference;
    readonly label: string;
    readonly icon: JSX.Element;
  }> = [
    { value: "system", label: t("System"), icon: <Monitor size={13} /> },
    { value: "light", label: t("Light"), icon: <Sun size={13} /> },
    { value: "dark", label: t("Dark"), icon: <Moon size={13} /> },
  ];

  return (
    <div className="theme-switcher" aria-label={t("Theme")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={preference === option.value ? "active" : ""}
          aria-pressed={preference === option.value}
          title={option.label}
          onClick={() => setPreference(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function readSavedThemePreference(): ThemePreference | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(themeStorageKey);
    return isThemePreference(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function clearSavedThemePreference(): void {
  try {
    globalThis.localStorage?.removeItem(themeStorageKey);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function readInitialThemePreference(): ThemePreference {
  return readSavedThemePreference() ?? defaultThemePreference;
}

function readSystemTheme(): ResolvedTheme {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
