# Lock-Aware Task Continuation Implementation Plan

## Status

**Scope:** macOS and Windows shared product code; macOS local verification; Windows
real-machine acceptance by the Windows owner.
**Decision:** persistent default-On non-visual continuation Switch; Computer Control always
pauses while locked.
**Status:** implementation, local validation and PR handoff complete; Windows real-machine
acceptance remains with the Windows owner.

## Delivery outcome

- Settings exposes **Continue running while locked** and persists it locally.
- On leaves current non-visual behavior unchanged.
- Off pauses the embedded run at the next safe Agent/provider/tool boundary and resumes the
  same run after unlock.
- Waiting does not consume idle/hard timeout budget and remains cancellable.
- Computer Control always fences and recovers through fresh unlocked readiness.
- No locked-control grant, credential path or secure-surface authority is added.

## Dependency order

```text
1. Preference and Desktop IPC
   -> 2. Desktop-to-daemon state bridge
      -> 3. Cooperative daemon/runner gate
         -> 4. Settings Switch and rollback UX
            -> 5. Docs, focused validation and ship
```

## Slice 1 — Focused persistent preference

### Changes

- Add a versioned `locked-task-continuation-preference.json` store.
- Default missing/malformed state to On.
- Serialize atomic writes with last invocation winning.
- Add typed get/set Desktop capability, preload exposure and IPC handlers.
- Restrict IPC to the main window and boolean values.
- Keep this file separate from Computer Use preview preferences.

### Exit criteria

- Restart reloads the saved value.
- Save failure returns a rejected command and preserves the prior value.
- Web-only/no Desktop mode cannot claim persistence.

## Slice 2 — Private Desktop-to-daemon state bridge

### Changes

- Add a focused client and `POST /computer-use/locked-task-continuation/desktop/state`.
- Require Desktop bridge token, configured workspace, POST and exact boolean schema.
- Publish at daemon startup/restart, OS boundary changes and preference changes.
- Probe the current macOS/Windows session state before first publication and fail closed
  when the probe is unknown.
- Bind state to an ephemeral Desktop owner, renew a short lease and release it at shutdown.
- Latch lock/suspend before asynchronous work and serialize publications.

### Exit criteria

- Renderer/route tokens cannot mutate the gate.
- A Desktop crash cannot leave an immortal blocked state in an external daemon.
- Reordered unlock/resume cannot publish unlocked until both boundaries clear.
- A task-state sync cannot delay or authorize Computer Control.

## Slice 3 — Cooperative run gate

### Changes

- Add process-wide continuation snapshot/waiters to `RuntimeSupervisor`.
- Gate run start in the daemon orchestrator.
- Add embedded Pi callbacks before Agent start, provider request and tool call.
- Preserve atomic in-flight action completion.
- Pause idle/hard timeout accounting only while that run actually waits at the gate.
- Use monotonic elapsed time for the hard-timeout budget.
- Use the run abort signal to cancel a waiter.

### Exit criteria

- Off plus locked blocks the next safe boundary.
- Unlock or toggle On releases the same run.
- Cancellation while waiting completes normally.
- External opaque runners are documented as run-start-only unless callback-aware.

## Slice 4 — Settings and safety boundary

### Changes

- Replace the fixed “tasks continue” badge with a persistent Switch.
- Add optimistic checked state, busy state, load warning and durable-truth reconciliation
  after save/sync/rollback failures.
- Expose the task preference capability independently from optional Cua Driver readiness.
- Keep fixed Computer Control pause and fresh-unlock recovery rows.
- Add Chinese translations.
- Update source-contract tests to require the task Switch and forbid locked-control commands.

### Exit criteria

- UI clearly says the Switch covers Agent/Shell/API/file work only.
- No text/action implies screen control while locked.
- Toggling On while locked never resumes the Driver coordinator.

## Slice 5 — Validation and ship

Run focused checks:

```bash
corepack pnpm --filter @ling-stack/runner-pi test
corepack pnpm --filter @ling-stack/daemon build
node --test packages/daemon/test/locked-task-continuation.test.mjs

corepack pnpm --filter @ling-stack/desktop build
node --test apps/desktop/tests/locked-task-continuation.test.mjs \
  apps/desktop/tests/desktop-runtime.test.mjs \
  apps/desktop/tests/ipc.test.mjs \
  apps/desktop/tests/theme-package-preload.test.mjs

node --test apps/web/test/lock-aware-computer-control-section.test.mjs
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
git diff --check
```

Then review the final diff, commit, push and create/merge a PR only when explicitly
requested. Windows owners validate the x64 packaged behavior later; they do not need to
prove or enable locked input.

## Test and failure coverage

| Path | Test | Expected result |
|---|---|---|
| missing/malformed preference | Desktop unit | default On |
| concurrent saves | Desktop unit | last invocation wins; no temp residue |
| client publication | Desktop unit | exact URL/header/body and response validation |
| IPC get/set | Desktop unit | main window only; boolean only |
| lock plus Switch Off | Runtime/gate unit | next safe boundary waits |
| unlock/resume reordered | Runtime unit | blocked until both clear |
| toggle On while locked | Runtime/gate unit | task released; control remains fenced |
| waiter cancellation | Gate unit | abort reason preserved and listener removed |
| provider/model/tool boundaries | Runner unit | wait before next atomic action |
| timeout while blocked | Orchestrator regression | no idle/hard cancellation budget consumed |
| global gate blocked before a run reaches a boundary | Orchestrator regression | that run's timeout remains active |
| wall clock changes during wait | Orchestrator regression | monotonic hard-time budget remains correct |
| Desktop starts while already locked | Runtime unit | first publication is locked; unknown probe fails closed |
| Desktop exits/crashes | Runtime/daemon unit | owner release or TTL expiry clears stale gate state |
| daemon sync plus rollback write failure | Runtime/Web unit | newly persisted value remains truth and UI rereads it |
| private daemon route | Daemon HTTP unit | token/method/workspace/schema enforced; no CORS grant |
| Settings | Web source/component checks | task Switch present; locked-control commands absent |
| lock/suspend control path | Existing Desktop/coordinator tests | control fenced; daemon untouched |

## Implementation tasks

- [x] **LATC-08 (P1)** — Add focused default-On atomic preference store.
- [x] **LATC-09 (P1)** — Add typed main-window IPC/preload get/set capability.
- [x] **LATC-10 (P1)** — Add Desktop-authenticated daemon state client and route.
- [x] **LATC-11 (P1)** — Add abortable cooperative gate to Runtime Supervisor.
- [x] **LATC-12 (P1)** — Gate run start and embedded Pi Agent/provider/tool boundaries.
- [x] **LATC-13 (P1)** — Exclude blocked time from idle/hard timeout accounting.
- [x] **LATC-14 (P1)** — Wire Desktop startup/restart and dual OS boundaries.
- [x] **LATC-15 (P1)** — Add persistent Settings Switch, translations and rollback UX.
- [x] **LATC-16 (P1)** — Add focused Desktop/Daemon/Runner/Web tests.
- [x] **LATC-17 (P1)** — Update policy, detailed design and implementation plan.
- [x] **LATC-18 (P1)** — Run broad local validation and final diff review.
- [x] **LATC-20 (P1)** — Add per-run timeout accounting and monotonic hard-time budget.
- [x] **LATC-21 (P1)** — Add Desktop owner lease, heartbeat, explicit release and expiry.
- [x] **LATC-22 (P1)** — Add initial macOS/Windows lock probe with fail-closed unknown state.
- [x] **LATC-23 (P1)** — Decouple Renderer preference capability from Cua Driver readiness.
- [x] **LATC-24 (P1)** — Preserve durable truth when publication rollback cannot reach disk.
- [x] **LATC-19 (P2)** — Prepare the verified implementation for commit/push/PR/merge on request.
- [ ] **LATC-WIN-02 (release handoff)** — Windows owner validates x64 persistence,
  lock pause/resume and unchanged Computer Control fence on real hardware.

## Estimate

- Shared implementation, focused tests and docs: completed in this slice.
- Broad local validation/review: 0.5–1.5 hours depending on test cache.
- Windows x64 acceptance: 0.5–1 day for the Windows owner; it does not block macOS local
  implementation completion.

## Local validation record

On 2026-07-31 the focused Desktop, Daemon, Runner and Web checks passed, including Desktop
build/typecheck, Web lint and i18n. The broad Daemon run passed 840/842 in parallel; the two
SQLite migration uniqueness races both passed when rerun individually. The unrelated
Windows provider verifier remains red because its existing production-lock fixture lacks
the previously required input-fence contract; none of the files in that fixture/verifier
path are changed by this slice.

The final focused rerun passed Desktop 54/54, locked-task Daemon 7/7, Runner 16/16 and Web
19/19. The pre-merge review closed all six timeout/lifecycle/startup/capability/durability
findings and additionally bounded stalled heartbeat requests and corrected rollback UI
copy. `git diff --check`, Web lint and the i18n audit were clean.

## Definition of done

- Default-On preference persists and is visible in packaged macOS/Windows Settings.
- Off plus locked cooperatively pauses embedded non-visual work at safe boundaries.
- Unlock or On resumes the same run and cancellation remains functional.
- Lock/suspend always pauses Computer Control independently.
- Focused build/tests and Web lint/i18n pass.
- Final diff contains no locked-control authorization path.
- Windows real-machine acceptance boundary is explicit.

## NOT in scope

- Positive locked-screen capture/input or a locked Driver generation.
- Identity confirmation for non-visual task continuation.
- New audit database or cloud preference synchronization.
- Forced mid-action Shell/API/file interruption.
- Mid-run pause for callback-unaware third-party runners.
- DLL/native-addon conversion, Windows ARM64 or Linux Desktop.

## Unresolved decisions

There are no unresolved decisions for the embedded Pi/Desktop scope. Windows x64
real-machine acceptance is an explicit release handoff, not an architecture decision.
