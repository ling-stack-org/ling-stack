import type {
  ComputerUseHostObstacle,
  ComputerUseHostObstacleKind,
  ComputerUsePipCorner,
  ComputerUsePipNormalizedPlacement,
  DesktopDisplayWorkArea,
  DesktopRect,
} from "../../shared/desktop-capabilities.js";

const DEFAULT_MARGIN = 16;
const DEFAULT_OBSTACLE_PADDING = 12;
const MIN_PREVIEW_WIDTH = 320;
const MIN_PREVIEW_HEIGHT = 200;

export const COMPUTER_USE_PIP_CORNERS: readonly ComputerUsePipCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
export const MAX_COMPUTER_USE_PIP_COLLISION_OFFSETS = 6;

export type ComputerUsePipObstacleKind = ComputerUseHostObstacleKind;

export interface ComputerUsePipObstacle {
  readonly bounds: DesktopRect;
  readonly kind?: ComputerUsePipObstacleKind;
}

export type ComputerUsePipObstacleInput = DesktopRect | ComputerUseHostObstacle | ComputerUsePipObstacle;

export interface ComputerUsePipPlacementScore {
  readonly total: number;
  readonly blockingCollisionArea: number;
  readonly collisionArea: number;
  readonly preferredCornerDistance: number;
  readonly previousPositionDistance: number;
  readonly cornerDisplacement: number;
}

export interface ComputerUsePipPlacementCandidate {
  readonly corner: ComputerUsePipCorner;
  readonly bounds: DesktopRect;
  readonly offsetIterations: number;
  readonly score: ComputerUsePipPlacementScore;
}

export interface RestoredComputerUsePipPlacement {
  readonly displayId: string;
  readonly bounds: DesktopRect;
  readonly usedDisplayFallback: boolean;
}

interface PlacementInput {
  readonly workArea: DesktopRect;
  readonly size: { readonly width: number; readonly height: number };
  readonly obstacles?: readonly ComputerUsePipObstacleInput[];
  readonly margin?: number;
  readonly obstaclePadding?: number;
  readonly preferredCorner?: ComputerUsePipCorner;
  readonly previousBounds?: DesktopRect;
  readonly maxOffsetIterations?: number;
}

export function chooseComputerUsePreviewBounds(input: PlacementInput): DesktopRect {
  return generateComputerUsePreviewPlacementCandidates(input)[0].bounds;
}

export function createComputerUsePreviewCornerCandidates(input: Pick<
  PlacementInput,
  "workArea" | "size" | "margin"
>): readonly Pick<ComputerUsePipPlacementCandidate, "corner" | "bounds">[] {
  const margin = Math.max(0, input.margin ?? DEFAULT_MARGIN);
  const availableWidth = Math.max(0, input.workArea.width - margin * 2);
  const availableHeight = Math.max(0, input.workArea.height - margin * 2);
  const width = Math.min(Math.max(input.size.width, MIN_PREVIEW_WIDTH), availableWidth || input.workArea.width);
  const height = Math.min(Math.max(input.size.height, MIN_PREVIEW_HEIGHT), availableHeight || input.workArea.height);
  const left = input.workArea.x + margin;
  const right = input.workArea.x + input.workArea.width - width - margin;
  const top = input.workArea.y + margin;
  const bottom = input.workArea.y + input.workArea.height - height - margin;

  return COMPUTER_USE_PIP_CORNERS.map((corner) => ({
    corner,
    bounds: clampComputerUsePreviewBounds({
      x: corner.endsWith("right") ? right : left,
      y: corner.startsWith("bottom") ? bottom : top,
      width,
      height,
    }, input.workArea),
  }));
}

export function generateComputerUsePreviewPlacementCandidates(
  input: PlacementInput,
): readonly ComputerUsePipPlacementCandidate[] {
  const preferredCorner = input.preferredCorner ?? "bottom-right";
  const obstacles = normalizeObstacles(input.obstacles ?? [], input.obstaclePadding ?? DEFAULT_OBSTACLE_PADDING);
  const maxOffsetIterations = Math.min(
    Math.max(Math.trunc(input.maxOffsetIterations ?? MAX_COMPUTER_USE_PIP_COLLISION_OFFSETS), 0),
    MAX_COMPUTER_USE_PIP_COLLISION_OFFSETS,
  );
  const candidates = createComputerUsePreviewCornerCandidates(input).map((candidate) =>
    resolveCornerCandidate({
      ...candidate,
      workArea: input.workArea,
      obstacles,
      preferredCorner,
      previousBounds: input.previousBounds,
      maxOffsetIterations,
    }),
  );
  return candidates.sort(comparePlacementCandidates);
}

export function scoreComputerUsePreviewBounds(input: {
  readonly bounds: DesktopRect;
  readonly corner: ComputerUsePipCorner;
  readonly cornerBounds?: DesktopRect;
  readonly preferredCorner?: ComputerUsePipCorner;
  readonly previousBounds?: DesktopRect;
  readonly obstacles?: readonly ComputerUsePipObstacleInput[];
  readonly obstaclePadding?: number;
}): ComputerUsePipPlacementScore {
  const obstacles = normalizeObstacles(input.obstacles ?? [], input.obstaclePadding ?? DEFAULT_OBSTACLE_PADDING);
  return scoreBounds({
    bounds: input.bounds,
    corner: input.corner,
    cornerBounds: input.cornerBounds ?? input.bounds,
    preferredCorner: input.preferredCorner ?? "bottom-right",
    previousBounds: input.previousBounds,
    obstacles,
  });
}

export function clampComputerUsePreviewBounds(bounds: DesktopRect, workArea: DesktopRect): DesktopRect {
  const width = Math.min(Math.max(bounds.width, 0), Math.max(workArea.width, 0));
  const height = Math.min(Math.max(bounds.height, 0), Math.max(workArea.height, 0));
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

export function encodeComputerUsePipNormalizedPlacement(input: {
  readonly bounds: DesktopRect;
  readonly display: DesktopDisplayWorkArea;
}): ComputerUsePipNormalizedPlacement {
  const bounds = clampComputerUsePreviewBounds(input.bounds, input.display.workArea);
  const availableX = Math.max(0, input.display.workArea.width - bounds.width);
  const availableY = Math.max(0, input.display.workArea.height - bounds.height);
  return {
    displayId: input.display.id,
    normalizedX: availableX === 0 ? 0 : clampUnit((bounds.x - input.display.workArea.x) / availableX),
    normalizedY: availableY === 0 ? 0 : clampUnit((bounds.y - input.display.workArea.y) / availableY),
    width: bounds.width,
    height: bounds.height,
    sourceWorkArea: { ...input.display.workArea },
  };
}

export function restoreComputerUsePipNormalizedPlacement(input: {
  readonly placement: ComputerUsePipNormalizedPlacement;
  readonly displays: readonly DesktopDisplayWorkArea[];
}): RestoredComputerUsePipPlacement | undefined {
  if (input.displays.length === 0) {
    return undefined;
  }
  const exactDisplay = input.displays.find((display) => display.id === input.placement.displayId);
  const display = exactDisplay ?? nearestDisplay(input.placement.sourceWorkArea, input.displays);
  const width = Math.min(Math.max(input.placement.width, 0), display.workArea.width);
  const height = Math.min(Math.max(input.placement.height, 0), display.workArea.height);
  const availableX = Math.max(0, display.workArea.width - width);
  const availableY = Math.max(0, display.workArea.height - height);
  const bounds = clampComputerUsePreviewBounds({
    x: display.workArea.x + clampUnit(input.placement.normalizedX) * availableX,
    y: display.workArea.y + clampUnit(input.placement.normalizedY) * availableY,
    width,
    height,
  }, display.workArea);
  return {
    displayId: display.id,
    bounds,
    usedDisplayFallback: exactDisplay === undefined,
  };
}

function resolveCornerCandidate(input: {
  readonly corner: ComputerUsePipCorner;
  readonly bounds: DesktopRect;
  readonly workArea: DesktopRect;
  readonly obstacles: readonly NormalizedObstacle[];
  readonly preferredCorner: ComputerUsePipCorner;
  readonly previousBounds?: DesktopRect;
  readonly maxOffsetIterations: number;
}): ComputerUsePipPlacementCandidate {
  const cornerBounds = input.bounds;
  const visited = new Set([boundsKey(cornerBounds)]);
  let currentBounds = cornerBounds;
  let best = candidateForBounds(input, cornerBounds, cornerBounds, 0);
  let offsetIterations = 0;

  while (offsetIterations < input.maxOffsetIterations) {
    const collision = firstCollision(currentBounds, input.obstacles);
    if (!collision) {
      break;
    }
    const translated = translatedBounds(currentBounds, collision.bounds)
      .map((bounds) => clampComputerUsePreviewBounds(bounds, input.workArea))
      .filter((bounds) => {
        const key = boundsKey(bounds);
        if (visited.has(key)) {
          return false;
        }
        visited.add(key);
        return true;
      })
      .map((bounds) => candidateForBounds(input, cornerBounds, bounds, offsetIterations + 1))
      .sort(comparePlacementCandidates);
    if (translated.length === 0) {
      break;
    }
    offsetIterations += 1;
    const next = translated[0];
    currentBounds = next.bounds;
    if (comparePlacementCandidates(next, best) < 0) {
      best = next;
    }
  }

  return best;
}

function candidateForBounds(
  input: {
    readonly corner: ComputerUsePipCorner;
    readonly obstacles: readonly NormalizedObstacle[];
    readonly preferredCorner: ComputerUsePipCorner;
    readonly previousBounds?: DesktopRect;
  },
  cornerBounds: DesktopRect,
  bounds: DesktopRect,
  offsetIterations: number,
): ComputerUsePipPlacementCandidate {
  return {
    corner: input.corner,
    bounds,
    offsetIterations,
    score: scoreBounds({
      bounds,
      corner: input.corner,
      cornerBounds,
      preferredCorner: input.preferredCorner,
      previousBounds: input.previousBounds,
      obstacles: input.obstacles,
    }),
  };
}

interface NormalizedObstacle {
  readonly bounds: DesktopRect;
  readonly kind: ComputerUsePipObstacleKind;
}

function normalizeObstacles(
  obstacles: readonly ComputerUsePipObstacleInput[],
  padding: number,
): readonly NormalizedObstacle[] {
  const safePadding = Math.max(0, padding);
  return obstacles.map((obstacle) => {
    const normalized = "bounds" in obstacle
      ? { bounds: obstacle.bounds, kind: obstacle.kind ?? "other" }
      : { bounds: obstacle, kind: "kind" in obstacle ? obstacle.kind : "other" as const };
    return {
      kind: normalized.kind,
      bounds: {
        x: normalized.bounds.x - safePadding,
        y: normalized.bounds.y - safePadding,
        width: normalized.bounds.width + safePadding * 2,
        height: normalized.bounds.height + safePadding * 2,
      },
    };
  });
}

function scoreBounds(input: {
  readonly bounds: DesktopRect;
  readonly corner: ComputerUsePipCorner;
  readonly cornerBounds: DesktopRect;
  readonly preferredCorner: ComputerUsePipCorner;
  readonly previousBounds?: DesktopRect;
  readonly obstacles: readonly NormalizedObstacle[];
}): ComputerUsePipPlacementScore {
  let collisionArea = 0;
  let blockingCollisionArea = 0;
  for (const obstacle of input.obstacles) {
    const area = overlapArea(input.bounds, obstacle.bounds);
    collisionArea += area;
    if (obstacle.kind === "composer" || obstacle.kind === "approval") {
      blockingCollisionArea += area;
    }
  }
  const preferredCornerDistance = cornerDistance(input.corner, input.preferredCorner);
  const previousPositionDistance = input.previousBounds
    ? boundsDistance(input.bounds, input.previousBounds)
    : 0;
  const cornerDisplacement = boundsDistance(input.bounds, input.cornerBounds);
  return {
    blockingCollisionArea,
    collisionArea,
    preferredCornerDistance,
    previousPositionDistance,
    cornerDisplacement,
    total:
      blockingCollisionArea * 1_000_000_000 +
      collisionArea * 1_000_000 +
      preferredCornerDistance * 10_000 +
      previousPositionDistance * 10 +
      cornerDisplacement,
  };
}

function comparePlacementCandidates(
  left: ComputerUsePipPlacementCandidate,
  right: ComputerUsePipPlacementCandidate,
): number {
  return left.score.blockingCollisionArea - right.score.blockingCollisionArea ||
    left.score.collisionArea - right.score.collisionArea ||
    left.score.preferredCornerDistance - right.score.preferredCornerDistance ||
    left.score.previousPositionDistance - right.score.previousPositionDistance ||
    left.score.cornerDisplacement - right.score.cornerDisplacement ||
    COMPUTER_USE_PIP_CORNERS.indexOf(left.corner) - COMPUTER_USE_PIP_CORNERS.indexOf(right.corner) ||
    left.offsetIterations - right.offsetIterations;
}

function firstCollision(
  bounds: DesktopRect,
  obstacles: readonly NormalizedObstacle[],
): NormalizedObstacle | undefined {
  return obstacles
    .map((obstacle, index) => ({
      obstacle,
      index,
      area: overlapArea(bounds, obstacle.bounds),
      blocking: obstacle.kind === "composer" || obstacle.kind === "approval",
    }))
    .filter((entry) => entry.area > 0)
    .sort((left, right) =>
      Number(right.blocking) - Number(left.blocking) ||
      right.area - left.area ||
      left.index - right.index,
    )[0]?.obstacle;
}

function translatedBounds(bounds: DesktopRect, obstacle: DesktopRect): readonly DesktopRect[] {
  return [
    { ...bounds, y: obstacle.y - bounds.height },
    { ...bounds, y: obstacle.y + obstacle.height },
    { ...bounds, x: obstacle.x - bounds.width },
    { ...bounds, x: obstacle.x + obstacle.width },
  ];
}

function nearestDisplay(
  sourceWorkArea: DesktopRect,
  displays: readonly DesktopDisplayWorkArea[],
): DesktopDisplayWorkArea {
  return [...displays].sort((left, right) =>
    rectCenterDistanceSquared(sourceWorkArea, left.workArea) - rectCenterDistanceSquared(sourceWorkArea, right.workArea) ||
    Number(right.primary === true) - Number(left.primary === true) ||
    left.id.localeCompare(right.id),
  )[0];
}

function cornerDistance(left: ComputerUsePipCorner, right: ComputerUsePipCorner): number {
  const leftPoint = cornerPoint(left);
  const rightPoint = cornerPoint(right);
  return Math.abs(leftPoint.x - rightPoint.x) + Math.abs(leftPoint.y - rightPoint.y);
}

function cornerPoint(corner: ComputerUsePipCorner): { readonly x: number; readonly y: number } {
  return {
    x: corner.endsWith("right") ? 1 : 0,
    y: corner.startsWith("bottom") ? 1 : 0,
  };
}

function boundsDistance(left: DesktopRect, right: DesktopRect): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function rectCenterDistanceSquared(left: DesktopRect, right: DesktopRect): number {
  const x = left.x + left.width / 2 - (right.x + right.width / 2);
  const y = left.y + left.height / 2 - (right.y + right.height / 2);
  return x * x + y * y;
}

function boundsKey(bounds: DesktopRect): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

function clampUnit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
}

function overlapArea(left: DesktopRect, right: DesktopRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}
