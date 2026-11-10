import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import JSZip from "jszip";
import { Packer } from "docx";
import { OfficeParser } from "officeparser";
import {
  MAX_EXTRACTED_TEXT, MAX_OFFICE_FILE_BYTES, MAX_PREVIEW_HTML, SUPPORTED_EXTENSIONS,
  applyOfficeDocumentEdits, applyOfficePresentationEdits, applyOfficeWorkbookEdits,
  createOfficeDocument, createOfficePresentation, createOfficeWorkbook, loadSafeOfficePackage,
  officeParserConfig, openOfficeWorkbook, readArray, readOfficeDocumentEdits, readRecord, readString,
  readTextReplacements, type OfficeWorkbook,
} from "./office-artifact-content.js";

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
    const { workbook, sheetCount } = await createOfficeWorkbook(record);
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writeWorkbookAtomic(workbook, path, overwrite);
    return { path, format: "xlsx", sheetCount, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editWorkbook(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Workbook edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".xlsx");
    const edits = readArray(record.edits, "edits", 1, 2_000);
    await validateResolvedOfficePath(path);
    const workbook = await openOfficeWorkbook(await readFile(path));
    const recoveryPath = await backupExisting(workspaceCwd, path);
    applyOfficeWorkbookEdits(workbook, edits);
    await writeWorkbookAtomic(workbook, path, true);
    return { path, format: "xlsx", editCount: edits.length, recoveryPath };
  }

  async createDocument(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Document create input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".docx");
    const overwrite = record.overwrite === true;
    const { document, blockCount } = createOfficeDocument(record);
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writeBytesAtomic(path, Buffer.from(await Packer.toBuffer(document)), overwrite);
    return { path, format: "docx", blockCount, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editDocument(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Document edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".docx");
    await validateResolvedOfficePath(path, signal);
    const edits = readOfficeDocumentEdits(record);
    const zip = await loadSafeOoxmlPackage(path, signal);
    const details = await applyOfficeDocumentEdits(zip, edits, signal);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writePackageAtomic(zip, path, signal);
    return { path, format: "docx", ...details, recoveryPath };
  }

  async createPresentation(workspaceCwd: string, input: unknown): Promise<unknown> {
    const record = readRecord(input, "Presentation create input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "write", ".pptx");
    const overwrite = record.overwrite === true;
    const { pptx, slideCount } = createOfficePresentation(record);
    await ensureWritableTarget(path, overwrite);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    const tempPath = `${path}.ling-${randomUUID()}.tmp.pptx`;
    await pptx.writeFile({ fileName: tempPath, compression: true });
    await publishTemp(tempPath, path, overwrite);
    return { path, format: "pptx", slideCount, ...(recoveryPath ? { recoveryPath } : {}) };
  }

  async editPresentation(workspaceCwd: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = readRecord(input, "Presentation edit input");
    const path = await resolveOfficePath(workspaceCwd, readString(record.path, "path", 4096), "read", ".pptx");
    const replacements = readTextReplacements(record.replacements, true);
    if (replacements.length === 0) throw new Error("office_presentation_edit_required");
    await validateResolvedOfficePath(path, signal);
    const zip = await loadSafeOoxmlPackage(path, signal);
    const details = await applyOfficePresentationEdits(zip, replacements, signal);
    const recoveryPath = await backupExisting(workspaceCwd, path);
    await writePackageAtomic(zip, path, signal);
    return {
      path,
      format: "pptx",
      ...details,
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
  const ast = await OfficeParser.parseOffice(path, officeParserConfig(signal));
  signal?.throwIfAborted();
  const extractedText = (await ast.to("text")).value;
  signal?.throwIfAborted();
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

async function loadSafeOoxmlPackage(path: string, signal?: AbortSignal): Promise<JSZip> {
  signal?.throwIfAborted();
  return loadSafeOfficePackage(await readFile(path), extensionKind(path), signal);
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

async function writeWorkbookAtomic(workbook: OfficeWorkbook, path: string, overwrite: boolean): Promise<void> {
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
