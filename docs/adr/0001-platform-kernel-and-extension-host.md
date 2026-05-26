# ADR 0001: Platform Kernel and Extension Host

## Status

Accepted.

## Context

Ling Stack is moving from a local AI workspace prototype toward a long-term platform
that can support Web, desktop, CLI, future mobile or PWA clients, multi-channel
execution, AI teammates, skill packs, workflow orchestration, GitHub automation, and
multiple provider and runner implementations.

The main architectural risk is uncontrolled coupling. If the web app, daemon, provider
adapters, runner adapters, GitHub automation, and future plugins can all mutate state
directly, Ling Stack will become hard to maintain and unsafe under concurrency,
disconnects, retries, and external webhooks.

The opposite risk is over-engineering too early. A full external plugin marketplace,
distributed scheduler, and multi-process sandbox would slow down v0.1 before the local
product loop is stable.

## Decision

Ling Stack will use a platform-kernel architecture:

- The kernel owns durable state machines, resource leases, approvals, audit events,
  idempotency, policy, secrets access boundaries, and recovery rules.
- The daemon exposes the kernel through local APIs and starts recovery on boot.
- The channel coordinator handles run requests, queue/conflict decisions, lease
  acquisition, runner sessions, and terminal reconciliation.
- Extensions add capability through typed contracts, manifests, registries, and a future
  extension host.
- Extensions do not write durable state directly and do not bypass kernel transitions.
- Skills are workflow templates, not permissions.
- GitHub, Slack, Feishu, email, and similar integrations are channel source adapters and
  automation extensions, not separate product cores.

The first implementation may keep most kernel code inside `packages/core` while v0.1 is
stabilized. The target package split is documented in
[Platform Architecture](../design/platform-architecture.md), but it should be migrated
incrementally rather than in one large rewrite.

## Consequences

This makes the following easier:

- Web, desktop, CLI, and future mobile clients can share contracts and API behavior.
- Provider, runner, channel, skill, memory, and automation features can be added without
  rewriting the product core.
- GitHub automation can review PRs or triage bugs without bypassing approvals or branch
  protection.
- State recovery remains consistent when SSE disconnects, providers timeout, runners
  crash, or webhooks are delivered more than once.
- Security boundaries can be enforced in one place.

This makes the following harder:

- Feature work must respect kernel contracts instead of directly editing store rows.
- More type definitions and contract tests are required before extension APIs become
  stable.
- Some fast UI experiments need daemon or contract support before becoming durable
  features.

## Migration

Migration should happen in phases:

1. Keep `packages/core` as the temporary kernel while v0.1 stabilizes.
2. Split the web app into feature modules so UI does not keep growing inside one large
   component.
3. Extract shared contracts and API client code when web, CLI, daemon, and core start
   duplicating DTOs.
4. Add internal registries for provider, runner, channel source, skill pack, tool, and
   memory extensions before dynamic plugin loading.
5. Add GitHub automation as read-only review artifacts first, then approval-gated
   comments, then stricter actions such as request changes, approve, push, merge, and
   release.
6. Add a desktop shell over the same daemon and shared UI contracts.
7. Only after internal extension boundaries are stable, expose an external plugin SDK and
   stronger sandboxing.
