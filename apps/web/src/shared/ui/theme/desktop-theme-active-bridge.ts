import type {
  ThemePackageRepositoryPort,
  ThemePackageRepositoryResult,
  ThemePackageRepositorySetActiveValue,
} from "./package/theme-package-repository-port.js";

export interface DesktopThemeActiveBridge {
  syncActiveTheme(themeId: string): Promise<ThemePackageRepositoryResult<ThemePackageRepositorySetActiveValue>>;
}

export function createDesktopThemeActiveBridge(
  repository: ThemePackageRepositoryPort,
): DesktopThemeActiveBridge {
  return Object.freeze({
    syncActiveTheme: (themeId: string) => repository.setActive({ themeId }),
  });
}
