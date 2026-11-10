import { statSync } from "node:fs";
import ExcelJS from "exceljs";
import type {
  SpreadsheetCell,
  SpreadsheetSheetMeta,
  SpreadsheetSheetWindow,
  SpreadsheetWorkbook,
} from "@ling-stack/contracts";
import { clampSpreadsheetWindow } from "@ling-stack/contracts";

const MAX_EXTRACT_CELLS = 2_000_000;

export interface SpreadsheetExtraction {
  readonly workbook: SpreadsheetWorkbook;
  readonly sizeBytes: number;
}


/**
 * Read workbook sheet metadata (names + bounds). Cell contents are fetched
 * per window so a 500k-row sheet never crosses the wire whole.
 */
export async function extractSpreadsheetWorkbook(path: string): Promise<SpreadsheetExtraction> {
  const sizeBytes = statSync(path).size;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets: SpreadsheetSheetMeta[] = [];
  let budget = MAX_EXTRACT_CELLS;
  workbook.eachSheet((sheet, index) => {
    const rowCount = Math.min(sheet.rowCount, budget > 0 ? Math.floor(budget / Math.max(sheet.columnCount, 1)) : 0);
    budget -= rowCount * Math.max(sheet.columnCount, 1);
    sheets.push({
      index: index - 1,
      name: sheet.name,
      rowCount,
      colCount: sheet.columnCount,
    });
  });
  return { workbook: { schemaVersion: 1, sheets }, sizeBytes };
}

export async function extractSpreadsheetSheetWindow(
  path: string,
  sheetIndex: number,
  requested: { rowStart?: number; rowEnd?: number; colStart?: number; colEnd?: number },
): Promise<SpreadsheetSheetWindow> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[sheetIndex];
  if (!sheet) {
    throw new Error(`Unknown worksheet index: ${sheetIndex}`);
  }
  const rowCount = sheet.rowCount;
  const colCount = sheet.columnCount;
  const window = clampSpreadsheetWindow(rowCount, colCount, requested);
  const cells: SpreadsheetCell[][] = [];
  for (let rowIndex = window.rowStart; rowIndex < window.rowEnd; rowIndex += 1) {
    const row: SpreadsheetCell[] = [];
    const sheetRow = sheet.getRow(rowIndex + 1);
    for (let colIndex = window.colStart; colIndex < window.colEnd; colIndex += 1) {
      const cell = sheetRow.getCell(colIndex + 1);
      const formula = typeof cell.formula === "string" && cell.formula.length > 0 ? cell.formula : undefined;
      let value: SpreadsheetCell["v"] = null;
      const result = cell.value;
      if (result !== null && result !== undefined) {
        if (typeof result === "object" && ! (result instanceof Date)) {
          const rich = result as { result?: unknown; text?: unknown; hyperlink?: unknown };
          if (rich.result !== undefined) value = normalizeValue(rich.result);
          else if (typeof rich.text === "string") value = rich.text;
          else if (typeof rich.hyperlink === "string") value = rich.hyperlink;
          else value = cell.text ?? null;
        } else {
          value = normalizeValue(result);
        }
      }
      row.push({ v: value, f: formula });
    }
    cells.push(row);
  }
  return {
    schemaVersion: 1,
    sheetIndex,
    sheetName: sheet.name,
    rowStart: window.rowStart,
    rowEnd: window.rowEnd,
    colStart: window.colStart,
    colEnd: window.colEnd,
    rowCount,
    colCount,
    cells,
  };
}

function normalizeValue(raw: unknown): SpreadsheetCell["v"] {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}
