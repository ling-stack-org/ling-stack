import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expectedComputerUseScreenshotManifestCases } from "./computer-use-screenshot-cases.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineRoot = join(desktopRoot, "tests", "screenshots", "computer-use-preview");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("Computer Use screenshot cases cover every authoritative visual state", () => {
  const visualStates = [...new Set(expectedComputerUseScreenshotManifestCases()
    .map((entry) => entry.visualState))].sort();
  assert.deepEqual(visualStates, [
    "approval_required",
    "completed",
    "connecting",
    "failed",
    "live",
    "paused",
    "permission_required",
    "reconnecting",
    "stop_failed",
    "stopped",
    "stopping",
  ]);
});

test("Computer Use screenshot baselines match manifest dimensions and hashes", async (context) => {
  const platformDirectories = (await readdir(baselineRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(platformDirectories.length > 0, "at least one screenshot baseline platform is required");

  for (const platformDirectory of platformDirectories) {
    await context.test(platformDirectory, async () => {
      const directory = join(baselineRoot, platformDirectory);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);
      assert.equal(platformDirectory, `${manifest.platform}-${manifest.arch}`);
      assert.deepEqual(
        manifest.cases.map(({ sha256: _sha256, ...entry }) => entry),
        expectedComputerUseScreenshotManifestCases(),
      );

      const manifestFilenames = manifest.cases.map((entry) => entry.filename).sort();
      const pngFilenames = (await readdir(directory)).filter((entry) => entry.endsWith(".png")).sort();
      assert.deepEqual(pngFilenames, manifestFilenames);

      for (const screenshot of manifest.cases) {
        const png = await readFile(join(directory, screenshot.filename));
        assert.ok(png.length >= 24, `${screenshot.filename} must contain a complete PNG header`);
        assert.ok(png.subarray(0, pngSignature.length).equals(pngSignature));
        assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
        assert.equal(
          png.readUInt32BE(16),
          screenshot.width,
          `${screenshot.filename} pixel width must match its manifest logical width`,
        );
        assert.equal(
          png.readUInt32BE(20),
          screenshot.height,
          `${screenshot.filename} pixel height must match its manifest logical height`,
        );
        assert.equal(
          createHash("sha256").update(png).digest("hex"),
          screenshot.sha256,
          `${screenshot.filename} SHA-256 must match its manifest`,
        );
      }
    });
  }
});
