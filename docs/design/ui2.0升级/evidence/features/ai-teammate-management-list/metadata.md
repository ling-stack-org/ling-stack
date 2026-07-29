# P8.1 AI Teammate Management List Evidence

## Scope And Result

- Function ID: `TEAMMATE-LIST-001`
- Status: `verified` on 2026-07-20 for the currently reachable Web list/search surface.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, switch, commit, push,
  rebase or merge was performed.
- Served artifact: Playwright-owned real Vite dev server at `http://127.0.0.1:4174`, not a static source or
  code-only fixture.
- Browser: Playwright Chromium, locale `en-US`.

The slice covers initial loading, background refresh, retained rows on refresh failure, loaded rows, search by
identity/model/channel, ready/needs-model/hidden filters, empty, no-result/clear, long labels, one visible primary
status, open/configure actions and a Portal-backed Radix Menu with one-Esc close and focus restore.

## Screenshots

| File | Viewport / Theme Pack | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-loaded-search.png` | 1440x960 / `ling-light` | loaded list filtered by `Ling Architect` | `7df9f176cda69ff36ffb25500693d2fb68b2c178b3237499e96a6602f7cbb5b3` |
| `1440x960-ling-light-refresh-failure.png` | 1440x960 / `ling-light` | four authoritative rows retained under scoped refresh failure | `5562a5c6d698514c8fdbb06dbb60935f01d98d5e0a941ecdc2fc728e55d2ffd1` |
| `1280x800-ling-dark-hidden-filter.png` | 1280x800 / `ling-dark` | hidden filter with visible neutral primary status | `74bfcd4716a463bcfb2376bb47b2c17b3c9025f2f02e14ea5af205db0813e9c5` |
| `1280x800-ling-dark-empty.png` | 1280x800 / `ling-dark` | loaded empty workspace and real create entry | `34a5e35bb28d0ed5aaa7a7cae6d826bf12c2be548c982e5e48974c388f45de48` |

All files were verified at their original pixel dimensions and visually inspected after the final status/summary
layout change. Search focus stays inside the control, model/channel/time use a stable two-line summary, status and
actions do not overlap, and the list owns its internal vertical scroll.

## Verification

- `@ling-stack/ui-react`: `50/50` passed.
- focused `ui2-teammate-management-list.spec.ts`: `4/4` passed.
- selected `teammates.spec.ts + ui2-settings-workspace-tools.spec.ts + dark-mode.spec.ts`: `30/30` passed.
- Web typecheck, i18n audit, lint/import/overlay guards and `git diff --check`: passed.
- focused CSS scan: zero color literals, `!important`, Theme/Profile selectors, `transition: all` and
  package-private `.ling-ui-*` selectors.
- migrated legacy list selector hits outside the focused owner: zero.
- runtime console/page errors: zero in all focused cases.
- document horizontal/vertical overflow assertions passed at both viewports; 14-row Settings regression passed
  after the list scroll owner received layout/paint containment.

## Ownership Boundary

- `AiTeammatesPage.tsx`: `648 -> 484` lines.
- `teammates.css`: `4,735 -> 4,344` lines for this slice.
- new owners: `TeammateManagementList.tsx` 316, view-model 129, controller 51 and focused CSS 283 lines.
- `TeammateWorkspace.tsx` remains 2,489 lines and was not expanded.
- existing custom creation, avatar upload, provider check, progress, private-chat and settings-tab behavior is
  regression-only in this slice.

The adjacent `Default roles` / create surface was not claimed by this list evidence. It was subsequently closed by
P8.1b under `TEAMMATE-CREATE-001`; its final evidence is recorded in
[`ai-teammate-management-create/metadata.md`](../ai-teammate-management-create/metadata.md). All detail Tabs remain
independent later P8.1 slices.

Theme Studio D3 and `DESKTOP-THEME-PACK-PERSISTENCE-001` are unrelated open decisions/TODOs and were not changed.
