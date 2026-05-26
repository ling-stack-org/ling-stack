# Architecture Decision Records

Use this directory for decisions that change Ling Stack's long-term architecture,
public contracts, storage model, plugin boundaries, security policy, or state-machine
semantics.

An ADR is required when a change affects any of these areas:

- Package boundaries.
- API contracts or shared schemas.
- Plugin manifests or extension host behavior.
- State machines, resource leases, approvals, or recovery behavior.
- Storage schema or migration strategy.
- Secrets handling and permission model.
- GitHub, Slack, Feishu, email, or other external automation side effects.
- Desktop, mobile, or web client contract compatibility.

Template:

```text
# ADR NNN: Title

## Status
Proposed | Accepted | Superseded

## Context
What problem forced the decision?

## Decision
What are we committing to?

## Consequences
What gets easier, harder, or blocked?

## Migration
How existing code moves to this decision.
```

Keep ADRs short, but make the tradeoff explicit. Design docs can explain the system in
detail; ADRs should preserve why a direction was chosen.
