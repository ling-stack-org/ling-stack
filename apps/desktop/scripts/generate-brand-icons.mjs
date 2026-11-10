import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { brandRoot, encodeIcns, encodeIco, macSlots, pngSizes, renderBrandIcon, repoRoot, windowsSizes } from "./brand-icon-assets.mjs";

const output = resolve(repoRoot, ".codex-artifacts/brand-icons");
async function write(path, bytes) {
  const target = resolve(repoRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

const frames = new Map();
for (const size of pngSizes) {
  const frame = await renderBrandIcon(size);
  frames.set(size, frame);
  await write(`${output}/png/ling-${size}.png`, frame.png);
}
const native = [];
for (const slot of macSlots) {
  const frame = await renderBrandIcon(slot.size, slot.logical);
  native.push({ slot, ...frame });
  await write(`${output}/Ling.iconset/icon_${slot.name}.png`, frame.png);
}
await write("apps/desktop/build/icon.icns", encodeIcns(native));
await write("apps/desktop/build/icon.ico", encodeIco(windowsSizes.map((size) => ({ size, png: frames.get(size).png }))));
await write("apps/web/public/favicon.svg", await readFile(new URL("ling-mark-micro.svg", brandRoot)));
await write("apps/web/public/favicon.png", frames.get(64).png);
for (const size of [16, 32, 48, 128]) {
  await write(`apps/chrome-extension/assets/icon-${size}.png`, frames.get(size).png);
}
await write("apps/chrome-extension/store-assets/source/ling-icon-512.png", frames.get(512).png);

const proof = createCanvas(1440, 920);
const ctx = proof.getContext("2d");
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";
ctx.fillStyle = "#eef0f2";
ctx.fillRect(0, 0, 1440, 920);
ctx.fillStyle = "#191c1f";
ctx.font = "600 26px sans-serif";
ctx.fillText("Ling / all-size vector exports", 32, 42);
ctx.font = "15px sans-serif";
ctx.fillText("Asset proof, not an app screenshot. Native sizes through 128px; large frames displayed at 128px.", 32, 70);
for (const [row, background, foreground] of [[0, "#ffffff", "#191c1f"], [1, "#1f1f1f", "#ffffff"]]) {
  const top = 94 + row * 408;
  ctx.fillStyle = background;
  ctx.fillRect(24, top, 1392, 390);
  for (const [index, size] of pngSizes.entries()) {
    const col = index % 7;
    const line = Math.floor(index / 7);
    const x = 36 + col * 194;
    const y = top + line * 190;
    const display = Math.min(size, 128);
    ctx.drawImage(frames.get(size).canvas, x + (184 - display) / 2, y + 18 + (138 - display) / 2, display, display);
    ctx.fillStyle = foreground;
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${size}px`, x + 92, y + 176);
    ctx.textAlign = "left";
  }
}
await write(`${output}/all-sizes.png`, proof.toBuffer("image/png"));
console.log(`Updated Web, macOS, Windows and Chrome brand assets. ${pngSizes.length} PNG sizes: ${output}`);
