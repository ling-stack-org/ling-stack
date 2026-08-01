export type MobileThemePreference = "system" | "light" | "dark";
export type MobileThemeMode = "light" | "dark";

export interface MobileThemeTokens {
  readonly mode: MobileThemeMode;
  readonly background: {
    readonly app: string;
    readonly panel: string;
    readonly elevated: string;
    readonly subtle: string;
    readonly pressed: string;
    readonly composer: string;
    readonly selection: string;
  };
  readonly text: { readonly strong: string; readonly default: string; readonly muted: string; readonly soft: string; readonly inverse: string };
  readonly border: { readonly default: string; readonly strong: string; readonly hairline: string };
  readonly action: { readonly accent: string; readonly foreground: string };
  readonly identity: { readonly background: string; readonly foreground: string };
  readonly status: {
    readonly info: string;
    readonly infoBackground: string;
    readonly warning: string;
    readonly warningBackground: string;
    readonly warningBorder: string;
    readonly danger: string;
    readonly success: string;
  };
  readonly spacing: readonly [2, 4, 8, 12, 16, 20, 24, 32];
  readonly radius: { readonly small: 6; readonly medium: 10; readonly large: 14; readonly pill: 999 };
}

const foundation = {
  spacing: [2, 4, 8, 12, 16, 20, 24, 32] as const,
  radius: { small: 6 as const, medium: 10 as const, large: 14 as const, pill: 999 as const },
};

export const lingLightMobileTheme: MobileThemeTokens = {
  mode: "light",
  background: {
    app: "#f6f7f8",
    panel: "#ffffff",
    elevated: "#ffffff",
    subtle: "#f1f3f5",
    pressed: "#e8ebee",
    composer: "#ffffff",
    selection: "#dfe8f2",
  },
  text: { strong: "#121417", default: "#2b3036", muted: "#68707a", soft: "#7c858f", inverse: "#ffffff" },
  border: { default: "#d9dde2", strong: "#b8bec6", hairline: "rgba(18,20,23,0.09)" },
  action: { accent: "#17191c", foreground: "#ffffff" },
  identity: { background: "#d8e3ee", foreground: "#2f4f6c" },
  status: {
    info: "#466b91",
    infoBackground: "#eef4fa",
    warning: "#8a5d12",
    warningBackground: "#fff8e8",
    warningBorder: "#e6d4a7",
    danger: "#a13e3b",
    success: "#2f7654",
  },
  ...foundation,
};

export const lingDarkMobileTheme: MobileThemeTokens = {
  mode: "dark",
  background: {
    app: "#111315",
    panel: "#171a1d",
    elevated: "#1d2024",
    subtle: "#22262b",
    pressed: "#2c3137",
    composer: "#191c20",
    selection: "#2b3a49",
  },
  text: { strong: "#f4f5f6", default: "#d7dbe0", muted: "#9ba3ad", soft: "#89929d", inverse: "#111315" },
  border: { default: "#353b42", strong: "#4b535d", hairline: "rgba(255,255,255,0.09)" },
  action: { accent: "#f0f2f4", foreground: "#151719" },
  identity: { background: "#d8e3ee", foreground: "#2f4f6c" },
  status: {
    info: "#8cb5df",
    infoBackground: "#1d2935",
    warning: "#ddb45f",
    warningBackground: "#2c271b",
    warningBorder: "#5f512f",
    danger: "#e48782",
    success: "#68bd91",
  },
  ...foundation,
};
