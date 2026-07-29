import type {
  CompiledLingThemeCandidate,
  LingColorScheme,
  LingPresentationProfileId,
  ThemeImageAnalysis,
} from "../../../shared/ui/index.js";
import type {
  QuickThemeImageIssue,
  QuickThemeDraftSourceMetadata,
} from "../../../shared/ui/theme/studio/index.js";

export type QuickThemeStage =
  | "analyzing"
  | "blocked"
  | "compiling"
  | "draft-ready"
  | "empty"
  | "installed"
  | "preview-ready"
  | "publishing"
  | "validating";

export interface QuickThemeSourceState extends QuickThemeDraftSourceMetadata {
  readonly analysis: ThemeImageAnalysis;
  readonly blob: Blob;
}

export interface QuickThemeState {
  readonly analysis?: ThemeImageAnalysis;
  readonly artworkIntensity: "balanced" | "strong" | "subtle";
  readonly colorScheme: LingColorScheme;
  readonly compiled?: CompiledLingThemeCandidate;
  readonly draftId: string;
  readonly issue?: QuickThemeImageIssue | { readonly code: string; readonly message: string };
  readonly name: string;
  readonly operationId: number;
  readonly presentationProfileId: LingPresentationProfileId;
  readonly revision: number;
  readonly source?: QuickThemeSourceState;
  readonly stage: QuickThemeStage;
  readonly themeId: string;
}

export type QuickThemeAction =
  | { readonly type: "source-started"; readonly operationId: number }
  | {
      readonly type: "source-ready";
      readonly operationId: number;
      readonly source: QuickThemeSourceState;
      readonly suggestedScheme: LingColorScheme;
      readonly suggestedProfileId: LingPresentationProfileId;
    }
  | { readonly type: "source-failed"; readonly issue: QuickThemeState["issue"]; readonly operationId: number }
  | { readonly type: "source-removed" }
  | { readonly type: "name-changed"; readonly name: string }
  | { readonly type: "scheme-changed"; readonly colorScheme: LingColorScheme }
  | { readonly type: "profile-changed"; readonly profileId: LingPresentationProfileId }
  | { readonly type: "intensity-changed"; readonly intensity: QuickThemeState["artworkIntensity"] }
  | { readonly type: "compile-started" }
  | { readonly type: "compile-ready"; readonly candidate: CompiledLingThemeCandidate }
  | { readonly type: "compile-failed"; readonly issue: NonNullable<QuickThemeState["issue"]> }
  | { readonly type: "publish-started" }
  | { readonly type: "installed" }
  | { readonly type: "issue-cleared" };

export function createQuickThemeState(input: {
  readonly draftId: string;
  readonly themeId: string;
}): QuickThemeState {
  return Object.freeze({
    artworkIntensity: "balanced",
    colorScheme: "light",
    draftId: input.draftId,
    name: "",
    operationId: 0,
    presentationProfileId: "ling-standard",
    revision: 0,
    stage: "empty",
    themeId: input.themeId,
  });
}

export function quickThemeReducer(state: QuickThemeState, action: QuickThemeAction): QuickThemeState {
  switch (action.type) {
    case "source-started":
      return freezeState({
        ...state,
        issue: undefined,
        operationId: action.operationId,
        stage: "validating",
      });
    case "source-ready":
      if (action.operationId !== state.operationId) return state;
      return freezeState({
        ...state,
        analysis: action.source.analysis,
        colorScheme: action.suggestedScheme,
        compiled: undefined,
        issue: undefined,
        presentationProfileId: action.suggestedProfileId,
        revision: state.revision + 1,
        source: action.source,
        stage: "draft-ready",
      });
    case "source-failed":
      if (action.operationId !== state.operationId) return state;
      return freezeState({ ...state, issue: action.issue, stage: state.source ? "draft-ready" : "blocked" });
    case "source-removed":
      return freezeState({
        ...state,
        analysis: undefined,
        compiled: undefined,
        issue: undefined,
        revision: state.revision + 1,
        source: undefined,
        stage: "empty",
      });
    case "name-changed":
      return freezeState({ ...state, compiled: undefined, issue: undefined, name: action.name, stage: editableStage(state) });
    case "scheme-changed":
      return invalidateCompiled(state, { colorScheme: action.colorScheme });
    case "profile-changed":
      return invalidateCompiled(state, { presentationProfileId: action.profileId });
    case "intensity-changed":
      return invalidateCompiled(state, { artworkIntensity: action.intensity });
    case "compile-started":
      return freezeState({ ...state, compiled: undefined, issue: undefined, stage: "compiling" });
    case "compile-ready":
      return freezeState({
        ...state,
        compiled: action.candidate,
        issue: action.candidate.readyToPublish
          ? undefined
          : action.candidate.verification.blockers[0] ?? { code: "compile-blocked", message: "Theme verification failed." },
        stage: action.candidate.readyToPublish ? "preview-ready" : "blocked",
      });
    case "compile-failed":
      return freezeState({ ...state, compiled: undefined, issue: action.issue, stage: "blocked" });
    case "publish-started":
      return freezeState({ ...state, issue: undefined, stage: "publishing" });
    case "installed":
      return freezeState({ ...state, issue: undefined, stage: "installed" });
    case "issue-cleared":
      return freezeState({ ...state, issue: undefined, stage: editableStage(state) });
  }
}

function invalidateCompiled(
  state: QuickThemeState,
  patch: Partial<Pick<QuickThemeState, "artworkIntensity" | "colorScheme" | "presentationProfileId">>,
): QuickThemeState {
  return freezeState({
    ...state,
    ...patch,
    compiled: undefined,
    issue: undefined,
    stage: editableStage(state),
  });
}

function editableStage(state: QuickThemeState): QuickThemeStage {
  return state.source ? "draft-ready" : "empty";
}

function freezeState(state: QuickThemeState): QuickThemeState {
  return Object.freeze(state);
}
