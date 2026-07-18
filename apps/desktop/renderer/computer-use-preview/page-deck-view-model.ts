import type {
  ComputerUsePipPagePresentationState,
  ComputerUsePipRendererSnapshot,
} from "../../shared/desktop-capabilities.js";

export interface ComputerUsePipResidentPageViewModel {
  readonly pageId: string;
  readonly targetLabel: string;
  readonly runtimeStatus: ComputerUsePipRendererSnapshot["runtimeStatus"];
  readonly presentationState: ComputerUsePipPagePresentationState;
  readonly position: number;
  readonly count: number;
  readonly active: boolean;
  readonly requested: boolean;
}

export interface ComputerUsePipAvailablePageViewModel {
  readonly pageId: string;
  readonly targetLabel: string;
  readonly runtimeStatus: ComputerUsePipRendererSnapshot["runtimeStatus"];
  readonly resident: boolean;
  readonly active: boolean;
}

export interface ComputerUsePipPageDeckViewModel {
  readonly activePageId: string;
  readonly requestedPageId?: string;
  readonly residentPages: readonly ComputerUsePipResidentPageViewModel[];
  readonly inactivePages: readonly ComputerUsePipResidentPageViewModel[];
  readonly availablePages: readonly ComputerUsePipAvailablePageViewModel[];
  readonly showChrome: boolean;
}

export function createComputerUsePipPageDeckViewModel(
  snapshot: ComputerUsePipRendererSnapshot,
): ComputerUsePipPageDeckViewModel | undefined {
  const deck = snapshot.deck;
  if (!deck?.activePageId) {
    return undefined;
  }
  const residentPages = deck.pages.map((page, index) => ({
    ...page,
    position: index + 1,
    count: deck.pages.length,
    active: page.pageId === deck.activePageId,
    requested: page.pageId === deck.requestedPageId,
  }));
  const residentIds = new Set(residentPages.map((page) => page.pageId));
  const availablePages = deck.availablePages.map((page) => ({
    ...page,
    resident: page.resident && residentIds.has(page.pageId),
    active: page.pageId === deck.activePageId,
  }));
  return {
    activePageId: deck.activePageId,
    ...(deck.requestedPageId ? { requestedPageId: deck.requestedPageId } : {}),
    residentPages,
    inactivePages: residentPages.filter((page) => !page.active),
    availablePages,
    showChrome: residentPages.length > 1 || availablePages.length > residentPages.length,
  };
}
