import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  archiveFor,
  archiveRequest,
  createRepositoryFixture,
  IMAGE_BYTES,
} from "./theme-package-repository-fixtures.mjs";
import { DesktopThemePackageRepository } from "../dist/main/theme-packages/theme-package-repository.js";

test("repository installs, reads, and restores a preview plus launch animation asset", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const bytes = archiveFor("launch-theme", {
    manifest: {
      launchAnimation: { preset: "canvas-windmill", referenceImage: "assets/launch.webp" },
      preview: "assets/preview.png",
    },
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
    launchAnimation: { path: "assets/launch.webp", bytes: IMAGE_BYTES.webp },
  });
  await fixture.repository.initialize();
  const installed = await fixture.repository.install(archiveRequest(bytes, { originalFileName: "launch-theme.ling-theme" }));
  assert.equal(installed.ok, true);
  assert.equal(installed.value.launchAnimation?.path, "assets/launch.webp");

  const read = await fixture.repository.read({
    includeLaunchAnimationBytes: true,
    includePreviewBytes: true,
    themeId: "launch-theme",
  });
  assert.equal(read.ok, true);
  assert.deepEqual([...new Uint8Array(read.value.launchAnimationBytes!)], [...IMAGE_BYTES.webp]);
  assert.deepEqual([...new Uint8Array(read.value.previewBytes!)], [...IMAGE_BYTES.png]);

  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.packages[0].launchAnimation?.path, "assets/launch.webp");
});
