import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationToolbar,
  ConversationToolbarActionButton,
  ConversationToolbarIconButton,
} from "../dist/index.js";

test("conversation toolbar composes shared UI controls with stable action semantics", () => {
  const html = renderToStaticMarkup(createElement(
    ConversationToolbar,
    { ariaLabel: "Conversation actions" },
    createElement(ConversationToolbarIconButton, {
      actionId: "summary",
      active: true,
      count: 2,
      icon: createElement("svg", { "aria-hidden": "true" }),
      label: "Summary",
    }),
    createElement(ConversationToolbarActionButton, {
      actionId: "review",
      count: 3,
      icon: createElement("svg", { "aria-hidden": "true" }),
      label: "Review: 3",
      visibleLabel: "Review",
    }),
  ));

  assert.match(html, /role="toolbar"/u);
  assert.match(html, /data-conversation-toolbar="true"/u);
  assert.match(html, /data-conversation-toolbar-frame="icon"/u);
  assert.match(html, /data-conversation-toolbar-frame="action"/u);
  assert.match(html, /data-conversation-action="summary"/u);
  assert.match(html, /aria-label="Summary"/u);
  assert.match(html, /aria-pressed="true"/u);
  assert.match(html, /class="[^"]*ling-ui-button[^"]*ling-conversation-toolbar-icon-button/u);
  assert.match(html, /data-conversation-action="review"/u);
  assert.match(html, />Review</u);
  assert.match(html, /ling-conversation-toolbar-count/u);
});

test("conversation package exports its owned cascade layer without legacy visual selectors", async () => {
  const index = await readFile(new URL("../dist/styles/index.css", import.meta.url), "utf8");
  const toolbar = await readFile(new URL("../dist/styles/toolbar/conversation-toolbar.css", import.meta.url), "utf8");
  const shell = await readFile(new URL("../dist/styles/layout/conversation-shell.css", import.meta.url), "utf8");
  const dock = await readFile(new URL("../dist/styles/dock/right-dock.css", import.meta.url), "utf8");
  const reviewQueue = await readFile(new URL("../dist/styles/dock/review-queue.css", import.meta.url), "utf8");

  assert.match(index, /layer\(ling\.conversation\)/u);
  assert.match(toolbar, /\.ling-conversation-toolbar/u);
  assert.match(toolbar, /var\(--ling-radius-pill/u);
  assert.match(shell, /\.conversation-shell/u);
  assert.match(index, /dock\/review-queue\.css/u);
  assert.match(dock, /\.right-dock/u);
  assert.match(reviewQueue, /\.right-dock-review-workbench/u);
  assert.doesNotMatch(`${toolbar}${shell}${dock}${reviewQueue}`, /transition:\s*all/u);
  assert.doesNotMatch(`${toolbar}${shell}${dock}${reviewQueue}`, /--text-|--surface-|--accent(?:-|\))/u);
  assert.doesNotMatch(`${dock}${reviewQueue}`, /#[0-9a-f]{3,8}\b/iu);
});
