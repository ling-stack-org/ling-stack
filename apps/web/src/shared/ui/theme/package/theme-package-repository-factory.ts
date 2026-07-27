import {
  DesktopThemePackageRepositoryAdapter,
  type DesktopThemePackageCapabilityLike,
} from "./desktop-theme-package-repository-adapter.js";
import type { ThemePackageRepositoryPort } from "./theme-package-repository-port.js";
import { WebThemePackageRepositoryAdapter } from "./web-theme-package-repository-adapter.js";

export interface ThemePackageRepositoryFactoryOptions {
  readonly desktopCapability?: unknown;
  readonly createWebRepository?: () => ThemePackageRepositoryPort;
}

const CAPABILITY_METHODS = Object.freeze([
  "bootstrap",
  "delete",
  "install",
  "list",
  "read",
  "reimport",
  "setActive",
] as const);

export function createThemePackageRepository(
  options: ThemePackageRepositoryFactoryOptions = {},
): ThemePackageRepositoryPort {
  const candidate = options.desktopCapability ?? readDesktopCapability();
  if (isCompleteDesktopThemePackageCapability(candidate)) {
    return new DesktopThemePackageRepositoryAdapter(candidate);
  }
  return options.createWebRepository?.() ?? new WebThemePackageRepositoryAdapter();
}

export function isCompleteDesktopThemePackageCapability(
  value: unknown,
): value is DesktopThemePackageCapabilityLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return CAPABILITY_METHODS.every((method) => typeof candidate[method] === "function");
}

function readDesktopCapability(): unknown {
  const root = globalThis as typeof globalThis & {
    readonly lingDesktop?: { readonly themePackages?: unknown };
  };
  return root.lingDesktop?.themePackages;
}
