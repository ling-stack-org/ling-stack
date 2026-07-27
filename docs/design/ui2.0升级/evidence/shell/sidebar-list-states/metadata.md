# P4.4 Sidebar List State Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixtures for channel, teammate, run, task, approval and conversation states
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-sidebar-list-states.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-dense-states.png` | `1440x960` | `ling-light` | Paused, waiting, running and failed rows plus long channel and teammate lists |
| `1280x800-ling-dark-recent-loading-busy.png` | `1280x800` | `ling-dark` | Delayed recent loading assertion followed by persisted running, selected row and archive action |

SHA-256:

```text
ddd9005fc56d6aada944fb3bb5a4f53f5867d63ae787ae9e4cfacba6fb634244  1280x800-ling-dark-recent-loading-busy.png
ba017c74a4c0b6e3a9d2bdeca57362776147e174a2d290625e13b50e9dbc4789  1440x960-ling-light-dense-states.png
```

## Verified Behavior

- Primary-state priority is `paused > waiting > failed > running > unread`; each object row renders at most one status.
- Channel state uses real channel, run, task, approval, notification preference and unread inputs.
- Teammate state uses real teammate, assigned task, run and approval inputs; idle teammates do not receive a fake green status.
- Recent conversations preserve persisted thread status and active run/stream state across list refresh.
- Recent loading uses two stable Skeleton rows; the final list is limited to five records and long titles truncate without overflow.
- Status is a semantic sibling of the row button, not a role nested inside a native button. It remains visible, has an explicit
  accessible name and does not shift the label or hover action column.
- Pending approvals remain `waiting` after opening a channel until the approval is resolved; they are not downgraded to unread.
- Existing archive and selection flows remain non-destructive and keep their stable action geometry.
- `sidebar.css` remains at 1960 lines. New state-column ownership is in focused `app/sidebar-ui2.css`.
- Browser console errors and page errors: `0` unexpected in both focused evidence scenarios.
- Both screenshots were inspected at original resolution; no overlap, horizontal overflow, theme leakage or row jump was found.

## Automated Evidence

- `@ling-stack/ui-react`: `38/38` tests passed.
- Pure channel, teammate and conversation status projection: `3/3` passed.
- Focused list-state browser spec: `2/2` passed.
- List-state plus object-row browser specs: `4/4` passed.
- Channel compact rail, pending approval priority and Health tab target: `3/3` passed.
- App, channel archive, teammate and dark-mode regression: `44/44` passed.
- Web i18n, UI 2.0 import/facade lint, typecheck and `git diff --check` passed.

## Remaining Scope

- This verifies `SIDEBAR-CHANNEL-001`, `SIDEBAR-TEAMMATE-001` and `SIDEBAR-RECENT-001` for the desktop Web target.
- Sidebar primary navigation, menu and tooltip are implemented but still need their own complete verification closure.
- The full 149-test exploratory run exposed one repeatable, unrelated Channel baseline failure:
  `phase 1 parallel multi-agent active transcript shows latest action per agent without drawer surfaces`.
  It expects zero `.conversation-work-cell-active-stream` nodes but receives two; P4.4 does not touch that work-cell path.
- First Run has no confirmed production trigger and remains `inventory`.
- Chromium Web evidence does not replace Windows DPI/high-contrast or signed Desktop package evidence.
