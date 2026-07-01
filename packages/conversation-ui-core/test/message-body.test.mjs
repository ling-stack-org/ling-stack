import assert from "node:assert/strict";
import test from "node:test";
import { splitInlineTokens } from "../dist/index.js";

test("message body keeps html closing tags as text instead of file chips", () => {
  const tokens = splitInlineTokens("Rich <script>window.__ling_p5_xss = true</script>", "/workspace/ling-stack");

  assert.equal(tokens.some((token) => token.kind === "local_file"), false);
  assert.equal(tokens.map((token) => token.kind === "text" ? token.text : "").join(""), "Rich <script>window.__ling_p5_xss = true</script>");
});

test("message body still detects ordinary absolute workspace file paths", () => {
  const tokens = splitInlineTokens("Inspect /workspace/ling-stack/apps/web/src/App.tsx", "/workspace/ling-stack");
  const fileToken = tokens.find((token) => token.kind === "local_file");

  assert.equal(fileToken?.kind, "local_file");
  assert.equal(fileToken.reference.raw, "/workspace/ling-stack/apps/web/src/App.tsx");
  assert.equal(fileToken.reference.displayPath, "apps/web/src/App.tsx");
  assert.equal(fileToken.reference.insideWorkspace, true);
});
