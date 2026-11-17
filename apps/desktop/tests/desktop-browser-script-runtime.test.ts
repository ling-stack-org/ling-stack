import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import test from "node:test";
import { browserAnnotationScript } from "../dist/main/browser/annotation-runtime.js";
import { browserPageScript } from "../dist/main/browser/page-runtime.js";
import { serializeBrowserScriptArgument } from "../dist/main/browser/script-serialization.js";
import { webMcpScript } from "../dist/main/browser/webmcp.js";

const hostileText = '</script><img src=x onerror="globalThis.pwned=true">\u2028\u2029"\\\n';

test("browser script serialization preserves values while escaping script delimiters", () => {
  const request = { action: "type" as const, revision: hostileText, ref: hostileText, text: hostileText };
  const serialized = serializeBrowserScriptArgument(request);

  assert.doesNotMatch(serialized, /<\/script>/u);
  assert.match(serialized, /\\u003C\\u002Fscript\\u003E/u);
  assert.match(serialized, /\\u2028/u);
  assert.match(serialized, /\\u2029/u);
  assert.deepEqual({ ...(runInNewContext(`(${serialized})`) as typeof request) }, request);
});

test("browser page, annotation, and WebMCP scripts compile with hostile text", () => {
  const pageRequest = { action: "type" as const, revision: hostileText, ref: hostileText, text: hostileText };
  const anchor = {
    kind: "element" as const,
    documentId: hostileText,
    documentRevision: 1,
    selector: hostileText,
    signature: hostileText,
    excerpt: hostileText,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0, zoom: 1 },
  };
  const scripts = [
    browserPageScript(pageRequest),
    browserAnnotationScript({ action: "locate", anchor }),
    webMcpScript({ action: "call", name: hostileText, args: { text: hostileText }, revision: hostileText }),
  ];

  for (const script of scripts) {
    assert.doesNotMatch(script, /<\/script>/u);
    assert.doesNotThrow(() => new Script(script));
  }
});
