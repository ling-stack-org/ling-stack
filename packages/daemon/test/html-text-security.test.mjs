import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { extractReadableHtmlText } from "../dist/features/channels/materialization/extractors/link-body.js";
import { decodeHtmlEntitiesOnce, stripUnreadableHtml } from "../dist/shared/html-text.js";

test("readable HTML extraction removes whitespace-terminated script tags", () => {
  const text = extractReadableHtmlText("ignored before<body><p>before</p><script>secret()</script ><p>after</p></body>ignored after");
  assert.equal(text, "before\nafter");
});

test("HTML entities decode exactly one layer", () => {
  assert.equal(decodeHtmlEntitiesOnce("&amp;lt; &lt; &amp;quot;"), "&lt; < &quot;");
  assert.equal(decodeHtmlEntitiesOnce("&#60; &#x3c;", { numeric: true }), "< <");
});

test("HTML scanning preserves plain comparisons and quoted tags but discards an unterminated markup tail", () => {
  assert.equal(stripUnreadableHtml("2 < 3"), "2 < 3");
  assert.equal(stripUnreadableHtml("x < y"), "x < y");
  assert.equal(extractReadableHtmlText('<body><p title="<not-a-tag>">visible</p><script>secret</script></body>'), "visible");
  assert.equal(extractReadableHtmlText('visible <a title="unterminated <script>secret</script>'), "visible");
  assert.equal(extractReadableHtmlText('<!-- <body>fake</body> --><body><p>real</p></body>'), "real");
  assert.equal(extractReadableHtmlText('<body><p>real</p><!-- </body> --><p>after</p></body>'), "real\nafter");
});

// Regression: P3-MAIN-HTML — malformed tags repeatedly rescanned the entire tail.
// Found by /qa independent content review on 2026-10-24
// Report: output/e6-20260928/p3-main-daemon-delta-independent-review-20261024.md
test("unterminated tag input cannot synchronously monopolize the daemon", async t => {
  const module = new URL("../dist/shared/html-text.js", import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import { stripUnreadableHtml } from ${JSON.stringify(module)};
    const tail = '<a '.repeat(40000);
    const cases = [tail, '<a title="'.repeat(15000), '<body>' + tail, '<body><script>' + tail];
    for (const input of cases) stripUnreadableHtml('visible ' + input);
    parentPort.postMessage('completed');
  `)}`));
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("malformed HTML exceeded the 2s worker budget")), 2000);
    worker.once("message", value => { clearTimeout(deadline); value === "completed" ? resolve() : reject(new Error("invalid worker result")); });
    worker.once("error", error => { clearTimeout(deadline); reject(error); });
    worker.once("exit", code => { clearTimeout(deadline); if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
});
