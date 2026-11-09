import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const previousWindow = globalThis.window;
let ConversationTimelineResponseFooter;
try {
  if (previousWindow === undefined) globalThis.window = {};
  ({ ConversationTimelineResponseFooter } = await vite.ssrLoadModule(
    "/src/shared/conversation/timeline/ConversationTimelineResponseFooter.tsx"));
} finally {
  if (previousWindow === undefined) delete globalThis.window;
}

function response(overrides = {}) {
  const message = { id: "message", kind: "agentMessage", markdown: "Task result", status: "succeeded", runId: "run" };
  return { id: "response", items: [message], messages: [message], message,
    copyText: message.markdown, logicalMessageCount: 1, settled: true, ...overrides };
}
function render(value = response(), props = {}) {
  return renderToStaticMarkup(React.createElement(ConversationTimelineResponseFooter,
    { response: value, cwd: "/workspace", ...props }));
}

test("settled response keeps copy followed by a closed, labelled review icon across conversation scopes", () => {
  for (const scopeKind of ["normal", "private", "channel_root", "topic", "branch", "run_detail", "child"]) {
    const html = render(response(), { scopeKind });
    assert.match(html, /aria-label="Copy message"/u);
    assert.match(html, /aria-label="Experience review"/u);
    assert.ok(html.indexOf('aria-label="Copy message"') < html.indexOf('aria-label="Experience review"'));
    assert.match(html, /data-learning-review-run-id="run"/u);
    assert.match(html, /aria-expanded="false"/u);
    assert.match(html, /data-ling-icon-button-contract="typed-lucide"/u);
    assert.doesNotMatch(html, /<details|<summary|learning-review-panel|learning-review-popover|Save experience/u);
  }
});

test("unfinished responses expose neither action and missing or ambiguous sources expose no review", () => {
  assert.equal(render(response({ settled: false })), "");
  for (const html of [render(response(), { cwd: undefined }), render(response({ items: [] })),
    render(response({ items: [{ runId: "run-a" }, { runId: "run-b" }] }))]) {
    assert.match(html, /aria-label="Copy message"/u);
    assert.doesNotMatch(html, /data-learning-review-run-id|aria-label="Experience review"/u);
  }
});

test("review source uses the authoritative report run or the single distinct response run", () => {
  assert.match(render(response({ items: [{ runId: "run-a" }, { runId: "run-b" }],
    report: { runId: "report-run" } })), /data-learning-review-run-id="report-run"/u);
  assert.match(render(response({ items: [{ runId: "child-run" }, { runId: "child-run" }, {}] })),
    /data-learning-review-run-id="child-run"/u);
});

test("custom response actions retain their copy projection and share the footer with review", () => {
  let received;
  const value = response();
  const html = render(value, { renderActions: (source, copyText) => {
    received = { source, copyText };
    return React.createElement("button", { "aria-label": "Custom copy" }, "Copy");
  } });
  assert.equal(received.source, value);
  assert.equal(received.copyText, "Task result");
  assert.match(html, /aria-label="Custom copy"/u);
  assert.match(html, /aria-label="Experience review"/u);
  assert.doesNotMatch(html, /aria-label="Copy message"/u);
});

test("a completed run can open review even when there is no message text to copy", () => {
  const html = render(response({ copyText: "" }));
  assert.match(html, /aria-label="Experience review"/u);
  assert.doesNotMatch(html, /aria-label="Copy message"/u);
});
