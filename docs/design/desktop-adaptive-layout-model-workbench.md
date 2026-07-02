# Desktop Adaptive Layout And Model Workbench Table

## Purpose

This document records the desktop-only adaptive layout contract for Ling Stack Web and
the first concrete polish target: the Model Workbench table at 1280px desktop width.
It was created because existing docs define the Model Workbench as a dense table, but
do not define the desktop multi-size acceptance rule or how the table should behave on
smaller laptop windows.

## Scope

This design is for desktop Web only. It covers laptop and external-monitor windows,
not mobile product layout.

Target desktop widths:

- 1280x800 as the small-laptop baseline.
- 1440x900 as the common laptop baseline.
- 1728x1117 as a scaled MacBook Pro style viewport.
- 1920x1080 as the common external-monitor baseline.
- 2560x1440 as the 2K monitor baseline.

## Current Finding

The July 2 desktop audit found that the app shell and major settings workspace tools do
not create page-level horizontal overflow across the target desktop matrix. The remaining
visible risk is the Model Workbench table inside Settings at 1280px:

- page overflow is still `0`;
- the provider table shell becomes an internal horizontal scroller;
- the table's hard `min-width` and fixed columns make the first small-laptop view feel
  less elastic than the rest of the settings surface.

## Product Rule

Desktop adaptive layout means:

- the full app page must not horizontally overflow at 1280px or above;
- primary action buttons must stay visible without page-level horizontal scrolling;
- dense operational tables may use internal horizontal scrolling only when the data is
  truly tabular and cannot be compressed without losing meaning;
- for high-frequency management tables, first try elastic columns, text truncation, and
  compact metadata before accepting internal horizontal scrolling;
- large screens may use more whitespace, but rows should not stretch into unreadable
  long lines.

Mobile behavior is out of scope. Existing narrow-screen fallback code can remain as
defensive behavior, but mobile viewport polish is not an acceptance target for this
slice.

## Model Workbench Design

The Model Workbench remains a dense table, matching `provider-presets.md`.

First polish target:

- remove the hard 1040px table minimum for the settings-embedded workbench;
- convert column widths to elastic percentages with small minimums;
- keep row actions visible in the right column;
- keep model name and Base URL on one scan line with ellipsis instead of widening the
  table;
- keep capability and check metadata accessible through existing row text, status chips,
  and edit sheet; do not add new cards or a secondary inspector.

Expected 1280px behavior:

- Settings secondary navigation remains visible.
- The provider table shell has no horizontal scrollbar in ordinary two-provider data.
- Provider name, model, Base URL, key status, check status, readiness, and actions remain
  visible.
- Long provider/model/base-url values truncate within their own cells instead of pushing
  the action column outside the shell.

## Module Boundaries

- UI markup: `apps/web/src/features/providers/ProviderSettings.tsx` only if a class or
  accessible label is needed.
- Styles: `apps/web/src/styles/providers.css`.
- Tests: `apps/web/e2e/model-workbench.spec.ts` and existing settings/app coverage.
- API/client/types/persistence: no changes.

Avoid adding new behavior to `AppShell.tsx` for this slice.

## Implementation Plan

1. Update Provider Workbench table CSS:
   - remove the fixed `min-width: 1040px`;
   - use percentage-based table columns;
   - lower fixed minimums in provider name/key/action cells;
   - keep status/action cells compact and visible.
2. Update E2E layout assertions:
   - assert the table shell does not horizontally scroll at the baseline workbench width;
   - keep the action-cell containment assertion;
   - keep selected-row and row-menu behavior.
3. Run:
   - `corepack pnpm --filter @ling-stack/web typecheck`;
   - `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts app.spec.ts settings.spec.ts`;
   - real dev-server desktop audit at 1280 and at least one wider viewport.

## Non-Goals

- No mobile adaptation.
- No API or provider persistence changes.
- No redesign of the add/edit provider sheet.
- No replacement of the Model Workbench table with cards.
- No broad CSS rewrite outside the provider workbench surface.
