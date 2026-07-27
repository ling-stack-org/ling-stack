import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { Locator } from "@playwright/test";

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

export interface PngPixelAnalysis extends PngDimensions {
  readonly decodedPixelHash: string;
  readonly uniqueColors: number;
  readonly opaqueRatio: number;
  readonly nonDominantRatio: number;
}

export interface VisualEffectSnapshot {
  readonly node: string;
  readonly filter: string;
  readonly opacity: string;
  readonly mixBlendMode: string;
}

interface DecodedPng extends PngDimensions {
  readonly rgba: Buffer;
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function sha256(buffer: Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function pngDimensions(buffer: Buffer): PngDimensions {
  assertPngSignature(buffer);
  if (buffer.length < 33 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Evidence PNG does not contain a valid IHDR chunk");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export function decodedPngPixelHash(buffer: Buffer, cropInset = 0): string {
  const decoded = decodePng(buffer);
  return sha256(cropRgba(decoded.rgba, decoded.width, decoded.height, cropInset));
}

export function analyzePngPixels(buffer: Buffer, cropInset = 0): PngPixelAnalysis {
  const decoded = decodePng(buffer);
  const rgba = cropRgba(decoded.rgba, decoded.width, decoded.height, cropInset);
  const width = decoded.width - cropInset * 2;
  const height = decoded.height - cropInset * 2;
  const colors = new Map<number, number>();
  let opaquePixels = 0;

  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset] ?? 0;
    const green = rgba[offset + 1] ?? 0;
    const blue = rgba[offset + 2] ?? 0;
    const alpha = rgba[offset + 3] ?? 0;
    if (alpha === 255) opaquePixels += 1;
    const color = (((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0);
    colors.set(color, (colors.get(color) ?? 0) + 1);
  }

  const totalPixels = width * height;
  const dominantPixels = Math.max(0, ...colors.values());
  return {
    width,
    height,
    decodedPixelHash: sha256(rgba),
    uniqueColors: colors.size,
    opaqueRatio: totalPixels > 0 ? opaquePixels / totalPixels : 0,
    nonDominantRatio: totalPixels > 0 ? (totalPixels - dominantPixels) / totalPixels : 0,
  };
}

export async function visualEffectChain(
  locator: Locator,
  stopAtSelector?: string,
): Promise<readonly VisualEffectSnapshot[]> {
  return locator.evaluate((element, boundarySelector) => {
    const snapshots: VisualEffectSnapshot[] = [];
    let current: Element | null = element;
    while (current) {
      const style = getComputedStyle(current);
      snapshots.push({
        node: `${current.tagName.toLowerCase()}${current.classList.length ? `.${[...current.classList].join(".")}` : ""}`,
        filter: style.filter,
        opacity: style.opacity,
        mixBlendMode: style.mixBlendMode,
      });
      if (boundarySelector && current.matches(boundarySelector)) break;
      current = current.parentElement;
    }
    return snapshots;
  }, stopAtSelector);
}

function decodePng(buffer: Buffer): DecodedPng {
  const { width, height } = pngDimensions(buffer);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported evidence PNG format: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }

  const idatChunks: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    if (offset + 12 > buffer.length) throw new Error("Evidence PNG contains a truncated chunk header");
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + length + 12;
    if (chunkEnd > buffer.length) throw new Error("Evidence PNG contains a truncated chunk body");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset = chunkEnd;
  }
  if (idatChunks.length === 0) throw new Error("Evidence PNG does not contain image data");

  const packed = inflateSync(Buffer.concat(idatChunks));
  const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * sourceBytesPerPixel;
  const expectedPackedBytes = (rowBytes + 1) * height;
  if (packed.length !== expectedPackedBytes) {
    throw new Error(`Unexpected evidence PNG payload length: expected=${expectedPackedBytes}, actual=${packed.length}`);
  }

  const sourcePixels = Buffer.alloc(rowBytes * height);
  let packedOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = packed[packedOffset] ?? 0;
    packedOffset += 1;
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = packed[packedOffset + column] ?? 0;
      const left = column >= sourceBytesPerPixel
        ? sourcePixels[rowOffset + column - sourceBytesPerPixel] ?? 0
        : 0;
      const up = row > 0 ? sourcePixels[rowOffset + column - rowBytes] ?? 0 : 0;
      const upLeft = row > 0 && column >= sourceBytesPerPixel
        ? sourcePixels[rowOffset + column - rowBytes - sourceBytesPerPixel] ?? 0
        : 0;
      sourcePixels[rowOffset + column] = (encoded + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
    }
    packedOffset += rowBytes;
  }

  if (sourceBytesPerPixel === 4) return { width, height, rgba: sourcePixels };
  const rgba = Buffer.alloc(width * height * 4);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < sourcePixels.length; sourceOffset += 3, targetOffset += 4) {
    rgba[targetOffset] = sourcePixels[sourceOffset] ?? 0;
    rgba[targetOffset + 1] = sourcePixels[sourceOffset + 1] ?? 0;
    rgba[targetOffset + 2] = sourcePixels[sourceOffset + 2] ?? 0;
    rgba[targetOffset + 3] = 255;
  }
  return { width, height, rgba };
}

function cropRgba(rgba: Buffer, width: number, height: number, cropInset: number): Buffer {
  if (!Number.isInteger(cropInset) || cropInset < 0) throw new Error("PNG crop inset must be a non-negative integer");
  if (cropInset === 0) return rgba;
  if (width <= cropInset * 2 || height <= cropInset * 2) throw new Error("Evidence PNG is too small to crop");

  const croppedWidth = width - cropInset * 2;
  const croppedHeight = height - cropInset * 2;
  const sourceRowBytes = width * 4;
  const targetRowBytes = croppedWidth * 4;
  const cropped = Buffer.alloc(targetRowBytes * croppedHeight);
  for (let row = cropInset; row < height - cropInset; row += 1) {
    const sourceStart = row * sourceRowBytes + cropInset * 4;
    rgba.copy(cropped, (row - cropInset) * targetRowBytes, sourceStart, sourceStart + targetRowBytes);
  }
  return cropped;
}

function assertPngSignature(buffer: Buffer): void {
  if (buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error("Evidence buffer is not a PNG image");
  }
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonalDistance = Math.abs(estimate - upLeft);
    return leftDistance <= upDistance && leftDistance <= diagonalDistance
      ? left
      : upDistance <= diagonalDistance ? up : upLeft;
  }
  throw new Error(`Unsupported PNG row filter: ${filter}`);
}
