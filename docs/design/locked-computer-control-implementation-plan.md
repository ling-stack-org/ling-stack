# Lock-Aware Task Continuation Implementation Plan

## Status

**Scope:** macOS and Windows product code; macOS local verification; Windows real-machine
acceptance by the Windows owner.
**Decision:** tasks continue, Computer Control pauses, unlock triggers fresh readiness.
**Supersedes:** the persistent locked-control Switch and restricted locked-generation plan.

## Delivery outcome

- Lock/sleep never intentionally cancels the daemon or active non-visual task.
- Computer Control closes its gate and retires provider/lease generation on lock/sleep.
- Unlock/resume creates a fresh normal generation after full readiness.
- Settings documents the behavior and exposes no locked-control mutation.
- Negative macOS/Windows security probes remain evidence, not an enablement path.

## What already exists

| Capability | Current owner | Plan action |
|---|---|---|
| OS lock/sleep/unlock/resume events | `DesktopRuntime` | Reuse without new event layer |
| gate, input fence, lease/process cleanup | Cua Driver coordinator | Reuse and regression-test ordering |
| fresh generation recovery | Cua Driver coordinator | Reuse normal readiness path |
| daemon/run lifecycle | Desktop daemon/runtime | Prove it stays independent |
| bundled settings page | Web settings | Replace action UI with fixed explanation |
| macOS attended probe | Desktop scripts | Retain unsupported evidence |
| Windows denial harness | Desktop scripts/release handoff | Retain as defensive verification |

## Dependency order

```text
1. Scope reduction
      |
      +--> 2. Static Settings behavior
      +--> 3. Design/source-of-truth rewrite
      +--> 4. Runtime/task-continuation assertions
                    |
                    v
             5. Local validation and review
```

Sequential implementation is preferred because the cleanup, UI and docs all describe one
security boundary and should be reviewed as one diff.

## Slice 1 — Remove the persistent locked-control product surface

### Changes

- Revert `allowLockedComputerUse` from Desktop preferences.
- Revert `setLockedComputerControlEnabled` from Desktop capability, preload and IPC.
- Revert the proposed persistent `userOptIn` additions from contracts and daemon state.
- Remove renderer `/authorize` and `/revoke`; keep only the read-only locked-state
  projection. Any dormant compatibility mutation remains Desktop-bridge authenticated and
  packaged `disabled_by_build`.
- Revert automatic runtime-grant arming from the policy coordinator.
- Restore fixed `disabled_by_build` semantics.

### Exit criteria

- No persistent locked-control preference is stored.
- No Renderer command can turn locked control on.
- Existing Computer Use Stop and normal Computer Control On/Off behavior are unchanged.

## Slice 2 — Replace Settings with lock-aware guidance

### Changes

- Replace `LockedComputerControlSection` with `LockAwareComputerControlSection`.
- Render three fixed rows: task continuation, Computer Control pause, unlock recovery.
- Add Chinese translations.
- Add a source-contract test proving the component has no Switch, locked projection or
  authorization/revoke command.

### Exit criteria

- The Computer Control page contains no “Allow control while locked” action.
- The explanation remains visible whether normal Computer Control is On or Off.
- UI copy explicitly excludes lock/login/password/secure-desktop interaction.

## Slice 3 — Preserve evidence and normal provider compatibility

### Changes

- Retain the corrected Darwin session keys and unlocked missing-lock-field handling.
- Retain the disposable AppKit attended probe and content-free unsupported evidence.
- Retain the system-only macOS PATH required by embedded Cua Driver 0.8.3.
- Document that the probe cannot promote product capability.

### Exit criteria

- Native helper and probe compile on macOS arm64.
- Evidence validates as `unsupported / locked_control_input_unavailable`.
- Managed provider environment does not inherit a hostile caller PATH.

## Slice 4 — Harden runtime regression coverage

### Automated checks

- Desktop runtime receives lock, suspend, unlock and resume in order.
- `resume` before `unlock`, and `unlock` before `resume`, remain paused until both system
  boundaries clear.
- A lock that arrives during initial provider enable is latched and reasserted after enable;
  the candidate generation cannot remain published.
- Lock/suspend invokes only Computer Control suspension.
- Daemon start count stays one and stop count stays zero until Desktop shutdown.
- Provider gate closes before input fence, lease revoke and process cleanup.
- Unlock/session-active creates exactly one fresh generation.
- Relock during recovery tears down the candidate generation.
- Settings source contains no locked-control mutation.

### Attended checks

- No additional macOS lock test is required for this change; the retained negative evidence
  already rejects locked input.
- Windows owners verify ordinary pause/unlock recovery on Windows x64 before release. They do
  not need to prove locked input.

## Slice 5 — Validation and ship

Run the narrow checks first:

```bash
corepack pnpm --filter @ling-stack/desktop build
node --test apps/desktop/tests/desktop-runtime.test.mjs \
  apps/desktop/tests/cua-driver-coordinator.test.mjs \
  apps/desktop/tests/cua-driver-provider-host.test.mjs \
  apps/desktop/tests/locked-control-darwin-probe-core.test.mjs \
  apps/desktop/tests/locked-control-feasibility-probe.test.mjs \
  apps/desktop/tests/locked-control-native-helper-source.test.mjs

corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
node --test apps/web/test/lock-aware-computer-control-section.test.mjs \
  apps/web/test/computer-control-view-model.test.mjs
```

Then run repository-appropriate broader checks if the focused checks pass. Hosted native CI
is not required while the Actions allowance is constrained; Windows real-machine acceptance
is a release handoff.

## Test and failure coverage

| Path | Test type | Expected result |
|---|---|---|
| lock/suspend event | Desktop unit | Computer Control suspension called; daemon untouched |
| unlock/resume event | Desktop unit | recovery hint called; daemon untouched |
| resume before unlock | Desktop/policy unit | no recovery until unlock also arrives |
| lock during initial enable | Desktop/coordinator unit | suspension remains latched; candidate retired |
| renderer authorization/revoke | daemon API | routes do not exist; only read-only projection remains |
| provider fence timeout | coordinator unit | immediate kill before cleanup |
| duplicate unlock hints | coordinator unit | one fresh generation |
| relock during recovery | coordinator unit | candidate generation removed |
| hostile host PATH | provider-host unit | only fixed system PATH on macOS |
| Settings page | Web source contract | explanation present; Switch/commands absent |
| macOS feasibility artifact | evidence unit | unsupported locked input remains immutable |

No silent failure mode remains that could enable locked input. A readiness failure after
unlock is visible as the existing Computer Control waiting/repair state while the ordinary
task remains alive.

## Implementation tasks

- [x] **LATC-01 (P1)** — Remove persistent opt-in preference, IPC and daemon state.
- [x] **LATC-02 (P1)** — Add fixed lock-aware Settings explanation.
- [x] **LATC-03 (P1)** — Rewrite policy and detailed design.
- [x] **LATC-04 (P1)** — Assert lock/sleep does not stop the daemon.
- [x] **LATC-05 (P1)** — Retain native probe corrections, evidence and provider PATH fix.
- [x] **LATC-06 (P1)** — Run focused Desktop/Web validation and fix failures.
- [x] **LATC-06A (P1)** — Remove Renderer mutation routes and harden reordered/pre-enable
  lock and suspend boundaries.
- [ ] **LATC-07 (P2)** — Review final diff, commit, push and merge when requested.
- [ ] **LATC-WIN-01 (release handoff)** — Windows owner validates x64 pause/unlock recovery.

## Estimate

- Scope reduction and UI/docs/tests: 2–4 hours with Codex.
- Local macOS validation and review: 1–2 hours depending on build cache.
- Windows x64 acceptance: 0.5–1 day for the Windows owner; it does not block local macOS
  implementation completion.

## Definition of done

- Persistent locked-control UX and state are absent from the diff.
- Lock/sleep pauses only Computer Control.
- Unlock/resume requires a fresh generation and readiness.
- Settings has no locked-control Switch or command.
- macOS negative evidence remains valid and content-free.
- Focused builds/tests/lint/i18n pass.
- Windows acceptance ownership and boundary are explicit.

## NOT in scope

- Positive locked-screen capture/input or a locked provider generation.
- Local identity confirmation for a locked-control preference.
- New grant/audit/persistence infrastructure.
- Automatic unlock, password/PIN entry or secure-desktop control.
- DLL/native-addon conversion.
- Windows ARM64 or Linux Desktop provider support.

## Unresolved decisions

There are no unresolved implementation decisions. Windows x64 real-machine acceptance is an
explicit release handoff, not an architecture decision.
