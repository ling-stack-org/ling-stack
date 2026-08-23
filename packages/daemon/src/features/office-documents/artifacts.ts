import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { OfficeParser } from "officeparser";

type XlsxCellValue = string | number | boolean | Date | null;

interface XlsxPopulateCell {
  value(value: XlsxCellValue): XlsxPopulateCell;
  formula(value: string): XlsxPopulateCell;
  style(name: string, value: unknown): XlsxPopulateCell;
}

interface XlsxPopulateColumn {
  width(value: number): XlsxPopulateColumn;
}

interface XlsxPopulateRow {
  style(styles: Record<string, unknown>): XlsxPopulateRow;
}

interface XlsxPopulateSheet {
  name(value: string): XlsxPopulateSheet;
  cell(address: string): XlsxPopulateCell;
  cell(row: number, column: number): XlsxPopulateCell;
  column(column: number): XlsxPopulateColumn;
  row(row: number): XlsxPopulateRow;
  freezePanes(xSplit: number, ySplit: number): XlsxPopulateSheet;
}

interface XlsxPopulateWorkbook {
  sheet(index: number): XlsxPopulateSheet;
  sheet(name: string): XlsxPopulateSheet | undefined;
  addSheet(name: string): XlsxPopulateSheet;
  outputAsync(options: { type: "nodebuffer" }): Promise<Buffer | Uint8Array | ArrayBuffer>;
}

interface XlsxPopulateFactory {
  fromBlankAsync(): Promise<XlsxPopulateWorkbook>;
  fromDataAsync(data: Buffer): Promise<XlsxPopulateWorkbook>;
}

interface PptxSlide {
  background: { color: string };
  addText(text: unknown, options: Record<string, unknown>): void;
}

interface PptxPresentation {
  layout: string;
  author: string;
  subject: string;
  title: string;
  addSlide(): PptxSlide;
  writeFile(options: { fileName: string; compression: boolean }): Promise<unknown>;
}

const PptxGenJS = createRequire(import.meta.url)("pptxgenjs") as new () => PptxPresentation;
const XlsxPopulate = createRequire(import.meta.url)("xlsx-populate") as XlsxPopulateFactory;

const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 100_000;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const MAX_SLIDES = 200;
const MAX_PACKAGE_ENTRIES = 5_000;
const MAX_XML_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_HTML = 256 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx"]);
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export class OfficeArtifactService {
  async prepareWorkbookSaveAs(workspaceCwd: string, input: unknown): Promise<Record<string, unknown>> {
    const record = readRecord(input, "Workbook save-as input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".xlsx");
    const overwrite = record.overwrite === true;
    await ensureWritableTarget(path, overwrite);
    return { ...record, path, overwrite };
  }

  async inspect(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Office inspect input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read");
    return inspectResolvedOfficePath(path, signal);
  }

  async validate(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Office validate input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read");
    return validateResolvedOfficePath(path, signal);
  }

  async createWorkbook(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Workbook create input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".xlsx");
    const overwrite = record.overwrite === true;
    const sheets = readArray(record.sheets, "sheets", 1, 100);
    const workbook = await XlsxPopulate.fromBlankAsync();
    for (const [sheetIndex, rawSheet] of sheets.entries()) {
      const sheetInput = readRecord(rawSheet, "sheet");
      const sheetName = readSheetName(sheetInput.name);
      const sheet = sheetIndex === 0 ? workbook.sheet(0).name(sheetName) : workbook.addSheet(sheetName);
      const rows = readMatrix(sheetInput.rows, "sheet.rows");
      rows.forEach((row, rowIndex) => {
        row.forEach((value, columnIndex) => {
          sheet.cell(rowIndex + 1, columnIndex + 1).value(normalizeCellValue(value));
        });
      });
      applyColumnWidths(sheet, sheetInput.columnWidths);
      if (sheetInput.freezeHeader === true) sheet.freezePanes(0, 1);
      if (sheetInput.headerStyle !== false && rows.length > 0) {
        sheet.row(1).style({ bold: true, fontColor: "FFFFFF", fill: "217346" });
      }
    }
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writeWorkbookAtomic(workbook, path, overwrite);
    return { path, format: "xlsx", sheetCount: sheets.length, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editWorkbook(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Workbook edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".xlsx");
    const edits = readArray(record.edits, "edits", 1, 2_000);
    await validateResolvedOfficePath(path);
    const workbook = await XlsxPopulate.fromDataAsync(await readFile(path));
    const recoveryPath = await backupExisting(workspaceCwd, path);
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
    await writeWorkbookAtomic(workbook, path, true);
    return { path, format: "xlsx", editCount: edits.length, recoveryPath };
  }

  async createDocument(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Document create input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".docx");
    const overwrite = record.overwrite === true;
    const blocks = readArray(record.blocks, "blocks", 1, 2_000);
    const children = blocks.map((rawBlock) => createDocxBlock(readRecord(rawBlock, "document block")));
    const document = new Document({ sections: [{ children }] });
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writeBytesAtomic(path, Buffer.from(await Packer.toBuffer(document)), overwrite);
    return { path, format: "docx", blockCount: blocks.length, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editDocument(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Document edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".docx");
    await validateResolvedOfficePath(path, signal);
    const replacements = readTextReplacements(record.replacements, false);
    const appendParagraphs = readStringArray(record.appendParagraphs, "appendParagraphs", 0, 200, 50_000);
    if (replacements.length === 0 && appendParagraphs.length === 0) throw new Error("office_document_edit_required");
    const zip = await loadSafeOoxmlPackage(path, signal);
    const source = await readXmlMember(zip, "word/document.xml", signal);
    const document = parseXml(source);
    const replacementMatches = replacements.map((replacement) =>
      replaceTextInNodes(Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "t")), replacement));
    if (replacementMatches.some((count) => count === 0)) throw new Error("office_edit_text_not_found");
    const replacementCount = replacementMatches.reduce((sum, count) => sum + count, 0);
    const body = document.getElementsByTagNameNS(WORD_NAMESPACE, "body").item(0);
    if (!body) throw new Error("office_document_package_invalid");
    const sectionProperties = Array.from(body.childNodes).find((node) =>
      node.nodeType === 1 && node.namespaceURI === WORD_NAMESPACE && node.localName === "sectPr");
    for (const text of appendParagraphs) {
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
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writePackageAtomic(zip, path, signal);
    return { path, format: "docx", replacementCount, appendedParagraphCount: appendParagraphs.length, recoveryPath };
  }

  async createPresentation(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Presentation create input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".pptx");
    const overwrite = record.overwrite === true;
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
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    const tempPath = `${path}.ling-${randomUUID()}.tmp.pptx`;
    await pptx.writeFile({ fileName: tempPath, compression: true });
    await publishTemp(tempPath, path, overwrite);
    return { path, format: "pptx", slideCount: slides.length, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editPresentation(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Presentation edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".pptx");
    const replacements = readTextReplacements(record.replacements, true);
    if (replacements.length === 0) throw new Error("office_presentation_edit_required");
    await validateResolvedOfficePath(path, signal);
    const zip = await loadSafeOoxmlPackage(path, signal);
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
      if (changedSlides.has(member.slide)) {
        zip.file(member.name, new XMLSerializer().serializeToString(document));
      }
    }
    if (matches.some((count) => count === 0)) throw new Error("office_edit_text_not_found");
    signal?.throwIfAborted();
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writePackageAtomic(zip, path, signal);
    return {
      path,
      format: "pptx",
      replacementCount: matches.reduce((sum, count) => sum + count, 0),
      changedSlides: [...changedSlides].sort((left, right) => left - right),
      recoveryPath,
    };
  }

  async renderDocument(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.validate(workspaceCwd, input, signal);
    const inspected = await this.inspect(workspaceCwd, input, signal) as Record<string, unknown>;
    const text = typeof inspected.text === "string" ? inspected.text : "";
    const format = inspected.format === "xlsx" || inspected.format === "docx" || inspected.format === "pptx"
      ? inspected.format
      : "unknown";
    const prefix = `<article class="ling-office-preview" data-format="${format}"><pre>`;
    const suffix = "</pre></article>";
    const available = MAX_PREVIEW_HTML - prefix.length - suffix.length;
    const rendered = escapeHtmlBounded(text, available);
    return {
      format,
      mimeType: "text/html",
      html: `${prefix}${rendered.html}${suffix}`,
      truncated: inspected.truncated === true || rendered.truncated,
    };
  }
}

async function inspectResolvedOfficePath(path: string, signal?: AbortSignal): Promise<unknown> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > MAX_OFFICE_FILE_BYTES) throw new Error("office_document_too_large");
  const ast = await OfficeParser.parseOffice(path, {
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
    abortSignal: signal,
    decompressionLimits: {
      maxUncompressedBytes: 128 * 1024 * 1024,
      maxZipEntries: 5_000,
      maxTableCells: 250_000,
    },
  });
  signal?.throwIfAborted();
  const extractedText = ast.toText();
  const text = extractedText.slice(0, MAX_EXTRACTED_TEXT);
  return {
    format: extensionKind(path),
    sizeBytes: fileStat.size,
    text,
    truncated: extractedText.length > text.length,
    metadata: sanitizeMetadata(ast.metadata),
    warnings: (ast.warnings ?? []).slice(0, 20).map((warning) => String(warning).slice(0, 512)),
  };
}

async function validateResolvedOfficePath(path: string, signal?: AbortSignal): Promise<unknown> {
  const inspected = await inspectResolvedOfficePath(path, signal) as Record<string, unknown>;
  await loadSafeOoxmlPackage(path, signal);
  return {
    valid: true,
    format: inspected.format,
    sizeBytes: inspected.sizeBytes,
    warnings: inspected.warnings,
  };
}

interface TextReplacement {
  readonly search: string;
  readonly replace: string;
  readonly all: boolean;
  readonly slide?: number;
}

async function loadSafeOoxmlPackage(path: string, signal?: AbortSignal): Promise<JSZip> {
  signal?.throwIfAborted();
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error("office_document_too_large");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    throw new Error("office_document_package_invalid");
  }
  const entries = Object.values(zip.files);
  if (entries.length === 0 || entries.length > MAX_PACKAGE_ENTRIES) throw new Error("office_document_package_invalid");
  for (const entry of entries) {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (isUnsafeZipPath(originalName)) throw new Error("office_document_package_invalid");
    if (entry.dir) continue;
    const normalized = originalName.toLowerCase();
    if (
      normalized.endsWith("vbaproject.bin")
      || normalized.includes("/activex/")
      || normalized.includes("/embeddings/")
      || normalized.includes("oleobject")
    ) {
      throw new Error("office_document_executable_unsupported");
    }
  }
  const requiredMember = extname(path).toLowerCase() === ".docx" ? "word/document.xml"
    : extname(path).toLowerCase() === ".pptx" ? "ppt/presentation.xml"
    : "xl/workbook.xml";
  if (!zip.file("[Content_Types].xml") || !zip.file(requiredMember)) throw new Error("office_document_package_invalid");
  signal?.throwIfAborted();
  return zip;
}

function isUnsafeZipPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\\")) return true;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return !normalized || normalized.split("/").some((segment) => segment === ".." || segment.length === 0);
}

async function readXmlMember(zip: JSZip, name: string, signal?: AbortSignal): Promise<string> {
  const member = zip.file(name);
  if (!member) throw new Error("office_document_package_invalid");
  const bytes = await member.async("uint8array");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_XML_MEMBER_BYTES) throw new Error("office_document_xml_too_large");
  signal?.throwIfAborted();
  return Buffer.from(bytes).toString("utf8");
}

function parseXml(source: string) {
  try {
    return new DOMParser({
      onError(level) {
        if (level !== "warning") throw new Error("office_document_xml_invalid");
      },
    }).parseFromString(source, "application/xml");
  } catch {
    throw new Error("office_document_xml_invalid");
  }
}

function readTextReplacements(value: unknown, withSlide: boolean): readonly TextReplacement[] {
  return readArray(value ?? [], "replacements", 0, 100).map((item, index) => {
    const record = readRecord(item, `replacements[${index}]`);
    const allowed = new Set(["search", "replace", "all", ...(withSlide ? ["slide"] : [])]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("office_edit_replacement_invalid");
    if (record.all !== undefined && typeof record.all !== "boolean") throw new Error("office_edit_replacement_invalid");
    const slide = record.slide === undefined ? undefined : readPositiveInteger(record.slide, "slide", MAX_SLIDES);
    return {
      search: readString(record.search, "search", 1_000),
      replace: readString(record.replace, "replace", 10_000, true),
      all: record.all === true,
      ...(slide ? { slide } : {}),
    };
  });
}

function replaceTextInNodes(nodes: readonly { textContent: string | null }[], replacement: TextReplacement): number {
  let count = 0;
  for (const node of nodes) {
    const source = node.textContent ?? "";
    if (!source.includes(replacement.search)) continue;
    if (replacement.all) {
      const matches = source.split(replacement.search).length - 1;
      node.textContent = source.split(replacement.search).join(replacement.replace);
      count += matches;
      continue;
    }
    node.textContent = source.replace(replacement.search, replacement.replace);
    count += 1;
    break;
  }
  return count;
}

async function writePackageAtomic(zip: JSZip, path: string, signal?: AbortSignal): Promise<void> {
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error("office_document_too_large");
  signal?.throwIfAborted();
  await writeBytesAtomic(path, bytes, true);
}

function escapeHtmlBounded(value: string, maxBytes: number): { readonly html: string; readonly truncated: boolean } {
  let html = "";
  let truncated = false;
  for (const character of value) {
    const escaped = character === "&" ? "&amp;"
      : character === "<" ? "&lt;"
      : character === ">" ? "&gt;"
      : character === '"' ? "&quot;"
      : character === "'" ? "&#39;"
      : character;
    if (Buffer.byteLength(html, "utf8") + Buffer.byteLength(escaped, "utf8") > maxBytes) {
      truncated = true;
      break;
    }
    html += escaped;
  }
  return { html, truncated };
}

function createDocxBlock(block: Record<string, unknown>): Paragraph | Table {
  if (block.type === "paragraph") {
    const text = readString(block.text, "paragraph.text", 50_000, true);
    const heading = block.heading === 1 ? HeadingLevel.HEADING_1
      : block.heading === 2 ? HeadingLevel.HEADING_2
      : block.heading === 3 ? HeadingLevel.HEADING_3
      : undefined;
    return new Paragraph({
      ...(heading ? { heading } : {}),
      children: [new TextRun({ text, bold: block.bold === true })],
    });
  }
  if (block.type === "table") {
    const rows = readMatrix(block.rows, "table.rows");
    return new Table({
      rows: rows.map((row) => new TableRow({
        children: row.map((value) => new TableCell({ children: [new Paragraph(String(value ?? ""))] })),
      })),
    });
  }
  throw new Error("office_document_block_unsupported");
}

async function resolveOfficePath(
  workspaceCwd: string,
  requestedPath: string,
  mode: "read" | "write",
  expectedExtension?: string,
): Promise<string> {
  const requestedWorkspaceRoot = resolve(workspaceCwd);
  const workspaceRoot = await realpath(requestedWorkspaceRoot);
  const requestedTarget = resolve(isAbsolute(requestedPath) ? requestedPath : resolve(requestedWorkspaceRoot, requestedPath));
  const relation = relative(requestedWorkspaceRoot, requestedTarget);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("office_path_outside_workspace");
  const extension = extname(requestedTarget).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension) || (expectedExtension && extension !== expectedExtension)) {
    throw new Error("office_document_format_unsupported");
  }
  if (mode === "read") {
    const canonical = await realpath(requestedTarget);
    const canonicalRelation = relative(workspaceRoot, canonical);
    if (canonicalRelation.startsWith("..") || isAbsolute(canonicalRelation)) throw new Error("office_path_outside_workspace");
    return canonical;
  }
  const requestedParent = dirname(requestedTarget);
  const existingAncestor = await findExistingAncestor(requestedParent);
  const canonicalAncestor = await realpath(existingAncestor);
  const ancestorRelation = relative(workspaceRoot, canonicalAncestor);
  if (ancestorRelation.startsWith("..") || isAbsolute(ancestorRelation)) throw new Error("office_path_outside_workspace");
  await mkdir(requestedParent, { recursive: true });
  const canonicalParent = await realpath(requestedParent);
  const parentRelation = relative(workspaceRoot, canonicalParent);
  if (parentRelation.startsWith("..") || isAbsolute(parentRelation)) throw new Error("office_path_outside_workspace");
  return resolve(canonicalParent, basename(requestedTarget));
}

async function findExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function ensureWritableTarget(path: string, overwrite: boolean): Promise<void> {
  try {
    const existing = await stat(path);
    if (!existing.isFile()) throw new Error("office_target_not_file");
    if (!overwrite) throw new Error("office_target_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function backupExisting(workspaceCwd: string, path: string): Promise<string | undefined> {
  try {
    const existing = await stat(path);
    if (!existing.isFile()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
  const recoveryDir = resolve(workspaceCwd, ".ling-stack", "recovery", "office");
  await mkdir(recoveryDir, { recursive: true });
  const recoveryPath = resolve(recoveryDir, `${digest}-${Date.now()}-${randomUUID()}${extname(path).toLowerCase()}`);
  await copyFile(path, recoveryPath, fsConstants.COPYFILE_EXCL);
  return recoveryPath;
}

async function writeWorkbookAtomic(workbook: XlsxPopulateWorkbook, path: string, overwrite: boolean): Promise<void> {
  const output = await workbook.outputAsync({ type: "nodebuffer" });
  const bytes = Buffer.isBuffer(output)
    ? output
    : output instanceof ArrayBuffer
      ? Buffer.from(output)
      : Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  await writeBytesAtomic(path, bytes, overwrite);
}

async function writeBytesAtomic(path: string, bytes: Buffer, overwrite: boolean): Promise<void> {
  const tempPath = `${path}.ling-${randomUUID()}.tmp${extname(path)}`;
  await writeFile(tempPath, bytes, { flag: "wx" });
  await publishTemp(tempPath, path, overwrite);
}

async function publishTemp(tempPath: string, path: string, overwrite: boolean): Promise<void> {
  try {
    if (!overwrite) {
      await link(tempPath, path);
      await unlink(tempPath);
      return;
    }
    await rename(tempPath, path);
  } catch (error) {
    if (!overwrite || process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    await unlink(path);
    await rename(tempPath, path);
  }
}

function extensionKind(path: string): "xlsx" | "docx" | "pptx" {
  return extname(path).slice(1).toLowerCase() as "xlsx" | "docx" | "pptx";
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be a string up to ${maxLength} characters.`);
  }
  return value;
}

function readArray(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} must contain ${min}-${max} items.`);
  return value;
}

function readPositiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${field} must be an integer between 1 and ${max}.`);
  }
  return value as number;
}

function readStringArray(value: unknown, field: string, min: number, max: number, maxLength: number): readonly string[] {
  return readArray(value ?? [], field, min, max).map((item, index) => readString(item, `${field}[${index}]`, maxLength));
}

function readMatrix(value: unknown, field: string): readonly (readonly unknown[])[] {
  const rows = readArray(value, field, 0, MAX_ROWS);
  return rows.map((row, index) => readArray(row, `${field}[${index}]`, 0, MAX_COLUMNS));
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
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "object" && !Array.isArray(value) && typeof (value as { date?: unknown }).date === "string") {
    const date = new Date((value as { date: string }).date);
    if (!Number.isFinite(date.getTime())) throw new Error("office_cell_date_invalid");
    return date;
  }
  throw new Error("office_cell_value_unsupported");
}

function applyColumnWidths(sheet: XlsxPopulateSheet, value: unknown): void {
  if (value === undefined) return;
  const widths = readArray(value, "columnWidths", 0, MAX_COLUMNS);
  widths.forEach((rawWidth, index) => {
    if (typeof rawWidth !== "number" || !Number.isFinite(rawWidth) || rawWidth < 4 || rawWidth > 80) {
      throw new Error("office_column_width_invalid");
    }
    sheet.column(index + 1).width(rawWidth);
  });
}

function sanitizeMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (typeof item === "string") output[key] = item.slice(0, 1_000);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) output[key] = item;
    else if (item instanceof Date) output[key] = item.toISOString();
  }
  return output;
}
