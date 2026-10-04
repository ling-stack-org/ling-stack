# Office writer observation and no-start boundary

## Scope and status

Continuation of the current E6/U implementation, after the saved no-start
checkpoint `178f1169`. This is not a release, packaged acceptance, or completion
of D0/E1–E6/U/T/Harness. Public user-input admission remains disabled until the
whole production/recovery/GUI chain is proven.

## Confirmed failure

Two actual Node FS/SQLite scenarios returned `known_no_start` and released both
original barriers while a real readonly target FD remained open:

1. Terminal INSERT was rolled back by a COMMIT failure before native COMMIT.
2. Terminal artifact creation failed before the original seal API was entered.

Both had zero mutating callback/native/effect entry. The original receipt reader
checked resources only if a persisted terminal existed. A missing terminal was
incorrectly treated as absence of resource observation. A retained terminal
claim alone did not protect the artifact-before-seal case.

## Authority chain

`fixed writer -> Tracker -> original Core ticket -> pair/owner/forward gate`

- Before the writer can retain even a readonly native resource, Core latches
  `writerObservationStarted` on the original WeakMap-owned execution state.
- The bit is monotonic across COMMIT rollback and lost acknowledgement. It does
  not mark either journal role as mutating/launched.
- Admission already closed: reject outside all final-observation paths. Do not
  open resources or fabricate a failed terminal merely to explain rejection.
- No-start first permanently closes the original Office lifecycle. If observation
  started or a seal claim exists, the exact original persisted terminal must be
  present. Validation failure retains both blockers and does not pin a receipt
  digest/timestamp.
- A failed terminal can support no-start only when it is unpublished, every
  resource is an actually closed member-read resource, and all existing exact
  effect/descendant/history checks also succeed.
- A never-observed original ticket may still close as genuine no-start. Empty
  persisted rows, reconstructed tickets and caller booleans remain insufficient.

## Persistence reconciliation, not execution retry

After no-start closure rejects a missing terminal, only the fully identical
pre-existing `sealClaim` may use the dedicated terminal persistence gate. It
revalidates the original live pair/current owner, admitted/launched roles, and
absence of a settlement/receipt intent. No new artifact/digest, resource read,
child, forward effect or generic closed-lifecycle mutation is authorized.

Artifact-before-seal failure has no retained claim and remains blocked; this
change does not invent a manifest or reopen the original writer.

## Historical evidence

The canonical no-start payload now includes
`terminal: null | { terminalArtifactId, terminalDigest }`. Every public history
read requires exact existence/identity/digest equality and both fully verified
canonical journal roles. Deleting/replacing a bound terminal is not converted
into a weaker no-terminal proof. SQL tables/columns are unchanged; no backfill
or real history mutation is performed. Earlier unverified WIP payload shapes
are not upgraded into authority by a compatibility reader.

## Verification record

Raw RED and corrected runs remain separate. Two expected-error-code assertion
mistakes and outdated reservation retry assertions are test defects, not product
RED evidence. The meaningful product RED is the actual retained-FD failure above.

- Core/Daemon builds: exit 0 after the product change.
- Migration 151: 115/115, exit 0, real isolated populated upgrades, rollback,
  CHECK/FK/append-only/OR REPLACE boundaries.
- Corrected original Office matrix: 94/94, exit 0; independent original terminal
  suite also passed on the same frozen product build.
- New native resource boundary: final 5/5, exit 0; both real retained-FD scenarios
  retain terminal=0, receipt=0, blockers=2, local releases=0.
- Current Core full: 2019/2019, exit 0. Product inputs are frozen; later only one
  Daemon-only test assertion changed from an unprefixed to its actual typed code.
- Daemon final full: 2892/2892, exit 0, with zero failures/cancellations/skips;
  original handle 37204 was collected to completion, not restarted. The final
  3821-input manifest was rechecked after completion, exit 0. The old 2872
  baseline and deliberately interrupted intermediate run are not this result.
- Independent closed-readonly positive: 1/1, exit 0. The original target FD
  was actually read and closed (then EBADF); a complete failed terminal enabled
  original-ticket no-start with exact terminal binding. Independent SQLite
  readback confirmed pair COMMIT before binary and parent barrier release.
- Independent product-path review: no additional blocking finding, read-only.

Detailed receipts/logs are in the local E6 acceptance directory. This record
does not establish creator-bound directory authority, six fixed Office production
routes, full user-input continuation/delivery/restart recovery, packaged GUI or
combined review/CI completion. Those remain mandatory next work.

## Remote checkpoint boundary

The user requested an additional WIP backup to existing Draft PR #507. This
checkpoint contains this observation-boundary implementation, its standard
regressions and this design record. It does not upload ignored QA databases,
native fixture output, packaged apps, screenshots or credentials. No main
merge, release/version bump or history rewrite is part of this save request.
