# Skill Import Productization Implementation Plan

## Related Docs

- [Skill Import Productization](skill-import-productization.md)
- [Ling Skill Import V1](ling-skill-import-v1.md)

## Summary

Implement the productized import flow as a one-action file importer backed by the existing
non-persisting daemon preview route. Preserve existing draft and publish routes for
internal callers and compatibility.

## Module Boundaries

1. Add a pure skill-import helper for filename normalization, request construction, and
   client form invalidation rules.
2. Keep `useSkillImportController` responsible for file reading, validate-then-publish,
   busy/error state,
   and short-lived success feedback.
3. Keep `SkillImportDialog` presentational and remove registry/optimization concepts.
4. Keep `SkillLibrarySettingsPanel` responsible only for composing the controller with
   the surrounding library refresh and active subsection.

## API And Data Flow

- Add `SkillImportPreview` and `SkillImportPreviewResponse` contracts.
- Add `LingDaemonClient.previewSkillImport()` and `POST /skills/import-preview`.
- The route reuses current parsing and context-finding helpers but creates no store
  records.
- Import calls preview first, keeps the response internal, and stops on blocking errors.
- For a valid file, the same action creates one durable draft, verifies it remains
  publishable, and calls the existing draft publish route.
- Existing `/skills/import-draft`, draft publish, and optimization preview routes remain
  unchanged for compatibility.

## UI Implementation

- Replace source/path/name/content fields with a hidden file input, Choose file action,
  and selected filename row.
- Accept `.md,.markdown,.json,.txt` and text/Markdown/JSON MIME types.
- Send only `file.name`; normalize it to a basename before request construction.
- Omit `source` so daemon inference remains the single source-of-truth.
- Replace separate Check and Publish actions with one Import action.
- Remove import optimization state and controls; retain optimization in the skill detail
  inspector.
- Do not render successful preview details or non-blocking warning counts.
- Show a compact productized problem list only when validation blocks import.
- Reset validation problems whenever the selected file changes.

## Test Plan

- Core/daemon tests cover SKILL.md, AGENTS.md, JSON, pasted Markdown, duplicate ids,
  warning gates, and the absence of draft/registry writes during preview.
- API client tests cover the new endpoint request and response.
- Web tests cover file selection, one-action import, hidden source content, no technical
  fields, valid publish, blocked import, Escape/close, and no draft persistence before
  import.
- Run core and daemon tests, Web typecheck, i18n audit, Settings/skill-library Playwright
  tests, and `git diff --check`.
- Browser-check Chinese light mode at 1440x960 and 1280x800 against the active Vite URL.

## Hard Stops

- Stop if implementation requires directory/ZIP upload or referenced-file execution.
- Stop if AGENTS.md import must mutate teammate persona state.
- Stop if a SQLite schema migration is required.
- Stop if imported content can change tools, approvals, secrets, providers, or bindings.

## Assumptions

- This slice supports one text file and no direct paste/editor path.
- Optimization stays available only after publication in skill details.
- Existing durable drafts remain valid for internal candidate and source workflows.

## Completion Evidence

Implemented on 2026-07-11.

- Added the non-persisting `POST /skills/import-preview` route and matching contracts,
  API client, and Web facade.
- Added `useSkillImportController` and pure import helpers; kept the dialog focused on
  file selection, editable content, checking, and publishing.
- Kept optimization in the skill inspector and preserved the existing durable draft and
  publish routes for compatible internal flows.
- `SkillLibrarySettingsPanel.tsx` is 695 lines after the extraction; the new dialog,
  controller, and helper files remain below the 800-line production-file boundary.
- Verification passed: Web typecheck, i18n audit, API client tests (38), Core tests (276),
  daemon preview API test, Settings/skill Playwright tests (23), and `git diff --check`.
- Real Vite source-mode browser QA passed at `http://127.0.0.1:5173/` in Chinese light
  mode at 1440x960 and 1280x800. The 1280x800 dialog measured 603px client and scroll
  height, so the page and dialog did not introduce an extra scrollbar.
- Real daemon QA confirmed `/skills/import-preview` returned HTTP 200 and Escape removed
  both the dialog and overlay. Screenshots are stored under
  `.ling-stack/audits/skill-import-productization-2026-07-11/`.
