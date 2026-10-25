# P3 standard complete-dist regression receipt

## Verdict

Daemon full regression passed at ordinary product module/resource URLs.
This is automated isolated execution, not packaged GUI/E6 acceptance.

- Implementation checkpoint: `b3c1937cd8fb5dac8515ca0d2249a23ff959a876`.
- Only post-checkpoint test delta: `run-request-permission-axes.test.mjs`
  independently separates exact raw SQLite/Store snapshots from HTTP public
  projection. Four private keys must be absent; all original permission,
  source-immutability, receipt and no-replay assertions remain.
- All1541 candidate versus ordinary contracts/core/daemon `.js` files matched.
- Full runner: `run-p3-standard-dist-full-20261025.mjs`, exec27515,
  wrapper66288/child66291, actual exit0, terminal receipt at
  `2026-10-24T21:41:49.087Z`.
- Full result:523 files;7546 tests;7534 pass;0 fail;0 cancelled;12 existing skip.
- All8808 source/test/dist/native inputs unchanged before/after:
  `5f5d966ba03ce18cdcb94451a5790e5302f12fab79d47b1e751848e749d0245d`.

## Evidence fingerprints

| Evidence | SHA256 |
| --- | --- |
| `p3-standard-dist-full-20261025.log` | `2c82488dbc3afd26f17f1daff7589c1c7b78692c31a602cf34e84cf62a4408e4` |
| `p3-standard-dist-revalidated-20261025.log` | `0f563a7ac0b0f10863de301a63f4a9d69649cfb0669485d369389b6fca364814` |
| `p3-permission-axes-standard-dist-fresh-20261025.log` | `11605b139a131e64e13df31ce6983cb2ce2693a2e64a60f5cd5ffb0d44afcf99` |

Targeted standard-dist70/70 and independent A27 19/19 both actually exited0,
with zero skips. Original candidate full result7492pass/42fail/12skip remains
unchanged; it is not relabeled. Its42 count consists of38 leaves plus4
codesign parent aggregates, classified in the independent report. Separate
same-image resource probe and same-bytecode standard-URL execution discriminate
the external candidate resource/identity effects without weakening product
codesign or sandbox checks.

## Remaining gates

Checkpoint preservation: local commit `93de59fb` retains the raw package and
regression logs without whitespace normalization. Source whitespace validation
excludes only the raw package log's tool-generated ANSI/trailing whitespace.
The pre-push credential finding is the literal rejected-login negative fixture
from `packages/daemon/test/codex-login.test.mjs:102`, not a real credential;
the repository allowlist records only that exact sample, without bypassing the
hook or broadening credential patterns. Test revision numbers and synthetic
network-rejection cases may still be reported as nonblocking PII-shaped values.

Mac remains locked in the latest built-in Cua response; no alternate driver or
authentication bypass was attempted. New QA package is real and identity-verified,
but C01-R3 Engineer success plus QA expiry is not required fan-in or full project
success. Relative command-cwd/source binding, genuine reconnect/restart,
delegation, Office GUI and H09 hard cap/person-performed checks remain open.
No new PR/main merge, CI re-enablement, Windows work or release is asserted.
