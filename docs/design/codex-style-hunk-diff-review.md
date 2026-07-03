# Codex-Style Hunk Diff Review

## Goal

Review and conversation surfaces should show what changed, not the whole file. A user should be able to scan edited files, additions and deletions, and the exact changed ranges without scrolling through unrelated source.

## User-Facing Behavior

- Conversation messages summarize edits as `Edited N files +A -D`.
- Expanding an edit still shows only diff hunks and nearby context.
- Large unchanged regions render as fold rows such as `442 unmodified lines`.
- The right review dock and conversation diff blocks use the same hunk-only visual language.
- The UI remains bilingual; Chinese and English labels must fit narrow dock widths.

## Data Model

The source of truth is unified diff text from run artifacts, approval payloads, or future live turn diff events. The web client parses it into:

- File change summary: path, kind, additions, deletions, status.
- Hunk rows: add, delete, context, and lightweight meta lines.
- Fold rows: hidden unchanged line count between hunks or before the first visible hunk.

The parser must preserve line numbers for old and new files so review notes and visual anchors can stay accurate.

## Rendering Rules

- Hide `diff --git`, `index`, `---`, and `+++` metadata in the primary body when a structured hunk can be parsed.
- Show line number, gutter sign, and code text for each visible row.
- Strip the raw `+`, `-`, and leading context space from displayed code because the gutter already communicates row kind.
- Render fold rows inline between hunks, not as a separate modal or full-file expansion.
- Keep existing large-diff deferral: summaries mount first, body mounts after explicit expansion.
- If parsing fails, fall back to the existing raw diff rendering.

## Implementation Slice

1. Add a hunk parser in `apps/web/src/lib/diff-summary.ts`.
2. Update `DiffViewer` to render hunk rows and fold rows.
3. Update right-dock code preview fold labels to use localized copy.
4. Add i18n keys for edited-file summaries and unmodified-line folds.
5. Cover the behavior with focused tests around hunk folds and conversation diff rendering.

## Future Slice

Add a daemon-side live turn diff summary, similar to Codex app-server `turn/diff/updated`, so running sessions can show `Editing N files +A -D` before the final artifact is written.
