import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_THEME_PACKAGE_LIMITS,
  normalizeThemePackagePath,
  validateThemePackageIndex,
} from "../dist/index.js";

test("theme package index accepts one canonical manifest and one preview asset", () => {
  const result = validateThemePackageIndex(2048, [
    entry("theme.json", 800),
    entry("LICENSE.txt", 120),
    entry("assets/", 0, "directory"),
    entry("assets/preview.webp", 1024),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.files.length, 3);
  assert.equal(result.ok && result.totalUncompressedBytes, 1944);
});

test("theme package index rejects traversal, case-folded duplicates, special files, and unknown content", () => {
  const result = validateThemePackageIndex(4096, [
    entry("theme.json", 800),
    entry("THEME.JSON", 800),
    entry("assets/../escape.webp", 100),
    entry("assets/link.webp", 10, "symlink"),
    entry("payload.js", 20),
  ]);
  assert.equal(result.ok, false);
  const codes = new Set(result.ok ? [] : result.issues.map((issue) => issue.code));
  assert.equal(codes.has("duplicate-path"), true);
  assert.equal(codes.has("unsafe-path"), true);
  assert.equal(codes.has("unsupported-entry"), true);
  assert.equal(codes.has("unsupported-file"), true);
});

test("theme package index enforces archive, file, count, and uncompressed budgets", () => {
  assert.equal(validateThemePackageIndex(LING_THEME_PACKAGE_LIMITS.archiveBytes + 1, [entry("theme.json", 1)]).ok, false);
  assert.equal(validateThemePackageIndex(100, [entry("theme.json", LING_THEME_PACKAGE_LIMITS.manifestBytes + 1)]).ok, false);
  const tooMany = Array.from({ length: LING_THEME_PACKAGE_LIMITS.fileCount + 1 }, (_, index) => (
    index === 0 ? entry("theme.json", 1) : entry(`assets/${index}.png`, 1)
  ));
  assert.equal(validateThemePackageIndex(100, tooMany).ok, false);
  const oversized = [
    entry("theme.json", 1),
    entry("assets/preview.webp", LING_THEME_PACKAGE_LIMITS.totalUncompressedBytes),
  ];
  assert.equal(validateThemePackageIndex(100, oversized).ok, false);
});

test("theme package path normalization is strict and platform-independent", () => {
  assert.equal(normalizeThemePackagePath("assets/preview.webp"), "assets/preview.webp");
  assert.equal(normalizeThemePackagePath("assets/", true), "assets/");
  for (const path of ["/theme.json", "../theme.json", "assets//preview.webp", "assets\\preview.webp", "assets/预览.webp"]) {
    assert.equal(normalizeThemePackagePath(path), undefined);
  }
});

function entry(path, uncompressedBytes, kind = "file") {
  return {
    compressedBytes: uncompressedBytes,
    crc32: 0,
    kind,
    originalPath: path,
    path,
    uncompressedBytes,
  };
}
