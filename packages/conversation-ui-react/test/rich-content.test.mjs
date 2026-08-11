import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBodyRenderer } from "../dist/index.js";

test("shared renderer keeps incomplete Mermaid as escaped source", () => {
  const html = renderToStaticMarkup(
    MessageBodyRenderer({
      text: "```mermaid\ngraph TD\nA[<script>alert(1)</script>]",
      streaming: true,
    }),
  );

  assert.match(html, /data-rich-content="mermaid"/);
  assert.match(html, /graph TD/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /message-mermaid-canvas/);
});

test("shared renderer emits semantic GFM table and read-only task controls", () => {
  const html = renderToStaticMarkup(
    MessageBodyRenderer({
      text: "| Item | State |\n| --- | --- |\n| Parser | Ready |\n\n- [x] tested",
    }),
  );

  assert.match(html, /<table class="message-body-table">/);
  assert.match(html, /<th>Item<\/th>/);
  assert.match(html, /<td>Ready<\/td>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*readOnly=""/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked=""/);
  assert.match(html, /<input[^>]*data-ling-control-native="true"[^>]*type="checkbox"/);
});

test("shared renderer does not emit raw HTML or unsafe link targets", () => {
  const html = renderToStaticMarkup(
    MessageBodyRenderer({
      text: "<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1)) [safe](https://example.com)",
    }),
  );

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src="x"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/example.com"/);
});

test("shared renderer preserves complete and incomplete math fallback boundaries", () => {
  const incomplete = renderToStaticMarkup(MessageBodyRenderer({ text: "$$\nx^2", streaming: true }));
  const complete = renderToStaticMarkup(MessageBodyRenderer({ text: "$$\nx^2\n$$", streaming: true }));

  assert.match(incomplete, /data-rich-content="math"/);
  assert.match(incomplete, />x\^2<\/div>/);
  assert.match(complete, /data-rich-content="math"/);
  assert.match(complete, />x\^2<\/div>/);
});
