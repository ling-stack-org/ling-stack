import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME_SELECTION,
  LING_THEME_CSS_VARIABLES,
  ThemeRegistry,
  applyResolvedTheme,
  applyThemeTransaction,
  lingDarkTheme,
  lingLightTheme,
  parseThemeBootstrapSnapshot,
  parseThemeSelection,
  resolvedThemeToBootstrapSnapshot,
  validateThemeManifest,
  verifyThemeSentinel,
} from "../dist/index.js";

test("built-in themes are independent complete manifests with fixed and system resolution", () => {
  const registry = new ThemeRegistry();
  assert.deepEqual(registry.list().map((theme) => theme.manifest.id), ["ling-breeze", "ling-dark", "ling-light", "ling-night", "ling-ocean", "ling-journey"]);
  assert.equal(registry.resolve(DEFAULT_THEME_SELECTION, "light").themeId, "ling-light");
  assert.equal(registry.resolve(DEFAULT_THEME_SELECTION, "dark").themeId, "ling-dark");

  const fixedDark = registry.resolve({ mode: "fixed", themeId: "ling-dark" }, "light");
  assert.equal(fixedDark.themeId, "ling-dark");
  assert.equal(fixedDark.colorScheme, "dark");
  assert.equal(fixedDark.presentationProfileId, "ling-standard");
  assert.equal(Object.keys(fixedDark.variableMap).length, LING_THEME_CSS_VARIABLES.length);

  const breeze = registry.resolve({ mode: "fixed", themeId: "ling-breeze" }, "dark");
  assert.equal(breeze.manifest.scene?.id, "forest-breeze");
  assert.equal(breeze.presentationProfileId, "ling-illustrated");
  assert.equal(registry.resolve({ mode: "fixed", themeId: "ling-night" }, "light").manifest.scene?.id, "midnight-aurora");
  assert.equal(registry.resolve({ mode: "fixed", themeId: "ling-journey" }, "light").manifest.scene?.id, "farbound-journey");
});

test("registry validates imported themes, protects built-ins, and falls back without rewriting selection", () => {
  const registry = new ThemeRegistry();
  const imported = importedTheme("quiet-ocean");
  const result = registry.install(imported, "local-import", "2026-07-18T00:00:00.000Z");
  assert.equal(result.ok, true);
  assert.equal(result.theme?.manifest.source, "local-import");
  assert.equal(registry.resolve({ mode: "fixed", themeId: "quiet-ocean" }, "dark").themeId, "quiet-ocean");

  const unknownSelection = { mode: "fixed", themeId: "missing-theme" };
  const fallback = registry.resolve(unknownSelection, "dark");
  assert.equal(fallback.themeId, "ling-dark");
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.fallbackFrom, "missing-theme");
  assert.deepEqual(fallback.selection, unknownSelection);

  const reserved = registry.install({ ...imported, id: "ling-user-theme" }, "local-import");
  assert.equal(reserved.ok, false);
  assert.equal(reserved.issues?.some((item) => item.code === "reserved-id"), true);
  assert.equal(registry.uninstall("ling-light"), false);
  assert.equal(registry.uninstall("quiet-ocean"), true);
});

test("manifest validation rejects executable colors, incomplete tokens, weak contrast, and unknown profiles", () => {
  const executable = validateThemeManifest(importedTheme("unsafe-color", {
    tokens: { ...lingLightTheme.tokens, background: { ...lingLightTheme.tokens.background, app: "url(https://example.test/a.png)" } },
  }), { source: "local-import" });
  assert.equal(executable.ok, false);
  assert.equal(executable.issues.some((item) => item.code === "invalid-color"), true);

  const incomplete = validateThemeManifest({ ...importedTheme("incomplete"), tokens: { background: {} } }, { source: "local-import" });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.issues.some((item) => item.code === "missing-token"), true);

  const weak = validateThemeManifest(importedTheme("weak-contrast", {
    tokens: { ...lingLightTheme.tokens, text: { ...lingLightTheme.tokens.text, default: "#fefefe" } },
  }), { source: "local-import" });
  assert.equal(weak.ok, false);
  assert.equal(weak.issues.some((item) => item.code === "insufficient-contrast"), true);

  const unknownProfile = validateThemeManifest({
    ...importedTheme("unknown-profile"),
    presentation: { profileId: "theme-owned-layout" },
  }, { source: "local-import" });
  assert.equal(unknownProfile.ok, false);
  assert.equal(unknownProfile.issues.some((item) => item.code === "invalid-presentation"), true);

  const importedScene = validateThemeManifest({
    ...importedTheme("imported-scene"),
    scene: { id: "forest-breeze", mascot: true, corners: true },
  }, { source: "local-import" });
  assert.equal(importedScene.ok, false);
  assert.equal(importedScene.issues.some((item) => item.code === "invalid-artwork"), true);
});

test("selection and bootstrap snapshot parsers accept only complete allowlisted state", () => {
  assert.deepEqual(parseThemeSelection({ mode: "fixed", themeId: "quiet-ocean" }), { mode: "fixed", themeId: "quiet-ocean" });
  assert.equal(parseThemeSelection({ mode: "fixed", themeId: "Quiet Ocean" }), undefined);

  const registry = new ThemeRegistry();
  assert.equal(registry.install(importedTheme("quiet-ocean"), "local-import").ok, true);
  const resolved = registry.resolve({ mode: "fixed", themeId: "quiet-ocean" }, "light");
  const snapshot = resolvedThemeToBootstrapSnapshot(resolved);
  assert.ok(snapshot);
  assert.deepEqual(parseThemeBootstrapSnapshot(snapshot), snapshot);
  const nativeSnapshot = resolvedThemeToBootstrapSnapshot(resolved, "a".repeat(64));
  assert.deepEqual(parseThemeBootstrapSnapshot(nativeSnapshot), nativeSnapshot);
  assert.equal(parseThemeBootstrapSnapshot({ ...snapshot, packageChecksumSha256: "not-a-checksum" }), undefined);
  assert.equal(parseThemeBootstrapSnapshot({ ...snapshot, packageChecksumSha256: "A".repeat(64) }), undefined);
  assert.equal(parseThemeBootstrapSnapshot({ ...snapshot, variableMap: { "--ling-bg-app": "#fff" } }), undefined);
  assert.equal(parseThemeBootstrapSnapshot({
    ...snapshot,
    variableMap: { ...snapshot.variableMap, "--ling-not-allowed": "#fff" },
  }), undefined);
});

test("theme application restores root attributes and variables when verification or persistence fails", async () => {
  const registry = new ThemeRegistry();
  assert.equal(registry.install(importedTheme("quiet-ocean"), "local-import").ok, true);
  const root = fakeRoot();
  const light = registry.resolve({ mode: "fixed", themeId: "ling-light" }, "light");
  const imported = registry.resolve({ mode: "fixed", themeId: "quiet-ocean" }, "light");
  applyResolvedTheme(root, light);
  assert.equal(root.dataset.uiTheme, "ling-light");

  await assert.rejects(() => applyThemeTransaction(root, imported, { verify: () => false }), /sentinel/u);
  assert.equal(root.dataset.uiTheme, "ling-light");
  assert.equal(root.style.getPropertyValue("--ling-bg-app"), "");

  await assert.rejects(() => applyThemeTransaction(root, imported, {
    persist: () => { throw new Error("storage unavailable"); },
    verify: () => true,
  }), /storage unavailable/u);
  assert.equal(root.dataset.uiTheme, "ling-light");
});

test("theme sentinel treats equivalent serialized CSS colors as equal", () => {
  const registry = new ThemeRegistry();
  const light = registry.resolve({ mode: "fixed", themeId: "ling-light" }, "light");
  const root = fakeRoot(fakeColorDocument());
  const previousGetComputedStyle = globalThis.getComputedStyle;

  try {
    globalThis.getComputedStyle = () => ({
      getPropertyValue: () => "#fff",
    });
    assert.equal(verifyThemeSentinel(root, light), true);

    globalThis.getComputedStyle = () => ({
      getPropertyValue: () => "#000000",
    });
    assert.equal(verifyThemeSentinel(root, light), false);
  } finally {
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

function importedTheme(id, overrides = {}) {
  return {
    ...structuredClone(lingLightTheme),
    id,
    name: id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    source: "local-import",
    ...overrides,
  };
}

function fakeRoot(ownerDocument) {
  const values = new Map();
  return {
    dataset: {},
    ownerDocument,
    style: {
      colorScheme: "",
      getPropertyValue: (name) => values.get(name) ?? "",
      removeProperty: (name) => values.delete(name),
      setProperty: (name, value) => values.set(name, value),
    },
  };
}

function fakeColorDocument() {
  return {
    createElement: () => {
      let color = "";
      return {
        style: {
          get color() {
            return color;
          },
          set color(value) {
            const normalized = value.trim().toLowerCase();
            if (normalized === "#fff" || normalized === "#ffffff") color = "rgb(255, 255, 255)";
            else if (normalized === "#000" || normalized === "#000000") color = "rgb(0, 0, 0)";
            else color = "";
          },
        },
      };
    },
  };
}
