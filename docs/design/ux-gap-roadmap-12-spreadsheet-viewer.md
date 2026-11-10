# Interactive Spreadsheet Viewer

## Status

Status: design approved for implementation
Owner: Web / Desktop / Daemon previews
Last verified: 2026-10-26

## Background and competitive reference

ZCode opens spreadsheets in a side panel with cell navigation and formula
disclosure; WorkBuddy's headline demo is cleaning an Excel file *and showing
the result*. Ling can *operate* Excel/WPS through the Windows Office driver
and can preview office files as text on desktop, but a human has no
spreadsheet view — for a product whose teammates produce tabular work, that
is the biggest single preview gap.

## Goal

Open `.xlsx`/`.csv` (and `.xls` read-only) in the right dock: sheet tabs,
frozen header row, cell selection, formula display for selected cell, virtual
scrolling for large sheets. Read-only in V1; editing stays with the agent
(ask a teammate to change it) and the Office driver.

## Design

### 1. Parsing: one library, daemon-side extraction

- Daemon `previews` feature gains spreadsheet extraction using
  `exceljs` (already the planned dependency for deliverable building —
  **one new dependency serving two features**, see
  [ux-gap-roadmap-01-document-deliverables.md](ux-gap-roadmap-01-document-deliverables.md)):
  parse workbook → per-sheet `{ name, rowCount, colCount, cells }` with
  values, formulas, number formats.
- Transport: for big sheets, an envelope contract
  `SpreadsheetWorkbook { sheets: SheetMeta[] }` +
  `SpreadsheetSheetWindow { sheetId, rowStart, rowMax, colStart, colMax, rows: Cell[][] }` —
  windowed reads (`GET /previews/spreadsheet/:refId/sheet/:index?window=...`)
  so a 500k-row file never crosses the wire whole. CSV parses in the same
  envelope (single sheet).
- Security: formulas are *displayed*, never evaluated — `exceljs` reads
  cached values; we show `value` plus `formula` string. Cell count caps per
  window; redaction pipeline (existing `redactionNotes`) applies to cell text.

### 2. UI: virtualized grid, existing design system

- `conversation-ui-react` (shared web+desktop): `SpreadsheetGrid` using the
  repo's existing virtualization (`@tanstack/react-virtual` is already a web
  dependency) — no new grid library.
- Features: sheet tabs, sticky header row + row-number column, cell selection
  with keyboard arrows, formula bar (selected cell's formula/value),
  number-format-aware rendering (dates, currency as text).
- Preview kind: `PreviewContentKind` gains `"spreadsheet"`; the ref's
  `contentType` routes .xlsx/.csv/.xls to it.

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| `PreviewContentKind` switches | additive | New kind; `unsupported` default preserved (same audit as items 01/02). |
| Office driver | orthogonal | Driver writes via the real Excel app; viewer reads file bytes. No conflict; both can be open — driver writes go through snapshots, viewer is read-only. |
| Desktop `local-files/preview.ts` | reuse | Desktop serves the bytes; the shared grid component renders. Docx/pdf text fallbacks unchanged. |
| Image compare / other previews | unchanged | Grid is a new renderer on the same `PreviewContentResponse` envelope. |

### 4. Incompatible-case upgrade path

Window contract is versioned (`spreadsheetWindowVersion`). If editing arrives
(V2), it is a new authority-gated feature writing through the daemon with
snapshots — the read path and its caches are untouched; read-only clients
simply never call write routes.

## Implementation plan

1. Contracts: workbook/sheet/window types + preview kind.
2. Daemon: exceljs extraction + windowed route + redaction + tests (fixture
   workbooks incl. formulas, dates, large sheet).
3. `conversation-ui-react`: `SpreadsheetGrid` + formula bar + keyboard nav.
4. Web right dock + desktop preview integration.
5. Tests: extraction unit tests, windowing math unit tests, Playwright spec
   with mocked daemon: open workbook fixture → switch sheets → select cell →
   formula bar, screenshot evidence.

## Acceptance

- Fixture workbook with 3 sheets + formulas: sheet tabs work, selecting a
  formula cell shows the formula (Playwright, screenshots).
- 200k-row synthetic sheet opens with virtualized windowing (unit-level
  windowing math + capped memory assertions).
- Existing preview suites stay green.
