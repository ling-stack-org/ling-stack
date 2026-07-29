import type { MediaCanvasPosition, MediaScene } from "../../types.js";

const leftDockInset = 320;
const rightDockInset = 392;
const canvasEdgeInset = 16;
const canvasTopInset = 72;
const canvasBottomInset = 56;
const minimapBottomInset = 144;
const minimumSafeCanvasWidth = 400;
const minimumMinimapWidth = 560;
export const storyboardNodeWidth = 218;
export const storyboardNodeHeight = 104;
export const storyboardMaximumMotionDuration = 250;

export interface CanvasSafeArea {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface StoryboardFitViewPadding {
  readonly top: `${number}px`;
  readonly right: `${number}px`;
  readonly bottom: `${number}px`;
  readonly left: `${number}px`;
}

export interface StoryboardViewportTarget {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface StoryboardLayoutBounds {
  readonly width: number;
  readonly height: number;
}

export interface StoryboardLayoutItem {
  readonly position: MediaCanvasPosition;
  readonly width: number;
  readonly height: number;
}

export function mediaProductionDocksAreExclusive(stageWidth: number): boolean {
  if (stageWidth <= 0) {
    return false;
  }
  return stageWidth - leftDockInset - rightDockInset < minimumSafeCanvasWidth;
}

export function storyboardCanvasSafeArea(input: {
  readonly width: number;
  readonly height: number;
  readonly leftDockOpen: boolean;
  readonly rightDockOpen: boolean;
  readonly miniMapVisible: boolean;
}): CanvasSafeArea {
  const left = input.leftDockOpen ? leftDockInset : canvasEdgeInset;
  const right = input.rightDockOpen ? rightDockInset : canvasEdgeInset;
  const top = canvasTopInset;
  const bottom = input.miniMapVisible ? minimapBottomInset : canvasBottomInset;
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, input.width - left - right),
    height: Math.max(0, input.height - top - bottom),
  };
}

export function shouldShowStoryboardMiniMap(input: {
  readonly scenes: readonly MediaScene[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly leftDockOpen: boolean;
  readonly rightDockOpen: boolean;
}): boolean {
  if (input.scenes.length < 2 || input.canvasWidth <= 0 || input.canvasHeight <= 0) {
    return false;
  }
  const safeArea = storyboardCanvasSafeArea({
    width: input.canvasWidth,
    height: input.canvasHeight,
    leftDockOpen: input.leftDockOpen,
    rightDockOpen: input.rightDockOpen,
    miniMapVisible: false,
  });
  if (safeArea.width < minimumMinimapWidth || safeArea.height < 300) {
    return false;
  }
  if (input.scenes.length >= 5) {
    return true;
  }
  const bounds = storyboardSceneBounds(input.scenes);
  return bounds.width > safeArea.width * 1.35 || bounds.height > safeArea.height * 1.35;
}

export function storyboardFitViewPadding(input: {
  readonly leftDockOpen: boolean;
  readonly rightDockOpen: boolean;
  readonly miniMapVisible: boolean;
}): StoryboardFitViewPadding {
  const safeArea = storyboardCanvasSafeArea({ width: 0, height: 0, ...input });
  return {
    top: `${safeArea.top}px`,
    right: `${safeArea.right}px`,
    bottom: `${safeArea.bottom}px`,
    left: `${safeArea.left}px`,
  };
}

export function storyboardFocusViewport(input: {
  readonly nodePosition: MediaCanvasPosition;
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
  readonly zoom: number;
  readonly safeArea: CanvasSafeArea;
}): StoryboardViewportTarget {
  const nodeWidth = input.nodeWidth ?? storyboardNodeWidth;
  const nodeHeight = input.nodeHeight ?? storyboardNodeHeight;
  const targetX = input.safeArea.left + input.safeArea.width / 2;
  const targetY = input.safeArea.top + input.safeArea.height / 2;
  return {
    x: targetX - (input.nodePosition.x + nodeWidth / 2) * input.zoom,
    y: targetY - (input.nodePosition.y + nodeHeight / 2) * input.zoom,
    zoom: input.zoom,
  };
}

export function storyboardMotionDuration(reducedMotion: boolean, preferredDuration: number): number {
  if (reducedMotion) return 0;
  return Math.min(storyboardMaximumMotionDuration, Math.max(0, Math.trunc(preferredDuration)));
}

export function storyboardLayoutBounds(items: readonly StoryboardLayoutItem[]): StoryboardLayoutBounds {
  if (items.length === 0) return { width: 0, height: 0 };
  const minX = Math.min(...items.map((item) => item.position.x));
  const minY = Math.min(...items.map((item) => item.position.y));
  const maxX = Math.max(...items.map((item) => item.position.x + item.width));
  const maxY = Math.max(...items.map((item) => item.position.y + item.height));
  return { width: maxX - minX, height: maxY - minY };
}

export function storyboardBoundsFitSafeArea(input: {
  readonly bounds: StoryboardLayoutBounds;
  readonly safeArea: CanvasSafeArea;
  readonly minimumZoom: number;
}): boolean {
  if (input.safeArea.width <= 0 || input.safeArea.height <= 0 || input.minimumZoom <= 0) return false;
  return input.bounds.width * input.minimumZoom <= input.safeArea.width
    && input.bounds.height * input.minimumZoom <= input.safeArea.height;
}

export function storyboardSceneBounds(scenes: readonly MediaScene[]): { readonly width: number; readonly height: number } {
  if (scenes.length === 0) return { width: 0, height: 0 };
  const minX = Math.min(...scenes.map((scene) => scene.canvasPosition.x));
  const minY = Math.min(...scenes.map((scene) => scene.canvasPosition.y));
  const maxX = Math.max(...scenes.map((scene) => scene.canvasPosition.x + storyboardNodeWidth));
  const maxY = Math.max(...scenes.map((scene) => scene.canvasPosition.y + storyboardNodeHeight));
  return { width: maxX - minX, height: maxY - minY };
}
