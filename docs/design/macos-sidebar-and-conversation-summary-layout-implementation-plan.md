# macOS Sidebar And Conversation Summary Layout Implementation Plan

Status: completed 2026-08-24
Baseline: `origin/main@7e2155f6e56d5d5648d044095f8e56fa231a00e0`
Scope: macOS Desktop Sidebar chrome and shared channel/normal/private Summary geometry

## Objective

Move the expanded macOS Sidebar toggle into the safe titlebar row, correct the compact
rail action order, and prevent Summary from covering any conversation when Details is
open. Web and Windows Sidebar geometry, conversation business state, daemon/API contracts,
permissions, approvals, persistence, and right-dock tools remain unchanged.

## Delivery Slices

1. Lock macOS titlebar geometry and compact rail order in focused Playwright regressions.
2. Add a pure shared Summary availability resolver and a React controller that observes
   the stable conversation root, preserves open intent, and exposes reserved-column style.
3. Apply the controller to channel, normal conversation, and teammate private chat.
4. Replace per-surface Summary offsets with shared `280px + 16px` geometry and add actual
   `aria-expanded` projection to the shared toolbar.
5. Verify wide coexistence, narrow concealment, automatic restoration, dock resizing,
   Sidebar collapse, reduced motion, dark/light themes, and runtime errors.

## Geometry Contract

```text
available root
  conversation column (>= 560px content + 48px gutter)
  summary reserve (280px panel + 16px gap, or 0)
  dock handle (8px, or 0)
  right dock (current target width, or 0)
```

The root width is measured before child reflow. A hidden Summary opens when the available
width is at least the required width plus a small hysteresis margin; a visible Summary
closes only after crossing the matching lower threshold. Closing Details or collapsing
Sidebar must re-evaluate the same controller without changing `summaryRequested`.

## Owned Files

- `apps/web/src/features/navigation/SidebarNavigation.tsx` only if semantic ordering cannot
  be expressed safely in CSS; CSS is preferred for the platform-only visual change.
- `apps/web/src/styles/app/macos-titlebar.css`
- `apps/web/src/styles/app/sidebar-rail-sections.css`
- focused shared Summary layout helper/controller under `apps/web/src/features/workspace`
- channel, normal conversation, and teammate private layout adapters and styles
- shared toolbar accessibility projection
- focused Web unit and Playwright tests

## Acceptance

- Expanded macOS Sidebar toggle is `32x32`, wholly right of the `76px` traffic-light zone,
  does not overlap New conversation, remains clickable, and leaves a real drag region.
- Collapsed macOS Sidebar shows Show navigation above New conversation; both are `36x36`.
- Web and Windows retain their existing Sidebar arrangement.
- At wide geometry all three conversation surfaces show feed, Composer, Summary, handle,
  and Details without overlap; feed and Composer share the same horizontal axis.
- At narrow geometry Summary disappears while its intent remains active, then automatically
  returns after width is restored, Sidebar collapses, or Details releases enough space.
- Resizing across the threshold does not flash repeatedly and never creates document-level
  horizontal overflow.
- Console and `pageerror` stay empty in `1440x960` Light, `1280x800` Dark, and one wide
  desktop fixture. Reduced-motion behavior remains spatially stable.

## Validation

- pure Summary resolver unit tests;
- `apps/web/e2e/macos-titlebar.spec.ts`;
- Sidebar foundation/rail focused Playwright suites;
- `apps/web/e2e/ui2-conversation-panels.spec.ts` with channel, normal, and private geometry;
- Web lint, i18n, typecheck, unit tests, production build, and `git diff --check`;
- real-browser screenshots and console/page-error inspection on the served implementation.

## Hard Stops

- No timers, viewport-only media-query guess, opacity-only concealment, or per-surface magic
  offset patch.
- No second Summary state machine and no change to Summary content ownership.
- No message, RunSession, right-dock page, Desktop IPC, security, or persistence change.

## Completion Evidence

- Shared Summary resolver unit suite: `6/6`; full Web unit suite: `64/64`.
- Focused macOS chrome and three-surface Summary Playwright: `15/15`.
- Sidebar controls/foundation/rail Playwright: `10/10`.
- Web lint, i18n, typecheck, production build, and 248-file Markdown link check passed.
- Real Browser verification covered `1728x960`, `1440x960`, and `1280x800` in Ling
  Light/Dark: wide coexistence, narrow concealment, Sidebar-triggered restoration, zero
  document overflow, and zero console errors or warnings.
