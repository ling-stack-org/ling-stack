# Approvals UI 2.0 Evidence Metadata

## Scope And Status

- Captured and verified: `2026-07-23 02:13 CST`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` /
  `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: large shared dirty tree; existing changes were preserved. No reset, clean, stash, switch, checkout,
  rebase, merge, commit or push was run.
- Served artifact: real Vite source application with Playwright daemon fixtures, not static component HTML.
- Browser: Playwright `1.60.0` Chromium project, one worker, desktop `deviceScaleFactor=1`, reduced motion.
- Screenshot server: `http://127.0.0.1:4314`; exact legacy and external-work gates used ports `4315` and `4313`.
- Themes: built-in `ling-light` and `ling-dark`; no imported Theme Pack is claimed.
- Web status: `APPROVAL-LIST-001` and `APPROVAL-DECIDE-001` are verified.
- Desktop status: packaged Electron macOS/Windows evidence remains a separate release gate.

## Reproduction And Results

```bash
cd apps/web
LING_PLAYWRIGHT_PORT=4314 corepack pnpm exec playwright test e2e/ui2-approvals.spec.ts --workers=1
LING_PLAYWRIGHT_PORT=4315 corepack pnpm exec playwright test e2e/approvals.spec.ts --workers=1
LING_PLAYWRIGHT_PORT=4313 corepack pnpm exec playwright test e2e/external-work.spec.ts --workers=1
```

- focused Approvals: `9/9` passed;
- legacy Approvals: `2/2` passed;
- exact external-work selected: `5/5` passed;
- Web typecheck, UI 2.0 lint, i18n audit and scoped `git diff --check`: passed;
- focused CSS scan: zero hard-coded colors, `!important`, private keyframes, `transition: all`, Theme/Profile
  selectors, direct `.ling-ui-*` overrides or direct package imports.

The focused tests cover 100-row internal scroll, keyboard selection, search/Escape, retained refresh failure,
request/selection races, empty History, truthful queue categories, high-risk portal Dialog focus/single-flight,
decision failure and authority expiry, durable permission delta, independent external execute/cancel failures,
Inline Strip deduplication and Composer geometry, and folded long payload containment. Browser/page errors are asserted
clean; synthetic `409/503` responses are allowed only in their explicit fault fixtures.

The exact external-work gate additionally expands the artifact Inspector and verifies ordinary Markdown/JSON approval,
execution and cancellation records; these records are not treated as file-diff evidence.

## Original-Size Screenshot Ledger

All eight files are direct RGB Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme / locale | Captured state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-actionable-list-detail.png` | `1440x960`, `ling-light`, `en-US` | 100-row Actionable list, keyboard-selected detail and retained/race-safe refresh | `d91a8d0ce5e1aa851b3484cfd143a5a8929660e0805dfc84ad33feec94ec10fb` |
| `1280x800-ling-dark-empty-history.png` | `1280x800`, `ling-dark`, `zh-CN` | empty History with Work Board and Refresh actions | `5a0dc0c01a39a9fcd633cff05f4ffbedd072a7001df12dc116b69bb04294dd19` |
| `1440x960-ling-light-high-risk-confirm.png` | `1440x960`, `ling-light`, `en-US` | busy high-risk portal Dialog with required reason and blocked dismissal | `7c0ceaca839ac3f410c8cc219d4affe95f166097bcb21a51a468a1c1604e8f59` |
| `1280x800-ling-dark-decision-failure.png` | `1280x800`, `ling-dark`, `en-US` | failed decision retained in Dialog with reason and Retry | `7d7f3f33b63372535824eeaed0a9ff272f9d1b9cb7e6e0e6e127f7f487a087f7` |
| `1440x960-ling-light-permission-delta.png` | `1440x960`, `ling-light`, `zh-CN` | History detail with durable add/remove/unchanged permission result | `d740045ce42376daca4e5fe209f6f329cd21c151a85f003cefb924b6042066ab` |
| `1280x800-ling-dark-external-action-failure.png` | `1280x800`, `ling-dark`, `zh-CN` | approved external action with scoped execution failure and Retry | `336f74849c03846346ee2ebfc4f9eab70e946884580e13e2478ad2443b7a6cc3` |
| `1440x960-ling-light-inline-approval-strip.png` | `1440x960`, `ling-light`, `en-US` | critical-first Inline Strip, folded secondary items and stable Composer | `04ce52ceca0f58d36c7199554d25d83fbd96137a2b922267c2310da4667e1880` |
| `1280x800-ling-dark-expired-long-payload.png` | `1280x800`, `ling-dark`, `zh-CN` | expired long path with repair owner and folded technical payload | `f170afadb94f806718f45966aacc90b9c2de7d36cbb9d5fc7ba379ccd326536c` |

## Original-Size Visual Audit

- `actionable-list-detail`: list and detail remain distinct internal-scroll owners; selected row, controls and long
  list content do not create root horizontal overflow.
- `empty-history`: empty list and handling panel remain aligned; no phantom decision action or opposite-theme panel.
- `high-risk-confirm`: one centered portal Dialog and one backdrop; footer, textarea and disabled busy controls fit.
- `decision-failure`: retained reason, local failure and Retry fit the Dark Dialog without clipping or stacked overlay.
- `permission-delta`: add/remove/unchanged columns, durable result and technical Inspector remain contained.
- `external-action-failure`: selected row, audit summary, scoped failure, Retry and artifact Inspector stay in the
  detail scroll owner without covering the list.
- `inline-approval-strip`: primary and secondary approvals remain inside the Composer width; Send and workspace
  controls remain reachable.
- `expired-long-payload`: long path wraps inside the detail; repair actions and folded technical Inspector remain
  visible without widening the page.

No image showed incoherent overlap, root-width overflow, mixed Light/Dark surfaces or a second active overlay.

## Honest Remaining Gaps

- Imported Theme Pack compatibility is a global theme gate and is not represented by these images.
- No packaged Electron macOS Retina or Windows 125%/150%/forced-colors capture was produced.

## U13 Selector Owner Closeout

- Inbox/Card/Inline Strip owners now live only in `styles/approvals/*`; Channel-specific approval detail/status/reason
  owners live in `channel-overlays.css`.
- `components.css`, `strict-console.css` and `workspace.css` have zero Approvals/legacy inline-panel selector matches.
  The dead `inline-approval-panel/head` family was deleted rather than copied.
- Focused owner scan remains zero for hard-coded colors, `!important`, `transition: all`, private keyframes and
  Theme Pack selectors.
- Focused Approvals + legacy Approvals + Channel overlay regression passed `18/18`; the outer Composer approval
  surface is correctly queried as a named region while its hidden child remains the single `role=status` live owner.
- The original wrong-role failure was isolated, the corrected exact case passed `3/3`, and the final combined gate
  passed `18/18` with one worker on isolated Vite ports.
