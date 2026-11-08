# Automations Codex-like parity implementation plan

Status: implementation in progress on `gansx/automation-codex-parity`

## Decision

The reverse review established a product shape, not a private Codex cloud protocol.
Ling therefore keeps a local resident daemon as the scheduler authority. A future
relay can host that same daemon behind an authenticated connection, but this change
does not invent a vendor cloud service or claim offline execution while the machine
is powered off.

## Behavior contract

An automation remains a durable definition with one Ling automation thread. Every
admitted fire creates one `AutomationRun`, and normal `RunSession`, approvals,
artifacts, provider snapshots, and idempotency rules remain authoritative.

The existing daily, weekly, and millisecond interval editor forms continue to work.
The custom RRULE editor now admits:

- `FREQ=HOURLY;INTERVAL=n` for elapsed hourly cadence;
- `FREQ=MONTHLY;BYMONTHDAY=d;BYHOUR=h;BYMINUTE=m;BYSECOND=s` in the definition
  timezone;
- `UNTIL=YYYYMMDDTHHMMSSZ` (or an ISO timestamp ending in `Z`) as a finite bound;
- `COUNT=1` as a one-shot rule.

Unsupported fields fail closed at request validation and scheduler admission. DST gaps
are skipped and overlaps use the existing first-fold policy. A finite rule with no
future occurrence is a completed task: after its terminal run the definition becomes
disabled with `nextRunAt` cleared, without putting the scheduler in an error state.

On daemon start or refresh, a stale persisted due slot is handled exactly once:
`skip` advances to the next future occurrence; `run_one` arms the persisted slot for
one bounded catch-up run, then computes the next occurrence from the current clock.
Neither mode bulk-replays missed windows. Generation fencing and SQLite rechecks keep
pause, archive, edit, stop, and restart callbacks from dispatching stale work.

Changing a target to a thread sets `automationMode=heartbeat` and `targetThreadId`.
Moving to a workspace or channel sets `automationMode=cron` and clears the target
thread. A heartbeat still requires an archived-safe target, a resumable last run, and
the target run's provider/tool/permission snapshot.

## Implementation boundaries

1. `packages/core/src/automation-recurrence.ts` owns RRULE parsing, timezone math,
   finite completion, and typed recurrence errors.
2. `packages/core/src/storage/sqlite/automation-store.ts` owns atomic target/mode
   normalization for every API and direct store caller.
3. `packages/daemon/src/features/automations/scheduler.ts` owns stale-slot policy,
   timer fencing, and completion-safe rearming.
4. Existing Web custom RRULE and target selectors remain the authoring surface; the
   domain mutation also sends the normalized mode explicitly.

## Verification gates

- recurrence: hourly, monthly day handling, UNTIL boundary, COUNT=1 completion,
  malformed rules, DST gap/overlap, and existing interval phase tests;
- scheduler: skip/run_one divergence, no burst, stale callback fencing, restart,
  pause/archive, and finite-task disablement;
- state: store/API target changes produce coherent mode and target fields;
- package: core and daemon typecheck, focused daemon/core/CLI tests, docs/link/license/
  public checks, and `git diff --check`;
- runtime: daemon scheduler start/status/stop and SQLite state are inspected after
  the focused suite. Browser/mobile acceptance remains outside this change unless
  the repository's Web checks require it.

## Follow-up

Relay-resident daemon, TLS/token pairing, capability discovery, and vendor-hosted
cloud scheduling remain a separate design and release gate.
