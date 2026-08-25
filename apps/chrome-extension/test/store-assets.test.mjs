import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Chrome Web Store image candidates use the required dimensions", async () => {
  const assets = [
    ["store-assets/promo-440x280.png", 440, 280],
    ["store-assets/screenshots/plugin-manager-light-1280x800.png", 1280, 800],
    ["store-assets/screenshots/plugin-manager-dark-1280x800.png", 1280, 800],
    ["store-assets/source/ling-icon-512.png", 512, 512],
  ];

  for (const [path, width, height] of assets) {
    const image = await readFile(resolve(root, path));
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG", path);
    assert.equal(image.readUInt32BE(16), width, `${path} width`);
    assert.equal(image.readUInt32BE(20), height, `${path} height`);
  }
});

test("promotional image source uses the high-resolution committed Ling mark", async () => {
  const source = await readFile(resolve(root, "store-assets/source/promo-440x280.html"), "utf8");
  assert.match(source, /ling-icon-512\.png/u);
  assert.doesNotMatch(source, /<h1|<p|<span/u);
});
