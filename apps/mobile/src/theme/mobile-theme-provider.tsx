import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import { readMobileThemePreference, writeMobileThemePreference } from "../platform/remote-storage";
import {
  lingDarkMobileTheme,
  lingLightMobileTheme,
  type MobileThemePreference,
  type MobileThemeTokens,
} from "./mobile-theme";

interface MobileThemeContextValue {
  readonly preference: MobileThemePreference;
  readonly theme: MobileThemeTokens;
  readonly setPreference: (preference: MobileThemePreference) => Promise<void>;
}

const MobileThemeContext = createContext<MobileThemeContextValue | undefined>(undefined);

export function MobileThemeProvider({ children }: { readonly children: ReactNode }) {
  const systemMode = useColorScheme();
  const [preference, setPreferenceState] = useState<MobileThemePreference>("system");

  useEffect(() => {
    void readMobileThemePreference().then(setPreferenceState);
  }, []);

  const value = useMemo<MobileThemeContextValue>(() => {
    const mode = preference === "system" ? (systemMode === "dark" ? "dark" : "light") : preference;
    return {
      preference,
      theme: mode === "dark" ? lingDarkMobileTheme : lingLightMobileTheme,
      setPreference: async (next) => {
        await writeMobileThemePreference(next);
        setPreferenceState(next);
      },
    };
  }, [preference, systemMode]);

  return <MobileThemeContext.Provider value={value}>{children}</MobileThemeContext.Provider>;
}

export function useMobileTheme(): MobileThemeContextValue {
  const value = useContext(MobileThemeContext);
  if (!value) {
    throw new Error("MobileThemeProvider is required");
  }
  return value;
}
