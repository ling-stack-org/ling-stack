import { sniffThemeImageMime } from "../import/theme-image-validation.js";
import { BACKGROUND_LIMITS, BackgroundError, checkBackgroundDimensions } from "./background-model.js";

/** Bounded container preflight before browser/native decoding. Decoders still validate compressed pixels. */
export function inspectBackgroundImage(bytes: Uint8Array, fileName?: string, declaredMime?: string) {
  if (!bytes.length || bytes.length > BACKGROUND_LIMITS.bytes) throw new BackgroundError("capacity");
  const mimeType = sniffThemeImageMime(bytes);
  // The bytes are authoritative. File extensions and browser supplied MIME values
  // are advisory and can be wrong for files exported or renamed by desktop tools
  // (for example a JPEG saved with a `.png` name). The decoded content is still
  // fully validated below and normalized before it is stored as a background.
  void fileName;
  void declaredMime;
  if (!mimeType) throw new BackgroundError("invalid-image");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const invalid = (): never => { throw new BackgroundError("invalid-image"); };
  let width = 0, height = 0;
  if (mimeType === "image/png") {
    let offset = 8, data = false, end = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), type = text(offset + 4, 4);
      const next = offset + 12 + length;
      if (next > bytes.length || type === "acTL" || type === "fcTL" || type === "fdAT") invalid();
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) invalid();
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        checkBackgroundDimensions(width, height);
      } else if (type === "IHDR") invalid();
      if (type === "IDAT") data = true;
      if (type === "IEND") { if (length || next !== bytes.length || !data) invalid(); end = true; }
      offset = next;
    }
    if (!end || offset !== bytes.length) invalid();
  } else if (mimeType === "image/webp") {
    if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12, image = false, extended = false;
    const uint24 = (o: number) => bytes[o] + bytes[o + 1] * 256 + bytes[o + 2] * 65536;
    while (offset + 8 <= bytes.length) {
      const type = text(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      const next = start + length + (length % 2);
      if (next > bytes.length || type === "ANIM" || type === "ANMF") invalid();
      if (type === "VP8X") {
        if (length !== 10 || offset !== 12 || extended || image || (bytes[start] & 2)) invalid();
        extended = true;
        width = uint24(start + 4) + 1; height = uint24(start + 7) + 1;
      } else if (type === "VP8 ") {
        if (image || length < 10 || text(start + 3, 3) !== "\x9d\x01\x2a") invalid();
        const w = view.getUint16(start + 6, true) & 0x3fff, h = view.getUint16(start + 8, true) & 0x3fff;
        if (width && (width !== w || height !== h)) invalid();
        width = w; height = h; image = true;
      } else if (type === "VP8L") {
        if (image || length < 5 || bytes[start] !== 0x2f) invalid();
        const bits = view.getUint32(start + 1, true);
        const w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1;
        if (width && (width !== w || height !== h)) invalid();
        width = w; height = h; image = true;
      }
      if (width) checkBackgroundDimensions(width, height);
      offset = next;
    }
    if (!image || offset !== bytes.length) invalid();
  } else {
    if (bytes.length < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) invalid();
    let offset = 2, scan = false;
    while (offset + 2 <= bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) {
        if (offset + 2 > bytes.length) invalid();
        const length = view.getUint16(offset);
        if (length < 6 || offset + length > bytes.length - 2) invalid();
        scan = true; break;
      }
      if (marker === 0xd9 || marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
      if (offset + 2 > bytes.length) invalid();
      const length = view.getUint16(offset), next = offset + length;
      if (length < 2 || next > bytes.length - 2) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || width) invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
        checkBackgroundDimensions(width, height);
      }
      offset = next;
    }
    if (!scan) invalid();
  }
  checkBackgroundDimensions(width, height);
  return Object.freeze({ mimeType, width, height });
}
