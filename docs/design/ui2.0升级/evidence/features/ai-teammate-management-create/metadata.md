# P8.1b AI Teammate Management Create Evidence

## Scope And Result

- Function ID: `TEAMMATE-CREATE-001`
- Status: `verified` on 2026-07-20 for Default roles, template/custom creation and the real setup progress flow.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, switch, commit, push,
  rebase or merge was performed.
- Served artifact: Playwright-owned real Vite dev server at `http://127.0.0.1:4174`, not a static source or
  code-only fixture.
- Browser: Playwright Chromium, locale `en-US`.

The slice covers the compact Default roles catalog, role details, template selection, custom setup, avatar
selection/removal, ready-model selection, no-model repair, seven real setup steps, model failure, post-create
partial failure, successful creation, Dialog dismissal/focus rules, long content and both Settings/sidebar entry
paths. It preserves the existing daemon/domain creation authority.

## Screenshots

| File | Viewport / Theme Pack | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-default-roles.png` | 1440x960 / `ling-light` | compact role catalog and non-truncated create action | `f4617412607dac6744c97b30b995b172825d39c1713566b73e4c69710adfc877` |
| `1280x800-ling-dark-role-select.png` | 1280x800 / `ling-dark` + reduced motion | shared role-selection Dialog and fixed Footer | `b12211c88d618445561f47200ecd35a64cb3c6f39e7465dc59fc30ad20abf520` |
| `1440x960-ling-dark-custom-setup.png` | 1440x960 / `ling-dark` | custom identity, uploaded avatar, model, description and channel | `deaa5d99b3ee61ad60807f38c49f6a44afba615d4f141983ef5b7f8131e8d268` |
| `1280x800-ling-dark-model-failure.png` | 1280x800 / `ling-dark` | model blocker, seven-step truth and repair actions | `af71689c2aba90677dfcc19fa4e3b18c750e8bc357473a1df9b7279bbc951228` |
| `1440x960-ling-light-partial-warning.png` | 1440x960 / `ling-light` | record created, avatar failed, warning result and one Open chat action | `b6d801bc87a19646ae85c252a2c771a1a4bb7105b42b4d307571b05442778ed2` |

All files were verified at their original pixel dimensions and visually inspected after the final partial-result
fix. Header, single scrolling body and Footer remain separate; fields, role rows and actions do not overflow;
Dark selected/failure states retain readable contrast; the partial result cannot return to setup and create a
duplicate teammate.

## Verification

- `@ling-stack/ui-react`: `50/50` passed.
- focused `ui2-teammate-management-create.spec.ts`: `5/5` passed, including post-record partial failure.
- selected `teammates.spec.ts + ui2-settings-workspace-tools.spec.ts + dark-mode.spec.ts` plus focused owner:
  `35/35` passed.
- Web typecheck, i18n audit, lint/import/overlay guards and `git diff --check`: passed.
- focused CSS scan: zero color literals, `!important`, Theme/Profile selectors, `transition: all` and
  package-private `.ling-ui-*` selectors.
- migrated role/create selector hits in `teammates.css`, `strict-console.css` and `components.css`: zero.
- runtime console/page errors and document horizontal/vertical overflow: zero in all focused cases.

## Ownership Boundary

- `AiTeammatesPage.tsx`: `484 -> 421` lines in P8.1b (`648 -> 421` across P8.1a/b).
- `TeammateCreateDrawer.tsx`: `594 -> 368` lines and remains orchestration/state only.
- extracted owners: role catalog `75`, role step `105`, custom setup `154`, progress `110`, shared create
  fields `64` and role icons `23` lines.
- `teammates.css`: `4,344 -> 2,864`; focused owners are role catalog `153`, create `325` and progress `135`
  lines.
- the 2,489-line `TeammateWorkspace.tsx` received no creation behavior.

The next independent P8.1 slice is teammate Profile/Avatar. Model, Skills/MCP, Memory and the remaining detail
Tabs are not claimed by this evidence. Theme Studio D3 and `DESKTOP-THEME-PACK-PERSISTENCE-001` remain unrelated
open decisions/TODOs.
