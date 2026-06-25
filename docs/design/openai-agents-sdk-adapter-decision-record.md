# OpenAI Agents SDK Adapter Decision Record

## Status

Deferred design record. Do not implement until the short-term runtime hardening slices
have landed and passed conformance.

## Verdict

- Integration type: future dedicated runner adapter or sandbox-backed sidecar, not a
  provider preset and not the default Ling runner.
- Candidate runner id: none yet. Reserve `openai-agents-sdk` only after a concrete sidecar
  protocol exists.
- Current default runner: `pi`.
- Confidence: medium. The product boundary is clear, but the exact SDK transport and
  sandbox API shape may change.

## Why This Exists

OpenAI Agents SDK can run agent sessions with tools, handoffs, tracing, approvals, and
sandboxed workspaces. Those primitives map well to Ling's runtime pattern contracts, but
they are not a replacement for Ling's product state.

Ling owns:

- workspace, task, thread, workflow, work unit, and attempt state;
- approval policy and approval checkpoints;
- artifact import, redaction, and audit evidence;
- runner selection, fallback, and conformance;
- teammate memory and channel delivery.

The SDK may own an opaque backend session inside an adapter. It must not become the source
of truth for Ling work.

## Decision Boundary

```text
Ling task / workflow step
  -> RunnerRegistry
    -> future openai-agents-sdk adapter
      -> SDK sidecar session / sandbox / tools
      -> normalized Ling events
  -> Ling approvals / artifacts / traces / audit
```

This adapter is allowed to improve execution fidelity, sandbox setup, and resume behavior.
It is not allowed to bypass Ling approval policy, mutate Ling workflow state directly, or
store raw SDK run state as public evidence.

## Prerequisites

The adapter cannot start until these short-term slices are done:

1. P14 platform-native sandbox policy and evidence:
   - policy profiles exist as product-level settings;
   - unsupported hosts fail closed;
   - evidence proves read/write/network/artifact/secret behavior;
   - readiness never grants execution permission by itself.
2. P15 runner hydration defaulting and observability:
   - hydration decisions are visible in run diagnostics;
   - policy and budget denials are model-visible;
   - hydrated schemas remain runner-only DTOs;
   - disabling hydration returns to existing behavior.
3. Runner conformance already covers:
   - approval before side effect;
   - denial blocks execution;
   - cancellation and stale completion;
   - workspace boundary rejection;
   - artifact import and secret redaction.

## Required Gates

Before any SDK-backed runner is selectable:

- Feature flag: disabled by default and workspace-scoped.
- Readiness probe: confirms endpoint or sidecar launch, SDK version, required tools, and
  sandbox support.
- Capability negotiation: reports session lifecycle, text streaming, tool events,
  approval interception, artifacts, cancellation, workspace boundary, and native resume.
- Conformance: passes the shared runner suite with SDK-specific fault injection.
- Approval bridge: proves every side-effecting tool pauses before execution.
- Workspace boundary: proves file and shell actions stay inside the bound workspace or
  imported artifact roots.
- Artifact import: copies SDK outputs into Ling artifact roots and redacts before exposure.
- Secret handling: injects only secret refs; no raw provider secrets, bearer tokens, or
  resume tokens in traces, snapshots, manifests, or artifacts.

## Non-Goals

- Do not replace Pi as the default runner.
- Do not import Python Agents SDK into the main TypeScript daemon process.
- Do not enable hosted OpenAI sandbox providers by default.
- Do not treat OpenAI model provider presets as runner adapters.
- Do not persist raw SDK `RunState` as Ling state.
- Do not expose SDK memory/session state as Ling teammate memory.

## PR-Sized Future Slices

### M0: SDK Adapter Decision Refresh

- Re-check the current SDK transport, sandbox, and approval APIs.
- Decide whether the adapter is a local sidecar, a hosted sandbox bridge, or rejected.
- Update this record with exact API evidence before code starts.

### M1: Fake SDK Sidecar Harness

- Add a fake sidecar that mimics SDK session, tool, approval, artifact, cancel, and resume
  behavior.
- Run the shared conformance suite against the fake sidecar first.
- Acceptance: no real SDK dependency is needed to prove Ling's adapter boundary.

### M2: Experimental SDK Adapter

- Add an adapter behind `runners.openaiAgentsSdk.enabled`.
- Normalize SDK events into Ling run events.
- Route approval, artifact, workspace, and hydration decisions through Ling.
- Acceptance: selecting the adapter without gates fails closed; enabling it for an
  experimental workspace requires explicit config and passing conformance.

### M3: Sandbox Provider Decision

- Decide separately whether to use SDK-managed hosted sandboxes.
- Acceptance: hosted sandbox remains disabled unless artifact import, network policy,
  cost policy, and data residency constraints are explicit.

## Rollback

The adapter must be removable without affecting Pi:

- disable `runners.openaiAgentsSdk.enabled`;
- keep existing Pi runner behavior and prompt path;
- keep Ling trace, approval, handoff, hydration, and sandbox read models;
- discard opaque SDK session handles after expiry;
- preserve imported artifacts and audit records as Ling-owned evidence.
