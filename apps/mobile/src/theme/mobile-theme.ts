export type MobileThemePreference = "system" | "light" | "dark";
export type MobileThemeMode = "light" | "dark";

export interface MobileThemeTokens {
  readonly mode: MobileThemeMode;
  readonly background: {
    readonly app: string;
    readonly panel: string;
    readonly subtle: string;
    readonly pressed: string;
  };
  readonly text: { readonly strong: string; readonly default: string; readonly muted: string; readonly inverse: string };
  readonly border: { readonly default: string };
  readonly action: { readonly accent: string };
  readonly status: { readonly info: string; readonly warning: string; readonly danger: string; readonly success: string };
  readonly spacing: readonly [2, 4, 8, 12, 16, 20, 24, 32];
  readonly radius: { readonly small: 6; readonly medium: 10; readonly large: 14; readonly pill: 999 };
}

const foundation = {
  spacing: [2, 4, 8, 12, 16, 20, 24, 32] as const,
  radius: { small: 6 as const, medium: 10 as const, large: 14 as const, pill: 999 as const },
};

export const lingLightMobileTheme: MobileThemeTokens = {
  mode: "light",
  background: { app: "#f6f7f8", panel: "#ffffff", subtle: "#f1f3f5", pressed: "#e8ebee" },
  text: { strong: "#121417", default: "#2b3036", muted: "#68707a", inverse: "#ffffff" },
  border: { default: "#d9dde2" },
  action: { accent: "#17191c" },
  status: { info: "#466b91", warning: "#8a5d12", danger: "#a13e3b", success: "#28734f" },
  ...foundation,
};

export const lingDarkMobileTheme: MobileThemeTokens = {
  mode: "dark",
  background: { app: "#111315", panel: "#171a1d", subtle: "#22262b", pressed: "#2c3137" },
  text: { strong: "#f4f5f6", default: "#d7dbe0", muted: "#9ba3ad", inverse: "#111315" },
  border: { default: "#353b42" },
  action: { accent: "#f0f2f4" },
  status: { info: "#8cb5df", warning: "#ddb45f", danger: "#e48782", success: "#68bd91" },
  ...foundation,
};
