# T13-P.3-X Runtime Diagnostics Formal Evidence

## Scope And Baseline

- Slice: `T13-P.3-X Runtime Diagnostics formal evidence`.
- Recorded: `2026-07-26`, Asia/Shanghai.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- Branch HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Base reference `origin/main`: `db56fd7f3885d8146a363b8aa4449521af0e200e`.
- Merge base with `origin/main`: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this evidence slice. The recording snapshot reported 290 modified/added,
  57 deleted and 539 untracked porcelain entries; unrelated Agent and user changes were preserved.
- Write boundary: this slice adds only the two PNG files and this metadata file under
  `evidence/features/runtime-diagnostics-status/`. It does not modify production, CSS, tests, master plans or
  migration documents.

## Reproduction

The final images were captured from the real Web source through the Playwright-managed Vite server on the isolated
port `4300`. This is the Vite source application, not a built `dist`, static preview, container or packaged Desktop
renderer. The focused fixture uses the existing mock daemon routes and real Runtime Diagnostics presentation.

```bash
LING_PLAYWRIGHT_PORT=4300 LING_CAPTURE_RUNTIME_DIAGNOSTICS=1 \
  corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-runtime-diagnostics-status-presentation.spec.ts
```

Final capture result: `4/4` Chromium tests passed in 8.6 seconds.

## Status Coverage

| Runtime entity | Authoritative status | Visible presentation | Tone |
|---|---|---|---|
| Work Unit | `queued` | `Queued` / `已排队` | info |
| Work Unit | `claimed` | `Claimed` / `已认领` | info |
| Work Unit | `running` | `Running` / `运行中` | info |
| Work Unit | `waiting_for_approval` | `Waiting for approval` / `等待审批` | warning |
| Work Unit | `cancelling` | `Cancelling` / `正在取消` | warning |
| Work Unit | `succeeded` | `Succeeded` / `成功` | success |
| Work Unit | `failed` | `Failed` / `失败` | danger |
| Work Unit | `cancelled` | `Cancelled` / `已取消` | neutral |
| Work Unit | `stale` | `Stale` / `已过期` | warning |
| Resource Lease | `active` | `Active` / `进行中` | success |
| Resource Lease | `released` | `Completed` / `已完成` | neutral |
| Resource Lease | `expired` | `Expired` / `已过期` | warning |
| Semaphore | `active` | `Active` / `进行中` | success |
| Semaphore | `released` | `Completed` / `已完成` | neutral |
| Semaphore | `expired` | `Expired` / `已过期` | warning |

The static presentation matrix covers all 15 status mappings. The populated browser scenarios render all reachable
Work Unit, Lease and Semaphore states; the Cancel changed-state path reaches `cancelled` without adding a hidden raw
status token to the product DOM. No visible label contains snake_case.

## Automated And Runtime Assertions

- Every Runtime action button has a measured bounding box of at least `32px x 32px`.
- Cancel, Retry and Reconcile keep their real callbacks, scoped busy state and disabled behavior.
- The long Work Unit identifier, owner text, resource key and unbroken failure text remain contained in the narrow
  right Dock. The panel, long row and document have no horizontal overflow beyond the one-pixel geometry tolerance.
- All four visible supervisor MetaRows keep the external 2x2 summary. Each card uses a single label/value column,
  a measured gap of at least 2px, contained child boxes and no row scroll overflow.
- The Ling Dark scenario runs at `1280x800` with reduced motion and verifies productized Chinese labels, semantic
  status tones, theme ownership and long-content containment.
- The unavailable/empty scenario verifies the Runtime unavailable notice, `No work units recorded`, `No held
  leases` and `No semaphore slots`, with zero status indicators and no document/panel overflow. It is automated
  evidence only; the two-file evidence budget intentionally does not add a third empty-state screenshot.
- The runtime collector reported zero unexpected console errors and zero page errors for Light, Dark and
  unavailable/empty scenarios.
- Focused ownership assertions report no `StatusBadge` call, package-private `.ling-ui-*` selector, legacy
  `.status-badge` selector, Runtime universal reduced-motion blanket or `!important` in the focused owner.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | Bytes | Color | SHA-256 |
|---|---|---:|---|---|
| `1440x960-ling-light-runtime-diagnostics.png` | `1440x960` / Ling Light | 158014 | 8-bit RGB | `468e827f6fbf5ea841e8439f50e0905d50c902c37cc8ec0e0f1a3def284961af` |
| `1280x800-ling-dark-runtime-diagnostics.png` | `1280x800` / Ling Dark / reduced motion | 127589 | 8-bit RGB | `e3cb6eb7e63e871c6a5acaae39656d1401af9bb722537eeaefec460e4e5e4165` |

Both files are direct viewport PNG captures. They were copied byte-for-byte from the passing Playwright result and
were not resized, recompressed or color-converted.

## Original-Size Visual Review

- The Runtime Dock remains a narrow right-side inspector and does not overlap the Channel header, feed or Composer.
- The supervisor summary remains 2x2. `Runtime`, `PID`, `Status` and `Started` labels are visibly separated from
  their values; `Runtimeruntime_...`, `Statushealthy` and Started-value collisions are absent.
- Long runtime IDs use a stable one-line ellipsis. MetaRow labels, values and cards do not cross their boundaries.
- KPI cards, Work Unit list rows, status indicators and long identifiers remain aligned and contained.
- Light and Dark surfaces use their semantic tokens without hard-coded white leakage, clipped text or incoherent
  overlap. The screenshots and geometry checks show no horizontal overflow.
- The two screenshots show the populated list state. The complete matrix, 32px action area and unavailable/empty
  state are frozen by the focused assertions above where the narrow viewport cannot display every row at once.

## Web, AppShell And Desktop Boundary

- Proven: the Web AppShell Channel surface, Activity inspector navigation and Runtime Diagnostics Dock rendered by
  source Vite in Chromium at the two required desktop viewports.
- Not changed: AppShell navigation/business state, Runtime API/contracts/state machine, shared MetaRow, shared
  StatusIndicator, aggregate CSS and Desktop code.
- Not proven by this slice: packaged Electron Desktop, macOS Retina/native material, Windows 125%/150% DPI, Desktop
  window chrome, daemon lifecycle or real provider/runner execution. Those remain separate Desktop evidence work.
- This evidence does not elevate any master-plan or migration-board status by itself.
