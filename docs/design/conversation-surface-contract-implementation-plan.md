# Conversation Surface Contract Implementation Plan

Status: active implementation plan
Owner: conversation UI package and product-surface maintainers
Last verified: 2026-08-05

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
- Shared message bodies use stable 15px/550 strong text from the first pending frame;
  the 13px pending spinner uses a shared 5px first-line offset.
- Channel optimistic sends retain one virtual render identity through acknowledgement and
  reply start. A measured tail observer follows once per frame only while the user remains
  at latest, and virtual `paddingEnd` owns the 38px Composer clearance.
- Channel, normal conversation and teammate private chat use one pending-asset component.
  Attachments and links stay in one non-wrapping row with internal horizontal scrolling.
- Successful text-only chat runs stay quiet. WorkCell remains for tools, approvals,
  artifacts, durable changes/risks and failed or approval-blocked runs.
- Final assistant text from `message_end` is persisted as a fallback when a compatible
  provider emits no text deltas; fully empty chat output becomes a localized message-level
  failure. Provider checks also reject successful HTTP responses with no displayable text
  as `empty_response`.
- Ordinary channel replies now execute as standard `RunSession` records. Their
  `channel_ai_reply` WorkUnit is only the supervision projection linked to that run and
  message; guidance reuses the existing `RunIntervention`, cancellation and continuation
  paths. One active teammate reply is selected automatically, while concurrent replies
  require an explicit "Guide whom" selection. No second guidance queue or table is added.
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
- Finish sent-attachment rendering, failure and recovery states without exposing raw
  payloads. Pending Composer previews are already shared across all three Web surfaces.
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
