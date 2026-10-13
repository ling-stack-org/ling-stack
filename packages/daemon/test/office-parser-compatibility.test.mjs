import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfficeParser } from "officeparser";
import { officeExtractorV1 } from "../dist/features/channels/materialization/extractors/office.js";
import { OfficeArtifactService } from "../dist/features/office-documents/artifacts.js";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "ling-office-parser-compatibility-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, service: new OfficeArtifactService() };
}

const creates = {
  docx: (service, workspace, path) => service.createDocument(workspace, {
    path, blocks: [{ type: "paragraph", text: "Parser compatibility fixture" }],
  }),
  xlsx: (service, workspace, path) => service.createWorkbook(workspace, {
    path, sheets: [{ name: "Summary", rows: [["Parser compatibility fixture", 42]] }],
  }),
  pptx: (service, workspace, path) => service.createPresentation(workspace, {
    path, title: "Fixture", slides: [{ title: "Parser compatibility fixture", bullets: ["Local output"] }],
  }),
};

for (const format of Object.keys(creates)) {
  test(`OfficeParser 8 extracts real ${format} files for inspection and channel materialization`, async t => {
    const { workspace, service } = await fixture(t);
    const fileName = `fixture.${format}`;
    const path = join(workspace, fileName);
    await creates[format](service, workspace, path);
    assert.match((await service.inspect(workspace, { path })).text, /Parser compatibility fixture/u);
    const result = await officeExtractorV1.materialize({
      sourceKind: "attachment", attachment: { kind: "office", fileName, path: fileName, sizeBytes: (await stat(path)).size },
      attachmentsDir: workspace, maxBytes: 1024 * 1024, maxChars: 10000,
    });
    assert.equal(result.status, "available", JSON.stringify(result));
    assert.match(result.contentText, /Parser compatibility fixture/u);
    assert.equal(result.structuredSummary.format, format);
    assert.equal(result.truncated, false);
  });
}

test("inspection does not publish text after cancellation during asynchronous conversion", async t => {
  const { workspace, service } = await fixture(t);
  const path = join(workspace, "fixture.docx");
  await writeFile(path, "fixture");
  const controller = new AbortController();
  const reason = new Error("cancelled during conversion");
  t.mock.method(OfficeParser, "parseOffice", async () => ({
    async to(format) {
      assert.equal(format, "text");
      controller.abort(reason);
      return { value: "must not publish" };
    },
  }));
  await assert.rejects(service.inspect(workspace, { path }, controller.signal), error => error === reason);
});

test("channel materialization retains a blocked result when asynchronous conversion fails", async t => {
  const { workspace } = await fixture(t);
  await writeFile(join(workspace, "fixture.docx"), "fixture");
  t.mock.method(OfficeParser, "parseOffice", async () => ({ async to() { throw new Error("conversion failed"); } }));
  const result = await officeExtractorV1.materialize({
    sourceKind: "attachment", attachment: { kind: "office", fileName: "fixture.docx", path: "fixture.docx", sizeBytes: 7 },
    attachmentsDir: workspace, maxBytes: 1024, maxChars: 100,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.errorCode, "parser_failed");
  assert.equal(result.errorMessage, "conversion failed");
});
