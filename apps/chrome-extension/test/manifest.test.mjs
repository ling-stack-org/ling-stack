import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Chrome manifest uses the stable development identity and minimal V1 permissions", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const extensionId = [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
  assert.equal(extensionId, "ggmhibjboaedlnidbemkefonahjgcapc");
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "storage"]);
  for (const forbidden of ["cookies", "debugger", "downloads", "history", "bookmarks", "nativeMessaging", "webRequest"]) {
    assert.equal(manifest.permissions.includes(forbidden), false);
  }
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal("content_scripts" in manifest, false);
  assert.deepEqual(manifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
});

test("Chrome package uses store-ready Ling icons at every manifest size", async () => {
  for (const size of [16, 32, 48, 128]) {
    const icon = await readFile(resolve(root, `assets/icon-${size}.png`));
    assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
    assert.equal(icon[25], 6);
  }
});
