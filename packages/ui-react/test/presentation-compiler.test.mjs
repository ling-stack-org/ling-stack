import assert from "node:assert/strict";
import test from "node:test";
import {
  PresentationProfileRegistry,
  ThemeRegistry,
  LING_THEME_CSS_VARIABLES,
  analyzeThemeImage,
  compileLingTheme,
} from "../dist/index.js";

const imageFixture = new Uint8ClampedArray([
  232, 234, 236, 255, 232, 234, 236, 255, 216, 48, 68, 255, 32, 88, 214, 255,
  232, 234, 236, 255, 232, 234, 236, 255, 28, 176, 116, 255, 236, 174, 42, 255,
]);

test("presentation profiles own route-aware surfaces and degrade without changing product geometry", () => {
  const registry = new PresentationProfileRegistry();

  assert.deepEqual(registry.list().map((profile) => profile.id), [
    "ling-standard",
    "ling-glass",
    "ling-immersive",
    "ling-illustrated",
  ]);

  const immersiveHome = registry.resolveSurface("ling-immersive", "home", { viewportWidth: 1440 });
  assert.equal(immersiveHome.surfaceRecipe, "translucent");
  assert.equal(immersiveHome.artwork, "strong");
  assert.equal(immersiveHome.decorations, false);

  const immersiveSettings = registry.resolveSurface("ling-immersive", "settings", { viewportWidth: 1440 });
  assert.equal(immersiveSettings.surfaceRecipe, "solid");
  assert.equal(immersiveSettings.artwork, "off");

  const compactIllustrated = registry.resolveSurface("ling-illustrated", "home", { viewportWidth: 1280 });
  assert.equal(compactIllustrated.artwork, "ambient");
  assert.equal(compactIllustrated.decorations, false);

  const accessibleIllustrated = registry.resolveSurface("ling-illustrated", "home", {
    viewportWidth: 1440,
    reducedTransparency: true,
  });
  assert.equal(accessibleIllustrated.surfaceRecipe, "solid");
  assert.equal(accessibleIllustrated.artwork, "off");
  assert.equal(accessibleIllustrated.decorations, false);

  assert.equal(registry.supportsArtworkSlot("ling-illustrated", "home-corner-end"), true);
  assert.equal(registry.supportsArtworkSlot("ling-immersive", "home-corner-end"), false);
  assert.equal(registry.supportsDecorationSet("ling-illustrated", "home-corners"), true);
  assert.equal(registry.get("theme-owned-profile"), undefined);
});

test("local theme image analysis is deterministic and keeps the quiet side available for UI", () => {
  const input = { width: 4, height: 2, pixels: imageFixture };
  const analysis = analyzeThemeImage(input);

  assert.deepEqual(analyzeThemeImage(input), analysis);
  assert.equal(analysis.width, 4);
  assert.equal(analysis.height, 2);
  assert.equal(analysis.safeArea, "left");
  assert.ok(analysis.focusX > 0.5);
  assert.ok(analysis.leftInformationScore < analysis.rightInformationScore);
  assert.ok(analysis.averageLuminance > 0 && analysis.averageLuminance < 1);
  assert.ok(analysis.dominantColors.length > 1 && analysis.dominantColors.length <= 5);
  assert.equal(analysis.recommendedProfileId, "ling-immersive");
});

test("theme compiler deterministically produces a complete validated generated manifest", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  const input = {
    identity: { id: "quiet-canvas", name: "Quiet Canvas", description: "Generated from a local reference." },
    colorScheme: "light",
    presentation: { profileId: "ling-immersive", surfaceIntensity: "balanced", artworkIntensity: "balanced" },
    paletteCandidate: { background: analysis.dominantColors[0], accent: analysis.accentCandidate },
    analysis,
    generation: {
      mode: "quick",
      createdAt: "2026-07-18T00:00:00.000Z",
      sourceAssetCount: 1,
    },
  };

  const compiled = compileLingTheme(input);
  assert.deepEqual(compileLingTheme(input), compiled);
  assert.equal(compiled.manifest.id, "quiet-canvas");
  assert.equal(compiled.manifest.source, "local-generated");
  assert.equal(compiled.manifest.presentation?.profileId, "ling-immersive");
  assert.equal(compiled.manifest.generation?.compilerVersion, "1.0.0");
  assert.equal(compiled.verification.blockers.length, 0);
  assert.equal(compiled.readyToPublish, true);
  assert.equal(Object.keys(compiled.tokenMap).length, LING_THEME_CSS_VARIABLES.length);

  const installed = new ThemeRegistry().install(compiled.manifest, "local-generated");
  assert.equal(installed.ok, true);
});

test("theme compiler blocks unsafe palette and unregistered presentation input instead of emitting executable styles", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  const compiled = compileLingTheme({
    identity: { id: "ling-user-injected", name: "Unsafe Theme" },
    colorScheme: "dark",
    presentation: { profileId: "theme-owned-layout" },
    paletteCandidate: {
      background: "url(https://invalid.example/background.png)",
      accent: "var(--provider-color)",
    },
    analysis,
    generation: {
      mode: "advanced",
      createdAt: "2026-07-18T00:00:00.000Z",
      sourceAssetCount: 1,
      plannerModelRef: "planner-safe-reference",
    },
  });

  assert.equal(compiled.readyToPublish, false);
  assert.equal(compiled.verification.blockers.some((issue) => issue.code === "invalid-palette"), true);
  assert.equal(compiled.verification.blockers.some((issue) => issue.code === "reserved-id"), true);
  assert.equal(compiled.verification.blockers.some((issue) => issue.code === "invalid-presentation"), true);
  assert.equal(JSON.stringify(compiled.manifest).includes("url("), false);
  assert.equal(JSON.stringify(compiled.manifest).includes("var("), false);
});

test("theme compiler maps validated artwork identity into an allowlisted local asset without source paths", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  const compiled = compileLingTheme({
    identity: { id: "quiet-artwork", name: "Quiet Artwork" },
    colorScheme: "light",
    presentation: { profileId: "ling-immersive", artworkIntensity: "balanced" },
    paletteCandidate: { background: analysis.dominantColors[0], accent: analysis.accentCandidate },
    analysis,
    artwork: [{
      id: "background-main",
      slot: "shell-background",
      mimeType: "image/webp",
      width: 1920,
      height: 1080,
      byteLength: 420_000,
      checksumSha256: "a".repeat(64),
      hasAlpha: false,
      analysis,
      contentRisk: { readableText: false, logoOrWatermark: false, uiChrome: false },
    }],
    generation: { mode: "quick", createdAt: "2026-07-18T00:00:00.000Z", sourceAssetCount: 1 },
  });

  assert.equal(compiled.readyToPublish, true);
  assert.equal(compiled.assets.length, 1);
  assert.equal(compiled.assets[0].path, "assets/background-main.webp");
  assert.equal(compiled.manifest.artwork?.assets[0]?.image, "assets/background-main.webp");
  assert.equal(compiled.verification.warnings.some((issue) => issue.code === "missing-artwork"), false);
  assert.equal(JSON.stringify(compiled).includes("/Users/"), false);
});

test("theme compiler blocks screenshot, text, logo, and invalid decoration artwork", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  const compiled = compileLingTheme({
    identity: { id: "blocked-artwork", name: "Blocked Artwork" },
    colorScheme: "dark",
    presentation: { profileId: "ling-illustrated", decorationSet: "home-corners" },
    paletteCandidate: { background: "#304050", accent: "#d8a648" },
    analysis,
    artwork: [{
      id: "unsafe-corner",
      slot: "home-corner-end",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 300_000,
      checksumSha256: "b".repeat(64),
      hasAlpha: false,
      analysis,
      contentRisk: { readableText: true, logoOrWatermark: true, uiChrome: true },
    }],
    generation: { mode: "advanced", createdAt: "2026-07-18T00:00:00.000Z", sourceAssetCount: 1 },
  });

  const codes = compiled.verification.blockers.map((issue) => issue.code);
  assert.equal(compiled.readyToPublish, false);
  assert.equal(codes.includes("decoration-requires-alpha"), true);
  assert.equal(codes.includes("artwork-readable-text"), true);
  assert.equal(codes.includes("artwork-logo-watermark"), true);
  assert.equal(codes.includes("artwork-ui-chrome"), true);
  assert.equal(compiled.assets.length, 0);
});

test("theme compiler rejects a decoration set that the selected Presentation Profile does not own", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  const compiled = compileLingTheme({
    identity: { id: "unsupported-decoration", name: "Unsupported Decoration" },
    colorScheme: "light",
    presentation: { profileId: "ling-immersive", decorationSet: "home-corners" },
    paletteCandidate: { background: "#d9e5df", accent: "#386a57" },
    analysis,
    generation: { mode: "quick", createdAt: "2026-07-18T00:00:00.000Z", sourceAssetCount: 1 },
  });

  assert.equal(compiled.readyToPublish, false);
  assert.equal(compiled.verification.blockers.some((issue) => issue.code === "unsupported-decoration-set"), true);
});

test("theme compiler repairs extreme Light and Dark palette candidates into valid semantic contrast", () => {
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels: imageFixture });
  for (const fixture of [
    { id: "extreme-light", colorScheme: "light", background: "#000000", accent: "#ffffff" },
    { id: "extreme-dark", colorScheme: "dark", background: "#ffffff", accent: "#000000" },
  ]) {
    const compiled = compileLingTheme({
      identity: { id: fixture.id, name: fixture.id },
      colorScheme: fixture.colorScheme,
      presentation: { profileId: "ling-standard" },
      paletteCandidate: { background: fixture.background, accent: fixture.accent },
      analysis,
      generation: { mode: "quick", createdAt: "2026-07-18T00:00:00.000Z", sourceAssetCount: 1 },
    });
    assert.equal(compiled.verification.blockers.length, 0, JSON.stringify(compiled.verification.blockers));
    assert.equal(new ThemeRegistry().install(compiled.manifest, "local-generated").ok, true);
  }
});
