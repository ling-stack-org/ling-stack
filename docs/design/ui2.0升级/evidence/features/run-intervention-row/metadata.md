# Run Intervention Row Productization UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this slice; unrelated Desktop, Computer Use and UI 2.0 changes were preserved.
- Source: the real Vite application through Playwright Chromium and the existing daemon fixtures, not static markup.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.26 Runs Intervention Row productization` is Web `verified`. It does not change Function ID status or close packaged macOS/Windows evidence.

## Product Boundary

- `RunInterventionRow` is a pure presentation component with actionable and read-only modes.
- Run Guidance keeps Cancel/Start handling callbacks, scoped busy keys and row-owned errors.
- Thread Evidence reuses the information structure but receives no mutation callback or action.
- A dedicated view-model maps the six authoritative intervention statuses to neutral/info/warning/success/danger tones.
- Short guidance remains visible. Guidance over 260 characters is three lines by default, expands by keyboard, and uses a bounded 240px internal scroll area.
- Details expose requested actor, created/updated time, continuation ID and failure reason without making raw identifiers part of the default row.
- No daemon/API/contract/database/state-machine, global DataRow, global Input/Textarea or Desktop behavior changed.

## Focus Containment Decision

The input focus issue reported from recent screenshots is not a shared `@ling-stack/ui-react` Input defect. Shared
Input/Select/Textarea containment remains covered by `ui2-form-controls.spec.ts` (`4/4` in the selected run). O.26
does not add a global `input:focus` override. Remaining legacy raw controls stay in the T12.1b/U13 migration lanes.

## Verification

| Gate | Result |
|---|---|
| New focused spec, ordinary | `3/3` passed |
| New focused spec, formal capture | `3/3` passed |
| Runs/Runtime/Form selected | `36/36` passed |
| App/Automations/Approvals/Dark/Theme broad | `48/48` passed |
| Web i18n audit | passed |
| Web UI boundary/overlay lint | passed |
| Web typecheck | passed |
| Web production build | passed; existing large-chunk warning only |
| `git diff --check` | passed |

The focused spec verifies visible status labels, direct queued actions, no actions in Thread read-only mode, keyboard
disclosure, reduced motion, long-text internal scrolling, failure retention, retry to an authoritative continuation,
32px action hit areas, semantic Theme Pack tokens, console/page errors, row overflow and document overflow.

## CSS And Module Ownership

- `RunGuidancePanel.tsx`: 63 lines and composition-only.
- `RunInterventionRow.tsx`: 113 lines and presentation-only.
- `ThreadEvidenceSection.tsx`: 43 lines; technical intervention enums no longer render through a generic DataRow.
- `run-intervention-view-models.ts`: 15 lines and pure status-tone ownership.
- `runs/intervention-row.css`: 126 lines, no color literal, `!important`, Theme/Profile selector, `transition: all`, private package selector or keyframe.
- `run-detail.css` releases the old grouped `.runs-intervention-row` writer; `runs.css` adds one explicit focused import.
- Web CSS moves from the O.25 baseline `158 files / 34,998 lines` to `159 files / 35,124 lines`. The +126 lines are an explicit productization owner, not aggregate cleanup. `components.css=3,743`, `strict-console.css=439` and `layout.css=907` do not grow.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-queued-direct-actions.png` | 1440x960 / Ling Light | Short queued guidance, visible state and direct Cancel/Start handling | `0b434ad84fb0ea26752c1c1e5cb0521f884205228ed46b2e93d2327c6a0a37da` |
| `1280x800-ling-dark-long-expanded-failure.png` | 1280x800 / Ling Dark / reduced motion | Long expanded guidance, bounded internal scroll and scoped promote failure | `d7e6914a1c903e3d1acfc4f8413675aae49f8daa76812a3ec5b8568c930260f4` |
| `1440x960-quiet-ocean-thread-read-only-states.png` | 1440x960 / Quiet Ocean | Thread read-only Started/Failed rows and expanded continuation metadata | `4c9054c4998f60f8b7c5deeb69659d35c5966afd3f7ccc415db4422a856bdee5` |

All PNGs are direct viewport captures and were not resized or recompressed. Each was inspected at original size after
the final passing capture. Target rows are visible, status text is not color-only, controls do not overlap, long text
is bounded, internal and document horizontal overflow are absent, and the imported theme keeps semantic surfaces.

## Honest Remaining Gaps

- O.26 does not claim all legacy raw inputs are migrated. T12.1b/U13 remains the owner for those page-level controls.
- Thread intervention aggregation still uses its existing request/loading semantics; O.26 only changes its presentation.
- The outer Run Guidance Inspector and inner heading remain a separate information-density cleanup candidate because existing business E2E addresses the inner heading directly.
- Message Action Bar and the full Message/Transcript package ownership release remain larger candidates for the next audited slice.
- No packaged Electron macOS Retina or Windows 125%/150% capture was produced.
- Large existing files such as `runtime.spec.ts`, `app.spec.ts`, `WorkspaceClientView.tsx` and `TeammateWorkspace.tsx` remain architecture debt; O.26 did not add behavior to them.
