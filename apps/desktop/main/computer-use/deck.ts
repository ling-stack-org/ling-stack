import type { ComputerUsePreviewProjection } from "@ling-stack/contracts";
import type { ComputerUsePipSurfaceKind } from "../../shared/desktop-capabilities.js";
import { selectComputerUsePipDeckProjections } from "./deck-selectors.js";

export { selectComputerUsePipDeckProjections } from "./deck-selectors.js";
export type { ComputerUsePipSurfaceKind } from "../../shared/desktop-capabilities.js";

export const COMPUTER_USE_PIP_MAX_RESIDENT_PAGES = 5;

export interface ComputerUsePipDeckScope {
  readonly workspaceId: string;
  readonly surfaceKind: ComputerUsePipSurfaceKind;
  readonly ownerId: string;
}

export type ComputerUsePipPagePresentationState =
  | "inactive"
  | "activating"
  | "active";

export interface ComputerUsePipPageState {
  readonly pageId: string;
  readonly sessionId: string;
  readonly presentationState: ComputerUsePipPagePresentationState;
  readonly lastActivatedAtMs: number;
}

export interface ComputerUsePipDeckState {
  readonly scope: ComputerUsePipDeckScope;
  readonly availablePageIds: readonly string[];
  readonly pages: readonly ComputerUsePipPageState[];
  readonly dismissedPageIds: readonly string[];
  readonly activePageId?: string;
  readonly requestedPageId?: string;
  readonly switchGeneration: number;
}

export interface ComputerUsePipDeckReconcileInput {
  readonly state?: ComputerUsePipDeckState;
  readonly scope: ComputerUsePipDeckScope;
  readonly projections: readonly ComputerUsePreviewProjection[];
  readonly nowMs: number;
}

export interface ComputerUsePipDeckSwitchRequest {
  readonly state: ComputerUsePipDeckState;
  readonly generation: number;
  readonly pageId: string;
  readonly evictedPageId?: string;
}

export function createComputerUsePipDeckState(
  scope: ComputerUsePipDeckScope,
): ComputerUsePipDeckState {
  return {
    scope,
    availablePageIds: [],
    pages: [],
    dismissedPageIds: [],
    switchGeneration: 0,
  };
}

export function computerUsePipPageId(sessionId: string): string {
  return sessionId;
}

export function computerUsePipDeckScopesEqual(
  left: ComputerUsePipDeckScope,
  right: ComputerUsePipDeckScope,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.surfaceKind === right.surfaceKind
    && left.ownerId === right.ownerId;
}

export function reconcileComputerUsePipDeck(
  input: ComputerUsePipDeckReconcileInput,
): ComputerUsePipDeckState {
  const eligible = selectComputerUsePipDeckProjections({
    scope: input.scope,
    projections: input.projections,
  });
  const availablePageIds = eligible.map((projection) => computerUsePipPageId(projection.sessionId));
  const availableSet = new Set(availablePageIds);
  const scopeChanged = !input.state || !computerUsePipDeckScopesEqual(input.state.scope, input.scope);
  const previous = scopeChanged ? createComputerUsePipDeckState(input.scope) : input.state;
  const dismissedPageIds = previous.dismissedPageIds.filter((pageId) => availableSet.has(pageId));
  const dismissedSet = new Set(dismissedPageIds);
  const retainedPages = previous.pages.filter((page) =>
    availableSet.has(page.pageId) && !dismissedSet.has(page.pageId),
  );
  const residentIds = new Set(retainedPages.map((page) => page.pageId));

  const pages = [...retainedPages];
  for (const pageId of availablePageIds) {
    if (pages.length >= COMPUTER_USE_PIP_MAX_RESIDENT_PAGES) {
      break;
    }
    if (residentIds.has(pageId) || dismissedSet.has(pageId)) {
      continue;
    }
    pages.push({
      pageId,
      sessionId: pageId,
      presentationState: "inactive",
      lastActivatedAtMs: 0,
    });
    residentIds.add(pageId);
  }

  let activePageId: string | undefined = previous.activePageId && residentIds.has(previous.activePageId)
    ? previous.activePageId
    : pages[0]?.pageId;
  let requestedPageId: string | undefined = previous.requestedPageId && residentIds.has(previous.requestedPageId)
    ? previous.requestedPageId
    : undefined;

  if (requestedPageId === activePageId) {
    requestedPageId = undefined;
  }

  const normalizedPages = normalizePagePresentation(pages, activePageId, requestedPageId, input.nowMs);
  activePageId = normalizedPages.find((page) => page.presentationState === "active")?.pageId;

  return {
    scope: input.scope,
    availablePageIds,
    pages: normalizedPages,
    dismissedPageIds,
    ...(activePageId ? { activePageId } : {}),
    ...(requestedPageId ? { requestedPageId } : {}),
    switchGeneration: previous.switchGeneration,
  };
}

export function requestComputerUsePipDeckPage(
  state: ComputerUsePipDeckState,
  pageId: string,
  nowMs: number,
): ComputerUsePipDeckSwitchRequest | undefined {
  if (!state.availablePageIds.includes(pageId)) {
    return undefined;
  }

  const requestedPage = state.pages.find((page) => page.pageId === pageId) ?? {
    pageId,
    sessionId: pageId,
    presentationState: "inactive" as const,
    lastActivatedAtMs: 0,
  };
  const pages = [...state.pages];
  let evictedPageId: string | undefined;

  if (!state.pages.some((page) => page.pageId === pageId)) {
    if (pages.length >= COMPUTER_USE_PIP_MAX_RESIDENT_PAGES) {
      const evictionIndex = findInactiveLruIndex(pages, state.activePageId);
      if (evictionIndex < 0) {
        return undefined;
      }
      evictedPageId = pages[evictionIndex]?.pageId;
      pages.splice(evictionIndex, 1);
    }
    pages.push(requestedPage);
  }

  if (pages.length > COMPUTER_USE_PIP_MAX_RESIDENT_PAGES) {
    const evictionIndex = findInactiveLruIndex(pages, state.activePageId);
    if (evictionIndex < 0) {
      return undefined;
    }
    evictedPageId = pages[evictionIndex]?.pageId;
    pages.splice(evictionIndex, 1);
  }

  const generation = state.switchGeneration + 1;
  const normalizedPages = normalizePagePresentation(
    pages,
    state.activePageId,
    pageId === state.activePageId ? undefined : pageId,
    nowMs,
  );
  const dismissedPageIds = state.dismissedPageIds.filter((candidate) => candidate !== pageId);
  const baseState = withoutActiveRequest(state);
  const nextState: ComputerUsePipDeckState = {
    ...baseState,
    pages: normalizedPages,
    dismissedPageIds,
    ...(state.activePageId ? { activePageId: state.activePageId } : {}),
    ...(pageId === state.activePageId ? {} : { requestedPageId: pageId }),
    switchGeneration: generation,
  };

  return { state: nextState, generation, pageId, ...(evictedPageId ? { evictedPageId } : {}) };
}

export function commitComputerUsePipDeckPage(
  state: ComputerUsePipDeckState,
  input: { readonly pageId: string; readonly generation: number; readonly nowMs: number },
): ComputerUsePipDeckState {
  if (
    state.switchGeneration !== input.generation
    || state.requestedPageId !== input.pageId
    || !state.pages.some((page) => page.pageId === input.pageId)
  ) {
    return state;
  }
  const page = state.pages.find((candidate) => candidate.pageId === input.pageId)!;
  const reordered = [
    { ...page, lastActivatedAtMs: input.nowMs },
    ...state.pages.filter((candidate) => candidate.pageId !== input.pageId),
  ];
  const baseState = withoutActiveRequest(state);
  return {
    ...baseState,
    pages: normalizePagePresentation(reordered, input.pageId, undefined, input.nowMs),
    activePageId: input.pageId,
    switchGeneration: state.switchGeneration,
  };
}

export function cancelComputerUsePipDeckPageSwitch(
  state: ComputerUsePipDeckState,
  input: { readonly generation: number; readonly nowMs: number },
): ComputerUsePipDeckState {
  if (state.switchGeneration !== input.generation || !state.requestedPageId) {
    return state;
  }
  const baseState = withoutActiveRequest(state);
  return {
    ...baseState,
    pages: normalizePagePresentation(state.pages, state.activePageId, undefined, input.nowMs),
    ...(state.activePageId ? { activePageId: state.activePageId } : {}),
  };
}

export function dismissComputerUsePipDeckPage(
  state: ComputerUsePipDeckState,
  pageId: string,
  nowMs: number,
): ComputerUsePipDeckState {
  if (!state.availablePageIds.includes(pageId)) {
    return state;
  }
  const pages = state.pages.filter((page) => page.pageId !== pageId);
  const nextActivePageId = state.activePageId === pageId
    ? pages[0]?.pageId
    : state.activePageId;
  const requestedPageId = state.requestedPageId === pageId ? undefined : state.requestedPageId;
  const nextPages = pages.map((page) => page.pageId === nextActivePageId && state.activePageId === pageId
    ? { ...page, lastActivatedAtMs: nowMs }
    : page);
  const baseState = withoutActiveRequest(state);
  return {
    ...baseState,
    pages: normalizePagePresentation(nextPages, nextActivePageId, requestedPageId, nowMs),
    dismissedPageIds: [...new Set([...state.dismissedPageIds, pageId])],
    ...(nextActivePageId ? { activePageId: nextActivePageId } : {}),
    ...(requestedPageId ? { requestedPageId } : {}),
    switchGeneration: state.switchGeneration + (state.requestedPageId === pageId ? 1 : 0),
  };
}

function normalizePagePresentation(
  pages: readonly ComputerUsePipPageState[],
  activePageId: string | undefined,
  requestedPageId: string | undefined,
  nowMs: number,
): readonly ComputerUsePipPageState[] {
  return pages.map((page) => {
    const presentationState = page.pageId === requestedPageId
      ? "activating"
      : page.pageId === activePageId
        ? "active"
        : "inactive";
    return {
      ...page,
      presentationState,
      lastActivatedAtMs: presentationState === "active" && page.lastActivatedAtMs === 0
        ? nowMs
        : page.lastActivatedAtMs,
    };
  });
}

function findInactiveLruIndex(
  pages: readonly ComputerUsePipPageState[],
  activePageId: string | undefined,
): number {
  let candidateIndex = -1;
  let candidateActivatedAt = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!page || page.pageId === activePageId) {
      continue;
    }
    if (page.lastActivatedAtMs <= candidateActivatedAt) {
      candidateIndex = index;
      candidateActivatedAt = page.lastActivatedAtMs;
    }
  }
  return candidateIndex;
}

function withoutActiveRequest(
  state: ComputerUsePipDeckState,
): Omit<ComputerUsePipDeckState, "activePageId" | "requestedPageId"> {
  const { activePageId: _activePageId, requestedPageId: _requestedPageId, ...rest } = state;
  return rest;
}
