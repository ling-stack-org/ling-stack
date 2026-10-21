import assert from "node:assert/strict";
import test from "node:test";
import { extractReadableHtmlText } from "../dist/features/channels/materialization/extractors/link-body.js";
import { decodeHtmlEntitiesOnce } from "../dist/shared/html-text.js";

test("readable HTML extraction removes whitespace-terminated script tags", () => {
  const text = extractReadableHtmlText("ignored before<body><p>before</p><script>secret()</script ><p>after</p></body>ignored after");
  assert.equal(text, "before\nafter");
});

test("HTML entities decode exactly one layer", () => {
  assert.equal(decodeHtmlEntitiesOnce("&amp;lt; &lt; &amp;quot;"), "&lt; < &quot;");
  assert.equal(decodeHtmlEntitiesOnce("&#60; &#x3c;", { numeric: true }), "< <");
});
