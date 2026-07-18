import type {
  ComputerUsePreviewReleaseMediaRequest,
  ComputerUsePreviewReleaseMediaResult,
  ComputerUsePipRendererSnapshot,
} from "../../shared/desktop-capabilities.js";
import {
  createComputerUsePreviewViewModel,
  type ComputerUsePreviewActionId,
  type ComputerUsePreviewActionViewModel,
  type ComputerUsePreviewStopCommandState,
} from "./preview-view-model.js";
import {
  createComputerUsePipPageDeckViewModel,
  type ComputerUsePipPageDeckViewModel,
  type ComputerUsePipResidentPageViewModel,
} from "./page-deck-view-model.js";
import {
  createComputerUsePreviewTranslator,
  normalizeComputerUsePreviewLocale,
  type ComputerUsePreviewTranslate,
} from "./messages.js";
import { subscribeWithInitialRead } from "../../shared/initial-state-subscription.js";
import "@fontsource-variable/inter";
import "./styles.css";

const root = document.getElementById("preview-root");
if (!root) {
  throw new Error("Computer Use preview root was not found");
}
const previewRoot = root;

const fallbackSnapshot: ComputerUsePipRendererSnapshot = {
  sessionId: "preview_fake_session_01",
  conversationId: "preview_fake_conversation_01",
  locale: "en-US",
  targetLabel: "Browser task",
  runtimeStatus: "running",
  sourceStatus: "live",
  sourceKind: "fake",
  sourceRevision: 1,
  sourceGeneration: 1,
  visibilityIntent: "auto",
  frameReady: true,
  aspectRatio: 1.6,
  canStop: true,
  canOpenSettings: false,
};
const RENDERER_COMMAND_TIMEOUT_MS = 10_000;
const PAGE_THUMBNAIL_WIDTH = 320;
const PAGE_THUMBNAIL_MAX_HEIGHT = 240;
const PAGE_THUMBNAIL_MAX_COUNT = 4;
const PAGE_THUMBNAIL_MEMORY_BUDGET_BYTES = 20 * 1024 * 1024;

interface StoppedTrackBatch {
  readonly tracks: readonly MediaStreamTrack[];
  readonly releasedTracks: readonly MediaStreamTrack[];
}

interface MediaAcquisitionSettlement {
  readonly stream?: MediaStream;
  readonly stoppedTracks: StoppedTrackBatch;
  readonly error?: unknown;
}

interface PendingMediaAcquisition {
  readonly mediaKey: string;
  readonly generation: number;
  readonly completion: Promise<MediaAcquisitionSettlement>;
}

interface MediaReleaseRecord {
  readonly mediaKey: string;
  readonly generationBoundary: number;
  readonly completion: Promise<ComputerUsePreviewReleaseMediaResult>;
}

let snapshot = fallbackSnapshot;
let currentMediaKey: string | undefined;
let currentStream: MediaStream | undefined;
let mediaRequestGeneration = 0;
const pendingMediaAcquisitions = new Map<number, PendingMediaAcquisition>();
const mediaReleaseRecords = new Map<string, MediaReleaseRecord>();
let menuOpen = false;
let viewAllOpen = false;
let pageCommandFailed = false;
const pageThumbnails = new Map<string, HTMLCanvasElement>();
let focusAfterRender:
  | { readonly kind: "menu" }
  | { readonly kind: "more" }
  | { readonly kind: "action"; readonly actionId: ComputerUsePreviewActionId; readonly inMenu: boolean }
  | { readonly kind: "page"; readonly pageId: string; readonly control: "activate" | "close" }
  | { readonly kind: "view_all_item"; readonly pageId: string }
  | { readonly kind: "view_all" }
  | undefined;
let lastFrameActivityReportAt = 0;
let stopCommandState: ComputerUsePreviewStopCommandState = "idle";
let stopRequestSequence = 0;
let stopConvergenceTimeoutId: number | undefined;
let rendering = false;
const interactionState = { hover: false, focus: false };
const capabilities = window.lingComputerUsePreview;

render();
document.addEventListener("keydown", handleDocumentKeyDown);
document.addEventListener("pointerdown", handleDocumentPointerDown);
previewRoot.addEventListener("pointerenter", () => reportInteraction("hover", true));
previewRoot.addEventListener("pointerleave", () => reportInteraction("hover", false));
previewRoot.addEventListener("focusin", () => reportInteraction("focus", true));
previewRoot.addEventListener("focusout", handlePreviewFocusOut);
window.addEventListener("blur", () => reportInteraction("focus", false));
if (capabilities) {
  subscribeWithInitialRead({
    read: () => capabilities.getSnapshot(),
    subscribe: (listener) => capabilities.onSnapshotChanged(listener),
    onValue: applySnapshot,
  });
  capabilities.onReleaseMedia((request) => releaseMediaForRequest(request));
} else {
  void syncSource();
}

function applySnapshot(next: ComputerUsePipRendererSnapshot | undefined): void {
  const nextSnapshot = next ?? fallbackSnapshot;
  const sessionChanged = nextSnapshot.sessionId !== snapshot.sessionId;
  const switchingWithinDeck = Boolean(nextSnapshot.deck && snapshot.deck);
  if (nextSnapshot.deck?.requestedPageId && nextSnapshot.deck.activePageId === snapshot.sessionId && snapshot.frameReady) {
    captureActivePageThumbnail(snapshot.sessionId);
  }
  if (sessionChanged && !switchingWithinDeck) {
    menuOpen = false;
    viewAllOpen = false;
    focusAfterRender = undefined;
    resetStopCommandState(true);
  } else {
    // An explicit focus request from a page command or popover action wins over
    // the best-effort preservation of whatever focus happened to be active
    // while the snapshot was in flight.
    if (!focusAfterRender) {
      preserveCurrentFocus();
    }
    if (
      nextSnapshot.runtimeStatus === "stopping" ||
      nextSnapshot.runtimeStatus === "succeeded" ||
      nextSnapshot.runtimeStatus === "failed" ||
      nextSnapshot.runtimeStatus === "cancelled"
    ) {
      resetStopCommandState(true);
    }
  }
  snapshot = nextSnapshot;
  prunePageThumbnails(nextSnapshot);
  if (!nextSnapshot.deck) {
    viewAllOpen = false;
  }
  render();
  void syncSource();
}

function render(): void {
  rendering = true;
  const reusableVideo = currentStream && currentMediaKey === mediaKeyFor(snapshot)
    ? previewRoot.querySelector<HTMLVideoElement>(".preview-video")
    : undefined;
  const nextPreview = buildPreview(snapshot);
  if (reusableVideo) {
    nextPreview.querySelector<HTMLVideoElement>(".preview-video")?.replaceWith(reusableVideo);
  }
  previewRoot.replaceChildren(nextPreview);
  rendering = false;
  if (currentStream && currentMediaKey === mediaKeyFor(snapshot)) {
    attachCurrentStream();
  }
  if (focusAfterRender) {
    const focusTarget = focusAfterRender;
    focusAfterRender = undefined;
    window.setTimeout(() => {
      const selector = focusTarget.kind === "menu"
        ? ".preview-menu [role=\"menuitem\"]"
        : focusTarget.kind === "more"
        ? ".more-button"
        : focusTarget.kind === "view_all"
          ? ".page-deck-view-all"
          : focusTarget.kind === "view_all_item"
            ? `.page-deck-view-all-panel [data-page-activate="${cssEscape(focusTarget.pageId)}"]`
            : focusTarget.kind === "page"
              ? `[data-page-${focusTarget.control}="${cssEscape(focusTarget.pageId)}"]`
              : `${focusTarget.inMenu ? ".preview-menu " : ""}[data-action-id="${focusTarget.actionId}"]`;
      previewRoot.querySelector<HTMLElement>(selector)?.focus();
    }, 0);
  }
}

function buildPreview(value: ComputerUsePipRendererSnapshot): HTMLElement {
  const locale = normalizeComputerUsePreviewLocale(value.locale);
  const t = createComputerUsePreviewTranslator(locale);
  const viewModel = createComputerUsePreviewViewModel(value, { stopCommandState });
  const pageDeck = createComputerUsePipPageDeckViewModel(value);
  document.documentElement.lang = locale;
  document.title = t("windowTitle", { target: value.targetLabel, status: viewModel.label });
  const shell = document.createElement("section");
  shell.className = "preview-shell";
  shell.dataset.state = viewModel.state;
  shell.dataset.tone = viewModel.tone;
  shell.dataset.controls = viewModel.controlsPersistent ? "persistent" : "hover";
  shell.dataset.stopCommand = stopCommandState;
  shell.dataset.pageDeck = pageDeck?.showChrome ? "visible" : "single";
  shell.dataset.pageThumbnailCount = String(pageThumbnails.size);
  shell.dataset.pageThumbnailBytes = String(pageThumbnailMemoryBytes());
  shell.setAttribute("aria-label", t("previewLabel", { target: value.targetLabel }));

  if (pageDeck?.showChrome) {
    shell.append(buildPageDeckBackplates(pageDeck, t));
  }

  const frame = document.createElement("div");
  frame.className = "preview-frame";
  if (value.sourceKind === "display_media") {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", t("livePreviewLabel"));
    frame.append(video);
  } else {
    frame.innerHTML = `
      <div class="fake-page" aria-hidden="true">
        <div class="fake-toolbar"><i></i><i></i><i></i><span></span></div>
        <div class="fake-body"><aside></aside><article><b></b><b></b><b></b><b></b></article></div>
        <div class="fake-cursor"></div>
      </div>
    `;
  }
  if (
    pageDeck?.requestedPageId
    && pageDeck.activePageId !== value.sessionId
    && pageThumbnails.has(pageDeck.activePageId)
  ) {
    const frozen = clonePageThumbnail(pageDeck.activePageId);
    if (frozen) {
      frozen.className = "page-switch-frozen-thumbnail";
      frozen.setAttribute("aria-hidden", "true");
      frame.append(frozen);
    }
  }

  const overlay = document.createElement("div");
  overlay.className = `preview-status-overlay ${viewModel.overlayMode}`;
  overlay.setAttribute("role", viewModel.ariaLive === "assertive" ? "alert" : "status");
  overlay.setAttribute("aria-live", viewModel.ariaLive);
  overlay.setAttribute("aria-atomic", "true");
  const statusIcon = document.createElement("span");
  statusIcon.className = `preview-status-icon tone-${viewModel.tone}`;
  statusIcon.setAttribute("aria-hidden", "true");
  const statusCopy = document.createElement("span");
  statusCopy.className = "preview-status-copy";
  const statusLabel = document.createElement("strong");
  statusLabel.textContent = viewModel.label;
  statusCopy.append(statusLabel);
  if (viewModel.detail) {
    const detail = document.createElement("small");
    detail.textContent = viewModel.detail;
    statusCopy.append(detail);
  }
  if (viewModel.busy) {
    const busy = document.createElement("span");
    busy.className = "preview-status-spinner";
    busy.setAttribute("aria-label", t("inProgressLabel"));
    statusCopy.append(busy);
  }
  overlay.append(statusIcon, statusCopy);
  if (viewModel.overlayAction) {
    overlay.classList.add("has-action");
    overlay.append(actionButton(viewModel.overlayAction, "status-action"));
  }

  const header = document.createElement("header");
  header.className = "preview-header";
  const title = document.createElement("div");
  title.className = "preview-title";
  title.innerHTML = `<span class="live-dot tone-${viewModel.tone}"></span><strong></strong><small></small>`;
  title.querySelector("strong")!.textContent = value.targetLabel;
  title.querySelector("small")!.textContent = viewModel.label;

  const controls = document.createElement("div");
  controls.className = "preview-controls";
  controls.setAttribute("aria-label", t("previewActionsLabel"));
  for (const action of viewModel.primaryActions) {
    controls.append(actionButton(action, "primary-action"));
  }
  const moreButton = button(t("moreLabel"), toggleMore, "more-button");
  moreButton.setAttribute("aria-label", t("morePreviewActionsLabel"));
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", String(menuOpen));
  controls.append(moreButton);
  if (menuOpen) {
    controls.append(buildMenu(viewModel.menuActions, t));
  }
  header.append(title, controls);
  shell.append(frame, overlay, header);
  if (pageDeck?.showChrome) {
    shell.append(buildPageDeckChrome(pageDeck, t));
  }
  return shell;
}

function buildPageDeckBackplates(
  pageDeck: ComputerUsePipPageDeckViewModel,
  t: ComputerUsePreviewTranslate,
): HTMLElement {
  const backplates = document.createElement("div");
  backplates.className = "page-deck-backplates";
  backplates.setAttribute("role", "group");
  backplates.setAttribute("aria-label", t("pageDeckLabel"));
  pageDeck.inactivePages.slice(0, PAGE_THUMBNAIL_MAX_COUNT).forEach((page, index) => {
    const card = document.createElement("article");
    card.className = "page-deck-card";
    card.dataset.presentationState = page.presentationState;
    card.style.setProperty("--page-stack-index", String(index));

    const activate = button(
      page.requested
        ? t("activatingPageAction", { target: page.targetLabel })
        : t("activatePageAction", { target: page.targetLabel }),
      () => activateDeckPage(page.pageId),
      "page-deck-card-activate",
    );
    activate.dataset.pageActivate = page.pageId;
    activate.setAttribute("aria-label", pageAriaLabel(page, t));
    activate.append(pageThumbnailOrPlaceholder(page));
    const copy = document.createElement("span");
    copy.className = "page-deck-card-copy";
    const target = document.createElement("strong");
    target.textContent = page.targetLabel;
    const status = document.createElement("small");
    status.textContent = pageRuntimeStatusLabel(page.runtimeStatus, t);
    copy.append(target, status);
    activate.append(copy);

    const close = button(
      "×",
      () => closeDeckPage(page.pageId),
      "page-deck-card-close",
    );
    close.dataset.pageClose = page.pageId;
    close.setAttribute("aria-label", t("closePageAction", { target: page.targetLabel }));
    card.append(activate, close);
    backplates.append(card);
  });
  return backplates;
}

function buildPageDeckChrome(
  pageDeck: ComputerUsePipPageDeckViewModel,
  t: ComputerUsePreviewTranslate,
): HTMLElement {
  const chrome = document.createElement("div");
  chrome.className = "page-deck-chrome";
  const tabs = document.createElement("div");
  tabs.className = "page-deck-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("pageDeckLabel"));
  tabs.addEventListener("keydown", handlePageTabKeyDown);
  for (const page of pageDeck.residentPages) {
    const tab = button(
      page.targetLabel,
      () => activateDeckPage(page.pageId),
      `page-deck-tab${page.active ? " active" : ""}${page.requested ? " requested" : ""}`,
    );
    tab.dataset.pageActivate = page.pageId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(page.active));
    tab.setAttribute("aria-label", pageAriaLabel(page, t));
    tab.tabIndex = page.requested || (page.active && !pageDeck.requestedPageId) ? 0 : -1;
    tabs.append(tab);
  }

  const actions = document.createElement("div");
  actions.className = "page-deck-actions";
  const activePage = pageDeck.residentPages.find((page) => page.active);
  if (activePage) {
    const closeActive = button(
      "×",
      () => closeDeckPage(activePage.pageId),
      "page-deck-close-active",
    );
    closeActive.dataset.pageClose = activePage.pageId;
    closeActive.setAttribute("aria-label", t("closePageAction", { target: activePage.targetLabel }));
    actions.append(closeActive);
  }
  const viewAll = button(
    t("viewAllPagesAction", { count: pageDeck.availablePages.length }),
    toggleViewAllPages,
    "page-deck-view-all",
  );
  viewAll.setAttribute("aria-expanded", String(viewAllOpen));
  viewAll.setAttribute("aria-haspopup", "dialog");
  actions.append(viewAll);
  chrome.append(tabs, actions);

  if (pageCommandFailed) {
    const failure = document.createElement("span");
    failure.className = "page-deck-command-failure";
    failure.setAttribute("role", "alert");
    failure.textContent = t("failedLabel");
    chrome.append(failure);
  }
  if (viewAllOpen) {
    chrome.append(buildViewAllPages(pageDeck, t));
  }
  return chrome;
}

function buildViewAllPages(
  pageDeck: ComputerUsePipPageDeckViewModel,
  t: ComputerUsePreviewTranslate,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "page-deck-view-all-panel";
  panel.dataset.pageDeckViewAll = "true";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("availablePagesLabel"));
  for (const page of pageDeck.availablePages) {
    const row = document.createElement("div");
    row.className = "page-deck-view-all-row";
    row.dataset.resident = String(page.resident);
    const activate = button(
      page.targetLabel,
      () => activateDeckPage(page.pageId, true),
      "page-deck-view-all-item",
    );
    activate.dataset.pageActivate = page.pageId;
    activate.setAttribute("aria-current", page.active ? "page" : "false");
    const target = document.createElement("strong");
    target.textContent = page.targetLabel;
    const status = document.createElement("small");
    status.textContent = pageRuntimeStatusLabel(page.runtimeStatus, t);
    activate.replaceChildren(target, status);
    row.append(activate);
    if (page.resident) {
      const close = button("×", () => closeDeckPage(page.pageId), "page-deck-view-all-close");
      close.dataset.pageClose = page.pageId;
      close.setAttribute("aria-label", t("closePageAction", { target: page.targetLabel }));
      row.append(close);
    }
    panel.append(row);
  }
  return panel;
}

async function activateDeckPage(pageId: string, closeViewAll = false): Promise<void> {
  const current = window.lingComputerUsePreview;
  if (!current) {
    return;
  }
  const hadPageCommandFailure = pageCommandFailed;
  pageCommandFailed = false;
  if (closeViewAll) {
    viewAllOpen = false;
  }
  if (closeViewAll || hadPageCommandFailure) {
    focusAfterRender = { kind: "page", pageId, control: "activate" };
    render();
  }
  try {
    const result = await waitForRendererCommand(current.activatePage(pageId));
    if (!result.accepted) {
      pageCommandFailed = true;
      focusAfterRender = { kind: "page", pageId, control: "activate" };
      render();
    }
  } catch {
    pageCommandFailed = true;
    focusAfterRender = { kind: "page", pageId, control: "activate" };
    render();
  }
}

async function closeDeckPage(pageId: string): Promise<void> {
  const current = window.lingComputerUsePreview;
  if (!current) {
    return;
  }
  const pageDeck = createComputerUsePipPageDeckViewModel(snapshot);
  const nextPage = pageDeck?.residentPages.find((page) => page.pageId !== pageId);
  pageCommandFailed = false;
  focusAfterRender = nextPage
    ? { kind: "page", pageId: nextPage.pageId, control: "activate" }
    : { kind: "view_all" };
  try {
    const result = await waitForRendererCommand(current.closePage(pageId));
    if (!result.accepted) {
      pageCommandFailed = true;
      focusAfterRender = { kind: "page", pageId, control: "close" };
      render();
    }
  } catch {
    pageCommandFailed = true;
    focusAfterRender = { kind: "page", pageId, control: "close" };
    render();
  }
}

function toggleViewAllPages(): void {
  viewAllOpen = !viewAllOpen;
  if (viewAllOpen) {
    const firstPage = createComputerUsePipPageDeckViewModel(snapshot)?.availablePages[0];
    focusAfterRender = firstPage
      ? { kind: "view_all_item", pageId: firstPage.pageId }
      : { kind: "view_all" };
  } else {
    focusAfterRender = { kind: "view_all" };
  }
  render();
}

function pageAriaLabel(
  page: ComputerUsePipResidentPageViewModel,
  t: ComputerUsePreviewTranslate,
): string {
  return t("pagePositionLabel", {
    target: page.targetLabel,
    status: pageRuntimeStatusLabel(page.runtimeStatus, t),
    position: page.position,
    count: page.count,
  });
}

function pageRuntimeStatusLabel(
  status: ComputerUsePipRendererSnapshot["runtimeStatus"],
  t: ComputerUsePreviewTranslate,
): string {
  if (status === "failed") return t("failedLabel");
  if (status === "succeeded") return t("completedLabel");
  if (status === "cancelled") return t("stoppedLabel");
  if (status === "stopping") return t("stoppingLabel");
  if (status === "waiting_for_approval") return t("approvalRequiredLabel");
  if (status === "paused") return t("pausedLabel");
  if (status === "starting") return t("connectingLabel");
  return t("liveLabel");
}

function pageThumbnailOrPlaceholder(page: ComputerUsePipResidentPageViewModel): HTMLElement {
  const thumbnail = clonePageThumbnail(page.pageId);
  if (thumbnail) {
    thumbnail.className = "page-deck-card-thumbnail";
    thumbnail.setAttribute("aria-hidden", "true");
    return thumbnail;
  }
  const placeholder = document.createElement("span");
  placeholder.className = "page-deck-card-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = page.targetLabel.trim().slice(0, 1).toLocaleUpperCase() || "•";
  return placeholder;
}

function clonePageThumbnail(pageId: string): HTMLCanvasElement | undefined {
  const source = pageThumbnails.get(pageId);
  if (!source) {
    return undefined;
  }
  const clone = document.createElement("canvas");
  clone.width = source.width;
  clone.height = source.height;
  clone.getContext("2d")?.drawImage(source, 0, 0);
  return clone;
}

function buildMenu(
  actions: readonly ComputerUsePreviewActionViewModel[],
  t: ComputerUsePreviewTranslate,
): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "preview-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("previewMenuLabel"));
  for (const action of actions) {
    if (action.separatorBefore) {
      const separator = document.createElement("div");
      separator.className = "preview-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
    }
    const item = actionButton(action, "menu-item");
    item.setAttribute("role", "menuitem");
    menu.append(item);
  }
  menu.addEventListener("keydown", handleMenuKeyDown);
  return menu;
}

function toggleMore(): void {
  menuOpen = !menuOpen;
  focusAfterRender = { kind: menuOpen ? "menu" : "more" };
  render();
}

function closeMenu(returnFocus = true): void {
  if (!menuOpen) {
    return;
  }
  menuOpen = false;
  if (returnFocus) {
    focusAfterRender = { kind: "more" };
  }
  render();
}

async function invokeAction(action: ComputerUsePreviewActionId): Promise<void> {
  closeMenu(false);
  const current = window.lingComputerUsePreview;
  if (!current) {
    return;
  }
  if (action === "open") {
    await waitForRendererCommand(current.openOwnerConversation());
  } else if (action === "reset") {
    await waitForRendererCommand(current.resetPosition());
  } else if (action === "settings") {
    await waitForRendererCommand(current.openScreenPermissionSettings());
  } else if (action === "retry") {
    await waitForRendererCommand(current.retryCapture());
  } else if (action === "hide") {
    await waitForRendererCommand(current.hide());
  } else if (action === "close") {
    await waitForRendererCommand(current.close());
  } else if (action === "stop") {
    await requestStop(current);
  }
}

async function requestStop(current: NonNullable<typeof capabilities>): Promise<void> {
  if (stopCommandState === "pending") {
    return;
  }
  const sessionId = snapshot.sessionId;
  const requestSequence = ++stopRequestSequence;
  stopCommandState = "pending";
  menuOpen = false;
  focusAfterRender = undefined;
  render();
  try {
    const result = await waitForRendererCommand(current.requestStop());
    if (requestSequence !== stopRequestSequence || snapshot.sessionId !== sessionId) {
      return;
    }
    if (!result.accepted) {
      stopCommandState = "failed";
      render();
      return;
    }
    startStopConvergenceTimeout(requestSequence, sessionId);
  } catch {
    if (requestSequence !== stopRequestSequence || snapshot.sessionId !== sessionId) {
      return;
    }
    stopCommandState = "failed";
    render();
  }
}

function startStopConvergenceTimeout(requestSequence: number, sessionId: string): void {
  clearStopConvergenceTimeout();
  stopConvergenceTimeoutId = window.setTimeout(() => {
    stopConvergenceTimeoutId = undefined;
    if (
      requestSequence !== stopRequestSequence ||
      snapshot.sessionId !== sessionId ||
      stopCommandState !== "pending"
    ) {
      return;
    }
    stopCommandState = "failed";
    render();
  }, RENDERER_COMMAND_TIMEOUT_MS);
}

function clearStopConvergenceTimeout(): void {
  if (stopConvergenceTimeoutId !== undefined) {
    window.clearTimeout(stopConvergenceTimeoutId);
    stopConvergenceTimeoutId = undefined;
  }
}

async function waitForRendererCommand<T>(command: Promise<T>): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("computer_use_renderer_command_timeout")),
        RENDERER_COMMAND_TIMEOUT_MS,
      );
      command.then(resolve, reject);
    });
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape" && menuOpen) {
    event.preventDefault();
    closeMenu();
  } else if (event.key === "Escape" && viewAllOpen) {
    event.preventDefault();
    viewAllOpen = false;
    focusAfterRender = { kind: "view_all" };
    render();
  }
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  if (menuOpen && !event.target.closest(".preview-controls")) {
    closeMenu(false);
  }
  if (viewAllOpen && !event.target.closest(".page-deck-chrome")) {
    viewAllOpen = false;
    focusAfterRender = { kind: "view_all" };
    render();
  }
}

function handlePageTabKeyDown(event: KeyboardEvent): void {
  const tablist = event.currentTarget;
  if (!(tablist instanceof HTMLElement)) {
    return;
  }
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>("[role=\"tab\"]")];
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % tabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  } else if (event.key === "Enter" || event.key === " ") {
    const pageId = (document.activeElement as HTMLElement | null)?.dataset.pageActivate;
    if (pageId) {
      event.preventDefault();
      void activateDeckPage(pageId);
    }
    return;
  } else if (event.key === "Delete") {
    const pageId = (document.activeElement as HTMLElement | null)?.dataset.pageActivate;
    if (pageId) {
      event.preventDefault();
      void closeDeckPage(pageId);
    }
    return;
  }
  if (nextIndex !== undefined && tabs[nextIndex]) {
    event.preventDefault();
    tabs[nextIndex].tabIndex = 0;
    tabs[nextIndex].focus();
  }
}

function handleMenuKeyDown(event: KeyboardEvent): void {
  const menu = event.currentTarget;
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  const items = [...menu.querySelectorAll<HTMLElement>("[role=\"menuitem\"]")];
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown") {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  } else if (event.key === "ArrowUp") {
    nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  }
  if (nextIndex !== undefined && items[nextIndex]) {
    event.preventDefault();
    items[nextIndex].focus();
  }
}

function handlePreviewFocusOut(event: FocusEvent): void {
  if (rendering) {
    return;
  }
  if (event.relatedTarget instanceof Node && previewRoot.contains(event.relatedTarget)) {
    return;
  }
  reportInteraction("focus", false);
}

function reportInteraction(kind: "hover" | "focus", active: boolean): void {
  if (interactionState[kind] === active) {
    return;
  }
  interactionState[kind] = active;
  capabilities?.reportInteraction({ kind, active });
}

function preserveCurrentFocus(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !previewRoot.contains(active)) {
    return;
  }
  const actionId = active.dataset.actionId as ComputerUsePreviewActionId | undefined;
  if (actionId) {
    focusAfterRender = { kind: "action", actionId, inMenu: Boolean(active.closest(".preview-menu")) };
  } else if (active.classList.contains("more-button")) {
    focusAfterRender = { kind: "more" };
  } else if (active.closest(".page-deck-view-all-panel") && active.dataset.pageActivate) {
    focusAfterRender = { kind: "view_all_item", pageId: active.dataset.pageActivate };
  } else if (active.dataset.pageActivate) {
    focusAfterRender = { kind: "page", pageId: active.dataset.pageActivate, control: "activate" };
  } else if (active.dataset.pageClose) {
    focusAfterRender = { kind: "page", pageId: active.dataset.pageClose, control: "close" };
  } else if (active.classList.contains("page-deck-view-all")) {
    focusAfterRender = { kind: "view_all" };
  }
}

function resetStopCommandState(invalidateRequest: boolean): void {
  clearStopConvergenceTimeout();
  stopCommandState = "idle";
  if (invalidateRequest) {
    stopRequestSequence += 1;
  }
}

async function syncSource(): Promise<void> {
  const mediaKey = mediaKeyFor(snapshot);
  if (
    snapshot.sourceKind === "display_media" &&
    snapshot.sourceStatus !== "connecting" &&
    snapshot.sourceStatus !== "live" &&
    snapshot.sourceStatus !== "stalled"
  ) {
    invalidateCurrentMedia();
    return;
  }
  if (currentMediaKey === mediaKey) {
    if (currentStream) {
      attachCurrentStream();
    }
    return;
  }
  invalidateCurrentMedia();
  currentMediaKey = mediaKey;
  const requestGeneration = mediaRequestGeneration;
  if (snapshot.sourceKind === "fake") {
    const sessionId = snapshot.sessionId;
    const revision = snapshot.sourceRevision;
    const sourceGeneration = snapshot.sourceGeneration;
    // Hidden BrowserWindows may suppress requestAnimationFrame on Rosetta/x64
    // after a Hide -> Show reload. The fake source has no media frame to wait
    // for, so schedule the acknowledgement independently of paint throttling.
    setTimeout(() => window.lingComputerUsePreview?.reportFrameReady(
      sessionId,
      revision,
      sourceGeneration,
    ), 0);
    return;
  }
  const sessionId = snapshot.sessionId;
  const revision = snapshot.sourceRevision;
  const sourceGeneration = snapshot.sourceGeneration;
  const pendingAcquisition = beginMediaAcquisition(mediaKey, requestGeneration);
  pendingMediaAcquisitions.set(requestGeneration, pendingAcquisition);
  let settlement: MediaAcquisitionSettlement;
  try {
    settlement = await pendingAcquisition.completion;
  } finally {
    if (pendingMediaAcquisitions.get(requestGeneration) === pendingAcquisition) {
      pendingMediaAcquisitions.delete(requestGeneration);
    }
  }
  if (settlement.error !== undefined) {
    if (!isCurrentMediaIdentity(mediaKey, requestGeneration)) {
      return;
    }
    invalidateCurrentMedia();
    window.lingComputerUsePreview?.reportSourceFailure(
      sessionId,
      revision,
      sourceGeneration,
      settlement.error instanceof Error ? settlement.error.message : String(settlement.error),
    );
    return;
  }
  const stream = settlement.stream;
  if (!stream || !isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
    if (stream) {
      stopMediaStream(stream);
    }
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
    stopMediaStream(stream);
    return;
  }
  const video = document.querySelector<HTMLVideoElement>(".preview-video");
  if (!video) {
    invalidateCurrentMedia();
    return;
  }
  attachCurrentStream();
  track?.addEventListener("ended", () => {
    if (isCurrentMediaIdentity(mediaKey, requestGeneration) && currentStream === stream) {
      window.lingComputerUsePreview?.reportSourceEnded(
        sessionId,
        revision,
        sourceGeneration,
        "capture_track_ended",
      );
    }
  }, { once: true });
  let frameReported = false;
  const reportFrameReady = (): void => {
    if (
      frameReported ||
      !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
      currentStream !== stream ||
      track?.readyState === "ended" ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }
    frameReported = true;
    window.lingComputerUsePreview?.reportFrameReady(sessionId, revision, sourceGeneration);
  };
  video.addEventListener("loadeddata", reportFrameReady, { once: true });
  const videoWithFrameCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  };
  const requestFrameCallback = videoWithFrameCallback.requestVideoFrameCallback?.bind(videoWithFrameCallback);
  if (requestFrameCallback) {
    const reportVideoFrame = (now: number): void => {
      if (
        !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
        currentStream !== stream ||
        track?.readyState === "ended"
      ) {
        return;
      }
      reportFrameReady();
      if (now - lastFrameActivityReportAt >= 250) {
        lastFrameActivityReportAt = now;
        window.lingComputerUsePreview?.reportFrameActivity(sessionId, revision, sourceGeneration);
      }
      requestFrameCallback(reportVideoFrame);
    };
    requestFrameCallback(reportVideoFrame);
  } else {
    video.addEventListener("timeupdate", () => {
      if (isCurrentMediaIdentity(mediaKey, requestGeneration) && currentStream === stream) {
        window.lingComputerUsePreview?.reportFrameActivity(sessionId, revision, sourceGeneration);
      }
    });
  }
  // Hidden/occluded BrowserWindows can defer loadeddata and
  // requestVideoFrameCallback even after Chromium has decoded current data.
  // Poll the decoded-data state without relaxing the first-frame gate. The
  // source identity check stops the short-lived loop immediately on Hide,
  // revision replacement, reconnect, or renderer teardown.
  const pollDecodedFrame = (): void => {
    if (
      frameReported ||
      !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
      currentStream !== stream ||
      track?.readyState === "ended"
    ) {
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      reportFrameReady();
      return;
    }
    setTimeout(pollDecodedFrame, 16);
  };
  setTimeout(pollDecodedFrame, 0);
  try {
    await video.play();
  } catch (error) {
    if (!isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
      return;
    }
    invalidateCurrentMedia();
    window.lingComputerUsePreview?.reportSourceFailure(
      sessionId,
      revision,
      sourceGeneration,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    reportFrameReady();
  }
}

function beginMediaAcquisition(mediaKey: string, generation: number): PendingMediaAcquisition {
  const completion = (async (): Promise<MediaAcquisitionSettlement> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 960, max: 960 },
          height: { ideal: 600, max: 600 },
        },
      });
      if (!isCurrentMediaIdentity(mediaKey, generation)) {
        return { stoppedTracks: stopMediaStream(stream) };
      }
      currentStream = stream;
      return { stream, stoppedTracks: emptyStoppedTrackBatch() };
    } catch (error) {
      return { stoppedTracks: emptyStoppedTrackBatch(), error };
    }
  })();
  return { mediaKey, generation, completion };
}

function captureActivePageThumbnail(pageId: string): void {
  if (!pageId || snapshot.sessionId !== pageId || !snapshot.frameReady) {
    return;
  }
  const aspectRatio = Number.isFinite(snapshot.aspectRatio) && snapshot.aspectRatio > 0
    ? snapshot.aspectRatio
    : 1.6;
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_THUMBNAIL_WIDTH;
  canvas.height = Math.max(1, Math.min(
    PAGE_THUMBNAIL_MAX_HEIGHT,
    Math.round(PAGE_THUMBNAIL_WIDTH / aspectRatio),
  ));
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const video = document.querySelector<HTMLVideoElement>(".preview-video");
  let capturedVideo = false;
  if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      capturedVideo = true;
    } catch {
      capturedVideo = false;
    }
  }
  if (!capturedVideo) {
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#182033");
    gradient.addColorStop(1, "#0b101b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#dce7fa";
    context.font = "600 22px system-ui";
    context.fillText(snapshot.targetLabel.slice(0, 28), 20, Math.round(canvas.height / 2));
  }
  pageThumbnails.delete(pageId);
  pageThumbnails.set(pageId, canvas);
  enforcePageThumbnailBudget();
}

function prunePageThumbnails(value: ComputerUsePipRendererSnapshot): void {
  const deck = value.deck;
  if (!deck) {
    pageThumbnails.clear();
    return;
  }
  const residentIds = new Set(deck.pages.map((page) => page.pageId));
  for (const pageId of pageThumbnails.keys()) {
    if (!residentIds.has(pageId)) {
      pageThumbnails.delete(pageId);
    }
  }
  if (!deck.requestedPageId && deck.activePageId === value.sessionId && value.frameReady) {
    pageThumbnails.delete(deck.activePageId);
  }
  enforcePageThumbnailBudget();
}

function enforcePageThumbnailBudget(): void {
  while (
    pageThumbnails.size > PAGE_THUMBNAIL_MAX_COUNT
    || pageThumbnailMemoryBytes() > PAGE_THUMBNAIL_MEMORY_BUDGET_BYTES
  ) {
    const oldestPageId = pageThumbnails.keys().next().value as string | undefined;
    if (!oldestPageId) {
      break;
    }
    pageThumbnails.delete(oldestPageId);
  }
}

function pageThumbnailMemoryBytes(): number {
  return [...pageThumbnails.values()]
    .reduce((total, canvas) => total + canvas.width * canvas.height * 4, 0);
}

async function releaseMediaForRequest(
  request: ComputerUsePreviewReleaseMediaRequest,
): Promise<ComputerUsePreviewReleaseMediaResult> {
  if (snapshot.deck?.activePageId === request.sessionId) {
    captureActivePageThumbnail(request.sessionId);
  }
  const requestedMediaKey = `${request.sessionId}:${request.sourceRevision}:${request.sourceGeneration}:display_media`;
  if (currentMediaKey && currentMediaKey !== requestedMediaKey) {
    return identityMismatchReleaseResult();
  }
  if (currentMediaKey === requestedMediaKey) {
    const release = invalidateCurrentMedia();
    if (release) {
      return release.completion;
    }
  }
  const existingRelease = mediaReleaseRecords.get(requestedMediaKey);
  return existingRelease ? existingRelease.completion : identityMismatchReleaseResult();
}

function invalidateCurrentMedia(): MediaReleaseRecord | undefined {
  const mediaKey = currentMediaKey;
  if (!mediaKey) {
    if (currentStream) {
      mediaRequestGeneration += 1;
      stopMediaStream(currentStream);
    }
    currentStream = undefined;
    clearAttachedVideo();
    lastFrameActivityReportAt = 0;
    return undefined;
  }
  const generationBoundary = mediaRequestGeneration;
  mediaRequestGeneration += 1;
  currentMediaKey = undefined;
  const stoppedCurrentTracks = currentStream
    ? stopMediaStream(currentStream)
    : emptyStoppedTrackBatch();
  currentStream = undefined;
  lastFrameActivityReportAt = 0;
  clearAttachedVideo();
  const pendingCompletions = [...pendingMediaAcquisitions.values()]
    .filter((pending) => pending.generation <= generationBoundary)
    .map((pending) => pending.completion);
  const completion = Promise.all(pendingCompletions).then((settlements) => releaseResultForTracks([
    stoppedCurrentTracks,
    ...settlements.map((settlement) => settlement.stoppedTracks),
  ]));
  const release = { mediaKey, generationBoundary, completion };
  rememberMediaRelease(release);
  return release;
}

function rememberMediaRelease(release: MediaReleaseRecord): void {
  mediaReleaseRecords.delete(release.mediaKey);
  mediaReleaseRecords.set(release.mediaKey, release);
  while (mediaReleaseRecords.size > 8) {
    const oldestKey = mediaReleaseRecords.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    mediaReleaseRecords.delete(oldestKey);
  }
}

function releaseResultForTracks(
  batches: readonly StoppedTrackBatch[],
): ComputerUsePreviewReleaseMediaResult {
  const tracks = new Set<MediaStreamTrack>();
  const releasedTracks = new Set<MediaStreamTrack>();
  for (const batch of batches) {
    batch.tracks.forEach((track) => tracks.add(track));
    batch.releasedTracks.forEach((track) => releasedTracks.add(track));
  }
  return {
    status: releasedTracks.size > 0 ? "released" : "already_released",
    releasedTrackCount: releasedTracks.size,
    allTracksEnded: [...tracks].every((track) => track.readyState === "ended"),
  };
}

function identityMismatchReleaseResult(): ComputerUsePreviewReleaseMediaResult {
  return {
    status: "identity_mismatch",
    releasedTrackCount: 0,
    allTracksEnded: false,
  };
}

function stopMediaStream(stream: MediaStream): StoppedTrackBatch {
  return stopMediaTracks(stream.getTracks());
}

function stopMediaTracks(tracks: readonly MediaStreamTrack[]): StoppedTrackBatch {
  const releasedTracks: MediaStreamTrack[] = [];
  for (const track of tracks) {
    if (trackHasEnded(track)) {
      continue;
    }
    try {
      track.stop();
    } catch {
      // A non-ended track produces a negative ACK and main destroys the window.
    }
    if (trackHasEnded(track)) {
      releasedTracks.push(track);
    }
  }
  return { tracks: [...tracks], releasedTracks };
}

function trackHasEnded(track: MediaStreamTrack): boolean {
  return track.readyState === "ended";
}

function emptyStoppedTrackBatch(): StoppedTrackBatch {
  return { tracks: [], releasedTracks: [] };
}

function clearAttachedVideo(): void {
  const video = document.querySelector<HTMLVideoElement>(".preview-video");
  if (video) {
    video.srcObject = null;
  }
}

function isCurrentMediaIdentity(mediaKey: string, generation: number): boolean {
  return currentMediaKey === mediaKey && mediaRequestGeneration === generation;
}

function attachCurrentStream(): void {
  const video = document.querySelector<HTMLVideoElement>(".preview-video");
  if (!video || !currentStream || video.srcObject === currentStream) {
    return;
  }
  video.srcObject = currentStream;
  void video.play().catch(() => undefined);
}

function mediaKeyFor(value: ComputerUsePipRendererSnapshot): string {
  return `${value.sessionId}:${value.sourceRevision}:${value.sourceGeneration}:${value.sourceKind}`;
}

function actionButton(action: ComputerUsePreviewActionViewModel, className: string): HTMLButtonElement {
  const element = button(
    action.label,
    () => invokeAction(action.id),
    `${className}${action.danger ? " danger" : ""}`,
  );
  element.dataset.actionId = action.id;
  element.disabled = action.disabled;
  return element;
}

function button(label: string, action: () => void | Promise<void>, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", () => {
    void Promise.resolve(action()).catch(() => undefined);
  });
  return element;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}
