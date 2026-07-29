# P4.8 AppShell Feedback And Permission Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty integrated Desktop/Computer Use and UI 2.0 workspace; no reset, cleanup, stash mutation,
  commit, push or branch switch
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium on macOS 26.5.2 arm64
- Data source: deterministic `mockDaemon`; offline sequence is `false -> false -> true`, Full Access uses a
  configured `gpt-5.5` chat provider and an empty run list
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-shell-feedback-permission.spec.ts
```

## Function IDs

- `SHELL-DISCONNECT-001`
- `SHELL-PERMISSION-001`

## Verified Behavior

Connection feedback:

- daemon health failure leaves the selected Work Board and stale data mounted;
- persistent InlineFeedback explains that information may be out of date;
- Reconnect owns only its own loading and disabled state;
- successful health refresh clears the feedback without remounting the active page;
- the feedback remains below Dialog content at `z-index: 59` and does not create document overflow.

Full Access confirmation:

- the programmatic confirmation uses the shared application overlay root and shared Dialog at `z-index: 61`;
- initial focus lands on the non-destructive footer Cancel action instead of opening the title-bar Tooltip;
- one `Escape` rejects the pending confirmation and closes the Dialog;
- after the waiting Send control is enabled, focus returns to it and the composer draft remains intact;
- cancellation creates no run;
- reopening and confirming creates exactly one run with `permissionConfirmation.confirmed=true`,
  `mode=full_access`, `authorizationMode=always` and `workspaceAccessMode=full_access`;
- reduced motion removes animation without changing focus, presence or dismissal behavior.

Both focused tests verify no unexpected browser console errors and no document-level horizontal overflow.

## Automated Evidence

- `@ling-stack/ui-react`: `39/39`.
- `ui2-shell-feedback-permission.spec.ts`: `2/2`.
- P4.8 plus App/Dialog/Overlay/Dark combined regression: `28/28`.
- Web i18n, lint/import/overlay budgets, typecheck and `git diff --check`: passed.
- Legacy overlay budgets remain `97` total `z-index` declarations and `25` high numeric declarations; P4.8
  does not claim that U13/P12 cleanup is complete.

## Screenshots

| File | Viewport | Theme Pack | State | SHA-256 |
|---|---|---|---|---|
| `1440x960-ling-light-offline-feedback.png` | `1440x960` | `ling-light` | Work Board remains visible under persistent offline feedback | `cee8dc50c95f9da2c6e533cb4679190b17ce28521423c84428c7d55d08390b47` |
| `1280x800-ling-dark-full-access-confirmation.png` | `1280x800` | `ling-dark` | Full Access Dialog with Cancel initial focus and reduced motion | `b92d311eac1f10598f840663a6ff3a7ad385092a9180951e11558b67e4ed8612` |

Both PNG files were inspected at original resolution. No overlap, clipping, theme leakage, incoherent layering
or document overflow was observed.

## Status Decision And Boundary

- `SHELL-DISCONNECT-001`: `verified`.
- `SHELL-PERMISSION-001`: `verified`.
- Generic domain error ownership, First Run, Presentation artwork runtime and legacy CSS/z-index cleanup remain
  separate open work. These screenshots do not close those Function IDs.
- This Web evidence does not replace Windows DPI, native title-bar or signed Desktop package evidence.
