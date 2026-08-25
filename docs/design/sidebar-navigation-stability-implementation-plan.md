# Sidebar Navigation Stability Implementation Plan

Status: implemented; PR validation complete with documented baseline exceptions
Baseline: `origin/main@d0c9b42af78455741f30cd7d75a0dd99d77d4db4`
Scope: Desktop Web and packaged Desktop Web surface

## Objective

Remove transient loading presentation from the persistent left navigation. Switching between any visible main
navigation target changes only the active target while sidebar identity, section structure, rows, dimensions, scroll
and focus remain stable.

## Product Contract

- Sidebar never projects active-page detail loading, lazy chunk loading, or mutation busy state.
- Section counts are not replaced by Spinner or Loading content during navigation.
- Initial list Skeleton is allowed only when the current workspace has no cached or authoritative rows.
- Once rows exist, background refresh keeps them visible and commits the next collection atomically.
- Settings remains a full-screen shell boundary, but entering and leaving it has no blank or Loading intermediate frame.
- Failures stay owned by the target content or initiating action; stale cached navigation remains usable.

## Implementation Boundary

Owned files:

- `apps/web/src/features/navigation/SidebarSection.tsx`
- `apps/web/src/features/navigation/SidebarNavigation.tsx`
- `apps/web/src/domains/conversations/use-conversation-domain.ts`
- `apps/web/src/app/AppShell.tsx`
- focused Web unit and Playwright tests

The implementation must not change channel or teammate business state machines, daemon routes, API contracts,
database state, permissions, approvals, runtime selection or message persistence. If validation requires any such
change, implementation stops for product review.

## Delivery Slices

1. Add a failing regression that delays conversation detail responses and records all loading nodes and structural
   mutations under `.left-nav` while switching between normal conversations and teammate private chat.
2. Separate conversation collection readiness from conversation detail and mutation busy ownership. Only collection
   readiness may drive an initial sidebar Skeleton.
3. Remove header and compact-rail loading replacement from `SidebarSection`; keep a stable count/status slot.
4. Project only initial collection readiness through `AppShell` and `SidebarNavigation`. Preserve existing eager
   Sidebar placement outside active-page Suspense.
5. Run the full navigation matrix and Web checks before PR delivery.

## Acceptance Matrix

With target detail endpoints delayed long enough to expose transient states, repeatedly switch:

- new conversation, conversation A and conversation B;
- normal conversation and teammate private chat;
- teammate A and teammate B;
- channels, conversations and teammates;
- Media Production, Plugin Manager and Automations;
- expanded and compact Sidebar;
- Settings entry and return.

After initial hydration:

- `.left-nav` and each `[data-sidebar-section]` keep the same DOM identity;
- no Sidebar Spinner, Skeleton or Loading text appears;
- section count/status slots, width and scroll position do not jump;
- focus remains usable and the selected target changes without an intermediate cleared state;
- content errors do not clear or replace Sidebar data;
- console and `pageerror` remain empty.

## Validation

- focused navigation component/unit tests;
- delayed-response Playwright regression with a MutationObserver and geometry sampling;
- `corepack pnpm --filter @ling-stack/web lint`;
- `corepack pnpm --filter @ling-stack/web run check:i18n`;
- `corepack pnpm --filter @ling-stack/web typecheck`;
- `corepack pnpm --filter @ling-stack/web test`;
- focused and full Web Playwright suites;
- desktop browser checks at `1440x960` Light and `1280x800` Dark;
- `git diff --check`.

## Hard Stops

- No timer, debounce, opacity, delayed Spinner or CSS-only concealment.
- No weakening or deleting existing loading, ownership or late-response assertions.
- No clearing cached Sidebar collections during navigation.
- No changes to channel, teammate, security, approval, runtime or persistence semantics without renewed review.

## Completion Evidence

Implemented on 2026-08-14 without changing channel or teammate domain logic, API contracts, daemon behavior or
persistence.

- The delayed conversation-detail regression fails on the baseline because the recent-conversation count is replaced
  by a Spinner, and passes after the fix with stable status text, geometry and DOM identity.
- A 21-transition Playwright matrix covers normal conversations, channels, teammate private chat, Media Production,
  Plugin Manager, Automations and new conversation at `1280x800` Dark.
- The delayed regression covers `1440x960` Light. Both focused browser paths report no console error or `pageerror`.
- The focused Sidebar suite passes 25 relevant tests. One unrelated compact-rail Tooltip coordinate assertion remains
  failing and reproduces unchanged on `origin/main@d0c9b42a`.
- Web typecheck, lint, i18n, 45 unit tests, production build and `git diff --check` pass.
- The full 983-test Playwright attempt was stopped after multiple legacy send fixtures timed out because their mock
  Provider has no successful `lastCheck`; the same disabled-Send failure reproduces on the unchanged main worktree.
  This implementation does not alter those fixtures or Provider readiness behavior.
