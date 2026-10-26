import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildArtifactPreview } from "../dist/features/previews/content-preview.js";

async function withHtmlArtifact(html, fileName = "chart.html", contentType = "text/html") {
  const dir = await mkdtemp(join(tmpdir(), "ling-html-preview-"));
  const path = join(dir, fileName);
  await writeFile(path, html, "utf8");
  try {
    return buildArtifactPreview({
      artifact: {
        id: "artifact_html_1",
        type: "file",
        path,
        contentType,
        sizeBytes: Buffer.byteLength(html),
        createdAt: "2026-10-26T00:00:00.000Z",
      },
      contentPath: path,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("self-contained HTML artifacts render as interactive previews", async () => {
  const preview = await withHtmlArtifact("<!doctype html><html><body><button id='b'>1</button><script>let n=0;b.onclick=()=>b.textContent=++n;</script></body></html>");
  assert.equal(preview.kind, "html_interactive");
  assert.ok(preview.htmlInteractive);
  assert.deepEqual(preview.htmlInteractive.sandbox, ["allow-scripts"]);
  assert.ok(preview.htmlInteractive.html.includes("onclick"));
  assert.equal(preview.ref.previewable, true);
});

test("HTML referencing remote resources falls back to source code with a redaction note", async () => {
  const preview = await withHtmlArtifact("<html><body><img src='https://example.com/x.png'></body></html>");
  assert.equal(preview.kind, "code");
  assert.equal(preview.htmlInteractive, undefined);
  assert.equal(preview.ref.previewable, false);
  assert.ok(preview.redactionNotes.some((note) => note.includes("safety scan")));
});

test("javascript: URLs are rejected by the interactive scan", async () => {
  const preview = await withHtmlArtifact("<html><body><a href='javascript:alert(1)'>x</a></body></html>");
  assert.equal(preview.kind, "code");
  assert.equal(preview.ref.previewable, false);
});

test("html detection also works from the .html extension without contentType", async () => {
  const preview = await withHtmlArtifact("<html><body>ok</body></html>", "report.html", undefined);
  assert.equal(preview.kind, "html_interactive");
});
