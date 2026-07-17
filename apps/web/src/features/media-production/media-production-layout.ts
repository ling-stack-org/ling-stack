import type { MediaScene } from "../../types.js";

const leftDockInset = 320;
const rightDockInset = 392;
const canvasEdgeInset = 16;
const canvasTopInset = 72;
const canvasBottomInset = 56;
const minimapBottomInset = 144;
const minimumSafeCanvasWidth = 640;
const minimumMinimapWidth = 560;

export interface CanvasSafeArea {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
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

function storyboardSceneBounds(scenes: readonly MediaScene[]): { readonly width: number; readonly height: number } {
  const nodeWidth = 218;
  const nodeHeight = 104;
  const minX = Math.min(...scenes.map((scene) => scene.canvasPosition.x));
  const minY = Math.min(...scenes.map((scene) => scene.canvasPosition.y));
  const maxX = Math.max(...scenes.map((scene) => scene.canvasPosition.x + nodeWidth));
  const maxY = Math.max(...scenes.map((scene) => scene.canvasPosition.y + nodeHeight));
  return { width: maxX - minX, height: maxY - minY };
}
