# Computer Use Hardening

## Status

Status: design approved; hardening slice in implementation
Owner: Desktop / Computer Use
Last verified: 2026-10-26

## Background and competitive reference

MiniMax ships stable Computer Use on macOS + Windows; Codex Desktop added
computer control across apps in April 2026. Ling has the architectural pieces
(Computer Use PiP capture window, bundled CUA driver, lock-aware tool
revocation) but `docs/design/implementation-status.md` records open gates:
signing/TCC acceptance on macOS, Windows acceptance, driver robustness. The
user-visible symptom is not missing features — it is *untrustworthy behavior*:
lost focus, stuck capture, silent failures.

## Goal

Not new capabilities: make the existing surface deterministic and observable
enough to leave alpha. Concretely, this roadmap slice ships the four
highest-friction hardening items below; remaining OS-acceptance gates
(signing, TCC prompts) stay with the desktop packaging track.

## Hardening slice

### 1. Session state machine, externally observable

The coordinator currently juggles grants/sources implicitly. Introduce an
explicit per-session state machine in contracts
(`idle → capturing → controlled → paused → revoked → closed`) surfaced by:
- the settings Computer Control card (current sessions + state + owner),
- a `computer_use_session` tool-evidence block in transcripts so the user sees
  *why* control started/stopped.

### 2. Watchdog and auto-revoke

A heartbeat between PiP capture and driver: if the agent's control stream
stalls > N seconds or the user locks the screen (existing
`locked-computer-control` integration), the session auto-transitions to
`revoked`, captures stop, and a governance notification is emitted. Previously
this relied on the user noticing; now it is guaranteed and reported.

### 3. Failure taxonomy

Driver errors today surface as opaque failures. Define a closed error set
(`permission_denied`, `screen_locked`, `display_changed`, `driver_unavailable`,
`target_app_unresponsive`) in contracts; renderer maps each to a specific
recovery action (e.g. `display_changed` → "resume capture" button; TCC → open
System Settings deep link on macOS).

### 4. Test harness without real screens

Virtual display abstraction so the driver can be exercised in CI: inject a
fake capture source (synthetic frames) and a scripted input sink that records
injected events. This converts "needs a real desktop" acceptance into repeatable
unit tests — the precondition for ever closing the packaged acceptance gates.

### Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| CUA driver IPC | additive | Heartbeat + state events are new message kinds; driver ignores unknown kinds (versioned handshake already present via capability negotiation). |
| Locked-computer-control | reused | Lock detection becomes one watchdog input, not a parallel path. |
| Settings card | extended | Same panel gains session list; no new settings section. |
| Approvals | unchanged | Control grants remain approval-gated as today. |

### Incompatible-case upgrade path

State machine is additive to contracts; sessions persisted across restarts are
closed as `revoked` on load (crash semantics), so no stored-state migration.
If the driver protocol needs a breaking change, the capability handshake
version gates it — old drivers get `driver_unavailable` with an upgrade hint
instead of silent misbehavior.

## Implementation plan

1. Contracts: session states, error taxonomy, watchdog events.
2. Desktop coordinator: state machine refactor, heartbeat watchdog, auto-revoke
   emission, error mapping.
3. Renderer: settings session list, transcript evidence block, per-error
   recovery actions.
4. Test harness: fake source + scripted sink; driver tests run headless in CI.
5. Tests: state machine transitions (unit), watchdog stall → revoke (unit),
   Playwright spec for settings session list with mocked bridge, screenshots.

## Acceptance

- Forced stall (simulated) auto-revokes within the watchdog window and shows
  the governance notification (unit test).
- Each error taxonomy member maps to its recovery action (unit test).
- Virtual-display driver suite passes headless on CI (Windows dev machine).
