# P7B.4 Startup And Run Diagnostics Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | 2026-07-20 |
| Branch | `codex/ui2-desktop-coverage-foundation` |
| HEAD | `0a0b8050` |
| Working tree | dirty, 409 porcelain entries at capture time; Desktop/Computer Use and UI 2.0 work are intentionally preserved together |
| Server | real Vite dev server at `http://127.0.0.1:4174` |
| Server command | `corepack pnpm exec vite --host 127.0.0.1 --port 4174` through Playwright `webServer` |
| Capture command | `LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-startup-diagnostics.spec.ts` |
| Browser | Playwright Chromium, one worker |
| Data | deterministic mock daemon fixture; this proves the Web product surface and real browser interactions, not a live daemon or packaged Desktop host |

## Evidence Matrix

| File | Viewport | Theme / locale | Trigger and state | Result |
|---|---|---|---|---|
| `1440x960-ling-light-startup-ready.png` | 1440x960 | `ling-light`, `en-US` | Settings > Startup and diagnostics after initial loading | one quiet Ready state, icon-only Refresh, Open Run Diagnostics, folded technical details, no redundant success card |
| `1440x960-ling-light-startup-blocker-details.png` | 1440x960 | `ling-light`, `en-US` | degraded provider and failed plugin; open Technical details | product reasons and suggested next steps remain primary; ten phases, raw code and long path stay inside the explicit technical owner |
| `1280x800-ling-dark-startup-stale-zh-CN.png` | 1280x800 | `ling-dark`, `zh-CN`, reduced motion | refresh an existing Ready snapshot and receive 503 | authoritative snapshot remains visible, stale warning is persistent, raw failure is folded, actions and Chinese labels remain contained |
| `1440x960-ling-light-run-diagnostics-selected.png` | 1440x960 | `ling-light`, `en-US` | open Run Diagnostics and select a running run | bounded list/detail layout, one status, event/artifact counts, readable recent activity labels, folded raw data and explicit full diagnostics action |
| `1280x800-ling-dark-run-diagnostics-empty.png` | 1280x800 | `ling-dark`, `en-US` | open diagnostics with no runs | distinct compact list and detail empty states, Settings navigation retained, no false error or global navigation |
| `1280x800-ling-dark-run-diagnostics-error-details.png` | 1280x800 | `ling-dark`, `en-US` | refresh no-runs list, receive 503, open Error details | persistent product error owns the surface, raw provider message appears only after disclosure, empty state remains truthful |

## Interaction And Runtime Checks

- Loading and refresh: initial Startup loading keeps stable geometry; Refresh only marks its initiating IconButton busy; an existing snapshot survives refresh failure as stale.
- Data ownership: Startup uses the existing status/refresh API. Settings Run Diagnostics uses the Runs domain error, events, artifacts and selected run without copying request state into Settings.
- Selection: selecting a run loads its detail without a second `/runs` list request or resetting the Settings return target.
- Disclosure: phase IDs, codes, paths, raw errors and run IDs stay folded until Technical/Error/Raw details are explicitly opened.
- Navigation: Settings navigation remains visible; Ling Stack global navigation remains absent; Open full diagnostics is explicit and outside Raw details.
- Activity: the six most recent relevant events expose readable labels and timestamps. Delta/update noise is excluded, while failure, approval, artifact and tool lifecycle remain scannable.
- Keyboard and motion: shared IconButton, Button and InspectorSection semantics remain in use; the Chinese stale scenario ran with `prefers-reduced-motion: reduce`.
- Console: all focused scenarios completed with no collected `console.error` or `pageerror`.
- Overflow: E2E verified panel and document horizontal containment at both target viewports; long paths wrap inside technical details and Settings owns vertical scrolling.
- Visual review: all six PNGs were opened at original resolution. The initially blank Recent activity labels were corrected and recaptured; no text/control overlap, clipped action, hard-coded light surface in Dark, or incoherent overlay stacking remained.

## Test Results At Capture

```text
@ling-stack/ui-react                                      41/41 passed
ui2-settings-startup-diagnostics.spec.ts                    5/5 passed
settings.spec.ts                                           17/17 passed
runtime.spec.ts                                            19/19 passed
ui2-settings-shell + feedback + app + dark-mode            25/25 passed
Web typecheck, check:i18n, lint, diff check                 passed
```

## SHA-256

```text
070e022965a0810ba41a6a5e35d12be706c00851232d2b17665c278af206304e  1280x800-ling-dark-run-diagnostics-empty.png
4eda9737533ad9e6f94c793b6a89ffda96502856aac788e21e15a23b53a883ba  1280x800-ling-dark-run-diagnostics-error-details.png
15965bb969f9315d7fdf20843b5ee5a4c2682b1abcec79ee0df044f229df35f1  1280x800-ling-dark-startup-stale-zh-CN.png
e8db7c081409e18b10ea2ce07d266d373c5084fd1d5c3352d4798250098ee904  1440x960-ling-light-run-diagnostics-selected.png
1404d8cd77c189872ff1929ae8b45230c4e2a8ed08479214aedf68ee0a1d5ca8  1440x960-ling-light-startup-blocker-details.png
8a04d2804582a7c1b51ba872cf510df3f0b2ae48ac3f7205b4e0914543ee14b9  1440x960-ling-light-startup-ready.png
```

## Scope Boundary

- This slice changes only Startup/Run Diagnostics presentation, state projection, Settings adapters, focused CSS, tests and evidence.
- It does not add repair actions, retry/cancel/intervention controls, routes, `ViewId`, APIs, persistence, permissions or a second Runs state owner.
- `nextAction` remains advisory text because the current Startup contract has no action identifier or repair API.
- It does not prove a live daemon, packaged macOS/Windows client or Windows DPI/high-contrast behavior; those remain release and platform gates.
