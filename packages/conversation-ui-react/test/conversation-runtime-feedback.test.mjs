import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationGuidanceStrip,
  ConversationStatusStrip,
} from "../dist/index.js";

test("conversation status actions use shared buttons with stable labels", () => {
  const html = renderToStaticMarkup(createElement(ConversationStatusStrip, {
    title: "Run in progress",
    actions: [
      { id: "open", label: "Open run", onClick: () => undefined },
      { id: "stop", label: "Stop", danger: true, onClick: () => undefined },
    ],
  }));

  assert.match(html, /role="status"/u);
  assert.match(html, /class="[^"]*ling-ui-button[^"]*conversation-status-action/u);
  assert.match(html, /data-size="sm"/u);
  assert.match(html, /data-variant="danger"/u);
  assert.match(html, /aria-label="Open run"/u);
  assert.match(html, /aria-label="Stop"/u);
});

test("conversation guidance actions use shared icon buttons and a semantic menu trigger", () => {
  const html = renderToStaticMarkup(createElement(ConversationGuidanceStrip, {
    title: "Queued guidance",
    items: [{
      id: "guidance-1",
      instruction: "Continue with browser evidence",
      statusLabel: "Queued",
      promoteLabel: "Run this guidance now",
      onPromote: () => undefined,
      deleteLabel: "Delete queued guidance",
      onDelete: () => undefined,
      moreLabel: "More guidance actions",
      editLabel: "Edit message",
      onEdit: () => undefined,
    }],
  }));

  assert.match(html, /class="conversation-guidance-row"/u);
  assert.equal((html.match(/<button\b/gmu) ?? []).length, 3);
  assert.match(html, /class="[^"]*ling-ui-button/u);
  assert.match(html, /aria-label="Run this guidance now"/u);
  assert.match(html, /aria-label="Delete queued guidance"/u);
  assert.match(html, /aria-label="More guidance actions"/u);
  assert.match(html, /aria-haspopup="menu"/u);
});
