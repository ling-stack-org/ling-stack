# Conversation Surface Contract Implementation Plan

Status: active implementation plan
Owner: conversation UI package and product-surface maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)

The contracts own product behavior. This plan tracks only the remaining shared-package
and consumption work.

## Current Baseline

- Shared conversation primitives and view models exist.
- Channel, normal conversation and teammate private chat reuse shared message, feedback,
  permission, avatar, source and Composer foundations.
- Compact work presentation and focused regression coverage are present.
- Core-only package extraction has started without moving API, routing or persistence into
  the presentation package.
- Cross-surface synchronization keeps normal conversation avatar-free, shares model blocker
  and drag/drop behavior, projects approvals and interventions, carries structured file
  references, and keeps active-run follow-ups in the original conversation thread.

## Completed Synchronization Slice

- Normal conversation, channel and private chat use policy-owned avatar visibility and
  shared ordinary-message geometry; normal conversation keeps both avatar flags disabled.
- Normal conversation and private WorkCells consume real associated approvals.
- Active normal-conversation messages reuse `queue_followup`, appear immediately as one
  ordinary user message and do not expose queue-specific chrome.
- Tool, approval, artifact and intervention events invalidate selected conversation detail
  through existing SSE/control-plane streams without idle polling.
- Channel-only teammate routing, topic replies, goals, plans and multi-agent activity remain
  channel-only.

## Remaining Work

### WorkCell Boundary

- Finish the shared WorkCell shell and typed operation/result projections.
- Keep run, approval and artifact state in existing domains; the package receives view
  models and callbacks only.
- Preserve quiet normal messages and persistent warning/approval surfaces.

### Evidence And Attachments

- Consolidate source, artifact, diff and command evidence into shared typed projections.
- Finish attachment rendering, failure and recovery states without exposing raw payloads.
- Keep large content lazy and cancellable; stale hydration cannot replace newer content.

### Package CSS

- Move only component-owned selectors into the shared package.
- Keep page geometry and product-specific layout in the consuming application.
- Remove compatibility selectors only after every production consumer and test is migrated.

### Desktop Consumption

- Let Desktop renderers consume the same primitives, tokens and state semantics through
  typed adapters.
- Do not move Electron IPC, window lifecycle or media ownership into the UI package.
- Verify compact windows independently from full AppShell geometry.

## Module Boundaries

```text
@ling-stack/conversation-ui-core
  -> framework-neutral types, parsing and view-model helpers

@ling-stack/conversation-ui-react
  -> React presentation over ui-react primitives

apps/web and Desktop renderers
  -> API, i18n, routing, domain state and product geometry
```

No shared package may own daemon requests, storage, permission decisions or route state.

## Verification

- Unit tests cover view-model normalization, long content and stale response rejection.
- Web E2E covers all three conversation surfaces, keyboard behavior, Light/Dark and error
  ownership.
- Desktop focused tests cover compact consumption and theme/locale propagation.
- Package extraction must not weaken existing run, approval or artifact assertions.

## Closure

Close after WorkCell, evidence, attachment, package CSS and Desktop consumption boundaries
are complete. Merge durable rules into the owning contracts and delete this plan.
