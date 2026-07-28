import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComputerUsePipRendererSnapshot } from "../../shared/desktop-capabilities.js";

const PAGE_THUMBNAIL_WIDTH = 320;
const PAGE_THUMBNAIL_MAX_HEIGHT = 240;
const PAGE_THUMBNAIL_MAX_COUNT = 4;
const PAGE_THUMBNAIL_MEMORY_BUDGET_BYTES = 20 * 1024 * 1024;

export interface ComputerUsePageThumbnailState {
  readonly bytes: number;
  readonly count: number;
  readonly get: (pageId: string) => HTMLCanvasElement | undefined;
  readonly revision: number;
}

export function useComputerUsePageThumbnails(
  snapshot: ComputerUsePipRendererSnapshot,
): ComputerUsePageThumbnailState {
  const thumbnailsRef = useRef(new Map<string, HTMLCanvasElement>());
  const lastCaptureIdentityRef = useRef("");
  const [revision, setRevision] = useState(0);

  useLayoutEffect(() => {
    const thumbnails = thumbnailsRef.current;
    const deck = snapshot.deck;
    let changed = false;
    if (!deck) {
      if (thumbnails.size > 0) {
        thumbnails.clear();
        changed = true;
      }
      lastCaptureIdentityRef.current = "";
    } else {
      const residentIds = new Set(deck.pages.map((page) => page.pageId));
      for (const pageId of thumbnails.keys()) {
        if (!residentIds.has(pageId)) {
          thumbnails.delete(pageId);
          changed = true;
        }
      }

      if (deck.requestedPageId && deck.activePageId === snapshot.sessionId && snapshot.frameReady) {
        const captureIdentity = [
          deck.activePageId,
          deck.requestedPageId,
          snapshot.sourceRevision,
          snapshot.sourceGeneration,
        ].join(":");
        if (captureIdentity !== lastCaptureIdentityRef.current) {
          const thumbnail = captureActivePageThumbnail(snapshot);
          if (thumbnail) {
            thumbnails.delete(deck.activePageId);
            thumbnails.set(deck.activePageId, thumbnail);
            changed = true;
          }
          lastCaptureIdentityRef.current = captureIdentity;
        }
      } else {
        lastCaptureIdentityRef.current = "";
        if (deck.activePageId === snapshot.sessionId && snapshot.frameReady) {
          changed = thumbnails.delete(deck.activePageId) || changed;
        }
      }

      changed = enforceThumbnailBudget(thumbnails) || changed;
    }
    if (changed) {
      setRevision((current) => current + 1);
    }
  }, [snapshot]);

  return useMemo(() => {
    const thumbnails = thumbnailsRef.current;
    return {
      bytes: thumbnailMemoryBytes(thumbnails),
      count: thumbnails.size,
      get: (pageId: string) => thumbnails.get(pageId),
      revision,
    };
  }, [revision]);
}

function captureActivePageThumbnail(
  snapshot: ComputerUsePipRendererSnapshot,
): HTMLCanvasElement | undefined {
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
    return undefined;
  }

  const video = document.querySelector<HTMLVideoElement>(".preview-video");
  if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch {
      // Fall through to a token-derived placeholder when capture is unavailable.
    }
  }

  const theme = getComputedStyle(document.documentElement);
  context.fillStyle = theme.getPropertyValue("--ling-bg-subtle").trim() || "Canvas";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = theme.getPropertyValue("--ling-text-default").trim() || "CanvasText";
  context.font = "600 22px system-ui";
  context.fillText(snapshot.targetLabel.slice(0, 28), 20, Math.round(canvas.height / 2));
  return canvas;
}

function enforceThumbnailBudget(thumbnails: Map<string, HTMLCanvasElement>): boolean {
  let changed = false;
  while (
    thumbnails.size > PAGE_THUMBNAIL_MAX_COUNT
    || thumbnailMemoryBytes(thumbnails) > PAGE_THUMBNAIL_MEMORY_BUDGET_BYTES
  ) {
    const oldestPageId = thumbnails.keys().next().value as string | undefined;
    if (!oldestPageId) {
      break;
    }
    thumbnails.delete(oldestPageId);
    changed = true;
  }
  return changed;
}

function thumbnailMemoryBytes(thumbnails: ReadonlyMap<string, HTMLCanvasElement>): number {
  return [...thumbnails.values()]
    .reduce((total, canvas) => total + canvas.width * canvas.height * 4, 0);
}
