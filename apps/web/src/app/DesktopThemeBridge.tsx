import { useEffect } from "react";
import { useTheme } from "../theme.js";

export function DesktopThemeBridge(): null {
  const { repositoryReady, resolved, syncActiveTheme } = useTheme();

  useEffect(() => {
    if (repositoryReady) void syncActiveTheme(resolved.themeId).catch(() => undefined);
    const tokens = resolved.manifest.tokens;
    const desktop = resolved.manifest.desktop;
    window.lingDesktop?.appearance?.reportTheme({
      themeId: resolved.themeId,
      colorScheme: resolved.colorScheme,
      presentationProfileId: resolved.presentationProfileId,
      variables: {
        ...resolved.variableMap,
        "--ling-overlay-scrim": tokens.background.overlay,
        "--ling-compact-window-bg": desktop?.windowBackground ?? tokens.background.elevated,
        "--ling-compact-window-elevated": tokens.background.elevated,
        "--ling-compact-window-text": tokens.text.strong,
        "--ling-compact-window-muted": tokens.text.muted,
        "--ling-compact-window-border": tokens.border.default,
        "--ling-compact-window-focus": tokens.border.focus,
        "--ling-compact-window-shadow": tokens.shadow.overlay,
      },
    });
  }, [repositoryReady, resolved, syncActiveTheme]);

  return null;
}
