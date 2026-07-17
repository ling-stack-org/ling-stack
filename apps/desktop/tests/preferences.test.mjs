import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopPreferenceStore, sanitizePreferences } from "../dist/main/preferences.js";

test("sanitizePreferences removes expired hidden-session suppressions", () => {
  const result = sanitizePreferences({
    schemaVersion: 1,
    previewAutoShow: false,
    hiddenSessionSuppressions: {
      active: "2026-07-16T00:00:00.000Z",
      expired: "2026-07-14T00:00:00.000Z",
    },
  }, new Date("2026-07-15T00:00:00.000Z"));

  assert.deepEqual(result.hiddenSessionSuppressions, { active: "2026-07-16T00:00:00.000Z" });
  assert.equal(result.previewAutoShow, false);
});

test("sanitizePreferences rejects undersized preview bounds", () => {
  const result = sanitizePreferences({
    schemaVersion: 1,
    hiddenSessionSuppressions: {},
    previewBounds: { x: 1, y: 2, width: 120, height: 80 },
  });
  assert.equal(result.previewBounds, undefined);
});

test("sanitizePreferences keeps valid normalized display placements and rejects malformed entries", () => {
  const validPlacement = {
    displayId: "secondary",
    normalizedX: 0.75,
    normalizedY: 0.25,
    width: 400,
    height: 250,
    sourceWorkArea: { x: 1440, y: 0, width: 1920, height: 1080 },
  };
  const result = sanitizePreferences({
    schemaVersion: 1,
    hiddenSessionSuppressions: {},
    previewPreferredCorner: "bottom-right",
    previewDisplayPlacements: {
      secondary: validPlacement,
      mismatched: validPlacement,
      invalidRatio: { ...validPlacement, displayId: "invalidRatio", normalizedX: 1.5 },
    },
  });

  assert.equal(result.previewPreferredCorner, "bottom-right");
  assert.deepEqual(result.previewDisplayPlacements, { secondary: validPlacement });
});

test("DesktopPreferenceStore serializes concurrent saves with last invocation winning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-desktop-preferences-"));
  const filePath = join(directory, "desktop-preferences.json");
  const store = new DesktopPreferenceStore(filePath, () => new Date("2026-07-15T00:00:00.000Z"));
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.save({
      schemaVersion: 1,
      previewAutoShow: index === 11,
      hiddenSessionSuppressions: {
        [`session-${index}`]: "2026-07-16T00:00:00.000Z",
      },
    })));

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.previewAutoShow, true);
    assert.deepEqual(persisted.hiddenSessionSuppressions, {
      "session-11": "2026-07-16T00:00:00.000Z",
    });
    assert.deepEqual((await readdir(directory)).sort(), ["desktop-preferences.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
