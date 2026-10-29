import { readFileSync, statSync } from "node:fs";
import { unzipSync } from "fflate";
import type { SpreadsheetWorkbook } from "@ling-stack/contracts";

/**
 * Synchronous sheet-name extraction for preview envelopes: reads only the zip
 * entry xl/workbook.xml so a preview never pays for a full ExcelJS parse.
 * Row/column counts are discovered authoritatively by the windowed route.
 *
 * Deliberately ExcelJS-free: this module sits in the preview dependency graph
 * that the keychain sandbox fixture loads, and the fixture's ESM loader
 * cannot handle exceljs's deep CJS chain.
 */
export function extractSpreadsheetSheetNamesSync(path: string, maxBytes: number): SpreadsheetWorkbook {
  const sizeBytes = statSync(path).size;
  const names: string[] = [];
  if (sizeBytes <= maxBytes) {
    try {
      // Decompress only the workbook manifest entry — never every archive
      // member — so a highly compressed bomb cannot exhaust daemon memory.
      const files = unzipSync(readFileSync(path), {
        filter: (file) => file.name === "xl/workbook.xml",
      });
      const workbookXml = files["xl/workbook.xml"];
      if (workbookXml) {
        const xml = Buffer.from(workbookXml).toString("utf8");
        for (const match of xml.matchAll(/<sheet[^>]*\bname="([^"]+)"/gu)) {
          names.push(decodeXmlEntities(match[1]));
          if (names.length >= 100) break;
        }
      }
    } catch {
      // Not a readable zip: fall through to an empty listing.
    }
  }
  return {
    schemaVersion: 1,
    sheets: names.map((name, index) => ({ index, name, rowCount: 0, colCount: 0 })),
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}
