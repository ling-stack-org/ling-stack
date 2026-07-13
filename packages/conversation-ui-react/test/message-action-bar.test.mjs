import assert from "node:assert/strict";
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

test("message action bar exposes keyboard buttons and matching accessible labels", () => {
  const html = renderToStaticMarkup(createElement(MessageActionBar, {
    surface: "normal_conversation",
    actions: [action("edit", "edit_latest")],
  }));

  assert.match(html, /<button[^>]*type="button"/u);
  assert.match(html, /aria-label="Edit"/u);
  assert.match(html, /title="Edit"/u);
  assert.match(html, /data-tooltip="Edit"/u);
});

function action(id, kind) {
  return { id, kind, label: label(id), onClick: () => undefined };
}

function label(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
