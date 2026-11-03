import assert from "node:assert/strict";
import test from "node:test";
import { HTML_INTERACTIVE_CSP, injectInteractiveHtmlCsp } from "../dist/artifacts.js";

const unescapeAttribute = (value) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_INTERACTIVE_CSP}">`;

test("interactive HTML default-denies remote subresources while keeping local interactivity", () => {
  const directives = new Map(HTML_INTERACTIVE_CSP.split(";").map((entry) => {
    const [name, ...sources] = entry.trim().split(/\s+/u);
    return [name, sources];
  }));
  for (const directive of ["default-src", "connect-src", "frame-src", "object-src", "worker-src", "base-uri", "form-action"]) {
    assert.deepEqual(directives.get(directive), ["'none'"], directive);
  }
  assert.deepEqual(directives.get("script-src"), ["'unsafe-inline'"]);
  assert.deepEqual(directives.get("style-src"), ["'unsafe-inline'"]);
  assert.deepEqual(directives.get("img-src"), ["data:", "blob:"]);
  assert.deepEqual(directives.get("font-src"), ["data:"]);
});

for (const html of [
  "<script>beforeHead()</script><head><title>Late head</title></head>",
  "<!-- <head> --><script>afterFakeHead()</script>",
  '<!doctype html><html><head data-label="a>b"><script>inline()</script></head><body>content</body></html>',
  '<textarea><head></textarea><script>afterTextarea()</script>',
  '<script>const bait="connect-src \'none\'";</script>',
  '</iframe><script>cannotBreakOut()</script>&quot;&amp;',
]) {
  test(`interactive HTML binds policy before any authored bytes: ${html.slice(0, 45)}`, () => {
    const wrapped = injectInteractiveHtmlCsp(html);
    assert.ok(wrapped.startsWith("<!doctype html><html><head>" + policyMeta), "trusted wrapper precedes all authored bytes");
    const match = /<iframe sandbox="allow-scripts"[^>]* srcdoc="([^"]*)"><\/iframe>/u.exec(wrapped);
    assert.ok(match, "a second opaque-origin frame keeps frame-src policy on the navigating frame's parent");
    const inner = unescapeAttribute(match[1]);
    assert.equal(inner, "<!doctype html>" + policyMeta + html, "source content is preserved without parsing or unescaped interpolation");
    assert.equal(wrapped.split("<script>").length, 1, "untrusted script tags are attribute-encoded in the wrapper");
    assert.equal(wrapped.split('<iframe sandbox="allow-scripts"').length, 2, "authored closing tags cannot create sibling frames");
  });
}

test("interactive HTML never trusts a pre-existing permissive policy or skips a repeated wrap", () => {
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src *"><button onclick="this.textContent=1">Go</button>';
  const first = injectInteractiveHtmlCsp(html);
  const second = injectInteractiveHtmlCsp(first);
  assert.notEqual(first, second);
  assert.ok(second.startsWith("<!doctype html><html><head>" + policyMeta));
});
