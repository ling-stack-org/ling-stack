# P8.2a Council List / Health A Evidence

## Scope

- Captured: 2026-07-22, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: shared and dirty before this slice; no reset, clean, stash, checkout, commit, push, rebase or merge.
- Surface: real Vite source application at `http://127.0.0.1:4174` with Playwright daemon fixtures.
- Function ID: `COUNCIL-LIST-001` under the user-selected Council A boundary.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

Council List / Health reports only Council configuration and the existing member-readiness health report. It never
claims current execution, recent run source, aggregate runtime or other provenance the current API cannot prove.
`COUNCIL-RUNTIME-001` remains inventory/provenance-blocked. Create/Clone authority and Members were subsequently
closed by their focused slices; Channels, full Settings
and Archive remain separately owned and were regression-tested rather than claimed by this slice.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-healthy-attention.png` | 1440x960 / `ling-light`, en-US | healthy, critical attention, paused, selected finding Inspector | `9866aa861ad8049be8caef8bcb19e6b8392a415ce19e1c47cf4de79ee9e1b387` |
| `1440x960-ling-dark-partial-health.png` | 1440x960 / `ling-dark`, en-US | truncated report projects partial, never false healthy | `107835b217dbd93d3b31df73f355bca87689c925e0b759e7c81cd7eb13d047e7` |
| `1280x800-ling-light-long-zh-cn.png` | 1280x800 / `ling-light`, zh-CN | 64 Councils, long identities, internal list scroll | `5fa01d3d41236fca048877ce85456e38a1e59f05548d7cae3ea4fcb0176f1218` |
| `1280x800-ling-dark-refresh-stale.png` | 1280x800 / `ling-dark`, en-US | retained rows, compact persistent error, readable Retry and stale marker | `3497a1c175e61045bbcdd8c288da596bdf24d54d7b1bfcc4fcbb123b01124515` |
| `1280x800-ling-dark-no-result.png` | 1280x800 / `ling-dark`, en-US, reduced motion | no-result distinct from empty, readable Clear filters action | `dc2b5e6c7d2bf72e5cb93e6e399f8e0947ef916000842e1df63477e939c7db48` |

All five RGB PNGs match their encoded dimensions and were inspected at original resolution. Screenshot review found
and fixed two defects not caught by the first assertions: optional feedback had consumed the list's flexible row, and
the no-result action had collapsed in the narrow column. Focused bounds now require compact feedback, retained list
height, readable Retry and readable Clear filters.

## Reachable State Evidence

- every row has exactly one primary state: paused, partial, attention, pending or healthy;
- missing, invalid, stale, workspace-mismatched or truncated reports cannot project healthy;
- `critical / warning / info` remain compatibility finding filters without creating a second row state;
- Search/Filter preserve explicit selection; temporarily filtered selection returns when filters clear;
- Refresh is single-flight, retains authoritative rows on failure and clears stale feedback after a changed snapshot;
- loading Skeleton, loaded empty, local no-result, protected built-in and long Chinese list are independently reachable;
- listbox/option keyboard semantics support Enter/Space and stable `.council-list-row` compatibility without restoring
  the legacy button or legacy CSS owner;
- Settings embedded mode and full workspace reuse the same List/Health owner.

## Verification

- Focused `ui2-council-list-health.spec.ts`: `6/6`, including final evidence capture.
- Council legacy behavior: `councils.spec.ts` `2/2`; Create/Clone focused `7/7`.
- Activity + Teammates + Council List/Create + Settings workspace-tools + Dark selected regression: `51/51`.
- Web `typecheck`, `check:i18n`, UI 2.0 `lint` and final whitespace checks: passed.
- Focused CSS scan: zero hard-coded colors, `!important`, private keyframes, `transition: all`, package-private
  `.ling-ui-*` selectors or direct Radix imports.

## Structure And Residual Risk

- Focused owners: 250-line pure view-model, 150-line controller, 191-line List, 41-line Health summary, 386-line CSS
  and 378-line E2E. `councils.css` fell to 433 lines; no duplicate List/Health style owner remains.
- `CouncilWorkspacePage.tsx` is 538 lines and `CouncilWorkspacePanels.tsx` is 520 lines, both below the 800-line guard.
- No API, contract, Core, daemon production code, database or migration changed. Runtime provenance remains a separate
  explicit blocker.
