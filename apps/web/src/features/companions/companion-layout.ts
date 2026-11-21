import type { CompanionAttentionSource } from "@ling-stack/contracts";

export interface CompanionLayoutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type CompanionCardSide = "right" | "left" | "above" | "below";

export interface CompanionCardPlacement {
  readonly side: CompanionCardSide;
  readonly rect: CompanionLayoutRect;
}

const sides: readonly CompanionCardSide[] = ["right", "left", "above", "below"];

export function chooseCompanionCardPlacement(input: {
  readonly anchor: CompanionLayoutRect;
  readonly card: Pick<CompanionLayoutRect, "width" | "height">;
  readonly viewport: CompanionLayoutRect;
  readonly preferredSide?: CompanionCardSide;
  readonly gap?: number;
  readonly margin?: number;
}): CompanionCardPlacement {
  const gap = input.gap ?? 12;
  const margin = input.margin ?? 12;
  const candidates = sides.map((side) => {
    const raw = candidateRect(side, input.anchor, input.card, gap);
    const fitted = fitRect(raw, input.card, input.viewport, margin);
    return {
      side,
      rect: fitted,
      fits: fitsWithin(raw, input.card, input.viewport, margin),
      spare: spareSpace(fitted, input.card, input.viewport, margin),
    };
  });
  const preferred = input.preferredSide ? candidates.find((candidate) => candidate.side === input.preferredSide) : undefined;
  if (preferred?.fits) return { side: preferred.side, rect: preferred.rect };
  const best = candidates
    .filter((candidate) => candidate.fits)
    .sort((left, right) =>
      (right.spare - left.spare) ||
      sides.indexOf(left.side) - sides.indexOf(right.side),
    )[0] ?? candidates.sort((left, right) => right.spare - left.spare)[0]!;
  return { side: best.side, rect: best.rect };
}

export function sourceNavigationRequest(source: CompanionAttentionSource): {
  readonly workspace: string;
  readonly kind: "source";
  readonly channelId?: string;
  readonly threadId?: string;
  readonly sourceItemId?: string;
  readonly sourceId: string;
} {
  return {
    workspace: source.cwd,
    kind: "source",
    ...(source.channelId ? { channelId: source.channelId } : {}),
    ...(source.threadId ? { threadId: source.threadId } : {}),
    ...(source.sourceItemId ? { sourceItemId: source.sourceItemId } : {}),
    sourceId: source.id,
  };
}

function candidateRect(
  side: CompanionCardSide,
  anchor: CompanionLayoutRect,
  card: Pick<CompanionLayoutRect, "width" | "height">,
  gap: number,
): CompanionLayoutRect {
  switch (side) {
    case "left":
      return { left: anchor.left - gap - card.width, top: anchor.top + (anchor.height - card.height) / 2, ...card };
    case "above":
      return { left: anchor.left + (anchor.width - card.width) / 2, top: anchor.top - gap - card.height, ...card };
    case "below":
      return { left: anchor.left + (anchor.width - card.width) / 2, top: anchor.top + anchor.height + gap, ...card };
    case "right":
      return { left: anchor.left + anchor.width + gap, top: anchor.top + (anchor.height - card.height) / 2, ...card };
  }
}

function fitRect(
  rect: CompanionLayoutRect,
  size: Pick<CompanionLayoutRect, "width" | "height">,
  viewport: CompanionLayoutRect,
  margin: number,
): CompanionLayoutRect {
  return {
    left: clamp(rect.left, viewport.left + margin, viewport.left + viewport.width - size.width - margin),
    top: clamp(rect.top, viewport.top + margin, viewport.top + viewport.height - size.height - margin),
    width: size.width,
    height: size.height,
  };
}

function fitsWithin(
  rect: CompanionLayoutRect,
  size: Pick<CompanionLayoutRect, "width" | "height">,
  viewport: CompanionLayoutRect,
  margin: number,
): boolean {
  return size.width <= viewport.width - margin * 2
    && size.height <= viewport.height - margin * 2
    && rect.left >= viewport.left + margin
    && rect.top >= viewport.top + margin
    && rect.left + size.width <= viewport.left + viewport.width - margin
    && rect.top + size.height <= viewport.top + viewport.height - margin;
}

function spareSpace(
  rect: CompanionLayoutRect,
  size: Pick<CompanionLayoutRect, "width" | "height">,
  viewport: CompanionLayoutRect,
  margin: number,
): number {
  const horizontal = Math.min(
    rect.left - viewport.left - margin,
    viewport.left + viewport.width - margin - rect.left - size.width,
  );
  const vertical = Math.min(
    rect.top - viewport.top - margin,
    viewport.top + viewport.height - margin - rect.top - size.height,
  );
  return Math.max(0, horizontal) + Math.max(0, vertical);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
