import { extname } from "node:path";
import { Packer } from "docx";
import {
  MAX_OFFICE_FILE_BYTES,
  applyOfficeDocumentEdits,
  applyOfficePresentationEdits,
  applyOfficeWorkbookEdits,
  createOfficeDocument,
  createOfficePresentation,
  createOfficeWorkbook,
  openOfficeWorkbook,
  readArray,
  readOfficeDocumentEdits,
  readRecord,
  readString,
  readTextReplacements,
  validateOfficeBytes,
  type OfficeArtifactFormat,
} from "./office-artifact-content.js";

export type OfficeLocalArtifactToolName =
  | "office_create_workbook" | "office_edit_workbook"
  | "office_create_document" | "office_edit_document"
  | "office_create_presentation" | "office_edit_presentation";

/** Data only. The Host acquires and authorizes this snapshot separately. */
export interface OfficeArtifactByteSnapshot {
  readonly format: OfficeArtifactFormat;
  readonly bytes: Uint8Array;
}

export type OfficeArtifactResultDetails = { readonly format: OfficeArtifactFormat } & (
  | { readonly sheetCount: number }
  | { readonly editCount: number }
  | { readonly blockCount: number }
  | { readonly replacementCount: number; readonly appendedParagraphCount: number }
  | { readonly slideCount: number }
  | { readonly replacementCount: number; readonly changedSlides: readonly number[] }
);

/**
 * An owned in-memory payload, not a receipt or permission capability. No target
 * existence, canonical path, recovery file, publication or safe status is claimed.
 * A fixed Host writer must add actual path/recovery fields to resultDetails.
 */
export interface PreparedOfficeArtifact {
  readonly toolName: OfficeLocalArtifactToolName;
  readonly requestedPath: string;
  readonly format: OfficeArtifactFormat;
  readonly overwrite: boolean;
  readonly bytes: Buffer;
  readonly resultDetails: OfficeArtifactResultDetails;
}

const toolDefinitions = {
  office_create_workbook: { format: "xlsx", label: "Workbook create input", edit: false },
  office_edit_workbook: { format: "xlsx", label: "Workbook edit input", edit: true },
  office_create_document: { format: "docx", label: "Document create input", edit: false },
  office_edit_document: { format: "docx", label: "Document edit input", edit: true },
  office_create_presentation: { format: "pptx", label: "Presentation create input", edit: false },
  office_edit_presentation: { format: "pptx", label: "Presentation edit input", edit: true },
} as const;

/**
 * Prepare one of Ling's six local create/edit payloads without opening a path or
 * touching disk/network. Inputs and edit bytes are copied before the first await.
 * SDK/parser failures and cancellation propagate; they do not establish safety.
 */
export async function prepareOfficeArtifact(
  toolName: OfficeLocalArtifactToolName,
  input: unknown,
  snapshot?: OfficeArtifactByteSnapshot,
  signal?: AbortSignal,
): Promise<PreparedOfficeArtifact> {
  signal?.throwIfAborted();
  if (!Object.prototype.hasOwnProperty.call(toolDefinitions, toolName)) throw new Error("office_documents_tool_unavailable");
  const definition = toolDefinitions[toolName];
  // Tool inputs are data. Cloning prevents a caller changing nested rows/edits
  // while an SDK serializes; arbitrary SDK objects/callbacks are not accepted.
  const record = structuredClone(readRecord(input, definition.label));
  const requestedPath = readString(record.path, "path", 4096);
  if (extname(requestedPath).toLowerCase() !== `.${definition.format}`) throw new Error("office_document_format_unsupported");
  const originalBytes = definition.edit ? ownSnapshot(snapshot, definition.format) : undefined;
  const overwrite = definition.edit || record.overwrite === true;
  let output: unknown;
  let resultDetails: OfficeArtifactResultDetails;

  if (toolName === "office_create_workbook") {
    const { workbook, sheetCount } = await createOfficeWorkbook(record);
    signal?.throwIfAborted();
    output = await workbook.outputAsync({ type: "nodebuffer" });
    resultDetails = { format: "xlsx", sheetCount };
  } else if (toolName === "office_edit_workbook") {
    const edits = readArray(record.edits, "edits", 1, 2_000);
    await validateOfficeBytes(originalBytes!, "xlsx", signal);
    const workbook = await openOfficeWorkbook(originalBytes!);
    signal?.throwIfAborted();
    applyOfficeWorkbookEdits(workbook, edits);
    output = await workbook.outputAsync({ type: "nodebuffer" });
    resultDetails = { format: "xlsx", editCount: edits.length };
  } else if (toolName === "office_create_document") {
    const { document, blockCount } = createOfficeDocument(record);
    output = await Packer.toBuffer(document);
    resultDetails = { format: "docx", blockCount };
  } else if (toolName === "office_edit_document") {
    const zip = await validateOfficeBytes(originalBytes!, "docx", signal);
    const details = await applyOfficeDocumentEdits(zip, readOfficeDocumentEdits(record), signal);
    output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    resultDetails = { format: "docx", ...details };
  } else if (toolName === "office_create_presentation") {
    const { pptx, slideCount } = createOfficePresentation(record);
    // Public memory output only. The current library's nodebuffer branch uses
    // STORE even with compression:true, matching its old Node writeFile branch.
    output = await pptx.write({ outputType: "nodebuffer", compression: true });
    resultDetails = { format: "pptx", slideCount };
  } else {
    const replacements = readTextReplacements(record.replacements, true);
    if (replacements.length === 0) throw new Error("office_presentation_edit_required");
    const zip = await validateOfficeBytes(originalBytes!, "pptx", signal);
    const details = await applyOfficePresentationEdits(zip, replacements, signal);
    output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    resultDetails = { format: "pptx", ...details };
  }
  signal?.throwIfAborted();
  return { toolName, requestedPath, format: definition.format, overwrite, bytes: ownOutput(output), resultDetails };
}

function ownSnapshot(snapshot: OfficeArtifactByteSnapshot | undefined, format: OfficeArtifactFormat): Buffer {
  if (!snapshot || !(snapshot.bytes instanceof Uint8Array)) throw new Error("office_preparation_snapshot_required");
  if (snapshot.format !== format) throw new Error("office_document_format_unsupported");
  assertByteBudget(snapshot.bytes.byteLength);
  return Buffer.from(snapshot.bytes);
}

function ownOutput(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error("office_document_output_invalid");
  assertByteBudget(value.byteLength);
  return value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(new Uint8Array(value));
}

function assertByteBudget(size: number): void {
  if (size === 0 || size > MAX_OFFICE_FILE_BYTES) throw new Error("office_document_too_large");
}
