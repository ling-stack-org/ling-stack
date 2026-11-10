import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { readonlyImageArguments, summarizeUngoogledPack, validateUngoogledAppInfo, validateReadonlyMount } from "./inspect-ungoogled-dmg.mjs";

function pack(payloads) {
  const start = 12 + (payloads.length + 1) * 6, bytes = Buffer.alloc(start + payloads.reduce((n, b) => n + b.length, 0));
  bytes.writeUInt32LE(5, 0); bytes[4] = 1; bytes.writeUInt16LE(payloads.length, 8);
  let offset = start;
  for (const [i, payload] of payloads.entries()) {
    bytes.writeUInt16LE(i + 1, 12 + i * 6); bytes.writeUInt32LE(offset, 14 + i * 6);
    payload.copy(bytes, offset); offset += payload.length;
  }
  bytes.writeUInt32LE(offset, 14 + payloads.length * 6);
  return bytes;
}
const credits = Buffer.from('<html><title>Credits</title>\n' + 'Permission is hereby granted, free of charge\n'.repeat(12) + '</html>\n');

test("actual Chromium Mac bundle uses BUILD.PATCH for CFBundleVersion and the full version for CFBundleShortVersionString", () => {
  const info = { CFBundleVersion: "8037.97", CFBundleShortVersionString: "154.0.8037.97",
    CFBundleIdentifier: "org.chromium.Chromium", CFBundleExecutable: "Chromium" };
  validateUngoogledAppInfo(info, "154.0.8037.97");
  for (const changed of [{ CFBundleVersion: "8037.96" }, { CFBundleShortVersionString: "154.0.8037.96" },
    { CFBundleShortVersionString: "151.0.8037.97" }, { CFBundleIdentifier: "other.app" }, { CFBundleExecutable: "other" }]) {
    assert.throws(() => validateUngoogledAppInfo({ ...info, ...changed }, "154.0.8037.97"), /app_version_invalid/);
  }
});

test("DMG inspection requests read-only noninteractive mounting into an explicitly owned absolute directory", () => {
  const args = readonlyImageArguments("/owned/candidate/browser.dmg", "/owned/staging/mount");
  assert.deepEqual(args, ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", "/owned/staging/mount", "-plist", "/owned/candidate/browser.dmg"]);
  for (const [image, mount] of [["relative", "/absolute"], ["/absolute", "relative"], ["/bad\0image", "/absolute"]]) {
    assert.throws(() => readonlyImageArguments(image, mount), /mount_path_invalid/);
  }
});

test("mount inspection verifies the actual image path, owned mountpoint and read-only status", () => {
  const image = { "image-path": "/owned/browser.dmg", writeable: false,
    "system-entities": [{ "mount-point": "/owned/staging/mount" }] };
  validateReadonlyMount({ images: [image] }, "/owned/browser.dmg", "/owned/staging/mount");
  for (const images of [[], [image, image], [{ ...image, writeable: true }],
    [{ ...image, "image-path": "/foreign/browser.dmg" }], [{ ...image, "system-entities": [{ "mount-point": "/foreign/mount" }] }]]) {
    assert.throws(() => validateReadonlyMount({ images }, "/owned/browser.dmg", "/owned/staging/mount"), /mount_not_readonly/);
  }
});

test("compiled resource inspection preserves all resources and full original credits without treating them as redistribution approval", () => {
  const result = summarizeUngoogledPack(pack([Buffer.from("ordinary resource"), gzipSync(credits), gzipSync(Buffer.alloc(0))]));
  assert.equal(result.resources.length, 3);
  assert.equal(result.credits.length, 1);
  assert.deepEqual(result.credits[0].bytes, credits);
  assert.equal(result.credits[0].resourceId, 2);
  assert.equal(result.credits[0].placeholder, false);
  assert.equal(result.credits[0].permissiveGrantCount, 12);
  assert.equal(result.credits[0].checksum, `sha256:${createHash("sha256").update(credits).digest("hex")}`);
});

test("placeholder credits and missing credit pages stay distinguishable from real notices", () => {
  const placeholder = Buffer.from('<html><title>Credits</title>This is sample credits page. generate_about_credits=true</html>');
  const result = summarizeUngoogledPack(pack([placeholder]));
  assert.equal(result.credits[0].placeholder, true);
  assert.equal(result.credits[0].permissiveGrantCount, 0);
  assert.equal(summarizeUngoogledPack(pack([Buffer.from("no credits")])).credits.length, 0);
});

test("corrupt resource offsets and compressed payloads fail inspection rather than silently losing instructions or credits", () => {
  const corrupt = pack([credits]); corrupt.writeUInt32LE(0, 14);
  assert.throws(() => summarizeUngoogledPack(corrupt), /pack_/);
  const compressed = gzipSync(credits); compressed[compressed.length - 1] ^= 1;
  assert.throws(() => summarizeUngoogledPack(pack([compressed])), /pack_/);
});
