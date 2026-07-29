# Plugin Manager UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-22`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop and UI 2.0 changes were preserved.
- Source surface: real Vite source application driven through the existing Playwright daemon fixture; no static DOM fixture.
- Browser: Chromium desktop, one worker, `deviceScaleFactor=1`, `en-US`.
- Themes: built-in `ling-light` and `ling-dark`; imported Theme Pack evidence is not claimed by this slice.
- Web status: all non-packaged Plugin Manager Function IDs are verified. `PLUGIN-CUA-001` and
  `PLUGIN-CUA-PROVIDER-HEALTH-001` remain implemented globally because packaged macOS/Windows evidence is absent.

## Reproduction And Test Result

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-plugin-manager.spec.ts plugins.spec.ts
```

Result: `17/17` passed on `2026-07-22`:

- focused `ui2-plugin-manager.spec.ts`: `10/10` passed;
- legacy `plugins.spec.ts`: `7/7` passed.

The focused suite covers retained rows after refresh failure and Retry recovery, row-scoped Check failure,
Drawer-scoped generic mutation failure, local filters, 100-row internal scrolling, shared create validation,
Runtime disclosure, uninstall confirmation and CUA setup. Before every evidence capture it asserts:

- unexpected console errors: `0`;
- uncaught page errors: `0`;
- document horizontal and vertical overflow: `<= 1px`;
- focused shared Input remains contained by its fixed-height shell;
- the 100-row TableBody owns vertical scrolling and table horizontal overflow remains `<= 1px`.

Synthetic request failures used by retained-refresh and mutation scenarios are acknowledged only by those tests;
all unrelated browser failures still fail the suite.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport screenshots. They were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-list-ready.png` | `1440x960`, `ling-light` | Ready list, stable four-column table and actions | `224f85dca5f7fac54aa9daea92f9d067ae6b8b4cf0803a85279ed4e932f81002` |
| `1440x960-ling-light-retained-refresh-failure.png` | `1440x960`, `ling-light` | Refresh failed, three previous rows retained, Retry visible | `85014a1f7528489b76015ee1f7f8033f7d6e8c0b1fb61459faf61d2a8f0ca620` |
| `1440x960-ling-light-search-no-result.png` | `1440x960`, `ling-light` | Local no-result state and Clear filters | `b105649c39cb9ac48b95c21b7a477443425b57a30eba01e8d690dac462dd7b21` |
| `1440x960-ling-light-create-validation.png` | `1440x960`, `ling-light` | Shared Dialog validation and first-invalid focus | `b73998d6bf7e17b2921bb295d3a6fe2b21a40aafad024cbbb4815739670cbd1b` |
| `1440x960-ling-light-uninstall-confirm.png` | `1440x960`, `ling-light` | Bundled package uninstall confirmation | `9342d6ff9fc6e28f30341c1c0298b2532816dc5b9aec943b0e228720f30cfaf4` |
| `1280x800-ling-dark-list-needs-action.png` | `1280x800`, `ling-dark` | Needs-action rows and compact action matrix | `f1631f8128f91752fc6d5acef9411a0897f8008955b5da24d3d43ff520c57063` |
| `1280x800-ling-dark-detail-runtime-blocked.png` | `1280x800`, `ling-dark` | Runtime blocker summary with raw data folded | `0c36d795f0eddc71d9a644031a85e44080e4dd5d26b31968c0b4e0b79efa2b03` |
| `1280x800-ling-dark-detail-mutation-failure.png` | `1280x800`, `ling-dark` | Generic runtime failure retained inside its Drawer owner | `4d0cd499669542bf9b02fec069affb7b166fea1d292e5784502bf1cbe5da8711` |
| `1280x800-ling-dark-cua-repair.png` | `1280x800`, `ling-dark` | macOS CUA installation guidance and repair path | `13faa355591628522ead74d27ac8389934a9e47761b4fc620fd95dfd52239f6b` |

## Original-Size Visual Audit

All nine PNGs were inspected at original resolution after the successful `17/17` run:

- header, toolbar, rows, Dialogs and Drawers remain inside `1440x960` and `1280x800`;
- no visible horizontal page/table overflow or clipped action group;
- retained refresh feedback does not replace or obscure the stale rows;
- row and Drawer failures stay beside the object/action that owns recovery;
- Light and Dark overlays use coherent token surfaces without a hard-coded opposite-theme panel;
- the focused create Input does not change control height or draw a second native focus box outside the shell.

## Honest Remaining Gaps

- The focused fixture covers built-in Ling Light/Dark only; imported Theme Pack compatibility remains a global theme gate.
- The macOS CUA Drawer is Web fixture evidence, not a packaged Electron macOS interactive session.
- The Windows provider-health Web fixture passes legacy E2E, but real packaged Windows 125%/150% scaling,
  high contrast and interactive provider attachment remain unverified.
- Web screenshots do not prove native titlebar, OS font rasterization, GPU composition or packaged startup behavior.
