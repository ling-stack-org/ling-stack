import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DockPageHeader, RightDockShell } from "../dist/index.js";

test("dock package consumers render typed normalized IconButton actions", () => {
  const headerHtml = renderToStaticMarkup(createElement(DockPageHeader, {
    backLabel: "Back",
    canGoBack: true,
    onBack: () => undefined,
    title: "Evidence",
  }));
  const expandedHtml = renderDock(false);
  const collapsedHtml = renderDock(true);

  assert.match(headerHtml, /data-ling-icon-button-contract="typed-lucide"/u);
  assert.match(headerHtml, /data-ling-icon=""/u);
  assert.match(headerHtml, /aria-label="Back"/u);
  assert.match(expandedHtml, /aria-label="Collapse"/u);
  assert.match(expandedHtml, /lucide-panel-right-close/u);
  assert.match(collapsedHtml, /aria-label="Expand"/u);
  assert.match(collapsedHtml, /lucide-panel-right-open/u);
  assert.equal((expandedHtml.match(/data-ling-icon-button-contract="typed-lucide"/gmu) ?? []).length, 2);
  assert.equal((collapsedHtml.match(/data-ling-icon-button-contract="typed-lucide"/gmu) ?? []).length, 2);
  assert.doesNotMatch(`${headerHtml}${expandedHtml}${collapsedHtml}`, /data-ling-icon-button-contract="legacy-react-node"/u);
});

test("owned IconButton consumers use component props without arbitrary icon geometry", async () => {
  const sources = await Promise.all([
    "../src/dock/DockPageHeader.tsx",
    "../src/dock/RightDockShell.tsx",
    "../src/feedback/ConversationGuidanceStrip.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const source = sources.join("\n");

  assert.doesNotMatch(source, /icon=\{<[^}]+\}/u);
  assert.doesNotMatch(source, /icon=\{[^}]*\b(?:size|strokeWidth|color)=/u);
  assert.match(source, /const CollapseIcon = collapsed \? PanelRightOpen : PanelRightClose/u);
  assert.match(source, /icon=\{CollapseIcon\}/u);
});

function renderDock(collapsed) {
  return renderToStaticMarkup(createElement(RightDockShell, {
    ariaLabel: "Conversation details",
    collapsed,
    launcherTitle: "Details",
    onBack: () => undefined,
    onClose: () => undefined,
    onCollapsedChange: () => undefined,
    onNavigate: () => undefined,
    open: true,
    pages: [],
    stack: [],
    surface: "normal_conversation",
  }));
}
