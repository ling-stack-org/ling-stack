import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble, MessageRow } from "../dist/index.js";

test("message roots expose stable ownership and avatar-presence attributes", () => {
  const normalPeer = renderToStaticMarkup(createElement(MessageRow, {
    authorType: "ai-teammate",
    authorName: "Ling",
    body: "No package avatar column",
  }));
  const normalOwn = renderToStaticMarkup(createElement(MessageRow, {
    authorType: "local-user",
    authorName: "You",
    body: "Surface adapter owns the row",
  }));
  const bubble = renderToStaticMarkup(createElement(MessageBubble, {
    avatar: createElement("span", { "data-avatar": "ling" }),
    author: "Ling",
    body: "Shared bubble",
  }));

  assert.match(normalPeer, /data-conversation-message-row="true"/u);
  assert.match(normalPeer, /data-has-avatar="false"/u);
  assert.match(normalOwn, /data-conversation-message-row="true"/u);
  assert.match(normalOwn, /data-has-avatar="false"/u);
  assert.match(bubble, /data-conversation-message-row="true"/u);
  assert.match(bubble, /data-has-avatar="true"/u);
});

test("message row keeps own identity, status, pending, and system semantics", () => {
  const own = renderToStaticMarkup(createElement(MessageRow, {
    authorType: "local-user",
    authorName: "You",
    avatar: createElement("span", { "data-avatar": "you" }),
    showOwnAuthor: true,
    body: "Sending",
    bodyStreaming: true,
    statusNode: createElement("span", { role: "status" }, "Pending"),
  }));
  const system = renderToStaticMarkup(createElement(MessageBubble, {
    avatar: createElement("span", { "data-avatar": "system" }),
    author: "System",
    tone: "system",
    body: "Runtime notice",
  }));

  assert.match(own, /message-bubble-own-with-author/u);
  assert.match(own, /message-row-own-identity/u);
  assert.match(own, /message-bubble-pending/u);
  assert.match(own, /role="status"/u);
  assert.match(system, /message-bubble-system/u);
});

test("conversation package owns message frame visuals through semantic tokens", async () => {
  const index = await readFile(new URL("../dist/styles/index.css", import.meta.url), "utf8");
  const styles = await readFile(new URL("../dist/styles/blocks/message-frame.css", import.meta.url), "utf8");

  assert.match(index, /blocks\/message-frame\.css/u);
  assert.match(styles, /\[data-conversation-message-row\]/u);
  assert.match(styles, /\[data-has-avatar="false"\]/u);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(styles, /\.message-bubble-own/u);
  assert.match(styles, /\.message-bubble-peer/u);
  assert.match(styles, /\.message-bubble-system/u);
  assert.match(styles, /\.message-bubble-chat-blocked/u);
  assert.match(styles, /\.message-bubble-pending/u);
  assert.match(styles, /\.message-row-own-identity/u);
  assert.match(styles, /\.message-own-identity/u);
  assert.match(styles, /\.message-row-own-status/u);
  assert.match(styles, /var\(--conversation-/u);
  assert.match(styles, /var\(--ling-/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /\.(?:channel|normal|teammate)-/u);
  assert.doesNotMatch(styles, /transition:\s*all/u);
  assert.doesNotMatch(styles, /!important/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|(?:rgb|hsl|oklch)a?\(/iu);
  assert.doesNotMatch(styles, /\[data-theme/u);
});
