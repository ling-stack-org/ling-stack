import assert from "node:assert/strict";
import test from "node:test";
import {
  LingThemePackageError,
  parseThemePackageBytes,
  type LingThemeImageDecoder,
  type LingThemePackageIssueCode,
} from "../dist/index.js";
import {
  IMAGE_BYTES,
  importedManifest,
  themePackageFixture as createThemePackageFixture,
} from "./fixtures/theme-package-fixtures.mjs";

type FixtureImageAsset = { path: string; bytes: Uint8Array };

const themePackageFixture: (options: {
  manifest: ReturnType<typeof importedManifest>;
  preview?: FixtureImageAsset;
  launchAnimation?: FixtureImageAsset;
}) => Uint8Array = createThemePackageFixture;

const decodeImage = async () => ({ width: 1280, height: 800 });

test("shared bytes parser normalizes launch animation packages with preview assets", async () => {
  const withLaunchAnimation = await parseThemePackageBytes(themePackageFixture({
    manifest: importedManifest({
      launchAnimation: { preset: "canvas-windmill", referenceImage: "assets/launch.webp" },
      preview: "assets/preview.png",
    }),
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
    launchAnimation: { path: "assets/launch.webp", bytes: IMAGE_BYTES.webp },
  }), { decodeImage });
  assert.equal(withLaunchAnimation.launchAnimation?.path, "assets/launch.webp");
  assert.equal(withLaunchAnimation.launchAnimation?.mimeType, "image/webp");
  assert.equal(withLaunchAnimation.launchAnimation?.width, 1280);
  assert.deepEqual(withLaunchAnimation.files.map((file) => file.path), [
    "assets/launch.webp",
    "assets/preview.png",
    "theme.json",
  ]);
});

test("shared bytes parser rejects missing and invalid launch animation assets", async () => {
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ launchAnimation: { preset: "canvas-windmill", referenceImage: "assets/missing.webp" } }),
  }), "missing-launch-animation");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ launchAnimation: { preset: "other", referenceImage: "assets/launch.webp" } }),
    launchAnimation: { path: "assets/launch.webp", bytes: IMAGE_BYTES.webp },
  }), "invalid-launch-animation");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ launchAnimation: { preset: "canvas-windmill", referenceImage: "assets//launch.webp" } }),
    launchAnimation: { path: "assets/launch.webp", bytes: IMAGE_BYTES.webp },
  }), "invalid-launch-animation");
  await rejectsCode(themePackageFixture({
    manifest: importedManifest({ launchAnimation: { preset: "canvas-windmill", referenceImage: "https://example.test/launch.webp" } }),
  }), "invalid-launch-animation");
});

async function rejectsCode(bytes: Uint8Array, code: LingThemePackageIssueCode, decoder: LingThemeImageDecoder = decodeImage) {
  await assert.rejects(
    () => parseThemePackageBytes(bytes, { decodeImage: decoder }),
    (error: unknown) => {
      assert.ok(error instanceof LingThemePackageError);
      assert.equal(error.issues.some((issue) => issue.code === code), true, JSON.stringify(error.issues));
      return true;
    },
  );
}
