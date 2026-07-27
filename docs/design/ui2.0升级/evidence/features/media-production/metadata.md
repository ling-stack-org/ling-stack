# Media Production P10.2 Evidence

## Status

- Verification date: 2026-07-23
- Source: `0a0b8050+worktree`
- Served artifact: Vite source through the Playwright `webServer`
- Scope: desktop Web at `1440x960` and `1280x800`
- Result: `36/36` evidence scenarios passed
- Coverage: 9 Function IDs, 4 screenshots per ID
- Theme and locale split: 18 `ling-light/en-US`, 18 `ling-dark/zh-CN`
- Packaged macOS/Windows acceptance remains pending under the Desktop lane.

## Capture Command

```bash
LING_CAPTURE_UI2_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4250 \
corepack pnpm --filter @ling-stack/web exec playwright test \
e2e/ui2-media-production-evidence.spec.ts --workers=1
```

## Evidence Matrix

| Function ID | Captured states | Contact sheet |
|---|---|---|
| `PROD-PROJECT-001` | project loaded, retry, delete review, initial loading | [project](prod-project-001-contact-sheet.png) |
| `PROD-SCENE-001` | long tree, empty, editing focus, delete review | [scene](prod-scene-001-contact-sheet.png) |
| `PROD-TOOLBAR-001` | ready run, long identity, check, Generation Tasks | [toolbar](prod-toolbar-001-contact-sheet.png) |
| `PROD-CANVAS-001` | 100 scenes, exclusive dock, far fit, reduced motion | [canvas](prod-canvas-001-contact-sheet.png) |
| `PROD-INSPECTOR-001` | direct source, blocked source, result, history | [inspector](prod-inspector-001-contact-sheet.png) |
| `PROD-WORKFLOW-001` | empty, import mapping, connection failure, workflow test | [workflow](prod-workflow-001-contact-sheet.png) |
| `PROD-RUN-001` | review, approval, regeneration, failed regeneration | [run](prod-run-001-contact-sheet.png) |
| `PROD-PREVIEW-001` | image, unavailable, video, open task | [preview](prod-preview-001-contact-sheet.png) |
| `PROD-DELETE-001` | project, scene, retained failure, busy | [delete](prod-delete-001-contact-sheet.png) |

Each original PNG has a neighboring `.png.json` sidecar containing the exact fixture, state, viewport,
theme, locale, Function ID, source revision, SHA-256, overflow measurements, browser signals, and optional
Canvas/media pixel evidence.

## Automated Audit

- 36 original PNG files、36 sidecars and 9 contact sheets are present; no original/sidecar orphan files were found.
- Every sidecar SHA-256 matches its PNG bytes.
- Every PNG dimension matches the declared viewport.
- `documentOverflow=0` and `ownerOverflow=0` for all states.
- Unexpected console errors and page errors are empty for all states.
- The project-delete failure fixture returns a controlled `500`; unexpected browser console and page-error arrays remain empty,
  while the exact expected resource error is recorded separately in the sidecar.
- Canvas screenshots pass nonblank pixel checks: opaque ratio above `0.95`, at least 16 unique colors,
  and non-dominant ratio at least `0.02`.
- Image preview geometry and visual-effect chains are identical across Light and Dark. Pixel comparison
  excludes the 8px rounded-corner crop so theme-owned page background does not contaminate media bytes.

## Visual Review

The nine 2x2 contact sheets were inspected at original resolution. No incoherent overlap, horizontal
overflow, clipped control chrome, theme leakage, blank Canvas, or dialog stacking error was found.
The focused scene title Input remains inside its control shell, and workflow checkboxes no longer expand
their hidden native input into the mapping grid.

## Regression Evidence

- `@ling-stack/ui-react`: `51/51`
- `ui2-form-controls.spec.ts`: `2/2`
- `media-production.spec.ts`: `8/8`
- P10.2 focused Media Production specs: `27/27`
- `media-jobs.spec.ts` plus `ui2-media-jobs.spec.ts`: `16/16`
- `dark-mode.spec.ts`: `2/2`
- Web typecheck, lint, i18n audit, and `git diff --check`: passed
- Post-closeout Dock/Inspector CSS owner refinement: focused plus legacy Media Production `35/35` passed on an
  isolated Playwright port; current focused tree is 8 files / 1,597 lines.

## Residual Risk

- This closes the P10.2 Web behavior and visual-evidence lane only.
- Packaged Desktop evidence and macOS/Windows host integration remain in the Desktop backlog.
- `use-media-production-controller.ts` remains close to the 800-line production-file guardrail and must
  not absorb new overlay or presentation behavior.
