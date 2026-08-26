import type { MediaProjectAssetContentType } from "@ling-stack/core";

export interface SupportedImageInspection {
  readonly contentType: MediaProjectAssetContentType;
  readonly width: number;
  readonly height: number;
}

export function inspectSupportedImage(content: Buffer): SupportedImageInspection | undefined {
  if (content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return inspectPng(content);
  }
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xd8) {
    return inspectJpeg(content);
  }
  if (
    content.length >= 12 &&
    content.toString("ascii", 0, 4) === "RIFF" &&
    content.toString("ascii", 8, 12) === "WEBP"
  ) {
    return inspectWebp(content);
  }
  return undefined;
}

function inspectPng(content: Buffer): SupportedImageInspection | undefined {
  let offset = 8;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  let sawImageData = false;
  while (offset + 12 <= content.length) {
    const length = content.readUInt32BE(offset);
    const type = content.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;
    if (nextOffset > content.length) return undefined;
    if (!dimensions) {
      if (type !== "IHDR" || length !== 13) return undefined;
      dimensions = {
        width: content.readUInt32BE(offset + 8),
        height: content.readUInt32BE(offset + 12),
      };
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || nextOffset !== content.length) return undefined;
      return { contentType: "image/png", ...dimensions };
    }
    offset = nextOffset;
  }
  return undefined;
}

function inspectJpeg(content: Buffer): SupportedImageInspection | undefined {
  if (content.length < 8 || content[content.length - 2] !== 0xff || content[content.length - 1] !== 0xd9) {
    return undefined;
  }
  let offset = 2;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  while (offset + 2 <= content.length - 2) {
    if (content[offset] !== 0xff) return undefined;
    while (offset < content.length && content[offset] === 0xff) offset += 1;
    if (offset >= content.length - 2) return undefined;
    const marker = content[offset];
    offset += 1;
    if (marker === 0xda) {
      if (offset + 2 > content.length - 2) return undefined;
      const length = content.readUInt16BE(offset);
      if (!dimensions || length < 2 || offset + length > content.length - 2) return undefined;
      return { contentType: "image/jpeg", ...dimensions };
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > content.length - 2) return undefined;
    const length = content.readUInt16BE(offset);
    if (length < 2 || offset + length > content.length - 2) return undefined;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return undefined;
      const height = content.readUInt16BE(offset + 3);
      const width = content.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return undefined;
      dimensions ??= { width, height };
    }
    offset += length;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function inspectWebp(content: Buffer): SupportedImageInspection | undefined {
  if (content.length < 20 || content.readUInt32LE(4) + 8 !== content.length) return undefined;
  let offset = 12;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  while (offset + 8 <= content.length) {
    const type = content.toString("ascii", offset, offset + 4);
    const length = content.readUInt32LE(offset + 4);
    const nextOffset = offset + 8 + length + (length % 2);
    if (nextOffset > content.length) return undefined;
    const dataOffset = offset + 8;
    const chunkDimensions = readWebpChunkDimensions(content, type, dataOffset, length);
    if (chunkDimensions === false) return undefined;
    dimensions ??= chunkDimensions || undefined;
    offset = nextOffset;
  }
  if (offset !== content.length || !dimensions || dimensions.width === 0 || dimensions.height === 0) {
    return undefined;
  }
  return { contentType: "image/webp", ...dimensions };
}

function readWebpChunkDimensions(
  content: Buffer,
  type: string,
  dataOffset: number,
  length: number,
): { readonly width: number; readonly height: number } | false | undefined {
  if (type === "VP8X") {
    if (length < 10) return false;
    return {
      width: 1 + content.readUIntLE(dataOffset + 4, 3),
      height: 1 + content.readUIntLE(dataOffset + 7, 3),
    };
  }
  if (type === "VP8 ") {
    if (
      length < 10 ||
      content[dataOffset + 3] !== 0x9d ||
      content[dataOffset + 4] !== 0x01 ||
      content[dataOffset + 5] !== 0x2a
    ) {
      return false;
    }
    return {
      width: content.readUInt16LE(dataOffset + 6) & 0x3fff,
      height: content.readUInt16LE(dataOffset + 8) & 0x3fff,
    };
  }
  if (type === "VP8L") {
    if (length < 5 || content[dataOffset] !== 0x2f) return false;
    const b1 = content[dataOffset + 1];
    const b2 = content[dataOffset + 2];
    const b3 = content[dataOffset + 3];
    const b4 = content[dataOffset + 4];
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  return undefined;
}
