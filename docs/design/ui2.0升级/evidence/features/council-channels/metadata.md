# Council Channels UI 2.0 Evidence

Date: 2026-07-22

## Source

- Function ID: `COUNCIL-CHANNELS-001`
- Slice: `P8.2d / CCHA-01..08`
- Branch: `codex/ui2-desktop-coverage-foundation`
- HEAD at capture: `0a0b8050`
- Worktree: shared dirty UI2/Desktop worktree; the images contain the current uncommitted Council Channels slice and
  the already integrated UI2 foundations.
- Runtime: real Vite source server started by Playwright at `http://127.0.0.1:4192` for capture. The main-agent final
  focused rerun used isolated port `4199`.
- Data: deterministic Playwright daemon routes. No real token, secret, user path or remote provider was used.
- Acceptance surface: desktop Web. Packaged Electron macOS/Windows evidence is not claimed.

## Verification

```text
LING_PLAYWRIGHT_PORT=4192 LING_CAPTURE_UI2_EVIDENCE=1 \
  corepack pnpm --filter @ling-stack/web exec playwright test ui2-council-channels.spec.ts
Result: 7 passed

LING_PLAYWRIGHT_PORT=4199 \
  corepack pnpm --filter @ling-stack/web exec playwright test ui2-council-channels.spec.ts
Main-agent final result: 7 passed

Council list/health, members, create/clone, legacy Council, Settings workspace-tools and Dark selected regression
Result: 40 passed

Web typecheck, check:i18n and lint: passed
Touched-path git diff check, focused CSS forbidden scan and local document-link check: passed
```

The focused suite asserts exact full-policy attach/prefer/detach payloads, managed and unavailable Council rows,
paused/archived removal-only behavior, row-scoped busy/failure, initial and retained refresh failure, request identity,
100-row internal scrolling, Select focus containment, Tabs keyboard behavior, Open Channel routing, zero root/panel
horizontal overflow and zero unexpected console errors.

## Screenshots

| File | State | Viewport / locale / theme | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-attached-managed-preferred.png` | custom attached plus managed preferred Council | 1440x960 / en-US / ling-light | `fd01b7040f03fe16db2c983278afa0099eeb1974ac7ad7b484ae5b4b5e143139` |
| `1280x800-ling-dark-archived-removal-only-zh-cn.png` | archived channel, attached and unavailable relationships, detach only | 1280x800 / zh-CN / ling-dark / reduced motion | `4b25d964ac085b776709c28ce95eaf9bf9ee6d74c32da756e13a86abf1a0fd25` |
| `1440x960-ling-dark-retained-policy-refresh-failure.png` | retained authoritative policy after refresh failure | 1440x960 / en-US / ling-dark | `d5a6b891ce2ad89643da2d37e68b724eed50cfd22fd8ed08b60d01914dbd5ea1` |
| `1280x800-ling-dark-row-mutation-failure.png` | preferred mutation failed on initiating row only | 1280x800 / en-US / ling-dark | `ad8e60df94165bd5cf6e3b9d35c795cd55c0cc31b03a1e0af2a28c1730010127` |
| `1280x800-ling-light-no-channels.png` | no channel catalog, distinct empty state | 1280x800 / en-US / ling-light | `db87c9448de819a8f9157820d9fc19d314ad5969fc83e3de7ebd4ff3536b98f0` |
| `1440x960-ling-light-100-attached-councils.png` | long identities and 100 attached relationships in one scroll owner | 1440x960 / en-US / ling-light | `15f4fdf019f42f88485e9ea6df5e5de76425e2686f92d1ddfb16308737d14da3` |

All PNGs are original viewport size. Hashes were recomputed from the current files after the final capture.

## Visual Review

- All six images were inspected at original size.
- The channel selector, lifecycle status and Open action stay on one stable row at both target viewports.
- Relationship rows keep identity, one relationship status and bounded actions without horizontal overflow.
- The 100-row fixture scrolls inside the relationship list; the page and panel do not become a second scroll owner.
- Retained stale and row failure remain visible and actionable without clearing authoritative relationships.
- Archived state disables attach/prefer/open while preserving detach for every current relationship, including a missing
  Council rendered as `Unavailable` rather than exposing its raw ID.
- Dark and Chinese states use theme tokens and fit without clipped controls or color-only meaning.

## Residuals

- The policy API has no revision or ETag. The controller serializes mutations in this window but cannot prevent a
  different client from winning with a later full-policy write.
- Archived catalog discovery and active/paused application state come from separate snapshots; selection is repaired by
  ID, not by a server transaction spanning both requests.
- `COUNCIL-RUNTIME-001`, complete Council Settings/Archive and packaged Desktop evidence remain independent open work.
