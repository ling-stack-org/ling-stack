import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import type {
  DeckSpec,
  DeliverableKind,
  DeliverableSpec,
  DocSpec,
  WorkbookSpec,
} from "@ling-stack/contracts";

// pptxgenjs ships CJS-flavored typings that NodeNext resolves to the module
// namespace rather than the class, so the runtime default export is cast
// through a minimal structural interface.
import PptxGenJSModule from "pptxgenjs";

interface PptxSlide {
  addText(text: unknown, options: Record<string, unknown>): void;
  addNotes(notes: string): void;
}

interface PptxPresentation {
  title: string;
  addSlide(): PptxSlide;
  writeFile(options: { fileName: string }): Promise<string>;
}

const PptxGenJS = PptxGenJSModule as unknown as new () => PptxPresentation;

export interface BuiltDeliverable {
  readonly kind: DeliverableKind;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

const SAFE_FILENAME = /[^A-Za-z0-9._\-\u4e00-\u9fff]+/gu;

function safeFileName(title: string, extension: string): string {
  const base = title.replace(SAFE_FILENAME, "_").slice(0, 80) || "deliverable";
  return `${base}-${randomUUID().slice(0, 8)}.${extension}`;
}

/** V1 deck builder: title + bullets/two-column layouts via pptxgenjs. */
export async function buildDeckV1(spec: DeckSpec, outputDir: string): Promise<BuiltDeliverable> {
  const pptx = new PptxGenJS();
  pptx.title = spec.title;
  for (const slide of spec.slides) {
    const page = pptx.addSlide();
    if (slide.layout === "title") {
      page.addText(slide.title ?? spec.title, { x: 0.5, y: 2, w: "90%", fontSize: 32, bold: true });
      if (slide.body) page.addText(slide.body, { x: 0.5, y: 3.2, w: "90%", fontSize: 16 });
    } else if (slide.layout === "two_column") {
      page.addText(slide.title ?? "", { x: 0.5, y: 0.3, w: "90%", fontSize: 24, bold: true });
      const bullets = slide.bullets ?? [];
      const half = Math.ceil(bullets.length / 2);
      page.addText(bullets.slice(0, half).map((text) => ({ text, options: { bullet: true } })), {
        x: 0.5, y: 1.2, w: "45%", fontSize: 14,
      });
      page.addText(bullets.slice(half).map((text) => ({ text, options: { bullet: true } })), {
        x: 5.2, y: 1.2, w: "45%", fontSize: 14,
      });
    } else {
      // bullets and image share the simple title + list body.
      page.addText(slide.title ?? "", { x: 0.5, y: 0.3, w: "90%", fontSize: 24, bold: true });
      if (slide.bullets?.length) {
        page.addText(slide.bullets.map((text) => ({ text, options: { bullet: true } })), {
          x: 0.5, y: 1.2, w: "90%", fontSize: 14,
        });
      }
      if (slide.body) {
        page.addText(slide.body, { x: 0.5, y: 4.5, w: "90%", fontSize: 12 });
      }
    }
    if (slide.notes) page.addNotes(slide.notes);
  }
  const fileName = safeFileName(spec.title, "pptx");
  const absolutePath = join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  await pptx.writeFile({ fileName: absolutePath });
  return { kind: "deck", fileName, absolutePath, sizeBytes: 0 };
}

/** V1 doc builder: headings, paragraphs, bullets and tables via docx. */
export async function buildDocV1(spec: DocSpec, outputDir: string): Promise<BuiltDeliverable> {
  const children: (Paragraph | Table)[] = [];
  for (const block of spec.blocks) {
    if (block.type === "heading") {
      const level = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ text: block.text, heading: level }));
    } else if (block.type === "paragraph") {
      children.push(new Paragraph({ children: [new TextRun(block.text)] }));
    } else if (block.type === "bullets") {
      for (const item of block.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
      }
    } else {
      const headerRow = new TableRow({
        children: block.header.map((cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })] })),
      });
      const rows = block.rows.map((row) => new TableRow({
        children: row.map((cell) => new TableCell({ children: [new Paragraph({ text: cell })] })),
      }));
      children.push(new Table({ rows: [headerRow, ...rows] }));
    }
  }
  const document = new Document({
    creator: "Ling Stack",
    title: spec.title,
    sections: [{ children }],
  });
  const fileName = safeFileName(spec.title, "docx");
  const absolutePath = join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  const buffer = await Packer.toBuffer(document);
  await writeFile(absolutePath, buffer);
  return { kind: "doc", fileName, absolutePath, sizeBytes: buffer.length };
}

/** V1 workbook builder: named sheets with primitive cell values via exceljs. */
export async function buildWorkbookV1(spec: WorkbookSpec, outputDir: string): Promise<BuiltDeliverable> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ling Stack";
  for (const sheetSpec of spec.sheets) {
    const sheet = workbook.addWorksheet(sheetSpec.name.slice(0, 31));
    for (const row of sheetSpec.rows) {
      sheet.addRow([...row]);
    }
  }
  const fileName = safeFileName(spec.title, "xlsx");
  const absolutePath = join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  await workbook.xlsx.writeFile(absolutePath);
  return { kind: "workbook", fileName, absolutePath, sizeBytes: 0 };
}

export async function buildDeliverable(spec: DeliverableSpec, outputDir: string): Promise<BuiltDeliverable> {
  switch (spec.kind) {
    case "deck": return await buildDeckV1(spec, outputDir);
    case "doc": return await buildDocV1(spec, outputDir);
    case "workbook": return await buildWorkbookV1(spec, outputDir);
  }
}
