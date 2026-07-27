# P8.1g AI Teammate Memory Evidence

## Scope

- Captured: 2026-07-22, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, commit, push, rebase or merge.
- Surface: real Vite source application with Playwright daemon fixtures on isolated port `4184`, not `dist`, Storybook or static HTML.
- Function ID: `TEAMMATE-MEMORY-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

Memory preserves the existing auditable `Archive / Reject / Quarantine` lifecycle. It does not add permanent delete,
a hard-delete API, a retention bypass or new database state. The page separates the selected teammate's private/channel
scopes from explicitly labeled Workspace-wide review policy and inbox governance. Secret-adjacent source content,
parser warnings, raw identifiers and candidate bodies remain folded until the user opens the owning detail.

## Screenshot Matrix

| File | Viewport / Theme | Reached state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-scopes-health.png` | 1440x960 / `ling-light` | teammate scopes, warning/critical health and expanded sensitive finding Drawer | `eb1f3cefa438816b59f29bb5cf61943f5d9ee82dd4c724b7dc6cf12a37804150` |
| `1280x800-ling-dark-workspace-governance.png` | 1280x800 / `ling-dark` | retained authoritative scopes after refresh failure and Workspace governance boundary | `733d8b997a70d7402df89973cec5df0dc78c9cc4f3e4ec1f1c2fef24a34b9428` |
| `1280x800-ling-light-review-inspector.png` | 1280x800 / `ling-light` | review candidate Drawer, local policy-save failure and auditable action set | `c8afcccddf4d32f92b7b28188b8ef089f9a82505f0d25a2dc5630fa3cfaf46f0` |
| `1440x960-ling-dark-import-warning.png` | 1440x960 / `ling-dark` | import preview, warning/skipped detail and disabled secret-adjacent candidate | `2b0c4329b1662529d252a0b6904d55997e9f3bb741c9dc1180ac70768fa064ad` |
| `1280x800-ling-dark-protected-secret-reduced-motion.png` | 1280x800 / `ling-dark`, zh-CN, reduced motion | protected Ling Agent scope policy and reset-safe identity switch | `51af58ad53ae7b875be1aa4e18cbe3dffdbc04cbd8f4685783a70afa9c459dd3` |

All five PNG files were reviewed at original resolution after the shared Dialog close-control fix and evidence
recapture. Header, navigation, scope rows, feedback, governance controls, Dialog/Drawer and configuration summary do
not overlap. Both viewports remain document-contained. The focused overlays no longer leave a close Tooltip above an
auto-focused close icon, so one `Escape` reaches the Dialog/Drawer while `aria-label` and `title` remain available.

## Reachable State Evidence

- initial loading uses stable Skeleton geometry and cannot render a false empty state;
- a failed refresh retains the last authoritative scopes, marks them stale and exposes a local Retry;
- private summary/notes and channel brief/decisions remain distinct, with raw scope and owner detail folded;
- normal, warning and critical health use one visible state and an optional detail Drawer;
- conservative/balanced/fast policy changes are explicitly Workspace-wide, scoped-busy and rolled back after failure;
- approve, edit-and-approve, keep, archive, reject and quarantine preserve the auditable lifecycle; no Delete action is exposed;
- destructive review failure remains inside its confirmation Dialog, retains the row and supports retry;
- import requires preview before commit, keeps warning/skipped detail folded, preserves failed input and disables secret-adjacent candidates;
- protected Ling Agent copy remains truthful; pending old-teammate refreshes cannot leak scopes or overlays into the new identity;
- every focused scenario checks browser errors and document overflow; reduced motion adds no Feature-owned animation.

## Verification

- Focused capture run: `ui2-teammate-management-memory.spec.ts` `5/5`.
- Full Teammates plus Memory integration: `teammates.spec.ts` and focused Memory `26/26`.
- Legacy Markdown import path remains covered by the Teammates suite.
- Web `check:i18n`, typecheck and UI2 import/overlay lint passed before capture; final combined static gates are owned by the UI2 integration closeout.
- Direct Feature Radix imports, focused hard-coded colors, `!important`, `transition: all`, private keyframes and package-private `.ling-ui-*` selector ownership: zero.

## Structure And Residual Risk

- Focused owners: 384-line controller, 244-line pure view-model, 313-line primary CSS and 93-line overlay CSS.
- `TeammateWorkspace.tsx` is 1,802 lines and remains above the 1,200-line architecture-debt threshold. The Memory
  slice removed its controller/view-model/overlay responsibility, but MCP, Channels and Danger must continue extracting
  focused owners instead of appending major behavior.
- Workspace review policy and inbox are intentionally global governance within the teammate page; copy must continue
  to prevent users from interpreting them as selected-teammate-only data.
- No API, contract, database, route, retention or protected-teammate mutation behavior changed.
