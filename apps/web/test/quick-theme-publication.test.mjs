import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTokenOnlyManifest,
  compileTokenOnlyQuickTheme,
} from "../src/shared/ui/theme/studio/web-quick-theme-compiler.ts";

const analysis = {
  width: 128,
  height: 96,
  aspectRatio: 4 / 3,
  averageLuminance: 0.72,
  dominantColors: ["#d9e1e8", "#536f86"],
  accentCandidate: "#356d98",
  leftInformationScore: 0.2,
  rightInformationScore: 0.3,
  focusX: 0.5,
  focusY: 0.5,
  safeArea: "center",
  recommendedProfileId: "ling-immersive",
};

test("Quick D3=A compilation forces Standard and omits all runtime artwork", () => {
  const candidate = compileTokenOnlyQuickTheme({
    analysis,
    colorScheme: "light",
    createdAt: "2026-07-30T00:00:00.000Z",
    name: "Quiet Sky",
    themeId: "quick-theme-quiet-sky",
  });

  assert.equal(candidate.readyToPublish, true);
  assert.equal(candidate.manifest.source, "local-generated");
  assert.equal(candidate.manifest.generation?.mode, "quick");
  assert.equal(candidate.manifest.presentation?.profileId, "ling-standard");
  assert.equal(candidate.manifest.artwork, undefined);
  assert.equal(candidate.assets.length, 0);
});

test("Quick publication guard rejects artwork and non-Standard profiles", () => {
  const candidate = compileTokenOnlyQuickTheme({
    analysis,
    colorScheme: "dark",
    createdAt: "2026-07-30T00:00:00.000Z",
    name: "Night",
    themeId: "quick-theme-night",
  });
  assert.throws(() => assertTokenOnlyManifest({
    ...candidate.manifest,
    presentation: { ...candidate.manifest.presentation, profileId: "ling-immersive" },
  }, 0), /Standard/u);
  assert.throws(() => assertTokenOnlyManifest({
    ...candidate.manifest,
    artwork: { assets: [] },
  }, 0), /runtime artwork/u);
});
