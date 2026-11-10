import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n.js";
import type { SpreadsheetSheetWindow } from "../../../types.js";
import { daemonClient } from "../../../api/client.js";

/**
 * Interactive spreadsheet viewer (ux-gap-roadmap-12): sheet tabs, sticky
 * header, cell selection with a formula bar, and windowed reads so large
 * sheets never load whole. Formulas are displayed, never evaluated.
 */
export function SpreadsheetGrid({ cwd, path, sheets }: {
  readonly cwd: string;
  readonly path: string;
  readonly sheets?: readonly { readonly index: number; readonly name: string }[];
}): React.JSX.Element {
  const { t } = useI18n();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowStart, setRowStart] = useState(0);
  const [windowData, setWindowData] = useState<SpreadsheetSheetWindow | undefined>(undefined);
  const [selected, setSelected] = useState<{ row: number; col: number } | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setWindowData(undefined);
    setError("");
    void daemonClient._get<SpreadsheetSheetWindow>("/previews/spreadsheet", {
      cwd,
      path,
      sheet: sheetIndex,
      rowStart,
    })
      .then((body: SpreadsheetSheetWindow) => {
        if (cancelled) return;
        setWindowData(body);
        setSelected({ row: 0, col: 0 });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, path, sheetIndex, rowStart]);

  const loadNextPage = useCallback(() => {
    if (!windowData) return;
    setRowStart(Math.min(windowData.rowEnd, Math.max(0, windowData.rowCount - 1)));
  }, [windowData]);

  const selectedCell = useMemo(() => {
    if (!windowData || !selected) return undefined;
    const row = windowData.cells[selected.row - windowData.rowStart];
    return row?.[selected.col - windowData.colStart];
  }, [selected, windowData]);

  if (error) {
    return <div className="spreadsheet-grid spreadsheet-grid-error" role="alert">{error}</div>;
  }
  if (!windowData) {
    return <div className="spreadsheet-grid spreadsheet-grid-loading">{t("Loading spreadsheet...")}</div>;
  }

  const colLabel = (index: number): string => {
    let label = "";
    let n = index;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  };
  const cellText = (value: unknown): string => value === null || value === undefined ? "" : String(value);

  return (
    <div className="spreadsheet-grid" data-ui2-spreadsheet-grid="true" aria-label={t("Spreadsheet preview")}>
      {sheets && sheets.length > 1 ? (
        <div className="spreadsheet-grid-tabs" role="tablist" aria-label={t("Sheets")}>
          {sheets.map((sheet) => (
            <button
              key={sheet.index}
              type="button"
              role="tab"
              aria-selected={sheet.index === sheetIndex}
              className={sheet.index === sheetIndex ? "spreadsheet-grid-tab active" : "spreadsheet-grid-tab"}
              onClick={() => {
                setSheetIndex(sheet.index);
                setRowStart(0);
              }}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="spreadsheet-grid-toolbar">
        {windowData.rowCount > windowData.rowEnd ? (
          <button type="button" className="spreadsheet-grid-page-button" onClick={loadNextPage}>
            {t("Load more rows")} ({windowData.rowEnd}/{windowData.rowCount})
          </button>
        ) : (
          <span className="spreadsheet-grid-page-info">{windowData.rowCount} × {windowData.colCount}</span>
        )}
        {selected ? (
          <span className="spreadsheet-grid-formula" data-has-formula={selectedCell?.f ? "true" : undefined}>
            <code>{colLabel(selected.col)}{selected.row + 1}</code>
            <span>{selectedCell?.f ? `= ${selectedCell.f}` : cellText(selectedCell?.v) || "—"}</span>
          </span>
        ) : null}
      </div>
      <div className="spreadsheet-grid-scroll">
        <table className="spreadsheet-grid-table">
          <thead>
            <tr>
              <th className="spreadsheet-grid-corner" aria-label={t("Row")} />
              {Array.from({ length: windowData.colEnd - windowData.colStart }, (_, col) => (
                <th key={col} scope="col">{colLabel(windowData.colStart + col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {windowData.cells.map((row, rowIndex) => {
              const absoluteRow = windowData.rowStart + rowIndex;
              return (
                <tr key={absoluteRow}>
                  <th className="spreadsheet-grid-row-number" scope="row">{absoluteRow + 1}</th>
                  {row.map((cell, colIndex) => {
                    const absoluteCol = windowData.colStart + colIndex;
                    const isSelected = selected?.row === absoluteRow && selected?.col === absoluteCol;
                    return (
                      <td
                        key={absoluteCol}
                        className={isSelected ? "spreadsheet-grid-cell selected" : "spreadsheet-grid-cell"}
                        data-has-formula={cell.f ? "true" : undefined}
                        onClick={() => setSelected({ row: absoluteRow, col: absoluteCol })}
                      >
                        {cellText(cell.v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="spreadsheet-grid-note">{t("Formulas are shown for reference and never evaluated.")}</p>
    </div>
  );
}
