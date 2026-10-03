import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import test from "node:test";
import JSZip from "jszip";
import { Packer } from "docx";
import { OfficeParser } from "officeparser";
import PptxGenJS from "pptxgenjs";
import XlsxPopulate from "xlsx-populate";

// Select an actual compilation only; no source rewriting or injected producer.
const dist = process.env.LING_OFFICE_PREPARATION_TEST_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const { prepareOfficeArtifact } = await import(pathToFileURL(join(dist, "features/office-documents/office-artifact-preparation.js")).href);
const MIB = 1024 * 1024;
const MAX_BYTES = 50 * MIB;
const inputFor = {
  xlsx: { path: "reports/book.xlsx", sheets: [{ name: "Summary", rows: [["Metric", "Value"], ["Users", 42]], columnWidths: [18, 12], freezeHeader: true }] },
  docx: { path: "reports/brief.docx", blocks: [{ type: "paragraph", text: "Ling Office document", heading: 1 }, { type: "table", rows: [["Key", "Value"], ["Users", 42]] }] },
  pptx: { path: "reports/deck.pptx", title: "Ling deck", slides: [{ title: "Overview", bullets: ["Local", "Native"] }, { title: "Second", bullets: ["Overview again"] }] },
};
const createTool = { xlsx: "office_create_workbook", docx: "office_create_document", pptx: "office_create_presentation" };
const editTool = { xlsx: "office_edit_workbook", docx: "office_edit_document", pptx: "office_edit_presentation" };
const editInput = {
  xlsx: { path: inputFor.xlsx.path, edits: [{ sheet: "Summary", cell: "B2", value: 43, bold: true, numberFormat: "0.00" }] },
  docx: { path: inputFor.docx.path, replacements: [{ search: "Ling Office", replace: "Native Office" }], appendParagraphs: ["Added without rebuilding"] },
  pptx: { path: inputFor.pptx.path, replacements: [{ slide: 1, search: "Overview", replace: "Roadmap" }] },
};
const sources = Object.fromEntries(await Promise.all(Object.entries(createTool).map(async ([format, name]) => [format, (await prepareOfficeArtifact(name, inputFor[format])).bytes])));
const snapshot = format => ({ format, bytes: sources[format] });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rootMember = { xlsx: "xl/workbook.xml", docx: "word/document.xml", pptx: "ppt/presentation.xml" };
const text = async (bytes, format) => (await OfficeParser.parseOffice(bytes, { fileType: format, extractAttachments: false, ocr: false })).toText();

for (const format of Object.keys(createTool)) {
  test(`create ${format} uses real public SDK bytes and existing result fields`, async () => {
    const result = await prepareOfficeArtifact(createTool[format], inputFor[format]);
    assert.equal(Buffer.isBuffer(result.bytes), true);
    assert.equal(result.format, format);
    assert.equal(result.requestedPath, inputFor[format].path);
    assert.equal(result.overwrite, false);
    const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true });
    assert.ok(zip.file("[Content_Types].xml"));
    assert.ok(zip.file(rootMember[format]));
    assert.match(await text(result.bytes, format), new RegExp(format === "docx" ? "Ling Office" : format === "xlsx" ? "Users" : "Overview"));
    assert.deepEqual(result.resultDetails, format === "xlsx" ? { format, sheetCount: 1 } : format === "docx" ? { format, blockCount: 2 } : { format, slideCount: 2 });
    for (const forbidden of ["path", "recoveryPath", "safe", "receipt", "status", "executionId"]) assert.equal(forbidden in result, false);
  });

  test(`edit ${format} uses one captured snapshot without modifying original bytes`, async () => {
    const bytes = Buffer.from(sources[format]);
    const before = hash(bytes);
    const result = await prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes });
    assert.equal(hash(bytes), before);
    assert.notEqual(hash(result.bytes), before);
    assert.equal(result.overwrite, true);
    assert.match(await text(result.bytes, format), new RegExp(format === "xlsx" ? "43" : format === "docx" ? "Native Office" : "Roadmap"));
    assert.deepEqual(result.resultDetails, format === "xlsx" ? { format, editCount: 1 } : format === "docx" ? { format, replacementCount: 1, appendedParagraphCount: 1 } : { format, replacementCount: 1, changedSlides: [1] });
  });

  test(`edit ${format} owns snapshot bytes before the first await`, async () => {
    const backing = Buffer.concat([Buffer.from("prefix"), sources[format], Buffer.from("suffix")]);
    const bytes = backing.subarray(6, backing.length - 6);
    const pending = prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes });
    backing.fill(0);
    const result = await pending;
    assert.match(await text(result.bytes, format), new RegExp(format === "xlsx" ? "43" : format === "docx" ? "Native Office" : "Roadmap"));
  });
}

test("preparation never writes files or accesses network; input URLs remain text", async t => {
  const deny = () => { throw new Error("unexpected physical effect in pure preparation"); };
  for (const name of ["readFile", "mkdir", "copyFile", "writeFile", "link", "rename", "unlink", "open"]) t.mock.method(fs.promises, name, deny);
  for (const name of ["readFileSync", "mkdirSync", "copyFileSync", "writeFileSync", "linkSync", "renameSync", "unlinkSync", "openSync"]) t.mock.method(fs, name, deny);
  t.mock.method(https, "get", deny);
  t.mock.method(http, "get", deny);
  t.mock.method(globalThis, "fetch", deny);
  t.mock.method(PptxGenJS.prototype, "writeFile", deny);
  const result = await prepareOfficeArtifact(createTool.pptx, {
    path: "/definitely-not-created/deck.pptx", slides: [{ title: "https://example.invalid/image.png", bullets: ["/private/not-read.png"], image: { path: "https://example.invalid/not-fetched.png" } }],
  });
  assert.match(await text(result.bytes, "pptx"), /example\.invalid\/image/u);
  for (const format of ["xlsx", "docx"]) await prepareOfficeArtifact(createTool[format], inputFor[format]);
  for (const format of Object.keys(editTool)) await prepareOfficeArtifact(editTool[format], editInput[format], snapshot(format));
});

test("captured bytes still prepare after the original disk files and directory are removed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ling-office-captured-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const captured = {};
  for (const format of Object.keys(createTool)) {
    const path = join(dir, `source.${format}`);
    await writeFile(path, sources[format]);
    captured[format] = await readFile(path);
  }
  await rm(dir, { recursive: true, force: true });
  for (const format of Object.keys(editTool)) {
    const result = await prepareOfficeArtifact(editTool[format], { ...editInput[format], path: join(dir, "missing-parent", `source.${format}`) }, { format, bytes: captured[format] });
    assert.equal(result.bytes.length > 0, true);
  }
  assert.equal(fs.existsSync(dir), false);
});

test("create workbook owns nested input before SDK awaits", async () => {
  const input = structuredClone(inputFor.xlsx);
  const pending = prepareOfficeArtifact(createTool.xlsx, input);
  input.sheets[0].rows[1][0] = "mutated while waiting";
  const result = await pending;
  assert.match(await text(result.bytes, "xlsx"), /Users/u);
  assert.doesNotMatch(await text(result.bytes, "xlsx"), /mutated/u);
});

test("create overwrite is data only; mixed-case extension is retained", async () => {
  const result = await prepareOfficeArtifact(createTool.docx, { ...inputFor.docx, path: "report.DOCX", overwrite: true });
  assert.equal(result.requestedPath, "report.DOCX");
  assert.equal(result.overwrite, true);
});

test("workbook values, date, formula, formatting and package shape remain supported", async () => {
  const created = await prepareOfficeArtifact(createTool.xlsx, { path: "book.xlsx", sheets: [{ name: "Values", rows: [[true, null, { date: "2026-10-04" }, 42]], freezeHeader: true, columnWidths: [18] }] });
  const result = await prepareOfficeArtifact(editTool.xlsx, { path: "book.xlsx", edits: [{ sheet: "Values", cell: "d1", formula: "40+4", bold: true }] }, { format: "xlsx", bytes: created.bytes });
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(xml, /<f>40\+4<\/f>/u);
  assert.match(xml, /<pane\b[^>]*\bySplit="1"/u);
  assert.match(xml, /<col\b[^>]*\bwidth="18"/u);
});

for (const format of ["docx", "pptx"]) {
  test(`edit ${format} preserves unrelated ZIP members`, async () => {
    const zip = await JSZip.loadAsync(sources[format]);
    zip.file("customXml/ling-preservation.txt", "preserve-me");
    const original = await zip.generateAsync({ type: "nodebuffer" });
    const result = await prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes: original });
    assert.equal(await (await JSZip.loadAsync(result.bytes)).file("customXml/ling-preservation.txt").async("string"), "preserve-me");
  });
}

test("presentation all replacement traverses slides and reports sorted changedSlides", async () => {
  const result = await prepareOfficeArtifact(editTool.pptx, { path: "deck.pptx", replacements: [{ search: "Overview", replace: "Roadmap", all: true }] }, snapshot("pptx"));
  assert.deepEqual(result.resultDetails, { format: "pptx", replacementCount: 2, changedSlides: [1, 2] });
});

test("document first/all replacements keep existing counting semantics", async () => {
  const original = await prepareOfficeArtifact(createTool.docx, { path: "doc.docx", blocks: [{ type: "paragraph", text: "echo echo" }, { type: "paragraph", text: "echo" }] });
  for (const [all, count] of [[false, 1], [true, 3]]) {
    const result = await prepareOfficeArtifact(editTool.docx, { path: "doc.docx", replacements: [{ search: "echo", replace: "changed", all }] }, { format: "docx", bytes: original.bytes });
    assert.equal(result.resultDetails.replacementCount, count);
  }
});

for (const badInput of [null, [], "text", {}]) {
  test(`invalid top-level input ${JSON.stringify(badInput)} rejects without a payload`, async () => {
    await assert.rejects(prepareOfficeArtifact(createTool.docx, badInput), /must be an object|path must be a string/u);
  });
}
test("unknown tools and non-data callbacks cannot enter preparation", async () => {
  await assert.rejects(prepareOfficeArtifact("office_save_workbook_as", inputFor.xlsx), /office_documents_tool_unavailable/u);
  await assert.rejects(prepareOfficeArtifact("toString", inputFor.xlsx), /office_documents_tool_unavailable/u);
  await assert.rejects(prepareOfficeArtifact(createTool.docx, { ...inputFor.docx, callback: () => {} }), { name: "DataCloneError" });
});

for (const format of Object.keys(createTool)) {
  test(`${format} format mismatch and missing/wrong snapshot reject`, async () => {
    await assert.rejects(prepareOfficeArtifact(createTool[format], { ...inputFor[format], path: "file.txt" }), /office_document_format_unsupported/u);
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format]), /office_preparation_snapshot_required/u);
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes: "not-binary" }), /office_preparation_snapshot_required/u);
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], { format: "other", bytes: sources[format] }), /office_document_format_unsupported/u);
  });
  test(`${format} source byte budget rejects zero and overflow before parsing`, async t => {
    const spy = t.mock.method(OfficeParser, "parseOffice", () => { throw new Error("parser should not enter"); });
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1)]) {
      await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes }), /office_document_too_large/u);
    }
    assert.equal(spy.mock.callCount(), 0);
  });
}

test("50 MiB source passes the size gate, then fails independently as an invalid package", async () => {
  await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes: Buffer.alloc(MAX_BYTES) }), /office_document_package_invalid/u);
});

const invalidCases = [
  ["sheet name", "xlsx", { sheets: [{ name: "bad/name", rows: [] }] }, /office_worksheet_name_invalid/u],
  ["cell date", "xlsx", { sheets: [{ name: "Sheet", rows: [[{ date: "invalid" }]] }] }, /office_cell_date_invalid/u],
  ["cell value", "xlsx", { sheets: [{ name: "Sheet", rows: [[{ unsupported: true }]] }] }, /office_cell_value_unsupported/u],
  ["column width", "xlsx", { sheets: [{ name: "Sheet", rows: [], columnWidths: [81] }] }, /office_column_width_invalid/u],
  ["column count", "xlsx", { sheets: [{ name: "Sheet", rows: [new Array(257).fill(0)] }] }, /0-256 items/u],
  ["row count", "xlsx", { sheets: [{ name: "Sheet", rows: new Array(10001).fill([]) }] }, /0-10000 items/u],
  ["sheets", "xlsx", { sheets: [] }, /1-100 items/u],
  ["document blocks", "docx", { blocks: [] }, /1-2000 items/u],
  ["document block type", "docx", { blocks: [{ type: "image", path: "https://example.invalid" }] }, /office_document_block_unsupported/u],
  ["document text", "docx", { blocks: [{ type: "paragraph", text: "x".repeat(50001) }] }, /paragraph.text must be a string/u],
  ["presentation slides", "pptx", { slides: [] }, /1-200 items/u],
  ["presentation title", "pptx", { slides: [{ title: "x".repeat(513) }] }, /slide.title must be a string/u],
  ["presentation bullets", "pptx", { slides: [{ title: "Title", bullets: new Array(31).fill("x") }] }, /0-30 items/u],
];
for (const [name, format, fields, error] of invalidCases) {
  test(`create invalid ${name} preserves validation errors`, async () => {
    await assert.rejects(prepareOfficeArtifact(createTool[format], { ...inputFor[format], ...fields }), error);
  });
}
const invalidEdits = [
  ["missing sheet", "xlsx", { edits: [{ sheet: "Missing", cell: "A1", value: 1 }] }, /office_worksheet_not_found/u],
  ["cell address", "xlsx", { edits: [{ sheet: "Summary", cell: "A0", value: 1 }] }, /office_cell_address_invalid/u],
  ["missing value", "xlsx", { edits: [{ sheet: "Summary", cell: "A1" }] }, /office_edit_value_required/u],
  ["formula length", "xlsx", { edits: [{ sheet: "Summary", cell: "A1", formula: "x".repeat(8193) }] }, /formula must be a string/u],
  ["empty doc edit", "docx", { replacements: [], appendParagraphs: [] }, /office_document_edit_required/u],
  ["replacement fields", "docx", { replacements: [{ search: "Ling", replace: "X", slide: 1 }], appendParagraphs: [] }, /office_edit_replacement_invalid/u],
  ["not found", "docx", { replacements: [{ search: "absent", replace: "X" }], appendParagraphs: [] }, /office_edit_text_not_found/u],
  ["empty presentation edit", "pptx", { replacements: [] }, /office_presentation_edit_required/u],
  ["slide zero", "pptx", { replacements: [{ slide: 0, search: "Overview", replace: "X" }] }, /slide must be an integer/u],
  ["wrong slide", "pptx", { replacements: [{ slide: 2, search: "Second absent", replace: "X" }] }, /office_edit_text_not_found/u],
];
for (const [name, format, fields, error] of invalidEdits) {
  test(`edit invalid ${name} preserves validation errors`, async () => {
    await assert.rejects(prepareOfficeArtifact(editTool[format], { ...editInput[format], ...fields }, snapshot(format)), error);
  });
}

for (const format of Object.keys(editTool)) {
  test(`${format} invalid ZIP and missing required format part reject`, async () => {
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes: Buffer.from("not zip") }), /office_document_package_invalid/u);
    const zip = await JSZip.loadAsync(sources[format]);
    zip.remove(rootMember[format]);
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], { format, bytes: await zip.generateAsync({ type: "nodebuffer" }) }), /office_document_package_invalid/u);
  });
}
for (const [name, member, error] of [
  ["content types", "[Content_Types].xml", /office_document_package_invalid/u],
  ["macro", "word/vbaProject.bin", /office_document_executable_unsupported/u],
  ["ActiveX", "word/activeX/thing.bin", /office_document_executable_unsupported/u],
  ["embedded object", "word/embeddings/thing.bin", /office_document_executable_unsupported/u],
  ["OLE", "word/oleObject.bin", /office_document_executable_unsupported/u],
  ["unsafe path", "../escaped.txt", /office_document_package_invalid/u],
]) {
  test(`document rejects ${name} before SDK edits`, async () => {
    const zip = await JSZip.loadAsync(sources.docx);
    if (name === "content types") zip.remove(member); else zip.file(member, "blocked");
    await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes: await zip.generateAsync({ type: "nodebuffer" }) }), error);
  });
}
test("ZIP entry budget remains 5000", async () => {
  const zip = await JSZip.loadAsync(sources.docx);
  for (let i = 0; i < 5001; i++) zip.file(`entry-${i}`, "");
  await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes: await zip.generateAsync({ type: "nodebuffer" }) }), /office_document_package_invalid/u);
});
test("ZIP CRC failure is not accepted as an editable snapshot", async () => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("customXml/crc.txt", "unique-crc-marker");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  const offset = bytes.indexOf("unique-crc-marker");
  assert.ok(offset > 0);
  bytes[offset] ^= 1;
  await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes }), /office_document_package_invalid/u);
});

async function documentWithPadding(parts) {
  const zip = await JSZip.loadAsync(sources.docx);
  for (const [name, size] of parts) zip.file(name, Buffer.alloc(size));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("expanded package exact 128 MiB is accepted, including a parser-ignored binary part", async () => {
  const zip = await JSZip.loadAsync(sources.docx);
  let baseSize = 0;
  for (const entry of Object.values(zip.files)) if (!entry.dir) baseSize += (await entry.async("uint8array")).byteLength;
  const bytes = await documentWithPadding([["padding.bin", 128 * MIB - baseSize]]);
  assert.ok(bytes.length < MAX_BYTES);
  const result = await prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes });
  assert.equal(result.resultDetails.replacementCount, 1);
  assert.ok((await JSZip.loadAsync(result.bytes)).file("padding.bin"));
});

for (const [name, parts, error] of [
  ["single parser-ignored member", [["padding.bin", 128 * MIB + 1]], /office_document_too_large/u],
  ["multiple cumulative members", [["part-one.bin", 70 * MIB], ["part-two.bin", 60 * MIB]], /office_document_too_large/u],
  ["parser-ignored XML", [["ignored.xml", 8 * MIB + 1]], /office_document_xml_too_large/u],
]) {
  test(`expanded budget stops ${name} before CRC and parser`, async t => {
    const bytes = await documentWithPadding(parts);
    const crcFlags = [];
    const original = JSZip.loadAsync;
    t.mock.method(JSZip, "loadAsync", function (data, options) {
      crcFlags.push(options?.checkCRC32);
      return original.call(this, data, options);
    });
    const parser = t.mock.method(OfficeParser, "parseOffice", async () => { throw new Error("parser must not enter before budget"); });
    await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes }), error);
    assert.deepEqual(crcFlags, [false]);
    assert.equal(parser.mock.callCount(), 0);
  });
}

test("expanded stream cancellation propagates without CRC, parser or payload", async t => {
  const bytes = await documentWithPadding([["padding.bin", 2 * MIB]]);
  const cancelled = new AbortController();
  const reason = new Error("cancelled expanded preflight");
  const parser = t.mock.method(OfficeParser, "parseOffice", async () => { throw new Error("parser must not run after cancellation"); });
  const pending = prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes }, cancelled.signal);
  setImmediate(() => cancelled.abort(reason));
  await assert.rejects(pending, error => error === reason);
  assert.equal(parser.mock.callCount(), 0);
});

for (const closeOnly of [false, true]) {
  test(`expanded member ${closeOnly ? "close without end" : "async stream error"} rejects rather than hanging`, { timeout: 2000 }, async t => {
    const failure = new Error("async public ZIP member error");
    const original = JSZip.loadAsync;
    t.mock.method(JSZip, "loadAsync", async function (bytes, options) {
      const zip = await original.call(this, bytes, options);
      t.mock.method(zip.file("word/document.xml"), "nodeStream", () => new Readable({
        read() { this.destroy(closeOnly ? undefined : failure); },
      }));
      return zip;
    });
    await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, snapshot("docx")), closeOnly ? /office_document_package_invalid/u : error => error === failure);
  });
}

test("exact 8 MiB XML member is admitted by the streaming and edit byte guards", async t => {
  t.mock.method(OfficeParser, "parseOffice", async () => ({}));
  const prefix = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
  const suffix = "</w:body></w:document>";
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("word/document.xml", prefix + " ".repeat(8 * MIB - prefix.length - suffix.length) + suffix);
  const result = await prepareOfficeArtifact(editTool.docx, { path: "brief.docx", appendParagraphs: ["append"] }, { format: "docx", bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) });
  assert.equal(result.resultDetails.appendedParagraphCount, 1);
});

function centralRows(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const rows = [];
  for (let index = 0; index < count; index++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    rows.push({ offset, local: bytes.readUInt32LE(offset + 42), name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8") });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return rows;
}
async function rejectBeforeSdk(t, bytes) {
  const load = t.mock.method(JSZip, "loadAsync", async () => { throw new Error("ambiguous raw roster must not reach JSZip/CRC"); });
  await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes }), /office_document_package_invalid/u);
  assert.equal(load.mock.callCount(), 0);
}

test("duplicate raw entry with hidden oversized payload rejects before folded JSZip budget", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("entry-a.bin", Buffer.alloc(128 * MIB + 1));
  zip.file("entry-b.bin", "small");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const second = centralRows(bytes).find(row => row.name === "entry-b.bin");
  bytes.write("entry-a.bin", second.offset + 46, "utf8");
  bytes.write("entry-a.bin", second.local + 30, "utf8");
  const folded = await JSZip.loadAsync(bytes, { checkCRC32: false });
  assert.equal(await folded.file("entry-a.bin").async("string"), "small");
  await rejectBeforeSdk(t, bytes);
});

test("directory with hidden oversized payload rejects before JSZip discards it", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("hidden.bin", Buffer.alloc(128 * MIB + 1));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const row = centralRows(bytes).find(item => item.name === "hidden.bin");
  bytes.writeUInt32LE(bytes.readUInt32LE(row.offset + 38) | 0x10, row.offset + 38);
  const folded = await JSZip.loadAsync(bytes, { checkCRC32: false });
  assert.equal(folded.files["hidden.bin/"].dir, true);
  assert.equal((await folded.files["hidden.bin/"].async("nodebuffer")).byteLength, 0);
  await rejectBeforeSdk(t, bytes);
});

test("declared-empty member cannot conceal a nonempty compressed payload", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("hidden.bin", "nonempty compressed payload");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const row = centralRows(bytes).find(item => item.name === "hidden.bin");
  bytes.writeUInt32LE(0, row.offset + 24);
  bytes.writeUInt32LE(0, row.local + 22);
  assert.equal((await (await JSZip.loadAsync(bytes, { checkCRC32: false })).file("hidden.bin").async("nodebuffer")).length, 0);
  await rejectBeforeSdk(t, bytes);
});

test("Unix permission-only directory cannot hide payload from the public member roster", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("hidden-unix.bin", Buffer.alloc(128 * MIB + 1));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const row = centralRows(bytes).find(item => item.name === "hidden-unix.bin");
  bytes.writeUInt16LE((bytes.readUInt16LE(row.offset + 4) & 0xff) | (3 << 8), row.offset + 4);
  bytes.writeUInt32LE(((bytes.readUInt32LE(row.offset + 38) & 0xffff) | (0x4000 << 16)) >>> 0, row.offset + 38);
  // This library version loses the permission-only directory and then throws
  // assigning unsafeOriginalName. The fixed roster rejects before SDK handling.
  await assert.rejects(JSZip.loadAsync(bytes, { checkCRC32: false }), /unsafeOriginalName/u);
  await rejectBeforeSdk(t, bytes);
});

test("directory flag and slash aliases cannot collapse the raw roster", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("collide", "");
  zip.folder("collide");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const row = centralRows(bytes).find(item => item.name === "collide");
  bytes.writeUInt32LE(bytes.readUInt32LE(row.offset + 38) | 0x10, row.offset + 38);
  await rejectBeforeSdk(t, bytes);
});

test("local header name mismatch cannot bypass central roster identity", async t => {
  const bytes = Buffer.from(sources.docx);
  const row = centralRows(bytes).find(item => item.name === "word/document.xml");
  bytes.write("word/otherdoc.xml", row.local + 30, "utf8");
  await rejectBeforeSdk(t, bytes);
});

test("normalized dot aliases and ZIP64/multivolume metadata are fail-closed", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("customXml/./alias.txt", "ambiguous");
  const alias = await zip.generateAsync({ type: "nodebuffer" });
  const zip64 = Buffer.from(sources.docx);
  const end = zip64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  zip64.writeUInt16LE(0xffff, end + 10);
  const volume = Buffer.from(sources.docx);
  volume.writeUInt16LE(1, end + 4);
  const load = t.mock.method(JSZip, "loadAsync", async () => { throw new Error("unsupported roster must reject before SDK"); });
  for (const bytes of [alias, zip64, volume]) await assert.rejects(prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes }), /office_document_package_invalid/u);
  assert.equal(load.mock.callCount(), 0);
});

test("ordinary UTF8 member names and public streamed ZIP output remain supported", async () => {
  const zip = await JSZip.loadAsync(sources.docx);
  zip.file("customXml/中文.txt", "preserve Unicode");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
  const result = await prepareOfficeArtifact(editTool.docx, editInput.docx, { format: "docx", bytes });
  assert.equal(await (await JSZip.loadAsync(result.bytes)).file("customXml/中文.txt").async("string"), "preserve Unicode");
});

test("EOCD signature embedded in the ZIP comment cannot select a second SDK roster", async t => {
  const zip = await JSZip.loadAsync(sources.docx);
  const bytes = await zip.generateAsync({ type: "nodebuffer", comment: "ordinary comment PK\x05\x06 trailing" });
  await rejectBeforeSdk(t, bytes);
});

for (const [name, xml, error] of [
  ["empty", "", /office_document_xml_too_large/u],
  ["malformed", '<w:document xmlns:w="broken"><w:body', /office_document_xml_invalid/u],
  ["missing body", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', /office_document_package_invalid/u],
  ["overflow", "x".repeat(8 * MIB + 1), /office_document_xml_too_large/u],
]) {
  test(`XML ${name} is rejected by bounded shared edit helpers`, async t => {
    // Isolate Ling's existing XML guard from the SDK's own earlier parser errors.
    t.mock.method(OfficeParser, "parseOffice", async () => ({}));
    const zip = await JSZip.loadAsync(sources.docx);
    zip.file("word/document.xml", xml);
    await assert.rejects(prepareOfficeArtifact(editTool.docx, { path: "brief.docx", appendParagraphs: ["append"] }, { format: "docx", bytes: await zip.generateAsync({ type: "nodebuffer" }) }), error);
  });
}

async function mockCreateOutput(t, format, value) {
  if (format === "docx") t.mock.method(Packer, "toBuffer", async () => value);
  else if (format === "pptx") t.mock.method(PptxGenJS.prototype, "write", async () => value);
  else {
    const original = XlsxPopulate.fromBlankAsync;
    t.mock.method(XlsxPopulate, "fromBlankAsync", async () => {
      const workbook = await original.call(XlsxPopulate);
      t.mock.method(workbook, "outputAsync", async () => value);
      return workbook;
    });
  }
}
for (const format of Object.keys(createTool)) {
  for (const [label, size] of [["zero", 0], ["exact 50 MiB", MAX_BYTES], ["overflow", MAX_BYTES + 1]]) {
    test(`${format} output budget ${label} is checked only by new preparation`, async t => {
      const sdkBytes = Buffer.alloc(size);
      await mockCreateOutput(t, format, sdkBytes);
      if (size === MAX_BYTES) {
        const result = await prepareOfficeArtifact(createTool[format], inputFor[format]);
        assert.equal(result.bytes.byteLength, size);
        assert.notEqual(result.bytes, sdkBytes);
        sdkBytes[0] = 1;
        assert.equal(result.bytes[0], 0);
      } else await assert.rejects(prepareOfficeArtifact(createTool[format], inputFor[format]), /office_document_too_large/u);
    });
  }
}
for (const [name, output] of [["typed-array view", new Uint8Array([0, 1, 2, 3]).subarray(1, 3)], ["ArrayBuffer", new Uint8Array([1, 2]).buffer]]) {
  test(`SDK ${name} output is copied with the exact byte range`, async t => {
    await mockCreateOutput(t, "docx", output);
    const result = await prepareOfficeArtifact(createTool.docx, inputFor.docx);
    assert.deepEqual(result.bytes, Buffer.from([1, 2]));
    new Uint8Array(output instanceof ArrayBuffer ? output : output.buffer).fill(9);
    assert.deepEqual(result.bytes, Buffer.from([1, 2]));
  });
}
test("unexpected non-binary SDK output rejects rather than coercing", async t => {
  await mockCreateOutput(t, "docx", "not-binary");
  await assert.rejects(prepareOfficeArtifact(createTool.docx, inputFor.docx), /office_document_output_invalid/u);
});

for (const [name, install, toolName, input, source] of [
  ["xlsx load blank", (t, fail) => t.mock.method(XlsxPopulate, "fromBlankAsync", fail), createTool.xlsx, inputFor.xlsx],
  ["xlsx load bytes", (t, fail) => t.mock.method(XlsxPopulate, "fromDataAsync", fail), editTool.xlsx, editInput.xlsx, snapshot("xlsx")],
  ["docx serializer", (t, fail) => t.mock.method(Packer, "toBuffer", fail), createTool.docx, inputFor.docx],
  ["pptx serializer", (t, fail) => t.mock.method(PptxGenJS.prototype, "write", fail), createTool.pptx, inputFor.pptx],
  ["ZIP edit serializer", (t, fail) => t.mock.method(JSZip.prototype, "generateAsync", fail), editTool.docx, editInput.docx, snapshot("docx")],
  ["Office parser", (t, fail) => t.mock.method(OfficeParser, "parseOffice", fail), editTool.docx, editInput.docx, snapshot("docx")],
]) {
  test(`async SDK failure propagates: ${name}`, async t => {
    const failure = new Error(`actual async rejection: ${name}`);
    install(t, async () => { throw failure; });
    await assert.rejects(prepareOfficeArtifact(toolName, input, source), error => error === failure);
  });
}
test("xlsx outputAsync rejection is propagated", async t => {
  const failure = new Error("async xlsx output failure");
  const original = XlsxPopulate.fromBlankAsync;
  t.mock.method(XlsxPopulate, "fromBlankAsync", async () => {
    const workbook = await original.call(XlsxPopulate);
    t.mock.method(workbook, "outputAsync", async () => { throw failure; });
    return workbook;
  });
  await assert.rejects(prepareOfficeArtifact(createTool.xlsx, inputFor.xlsx), error => error === failure);
});

test("abort before all six methods and after an SDK await yields no payload", async t => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled preparation"));
  for (const format of Object.keys(createTool)) {
    await assert.rejects(prepareOfficeArtifact(createTool[format], inputFor[format], undefined, cancelled.signal), /cancelled preparation/u);
    await assert.rejects(prepareOfficeArtifact(editTool[format], editInput[format], snapshot(format), cancelled.signal), /cancelled preparation/u);
  }
  let resolveOutput;
  t.mock.method(Packer, "toBuffer", () => new Promise(resolve => { resolveOutput = resolve; }));
  const during = new AbortController();
  const pending = prepareOfficeArtifact(createTool.docx, inputFor.docx, undefined, during.signal);
  during.abort(new Error("cancelled during serialization"));
  resolveOutput(sources.docx);
  await assert.rejects(pending, /cancelled during serialization/u);
});
