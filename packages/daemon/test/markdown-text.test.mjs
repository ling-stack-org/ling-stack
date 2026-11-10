import assert from "node:assert/strict";
import test from "node:test";
import { boundedMarkdownText, preserveMarkdownLayout } from "../dist/features/channels/markdown-text.js";

test("preserveMarkdownLayout keeps paragraphs, lists, and fenced code intact", () => {
  const input = "第一段\r\n\r\n- one   \r\n- two\r\n\r\n```ts\r\nconst value = 1;  \r\n```\r\n\r\n\r\n";
  assert.equal(preserveMarkdownLayout(input), "第一段\n\n- one\n- two\n\n```ts\nconst value = 1;\n```");
});

test("boundedMarkdownText truncates without flattening surviving line boundaries", () => {
  assert.equal(boundedMarkdownText("第一段\n\n```bash\necho ok\n```", 20), "第一段\n\n```bash\necho...");
});
