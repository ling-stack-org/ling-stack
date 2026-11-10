import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble, MessageRow } from "../dist/index.js";

test("message roots expose stable ownership and avatar-presence attributes", () => {
  const normalPeer = renderToStaticMarkup(createElement(MessageRow, {
    surface: "normal_conversation",
    authorType: "ai-teammate",
    authorName: "Ling",
    avatar: createElement("span", { "data-avatar": "ling" }),
    body: "No package avatar column",
  }));
  const normalOwn = renderToStaticMarkup(createElement(MessageRow, {
    surface: "normal_conversation",
    authorType: "local-user",
    authorName: "You",
    avatar: createElement("span", { "data-avatar": "you" }),
    body: "Surface adapter owns the row",
  }));
  const runOwn = renderToStaticMarkup(createElement(MessageRow, {
    surface: "run_thread",
    authorType: "local-user",
    authorName: "You",
    avatar: createElement("span", { "data-avatar": "hidden-by-policy" }),
    body: "Run thread policy owns identity visibility",
  }));
  const bubble = renderToStaticMarkup(createElement(MessageBubble, {
    avatar: createElement("span", { "data-avatar": "ling" }),
    author: "Ling",
    body: "Shared bubble",
  }));

  assert.match(normalPeer, /data-conversation-message-row="true"/u);
  assert.match(normalPeer, /data-conversation-surface="normal_conversation"/u);
  assert.match(normalPeer, /data-has-avatar="false"/u);
  assert.doesNotMatch(normalPeer, /data-avatar="ling"/u);
  assert.match(normalOwn, /data-conversation-message-row="true"/u);
  assert.match(normalOwn, /data-has-avatar="false"/u);
  assert.doesNotMatch(normalOwn, /data-avatar="you"/u);
  assert.match(runOwn, /data-has-avatar="false"/u);
  assert.doesNotMatch(runOwn, /hidden-by-policy/u);
  assert.match(bubble, /data-conversation-message-row="true"/u);
  assert.match(bubble, /data-has-avatar="true"/u);
});

test("message row keeps own identity, status, pending, and system semantics", () => {
  const own = renderToStaticMarkup(createElement(MessageRow, {
    surface: "normal_conversation",
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
  const blocked = renderToStaticMarkup(createElement(MessageRow, {
    surface: "normal_conversation",
    authorType: "ai-teammate",
    authorName: "Ling Agent",
    tone: "chat-blocked",
    body: "Waiting for approval",
  }));

  assert.match(own, /message-bubble-own-with-author/u);
  assert.match(own, /message-row-own-identity/u);
  assert.match(own, /message-bubble-pending/u);
  assert.match(own, /role="status"/u);
  assert.match(system, /message-bubble-system/u);
  assert.match(blocked, /message-bubble-chat-blocked/u);
});

test("peer identity labels stay available to assistive technology without duplicating visible status", () => {
  const peer = renderToStaticMarkup(createElement(MessageRow, {
    surface: "normal_conversation",
    authorType: "ai-teammate",
    authorName: "Ling Agent",
    avatar: createElement("span", { "data-avatar": "ling" }),
    body: "Ready",
    statusNode: createElement("span", { "data-status": "ready" }, "Ready"),
  }));

  assert.match(peer, /message-row-identity-sr-only/u);
  assert.match(peer, /message-row-peer-identity/u);
  assert.match(peer, /message-row-peer-status/u);
  assert.equal((peer.match(/data-status="ready"/gu) ?? []).length, 1);
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
