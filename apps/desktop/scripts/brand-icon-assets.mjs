import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export const brandRoot = new URL("../../web/public/icons/", import.meta.url);
export const pngSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096];
export const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
export const macSlots = [
  { name: "16x16", type: "ic04", size: 16, logical: 16, argb: true },
  { name: "16x16@2x", type: "ic11", size: 32, logical: 16 },
  { name: "32x32", type: "ic05", size: 32, logical: 32, argb: true },
  { name: "32x32@2x", type: "ic12", size: 64, logical: 32 },
  { name: "128x128", type: "ic07", size: 128, logical: 128 },
  { name: "128x128@2x", type: "ic13", size: 256, logical: 128 },
  { name: "256x256", type: "ic08", size: 256, logical: 256 },
  { name: "256x256@2x", type: "ic14", size: 512, logical: 256 },
  { name: "512x512", type: "ic09", size: 512, logical: 512 },
  { name: "512x512@2x", type: "ic10", size: 1024, logical: 512 },
];

export function variantForSize(size) {
  return size <= 24 ? "ling-mark-micro.svg" : size <= 64 ? "ling-mark-compact.svg" : "ling-mark.svg";
}

export async function renderBrandIcon(size, logicalSize = size) {
  const source = await readFile(new URL(variantForSize(logicalSize), brandRoot), "utf8");
  const sized = source.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const image = await loadImage(Buffer.from(sized));
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return { canvas, png: canvas.toBuffer("image/png") };
}

export function encodeIco(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...frames.map(({ png }) => png)]);
}

export function encodeIcns(frames) {
  const chunks = frames.map(({ slot, canvas, png }) => {
    const payload = slot.argb ? encodeArgb(canvas) : png;
    const header = Buffer.alloc(8);
    header.write(slot.type, 0, "ascii");
    header.writeUInt32BE(8 + payload.length, 4);
    return Buffer.concat([header, payload]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

// macOS standard 16/32px representations need premultiplied ARGB planes.
// Writing straight-alpha RGB here creates pale fringes on dark backgrounds.
function encodeArgb(canvas) {
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const parts = [Buffer.from("ARGB")];
  for (const channel of [3, 0, 1, 2]) {
    const plane = Buffer.alloc(canvas.width * canvas.height);
    for (let pixel = 0; pixel < plane.length; pixel += 1) {
      plane[pixel] = channel === 3 ? data[pixel * 4 + 3]
        : Math.round(data[pixel * 4 + channel] * data[pixel * 4 + 3] / 255);
    }
    for (let offset = 0; offset < plane.length; offset += 128) {
      const run = plane.subarray(offset, offset + 128);
      parts.push(Buffer.from([run.length - 1]), run);
    }
  }
  return Buffer.concat(parts);
}

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
