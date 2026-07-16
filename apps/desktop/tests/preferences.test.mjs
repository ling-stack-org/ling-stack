import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePreferences } from "../dist/main/preferences.js";

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
