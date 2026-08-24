import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Chrome manifest uses the Web Store production identity and minimal Native Host permissions", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const extensionId = [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
  assert.equal(extensionId, "mbmlnnfhebclljonhedpjghbhibfapei");
  assert.equal(manifest.version, "0.1.2");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "nativeMessaging", "scripting", "storage"]);
  for (const forbidden of ["cookies", "debugger", "downloads", "history", "bookmarks", "webRequest"]) {
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

test("Chrome popup contains no workspace, daemon, pairing, or consent controls", async () => {
  const [html, script] = await Promise.all([
    readFile(resolve(root, "src/popup.html"), "utf8"),
    readFile(resolve(root, "src/popup.js"), "utf8"),
  ]);
  for (const forbidden of ["pairing-code", 'id="cwd"', 'id="consent"', "daemonBaseUrl"]) {
    assert.equal(html.includes(forbidden), false);
    assert.equal(script.includes(forbidden), false);
  }
  assert.match(html, /id="primary-action"/u);
  assert.match(script, /currentState === "connected" \? "pause" : "resume"/u);
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
