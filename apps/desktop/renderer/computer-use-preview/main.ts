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
let focusAfterRender:
  | { readonly kind: "menu" }
  | { readonly kind: "more" }
  | { readonly kind: "action"; readonly actionId: ComputerUsePreviewActionId; readonly inMenu: boolean }
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
  if (sessionChanged) {
    menuOpen = false;
    focusAfterRender = undefined;
    resetStopCommandState(true);
  } else {
    preserveCurrentFocus();
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
    requestAnimationFrame(() => {
      const selector = focusTarget.kind === "menu"
        ? ".preview-menu [role=\"menuitem\"]"
        : focusTarget.kind === "more"
          ? ".more-button"
          : `${focusTarget.inMenu ? ".preview-menu " : ""}[data-action-id="${focusTarget.actionId}"]`;
      previewRoot.querySelector<HTMLElement>(selector)?.focus();
    });
  }
}

function buildPreview(value: ComputerUsePipRendererSnapshot): HTMLElement {
  const locale = normalizeComputerUsePreviewLocale(value.locale);
  const t = createComputerUsePreviewTranslator(locale);
  const viewModel = createComputerUsePreviewViewModel(value, { stopCommandState });
  document.documentElement.lang = locale;
  document.title = t("windowTitle", { target: value.targetLabel, status: viewModel.label });
  const shell = document.createElement("section");
  shell.className = "preview-shell";
  shell.dataset.state = viewModel.state;
  shell.dataset.tone = viewModel.tone;
  shell.dataset.controls = viewModel.controlsPersistent ? "persistent" : "hover";
  shell.dataset.stopCommand = stopCommandState;
  shell.setAttribute("aria-label", t("previewLabel", { target: value.targetLabel }));

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
  return shell;
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
  }
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!menuOpen || !(event.target instanceof Element)) {
    return;
  }
  if (!event.target.closest(".preview-controls")) {
    closeMenu(false);
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

async function releaseMediaForRequest(
  request: ComputerUsePreviewReleaseMediaRequest,
): Promise<ComputerUsePreviewReleaseMediaResult> {
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
