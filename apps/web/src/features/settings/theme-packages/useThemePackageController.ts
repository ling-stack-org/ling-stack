import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { LingThemePackageIssue, RegisteredTheme } from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import { useLingToast } from "../../../shared/ui/index.js";
import {
  parseWebThemePackage,
  type ParsedWebThemePackage,
  type StoredWebThemePackage,
} from "../../../shared/ui/theme/package/index.js";
import type { ThemePackageRepairItem } from "../../../shared/ui/theme/theme-package-runtime.js";
import { useTheme } from "../../../theme.js";
import {
  candidateThemePreviewTarget,
  registeredThemePreviewTarget,
  type ThemePreviewTarget,
} from "./theme-package-view-models.js";

export type ThemeImportPhase = "choose" | "installed-warning" | "publishing" | "review" | "validating";

export interface ThemeImportDialogState {
  readonly candidate?: ParsedWebThemePackage;
  readonly fileName?: string;
  readonly installed: boolean;
  readonly issues: readonly LingThemePackageIssue[];
  readonly mode: "import" | "reimport";
  readonly open: boolean;
  readonly phase: ThemeImportPhase;
  readonly targetThemeId?: string;
  readonly useAfterImport: boolean;
}

export interface ThemePreviewDialogState {
  readonly error?: string;
  readonly loading: boolean;
  readonly open: boolean;
  readonly package?: StoredWebThemePackage | ParsedWebThemePackage;
  readonly previewUrl?: string;
  readonly target?: ThemePreviewTarget;
}

export interface ThemeDeleteDialogState {
  readonly busy: boolean;
  readonly error?: LingThemePackageIssue;
  readonly target?: ThemeDeleteTarget;
}

export interface ThemeDeleteTarget {
  readonly id: string;
  readonly name: string;
}

const INITIAL_IMPORT: ThemeImportDialogState = Object.freeze({
  installed: false,
  issues: [],
  mode: "import",
  open: false,
  phase: "choose",
  useAfterImport: false,
});

export function useThemePackageController() {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const {
    installThemePackage,
    readThemePackage,
    removeTheme,
    setFixedTheme,
    themes,
  } = useTheme();
  const importReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const operationRef = useRef(0);
  const previewUrlRef = useRef<string | undefined>(undefined);
  const [importState, setImportState] = useState<ThemeImportDialogState>(INITIAL_IMPORT);
  const [previewState, setPreviewState] = useState<ThemePreviewDialogState>({
    loading: false,
    open: false,
  });
  const [deleteState, setDeleteState] = useState<ThemeDeleteDialogState>({ busy: false });

  useEffect(() => () => revokePreviewUrl(previewUrlRef), []);

  const openImport = (trigger?: HTMLButtonElement | null): void => {
    importReturnFocusRef.current = trigger ?? null;
    setImportState({ ...INITIAL_IMPORT, open: true });
  };

  const openReimport = (theme: RegisteredTheme, trigger?: HTMLButtonElement | null): void => {
    openReimportTarget(theme.manifest.id, trigger);
  };

  const openRepairReimport = (repair: ThemePackageRepairItem, trigger?: HTMLButtonElement | null): void => {
    openReimportTarget(repair.themeId, trigger);
  };

  const openReimportTarget = (themeId: string, trigger?: HTMLButtonElement | null): void => {
    importReturnFocusRef.current = trigger ?? null;
    setImportState({
      ...INITIAL_IMPORT,
      mode: "reimport",
      open: true,
      targetThemeId: themeId,
    });
  };

  const closeImport = (): void => {
    operationRef.current += 1;
    setImportState(INITIAL_IMPORT);
  };

  const loadFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setImportState((current) => ({
      ...current,
      candidate: undefined,
      fileName: file.name,
      installed: false,
      issues: [],
      phase: "validating",
    }));
    try {
      const candidate = await parseWebThemePackage(file);
      if (operationRef.current !== operation) return;
      setImportState((current) => {
        const blocker = importIdentityBlocker(current, candidate, themes);
        return {
          ...current,
          candidate,
          issues: blocker ? [blocker] : [],
          phase: "review",
        };
      });
    } catch (error) {
      if (operationRef.current !== operation) return;
      setImportState((current) => ({
        ...current,
        candidate: undefined,
        issues: packageIssues(error),
        phase: "choose",
      }));
    }
  };

  const publish = async (): Promise<void> => {
    const candidate = importState.candidate;
    if (!candidate || importState.issues.length > 0 || importState.installed) return;
    setImportState((current) => ({ ...current, issues: [], phase: "publishing" }));
    try {
      await installThemePackage(candidate);
    } catch {
      setImportState((current) => ({
        ...current,
        issues: [localIssue("publish-failed")],
        phase: "review",
      }));
      return;
    }
    showToast({
      message: importState.mode === "reimport" ? t("Theme reimported") : t("Theme imported"),
      scope: `theme:package:${candidate.manifest.id}`,
      tone: "success",
    });
    if (importState.mode === "import" && importState.useAfterImport) {
      try {
        await setFixedTheme(candidate.manifest.id);
      } catch {
        setImportState((current) => ({
          ...current,
          installed: true,
          issues: [localIssue("apply-failed")],
          phase: "installed-warning",
        }));
        return;
      }
    }
    closeImport();
  };

  const setUseAfterImport = (value: boolean): void => {
    setImportState((current) => ({ ...current, useAfterImport: value }));
  };

  const openInstalledPreview = async (
    theme: RegisteredTheme,
    trigger?: HTMLButtonElement | null,
  ): Promise<void> => {
    previewReturnFocusRef.current = trigger ?? null;
    revokePreviewUrl(previewUrlRef);
    const target = registeredThemePreviewTarget(theme);
    setPreviewState({ loading: theme.source !== "built-in", open: true, target });
    if (theme.source === "built-in") return;
    try {
      const storedPackage = await readThemePackage(theme.manifest.id);
      const previewUrl = storedPackage?.preview ? URL.createObjectURL(storedPackage.preview.blob) : undefined;
      previewUrlRef.current = previewUrl;
      setPreviewState({
        loading: false,
        open: true,
        package: storedPackage,
        ...(previewUrl ? { previewUrl } : {}),
        target,
      });
    } catch {
      setPreviewState({
        error: t("Installed theme details could not be loaded."),
        loading: false,
        open: true,
        target,
      });
    }
  };

  const openCandidatePreview = (trigger?: HTMLButtonElement | null): void => {
    const candidate = importState.candidate;
    if (!candidate) return;
    previewReturnFocusRef.current = trigger ?? null;
    revokePreviewUrl(previewUrlRef);
    const previewUrl = candidate.preview ? URL.createObjectURL(candidate.preview.blob) : undefined;
    previewUrlRef.current = previewUrl;
    setPreviewState({
      loading: false,
      open: true,
      package: candidate,
      ...(previewUrl ? { previewUrl } : {}),
      target: candidateThemePreviewTarget(candidate.manifest),
    });
  };

  const closePreview = (): void => {
    revokePreviewUrl(previewUrlRef);
    setPreviewState({ loading: false, open: false });
  };

  const openDelete = (theme: RegisteredTheme, trigger?: HTMLButtonElement | null): void => {
    deleteReturnFocusRef.current = trigger ?? null;
    setDeleteState({
      busy: false,
      target: { id: theme.manifest.id, name: theme.manifest.name },
    });
  };

  const openRepairDelete = (repair: ThemePackageRepairItem, trigger?: HTMLButtonElement | null): void => {
    deleteReturnFocusRef.current = trigger ?? null;
    setDeleteState({
      busy: false,
      target: { id: repair.themeId, name: repair.displayName },
    });
  };

  const closeDelete = (): void => {
    if (!deleteState.busy) setDeleteState({ busy: false });
  };

  const confirmDelete = async (): Promise<void> => {
    const target = deleteState.target;
    if (!target) return;
    setDeleteState({ busy: true, target });
    try {
      await removeTheme(target.id);
      showToast({
        message: t("Theme deleted"),
        scope: `theme:package:${target.id}`,
        tone: "success",
      });
      setDeleteState({ busy: false });
    } catch {
      setDeleteState({ busy: false, error: localIssue("delete-failed"), target });
    }
  };

  return {
    closeDelete,
    closeImport,
    closePreview,
    confirmDelete,
    deleteReturnFocusRef,
    deleteState,
    importReturnFocusRef,
    importState,
    loadFile,
    openCandidatePreview,
    openDelete,
    openImport,
    openInstalledPreview,
    openRepairDelete,
    openRepairReimport,
    openReimport,
    previewReturnFocusRef,
    previewState,
    publish,
    setUseAfterImport,
  } as const;
}

function importIdentityBlocker(
  state: ThemeImportDialogState,
  candidate: ParsedWebThemePackage,
  themes: readonly RegisteredTheme[],
): LingThemePackageIssue | undefined {
  if (state.mode === "reimport" && candidate.manifest.id !== state.targetThemeId) {
    return localIssue("reimport-id-mismatch");
  }
  if (state.mode === "import" && themes.some((theme) => theme.manifest.id === candidate.manifest.id)) {
    return localIssue("theme-already-installed");
  }
  return undefined;
}

function packageIssues(error: unknown): readonly LingThemePackageIssue[] {
  if (
    typeof error === "object"
    && error !== null
    && "issues" in error
    && Array.isArray((error as { issues?: unknown }).issues)
  ) return (error as { issues: readonly LingThemePackageIssue[] }).issues;
  return [localIssue("invalid-archive")];
}

function localIssue(code: string): LingThemePackageIssue {
  return Object.freeze({ code, message: code, path: "$" });
}

function revokePreviewUrl(ref: MutableRefObject<string | undefined>): void {
  if (ref.current) URL.revokeObjectURL(ref.current);
  ref.current = undefined;
}
