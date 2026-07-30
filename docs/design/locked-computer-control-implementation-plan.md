# Governed Locked Computer Control Implementation Plan

## Status

Implementation foundation complete; native enablement gates remain open. This plan covers
macOS and Windows code. macOS packaged acceptance is performed locally; Windows compilation,
real-machine acceptance and final Windows verdict are performed by the Windows team.

The current branch has implemented the shared contracts, fail-closed platform adapters,
Desktop coordinator, daemon registry/audit/routes, pre/post-provider policy checks,
Settings/PiP presentation and native-helper scaffolding. Product builds still publish
`disabled_by_build`, do not provide an executable locked generation, and do not restore a
grant after restart.

Two release-blocking facts remain:

1. both native helpers deliberately emit negative locked capture/input attestation because
   attended same-user locked feasibility has not been proven;
2. provider patch `0005-ling-provider-input-fence-v1.patch` fences a complete mutating tool
   invocation, not each low-level OS input emission required by the design.

These gaps are why the feature remains Off, not reasons to weaken the platform boundary.

The current production-safe behavior remains in force until a platform finishes every
release gate:

```text
lock / suspend / invalid session
  -> close call gate
  -> revoke current lease and provider generation
  -> retain requested Computer Control intent
  -> fresh normal readiness only after unlock/resume
```

## Inputs

- [Governed Locked Computer Control](locked-computer-control-policy.md)
- [Governed Locked Computer Control Detailed Design](locked-computer-control-detailed-design.md)
- [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md)
- [Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)
- [Bundled Embedded Cua Driver Implementation Plan](cua-driver-bundled-embedded-implementation-plan.md)

## Delivery outcome

After all required slices and one platform's release gates pass:

- Settings can offer a short-lived **Authorize for this task** action instead of a permanent
  locked-control toggle;
- an OS-owned local identity prompt arms one active run/session for at most 15 minutes and
  one lock transition;
- lock/unlock both rotate provider authority and cannot inherit an in-flight GUI call;
- locked execution remains inside the existing tool, approval, lease and audit path;
- login, credential, elevation and secure desktops remain unconditionally excluded;
- a failed/unknown platform proof leaves the row disabled and preserves current behavior;
- macOS and Windows can reach independent release verdicts without contract drift.

## What already exists

| Existing code | Planned extension |
| --- | --- |
| `apps/desktop/main/desktop-runtime.ts` power-monitor handlers | Delegate to a serialized locked-policy coordinator |
| `apps/desktop/main/cua-driver/coordinator.ts` generation/lease/process ownership | Add normal vs restricted-locked generation mode and rotate at both boundaries |
| `apps/desktop/main/cua-driver/adapters/*` | Add local identity and locked-session capability adapters alongside existing permission/readiness adapters |
| `packages/contracts/src/cua-driver-bundled.ts` | Keep provider contracts stable; add focused locked-control contracts in a separate module |
| Desktop bridge token, authority tuple and availability sequence | Authenticate grant/attestation publication and fence stale reports |
| Daemon bundled activation, client pool and activation fence | Intersect active locked grant before and after provider calls |
| Run approvals and runtime permission requests | Preserve as the only action-authorization system |
| Computer Use registry/Stop audit | Reuse audit id/reason/acknowledgement conventions; write locked lifecycle events through persisted RunStore/control-plane storage rather than relying on the bounded in-memory Stop audit array |
| Computer Control controller/view/page | Add pure Privacy projection and narrow authorize/revoke commands |

## Scope discipline

This is a security-sensitive cross-layer feature, so it necessarily touches more than eight
files. The plan controls complexity by adding only three new conceptual boundaries:

1. shared contracts;
2. one Desktop policy coordinator with platform adapters;
3. one daemon locked-policy registry/enforcer.

UI remains a pure projection. Provider lifecycle, approval, run state and audit storage are
extended rather than duplicated. A persistent global grant, general per-app allowlist,
privileged Windows service and Cua Driver rewrite are explicitly excluded.

## Dependency order

```text
Slice 0A macOS probe --------+-- unsupported --> macOS disabled evidence; stop macOS lane
Slice 0B Windows probe ------+-- unsupported --> Windows disabled evidence; stop Windows lane
      |                      |
      +---- shared findings -+--> Slice 1 contracts + inert projection
                                   |
                 +-----------------+------------------+
                 v                                    v
passing platform adapter(s), conditional       Slice 3 daemon registry/audit
                 +-----------------+------------------+
                                   |
                                   v
Slice 4 core state machine + input fence + passing platform adapter integration
                   |
                   v
Slice 5 daemon pre/post-call enforcement + approval intersection
                   |
                   v
Slice 6 Settings/PiP/status UX
                   |
                   v
Slice 7 cross-platform automation + package acceptance/handoff
                   |
                   v
per-platform release flag or current fixed-Off baseline
```

Slice 0 is a per-platform hard evidence gate. Contracts/disabled UI may be developed with
fixtures in parallel, and dormant enforcement scaffolding may land while every executable
entry remains fixed Off. A failed platform stops its positive native runtime and acceptance
lane. No scaffold may reinterpret failure as support or start a restricted generation.

## Slice 0 — Native feasibility probes

### Goal

Establish whether the signed, standard user-mode Ling/Cua tuple can capture and inject into
the same logged-in user desktop after lock while proving it is not addressing a secure
surface.

### macOS work

- Add a development-only native probe command to the existing native-helper boundary.
- Bind the console user/Aqua session before lock and compare after lock without logging raw
  account identifiers.
- Verify content-free capture readiness and input acknowledgement on a disposable Ling test
  surface; do not store pixels or keystrokes.
- Assert loginwindow/authentication UI exclusion.
- Run the exploratory probe on the minimum and current supported macOS versions on Apple
  Silicon; before `supported_restricted`, Slice 7 repeats acceptance on every declared
  macOS support cell.

### Windows work

- Add a development-only probe for WTS session, logon identity, window station and input
  desktop.
- Exercise the standard Medium-IL `ling-cua-driver.exe` tuple across lock/unlock.
- Assert denial for Winlogon, UAC secure desktop, Session 0, non-default input desktop,
  disconnect/reconnect and user switch.
- Do not introduce UIAccess, a service or saved credentials to make the probe pass.
- Produce fixtures and a handoff script; Windows colleagues execute the signed real-machine
  run.

### Exit criteria

- Each platform produces a non-release `feasible_candidate` result or a stable unsupported
  reason. Only Slice 7 full-matrix packaged acceptance may promote the platform capability
  to `supported_restricted`.
- Probe source, signed binary identity, OS version and content-free results are reviewable.
- A failed platform remains in the implementation plan only for disabled-state contracts and
  UI; identity/runtime enablement for that platform stops.

### Estimate

- CC-assisted implementation: 0.5–1 day per platform plus attended OS transitions.
- Human engineering: 1–2 days per platform; Windows elapsed time depends on colleague access.

## Slice 1 — Contracts and inert projection

### Files

- create `packages/contracts/src/locked-computer-control.ts`;
- export from the contracts package entry point;
- add `packages/contracts/test/locked-computer-control.test.mjs`;
- extend the canonical Cua setup projection with an optional locked-control block;
- add package-carried per-platform policy with mode `disabled` by default.

### Requirements

- Implement policy, capability, identity result, grant, attestation, projection and audit
  event validators.
- Enforce impossible-state rules: active requires grant/expiry/locked timestamp;
  `supported_restricted` requires every proof boolean; expiry cannot exceed packaged ceiling.
- Require `reason` for negative/unavailable/paused/failed states and omit it for successful
  capability, identity and active projections.
- Older consumers ignore the optional block and stay fixed Off.
- Static packaged capability never claims a live native proof.

### Tests

- table-test every valid enum/state;
- reject unknown fields where the wire contract is closed, oversized inputs, invalid
  timestamps, unsafe TTL, platform mismatches and active-without-grant projections;
- validate every success/failure reason constraint, including audit and input-fence failure;
- compatibility fixtures for old Desktop/new daemon and new Desktop/old daemon.

### Estimate

- CC-assisted: 3–5 hours.
- Human engineering: 1–1.5 days.

## Slice 2 — Local identity and platform attestation adapters

### Files

- create focused files under `apps/desktop/main/locked-computer-control/`;
- extend the existing Darwin native helper for `LocalAuthentication`;
- extend the existing Win32 native helper for `UserConsentVerifier`, WTS and input-desktop
  proof;
- add adapter unit/native integration tests beside existing Cua adapter tests.

### Requirements

- Platform-neutral interfaces return closed result enums, never native error dumps.
- OS prompt runs only from an unlocked, active session and is single-flight.
- Snapshot/recheck session identity and Desktop authority around the async prompt.
- Produce content-free session binding digests and attestation facts.
- Treat API absence, cancellation, remote/disconnected session and any unknown desktop as
  denial.
- Keep native bindings in Desktop/main/helper; renderer never loads native code.

### Tests

- success, cancel, failure, unavailable and stale result;
- lock/user switch/provider restart while prompt is pending;
- Darwin TCC granted but locked probe unsupported;
- Windows Hello verified but input desktop/Session 0/Winlogon denied;
- native helper crash/timeout and duplicate callback.

### Estimate

- CC-assisted: 1–1.5 days total after probes.
- Human engineering: 2–4 days, mainly native API and packaging work.

## Slice 3 — Daemon grant registry and audit projection

### Files

- create `packages/daemon/src/features/computer-use/locked-control-policy.ts`;
- create `packages/daemon/src/features/computer-use/locked-control-registry.ts`;
- create `packages/daemon/src/features/computer-use/locked-control-routes.ts`;
- extend existing daemon composition and persisted RunStore/control-plane event projection;
- add daemon route, registry, audit and recovery tests.

### Requirements

- Resolve active workspace/run/Computer Use session on the daemon; do not trust renderer
  scope ids. Because Settings has no task selector, require exactly one active session and
  fail closed when the scope is absent or ambiguous.
- Accept grant/attestation only through the authenticated Desktop bridge tuple.
- Keep bearer authority in memory; persist metadata audit and terminal projection only.
- Normalize non-terminal persisted state to Off on restart.
- Share a mutation owner/revision fence with Computer Control enable/disable/check.
- Implement idempotent pending-intent -> durable prepare -> memory commit/reconcile; prepared
  intent is short-lived and cannot create a locked lease.
- Derive independent Desktop/daemon monotonic deadlines from the committed TTL; wall-clock
  expiry is display/audit plus an additional early-revoke check, never the only timer.
- Make arm wait for durable audit success; make emergency revoke close in memory before
  bounded durable retry.
- Add persisted audit export references without duplicating tool arguments or screen
  contents; process-local Stop audit compatibility records are never arm authority.

### Tests

- wrong bridge token, workspace, authority epoch, generation, sequence and grant id;
- restart recovery, audit unavailable, duplicate arm/revoke, prepare/commit lost
  acknowledgements and TTL expiry;
- wall-clock rollback/forward and monotonic deadline boundary;
- run/session terminal transition revokes grant;
- disabling Computer Control races with authorization and always wins safely.

### Estimate

- CC-assisted: 0.5–1 day.
- Human engineering: 1.5–2.5 days.

## Slice 4 — Desktop policy state machine and generation rotation

### Files

- create `policy-coordinator.ts`, `capability-attestor.ts`, `identity-verifier.ts` and
  `audit-publisher.ts` under the new focused Desktop directory;
- minimally change `apps/desktop/main/desktop-runtime.ts` to delegate events;
- add the reviewed provider-local input-fence control channel to the existing Ling patch
  series under `apps/desktop/resources/providers/cua-driver/0.8.3-ling.1/patches/`;
- extend `apps/desktop/main/cua-driver/coordinator.ts`, lease publication and proxy context
  with `executionMode: normal | locked_restricted`;
- add policy-coordinator, runtime and provider-coordinator race tests.

### Requirements

- One queue serializes authorize/revoke/lock/unlock/suspend/quit/authority change.
- Lock closes the daemon gate before any async work.
- Lock fences provider input through a control thread independent from the MCP executor;
  every native input emission checks the epoch, and missed acknowledgement uses immediate
  retained-handle termination rather than the normal graceful shutdown wait.
- Normal generation is revoked, then a fresh non-executable locked generation id is reserved
  before attestation; only a passing attestation may start that exact id.
- Unlock always closes/revokes locked generation and consumes the grant before normal
  readiness.
- Grant is bound to one lock epoch, the fenced pre-lock normal generation and monotonic
  expiry; the fresh locked generation is bound separately by its attestation.
- Bounded drain kills the owned provider generation on missing acknowledgement.
- All cleanup is idempotent and best-effort complete; safety state changes precede audit
  retries.

### Inline diagrams

Add short maintained ASCII diagrams to:

- `policy-coordinator.ts`: state transitions and authority rotation;
- `cua-driver/coordinator.ts`: normal vs locked generation lifecycle;
- the primary race test: lock event, call gate, provider call and late result ordering.

### Tests

- every state transition and invalid transition;
- lock during identity prompt; lock at expiry boundary; unlock during attestation;
- next-lock epoch matching/overflow and abandoned generation reservation;
- duplicate/out-of-order Electron and native session events;
- already-dispatched click/type/drag/replay against a disposable target; no old-epoch event
  may appear after input-fence acknowledgement;
- provider start/stop failure, audit failure and daemon disconnect;
- late normal and locked results cannot project after a boundary;
- suspend/resume always revokes instead of reusing the grant.

### Estimate

- CC-assisted: 1–1.5 days.
- Human engineering: 2–3.5 days.

## Slice 5 — Daemon action enforcement

### Files

- extend bundled activation/client-pool/lease call path with the locked policy decision;
- extend `packages/daemon/src/features/plugins/presets.ts` as the single reviewed Cua tool
  policy source;
- define the locked tool subset beside the existing bundled Cua tool policy and verify its
  canonical digest/revision against the signed package policy;
- reuse existing run approval and runtime permission handlers;
- add unit and daemon integration tests around pre-dispatch and post-result fences.

### Requirements

- Evaluate provider generation, activation revision, grant, attestation, signed tool allowlist,
  teammate/run tool scope and approval in that order.
- Centralize `isCurrentPositiveAttestation`: exact grant/platform/lock-epoch/session-digest/
  generation binding, latest sequence, monotonic heartbeat freshness and all five positive
  proof booleans.
- Implement the exact `locked-cua-tools-v1` allow/deny rows from the detailed design; no
  additional bundled reviewed tool is implicitly inherited.
- Recheck generation/revision/grant/expiry and every attestation proof after provider result
  and before projection.
- A locked grant never auto-approves an action or mutates the available tool registry.
- Approval-required actions pause/deny with a stable reason until unlock.
- Stop/revoke remains callable independently from the locked allowlist.
- Unknown provider tools are denied in locked mode even if normal mode accepts them later.

### Tests

- Cartesian policy fixtures for locked/unlocked × grant/no grant × approval allow/prompt/deny;
- grant expires during provider call;
- attestation becomes stale/negative during provider call;
- every attestation identity field mismatch, stale sequence and missed heartbeat;
- unlock and disable races discard late results;
- package/daemon locked-policy digest mismatch and future tool rejection;
- existing normal unlocked behavior is unchanged.

### Estimate

- CC-assisted: 0.5–1 day.
- Human engineering: 1–2 days.

## Slice 6 — Settings, confirmation and visibility

### Files

- create `apps/web/src/domains/computer-control/locked-control-view-model.ts`;
- extend `use-computer-control-controller.ts` with authorize/revoke intents;
- create `LockedComputerControlSection.tsx` and keep the page component declarative;
- extend Desktop capability typings/preload/main IPC with two sender-checked commands;
- update Computer Control CSS/i18n and renderer/Playwright tests;
- reuse PiP/preview status surfaces for armed/active/revoke visibility.

### Requirements

- Implement the full show/hide/disabled matrix from the design.
- Replace the current “Always off in this version” disabled row only when the canonical
  projection says the platform is eligible.
- Explain task scope, 15-minute ceiling, one-lock consumption, approvals and secure-surface
  exclusions before the OS prompt.
- Display absolute expiry plus countdown; countdown never drives authority.
- Closing Settings or hiding the Ling window does not revoke; quit/Stop/Revoke does.
- An armed/active grant remains visible outside Settings and has an obvious Stop/Revoke path.
- UI refreshes canonical projection after command acknowledgement and never trusts the IPC
  acknowledgement as effective state.

### Tests

- pure view model for every reachable canonical capability/phase state, every reason-copy
  mapping, and one fail-closed invalid-projection path; do not construct impossible Cartesian
  combinations;
- rapid authorize/revoke/enable/disable and navigation during pending OS prompt;
- stale/failed refresh, expired projection and wall-clock jump;
- page hidden in pure Web/Linux/external mode;
- Playwright flow for supported fixture, cancellation, armed countdown, lock transition,
  unlock consumption and Stop;
- accessibility: keyboard, screen-reader labels, focus return from confirmation and OS prompt,
  reduced motion, light/dark themes.

### Estimate

- CC-assisted: 0.5–1 day.
- Human engineering: 1.5–2.5 days.

## Slice 7 — Acceptance, handoff and release control

### Automated gates

- contracts, Desktop, daemon and Web unit tests;
- renderer Playwright and Desktop fake-Electron lock/unlock integration;
- provider-local fence and immediate-termination integration with a disposable native input
  target;
- packaged provider coexistence smoke with an upstream Cua Driver present;
- restart/update/quit/Stop, audit export and feature-flag rollback;
- lock-event-to-gate-close and attestation-to-lease-removal performance assertions;
- no screenshots, raw input or identity secrets in logs/artifacts.

### macOS acceptance

- Apple Silicon packaged DMG/app, signed identity and embedded provider;
- attended local identity prompt and lock/unlock test on supported OS matrix;
- loginwindow/authentication exclusion and TCC-denied recovery;
- local owner records the platform release verdict.

### Windows handoff

- x64 Setup installs signed/test-signed `ling-cua-driver.exe` in the existing private
  payload layout;
- deterministic script verifies WTS/input desktop/Winlogon/UAC/Session-0 denial and standard
  Medium-IL behavior;
- fixtures, commands, expected reason codes, checksums and audit export are included;
- Windows team executes real-machine acceptance and owns PASS/FAIL; our team does not
  synthesize that verdict.

### Release and rollback

- independent `darwin` and `win32` feature/package policy gates;
- unknown/failed capability always renders disabled and executes current suspend behavior;
- rollback revokes live grants immediately and needs no provider/database downgrade;
- public release remains separate from internal acceptance.

### Estimate

- CC-assisted automation/handoff: 0.5–1 day.
- Human attended acceptance: macOS 0.5–1 day; Windows elapsed time owned by Windows team.

## Test coverage map

```text
IMPLEMENTED AUTOMATION                                OPEN RELEASE EVIDENCE
[x] contracts validators and impossible states       [ ] attended macOS locked capture/input
[x] Desktop authorize/revoke/lock race state machine [ ] loginwindow exclusion on packaged app
[x] daemon bridge auth/revision/TTL/audit recovery    [ ] per-OS-emission epoch fence
[x] pre/post provider grant/attestation/tool fence    [ ] disposable target no-post-fence input
[x] Settings view model/countdown/commands            [ ] macOS locked-control OS matrix
[x] PiP armed/attesting/active projection             [ ] Windows helper compile/sign on Windows
[x] helper crash/malformed/negative proof handling    [ ] Winlogon/UAC/WTS/Session-0 handoff run
[x] macOS helper compile + content-free session probe [ ] Windows-team real-machine verdict
[x] internal macOS DMG/ZIP + provider signing checks

The implemented tests prove fail-closed state and wiring. They do not prove positive locked
control. Only the open native/package rows may close that release boundary.
```

Current fixed-Off macOS package evidence (2026-07-31):

- `Ling-Stack-0.0.0-macos-arm64.dmg` and `.zip` build successfully with the embedded
  `ling-cua-driver`;
- `codesign --verify --deep --strict` passes for the App and strict verification passes for
  the provider; both report Team ID `ZH5RAD8573`;
- provider identifier is `com.lingstack.desktop.cua-driver` and hardened runtime is enabled;
- packaged authority is `test_signed_internal` / `internal`, and the provider seal is
  `productionEligible=false` with `managed-internal` test authority;
- packaged Desktop code still publishes `disabled_by_build`; the native locked-control
  helper is not staged while its positive feasibility and per-emission fence gates are open.

## Performance acceptance

| Measurement | Target | Failure behavior |
| --- | --- | --- |
| Lock event to synchronous call-gate close | p95 < 10 ms | Release gate fails; feature remains Off |
| Native lock event to provider input-fence acknowledgement | p95 < 50 ms; hard ceiling 100 ms | Immediately terminate provider; release gate fails |
| Negative attestation to lease removal | < 100 ms | Release gate fails |
| Locked pre-call policy evaluation | p95 < 2 ms, no DB/native call | Optimize cached memory snapshot before enablement |
| Missed attestation heartbeats | Revoke within 3 one-second intervals | Gate closes and generation stops |
| Provider drain at lock | Bounded; exact timeout chosen from existing coordinator budget | Kill owned generation and audit unacknowledged result |
| UI countdown | At most 1 render/second while visible | No effect on authority |

## Critical failure modes

1. **Lock race with an in-flight input.** Mitigation: close gate, independent provider-local
   input epoch fence, immediate termination on missing acknowledgement, generation rotation,
   disposable-target no-post-fence-input test and post-result fence. Current status: gate,
   whole-tool permit, termination and post-result fences exist; per-OS-emission checks and
   the disposable-target proof remain open, so enablement is blocked.
2. **OS prompt returns after scope changed.** Mitigation: snapshot/recheck authority, run,
   session and provider revision before installing the grant.
3. **Platform can report lock but not prove target desktop.** Mitigation: capability remains
   `probe_required`/`unsupported`; Electron event is never sufficient.
4. **Grant survives restart/update/user switch.** Mitigation: bearer authority is memory-only
   and bound to Desktop/daemon/session epochs.
5. **Audit outage creates unaudited authority.** Mitigation: arm requires durable audit;
   emergency revoke executes first and retries audit.
6. **Locked grant bypasses approval.** Mitigation: independent intersection in daemon before
   and after execution; identity verification grants no tool approval.
7. **Renderer fabricates supported state.** Mitigation: canonical daemon projection derives
   only from authenticated Desktop reports; renderer methods carry intent only.
8. **Windows workaround reaches secure desktop.** Mitigation: no service/UIAccess escalation;
   explicit Winlogon/UAC/Session-0 denial and Windows-team acceptance.

## Worktree and parallelization strategy

Keep each slice in an isolated worktree based on the latest `origin/main`; do not implement
inside a dirty canonical worktree. Recommended lanes after Slice 1 contracts land:

```text
Lane A (macOS native) --------+
Lane B (Windows native) ------+--> Slice 4 integration --> Slice 7 platform acceptance
Lane C (daemon policy/audit) -+
Lane D (Web UI) waits for stable projection from Slice 1/3
```

- Parallel: native adapters and daemon registry after shared contracts.
- Sequential: generation state machine after adapter/registry interfaces; action enforcement
  after state machine; final UI E2E after canonical projection.
- Windows lane may finish code/fixtures independently, but it cannot declare platform PASS.
- Merge contracts before cross-worktree code to avoid four divergent wire shapes.

## Implementation tasks

| ID | Status | Priority | Task | Depends on | Human estimate | CC-assisted estimate |
| --- | --- | --- | --- | --- | --- | --- |
| LCC-00 | Partial | P0 | Build macOS and Windows feasibility helpers; positive attended proof still open | None | 2–4 days | 1–2 days |
| LCC-01 | Implemented | P0 | Add contracts, validators, packaged disabled policy and compatibility fixtures | LCC-00 interface findings | 1–1.5 days | 3–5 hours |
| LCC-02 | Partial | P0 | macOS identity/session helper and bridge exist; positive feasibility/package wiring open | LCC-01 | 1–2 days | 0.5–1 day |
| LCC-03 | Handoff ready | P0 | Windows identity/WTS/input-desktop source and denial handoff; Windows execution open | LCC-01 | 1.5–2.5 days | 0.5–1 day |
| LCC-04 | Implemented | P0 | Add daemon memory grant registry, authenticated routes and durable metadata audit | LCC-01 | 1.5–2.5 days | 0.5–1 day |
| LCC-05 | Partial/blocking | P0 | Desktop state machine and whole-tool fence implemented; per-emission fence/restricted start open | LCC-04 plus positive native adapter | 2–3.5 days | 1–1.5 days |
| LCC-06 | Implemented while Off | P0 | Enforce grant/attestation/allowlist/approval before and after provider calls | LCC-04, LCC-05 | 1–2 days | 0.5–1 day |
| LCC-07 | Implemented | P1 | Implement Privacy projection, confirmation, countdown and external visibility | LCC-01, LCC-04 | 1.5–2.5 days | 0.5–1 day |
| LCC-08 | Partial | P0 | Core unit/race/privacy automation and fixed-Off macOS package checks implemented; positive packaged native/E2E rows open | LCC-04–07 plus passing native lane | 2–3 days | 1–1.5 days |
| LCC-09A | Open | P0 | Run macOS full-matrix packaged acceptance | positive macOS LCC-00, completed per-emission fence | 1–2 days | 0.5–1 day plus attended runs |
| LCC-09B | Windows-owned execution | P0 | Execute signed Windows handoff and record Windows-team verdict | Windows machine/certificate, completed per-emission fence | 1–2 days plus Windows owner | 0.5–1 day plus attended runs |

### Remaining estimate after this implementation slice

- Per-OS-emission provider fence plus disposable-target regression: approximately **1–2
  engineering days**, depending on the upstream input backend split.
- macOS attended feasibility and packaged acceptance: **0.5–1 day per declared OS cell**
  after the fence exists; a negative result stops enablement.
- Windows compile/sign/denial handoff: **0.5 day of Windows-owner time**; positive feasibility
  and full acceptance are not predictable until the Windows colleague runs them.
- Public-release signing/notarization and policy promotion remain a separate release task.
- If a platform probe fails, stop that platform after disabled-state/handoff evidence; do
  not bypass the OS boundary.

## Definition of done

A platform is done only when:

- native feasibility is `supported_restricted` on its supported OS matrix;
- identity, policy, audit and platform boundaries ship in the same gated release;
- all unit/integration/native/renderer/package tests pass;
- lock/unlock races meet latency and stale-result assertions;
- no secure surface can be targeted and no credential/biometric/screen content is logged;
- feature rollback immediately restores current fixed-Off behavior;
- macOS local owner or Windows team, respectively, records packaged real-machine acceptance.

Documentation or UI completion alone is not an implementation verdict.

## NOT in scope

- Automatic unlock/login, credential storage, loginwindow/Winlogon/UAC/secure desktop
  control, Windows service/UIAccess escalation or a provider rewrite.
- A permanent global setting, grant persistence across restart/update, multiple lock
  transitions, cloud authorization or background authorization without an active run.
- General per-app allowlist UX, Windows ARM64, Linux or pure Web support.
- Reopening the bundled provider packaging/supply-chain program beyond the existing normal
  product build and signed platform helper changes needed here.
- Our team declaring Windows real-machine PASS.

## Architecture and engineering review

- **Architecture:** the load-bearing choice is a memory-only task grant that intersects the
  existing daemon approval/lease path; no second runtime or audit store is introduced.
- **Code quality:** large existing coordinator/page files receive only delegation points;
  new state, adapters and view projection are focused modules with closed contracts.
- **Tests:** all contract, state, race, native and user paths are mapped above; packaged
  native acceptance is mandatory because mocks cannot prove OS desktop boundaries.
- **Performance:** the steady-state check is an in-memory snapshot; native probes and durable
  writes are off the per-action hot path except first arm/transition.
- **Failure posture:** eight critical gaps are converted into fail-closed requirements and
  release gates; none is deferred past enablement.

## Unresolved decisions

No unresolved architecture or product decisions. Platform feasibility is a hard measured
gate: unsupported is a valid completed result that keeps the feature Off.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Not required for this bounded follow-up |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | CLEAR | 4 P1 and 2 P2 findings folded; 0 open findings |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 architecture/code/test/performance findings folded into the plan; 0 open gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Recommended before implementation of Slice 6 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not required |

**CODEX:** Full attestation binding, provider-local input fencing, closed reason semantics,
exact locked tool policy, conditional platform lanes and reachable-state UI tests are folded.

**CROSS-MODEL:** Both reviews agree on reusing the existing Desktop/daemon/approval topology
and on treating native platform feasibility as a per-platform hard gate.

**VERDICT:** CODEX + ENG CLEARED — ready to begin Slice 0 feasibility; platform enablement
remains gated.

NO UNRESOLVED DECISIONS
