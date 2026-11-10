import { LING_THEME_CSS_VARIABLES, type ResolvedThemeState } from "./types.js";

export interface ApplyThemeOptions {
  readonly persist?: (resolved: ResolvedThemeState) => void | Promise<void>;
  readonly verify?: (root: HTMLElement, resolved: ResolvedThemeState) => boolean;
}

export interface AppliedThemeResult {
  readonly resolved: ResolvedThemeState;
  readonly previousThemeId?: string;
}

export interface ApplyThemeSyncOptions {
  readonly persist?: (resolved: ResolvedThemeState) => void;
  readonly verify?: (root: HTMLElement, resolved: ResolvedThemeState) => boolean;
}

export function applyThemeTransactionSync(
  root: HTMLElement,
  resolved: ResolvedThemeState,
  options: ApplyThemeSyncOptions = {},
): AppliedThemeResult {
  const previous = captureThemeState(root);
  root.dataset.themeTransition = "preparing";
  try {
    applyResolvedTheme(root, resolved);
    const verified = options.verify ? options.verify(root, resolved) : verifyThemeSentinel(root, resolved);
    if (!verified) throw new Error("Theme sentinel verification failed.");
    options.persist?.(resolved);
    delete root.dataset.themeTransition;
    return { resolved, previousThemeId: previous.attributes.uiTheme };
  } catch (error) {
    restoreThemeState(root, previous);
    throw error;
  }
}

export async function applyThemeTransaction(
  root: HTMLElement,
  resolved: ResolvedThemeState,
  options: ApplyThemeOptions = {},
): Promise<AppliedThemeResult> {
  const previous = captureThemeState(root);
  root.dataset.themeTransition = "preparing";
  try {
    await nextAnimationFrame();
    applyResolvedTheme(root, resolved);
    const verified = options.verify ? options.verify(root, resolved) : verifyThemeSentinel(root, resolved);
    if (!verified) throw new Error("Theme sentinel verification failed.");
    await options.persist?.(resolved);
    delete root.dataset.themeTransition;
    return { resolved, previousThemeId: previous.attributes.uiTheme };
  } catch (error) {
    restoreThemeState(root, previous);
    throw error;
  }
}

export function applyResolvedTheme(root: HTMLElement, resolved: ResolvedThemeState): void {
  const previous = captureThemeState(root);
  try {
    const usesRuntimeVariables = resolved.source === "local-import" || resolved.source === "local-generated";
    for (const variable of LING_THEME_CSS_VARIABLES) {
      if (usesRuntimeVariables) root.style.setProperty(variable, resolved.variableMap[variable]);
      else root.style.removeProperty(variable);
    }
    root.dataset.uiTheme = resolved.themeId;
    root.dataset.colorScheme = resolved.colorScheme;
    root.dataset.themeSelection = resolved.selection.mode;
    root.dataset.uiPresentation = resolved.presentationProfileId;
    root.dataset.theme = resolved.colorScheme;
    root.dataset.themePreference = legacyPreference(resolved);
    root.style.colorScheme = resolved.colorScheme;
  } catch (error) {
    restoreThemeState(root, previous);
    throw error;
  }
}

export function verifyThemeSentinel(root: HTMLElement, resolved: ResolvedThemeState): boolean {
  if (typeof getComputedStyle !== "function") return true;
  const computed = getComputedStyle(root).getPropertyValue("--ling-bg-app").trim();
  return computed.length > 0 && cssValuesAreEquivalent(
    root,
    computed,
    resolved.variableMap["--ling-bg-app"],
  );
}

function legacyPreference(resolved: ResolvedThemeState): string {
  if (resolved.selection.mode === "system") return "system";
  if (resolved.themeId === "ling-light") return "light";
  if (resolved.themeId === "ling-dark") return "dark";
  return resolved.colorScheme;
}

function nextAnimationFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function normalizeCssValue(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function cssValuesAreEquivalent(root: HTMLElement, actual: string, expected: string): boolean {
  const normalizedActual = normalizeCssValue(actual);
  const normalizedExpected = normalizeCssValue(expected);
  if (normalizedActual === normalizedExpected) return true;

  const probe = root.ownerDocument?.createElement("span");
  if (!probe) return false;
  const canonicalActual = canonicalCssColor(probe, actual);
  const canonicalExpected = canonicalCssColor(probe, expected);
  return canonicalActual !== undefined && canonicalActual === canonicalExpected;
}

function canonicalCssColor(probe: HTMLElement, value: string): string | undefined {
  probe.style.color = "";
  probe.style.color = value;
  const canonical = normalizeCssValue(probe.style.color);
  return canonical.length > 0 ? canonical : undefined;
}

interface CapturedThemeState {
  readonly attributes: Record<string, string | undefined>;
  readonly colorScheme: string;
  readonly variables: ReadonlyMap<string, string>;
}

function captureThemeState(root: HTMLElement): CapturedThemeState {
  return {
    attributes: {
      uiTheme: root.dataset.uiTheme,
      colorScheme: root.dataset.colorScheme,
      themeSelection: root.dataset.themeSelection,
      uiPresentation: root.dataset.uiPresentation,
      theme: root.dataset.theme,
      themePreference: root.dataset.themePreference,
      themeTransition: root.dataset.themeTransition,
    },
    colorScheme: root.style.colorScheme,
    variables: new Map(LING_THEME_CSS_VARIABLES.map((variable) => [variable, root.style.getPropertyValue(variable)])),
  };
}

function restoreThemeState(root: HTMLElement, previous: CapturedThemeState): void {
  for (const [key, value] of Object.entries(previous.attributes)) {
    if (value === undefined) delete root.dataset[key];
    else root.dataset[key] = value;
  }
  root.style.colorScheme = previous.colorScheme;
  for (const [variable, value] of previous.variables) {
    if (value) root.style.setProperty(variable, value);
    else root.style.removeProperty(variable);
  }
}
