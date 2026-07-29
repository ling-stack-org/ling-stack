# T13-P.7-H Profile Heatmap Theme Pack Evidence

- Scope: standalone `ProfilePage` heatmap only.
- Source owner: `apps/web/src/styles/profile.css`.
- Focused test: `apps/web/e2e/ui2-profile-heatmap-theme-pack.spec.ts`.
- Capture date: 2026-07-26 (Asia/Shanghai).
- Browser: Playwright Chromium through the real Vite application.
- Capture mode: `fullPage`; the requested viewport is recorded separately from the resulting image height.

## Evidence

| Theme | Viewport | PNG dimensions | File | SHA-256 |
|---|---:|---:|---|---|
| `ling-light` | `1440x960` | `1440x1028` | `1440x960-ling-light-profile-heatmap.png` | `25d6a624d3c5b276c2b66b3592470bb5a3f7c17507b9d444778203563c7a987f` |
| `ling-dark` | `1280x800` | `1280x1028` | `1280x800-ling-dark-profile-heatmap-focus.png` | `dbc91745803a2cf4f9d775784c292afe376f96859a903b31e7ce7769a1bb7d3d` |
| imported `quiet-ocean` | `1440x960` | `1440x1028` | `1440x960-quiet-ocean-profile-heatmap.png` | `89db9f02b962195fac9819f536ac56b3bca0d48d39d886e1c85cac9b19000992` |

## Verified Contract

- The actual standalone `ProfilePage` is mounted inside the real application providers; the test does not use a hand-authored heatmap fixture.
- `profile.css` contains zero `:root[data-theme="dark"] .profile-heatmap-cell` selectors.
- Level 0 resolves from `--ling-bg-panel`.
- Levels 1, 2, and 3 resolve from `--ling-action-accent` mixed with `--ling-bg-subtle` at `18%`, `34%`, and `58%`.
- Level 4 resolves directly from `--ling-action-accent`.
- All five computed backgrounds are distinct in `ling-light`, `ling-dark`, and imported `quiet-ocean`.
- The imported theme resolves `--ling-action-accent` to its own `#173f32`; no built-in Light/Dark selector supplies the heatmap color.
- The shared Profile name input keeps identical height before and after focus, and its focused native control remains within the shared input owner.
- Document and Profile horizontal overflow are at most one CSS pixel in all three scenarios.
- Console errors and uncaught page errors: `0` in all three scenarios.

## Verification

- `corepack pnpm --filter @ling-stack/web lint`: passed.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- ui2-profile-heatmap-theme-pack.spec.ts`: `4/4` passed.
- PNG decode and dimensions: passed for all three evidence files.
- Visual inspection: passed for Light, Dark, and imported Theme Pack captures.
