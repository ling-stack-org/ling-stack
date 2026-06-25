# External Agent Runner Adapters Implementation Plan

## Purpose

This document breaks the future Codex app-server, OpenClaw/ACP, Hermes, and other
external-agent runner work into small implementation slices. It extends
[Runner Adapters](runner-adapters.md) without changing the current runtime boundary:

- Pi remains the only enabled runner today.
- OpenAI, Claude, Gemini, and compatible model endpoints remain provider presets when
  Ling only needs a model API.
- External agent runtimes become runner adapters only after they expose sessions, tool
  events, artifacts, cancellation, approval semantics, and resume handles.

## Open-Source Patterns To Borrow

Borrow these patterns, not the whole implementation:

- ACP protocol implementations negotiate protocol version and capabilities before using
  optional messages. Ling should not infer compatibility from package versions alone.
- OpenClaw treats ACP as an explicit external-harness path. It requires backend plugin
  setup, allowlist policy, and `/acp doctor` before using ACP agents.
- OpenClaw documents separate routes for native Codex configuration and ACP harnesses.
  Ling should keep `codex-app-server` dedicated unless a Codex target is explicitly ACP.
- Hermes exposes multiple integration surfaces: ACP for editor-native clients, TUI
  gateway JSON-RPC for custom hosts that need full Hermes features, and an
  OpenAI-compatible API server for model-like clients.
- Hermes ACP maps internal tools into editor-facing tool kinds and keeps the exposed tool
  surface curated. Ling should do the same for external runners.
- OpenAI Agents SDK should stay a deferred dedicated-adapter decision until Ling's own
  sandbox policy and hydration observability gates are implemented. Treat SDK primitives as
  pattern inputs first; implement a sidecar only after conformance can prove the boundary.

References:

- [Agent Client Protocol](https://agentclientprotocol.com/)
- [OpenClaw ACP Agents](https://docs.openclaw.ai/tools/acp-agents)
- [OpenClaw Agent Runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)
- [Hermes ACP Editor Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [Hermes Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)

## Non-Goals

- Do not implement real ACP, Codex app-server, or Hermes adapters in the registry slice.
- Do not add runner ids for plain model providers such as `claude`, `gemini`, or `openai`.
- Do not expose Ling secrets, MCP tools, or workspace write access directly to external
  agents.
- Do not let external runtime session state become the source of truth for Ling work
  units, attempts, approvals, artifacts, or teammate memory.

## Module Shape

Keep the implementation modular. Adapter-specific code should not accumulate in
`packages/daemon/src/index.ts`, server route handlers, or the generic runner registry.

Recommended daemon layout:

```text
packages/daemon/src/runtime/
  runners.ts                         existing registry and resolution
  runner-readiness.ts                shared readiness/doctor contracts
  runner-conformance.ts              shared adapter conformance helpers
  external-agent/
    session-handles.ts               opaque backend session metadata
    event-normalizer.ts              backend event -> Ling event mapping
    approval-bridge.ts               side-effect proposal -> Ling approval request
    artifact-importer.ts             remote/local artifact import + redaction
    workspace-boundary.ts            cwd/path/tool boundary checks
    tool-surface.ts                  curated tool exposure and MCP bridge policy
  acp/
    protocol.ts                      ACP wire types used by Ling
    client.ts                        process/http client lifecycle
    capabilities.ts                  capability negotiation and policy decisions
    doctor.ts                        ACP endpoint readiness checks
    fake-server.ts                   test-only conformance harness
  adapters/
    codex-app-server.ts              dedicated Codex app-server adapter
    openclaw-acp.ts                  OpenClaw via ACP client bridge
    hermes-decision.ts               decision record helpers, no runner until chosen
```

Recommended contract package additions only when the daemon API needs to expose them:

```text
packages/contracts/src/
  runtime.ts                         existing runner status fields
  runner-readiness.ts                readiness result schema if exposed over HTTP
```

Recommended web additions only after readiness data exists:

```text
apps/web/src/features/settings/
  RunnerReadinessPanel.tsx           disabled reason, doctor result, conformance status
```

## Interface Sketch

These snippets are design-level interfaces. Use the existing `RunnerAdapter` and
`RegisteredRunner` names when implementing; do not create a parallel runner abstraction.

```ts
export type RunnerReadinessStatus = "ready" | "blocked" | "degraded" | "unknown";

export interface RunnerReadinessReport {
  readonly runnerId: string;
  readonly status: RunnerReadinessStatus;
  readonly checkedAt: string;
  readonly featureFlagEnabled: boolean;
  readonly conformancePassed: boolean;
  readonly endpointReachable?: boolean;
  readonly capabilityNegotiated?: boolean;
  readonly blockingReasons: readonly RunnerReadinessBlocker[];
}

export interface RunnerReadinessBlocker {
  readonly code:
    | "feature_flag_disabled"
    | "missing_endpoint"
    | "endpoint_unreachable"
    | "missing_capability_negotiation"
    | "conformance_not_passed"
    | "tool_surface_not_curated"
    | "approval_bridge_not_verified"
    | "workspace_boundary_not_verified";
  readonly message: string;
}
```

```ts
export interface ExternalAgentSessionHandle {
  readonly runnerId: string;
  readonly backend: "codex-app-server" | "openclaw-acp" | "hermes-acp" | "custom";
  readonly backendSessionId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}
```

```ts
export interface ExternalToolProposal {
  readonly backendToolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly sideEffect:
    | "none"
    | "workspace_read"
    | "workspace_write"
    | "shell"
    | "network"
    | "provider_or_secret"
    | "external_delivery";
}
```

## Readiness And Selection Rules

A future runner can be shown in Settings while disabled, but it cannot be selected until
all selection gates pass:

1. feature flag is enabled;
2. endpoint or launch command is configured;
3. doctor/readiness probe succeeds;
4. protocol/capability negotiation succeeds;
5. runner conformance suite passes;
6. approval bridge is verified for side-effectful tools;
7. workspace boundary enforcement is verified;
8. artifacts are imported into Ling artifact roots, not trusted by remote path alone.

If any gate fails, `RunnerRegistry.resolve` must still fail closed or fall back according
to the existing explicit/implicit fallback policy.

## Tool Surface Policy

External agent runners receive a curated tool surface. They do not receive raw Ling
internals.

| Capability | Default | Requirement before enabling |
| --- | --- | --- |
| workspace read | allowed after path-boundary check | file reads must stay under bound workspace roots |
| workspace write | disabled | approval bridge, patch preview, and post-write evidence |
| shell | disabled | runtime permission request and command evidence |
| MCP tools | disabled | explicit MCP bridge allowlist and per-tool approval profile |
| provider secret access | forbidden | external agent must never receive raw secret values |
| external message delivery | forbidden | delivery stays owned by Ling channels/automations |
| memory/persona mutation | forbidden | external memory can return candidates only |

## Adapter-Specific Decisions

### Codex app-server

Use a dedicated adapter when Ling talks to a Codex server that exposes native Codex
session, stream, approval, and artifact semantics. Do not route this through ACP unless
the selected Codex target explicitly speaks ACP and loses no required Ling controls.

### OpenAI Agents SDK

OpenAI Agents SDK is not a provider preset and is not the current default runner. It may
become a dedicated adapter only if Ling wraps it behind a sidecar or equivalent boundary
that exposes session lifecycle, tool events, approval interception, artifacts,
cancellation, workspace constraints, and resume handles.

The design record is [OpenAI Agents SDK Adapter Decision Record](openai-agents-sdk-adapter-decision-record.md).
Do not add a runner id until that record is refreshed against current SDK APIs and the
short-term runtime hardening slices have landed.

### OpenClaw ACP

Use `openclaw-acp` when OpenClaw exposes an ACP-compatible endpoint and can report
capabilities before execution. The adapter is a client bridge:

```text
Ling run -> RunnerRegistry -> openclaw-acp adapter -> ACP client -> OpenClaw session
```

OpenClaw must not directly mutate Ling work state, provider secrets, teammate memory, or
channel delivery.

### Hermes

Hermes should stay out of the runner registry until the integration surface is chosen:

- context/memory overlay only: no runner id;
- ACP server: possible ACP runner target with editor-style tool/event semantics;
- TUI gateway JSON-RPC: possible dedicated adapter if Ling needs full Hermes features;
- OpenAI-compatible API server: provider-like path, not runner execution.

Create a decision record before adding any Hermes runner id.

## External Runtime Decision Record Template

Use this template before adding any non-Pi runner id or adapter module:

```md
# External Runtime Decision: <runtime-name>

## Verdict

- Integration type: provider preset | dedicated runner adapter | ACP runner target |
  context/memory only | rejected
- Runner id, if any: <id or none>
- Confidence: high | medium | low | unknown

## Evidence

- Runtime surface: model API | ACP endpoint | JSON-RPC gateway | local CLI | HTTP server
- Session lifecycle: none | opaque session id | resumable session | unknown
- Tool lifecycle: none | stream-only | proposed-before-side-effect | side-effect-after-fact
- Artifact lifecycle: none | remote paths | importable artifacts | unknown
- Cancellation: none | best-effort | confirmed | unknown
- Approval interception: none | partial | confirmed | unknown
- Workspace boundary: none | configured | enforced by runtime | enforced by Ling adapter

## Decision Boundary

- Why this is not just a provider preset:
- Why ACP is or is not the right bridge:
- Which Ling controls must remain authoritative:

## Required Gates

- Feature flag:
- Readiness/doctor probe:
- Conformance tests:
- Approval bridge tests:
- Workspace boundary tests:
- Artifact import/redaction tests:

## Rejected Options

- Option:
- Reason rejected:
```

## PR-Sized Slices

### P0: Design And Decision Records

- Add this implementation plan.
- Add a short decision record template for future external agent runtimes.
- Acceptance: docs clearly separate provider presets, dedicated adapters, and ACP
  harnesses.

### P1: Shared Readiness Contracts

- Add `RunnerReadinessReport` schema and daemon-only readiness service.
- Add disabled runner readiness to `/runners` or a new `/runners/:id/readiness` route.
- Acceptance: disabled future runners report why they are blocked without becoming
  selectable.

### P2: Conformance Harness Extraction

- Move reusable checks from `runner-conformance.test.mjs` into a helper that adapter tests
  can reuse.
- Add fixtures for capability negotiation, side-effect approval, cancellation, artifact
  import, and secret redaction.
- Acceptance: Pi-compatible fake runner and future fake external runner can run the same
  conformance suite.

### P3: ACP Client Skeleton And Fake Server

- Add ACP protocol type subset, client lifecycle, and fake ACP server for tests.
- Implement initialization/capability negotiation only; no real OpenClaw dependency.
- Acceptance: fake ACP endpoint can pass readiness and fail closed when capabilities are
  missing.

### P4: External Agent Bridges

- Add shared `approval-bridge`, `artifact-importer`, `workspace-boundary`, and
  `tool-surface` modules.
- Acceptance: fake external runner cannot perform unapproved side effects and cannot
  expose raw secrets in events or artifacts.

### P5: OpenClaw ACP Adapter Behind Feature Flag

- Implement `openclaw-acp` using the shared ACP client and bridges.
- Keep it disabled unless feature flag, endpoint, readiness, and conformance all pass.
- Acceptance: selecting `openclaw-acp` without passing gates fails closed; selecting it
  after fake conformance executes through normalized runner events.

### P6: Codex App-Server Adapter Behind Feature Flag

- Implement dedicated `codex-app-server` adapter separately from ACP.
- Reuse the shared readiness, approval, artifact, and conformance modules.
- Acceptance: Codex-specific code stays in its adapter module; registry and routes stay
  generic.

### P7: Hermes Decision Slice

- Write a Hermes decision record choosing context-only, ACP, TUI gateway JSON-RPC, or
  provider-like API server.
- Do not implement a Hermes runner until the decision states which Ling controls are
  preserved.
- Acceptance: no `hermes` runner id exists without a concrete session protocol and
  conformance plan.

### P8: Deferred OpenAI Agents SDK Decision Refresh

- Re-check the current SDK transport, sandbox, approval, snapshot, and tool APIs.
- Decide whether Ling should build a local sidecar, use a hosted sandbox bridge, or reject
  SDK integration for the current cycle.
- Acceptance: the decision record names the exact integration surface and required gates;
  no runtime code is added in this slice.

## Implementation Guardrails

- Keep each adapter behind a feature flag and a conformance gate.
- Keep registry code generic; adapter-specific readiness belongs in adapter modules.
- Keep approval, artifact import, workspace boundary, and tool-surface policy shared.
- Prefer fake server tests before wiring a real external process.
- Treat external logs and artifacts as untrusted evidence until imported and redacted.
- Never silently promote external memory/persona/session state into Ling teammate memory.
