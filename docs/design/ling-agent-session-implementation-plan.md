# Ling Agent Session Implementation Plan

Status: active implementation plan
Owner: Ling Agent control plane and conversation maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Ling Agent Session](ling-agent-session.md)
- [Ling Agent Terminal Report Protocol](ling-agent-terminal-report-protocol.md)
- [Channel Team Operating System](channel-team-operating-system.md)

The contracts own identity, routing, report and conversation semantics. This plan tracks
only the remaining control-plane closure.

## Current Baseline

Initial P1-P6 slices provide:

- built-in Ling Agent identity and deterministic visible-message projection;
- active-session ordering and durable queued guidance;
- terminal report projection over real workflow/run evidence;
- permission and model-readiness integration;
- bounded execution through existing tasks, runs, approvals and tools;
- shared Web conversation presentation and focused acceptance coverage.

## Remaining Work

### Durable Identity

- Finish restart-safe identity and active-session resolution across channel, normal and
  teammate conversation scopes.
- Reject stale coordinator results after object, thread or workspace changes.
- Keep the built-in Ling Agent distinct from user-created teammates.

### Instruction Ownership

- Define one durable owner for queued, edited, cancelled and consumed instructions.
- Keep visible user messages aligned with executable continuation records.
- Preserve attachments, links and workspace refs without duplicating Composer state.

### Report Ownership

- Ensure terminal reports are deterministic projections of durable events and artifacts.
- Keep participant, evidence, approval and failure fields attributable and redacted.
- Prevent assistant prose from becoming a second source of truth for completion.

### Execution Decisions

- Close remaining boundaries between conversational replies, executable requests and
  documentation-only answers.
- Preserve explicit model, tool, skill and approval preflight before work starts.
- Keep multi-agent execution behind the existing orchestrator and authority model.

## Invariants

- One visible coordinator voice owns the ordinary channel transcript.
- Observer and background participants do not create competing visible replies.
- Ling Agent does not gain permissions from prompt text, memory or skill content.
- Browser state is a projection, never session authority.
- Failures remain attached to the object and action that produced them.

## Verification

- Core and daemon tests cover ordering, identity, continuation, terminal projection and
  restart recovery.
- Web E2E covers channel/normal/private parity, model and permission blocking, queued
  guidance, final reports and stale response rejection.
- Security fixtures cover scope isolation, redaction and approval enforcement.

## Closure

When durable identity, instruction, report and execution ownership are closed, merge the
rules into the owning contracts and delete this plan.
