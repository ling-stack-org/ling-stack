# P8.1d AI Teammate Management Model Evidence

## Scope

- Captured: 2026-07-21, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, commit, push, rebase or merge.
- Surface: real Vite application with Playwright daemon fixtures, not a static component screenshot.
- Function ID: `TEAMMATE-MODEL-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

The teammate Model Tab binds the existing `providerPresetId` only. Provider creation, API Key, Base URL,
protocol, capability editing and checks remain owned by Model Workbench. Ling Agent uses its active channel or
workspace model path and never exposes a fake editable binding. No daemon API, contract, database, route,
provider state machine, Settings IA or private-chat runtime behavior changed.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-ready.png` | 1440x960 / `ling-light` | ready route, visible primary status, single Header action owner | `7eb819eda8e471c404ede737dc2e8d7de6c3aa149deafcd7e64e5675cdecd42c` |
| `1280x800-ling-dark-missing-key.png` | 1280x800 / `ling-dark` | missing API Key with persistent repair guidance | `4627f64a93d7fd664f3b58587ccb003e9bec701392f3bf280d625d02f41747de` |
| `1440x960-ling-dark-protected-managed.png` | 1440x960 / `ling-dark`, zh-CN | protected Ling Agent managed path without Select/Reset/Save | `0522277b09d292f7675aa0144dc99f03fd2fb3deb018e5d361670ded836a5059` |
| `1280x800-ling-light-save-failure.png` | 1280x800 / `ling-light` | failed update keeps selected draft and local feedback | `1f7b54da04cc53ae411704fccf1580f7acf794a1abcdebc769282ea2a895a980` |
| `1280x800-ling-dark-long-model.png` | 1280x800 / `ling-dark`, reduced motion | long provider/model identity contained without document overflow | `7c1b50ab75c0121ef74e332d5076c7cfbbb307e46a569ceca7da886125a69a40` |

All five PNG files were inspected at original resolution. The second capture made the primary status text visible
instead of leaving only a semantic dot. Header actions, assigned-model Select, compact summary rows, repair feedback,
right summary, long labels and the three-column Settings shell remain separated at both viewports. Browser console
and document overflow assertions were empty for every focused scenario.

## Reachable State Evidence

- `managed`: protected Ling Agent shows channel/workspace ownership, no editable binding or Model actions.
- `unassigned` and no-provider inventory: one truthful warning or compact EmptyState with one Workbench action.
- missing saved id: synthetic unavailable selection preserves the state instead of silently becoming None.
- disabled, non-chat, missing Key, unchecked and failed check: deterministic one-status priority with product copy;
  raw provider response is absent.
- ready: one visible success status and no persistent success banner.
- dirty/reset/save: Header is the sole Reset/Save owner; duplicate save is disabled while pending.
- success: deduplicated `teammate:model:<id>:save` global Toast expires through the shared provider.
- failure: the selected draft stays editable and Model-owned InlineFeedback persists.
- long content/reduced motion: no horizontal/document overflow or custom transition/keyframe.

## Verification

- `corepack pnpm --filter @ling-stack/ui-react test`: `50/50`.
- `ui2-teammate-management-model.spec.ts`: `6/6`, including final evidence capture.
- `teammates.spec.ts` + Profile + Settings workspace-tools + Dark regression: `36/36`.
- List/Create focused regression: `9/9`.
- Web `typecheck`, `check:i18n`, `lint` and `git diff --check`: passed.
- Focused CSS forbidden literal, `!important`, Theme/Profile selector, `transition: all`, private keyframe and
  package-private `.ling-ui-*` selector hits: zero.

## Structure And Residual Risk

- `TeammateWorkspace.tsx`: `2,362 -> 2,348`; Model state/save/error logic moved out.
- New focused owners: `TeammateModelTab.tsx` 105 lines, `useTeammateModelController.ts` 113 lines,
  `teammate-model-view-models.ts` 217 lines and `teammate-management-model.css` 113 lines.
- `teammates.css`: `2,648 -> 2,628`; old Model grid/config-card selectors were removed.
- `teammate-management-settings-shell.css`: `257 -> 259` only to register the Model content scroll owner.
- The 2,348-line workspace remains architecture debt. Skills/MCP, Memory and remaining management Tabs must keep
  extracting focused controllers/components before adding major behavior.
- Theme Studio D3 and `DESKTOP-THEME-PACK-PERSISTENCE-001` remain separate open work and are not claimed here.
