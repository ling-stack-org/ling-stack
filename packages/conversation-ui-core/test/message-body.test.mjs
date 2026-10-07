import assert from "node:assert/strict";
import test from "node:test";
import { collectLocalFileReferences, parseLocalFileReference, parseMessageBody, splitInlineTokens } from "../dist/index.js";

test("relative file display resolves dot segments without granting outside paths workspace status", () => {
  const cwd = "/workspace/ling-stack";
  for (const path of ["docs/public.txt", "./docs/public.txt", "docs/../src/a.ts:12", "."]) {
    assert.equal(parseLocalFileReference(path, cwd).insideWorkspace, true, path);
  }
  for (const path of ["../outside.txt", "docs/../../outside.txt#L7", "..", "~/outside.txt"]) {
    const reference = parseLocalFileReference(path, cwd);
    assert.equal(reference.insideWorkspace, false, path);
    assert.equal(reference.raw, path);
  }
  assert.equal(parseLocalFileReference("docs/public.txt").insideWorkspace, false);
});

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

test("message body normalizes GFM tables, task lists, and nested quotes", () => {
  const blocks = parseMessageBody([
    "| Name | State |",
    "| :--- | ---: |",
    "| Parser | Ready |",
    "",
    "- [x] preserve references",
    "- [ ] finish previews",
    "",
    "> Review notes",
    ">",
    "> 1. nested item",
  ].join("\n"));

  assert.equal(blocks[0]?.kind, "table");
  assert.deepEqual(blocks[0]?.align, ["left", "right"]);
  assert.equal(blocks[0]?.rows.length, 2);
  assert.equal(blocks[1]?.kind, "list");
  assert.deepEqual(blocks[1]?.items.map((item) => item.checked), [true, false]);
  assert.equal(blocks[2]?.kind, "quote");
  assert.equal(blocks[2]?.blocks[1]?.kind, "list");
  assert.equal(blocks[2]?.blocks[1]?.ordered, true);
});

test("message body keeps Mermaid source inert until a streaming fence closes", () => {
  const incomplete = parseMessageBody("```mermaid\ngraph TD\nA-->B", undefined, { streaming: true });
  const complete = parseMessageBody("```mermaid\ngraph TD\nA-->B\n```", undefined, { streaming: true });

  assert.deepEqual(incomplete, [{ kind: "mermaid", source: "graph TD\nA-->B", complete: false }]);
  assert.deepEqual(complete, [{ kind: "mermaid", source: "graph TD\nA-->B", complete: true }]);
});

test("message body keeps display math inert until the closing delimiter arrives", () => {
  const incomplete = parseMessageBody("$$\nx^2 + y^2", undefined, { streaming: true });
  const complete = parseMessageBody("$$\nx^2 + y^2\n$$", undefined, { streaming: true });

  assert.deepEqual(incomplete, [{ kind: "math", source: "x^2 + y^2", display: true, complete: false }]);
  assert.deepEqual(complete, [{ kind: "math", source: "x^2 + y^2", display: true, complete: true }]);
});

test("message body renders raw HTML as text and drops unsafe link destinations", () => {
  const blocks = parseMessageBody("<script>window.__ling_xss = true</script>\n\n[unsafe](javascript:alert(1)) [safe](https://example.com/docs)");

  assert.deepEqual(blocks[0], {
    kind: "paragraph",
    inlines: [{ kind: "text", text: "<script>window.__ling_xss = true</script>" }],
  });
  assert.deepEqual(blocks[1], {
    kind: "paragraph",
    inlines: [
      { kind: "text", text: "unsafe" },
      { kind: "text", text: " " },
      { kind: "web_link", href: "https://example.com/docs", label: "safe" },
    ],
  });
});

test("message body does not absorb Chinese prose after a bare URL", () => {
  const blocks = parseMessageBody(
    "一个网页链接 https://example.com；以及本地文件路径 /workspace/ling-stack/todo.py。",
    "/workspace/ling-stack",
  );

  assert.equal(blocks[0]?.kind, "paragraph");
  assert.deepEqual(blocks[0].inlines.filter((token) => token.kind === "web_link"), [
    { kind: "web_link", href: "https://example.com", label: "https://example.com" },
  ]);
  assert.equal(blocks[0].inlines.filter((token) => token.kind === "text").map((token) => token.text).join(""),
    "一个网页链接 ；以及本地文件路径 。");
  assert.equal(blocks[0].inlines.find((token) => token.kind === "local_file")?.reference.displayPath, "todo.py");

  assert.deepEqual(splitInlineTokens("https://example.com。请继续"), [
    { kind: "web_link", href: "https://example.com", label: "https://example.com" },
    { kind: "text", text: "。请继续" },
  ]);
});

test("message body preserves an explicitly linked internationalized URL", () => {
  assert.deepEqual(parseMessageBody("[文档](https://example.com/中文)"), [{
    kind: "paragraph",
    inlines: [{ kind: "web_link", href: "https://example.com/中文", label: "文档" }],
  }]);
});

test("message body preserves mentions and workspace file references inside Markdown", () => {
  const blocks = parseMessageBody(
    "**@QA** inspect [App.tsx](/workspace/ling-stack/apps/web/src/App.tsx#L20)",
    "/workspace/ling-stack",
  );

  assert.equal(blocks[0]?.kind, "paragraph");
  assert.equal(blocks[0]?.inlines[0]?.kind, "strong");
  assert.equal(blocks[0]?.inlines[0]?.children[0]?.kind, "mention");
  const file = blocks[0]?.inlines.find((token) => token.kind === "local_file");
  assert.equal(file?.kind, "local_file");
  assert.equal(file.reference.displayPath, "apps/web/src/App.tsx#L20");
  assert.equal(file.reference.location, "#L20");
});

test("message body collects unique file references from nested structured blocks", () => {
  const blocks = parseMessageBody([
    "> Inspect /workspace/ling-stack/apps/web/src/App.tsx#L10",
    "",
    "- [same file](/workspace/ling-stack/apps/web/src/App.tsx#L10)",
    "- [other](docs/design/conversation-shared-capabilities.md)",
  ].join("\n"), "/workspace/ling-stack");

  assert.deepEqual(collectLocalFileReferences(blocks).map((reference) => reference.displayPath), [
    "apps/web/src/App.tsx#L10",
    "docs/design/conversation-shared-capabilities.md",
  ]);
});
