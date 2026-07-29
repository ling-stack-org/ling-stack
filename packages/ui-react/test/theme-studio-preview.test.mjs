import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  THEME_STUDIO_PREVIEW_VIEWPORTS,
  ThemeStudioPreviewFixture,
  lingLightTheme,
  themeTokensToCssVariables,
} from "../dist/index.js";

const copy = {
  ariaLabel: "Candidate theme preview",
  navigation: {
    home: "Home",
    conversations: "Conversations",
    settings: "Settings",
  },
  shared: {
    workspace: "Ling workspace",
    ready: "Ready",
    search: "Search",
    refresh: "Refresh",
    summary: "Summary",
    terminal: "Terminal",
    details: "Details",
  },
  home: {
    eyebrow: "Workspace",
    title: "Good morning",
    body: "Continue the work that matters.",
    primaryAction: "Start conversation",
    composerPlaceholder: "Ask Ling anything",
    recentTitle: "Recent work",
    recentSummary: "Theme Studio planning",
  },
  conversation: {
    title: "Design review",
    status: "Context ready",
    userMessage: "Review the current interface.",
    assistantMessage: "The main actions are now easier to scan.",
    composerPlaceholder: "Message Ling",
    dockTitle: "Conversation details",
    dockSummary: "Review, evidence, files and context",
    terminalTitle: "Workspace terminal",
  },
  settings: {
    title: "Interface preferences",
    sectionTitle: "Appearance",
    fieldLabel: "Response language",
    fieldValue: "English",
    rowLabel: "Current theme",
    rowSummary: "Candidate theme",
    rowStatus: "Preview",
    inspectorTitle: "Technical details",
    inspectorSummary: "Tokens and contrast",
    inspectorBody: "Semantic values remain isolated inside this preview.",
  },
  dialog: {
    pageTitle: "Theme settings",
    title: "Delete local theme?",
    body: "This permanently removes the installed theme.",
    fieldLabel: "Theme name",
    fieldValue: "Quiet Forest",
    statusTitle: "Theme is in use",
    statusBody: "Ling Light will be restored before deletion.",
    cancel: "Cancel",
    confirm: "Delete theme",
    toast: "Theme preview updated",
  },
};

const policy = {
  artwork: "ambient",
  decorations: true,
  surfaceRecipe: "translucent",
};

const variableMap = themeTokensToCssVariables(lingLightTheme.tokens);

test("theme studio preview exposes fixed desktop viewport contracts", () => {
  assert.deepEqual(THEME_STUDIO_PREVIEW_VIEWPORTS, {
    "1280x800": { height: 800, width: 1280 },
    "1440x960": { height: 960, width: 1440 },
    "1920x1080": { height: 1080, width: 1920 },
    "2560x1440": { height: 1440, width: 2560 },
    "3440x1440": { height: 1440, width: 3440 },
  });
});

test("home and conversation render exact scaled viewports without invoking product data", () => {
  const home = render("home", "1280x800", 0.5, "blob:local-preview");
  assert.match(home, /data-theme-studio-preview-fixture="true"/u);
  assert.match(home, /aria-label="Candidate theme preview"/u);
  assert.match(home, /data-preview-surface="home"/u);
  assert.match(home, /data-preview-viewport="1280x800"/u);
  assert.match(home, /data-preview-width="1280"/u);
  assert.match(home, /data-preview-height="800"/u);
  assert.match(home, /data-preview-scale="0\.5"/u);
  assert.match(home, /data-surface-recipe="translucent"/u);
  assert.match(home, /data-artwork="ambient"/u);
  assert.match(home, /data-decorations="true"/u);
  assert.match(home, /src="blob:local-preview"/u);
  assert.match(home, /--ling-bg-app:#f6f7f8/u);
  assert.match(home, /Start conversation/u);
  assert.match(home, /Ask Ling anything/u);

  const conversation = render("conversation", "1440x960", 0.4, "blob:local-preview");
  assert.match(conversation, /data-preview-surface="conversation"/u);
  assert.match(conversation, /Conversation details/u);
  assert.match(conversation, /Workspace terminal/u);
  assert.match(conversation, /aria-label="Search"/u);
  assert.match(conversation, /aria-label="Details"/u);
  assert.match(conversation, /Message Ling/u);
});

test("settings and dialog force protected token-only surfaces", () => {
  const settings = render("settings", "1280x800", 0.5, "blob:must-not-render");
  assert.match(settings, /data-preview-surface="settings"/u);
  assert.match(settings, /data-surface-recipe="solid"/u);
  assert.match(settings, /data-artwork="off"/u);
  assert.match(settings, /data-decorations="false"/u);
  assert.doesNotMatch(settings, /blob:must-not-render/u);
  assert.match(settings, /Interface preferences/u);
  assert.match(settings, /<details/u);
  assert.match(settings, /Semantic values remain isolated/u);

  const dialog = render("dialog", "1440x960", 0.4, "blob:must-not-render");
  assert.match(dialog, /data-preview-surface="dialog"/u);
  assert.match(dialog, /data-surface-recipe="solid"/u);
  assert.match(dialog, /data-artwork="off"/u);
  assert.doesNotMatch(dialog, /blob:must-not-render/u);
  assert.match(dialog, /role="dialog"/u);
  assert.match(dialog, /aria-label="Delete local theme\?"/u);
  assert.match(dialog, /role="status"/u);
  assert.match(dialog, /Theme preview updated/u);
  assert.match(dialog, /Delete theme/u);
});

test("preview drops non-allowlisted style keys and non-blob artwork URLs", () => {
  const unsafeMap = {
    ...variableMap,
    "--unregistered-theme-value": "red",
    backgroundImage: "url(https://invalid.example/style.png)",
  };
  const html = renderToStaticMarkup(createElement(ThemeStudioPreviewFixture, {
    artworkUrl: "https://invalid.example/artwork.png",
    copy,
    presentationPolicy: policy,
    scale: 0.5,
    surface: "home",
    variableMap: unsafeMap,
    viewport: "1280x800",
  }));

  assert.doesNotMatch(html, /invalid\.example/u);
  assert.doesNotMatch(html, /unregistered-theme-value/u);
  assert.doesNotMatch(html, /background-image/u);
  assert.match(html, /--ling-bg-app:#f6f7f8/u);
});

function render(surface, viewport, scale, artworkUrl) {
  return renderToStaticMarkup(createElement(ThemeStudioPreviewFixture, {
    artworkUrl,
    copy,
    presentationPolicy: policy,
    scale,
    surface,
    variableMap,
    viewport,
  }));
}
