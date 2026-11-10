import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_THEME_PACKAGE_LIMITS,
  LingThemePackageError,
  parseThemePackageBytes,
} from "../dist/index.js";
import {
  IMAGE_BYTES,
  appendBytes,
  cloneBytes,
  createZip,
  importedManifest,
  set16,
  set32,
  themePackageFixture,
  zipOffsets,
} from "./fixtures/theme-package-fixtures.mjs";

const decodeImage = async () => ({ width: 1280, height: 800 });

test("shared bytes parser normalizes token-only packages with optional preview and license", async () => {
  const tokenOnly = await parseThemePackageBytes(themePackageFixture(), { decodeImage });
  assert.equal(tokenOnly.manifest.id, "quiet-focus");
  assert.equal(tokenOnly.manifest.source, "local-import");
  assert.equal(tokenOnly.packageChecksumSha256.length, 64);
  assert.equal(tokenOnly.preview, undefined);
  assert.equal(tokenOnly.licenseText, undefined);
  assert.deepEqual(tokenOnly.files.map((file) => file.path), ["theme.json"]);
  assert.equal(new TextDecoder().decode(tokenOnly.files[0].bytes).endsWith("\n"), true);

  const withAssets = await parseThemePackageBytes(themePackageFixture({
    license: "MIT fixture license",
    manifest: importedManifest({ preview: "assets/preview.png" }),
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
  }), { decodeImage });
  assert.equal(withAssets.licenseText, "MIT fixture license");
  assert.equal(withAssets.preview?.mimeType, "image/png");
  assert.equal(withAssets.preview?.width, 1280);
  assert.equal(withAssets.preview?.height, 800);
  assert.equal(withAssets.preview?.checksumSha256.length, 64);
  assert.deepEqual(withAssets.files.map((file) => file.path), ["LICENSE.txt", "assets/preview.png", "theme.json"]);
});

test("shared bytes parser rejects empty, oversized, malformed, split, ZIP64, encrypted, unsupported and trailing archives", async () => {
  await rejectsCode(new Uint8Array(), "archive-empty");
  await rejectsCode(new Uint8Array(LING_THEME_PACKAGE_LIMITS.archiveBytes + 1), "archive-too-large");
  await rejectsCode(Uint8Array.from([1, 2, 3]), "invalid-archive");

  const base = themePackageFixture();
  const split = cloneBytes(base);
  set16(split, zipOffsets(split).eocd + 4, 1);
  await rejectsCode(split, "unsupported-archive");

  const zip64 = cloneBytes(base);
  set16(zip64, zipOffsets(zip64).eocd + 10, 0xffff);
  await rejectsCode(zip64, "unsupported-archive");

  const encrypted = cloneBytes(base);
  const encryptedOffsets = zipOffsets(encrypted);
  set16(encrypted, encryptedOffsets.central + 8, 1);
  set16(encrypted, encryptedOffsets.local + 6, 1);
  await rejectsCode(encrypted, "unsupported-archive");

  const unsupported = cloneBytes(base);
  const unsupportedOffsets = zipOffsets(unsupported);
  set16(unsupported, unsupportedOffsets.central + 10, 99);
  set16(unsupported, unsupportedOffsets.local + 8, 99);
  await rejectsCode(unsupported, "unsupported-archive");

  await rejectsCode(appendBytes(base, [0xde, 0xad]), "invalid-archive");
});

test("shared bytes parser rejects local metadata, CRC and actual size mismatches", async () => {
  const base = themePackageFixture();
  const localMismatch = cloneBytes(base);
  const localMismatchOffsets = zipOffsets(localMismatch);
  set16(localMismatch, localMismatchOffsets.local + 8, 0);
  await rejectsCode(localMismatch, "invalid-archive");

  const crcMismatch = cloneBytes(base);
  const crcOffsets = zipOffsets(crcMismatch);
  set32(crcMismatch, crcOffsets.central + 16, 0);
  set32(crcMismatch, crcOffsets.local + 14, 0);
  await rejectsCode(crcMismatch, "invalid-entry-crc");

  const sizeMismatch = cloneBytes(base);
  const sizeOffsets = zipOffsets(sizeMismatch);
  const view = new DataView(sizeMismatch.buffer, sizeMismatch.byteOffset, sizeMismatch.byteLength);
  const declared = view.getUint32(sizeOffsets.central + 24, true);
  set32(sizeMismatch, sizeOffsets.central + 24, declared - 1);
  set32(sizeMismatch, sizeOffsets.local + 22, declared - 1);
  await rejectsCode(sizeMismatch, "invalid-entry-size");
});

test("shared bytes parser rejects unsafe, duplicate-case and non-portable paths", async () => {
  for (const path of [
    "/theme.json",
    "C:/theme.json",
    "\\\\server\\share\\theme.json",
    "../theme.json",
    "theme\u0000.json",
    "主题.json",
  ]) {
    await rejectsCode(createZip([{ name: path, bytes: "{}" }]), "unsafe-path");
  }
  await rejectsCode(createZip([
    { name: "theme.json", bytes: "{}" },
    { name: "THEME.JSON", bytes: "{}" },
  ]), "duplicate-path");
});

test("shared bytes parser rejects symlink and special Unix entries", async () => {
  await rejectsCode(themePackageFixture({
    extraEntries: [{ name: "assets/link.png", bytes: "theme.json", mode: 0o120777 }],
  }), "unsupported-entry");
  await rejectsCode(themePackageFixture({
    extraEntries: [{ name: "assets/socket.png", bytes: "", mode: 0o140777 }],
  }), "unsupported-entry");
});

test("shared bytes parser enforces allowlisted files and referenced assets", async () => {
  await rejectsCode(themePackageFixture({
    extraEntries: [{ name: "payload.js", bytes: "alert(1)" }],
  }), "unsupported-file");
  await rejectsCode(themePackageFixture({
    extraEntries: [{ name: "assets/unused.png", bytes: IMAGE_BYTES.png }],
  }), "unreferenced-asset");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/missing.png" }),
  }), "missing-preview");
});

test("shared bytes parser rejects invalid text, JSON, schema, tokens, contrast and reserved IDs", async () => {
  await rejectsCode(createZip([{ name: "theme.json", bytes: Uint8Array.from([0xc3, 0x28]) }]), "invalid-text");
  await rejectsCode(createZip([{ name: "theme.json", bytes: "{" }]), "invalid-manifest");
  await rejectsCode(themePackageFixture({ manifest: importedManifest({ schemaVersion: 2 }) }), "invalid-schema");
  await rejectsCode(themePackageFixture({ manifest: importedManifest({ tokens: {} }) }), "missing-token");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({
      tokens: {
        ...importedManifest().tokens,
        text: { ...importedManifest().tokens.text, default: "#ffffff" },
      },
    }),
  }), "insufficient-contrast");
  await rejectsCode(themePackageFixture({ manifest: importedManifest({ id: "ling-replacement" }) }), "reserved-id");
  await rejectsCode(themePackageFixture({ manifest: importedManifest({ id: "con" }) }), "reserved-id");
});

test("shared bytes parser rejects runtime artwork, unknown presentation payloads and remote preview references", async () => {
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ artwork: { assets: [] } }),
  }), "runtime-artwork-not-supported");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ presentation: { profileId: "unregistered-layout" } }),
  }), "invalid-presentation");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "https://example.test/preview.png" }),
  }), "invalid-artwork");
});

test("shared image validation enforces extension, magic, decode and dimension parity", async () => {
  const formats = [
    ["assets/preview.png", IMAGE_BYTES.png, "image/png"],
    ["assets/preview.jpg", IMAGE_BYTES.jpeg, "image/jpeg"],
    ["assets/preview.webp", IMAGE_BYTES.webp, "image/webp"],
  ];
  for (const [path, bytes, mimeType] of formats) {
    const archive = themePackageFixture({
      manifest: importedManifest({ preview: path }),
      preview: { path, bytes },
    });
    const webResult = await parseThemePackageBytes(archive, { decodeImage: async () => ({ width: 960, height: 600 }) });
    const desktopResult = await parseThemePackageBytes(archive, { decodeImage: async () => ({ width: 960, height: 600 }) });
    assert.deepEqual(normalizedPreview(webResult.preview), normalizedPreview(desktopResult.preview));
    assert.equal(webResult.preview?.mimeType, mimeType);
  }

  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/preview.jpg" }),
    preview: { path: "assets/preview.jpg", bytes: IMAGE_BYTES.png },
  }), "invalid-preview-mime");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/preview.png" }),
    preview: { path: "assets/preview.png", bytes: Uint8Array.from([1, 2, 3]) },
  }), "invalid-preview-mime");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/preview.png" }),
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
  }), "invalid-preview-image", async () => { throw new Error("fixture decode failure"); });
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/preview.png" }),
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
  }), "invalid-preview-dimensions", async () => ({ width: 9000, height: 100 }));
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ preview: "assets/preview.png" }),
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
  }), "invalid-preview-dimensions", async () => ({ width: 8000, height: 5000 }));
});

test("shared bytes parser supports bounded data descriptors and rejects descriptor tampering", async () => {
  const archive = createZip([{ name: "theme.json", bytes: JSON.stringify(importedManifest()), compression: "deflate", dataDescriptor: true }]);
  assert.equal((await parseThemePackageBytes(archive, { decodeImage })).manifest.id, "quiet-focus");

  const tampered = cloneBytes(archive);
  const { central } = zipOffsets(tampered);
  set32(tampered, central - 12, 0);
  await rejectsCode(tampered, "invalid-archive");
});

function normalizedPreview(preview) {
  return preview && {
    byteLength: preview.byteLength,
    checksumSha256: preview.checksumSha256,
    height: preview.height,
    mimeType: preview.mimeType,
    path: preview.path,
    width: preview.width,
  };
}

async function rejectsCode(bytes, code, decoder = decodeImage) {
  await assert.rejects(
    () => parseThemePackageBytes(bytes, { decodeImage: decoder }),
    (error) => {
      assert.equal(error instanceof LingThemePackageError, true);
      assert.equal(error.issues.some((issue) => issue.code === code), true, JSON.stringify(error.issues));
      return true;
    },
  );
}
