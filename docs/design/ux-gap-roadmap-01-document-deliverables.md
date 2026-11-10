# Document Deliverables — PPT / Word / Excel Generation Loop

## Status

Status: design approved for implementation
Owner: Desktop / Web / Daemon
Last verified: 2026-10-26

## Background and competitive reference

MiniMax Code and WorkBuddy both win users on "give a task, receive a file":
presentations, cleaned spreadsheets, formatted reports. Ling today can operate
Excel/WPS through the desktop Office driver (Windows) and can preview docx/pdf
text in the desktop right dock, but it has no story for *producing* office
documents as deliverables, and no pptx/xlsx viewer at all.

## Goal

A user asks a teammate or channel to "make a deck / draft a report / build a
workbook", and receives a real `.pptx` / `.docx` / `.xlsx` artifact they can
open, preview in Ling, and hand off.

## Non-goals

- Pixel-perfect WYSIWYG editors inside Ling. Generation is agent-driven;
  editing stays in the native app.
- Cloud rendering. Everything is produced locally by the daemon.

## Design

### 1. Generation path: sandboxed node toolrunner, not the agent's shell

Add a daemon-side deliverable builder under
`packages/daemon/src/features/deliverables/`:

- Input: a normalized JSON spec (`DeckSpec`, `DocSpec`, `WorkbookSpec`) or a
  markdown outline the agent produced.
- Builders: `pptxgenjs` (pptx), `docx` (docx), `exceljs` (xlsx). All three are
  pure-JS, license-compatible, and already mainstream in Electron apps.
- Output: written to the workspace artifacts directory and registered through
  the existing artifact registry (`packages/daemon/src/features/automations/artifacts.ts`
  pattern), producing a `RunArtifact` with `type: "file"`,
  `contentType` `application/vnd.openxmlformats-*`.

The agent invokes this through one new harness tool
`deliverable_create` (bounded input schema, approval-gated like other tools),
rather than free-form npm/script execution. This reuses the approval and
authority model instead of creating a parallel one.

### 2. Spec schemas live in `packages/contracts/src/deliverables.ts`

```ts
export interface DeckSpec { title: string; slides: DeckSlide[]; }
export interface DeckSlide { layout: "title"|"bullets"|"image"|"two_column"; title?: string; bullets?: string[]; imageRef?: string; notes?: string; }
export interface WorkbookSpec { sheets: { name: string; rows: (string|number|null)[][]; formulas?: string[] }[]; }
export interface DocSpec { heading: string; blocks: DocBlock[]; } // paragraphs, headings, tables, lists
```

Versioned (`specVersion: 1`) so future renderers can be added without breaking
stored specs.

### 3. Preview: extend `PreviewContentKind`

`packages/contracts/src/artifacts.ts` gains `"pptx" | "docx" | "xlsx"` kinds.
Rendering strategy, desktop-first:

- pptx/docx: mammoth-style text+structure extraction already exists for docx
  (`apps/desktop/main/local-files/preview.ts` uses `mammoth`); add pptx text
  extraction (`pptx` unzip + slide XML parse — no new heavy dep, `fflate` is
  already a web devDependency and works server-side).
- xlsx: covered by the spreadsheet viewer design
  ([ux-gap-roadmap-12-spreadsheet-viewer.md](ux-gap-roadmap-12-spreadsheet-viewer.md)) —
  this item only wires the content kind.
- Web (no desktop): text-structure fallback preview, same as today's docx
  fallback, plus "open in system app" affordance on desktop.

### 4. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| `ArtifactType` union | additive | New `"file"` artifacts unchanged; only `contentType` distinguishes office docs. No union change needed. |
| `PreviewContentKind` union | additive | Add 3 kinds; all existing switch statements audited + exhaustive default kept (`unsupported`), so old renderers degrade safely. |
| Office driver (Windows Excel/WPS control) | orthogonal | Driver *operates* apps; deliverables *create files*. No shared code path; the driver can later open a generated file but that is not required for V1. |
| Skill library | integration | Ships as a built-in skill pack (`deliverables`) so the behavior is discoverable and evolvable without daemon changes. |
| Approvals | reuse | `deliverable_create` is a normal tool: `ask | smart | always` authorization applies unchanged. |

### 5. Incompatible-case upgrade path

If a future spec change breaks v1 (e.g. speaker notes become blocks), the
stored spec JSON keeps `specVersion`; builders ship versioned builders
(`buildDeckV1`), and the registry stores the *built file*, never the live spec.
Old artifacts therefore never re-render; nothing to migrate.

## Implementation plan

1. `packages/contracts`: `deliverables.ts` schemas + zod-style validation used by daemon.
2. `packages/daemon/src/features/deliverables/`: builders, route
   `POST /deliverables/build` (daemon-auth scoped), artifact registration.
3. Harness tool registration + approval wiring; slash intent `/deliverable`.
4. Preview kinds in daemon `previews` feature + desktop renderer + web fallback.
5. Built-in skill pack with 2 recipes (report→docx, outline→deck).
6. Tests: unit (builders produce valid zip/OOXML, round-trip open via parser),
   mock-daemon Playwright spec producing and previewing a deck, screenshot evidence.

## Acceptance

- Agent can create a 5-slide deck from a channel instruction; file appears in
  artifacts and previews with slide titles.
- Existing artifact/preview suites stay green; new Playwright spec captures
  before/after screenshots under `LING_CAPTURE_UI2_EVIDENCE=1`.
