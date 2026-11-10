import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";
import { Document, HeadingLevel, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { OfficeParser } from "officeparser";
import PptxGenJSModule from "pptxgenjs";
import XlsxPopulateModule from "xlsx-populate";
import type { Readable } from "node:stream";
import { assertOfficePackageRoster } from "./office-artifact-package-roster.js";

export type OfficeArtifactFormat = "xlsx" | "docx" | "pptx";
type XlsxCellValue = string | number | boolean | Date | null;

interface XlsxPopulateCell {
  value(value: XlsxCellValue): XlsxPopulateCell;
  formula(value: string): XlsxPopulateCell;
  style(name: string, value: unknown): XlsxPopulateCell;
}
interface XlsxPopulateColumn { width(value: number): XlsxPopulateColumn; }
interface XlsxPopulateRow { style(styles: Record<string, unknown>): XlsxPopulateRow; }
interface XlsxPopulateSheet {
  name(value: string): XlsxPopulateSheet;
  cell(address: string): XlsxPopulateCell;
  cell(row: number, column: number): XlsxPopulateCell;
  column(column: number): XlsxPopulateColumn;
  row(row: number): XlsxPopulateRow;
  freezePanes(xSplit: number, ySplit: number): XlsxPopulateSheet;
}
export interface OfficeWorkbook {
  sheet(index: number): XlsxPopulateSheet;
  sheet(name: string): XlsxPopulateSheet | undefined;
  addSheet(name: string): XlsxPopulateSheet;
  outputAsync(options: { type: "nodebuffer" }): Promise<Buffer | Uint8Array | ArrayBuffer>;
}
interface XlsxPopulateFactory {
  fromBlankAsync(): Promise<OfficeWorkbook>;
  fromDataAsync(data: Buffer): Promise<OfficeWorkbook>;
}
interface PptxSlide {
  background: { color: string };
  addText(text: unknown, options: Record<string, unknown>): void;
}
export interface OfficePresentation {
  layout: string;
  author: string;
  subject: string;
  title: string;
  addSlide(): PptxSlide;
  write(options: { outputType: "nodebuffer"; compression: boolean }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
  writeFile(options: { fileName: string; compression: boolean }): Promise<unknown>;
}

// Keep SDK imports static: the packaged daemon is bundled into an asar-local
// module, where runtime createRequire() cannot resolve workspace dependencies.
const PptxGenJS = PptxGenJSModule as unknown as new () => OfficePresentation;
const XlsxPopulate = XlsxPopulateModule as unknown as XlsxPopulateFactory;

export const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT = 100_000;
export const MAX_PREVIEW_HTML = 256 * 1024;
export const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx"]);
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const MAX_SLIDES = 200;
const MAX_PACKAGE_ENTRIES = 5_000;
const MAX_XML_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_EXPANDED_BYTES = 128 * 1024 * 1024;
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Build only the existing value/style workbook; never open or save a file. */
export async function createOfficeWorkbook(record: Record<string, unknown>): Promise<{ workbook: OfficeWorkbook; sheetCount: number }> {
  const sheets = readArray(record.sheets, "sheets", 1, 100);
  const workbook = await XlsxPopulate.fromBlankAsync();
  for (const [sheetIndex, rawSheet] of sheets.entries()) {
    const sheetInput = readRecord(rawSheet, "sheet");
    const sheetName = readSheetName(sheetInput.name);
    const sheet = sheetIndex === 0 ? workbook.sheet(0).name(sheetName) : workbook.addSheet(sheetName);
    const rows = readMatrix(sheetInput.rows, "sheet.rows");
    rows.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => sheet.cell(rowIndex + 1, columnIndex + 1).value(normalizeCellValue(value)));
    });
    applyColumnWidths(sheet, sheetInput.columnWidths);
    if (sheetInput.freezeHeader === true) sheet.freezePanes(0, 1);
    if (sheetInput.headerStyle !== false && rows.length > 0) {
      sheet.row(1).style({ bold: true, fontColor: "FFFFFF", fill: "217346" });
    }
  }
  return { workbook, sheetCount: sheets.length };
}

export function openOfficeWorkbook(bytes: Buffer): Promise<OfficeWorkbook> {
  return XlsxPopulate.fromDataAsync(bytes);
}

/** Apply the existing typed edit rules to an already loaded in-memory workbook. */
export function applyOfficeWorkbookEdits(workbook: OfficeWorkbook, edits: readonly unknown[]): void {
  for (const rawEdit of edits) {
    const edit = readRecord(rawEdit, "workbook edit");
    const sheet = workbook.sheet(readSheetName(edit.sheet));
    if (!sheet) throw new Error("office_worksheet_not_found");
    const cell = sheet.cell(readCellAddress(edit.cell));
    if (typeof edit.formula === "string") {
      cell.formula(readString(edit.formula, "formula", 8_192));
    } else if (Object.prototype.hasOwnProperty.call(edit, "value")) {
      cell.value(normalizeCellValue(edit.value));
    } else {
      throw new Error("office_edit_value_required");
    }
    if (edit.bold === true || edit.bold === false) cell.style("bold", edit.bold);
    if (typeof edit.numberFormat === "string") cell.style("numberFormat", readString(edit.numberFormat, "numberFormat", 128));
  }
}

export function createOfficeDocument(record: Record<string, unknown>): { document: Document; blockCount: number } {
  const blocks = readArray(record.blocks, "blocks", 1, 2_000);
  const children = blocks.map((rawBlock) => createDocxBlock(readRecord(rawBlock, "document block")));
  return { document: new Document({ sections: [{ children }] }), blockCount: blocks.length };
}

/** Construct only Ling's text-only template; no image/media paths or URLs. */
export function createOfficePresentation(record: Record<string, unknown>): { pptx: OfficePresentation; slideCount: number } {
  const slides = readArray(record.slides, "slides", 1, MAX_SLIDES);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Ling";
  pptx.subject = typeof record.subject === "string" ? readString(record.subject, "subject", 512) : "";
  pptx.title = typeof record.title === "string" ? readString(record.title, "title", 512) : "";
  for (const rawSlide of slides) {
    const slideInput = readRecord(rawSlide, "slide");
    const slide = pptx.addSlide();
    slide.background = { color: "F7F8FA" };
    const title = readString(slideInput.title, "slide.title", 512);
    slide.addText(title, { x: 0.7, y: 0.45, w: 11.9, h: 0.6, fontFace: "Arial", fontSize: 28, bold: true, color: "16181D", margin: 0 });
    const bullets = readStringArray(slideInput.bullets, "slide.bullets", 0, 30, 1_000);
    if (bullets.length > 0) {
      slide.addText(bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), {
        x: 0.9, y: 1.45, w: 11.3, h: 5.4, fontFace: "Arial", fontSize: 20, color: "30343B", breakLine: false, margin: 0.08,
      });
    }
  }
  return { pptx, slideCount: slides.length };
}

export interface TextReplacement {
  readonly search: string;
  readonly replace: string;
  readonly all: boolean;
  readonly slide?: number;
}
export interface OfficeDocumentEdits {
  readonly replacements: readonly TextReplacement[];
  readonly appendParagraphs: readonly string[];
}

export function readOfficeDocumentEdits(record: Record<string, unknown>): OfficeDocumentEdits {
  const replacements = readTextReplacements(record.replacements, false);
  const appendParagraphs = readStringArray(record.appendParagraphs, "appendParagraphs", 0, 200, 50_000);
  if (replacements.length === 0 && appendParagraphs.length === 0) throw new Error("office_document_edit_required");
  return { replacements, appendParagraphs };
}

export async function applyOfficeDocumentEdits(zip: JSZip, edits: OfficeDocumentEdits, signal?: AbortSignal): Promise<{ replacementCount: number; appendedParagraphCount: number }> {
  const document = parseXml(await readXmlMember(zip, "word/document.xml", signal));
  const replacementMatches = edits.replacements.map((replacement) =>
    replaceTextInNodes(Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "t")), replacement));
  if (replacementMatches.some((count) => count === 0)) throw new Error("office_edit_text_not_found");
  const body = document.getElementsByTagNameNS(WORD_NAMESPACE, "body").item(0);
  if (!body) throw new Error("office_document_package_invalid");
  const sectionProperties = Array.from(body.childNodes).find((node) =>
    node.nodeType === 1 && node.namespaceURI === WORD_NAMESPACE && node.localName === "sectPr");
  for (const text of edits.appendParagraphs) {
    const paragraph = document.createElementNS(WORD_NAMESPACE, "w:p");
    const run = document.createElementNS(WORD_NAMESPACE, "w:r");
    const textNode = document.createElementNS(WORD_NAMESPACE, "w:t");
    textNode.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    textNode.appendChild(document.createTextNode(text));
    run.appendChild(textNode);
    paragraph.appendChild(run);
    body.insertBefore(paragraph, sectionProperties ?? null);
  }
  zip.file("word/document.xml", new XMLSerializer().serializeToString(document));
  signal?.throwIfAborted();
  return { replacementCount: replacementMatches.reduce((sum, count) => sum + count, 0), appendedParagraphCount: edits.appendParagraphs.length };
}

export async function applyOfficePresentationEdits(zip: JSZip, replacements: readonly TextReplacement[], signal?: AbortSignal): Promise<{ replacementCount: number; changedSlides: number[] }> {
  const slideMembers = Object.keys(zip.files)
    .flatMap((name) => {
      const match = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(name);
      return match?.[1] ? [{ name, slide: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.slide - right.slide);
  const matches = new Array(replacements.length).fill(0);
  const changedSlides = new Set<number>();
  for (const member of slideMembers) {
    const relevant = replacements.flatMap((replacement, index) =>
      replacement.slide === undefined || replacement.slide === member.slide ? [{ replacement, index }] : []);
    if (relevant.length === 0) continue;
    const document = parseXml(await readXmlMember(zip, member.name, signal));
    const nodes = Array.from(document.getElementsByTagNameNS(DRAWING_NAMESPACE, "t"));
    for (const { replacement, index } of relevant) {
      const count = replaceTextInNodes(nodes, replacement);
      matches[index] += count;
      if (count > 0) changedSlides.add(member.slide);
    }
    if (changedSlides.has(member.slide)) zip.file(member.name, new XMLSerializer().serializeToString(document));
  }
  if (matches.some((count) => count === 0)) throw new Error("office_edit_text_not_found");
  signal?.throwIfAborted();
  return { replacementCount: matches.reduce((sum, count) => sum + count, 0), changedSlides: [...changedSlides].sort((left, right) => left - right) };
}

/** Parse bounded bytes only; callers own snapshot acquisition and path authority. */
export async function loadSafeOfficePackage(bytes: Buffer, format: OfficeArtifactFormat, signal?: AbortSignal): Promise<JSZip> {
  return readOfficePackage(bytes, format, true, signal);
}

async function readOfficePackage(bytes: Buffer, format: OfficeArtifactFormat, checkCRC32: boolean, signal?: AbortSignal): Promise<JSZip> {
  signal?.throwIfAborted();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error("office_document_too_large");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32, createFolders: false }); }
  catch { throw new Error("office_document_package_invalid"); }
  const entries = Object.values(zip.files);
  if (entries.length === 0 || entries.length > MAX_PACKAGE_ENTRIES) throw new Error("office_document_package_invalid");
  for (const entry of entries) {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (isUnsafeZipPath(originalName)) throw new Error("office_document_package_invalid");
    if (entry.dir) continue;
    const normalized = originalName.toLowerCase();
    if (normalized.endsWith("vbaproject.bin") || normalized.includes("/activex/") || normalized.includes("/embeddings/") || normalized.includes("oleobject")) {
      throw new Error("office_document_executable_unsupported");
    }
  }
  const requiredMember = format === "docx" ? "word/document.xml" : format === "pptx" ? "ppt/presentation.xml" : "xl/workbook.xml";
  if (!zip.file("[Content_Types].xml") || !zip.file(requiredMember)) throw new Error("office_document_package_invalid");
  signal?.throwIfAborted();
  return zip;
}

export function officeParserConfig(signal?: AbortSignal) {
  return {
    extractAttachments: false, includeRawContent: false, ocr: false, abortSignal: signal,
    decompressionLimits: { maxUncompressedBytes: 128 * 1024 * 1024, maxZipEntries: 5_000, maxTableCells: 250_000 },
  } as const;
}

/** Retain the existing parser validation without opening a source path again. */
export async function validateOfficeBytes(bytes: Buffer, format: OfficeArtifactFormat, signal?: AbortSignal): Promise<JSZip> {
  // CRC verification inflates every member in parallel. Bound actual expanded
  // bytes first, including parts the parser ignores, without trusting ZIP size
  // headers or SDK-private fields. This stricter preflight is preparation-only.
  assertOfficePackageRoster(bytes);
  const zip = await readOfficePackage(bytes, format, false, signal);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    await observeMemberBytes(entry, signal, (size) => {
      total += size;
      if (total > MAX_PACKAGE_EXPANDED_BYTES) throw new Error("office_document_too_large");
    });
  }
  await OfficeParser.parseOffice(bytes, { ...officeParserConfig(signal), fileType: format });
  signal?.throwIfAborted();
  return loadSafeOfficePackage(bytes, format, signal);
}

/** Stream public ZIP bytes without accumulating an unbounded member in memory. */
function observeMemberBytes(entry: JSZip.JSZipObject, signal: AbortSignal | undefined, observe: (size: number) => void): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    let ended = false;
    let memberBytes = 0;
    const finish = (failed: boolean, error?: unknown): void => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", onAbort);
      if (failed) {
        stream.pause();
        stream.destroy();
        reject(error);
      } else resolve();
    };
    const onAbort = (): void => finish(true, signal?.reason);
    stream.on("error", (error) => finish(true, error));
    stream.on("end", () => finish(false));
    stream.on("close", () => finish(true, new Error("office_document_package_invalid")));
    stream.on("data", (chunk: Buffer) => {
      if (ended) return;
      try {
        signal?.throwIfAborted();
        memberBytes += chunk.byteLength;
        if (entry.name.toLowerCase().endsWith(".xml") && memberBytes > MAX_XML_MEMBER_BYTES) throw new Error("office_document_xml_too_large");
        observe(chunk.byteLength);
      } catch (error) { finish(true, error); }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readXmlMember(zip: JSZip, name: string, signal?: AbortSignal): Promise<string> {
  const member = zip.file(name);
  if (!member) throw new Error("office_document_package_invalid");
  const bytes = await member.async("uint8array");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_XML_MEMBER_BYTES) throw new Error("office_document_xml_too_large");
  signal?.throwIfAborted();
  return Buffer.from(bytes).toString("utf8");
}

function isUnsafeZipPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\\")) return true;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return !normalized || normalized.split("/").some((segment) => segment === ".." || segment.length === 0);
}

function parseXml(source: string) {
  try {
    return new DOMParser({ onError(level) { if (level !== "warning") throw new Error("office_document_xml_invalid"); } })
      .parseFromString(source, "application/xml");
  } catch { throw new Error("office_document_xml_invalid"); }
}

export function readTextReplacements(value: unknown, withSlide: boolean): readonly TextReplacement[] {
  return readArray(value ?? [], "replacements", 0, 100).map((item, index) => {
    const record = readRecord(item, `replacements[${index}]`);
    const allowed = new Set(["search", "replace", "all", ...(withSlide ? ["slide"] : [])]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("office_edit_replacement_invalid");
    if (record.all !== undefined && typeof record.all !== "boolean") throw new Error("office_edit_replacement_invalid");
    const slide = record.slide === undefined ? undefined : readPositiveInteger(record.slide, "slide", MAX_SLIDES);
    return {
      search: readString(record.search, "search", 1_000), replace: readString(record.replace, "replace", 10_000, true),
      all: record.all === true, ...(slide ? { slide } : {}),
    };
  });
}

function replaceTextInNodes(nodes: readonly { textContent: string | null }[], replacement: TextReplacement): number {
  let count = 0;
  for (const node of nodes) {
    const source = node.textContent ?? "";
    if (!source.includes(replacement.search)) continue;
    if (replacement.all) {
      count += source.split(replacement.search).length - 1;
      node.textContent = source.split(replacement.search).join(replacement.replace);
    } else {
      node.textContent = source.replace(replacement.search, replacement.replace);
      count += 1;
      break;
    }
  }
  return count;
}

function createDocxBlock(block: Record<string, unknown>): Paragraph | Table {
  if (block.type === "paragraph") {
    const text = readString(block.text, "paragraph.text", 50_000, true);
    const heading = block.heading === 1 ? HeadingLevel.HEADING_1 : block.heading === 2 ? HeadingLevel.HEADING_2 : block.heading === 3 ? HeadingLevel.HEADING_3 : undefined;
    return new Paragraph({ ...(heading ? { heading } : {}), children: [new TextRun({ text, bold: block.bold === true })] });
  }
  if (block.type === "table") {
    return new Table({ rows: readMatrix(block.rows, "table.rows").map((row) => new TableRow({
      children: row.map((value) => new TableCell({ children: [new Paragraph(String(value ?? ""))] })),
    })) });
  }
  throw new Error("office_document_block_unsupported");
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function readString(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a string up to ${maxLength} characters.`);
  return value;
}
export function readArray(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} must contain ${min}-${max} items.`);
  return value;
}
function readPositiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${field} must be an integer between 1 and ${max}.`);
  return value as number;
}
function readStringArray(value: unknown, field: string, min: number, max: number, maxLength: number): readonly string[] {
  return readArray(value ?? [], field, min, max).map((item, index) => readString(item, `${field}[${index}]`, maxLength));
}
function readMatrix(value: unknown, field: string): readonly (readonly unknown[])[] {
  return readArray(value, field, 0, MAX_ROWS).map((row, index) => readArray(row, `${field}[${index}]`, 0, MAX_COLUMNS));
}
function readSheetName(value: unknown): string {
  const name = readString(value, "sheet name", 31);
  if (/[:\\/?*\[\]]/u.test(name)) throw new Error("office_worksheet_name_invalid");
  return name;
}
function readCellAddress(value: unknown): string {
  const address = readString(value, "cell", 32).toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(address)) throw new Error("office_cell_address_invalid");
  return address;
}
function normalizeCellValue(value: unknown): XlsxCellValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "object" && !Array.isArray(value) && typeof (value as { date?: unknown }).date === "string") {
    const date = new Date((value as { date: string }).date);
    if (!Number.isFinite(date.getTime())) throw new Error("office_cell_date_invalid");
    return date;
  }
  throw new Error("office_cell_value_unsupported");
}
function applyColumnWidths(sheet: XlsxPopulateSheet, value: unknown): void {
  if (value === undefined) return;
  readArray(value, "columnWidths", 0, MAX_COLUMNS).forEach((rawWidth, index) => {
    if (typeof rawWidth !== "number" || !Number.isFinite(rawWidth) || rawWidth < 4 || rawWidth > 80) throw new Error("office_column_width_invalid");
    sheet.column(index + 1).width(rawWidth);
  });
}
