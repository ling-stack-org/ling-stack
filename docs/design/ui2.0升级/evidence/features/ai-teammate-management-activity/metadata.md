# P8.1k AI Teammate Recent Activity Evidence

> Historical evidence: the Activity Settings tab documented here was removed by product decision on 2026-07-30.
> The private-chat Dock activity projection remains supported.

## Scope

- Captured: 2026-07-22, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, checkout, commit, push,
  rebase or merge was run.
- Surface: real Vite source application at `http://127.0.0.1:4174` with Playwright daemon fixtures.
- Function ID: `TEAMMATE-ACTIVITY-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

Settings owns one bounded `Recent activity` projection for the selected teammate. The verified private-chat Dock
Activity remains a separate private-context projection. Neither surface claims to be an immutable audit archive.
The Settings list requests the existing 100-item API boundary and exposes private messages, assigned tasks, teammate
Runs, approvals for those Runs and explicit channel mentions. Only Run rows navigate, through the existing Runs owner.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-all-kinds.png` | 1440x960 / `ling-light`, en-US | all five source kinds, one state per row and Run-only action | `38f5a7e7b39003793f37cdf72082244fef176019bfa3d7731b02689bbdfd25e6` |
| `1280x800-ling-dark-all-kinds-zh-CN.png` | 1280x800 / `ling-dark`, zh-CN, reduced motion | localized product hints and compact dark layout | `f217ca317ada4ce3632055ce0821866645b58b59617eb3dd52fecf64569e0549` |
| `1440x960-ling-dark-retained-error.png` | 1440x960 / `ling-dark`, en-US | failed refresh retains two authoritative rows and local Retry | `c64692c65c31a593388839c462c0867b43516d4f56eebf655f8c8d105436b5fc` |
| `1280x800-ling-light-filter-no-result.png` | 1280x800 / `ling-light`, en-US | search no-result and explicit Clear filters | `f320013cca11ac8f15e70bd1bfc84b3514246a38658e7317aac995aba377335d` |
| `1440x960-ling-light-protected-100-row-scroll.png` | 1440x960 / `ling-light`, en-US | protected Ling Agent, exact 100-row boundary and internal scroll | `ff87013433289d588f07b31ac7e9cd0692d17f9c449dbc3fef9f8b13930adfec` |

All five RGB PNGs match the viewport encoded in their filenames and were inspected at original resolution. The
toolbar, row status/action, right configuration summary and Settings navigation remain separate layout owners. Long
identities truncate inside the list, and no screenshot has document-level horizontal or vertical overflow.

## Reachable State Evidence

- initial loading uses stable Skeleton rows; authoritative empty and local no-result remain distinct;
- query and all five source filters are local, reset on teammate identity change and never mutate source records;
- failed refresh retains rows, exposes persistent local feedback and scopes loading to Refresh;
- delayed responses cannot cross a teammate switch because identity and request sequence are both guarded;
- the exact 100-row recent boundary owns internal scrolling and is not described as a total, archive or pagination;
- raw source ids are absent from the default layer; known server hints become product labels in English and Chinese;
- only Run rows expose `Open run`; Tasks remain owned by Work Board and no copied diagnostics are rendered;
- every focused scenario asserts browser errors and document overflow; reduced motion adds no feature animation.

## Verification

- Focused `ui2-teammate-management-activity.spec.ts`: `6/6`, including final evidence capture.
- Activity + Teammates + Council List/Create + Settings workspace-tools + Dark selected regression: `51/51`.
- Web `typecheck`, `check:i18n`, UI 2.0 `lint` and final whitespace checks: passed.
- Focused CSS scan: zero hard-coded colors, `!important`, private keyframes, `transition: all`, package-private
  `.ling-ui-*` selectors or direct Radix imports.

## Structure And Residual Risk

- Focused owners: 111-line pure view-model, 111-line controller, 195-line Tab, 192-line CSS and 329-line E2E.
- `TeammateWorkspace.tsx` remains above 2,000 lines and `AppShell.tsx` remains above 3,000 lines. This slice adds only
  composition/adaptation there; future Memory, Channels, MCP and Danger work must continue extracting focused owners.
- No daemon API, contract, database, retention, task state machine or private Dock behavior changed.
