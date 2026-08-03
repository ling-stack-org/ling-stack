# Runtime Control Plane Roadmap

## Purpose

Ling Stack is gradually growing a local runtime control plane. The direction is similar
to the role Codex app-server plays for Codex clients, but Ling should not clone Codex
app-server wholesale or migrate to its JSON-RPC protocol just to match the shape.

The control plane should emerge from concrete Ling pressure:

- reliable daemon lifecycle and local diagnostics;
- shared run state for Web, CLI, desktop, and future clients;
- durable run events, approvals, artifacts, and recovery;
- skill, teammate, memory, provider, tool, MCP, and runner registries;
- background jobs such as memory consolidation and reflection;
- future adapter support for Codex app-server or other external execution backends.

The implementation-level object model, API contract, event payload rules, and first
contract-tightening slices live in
[Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md).

## Current Position

The daemon remains Ling's product control plane. It owns workspace state, run
orchestration, approvals, provider preflight, runner selection, event persistence,
memory policy, and client-facing HTTP/SSE APIs.

Codex app-server is a reference architecture and a possible future runner backend, not
the current source of truth. Existing documents already reserve `codex-app-server` as a
disabled future runner adapter behind conformance and feature flags.

The old short/mid/long implementation files are consolidated here. Current status:

- operator lifecycle, restart/doctor foundations and several skill/template refresh paths already exist but require
  code-level status verification before being called a closed phase;
- daemon-owned state, snapshots and bounded events are the active medium-term direction;
- app-server-like processors, registry broker and alternate transports are long-term entry-criteria work only;
- no phase authorizes replacing HTTP/SSE, Pi, approval policy or the durable run/audit stores by default.

New runtime-control work updates this roadmap and the detailed design instead of creating another phase plan.

## What To Borrow From Codex

Borrow the internal separation where Ling has the same pressure:

- thin client entrypoints over a long-lived local daemon;
- explicit initialize or readiness gates before serving mutating requests;
- request processors separated from transport and presentation;
- bounded event delivery for slow or reconnecting clients;
- serialization scopes for state that must not race;
- stable check-row diagnostics and read-only doctor reports;
- dynamic capability registries for skills, tools, MCP servers, and plugins;
- clear distinction between persisted config, runtime status, and auth/secret state.

Do not borrow by default:

- a wholesale app-server JSON-RPC migration;
- Codex's single-agent thread assumptions;
- hidden approval bypasses for CLI convenience;
- a second state model that competes with Ling's run store and audit model.

## Phased Roadmap

### Phase 0: Keep The HTTP Daemon, Harden The Operator Loop

This phase is represented by the CLI and daemon lifecycle designs. New operator-loop work
is tracked directly in this roadmap.

- Keep the existing daemon HTTP/SSE API.
- Add robust daemon `start`, `status`, `stop`, `restart`, and `logs` behavior.
- Make `doctor` a read-only check-row report that can explain daemon, workspace,
  provider, keychain, MCP, SQLite, and web readiness without mutating state.
- Keep CLI output contracts stable: JSONL-only stdout for machine output, human progress
  on stderr, and explicit final-message output support.

### Phase 1: Runtime Control Plane Boundaries

Make the daemon boundary explicit before adding heavier transport.
The mid-term implementation details live in
[Runtime Control Plane Mid-Term Implementation Plan](./runtime-control-plane-detailed-design.md).

- Treat the daemon as the only owner of active runs, work units, leases, approvals, and
  memory review state.
- Keep Web, CLI, and desktop as replaceable clients over shared API contracts.
- Keep runner adapters behind the `RunnerRegistry` with capability checks,
  conformance tests, and audit metadata.
- Preserve fallback behavior: Pi remains the default runner until another backend passes
  conformance and explicit enablement.

### Phase 2: Registry Refresh And Overlay Semantics

Move mutable capability surfaces toward runtime registries instead of one-time seeding.

- Skills should be discovered from built-ins, imported packs, future local files, and
  plugins through an effective registry.
- Built-in teammate templates should behave as template defaults plus durable user
  overrides, not as seed-once records that drift forever.
- When a built-in template gains a default skill, existing built-in teammates should
  backfill the missing template binding unless the user has explicitly overridden that
  skill.
- Preserve user choices:
  - disabled template bindings stay disabled;
  - custom skill bindings stay present;
  - removed or tombstoned teammates are not recreated;
  - active runs keep the snapshot they started with.
- Add a lightweight skills registry refresh path before considering a broader protocol
  migration.

### Phase 3: Background Jobs And Continuation

Add long-lived runtime work without turning it into hidden prompt mutation.

- Memory Consolidation Jobs and Reflection Jobs produce reviewable memory candidates,
  with source refs, reason, confidence, review state, and audit visibility.
- Jobs must not silently mutate persona, grant tools, approve actions, access secrets,
  or leak raw cross-channel context.
- Run Interruption and Continuation should remain explicit:
  - queue a follow-up after the current run;
  - or cancel and redirect with preserved partial events, artifacts, and lineage.
- Do not inject new user prompts into an active runner session as a hidden mid-run prompt.

### Phase 4: Codex App-Server Adapter

Only after the control-plane contracts are stable, implement Codex app-server as an
optional runner backend.
The adapter design lives in [Runner Adapters](runner-adapters.md), and the broader
long-term control-plane layering remains in this roadmap and the detailed design.

- Keep it behind `runners.codexAppServer.enabled`.
- Require health probes, capability negotiation, conformance tests, approval bridge,
  streaming adapter, abort propagation, and resume handle mapping.
- Keep Ling's run store, approval policy, memory policy, and audit events as the product
  source of truth.
- Do not expose the adapter in user-facing pickers until it passes conformance and
  fail-closed behavior is verified.

### Phase 5: Transport Evolution If Needed

If Web, CLI, desktop, external workers, and background jobs create real pressure on the
HTTP/SSE API, introduce app-server-like transport concepts incrementally.

- Add initialize gates and client capability negotiation.
- Add request queues and backpressure for slow clients.
- Add subscription scopes for run, workspace, registry, and job events.
- Add versioned protocol envelopes only where the current HTTP/SSE contracts are a
  proven bottleneck.

This phase should be driven by observed concurrency, reconnect, and multi-client
problems, not by visual similarity to Codex app-server.

## Design Rule

Ling should keep growing toward a Codex app-server-like local control plane, but each
step must preserve Ling's own product boundaries:

- multi-teammate and channel-first, not single-agent only;
- durable audit and approval first;
- memory candidates and policy gates, not silent memory mutation;
- capability-driven runners, providers, MCP, tools, and skills;
- local-first SQLite until distributed coordination is a real requirement.
