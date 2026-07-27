# UI 2.0 Feedback And Data Display Evidence

## Runtime

- Date: 2026-07-18
- Surface: real Vite Web app with Playwright mock daemon routes
- URL: `http://127.0.0.1:4174/` during the Playwright-managed run
- Branch: `codex/ui2-desktop-coverage-foundation`
- Locale: English
- Theme packs: `ling-light`, `ling-dark`
- Viewports: `1440x960`, `1280x800`

## Captured States

- `1440x960-ling-light-profile-toast.png`: Profile save success through the shared global Toast;
  same-scope replacement keeps one item and hover pauses dismissal.
- `1280x800-ling-dark-profile-inline-error.png`: a deliberate Profile save failure remains as
  productized persistent InlineFeedback; no success/error Toast is created.
- `1280x800-ling-dark-model-empty-state.png`: Model Workbench empty result consumes the shared
  EmptyState through the compatibility adapter.

## Interaction Evidence

- Profile save Toast uses stable scope `profile:save`, replaces rather than stacks, remains visible
  while hovered, and dismisses after hover ends.
- Profile no longer renders `.profile-settings-tip` or a Feature-owned Toast viewport/timer.
- Plugin enable/disable/create and Media Production save continue to use the same Web adapter.
- Reduced motion was enabled for the Dark error/empty-state run.
- Both viewports passed horizontal-overflow assertions.

## Automated Evidence

- `@ling-stack/ui-react` tests: `23/23`.
- Focused `ui2-feedback-data-display.spec.ts`: `2/2`.
- Target regression (`profile`, `plugins`, `media-production`, `dark-mode`, focused spec): `22/22`.
- Web typecheck and i18n audit passed.
- Console/page errors: `0` unexpected. The Dark failure fixture intentionally returns one Profile
  `500`; the resulting network console entry is explicitly scoped out while all other errors remain
  fatal to the test.

## Remaining Scope

- P1C primitives are implemented, but DataRow/Table/Inspector and the global feedback migration are
  not yet complete across every product module.
- Browser `alert()`, remaining Settings success strips, legacy StatusBadge families, and page-specific
  empty/loading styles stay assigned to their later module slices.
