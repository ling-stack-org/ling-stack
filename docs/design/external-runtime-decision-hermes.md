# External Runtime Decision: Hermes

## Verdict

- Integration type: decision deferred; no runner id in P7
- Runner id, if any: none
- Confidence: medium

Hermes should not enter the Ling runner registry until Ling has evidence for a concrete
session protocol and can prove the same gates used by the OpenClaw ACP and Codex
app-server adapters. For now, Hermes may be evaluated as a context or memory overlay, but
not as an execution runner.

## Evidence

- Runtime surface: multiple possible surfaces, including ACP, TUI gateway JSON-RPC, and
  an OpenAI-compatible API server.
- Session lifecycle: not accepted for Ling runner execution until the chosen surface
  proves resumable or opaque-session semantics.
- Tool lifecycle: not accepted until side-effect proposals are available before the
  external runtime mutates workspace state.
- Artifact lifecycle: not accepted until artifacts can be imported into Ling-owned
  artifact roots with redaction.
- Cancellation: not accepted until cancellation is confirmed by conformance.
- Approval interception: not accepted until Ling approval bridge tests pass.
- Workspace boundary: Ling adapter must enforce the boundary even if Hermes also has its
  own workspace configuration.

## Decision Boundary

- Why this is not just a provider preset: a Hermes runner would need session, tool,
  approval, artifact, and cancellation semantics. If only model completion is needed, it
  belongs in the provider path instead.
- Why ACP is or is not the right bridge: ACP may be viable if Hermes exposes all required
  Ling controls through ACP. If Ling needs Hermes-specific features not represented in
  ACP, a dedicated TUI gateway JSON-RPC adapter must be considered separately.
- Which Ling controls must remain authoritative: work units, attempts, approvals,
  artifacts, teammate memory, provider secrets, external delivery, and workspace
  boundaries.

## Required Gates

- Feature flag: disabled by default; no flag is added in P7.
- Readiness/doctor probe: must prove endpoint reachability and protocol compatibility.
- Conformance tests: must pass shared lifecycle, cancellation, approval, redaction,
  artifact import, and workspace boundary cases.
- Approval bridge tests: must prove side effects are proposed before execution and denied
  actions fail closed.
- Workspace boundary tests: must reject paths outside Ling workspace roots.
- Artifact import/redaction tests: must import only into Ling artifact roots and redact
  forbidden values.

## Rejected Options

- Option: add a Hermes runner id now.
- Reason rejected: P7 has no chosen session protocol or conformance evidence.

- Option: treat Hermes OpenAI-compatible API as a runner.
- Reason rejected: model-compatible APIs are provider presets, not Ling runner execution.

- Option: route Hermes through ACP unconditionally.
- Reason rejected: ACP is only acceptable if it preserves Ling approval, artifact,
  cancellation, and workspace controls without losing required semantics.
