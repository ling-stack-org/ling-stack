import assert from "node:assert/strict";
import test from "node:test";
import { DesktopRendererThemeStore } from "../dist/main/renderer-theme-store.js";
import {
  parseDesktopRendererThemeInput,
  parseDesktopRendererThemeSnapshot,
} from "../dist/shared/renderer-theme.js";

test("Desktop renderer theme store validates, revisions, deduplicates, and broadcasts safe snapshots", () => {
  const sent = [];
  const renderer = {
    id: 42,
    isDestroyed: () => false,
    send: (channel, snapshot) => sent.push([channel, snapshot]),
  };
  const store = new DesktopRendererThemeStore();
  store.trackRenderer(renderer);

  assert.deepEqual(store.getSnapshot(), {
    revision: 1,
    themeId: "ling-light",
    colorScheme: "light",
    presentationProfileId: "ling-standard",
    variables: {},
  });
  assert.equal(store.report({
    themeId: "unsafe-theme",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: { "--ling-compact-window-bg": "url(https://example.com/a.png)" },
  }), undefined);
  assert.equal(store.report({
    themeId: "unknown-variable",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: { "--arbitrary-css": "red" },
  }), undefined);
  assert.equal(store.report({
    themeId: "unknown-profile",
    colorScheme: "dark",
    presentationProfileId: "theme-owned-layout",
    variables: {},
  }), undefined);
  assert.deepEqual(sent, []);

  const dark = store.report({
    themeId: "ling-dark",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: {
      "--ling-compact-window-bg": "rgb(17 19 21 / 94%)",
      "--ling-compact-window-text": "#f4f5f6",
    },
  });
  assert.equal(dark.revision, 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], dark);

  assert.deepEqual(store.report({
    themeId: "ling-dark",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: {
      "--ling-compact-window-bg": "rgb(17 19 21 / 94%)",
      "--ling-compact-window-text": "#f4f5f6",
    },
  }), dark);
  assert.equal(sent.length, 1);
});

test("Desktop renderer theme parsers reject malformed revisions and normalize identifiers", () => {
  assert.deepEqual(parseDesktopRendererThemeInput({
    themeId: "  LING-DARK ",
    colorScheme: "dark",
    presentationProfileId: " LING-STANDARD ",
    variables: {},
  }), {
    themeId: "ling-dark",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: {},
  });
  assert.equal(parseDesktopRendererThemeSnapshot({
    revision: 0,
    themeId: "ling-dark",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: {},
  }), undefined);
});
