import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTheme } from "../../../theme.js";
import {
  analyzeWebQuickThemeImage,
  compileTokenOnlyQuickTheme,
  putWebQuickThemeDraft,
  readWebQuickThemeDraft,
  type QuickThemeImageError,
  type WebQuickThemeDraftRecord,
} from "../../../shared/ui/theme/studio/index.js";
import {
  createQuickThemeState,
  quickThemeReducer,
  restoreQuickThemeState,
  type QuickThemeState,
} from "./quick-theme-state.js";

const ACTIVE_DRAFT_KEY = "ling-stack.quick-theme.active-draft.v1";

export interface QuickThemeStudioController {
  readonly canCompile: boolean;
  readonly canPublish: boolean;
  readonly dirty: boolean;
  readonly restoring: boolean;
  readonly sourcePreviewUrl?: string;
  readonly state: QuickThemeState;
  readonly analyzeFile: (file: File) => Promise<void>;
  readonly changeName: (name: string) => void;
  readonly changeScheme: (scheme: QuickThemeState["colorScheme"]) => void;
  readonly compile: () => void;
  readonly install: (apply: boolean) => Promise<boolean>;
  readonly removeSource: () => void;
}

export function useQuickThemeStudioController(): QuickThemeStudioController {
  const identityRef = useRef(createIdentity());
  const createdAtRef = useRef(new Date().toISOString());
  const analysisAbortRef = useRef<AbortController | undefined>(undefined);
  const nameRef = useRef("");
  const operationRef = useRef(0);
  const { installTheme, setFixedTheme, syncActiveTheme } = useTheme();
  const [state, dispatch] = useReducer(
    quickThemeReducer,
    identityRef.current,
    ({ draftId, themeId }) => createQuickThemeState({ draftId, themeId }),
  );
  const [restoring, setRestoring] = useState(true);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string>();
  nameRef.current = state.name;

  useEffect(() => {
    let cancelled = false;
    const activeDraftId = readActiveDraftId();
    if (!activeDraftId) {
      setRestoring(false);
      return () => { cancelled = true; };
    }
    void readWebQuickThemeDraft(activeDraftId)
      .then((stored) => {
        if (cancelled || !stored) return;
        createdAtRef.current = stored.createdAt;
        identityRef.current = { draftId: stored.id, themeId: stored.themeId };
        const source = stored.source && stored.sourceBlob && stored.analysis
          ? { ...stored.source, analysis: stored.analysis, blob: stored.sourceBlob }
          : undefined;
        dispatch({
          type: "draft-restored",
          state: restoreQuickThemeState({
            analysis: stored.analysis,
            artworkIntensity: stored.artworkIntensity,
            colorScheme: stored.colorScheme,
            draftId: stored.id,
            name: stored.name,
            presentationProfileId: "ling-standard",
            revision: stored.revision,
            source,
            themeId: stored.themeId,
          }),
        });
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    operationRef.current += 1;
    analysisAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (restoring) return undefined;
    const timeout = globalThis.setTimeout(() => {
      void persistQuickThemeDraft(state, createdAtRef.current).catch(() => undefined);
    }, 250);
    return () => globalThis.clearTimeout(timeout);
  }, [restoring, state.analysis, state.artworkIntensity, state.colorScheme, state.draftId, state.name, state.presentationProfileId, state.revision, state.source, state.themeId]);

  useEffect(() => {
    if (!state.source) {
      setSourcePreviewUrl(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(state.source.blob);
    setSourcePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state.source]);

  const analyzeFile = useCallback(async (file: File): Promise<void> => {
    if (restoring) return;
    analysisAbortRef.current?.abort();
    const abortController = new AbortController();
    analysisAbortRef.current = abortController;
    const operationId = operationRef.current + 1;
    operationRef.current = operationId;
    dispatch({ type: "source-started", operationId });
    try {
      const analyzed = await analyzeWebQuickThemeImage(file, abortController.signal);
      if (operationId !== operationRef.current) return;
      const suggestedScheme = analyzed.analysis.averageLuminance < 0.38 ? "dark" : "light";
      if (!nameRef.current.trim()) {
        const suggestedName = fileBaseName(analyzed.displayName);
        nameRef.current = suggestedName;
        dispatch({ type: "name-changed", name: suggestedName });
      }
      dispatch({
        type: "source-ready",
        operationId,
        source: { ...analyzed, analysis: analyzed.analysis, blob: file },
        suggestedScheme,
        suggestedProfileId: "ling-standard",
      });
    } catch (error) {
      if (operationId !== operationRef.current) return;
      dispatch({
        type: "source-failed",
        operationId,
        issue: readImageIssue(error),
      });
    } finally {
      if (analysisAbortRef.current === abortController) analysisAbortRef.current = undefined;
    }
  }, [restoring]);

  const changeName = useCallback((name: string): void => {
    if (restoring) return;
    nameRef.current = name;
    dispatch({ type: "name-changed", name });
  }, [restoring]);

  const removeSource = useCallback((): void => {
    if (restoring) return;
    operationRef.current += 1;
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = undefined;
    dispatch({ type: "source-removed" });
  }, [restoring]);

  const compile = useCallback((): void => {
    if (!state.source || !state.name.trim()) {
      dispatch({
        type: "compile-failed",
        issue: {
          code: state.source ? "name-required" : "source-required",
          message: state.source ? "Enter a theme name." : "Choose an image first.",
        },
      });
      return;
    }
    dispatch({ type: "compile-started" });
    try {
      dispatch({
        type: "compile-ready",
        candidate: compileTokenOnlyQuickTheme({
          analysis: state.source.analysis,
          colorScheme: state.colorScheme,
          createdAt: new Date().toISOString(),
          name: state.name,
          themeId: state.themeId,
        }),
      });
    } catch (error) {
      dispatch({
        type: "compile-failed",
        issue: { code: "compile-failed", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, [state.colorScheme, state.name, state.source, state.themeId]);

  const install = useCallback(async (apply: boolean): Promise<boolean> => {
    const candidate = state.compiled;
    if (!candidate?.readyToPublish) return false;
    dispatch({ type: "publish-started" });
    try {
      await persistQuickThemeDraft(state, createdAtRef.current);
      await installTheme(candidate.manifest);
      if (apply) {
        await setFixedTheme(candidate.manifest.id);
        await syncActiveTheme(candidate.manifest.id);
      }
      dispatch({ type: "installed" });
      return true;
    } catch (error) {
      dispatch({
        type: "compile-failed",
        issue: { code: "publish-failed", message: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  }, [installTheme, setFixedTheme, state.compiled, syncActiveTheme]);

  return useMemo(() => ({
    analyzeFile,
    canCompile: Boolean(state.source && state.name.trim()) && !restoring && !busy(state),
    canPublish: Boolean(state.compiled?.readyToPublish) && !restoring && !busy(state),
    changeName,
    changeScheme: (colorScheme: QuickThemeState["colorScheme"]) => {
      if (!restoring) dispatch({ type: "scheme-changed", colorScheme });
    },
    compile,
    dirty: state.stage !== "installed" && Boolean(state.source || state.name.trim()),
    install,
    removeSource,
    restoring,
    sourcePreviewUrl,
    state,
  }), [analyzeFile, changeName, compile, install, removeSource, restoring, sourcePreviewUrl, state]);
}

function createIdentity(): { readonly draftId: string; readonly themeId: string } {
  const suffix = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 20) || Date.now().toString(36);
  return { draftId: `quick-draft-${suffix}`, themeId: `quick-theme-${suffix}` };
}

function busy(state: QuickThemeState): boolean {
  return state.stage === "validating" || state.stage === "analyzing" || state.stage === "compiling" || state.stage === "publishing";
}

function fileBaseName(name: string): string {
  return name.replace(/\.(png|jpe?g|webp)$/iu, "").trim().slice(0, 80) || "Quick theme";
}

function readImageIssue(error: unknown): NonNullable<QuickThemeState["issue"]> {
  const issue = (error as QuickThemeImageError | undefined)?.issue;
  return issue ?? { code: "analysis-failed", message: error instanceof Error ? error.message : String(error) };
}

function sourceMetadata(source: NonNullable<QuickThemeState["source"]>) {
  return {
    byteLength: source.byteLength,
    checksumSha256: source.checksumSha256,
    displayName: source.displayName,
    height: source.height,
    mimeType: source.mimeType,
    width: source.width,
  } as const;
}

async function persistQuickThemeDraft(state: QuickThemeState, createdAt: string): Promise<void> {
  const draft: WebQuickThemeDraftRecord = {
    ...(state.analysis ? { analysis: state.analysis } : {}),
    artworkIntensity: "subtle",
    colorScheme: state.colorScheme,
    createdAt,
    id: state.draftId,
    name: state.name,
    presentationProfileId: "ling-standard",
    revision: state.revision,
    ...(state.source ? { source: sourceMetadata(state.source) } : {}),
    themeId: state.themeId,
    updatedAt: new Date().toISOString(),
  };
  await putWebQuickThemeDraft({
    draft,
    ...(state.source ? { sourceBlob: state.source.blob } : {}),
  });
  writeActiveDraftId(state.draftId);
}

function readActiveDraftId(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_DRAFT_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeActiveDraftId(draftId: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_DRAFT_KEY, draftId);
  } catch {
    // The editor remains usable when browser storage is restricted.
  }
}
