import {
  DEFAULT_THEME_SELECTION,
  ThemeRegistry,
  applyResolvedTheme,
  applyThemeTransactionSync,
  bootstrapSnapshotToResolvedTheme,
  type LingColorScheme,
  type LingThemePackManifest,
  type RegisteredTheme,
  type ResolvedThemeState,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clearSavedLegacyThemePreference,
  legacyPreferenceToSelection,
  listStoredThemeManifests,
  persistResolvedTheme,
  putStoredThemeManifest,
  readInitialThemeSelection,
  readSavedLegacyThemePreference,
  readThemeBootstrapSnapshot,
  themeSelectionToLegacyPreference,
  writeLegacyBootstrapPreference,
  type LegacyThemePreference,
} from "./shared/ui/theme/web-theme-storage.js";
import {
  deleteStoredWebThemePackage,
  type ParsedWebThemePackage,
  type StoredWebThemePackage,
} from "./shared/ui/theme/package/index.js";
import {
  publishWebGeneratedThemeManifest,
  webGeneratedThemeDescriptor,
} from "./shared/ui/theme/studio/index.js";
import {
  createThemePackageRepository,
  type ThemePackageRepositoryDescriptor,
  type ThemePackageRepositoryPort,
} from "./shared/ui/theme/package/index.js";
import {
  createThemePackageRequestId,
  repairUnavailableThemeSelection,
  requireThemePackageResult,
  selectionAfterThemeRemoval,
  storedPackageFromRepositoryRead,
  themePackagePublication,
  ThemePackageRepositoryOperationError,
  type ThemePackageRepairItem,
} from "./shared/ui/theme/theme-package-runtime.js";

export type ThemePreference = LegacyThemePreference;
export type ResolvedTheme = LingColorScheme;
export type ThemeStorageWarning =
  | "active-sync-failed"
  | "cleanup-pending"
  | "load-failed"
  | "save-failed";

export interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly selection: ThemeSelection;
  readonly resolved: ResolvedThemeState;
  readonly repositoryReady: boolean;
  readonly generatedThemePublishingSupported: boolean;
  readonly themes: readonly RegisteredTheme[];
  readonly themePackageRepairs: readonly ThemePackageRepairItem[];
  readonly storageWarning?: ThemeStorageWarning;
  readonly setPreference: (preference: ThemePreference) => void;
  readonly setLegacyPreference: (preference: ThemePreference) => void;
  readonly setFixedTheme: (themeId: string) => Promise<void>;
  readonly setFollowSystem: (enabled: boolean) => Promise<void>;
  readonly installTheme: (manifest: LingThemePackManifest) => Promise<RegisteredTheme>;
  readonly installThemePackage: (publication: ParsedWebThemePackage) => Promise<RegisteredTheme>;
  readonly readThemePackage: (themeId: string) => Promise<StoredWebThemePackage | undefined>;
  readonly removeTheme: (themeId: string) => Promise<void>;
  readonly syncActiveTheme: (themeId: string) => Promise<void>;
}

const fallbackRegistry = new ThemeRegistry();
const fallbackResolved = fallbackRegistry.resolve(DEFAULT_THEME_SELECTION, "light");
const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolvedTheme: "light",
  selection: DEFAULT_THEME_SELECTION,
  resolved: fallbackResolved,
  repositoryReady: false,
  generatedThemePublishingSupported: false,
  themes: fallbackRegistry.list(),
  themePackageRepairs: [],
  setPreference: () => undefined,
  setLegacyPreference: () => undefined,
  setFixedTheme: async () => undefined,
  setFollowSystem: async () => undefined,
  installTheme: async () => { throw new Error("ThemeProvider is unavailable."); },
  installThemePackage: async () => { throw new Error("ThemeProvider is unavailable."); },
  readThemePackage: async () => undefined,
  removeTheme: async () => undefined,
  syncActiveTheme: async () => undefined,
});

export function ThemeProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const initialRef = useRef(readInitialThemeSelection());
  const registryRef = useRef(new ThemeRegistry());
  const repositoryRef = useRef<ThemePackageRepositoryPort | undefined>(undefined);
  repositoryRef.current ??= createThemePackageRepository();
  const repositoryDescriptorsRef = useRef(new Map<string, ThemePackageRepositoryDescriptor>());
  const explicitSelectionRef = useRef(initialRef.current.explicit);
  const selectionRef = useRef(initialRef.current.selection);
  const initialSystemSchemeRef = useRef(readSystemTheme());
  const storedBootstrapSnapshotRef = useRef(readThemeBootstrapSnapshot());
  const bootstrapSnapshotRef = useRef(authorizeBootstrapSnapshot(
    initialRef.current.selection,
    initialSystemSchemeRef.current,
    storedBootstrapSnapshotRef.current,
  ));
  const [selection, setSelectionState] = useState<ThemeSelection>(initialRef.current.selection);
  const [systemScheme, setSystemScheme] = useState<LingColorScheme>(initialSystemSchemeRef.current);
  const bootstrapSystemSchemeRef = useRef(systemScheme);
  const [registryReady, setRegistryReady] = useState(false);
  const [repositoryReady, setRepositoryReady] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [themePackageRepairs, setThemePackageRepairs] = useState<readonly ThemePackageRepairItem[]>([]);
  const initialResolvedRef = useRef(resolveTarget(
    registryRef.current,
    initialRef.current.selection,
    systemScheme,
    false,
    bootstrapSnapshotRef.current,
    fallbackSchemeForUnavailableSelection(initialRef.current.selection, storedBootstrapSnapshotRef.current),
  ));
  const [resolved, setResolved] = useState<ResolvedThemeState>(initialResolvedRef.current);
  const [preferenceWarning, setPreferenceWarning] = useState<Extract<ThemeStorageWarning, "save-failed">>();
  const [repositoryWarning, setRepositoryWarning] = useState<Exclude<ThemeStorageWarning, "save-failed">>();
  const storageWarning = preferenceWarning ?? repositoryWarning;

  const targetResolved = useMemo(() => resolveTarget(
    registryRef.current,
    selection,
    systemScheme,
    registryReady,
    bootstrapSnapshotRef.current,
    fallbackSchemeForUnavailableSelection(selection, storedBootstrapSnapshotRef.current),
  ), [registryReady, registryVersion, selection, systemScheme]);

  const applyTarget = useCallback((nextSelection: ThemeSelection, target: ResolvedThemeState, persist: boolean): void => {
    const root = globalThis.document?.documentElement;
    if (!root) {
      setSelectionState(nextSelection);
      selectionRef.current = nextSelection;
      setResolved(target);
      return;
    }
    try {
      if (persist) {
        const packageChecksumSha256 = repositoryRef.current?.kind === "desktop"
          ? repositoryDescriptorsRef.current.get(target.themeId)?.packageChecksumSha256
          : undefined;
        applyThemeTransactionSync(root, target, {
          persist: () => persistResolvedTheme(nextSelection, target, packageChecksumSha256),
        });
      } else {
        applyResolvedTheme(root, target);
      }
      setSelectionState(nextSelection);
      selectionRef.current = nextSelection;
      setResolved(target);
      setPreferenceWarning(undefined);
    } catch {
      setPreferenceWarning("save-failed");
      throw new Error("Theme preference could not be saved.");
    }
  }, []);

  const commitSelection = useCallback(async (nextSelection: ThemeSelection): Promise<void> => {
    const target = resolveTarget(
      registryRef.current,
      nextSelection,
      systemScheme,
      registryReady,
      bootstrapSnapshotRef.current,
      fallbackSchemeForUnavailableSelection(nextSelection, storedBootstrapSnapshotRef.current),
    );
    applyTarget(nextSelection, target, true);
    explicitSelectionRef.current = true;
  }, [applyTarget, registryReady, systemScheme]);

  useLayoutEffect(() => {
    if (sameResolvedTheme(resolved, targetResolved)) return;
    try {
      applyTarget(selection, targetResolved, explicitSelectionRef.current);
    } catch {
      setSelectionState(resolved.selection);
    }
  }, [applyTarget, resolved, selection, targetResolved]);

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return undefined;
    const onChange = (event: MediaQueryListEvent): void => setSystemScheme(event.matches ? "dark" : "light");
    setSystemScheme(mediaQuery.matches ? "dark" : "light");
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const repository = repositoryRef.current!;
    void Promise.all([
      repository.bootstrap(),
      repository.kind === "desktop" ? listStoredThemeManifests() : Promise.resolve([]),
    ])
      .then(([result, legacyManifests]) => {
        if (cancelled) return;
        const bootstrap = requireThemePackageResult(result);
        const descriptors = new Map(bootstrap.packages.map((item) => [item.themeId, item]));
        repositoryDescriptorsRef.current = descriptors;
        const repairs: ThemePackageRepairItem[] = [];
        const knownManifests = new Map<string, LingThemePackManifest>();
        for (const descriptor of bootstrap.packages) {
          if (descriptor.manifest) knownManifests.set(descriptor.themeId, descriptor.manifest);
          if (descriptor.health !== "ready" || !descriptor.manifest) {
            repairs.push({
              descriptor,
              displayName: descriptor.manifest?.name ?? descriptor.themeId,
              issueCode: descriptor.issueCode,
              kind: "corrupt",
              themeId: descriptor.themeId,
            });
            continue;
          }
          const installed = registryRef.current.install(
            descriptor.manifest,
            descriptor.manifest.source === "local-generated" ? "local-generated" : "local-import",
            descriptor.installedAt,
          );
          if (!installed.ok) {
            repairs.push({
              descriptor: { ...descriptor, health: "corrupt", issueCode: "invalid_manifest" },
              displayName: descriptor.manifest.name,
              issueCode: "invalid_manifest",
              kind: "corrupt",
              themeId: descriptor.themeId,
            });
          }
        }
        if (repository.kind === "desktop") {
          for (const manifest of legacyManifests) {
            if ((manifest.source === "local-import" || manifest.source === "local-generated")
              && !descriptors.has(manifest.id)) {
              knownManifests.set(manifest.id, manifest);
              repairs.push({
                displayName: manifest.name,
                issueCode: "legacy_browser_only",
                kind: "legacy-browser-only",
                themeId: manifest.id,
              });
            }
          }
        }
        const availableIds = new Set(registryRef.current.list().map((theme) => theme.manifest.id));
        const repairedSelection = repairUnavailableThemeSelection(
          selectionRef.current,
          availableIds,
          bootstrapSystemSchemeRef.current,
          knownManifests,
          fallbackSchemeForUnavailableSelection(selectionRef.current, storedBootstrapSnapshotRef.current),
        );
        if (!sameThemeSelection(selectionRef.current, repairedSelection)) {
          const target = registryRef.current.resolve(repairedSelection, bootstrapSystemSchemeRef.current);
          applyTarget(repairedSelection, target, true);
          explicitSelectionRef.current = true;
        }
        setThemePackageRepairs(Object.freeze(repairs));
        setRepositoryWarning(bootstrap.recoveryWarnings.length > 0 ? "cleanup-pending" : undefined);
      })
      .catch(() => {
        if (!cancelled) setRepositoryWarning("load-failed");
      })
      .finally(() => {
        if (!cancelled) {
          setRegistryReady(true);
          setRepositoryReady(true);
          setRegistryVersion((current) => current + 1);
        }
      });
    return () => { cancelled = true; };
  }, [applyTarget]);

  const setPreference = useCallback((preference: ThemePreference): void => {
    void commitSelection(legacyPreferenceToSelection(preference)).catch(() => undefined);
  }, [commitSelection]);

  const setLegacyPreference = useCallback((preference: ThemePreference): void => {
    if (explicitSelectionRef.current) return;
    const nextSelection = legacyPreferenceToSelection(preference);
    const target = resolveTarget(
      registryRef.current,
      nextSelection,
      systemScheme,
      registryReady,
      bootstrapSnapshotRef.current,
      fallbackSchemeForUnavailableSelection(nextSelection, storedBootstrapSnapshotRef.current),
    );
    applyTarget(nextSelection, target, false);
    writeLegacyBootstrapPreference(preference);
  }, [applyTarget, registryReady, systemScheme]);

  const setFixedTheme = useCallback((themeId: string): Promise<void> => commitSelection({ mode: "fixed", themeId }), [commitSelection]);
  const setFollowSystem = useCallback((enabled: boolean): Promise<void> => commitSelection(enabled
    ? DEFAULT_THEME_SELECTION
    : { mode: "fixed", themeId: resolved.themeId }), [commitSelection, resolved.themeId]);

  const installTheme = useCallback(async (manifest: LingThemePackManifest): Promise<RegisteredTheme> => {
    if (repositoryRef.current!.kind === "desktop") {
      throw new Error("Desktop themes require a reviewed .ling-theme package.");
    }
    if (manifest.source !== "local-import" && manifest.source !== "local-generated") {
      throw new Error("Only local theme manifests can be installed.");
    }
    if (manifest.source === "local-generated" && registryRef.current.get(manifest.id)) {
      throw new Error("This generated theme is already installed.");
    }
    const result = registryRef.current.install(manifest, manifest.source);
    if (!result.ok || !result.theme) throw new Error(result.issues?.[0]?.message ?? "Theme manifest is invalid.");
    try {
      if (result.theme.manifest.source === "local-generated") {
        const stored = await publishWebGeneratedThemeManifest(result.theme.manifest);
        repositoryDescriptorsRef.current.set(
          result.theme.manifest.id,
          webGeneratedThemeDescriptor(stored),
        );
      } else {
        await putStoredThemeManifest(result.theme.manifest);
      }
    } catch (error) {
      registryRef.current.uninstall(result.theme.manifest.id);
      throw error;
    }
    setRegistryVersion((current) => current + 1);
    return result.theme;
  }, []);

  const syncActiveTheme = useCallback(async (themeId: string): Promise<void> => {
    const result = await repositoryRef.current!.setActive({ themeId });
    if (!result.ok) {
      setRepositoryWarning((current) => current === "load-failed" ? current : "active-sync-failed");
      throw new ThemePackageRepositoryOperationError(result.error);
    }
    setRepositoryWarning((current) => current === "active-sync-failed" ? undefined : current);
  }, []);

  const installThemePackage = useCallback(async (
    publication: ParsedWebThemePackage,
  ): Promise<RegisteredTheme> => {
    const themeId = publication.manifest.id;
    const previousTheme = registryRef.current.get(themeId);
    const descriptor = repositoryDescriptorsRef.current.get(themeId);
    const replacesLegacyBrowserRecord = repositoryRef.current!.kind === "desktop"
      && themePackageRepairs.some((item) => item.themeId === themeId && item.kind === "legacy-browser-only");
    const requestId = createThemePackageRequestId(descriptor ? "reimport" : "install");
    const repositoryResult = descriptor
      ? await repositoryRef.current!.reimport({
        archiveBytes: publication.archiveBytes,
        expectedRecordRevision: descriptor.recordRevision,
        originalFileName: publication.originalFileName,
        publication: themePackagePublication(publication),
        requestId,
        themeId,
        ...(descriptor.packageChecksumSha256 !== undefined
          ? { expectedCurrentChecksumSha256: descriptor.packageChecksumSha256 }
          : {}),
      })
      : await repositoryRef.current!.install({
        archiveBytes: publication.archiveBytes,
        originalFileName: publication.originalFileName,
        publication: themePackagePublication(publication),
        requestId,
      });
    const published = requireThemePackageResult(repositoryResult);
    if (published.health !== "ready" || !published.manifest) {
      throw new Error("Theme repository returned an unavailable package.");
    }
    const result = registryRef.current.install(
      published.manifest,
      published.manifest.source === "local-generated" ? "local-generated" : "local-import",
      published.installedAt ?? previousTheme?.installedAt,
    );
    if (!result.ok || !result.theme) throw new Error(result.issues?.[0]?.message ?? "Theme manifest is invalid.");
    repositoryDescriptorsRef.current.set(themeId, published);
    setThemePackageRepairs((current) => current.filter((item) => item.themeId !== themeId));
    if (replacesLegacyBrowserRecord) {
      await deleteStoredWebThemePackage(themeId).catch(() => setRepositoryWarning("cleanup-pending"));
    }
    if (resolved.themeId === themeId) {
      try {
        const target = registryRef.current.resolve(selection, systemScheme);
        applyTarget(selection, target, true);
      } catch (error) {
        restoreRegistryTheme(registryRef.current, themeId, previousTheme);
        throw error;
      }
    }
    setRegistryVersion((current) => current + 1);
    return result.theme;
  }, [applyTarget, resolved.themeId, selection, systemScheme, themePackageRepairs]);

  const readThemePackage = useCallback(async (themeId: string): Promise<StoredWebThemePackage | undefined> => {
    const result = await repositoryRef.current!.read({ includePreviewBytes: true, themeId });
    return storedPackageFromRepositoryRead(requireThemePackageResult(result));
  }, []);

  const removeTheme = useCallback(async (themeId: string): Promise<void> => {
    const theme = registryRef.current.get(themeId);
    if (theme?.source === "built-in") return;
    const descriptor = repositoryDescriptorsRef.current.get(themeId);
    const legacyRepair = themePackageRepairs.find((item) => (
      item.themeId === themeId && item.kind === "legacy-browser-only"
    ));
    if (!descriptor && legacyRepair) {
      await deleteStoredWebThemePackage(themeId);
      setThemePackageRepairs((current) => current.filter((item) => item.themeId !== themeId));
      return;
    }
    if (!descriptor) return;
    const previousSelection = selection;
    let switchedActive = false;
    if (resolved.themeId === themeId) {
      const nextSelection = selectionAfterThemeRemoval(
        previousSelection,
        themeId,
        theme?.manifest.colorScheme ?? resolved.colorScheme,
      );
      const fallbackId = nextSelection.mode === "fixed"
        ? nextSelection.themeId
        : resolved.colorScheme === "dark"
          ? nextSelection.darkThemeId
          : nextSelection.lightThemeId;
      await commitSelection(nextSelection);
      try {
        await syncActiveTheme(fallbackId);
        switchedActive = true;
      } catch (error) {
        await commitSelection(previousSelection).catch(() => undefined);
        throw error;
      }
    }
    try {
      requireThemePackageResult(await repositoryRef.current!.delete({
        expectedRecordRevision: descriptor.recordRevision,
        requestId: createThemePackageRequestId("delete"),
        themeId,
        ...(descriptor.packageChecksumSha256 !== undefined
          ? { expectedCurrentChecksumSha256: descriptor.packageChecksumSha256 }
          : {}),
      }));
    } catch (error) {
      if (switchedActive) {
        await commitSelection(previousSelection).catch(() => undefined);
        await syncActiveTheme(themeId).catch(() => undefined);
      }
      throw error;
    }
    registryRef.current.uninstall(themeId);
    repositoryDescriptorsRef.current.delete(themeId);
    setThemePackageRepairs((current) => current.filter((item) => item.themeId !== themeId));
    setRegistryVersion((current) => current + 1);
  }, [commitSelection, resolved.colorScheme, resolved.themeId, selection, syncActiveTheme, themePackageRepairs]);

  const preference = themeSelectionToLegacyPreference(selection, resolved);
  const value = useMemo<ThemeContextValue>(() => ({
    preference,
    resolvedTheme: resolved.colorScheme,
    selection,
    resolved,
    repositoryReady,
    generatedThemePublishingSupported: repositoryRef.current!.kind === "web",
    themes: registryRef.current.list(),
    themePackageRepairs,
    storageWarning,
    setPreference,
    setLegacyPreference,
    setFixedTheme,
    setFollowSystem,
    installTheme,
    installThemePackage,
    readThemePackage,
    removeTheme,
    syncActiveTheme,
  }), [installTheme, installThemePackage, preference, readThemePackage, removeTheme, repositoryReady, resolved, selection, setFixedTheme, setFollowSystem, setLegacyPreference, setPreference, storageWarning, syncActiveTheme, themePackageRepairs, registryVersion]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function readSavedThemePreference(): ThemePreference | undefined {
  return readSavedLegacyThemePreference();
}

export function clearSavedThemePreference(): void {
  clearSavedLegacyThemePreference();
}

export function writeThemeBootstrapPreference(preference: ThemePreference): void {
  writeLegacyBootstrapPreference(preference);
}

function resolveTarget(
  registry: ThemeRegistry,
  selection: ThemeSelection,
  systemScheme: LingColorScheme,
  registryReady: boolean,
  snapshot: ReturnType<typeof readThemeBootstrapSnapshot>,
  unavailableFallbackScheme?: LingColorScheme,
): ResolvedThemeState {
  const requestedThemeId = selection.mode === "fixed"
    ? selection.themeId
    : systemScheme === "dark"
      ? selection.darkThemeId
      : selection.lightThemeId;
  if (!registryReady && snapshot?.themeId === requestedThemeId) {
    return bootstrapSnapshotToResolvedTheme(selection, snapshot);
  }
  return registry.resolve(selection, unavailableFallbackScheme ?? systemScheme);
}

function fallbackSchemeForUnavailableSelection(
  selection: ThemeSelection,
  snapshot: ReturnType<typeof readThemeBootstrapSnapshot>,
): LingColorScheme | undefined {
  if (
    selection.mode !== "fixed"
    || selection.themeId === "ling-light"
    || selection.themeId === "ling-dark"
    || snapshot?.themeId !== selection.themeId
  ) return undefined;
  return snapshot.colorScheme;
}

function authorizeBootstrapSnapshot(
  selection: ThemeSelection,
  systemScheme: LingColorScheme,
  snapshot: ReturnType<typeof readThemeBootstrapSnapshot>,
): ReturnType<typeof readThemeBootstrapSnapshot> {
  if (!snapshot) return undefined;
  const requestedThemeId = selection.mode === "fixed"
    ? selection.themeId
    : systemScheme === "dark"
      ? selection.darkThemeId
      : selection.lightThemeId;
  if (snapshot.themeId !== requestedThemeId) return undefined;
  if (requestedThemeId === "ling-light" || requestedThemeId === "ling-dark") return undefined;
  const firstPaint = globalThis.window?.lingDesktop?.themePackages?.firstPaint;
  if (!globalThis.window?.lingDesktop) return snapshot;
  if (!firstPaint?.authorityComplete || !Array.isArray(firstPaint.readyThemes)) return undefined;
  const authority = firstPaint.readyThemes.find((entry) => entry.themeId === requestedThemeId);
  return authority && snapshot.packageChecksumSha256 === authority.packageChecksumSha256
    ? snapshot
    : undefined;
}

function readSystemTheme(): LingColorScheme {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function sameResolvedTheme(left: ResolvedThemeState, right: ResolvedThemeState): boolean {
  if (
    left.themeId !== right.themeId
    || left.colorScheme !== right.colorScheme
    || left.source !== right.source
    || left.presentationProfileId !== right.presentationProfileId
    || left.manifest.name !== right.manifest.name
    || !sameThemeSelection(left.selection, right.selection)
  ) return false;
  return Object.entries(left.variableMap).every(([key, value]) => right.variableMap[key as keyof typeof right.variableMap] === value);
}

function sameThemeSelection(left: ThemeSelection, right: ThemeSelection): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "fixed" && right.mode === "fixed") return left.themeId === right.themeId;
  return left.mode === "system" && right.mode === "system"
    && left.lightThemeId === right.lightThemeId
    && left.darkThemeId === right.darkThemeId;
}

function restoreRegistryTheme(
  registry: ThemeRegistry,
  themeId: string,
  previous: RegisteredTheme | undefined,
): void {
  if (previous && previous.source !== "built-in") {
    registry.install(previous.manifest, previous.source, previous.installedAt);
  } else {
    registry.uninstall(themeId);
  }
}
