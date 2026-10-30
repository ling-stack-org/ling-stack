/**
 * Document deliverables contract (ux-gap-roadmap-01).
 *
 * Deliverables are real .pptx / .docx / .xlsx files produced by the daemon
 * from versioned JSON specs the agent emits through a bounded tool. Stored
 * specs keep `specVersion`; builders are versioned (`buildDeckV1`...) so old
 * artifacts are never re-rendered and nothing needs migrating.
 */

export type DeliverableKind = "deck" | "doc" | "workbook";

export const DELIVERABLE_SPEC_VERSION = 1 as const;

export interface DeckSlide {
  readonly layout: "title" | "bullets" | "image" | "two_column";
  readonly title?: string;
  readonly bullets?: readonly string[];
  readonly body?: string;
  readonly imageRef?: string;
  readonly notes?: string;
}

export interface DeckSpec {
  readonly specVersion: typeof DELIVERABLE_SPEC_VERSION;
  readonly kind: "deck";
  readonly title: string;
  readonly slides: readonly DeckSlide[];
}

export type DocBlock =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "bullets"; readonly items: readonly string[] }
  | { readonly type: "table"; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] };

export interface DocSpec {
  readonly specVersion: typeof DELIVERABLE_SPEC_VERSION;
  readonly kind: "doc";
  readonly title: string;
  readonly blocks: readonly DocBlock[];
}

export interface WorkbookSheet {
  readonly name: string;
  readonly rows: readonly (readonly (string | number | null)[])[];
}

export interface WorkbookSpec {
  readonly specVersion: typeof DELIVERABLE_SPEC_VERSION;
  readonly kind: "workbook";
  readonly title: string;
  readonly sheets: readonly WorkbookSheet[];
}

export type DeliverableSpec = DeckSpec | DocSpec | WorkbookSpec;

export interface DeliverableBuildResponse {
  readonly schemaVersion: 1;
  readonly kind: DeliverableKind;
  readonly fileName: string;
  /** Workspace-relative path of the built file. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Spreadsheet preview (ux-gap-roadmap-12)
// ---------------------------------------------------------------------------

export type SpreadsheetCell = { readonly v: string | number | boolean | null; readonly f?: string };

export interface SpreadsheetSheetMeta {
  readonly index: number;
  readonly name: string;
  readonly rowCount: number;
  readonly colCount: number;
}

export interface SpreadsheetWorkbook {
  readonly schemaVersion: 1;
  readonly sheets: readonly SpreadsheetSheetMeta[];
}

export interface SpreadsheetSheetWindow {
  readonly schemaVersion: 1;
  readonly sheetIndex: number;
  readonly sheetName: string;
  readonly rowStart: number;
  /** Exclusive. */
  readonly rowEnd: number;
  readonly colStart: number;
  /** Exclusive. */
  readonly colEnd: number;
  readonly rowCount: number;
  readonly colCount: number;
  readonly cells: readonly (readonly SpreadsheetCell[])[];
}

export function parseDeliverableSpec(raw: unknown): { ok: true; spec: DeliverableSpec } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "Deliverable spec must be an object." };
  }
  const input = raw as Record<string, unknown>;
  if (input.specVersion !== DELIVERABLE_SPEC_VERSION) {
    return { ok: false, reason: `Unsupported deliverable specVersion: ${String(input.specVersion)}` };
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return { ok: false, reason: "Deliverable title is required." };
  }
  switch (input.kind) {
    case "deck": {
      if (!Array.isArray(input.slides) || input.slides.length === 0) {
        return { ok: false, reason: "Deck spec needs at least one slide." };
      }
      if (input.slides.length > 200) {
        return { ok: false, reason: "Deck spec exceeds 200 slides." };
      }
      return { ok: true, spec: input as unknown as DeckSpec };
    }
    case "doc": {
      if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
        return { ok: false, reason: "Doc spec needs at least one block." };
      }
      if (input.blocks.length > 5000) {
        return { ok: false, reason: "Doc spec exceeds 5000 blocks." };
      }
      return { ok: true, spec: input as unknown as DocSpec };
    }
    case "workbook": {
      if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
        return { ok: false, reason: "Workbook spec needs at least one sheet." };
      }
      if (input.sheets.length > 100) {
        return { ok: false, reason: "Workbook spec exceeds 100 sheets." };
      }
      return { ok: true, spec: input as unknown as WorkbookSpec };
    }
    default:
      return { ok: false, reason: `Unknown deliverable kind: ${String(input.kind)}` };
  }
}

/** Clamp a window request into sheet bounds; used by the daemon and tests. */
export function clampSpreadsheetWindow(
  rowCount: number,
  colCount: number,
  requested: { rowStart?: number; rowEnd?: number; colStart?: number; colEnd?: number },
  maxRows = 200,
  maxCols = 60,
): { rowStart: number; rowEnd: number; colStart: number; colEnd: number } {
  const rowStart = Math.max(0, Math.min(requested.rowStart ?? 0, rowCount));
  const colStart = Math.max(0, Math.min(requested.colStart ?? 0, colCount));
  const rowEnd = Math.max(rowStart + 1, Math.min(requested.rowEnd ?? rowStart + maxRows, rowCount, rowStart + maxRows));
  const colEnd = Math.max(colStart + 1, Math.min(requested.colEnd ?? colStart + maxCols, colCount, colStart + maxCols));
  return { rowStart, rowEnd, colStart, colEnd };
}
