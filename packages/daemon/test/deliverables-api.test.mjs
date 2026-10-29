import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { createDaemonServer } from "../dist/index.js";

async function withDaemon(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-deliverables-api-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    await fn(`http://127.0.0.1:${port}`, cwd);
  } finally {
    await daemon.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

test("deliverable build route writes real files into the workspace", async () => {
  await withDaemon(async (baseUrl, cwd) => {
    const response = await fetch(`${baseUrl}/deliverables/build?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specVersion: 1,
        kind: "workbook",
        title: "Smoke Metrics",
        sheets: [{ name: "Data", rows: [["k", "v"], ["a", 1]] }],
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.kind, "workbook");
    assert.ok(body.path.startsWith(".ling-stack/deliverables/"));
    const stats = await stat(join(cwd, body.path));
    assert.ok(stats.size > 0);
  });
});

test("deliverable build route rejects invalid specs and methods", async () => {
  await withDaemon(async (baseUrl, cwd) => {
    const bad = await fetch(`${baseUrl}/deliverables/build?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specVersion: 9, kind: "deck", title: "x", slides: [] }),
    });
    assert.equal(bad.status, 400);
    const get = await fetch(`${baseUrl}/deliverables/build?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(get.status, 405);
  });
});

test("spreadsheet preview is workspace-bound and serves windows", async () => {
  await withDaemon(async (baseUrl, cwd) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["name", "qty"]);
    sheet.addRow(["alpha", 3]);
    const filePath = join(cwd, "sample.xlsx");
    await workbook.xlsx.writeFile(filePath);

    const meta = await fetch(`${baseUrl}/previews/spreadsheet?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("sample.xlsx")}`);
    assert.equal(meta.status, 200);
    const metaBody = await meta.json();
    assert.equal(metaBody.schemaVersion, 1);
    assert.equal(metaBody.sheets[0].name, "Data");

    const window = await fetch(`${baseUrl}/previews/spreadsheet?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("sample.xlsx")}&sheet=0&rowStart=0&rowEnd=2&colStart=0&colEnd=2`);
    assert.equal(window.status, 200);
    const windowBody = await window.json();
    assert.equal(windowBody.sheetName, "Data");
    assert.deepEqual(windowBody.cells[0].map((cell) => cell.v), ["name", "qty"]);

    // An existing file outside the workspace must be rejected by containment.
    const outsidePath = join(tmpdir(), `ling-outside-${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(outsidePath);
    try {
      const escape = await fetch(`${baseUrl}/previews/spreadsheet?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(`../${basename(outsidePath)}`)}`);
      assert.equal(escape.status, 403);
    } finally {
      await rm(outsidePath, { force: true }).catch(() => {});
    }

    const missing = await fetch(`${baseUrl}/previews/spreadsheet?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("nope.xlsx")}`);
    assert.equal(missing.status, 400);
  });
});
