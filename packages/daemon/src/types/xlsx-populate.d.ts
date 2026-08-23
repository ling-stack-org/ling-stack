declare module "xlsx-populate" {
  interface Cell {
    value(value: string | number | boolean | Date | null): Cell;
    formula(value: string): Cell;
    style(name: string, value: unknown): Cell;
  }

  interface Column {
    width(value: number): Column;
  }

  interface Row {
    style(styles: Record<string, unknown>): Row;
  }

  interface Sheet {
    name(value: string): Sheet;
    cell(address: string): Cell;
    cell(row: number, column: number): Cell;
    column(column: number): Column;
    row(row: number): Row;
    freezePanes(xSplit: number, ySplit: number): Sheet;
  }

  interface Workbook {
    sheet(index: number): Sheet;
    sheet(name: string): Sheet | undefined;
    addSheet(name: string): Sheet;
    outputAsync(options: { type: "nodebuffer" }): Promise<Buffer | Uint8Array | ArrayBuffer>;
  }

  interface XlsxPopulate {
    fromBlankAsync(): Promise<Workbook>;
    fromDataAsync(data: Buffer): Promise<Workbook>;
  }

  const XlsxPopulate: XlsxPopulate;
  export = XlsxPopulate;
}
