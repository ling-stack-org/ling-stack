import type { ThemeImageAnalysis, ThemeImageSample } from "./compiler-types.js";

const MAX_SAMPLE_EDGE = 128;
const DOMINANT_COLOR_LIMIT = 5;

interface SampledPixel {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly luminance: number;
  readonly saturation: number;
}

export function analyzeThemeImage(sample: ThemeImageSample): ThemeImageAnalysis {
  validateSample(sample);
  const pixels = collectVisiblePixels(sample);
  if (pixels.length === 0) {
    throw new Error("Theme image sample has no visible pixels.");
  }

  const averageLuminance = pixels.reduce((sum, pixel) => sum + pixel.luminance, 0) / pixels.length;
  const information = informationScores(sample, pixels);
  const focus = focusPoint(sample, pixels, averageLuminance);
  const dominantColors = dominantPalette(pixels);
  const safeArea = safeAreaFromInformation(information.left, information.right);
  const informationTotal = information.left + information.right;

  return Object.freeze({
    width: sample.width,
    height: sample.height,
    aspectRatio: rounded(sample.width / sample.height),
    averageLuminance: rounded(averageLuminance),
    dominantColors: Object.freeze(dominantColors),
    accentCandidate: accentFromPalette(dominantColors),
    leftInformationScore: rounded(information.left),
    rightInformationScore: rounded(information.right),
    focusX: rounded(focus.x),
    focusY: rounded(focus.y),
    safeArea,
    recommendedProfileId: dominantColors.length > 1 && informationTotal > 0.08
      ? "ling-immersive"
      : "ling-standard",
  });
}

function validateSample(sample: ThemeImageSample): void {
  if (
    !Number.isSafeInteger(sample.width)
    || !Number.isSafeInteger(sample.height)
    || sample.width <= 0
    || sample.height <= 0
    || sample.width > MAX_SAMPLE_EDGE
    || sample.height > MAX_SAMPLE_EDGE
  ) {
    throw new Error(`Theme image samples must be between 1 and ${MAX_SAMPLE_EDGE} pixels per edge.`);
  }
  if (!(sample.pixels instanceof Uint8ClampedArray) || sample.pixels.length !== sample.width * sample.height * 4) {
    throw new Error("Theme image sample pixels must be a complete RGBA Uint8ClampedArray.");
  }
}

function collectVisiblePixels(sample: ThemeImageSample): readonly SampledPixel[] {
  const result: SampledPixel[] = [];
  for (let y = 0; y < sample.height; y += 1) {
    for (let x = 0; x < sample.width; x += 1) {
      const offset = (y * sample.width + x) * 4;
      if (sample.pixels[offset + 3] < 16) continue;
      const r = sample.pixels[offset];
      const g = sample.pixels[offset + 1];
      const b = sample.pixels[offset + 2];
      result.push({
        x,
        y,
        r,
        g,
        b,
        luminance: relativeLuminance(r, g, b),
        saturation: saturation(r, g, b),
      });
    }
  }
  return result;
}

function informationScores(
  sample: ThemeImageSample,
  pixels: readonly SampledPixel[],
): { readonly left: number; readonly right: number } {
  const byPosition = new Map(pixels.map((pixel) => [`${pixel.x}:${pixel.y}`, pixel]));
  let left = 0;
  let right = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (const pixel of pixels) {
    const neighbors = [byPosition.get(`${pixel.x - 1}:${pixel.y}`), byPosition.get(`${pixel.x}:${pixel.y - 1}`)]
      .filter((value): value is SampledPixel => value !== undefined);
    const edge = neighbors.length === 0
      ? 0
      : neighbors.reduce((sum, neighbor) => sum + colorDistance(pixel, neighbor), 0) / neighbors.length;
    if (pixel.x < sample.width / 2) {
      left += edge;
      leftCount += 1;
    } else {
      right += edge;
      rightCount += 1;
    }
  }
  return {
    left: leftCount > 0 ? left / leftCount : 0,
    right: rightCount > 0 ? right / rightCount : 0,
  };
}

function focusPoint(
  sample: ThemeImageSample,
  pixels: readonly SampledPixel[],
  averageLuminance: number,
): { readonly x: number; readonly y: number } {
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const pixel of pixels) {
    const weight = 0.05 + pixel.saturation + Math.abs(pixel.luminance - averageLuminance);
    totalWeight += weight;
    weightedX += ((pixel.x + 0.5) / sample.width) * weight;
    weightedY += ((pixel.y + 0.5) / sample.height) * weight;
  }
  return totalWeight > 0
    ? { x: weightedX / totalWeight, y: weightedY / totalWeight }
    : { x: 0.5, y: 0.5 };
}

function dominantPalette(pixels: readonly SampledPixel[]): string[] {
  const counts = new Map<string, number>();
  for (const pixel of pixels) {
    const color = toHex(quantize(pixel.r), quantize(pixel.g), quantize(pixel.b));
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, DOMINANT_COLOR_LIMIT)
    .map(([color]) => color);
}

function accentFromPalette(colors: readonly string[]): string {
  return [...colors]
    .sort((left, right) => hexSaturation(right) - hexSaturation(left) || left.localeCompare(right))[0]
    ?? "#4f6f96";
}

function safeAreaFromInformation(left: number, right: number): ThemeImageAnalysis["safeArea"] {
  const difference = Math.abs(left - right);
  if (difference < 0.025) return "center";
  return left < right ? "left" : "right";
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function saturation(r: number, g: number, b: number): number {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  return maximum === 0 ? 0 : (maximum - minimum) / maximum;
}

function colorDistance(left: SampledPixel, right: SampledPixel): number {
  return (Math.abs(left.r - right.r) + Math.abs(left.g - right.g) + Math.abs(left.b - right.b)) / (255 * 3);
}

function quantize(channel: number): number {
  return Math.min(255, Math.round(channel / 32) * 32);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexSaturation(color: string): number {
  return saturation(
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  );
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
