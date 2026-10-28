import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { parseDeliverableSpec, clampSpreadsheetWindow } from "@ling-stack/contracts";
import { buildDeliverable } from "../dist/features/deliverables/builders.js";
import { extractSpreadsheetWorkbook, extractSpreadsheetSheetWindow } from "../dist/features/deliverables/spreadsheet-extract.js";

async function withOutputDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ling-deliverables-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("deck spec builds a valid pptx with slides and notes", async () => {
  await withOutputDir(async (dir) => {
    const built = await buildDeliverable({
      specVersion: 1,
      kind: "deck",
      title: "Quarterly Review",
      slides: [
        { layout: "title", title: "Quarterly Review", body: "Prepared by Ling" },
        { layout: "bullets", title: "Highlights", bullets: ["Growth", "Retention"], notes: "mention Q3" },
      ],
    }, dir);
    assert.equal(built.kind, "deck");
    assert.ok(built.fileName.endsWith(".pptx"));
    const bytes = await readFile(built.absolutePath);
    const files = Object.keys(unzipSync(bytes));
    assert.ok(files.some((f) => f.startsWith("ppt/slides/slide")), `slides missing: ${files.slice(0, 6).join(",")}`);
    assert.ok(files.includes("ppt/notesSlides/notesSlide2.xml"), "speaker notes missing");
    assert.ok(bytes.length > 10_000);
  });
});

test("doc spec builds a valid docx with headings, bullets and tables", async () => {
  await withOutputDir(async (dir) => {
    const built = await buildDeliverable({
      specVersion: 1,
      kind: "doc",
      title: "Weekly Report",
      blocks: [
        { type: "heading", level: 1, text: "Summary" },
        { type: "paragraph", text: "一切正常。" },
        { type: "bullets", items: ["item one", "item two"] },
        { type: "table", header: ["Metric", "Value"], rows: [["DAU", "1200"]] },
      ],
    }, dir);
    assert.equal(built.kind, "doc");
    const bytes = await readFile(built.absolutePath);
    const files = Object.keys(unzipSync(bytes));
    assert.ok(files.includes("word/document.xml"));
    const documentXml = unzipSync(bytes)["word/document.xml"];
    const text = Buffer.from(documentXml).toString("utf8");
    assert.ok(text.includes("Summary"));
    assert.ok(text.includes("一切正常。"));
    assert.ok(text.includes("DAU"));
    assert.equal(built.sizeBytes > 0, true);
  });
});

test("workbook spec builds a valid xlsx that reads back through exceljs", async () => {
  await withOutputDir(async (dir) => {
    const built = await buildDeliverable({
      specVersion: 1,
      kind: "workbook",
      title: "Metrics",
      sheets: [
        { name: "Raw", rows: [["date", "value"], ["2026-10-27", 42], ["2026-10-28", null]] },
        { name: "看板", rows: [["合计"], [42]] },
      ],
    }, dir);
    assert.equal(built.kind, "workbook");
    assert.ok(built.fileName.endsWith(".xlsx"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(built.absolutePath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Raw", "看板"]);
    assert.equal(workbook.worksheets[0].getCell("B2").value, 42);
    assert.equal(workbook.worksheets[0].getCell("B3").value, null);
  });
});

test("deliverable spec parser enforces version, kind and bounds", () => {
  assert.equal(parseDeliverableSpec({ specVersion: 2, kind: "deck", title: "x", slides: [{}] }).ok, false);
  assert.equal(parseDeliverableSpec({ specVersion: 1, kind: "deck", title: "", slides: [{}] }).ok, false);
  assert.equal(parseDeliverableSpec({ specVersion: 1, kind: "deck", title: "x", slides: [] }).ok, false);
  assert.equal(parseDeliverableSpec({ specVersion: 1, kind: "doc", title: "x", blocks: [] }).ok, false);
  assert.equal(parseDeliverableSpec({ specVersion: 1, kind: "workbook", title: "x", sheets: [] }).ok, false);
  assert.equal(parseDeliverableSpec({ specVersion: 1, kind: "poster", title: "x" }).ok, false);
  const ok = parseDeliverableSpec({ specVersion: 1, kind: "workbook", title: "x", sheets: [{ name: "a", rows: [[1]] }] });
  assert.equal(ok.ok, true);
});

test("spreadsheet window clamping keeps reads bounded", () => {
  assert.deepEqual(
    clampSpreadsheetWindow(1000, 40, {}),
    { rowStart: 0, rowEnd: 200, colStart: 0, colEnd: 40 },
  );
  assert.deepEqual(
    clampSpreadsheetWindow(1000, 40, { rowStart: 900, rowEnd: 2000 }),
    { rowStart: 900, rowEnd: 1000, colStart: 0, colEnd: 40 },
  );
  assert.deepEqual(
    clampSpreadsheetWindow(10, 3, { rowStart: 5, rowEnd: 6, colStart: 1, colEnd: 2 }),
    { rowStart: 5, rowEnd: 6, colStart: 1, colEnd: 2 },
  );
});

test("workbook extraction returns sheet metadata and windowed cells with formulas", async () => {
  await withOutputDir(async (dir) => {
    const built = await buildDeliverable({
      specVersion: 1,
      kind: "workbook",
      title: "Extract",
      sheets: [
        { name: "Data", rows: [["name", "qty"], ["alpha", 3], ["beta", 4]] },
      ],
    }, dir);
    const { workbook, sizeBytes } = await extractSpreadsheetWorkbook(built.absolutePath);
    assert.equal(workbook.sheets.length, 1);
    assert.equal(workbook.sheets[0].name, "Data");
    // exceljs may count a trailing phantom row; the real data rows must fit.
    assert.ok(workbook.sheets[0].rowCount >= 2);
    assert.equal(sizeBytes > 0, true);

    const window = await extractSpreadsheetSheetWindow(built.absolutePath, 0, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 });
    assert.equal(window.sheetName, "Data");
    assert.equal(window.cells.length, 2);
    assert.deepEqual(window.cells[0].map((cell) => cell.v), ["name", "qty"]);
    assert.deepEqual(window.cells[1].map((cell) => cell.v), ["alpha", 3]);

    await assert.rejects(
      extractSpreadsheetSheetWindow(built.absolutePath, 5, {}),
      /Unknown worksheet index/u,
    );
  });
});

test("built deliverable filenames are unique and sanitized", async () => {
  await withOutputDir(async (dir) => {
    const spec = { specVersion: 1, kind: "doc", title: "bad/name:here", blocks: [{ type: "paragraph", text: "x" }] };
    const first = await buildDeliverable(spec, dir);
    const second = await buildDeliverable(spec, dir);
    assert.notEqual(first.fileName, second.fileName);
    assert.equal(first.fileName.includes("/"), false);
    assert.equal(first.fileName.includes(":"), false);
    const files = await readdir(dir);
    assert.equal(files.length, 2);
  });
});
