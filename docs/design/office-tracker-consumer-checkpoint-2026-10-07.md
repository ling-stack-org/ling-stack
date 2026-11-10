# Original Office V2 Tracker and consumer checkpoint — 2026-10-07

This is an incremental implementation checkpoint, not completion of E6,
production Office acceptance or the cumulative PR. The controlled-process
boundary is unchanged: Full Access and other unrestricted same-user processes
are not isolated by this work.

## Fixed settlement order

The original private plan retains its Core authority, close claim and committed
grant. The production adapter follows this order:

```text
original native session closure
  → terminal seal
  → original Host window close claim
  → Core atomic pair commit/readback
  → fixed protection lease release
  → fixed original Tracker/Group barriers
  → consumer result
```

Tracker and executor Group use constructor-private close, read and settlement
entries. Replacing a public instance/prototype method with a no-op cannot
counterfeit settlement. The prepared production ticket is bound once to its
exact original Core authority; replacing a DTO cannot remove that requirement.

Before either local barrier closes, the fixed entry requires an existing
release history for the same authority/grant/claim, then reads Core SQL and
Registry private history. This assertion cannot perform the first release,
reopen or close native resources, or delete a Registry member. Synchronous
post-COMMIT reentry before the actual release is rejected. Partial local
settlement and notification return-loss retain their bounded original retry
contract.

The adapter result keeps native facts separate from settlement. Its native
facts still report `coreSafe: false`, `canonicalVisibility: "unverified"` and
`packaged: false`; the consumer must not promote these flags.

## Original production entry wiring

- Daemon creates one original Supervisor before early plugin synchronization
  opens the default Store. The default factory retains its private composition;
  an injected ordinary factory remains untrusted.
- Native artifact selection is a typed Host-only dependency, not an environment,
  workspace, HTTP or model flag. Formal CLI/packaged bootstrap is not yet wired.
- The consumer selects V2 only after its original input snapshot and serializer:
  create, absent target, strict non-overwrite, and at least one missing ancestor.
  Existing-parent create, edit and overwrite continue through V1.
- V2 selection is latched before runtime lookup/preparation. A failed V2 path
  cannot fall back to V1, invent known-no-start or precreate the destination.
  The reservation's private route latch is installed before public guard reads;
  neither V1 preparation nor generic reservation no-start can reenter through
  cleanup or unknown-state notification callbacks.
- Request digest uses the pre-observer owned MCP input. The selected protocol's
  policy digest uses the original permission authority and approval frame.
  Caller-provided protocol/runtime claims are not authority.

## Unprepared failure cleanup

Independent review identified a pre-claim resource leak: a successful bootstrap
had opened original readonly stage FDs, but snapshot revalidation could fail
before Office preparation. Simply marking the roles unknown retained these
unbound FDs indefinitely. The reservation-owning cleanup-only entry now closes
that exact returned bootstrap without settling either role. It cannot be used
after a preparation claim, a lost bootstrap return or native/bound entry.
Original runtime/Registry/FD tombstones reject recursive close and unknown-close
retry. Cleanup does not remove the private V2 route latch or grant no-start.

Two genuine failures were reproduced before these fixes: the original readonly
FDs were never closed after a pre-claim snapshot race; after cleanup was added,
a synchronous Store notification could settle the same V2 reservation through
generic no-start. Both original failing runs are retained. The final route latch
rejects no-start and V1 preparation before either can reenter a public owner read.

## Fresh targeted evidence

All figures below are separate runs, not a combined full-suite result:

- The final cleanup/latch build passed. Its affected regressions passed:
  eight genuine native cleanup/return-loss/close-unknown cases, seven portable
  consumer cases, and seventeen execution regressions: 32 distinct cases,
  no failures or skips. The initial portable five are included in the final
  seven, not counted twice. Claimed preparation and lost bootstrap returns
  retain their original unknown resources instead of gaining cleanup authority.
- The two added claim-time owner-read cases reject same-reservation no-start
  and V1 preparation with zero nested owner reads or Core V1 preparations.
- The older neighborhoods below were run before the final cleanup/latch changes;
  they remain evidence for those slices, not a fresh full-suite run.
- Fresh Daemon TypeScript build passed with Node 22.
- Tracker/Group and legal V1 neighborhood: 126 passed, no failures or skips.
- Original adapter regressions plus four production-order cases: 17 passed,
  no failures or skips, using the reviewed native addon and default 20 sources.
- Genuine directory composition: 12 passed, no failures or skips.
- Actual Daemon startup/cleanup/warmup/shutdown neighborhood: 30 passed,
  no failures or skips. This verifies root ownership, not native product success.
- Portable consumer/execution/MCP-route/composition neighborhood: 76 passed.
- Direct original-composition plus production MCP callback: one genuine DOCX
  create passed, including committed Core pair, fixed barriers and lease history.

The last result is not actual Daemon startup, HTTP ACK-loss, packaged Electron
or GUI evidence. Raw earlier failures are retained, including public no-op and
closed-pending fixture misuse; they were not hidden by removing assertions.

## Actual startup blocker and next gate

Four native product cases using actual default Daemon startup remain blocked
before MCP/native stage acquisition. Startup's default Keychain status probe
enters the original controlled `keychain_security` source without a protection
domain. Its fixed source history therefore closes actor coverage, and Registry
correctly refuses `protected_host_actor_coverage_unknown`.

The next implementation must preserve the Keychain probe and certify its fixed
Host-controlled execution domain. Removing the probe, clearing coverage,
reclassifying the launcher as user-external or using its absolute executable
path as proof would weaken the contract and is not an accepted fix. These four
cases must then pass through actual startup and MCP before packaged acceptance.

Formal CLI artifact bootstrap, final packaged identity/signature/Electron
readback and macOS Computer Use acceptance remain required. The prior
[lease checkpoint](office-lease-checkpoint-2026-10-07.md) remains historical
evidence for its own slice.

## Landing status

PR #507 remains Draft and unmerged; its required CI has not started because of
GitHub account payment/spending-limit restrictions, and independent approval is
still required. PR #509 has actual build/license and major migration failures.
This checkpoint is safe progress preservation, not merge readiness. Local
targeted tests do not substitute for either external gate.
