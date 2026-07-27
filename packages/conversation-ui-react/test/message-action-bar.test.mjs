import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActionBar } from "../dist/index.js";

test("message action bar filters actions by surface policy", () => {
  const html = renderToStaticMarkup(createElement(MessageActionBar, {
    surface: "teammate_direct",
    actions: [
      action("copy", "copy"),
      action("edit", "edit_latest"),
      action("reply", "reply_topic"),
      action("fork", "fork"),
    ],
  }));

  assert.match(html, /aria-label="Copy"/u);
  assert.match(html, /aria-label="Edit"/u);
  assert.doesNotMatch(html, /aria-label="Reply"/u);
  assert.doesNotMatch(html, /aria-label="Fork"/u);
});

test("message action bar uses shared Radix tooltips and matching accessible labels", () => {
  const html = renderToStaticMarkup(createElement(MessageActionBar, {
    surface: "normal_conversation",
    actions: [{
      ...action("edit", "edit_latest"),
      icon: createElement("svg", { "aria-hidden": "true" }),
    }],
  }));

  assert.match(html, /<button[^>]*type="button"/u);
  assert.match(html, /aria-label="Edit"/u);
  assert.match(html, /class="message-action-bar-tooltip-trigger"/u);
  assert.match(html, /data-state="closed"/u);
  assert.match(html, /class="message-action-bar-label">Edit</u);
  assert.doesNotMatch(html, /data-tooltip=/u);
  assert.doesNotMatch(html, /title="Edit"/u);
});

test("message action bar preserves visibility and asynchronous action states", () => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(MessageActionBar, {
      surface: "normal_conversation",
      visibility: "hover-focus",
      actions: [action("edit", "edit_latest")],
    }),
    createElement(MessageActionBar, {
      surface: "normal_conversation",
      visibility: "always",
      actions: [action("copy", "copy", { copyText: "hello" })],
    }),
    createElement(MessageActionBar, {
      surface: "normal_conversation",
      visibility: "critical",
      actions: [action("stop", "custom", { danger: true, loading: true })],
    }),
  ));

  assert.match(html, /message-action-bar-hover-focus/u);
  assert.match(html, /message-action-bar-always/u);
  assert.match(html, /message-action-bar-critical/u);
  assert.match(html, /message-action-bar-action danger loading/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /message-action-bar-spinner/u);
  assert.match(html, /aria-label="Copy"/u);
});

test("message action bar CSS owns 32px icon controls without pseudo tooltips", async () => {
  const index = await readFile(new URL("../dist/styles/index.css", import.meta.url), "utf8");
  const styles = await readFile(new URL("../dist/styles/feedback/message-action-bar.css", import.meta.url), "utf8");
  const implementation = await readFile(new URL("../dist/feedback/MessageActionBar.js", import.meta.url), "utf8");

  assert.match(index, /feedback\/message-action-bar\.css/u);
  assert.match(styles, /--conversation-action-hit-area:\s*var\(--ling-control-sm,\s*32px\)/u);
  assert.match(styles, /width:\s*var\(--conversation-action-hit-area\)/u);
  assert.match(styles, /height:\s*var\(--conversation-action-hit-area\)/u);
  assert.match(styles, /\.message-action-bar-label/u);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(implementation, /Tooltip/u);
  assert.doesNotMatch(styles, /visibility:\s*hidden/u);
  assert.doesNotMatch(`${styles}${implementation}`, /data-tooltip/u);
  assert.doesNotMatch(styles, /::(?:before|after)|content:\s*attr/u);
  assert.doesNotMatch(styles, /transition:\s*all/u);
  assert.doesNotMatch(styles, /!important/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|(?:rgb|hsl|oklch)a?\(/iu);
  assert.doesNotMatch(styles, /\[data-theme/u);
});

function action(id, kind, overrides = {}) {
  return { id, kind, label: label(id), onClick: () => undefined, ...overrides };
}

function label(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
