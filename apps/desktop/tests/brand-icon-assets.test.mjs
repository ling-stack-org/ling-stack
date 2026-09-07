import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { brandRoot, macSlots, pngSizes, renderBrandIcon, repoRoot } from "../scripts/brand-icon-assets.mjs";
import { inspectIcoFrames } from "./verify-windows-app-icons.mjs";

function pixels(canvas) {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

async function decode(source, size) {
  const image = await loadImage(source);
  assert.equal(image.width, size);
  assert.equal(image.height, size);
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

function assertVisibleTransparentIcon(canvas) {
  const size = canvas.width;
  const data = pixels(canvas);
  let visible = 0;
  let solid = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = data[(y * size + x) * 4 + 3];
      if (alpha) visible += 1;
      if (alpha === 255) solid += 1;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) assert.equal(alpha, 0, `${size}px margin`);
    }
  }
  assert.ok(visible > size * size * 0.25 && visible < size * size * 0.85);
  assert.ok(solid > visible * 0.35);
}

function assertSameArtwork(actual, expected) {
  assertVisibleTransparentIcon(actual);
  const a = pixels(actual);
  const b = pixels(expected);
  let total = 0;
  for (let pixel = 0; pixel < a.length; pixel += 4) {
    total += Math.abs(a[pixel + 3] - b[pixel + 3]);
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs(a[pixel + channel] * a[pixel + 3] - b[pixel + channel] * b[pixel + 3]) / 255;
    }
  }
  // Permit subpixel antialiasing differences between supported canvas versions.
  assert.ok(total / a.length < 1.5, `Packaged artwork differs from the vector master: ${total / a.length}`);
}

function assertCrispExteriorEdges(canvas) {
  const size = canvas.width;
  const data = pixels(canvas);
  // Sample straight silhouette segments, away from rounded corners and joins.
  for (const ratio of [0.22, 0.3, 0.38]) {
    const y = Math.floor(size * ratio);
    for (const direction of [1, -1]) {
      let x = direction === 1 ? 0 : size - 1;
      const alpha = () => data[(y * size + x) * 4 + 3];
      while (x >= 0 && x < size && alpha() === 0) x += direction;
      assert.ok(x >= 0 && x < size, `Missing silhouette at ${size}px, row ${y}`);
      const start = x;
      while (x >= 0 && x < size && alpha() < 255) x += direction;
      assert.ok(x >= 0 && x < size, `Missing opaque interior at ${size}px, row ${y}`);
      assert.ok(Math.abs(x - start) <= 3,
        `Blurred exterior edge at ${size}px, row ${y}: ${Math.abs(x - start)} transition pixels`);
    }
  }
}

test("brand masters remain vector-only and render with transparent margins at every export size", async () => {
  for (const name of ["ling-mark.svg", "ling-mark-compact.svg", "ling-mark-micro.svg"]) {
    const source = await readFile(new URL(name, brandRoot), "utf8");
    assert.doesNotMatch(source, /<(?:image|filter|script|foreignObject)\b|data:|feGaussianBlur/);
    assert.equal((source.match(/<circle\b/g) ?? []).length, 5);
  }
  for (const size of pngSizes) assertVisibleTransparentIcon((await renderBrandIcon(size)).canvas);
});

test("large exports retain native-resolution edges and reject enlarged 256px artwork", async () => {
  const small = (await renderBrandIcon(256)).canvas;
  assertCrispExteriorEdges(small);
  for (const size of pngSizes.filter((value) => value > 256)) {
    const frame = await renderBrandIcon(size);
    assertCrispExteriorEdges(await decode(frame.png, size));

    const enlarged = createCanvas(size, size);
    const context = enlarged.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(small, 0, 0, size, size);
    assert.throws(() => assertCrispExteriorEdges(enlarged), /Blurred exterior edge/);
  }
});

test("Windows and Chrome frames match the correct optical vector master", async () => {
  const ico = await readFile(resolve(repoRoot, "apps/desktop/build/icon.ico"));
  for (const frame of inspectIcoFrames(ico)) {
    assert.equal(frame.bitCount, 32);
    assertSameArtwork(await decode(frame.data, frame.width), (await renderBrandIcon(frame.width)).canvas);
  }
  for (const size of [16, 32, 48, 128]) {
    const icon = resolve(repoRoot, `apps/chrome-extension/assets/icon-${size}.png`);
    assertSameArtwork(await decode(icon, size), (await renderBrandIcon(size)).canvas);
  }
  assertSameArtwork(await decode(resolve(repoRoot, "apps/web/public/favicon.png"), 64), (await renderBrandIcon(64)).canvas);
  assert.equal(await readFile(resolve(repoRoot, "apps/web/public/favicon.svg"), "utf8"),
    await readFile(new URL("ling-mark-micro.svg", brandRoot), "utf8"));
  assertSameArtwork(await decode(resolve(repoRoot, "apps/chrome-extension/store-assets/source/ling-icon-512.png"), 512),
    (await renderBrandIcon(512)).canvas);
});

test("macOS system decoder preserves all standard and Retina optical representations", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-brand-roundtrip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = resolve(directory, "Ling.iconset");
  execFileSync("iconutil", ["-c", "iconset", resolve(repoRoot, "apps/desktop/build/icon.icns"), "-o", output]);
  for (const slot of macSlots) {
    const actual = await decode(resolve(output, `icon_${slot.name}.png`), slot.size);
    const expected = (await renderBrandIcon(slot.size, slot.logical)).canvas;
    assertSameArtwork(actual, expected);
    if (slot.size >= 256) assertCrispExteriorEdges(actual);
    if (slot.argb) {
      const a = pixels(actual);
      const b = pixels(expected);
      for (let pixel = 0; pixel < a.length; pixel += 4) {
        assert.equal(a[pixel + 3], b[pixel + 3]);
        for (let channel = 0; channel < 3; channel += 1) {
          assert.ok(Math.abs(a[pixel + channel] - b[pixel + channel]) * a[pixel + 3] / 255 <= 1.01);
        }
      }
    }
  }
});
