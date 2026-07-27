import { subscribeWithInitialRead } from "../../shared/initial-state-subscription.js";
import {
  DESKTOP_RENDERER_THEME_VARIABLES,
  parseDesktopRendererThemeSnapshot,
  type DesktopRendererThemeSnapshot,
} from "../../shared/renderer-theme.js";
import type { LingComputerUsePreviewCapabilities } from "../../shared/desktop-capabilities.js";

export interface ComputerUsePreviewThemeController {
  dispose(): void;
  start(): void;
}

export function createComputerUsePreviewThemeController(input: {
  readonly getCapabilities: () => LingComputerUsePreviewCapabilities | undefined;
  readonly root?: HTMLElement;
}): ComputerUsePreviewThemeController {
  const root = input.root ?? document.documentElement;
  let appliedRevision = 0;
  let unsubscribe: (() => void) | undefined;

  const apply = (value: unknown): void => {
    const snapshot = parseDesktopRendererThemeSnapshot(value);
    if (!snapshot || snapshot.revision <= appliedRevision) {
      return;
    }
    applySnapshot(root, snapshot);
    appliedRevision = snapshot.revision;
  };

  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
    start: () => {
      if (unsubscribe) {
        return;
      }
      const capabilities = input.getCapabilities();
      if (
        !capabilities
        || typeof capabilities.getThemeSnapshot !== "function"
        || typeof capabilities.onThemeSnapshotChanged !== "function"
      ) {
        return;
      }
      unsubscribe = subscribeWithInitialRead({
        read: () => capabilities.getThemeSnapshot(),
        subscribe: (listener) => capabilities.onThemeSnapshotChanged(listener),
        onValue: apply,
      });
    },
  };
}

function applySnapshot(root: HTMLElement, snapshot: DesktopRendererThemeSnapshot): void {
  const previous = captureThemeState(root);
  try {
    for (const variable of DESKTOP_RENDERER_THEME_VARIABLES) {
      const value = snapshot.variables[variable];
      if (value === undefined) {
        root.style.removeProperty(variable);
      } else {
        root.style.setProperty(variable, value);
      }
    }
    root.dataset.uiTheme = snapshot.themeId;
    root.dataset.colorScheme = snapshot.colorScheme;
    root.dataset.theme = snapshot.colorScheme;
    root.dataset.uiPresentation = snapshot.presentationProfileId;
    root.dataset.presentationProfile = snapshot.presentationProfileId;
    root.dataset.uiSurface = "overlay";
    root.dataset.uiSurfaceRecipe = "solid";
    root.dataset.uiArtworkPolicy = "off";
    root.dataset.uiDecorationPolicy = "off";
    root.style.colorScheme = snapshot.colorScheme;
    root.dataset.themeRevision = String(snapshot.revision);
  } catch (error) {
    restoreThemeState(root, previous);
    throw error;
  }
}

function captureThemeState(root: HTMLElement) {
  return {
    colorScheme: root.style.colorScheme,
    colorSchemeAttribute: root.dataset.colorScheme,
    presentationProfile: root.dataset.presentationProfile,
    uiPresentation: root.dataset.uiPresentation,
    uiSurface: root.dataset.uiSurface,
    uiSurfaceRecipe: root.dataset.uiSurfaceRecipe,
    uiArtworkPolicy: root.dataset.uiArtworkPolicy,
    uiDecorationPolicy: root.dataset.uiDecorationPolicy,
    theme: root.dataset.theme,
    themeId: root.dataset.uiTheme,
    themeRevision: root.dataset.themeRevision,
    variables: new Map(DESKTOP_RENDERER_THEME_VARIABLES.map((variable) => [
      variable,
      root.style.getPropertyValue(variable),
    ])),
  };
}

function restoreThemeState(root: HTMLElement, previous: ReturnType<typeof captureThemeState>): void {
  restoreDataAttribute(root, "presentationProfile", previous.presentationProfile);
  restoreDataAttribute(root, "uiPresentation", previous.uiPresentation);
  restoreDataAttribute(root, "uiSurface", previous.uiSurface);
  restoreDataAttribute(root, "uiSurfaceRecipe", previous.uiSurfaceRecipe);
  restoreDataAttribute(root, "uiArtworkPolicy", previous.uiArtworkPolicy);
  restoreDataAttribute(root, "uiDecorationPolicy", previous.uiDecorationPolicy);
  restoreDataAttribute(root, "colorScheme", previous.colorSchemeAttribute);
  restoreDataAttribute(root, "theme", previous.theme);
  restoreDataAttribute(root, "uiTheme", previous.themeId);
  restoreDataAttribute(root, "themeRevision", previous.themeRevision);
  root.style.colorScheme = previous.colorScheme;
  for (const [variable, value] of previous.variables) {
    if (value) {
      root.style.setProperty(variable, value);
    } else {
      root.style.removeProperty(variable);
    }
  }
}

function restoreDataAttribute(
  root: HTMLElement,
  key: "presentationProfile" | "uiPresentation" | "uiSurface" | "uiSurfaceRecipe" | "uiArtworkPolicy" | "uiDecorationPolicy" | "colorScheme" | "theme" | "uiTheme" | "themeRevision",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete root.dataset[key];
  } else {
    root.dataset[key] = value;
  }
}
