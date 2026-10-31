# C01 project module inputs — source checkpoint

Status: source implementation and scoped independent review passed; not in the
running packaged App. Overall E6 acceptance/PR/main remain open.

## Retained failure and repair

C01-R2's real approved CLI failed because only cli.js and records.csv were
explicit inputs; its ledger.js import had no dependency authority. The original
workflow/run remains blocked. No historical repair or broad workspace mount.

The new Host-compiled `node_module_closure_v1` requires a separately quoted
current-user project directory. Imports are dependency facts, not permissions.
Existing no-scope plans retain explicit-file semantics and now fail preparation
as `dependency_scope_required`/`not_started`, rather than execute a missing module.
See `docs/design/restricted-command-project-inputs.md` for exact supported module
syntax, native capture/ownership checks, budgets and package-boundary limits.

Acorn 8.19.0 was already locked/installed. Its Daemon importer is now explicit.
An offline lockfile-only attempt failed on an unrelated uncached keyring
metadata entry; the importer was precisely synchronized, without downloading or
rewriting the rest of the lockfile. No clean-install verification is claimed.

## Actual receipts

- Binding RED1/4 -> GREEN; independent boundary RED5/7 before repairs.
- Final three pure candidate tests: 27/27, exit0.
- Adjacent binding/native decoder/bootstrap regressions: 77/77, exit0.
- Final Contracts: 95/95, exit0; Core no-emit and candidate Daemon tsc exit0.
- Real native helper plus Electron Node mode: 15/15, exit0; CLI imports ledger
  and returns10000, dependency hashes and parent provenance survive, unrelated
  private.js is not captured, origin access remains denied. Hardlink/symlink,
  open package boundary, approval/owner/cancel/no-scope protections are exercised.
- Final independent reviewer `/root/c01_dependency_boundary_review`: zero
  remaining confirmed findings in the selected scope, independent8/8 exit0.

Logs: `project-inputs-final-delta-20261024.log` and
`project-inputs-final-native-repaired-20261024.log`. The earlier native log
with two failures is retained: fixture lacked a separately quoted root source;
only fixture provenance was corrected, not the production guard.

Final reviewed source SHA256 for node-command-inputs.ts:
`33b4f5acf317b04b232fdeb7194ee0ef3f878a8bc8f50cb6ea8afaf9243ce30b`.
Reviewed boundary test SHA256:
`5cc247cac3d7a37bab3d9cc97886401bbf8563ff1c46a525362c26718b893235`.

## Broad regression and newly discovered work

The original isolated519-file Daemon regression is still running as exec52731,
PID50145. Do not restart it or overwrite its dist while live. Its log is
`project-inputs-daemon-full-20261024.log`. Candidate deltas build separately in
`project-inputs-final-build/` using a loader that remaps outputs only, no stubs.

Three channel-workspace failures were independently reproduced (3/3 fail,
actual exit1) against the final candidate. Log:
`project-inputs-channel-failures-probe-20261024.log`.

1. Hard-summary test assumed the removed1024-token artificial input floor. Its
   1800 window minus512 output/512 overhead is776; summary requires >=1024.
   Use a real2400 window for that test's intended proactive-summary contract.
2. Two workflow tests found an actual regression: freezing the accepted rendered
   task also copied private role memory into durable task.prompt. Keep strict
   accepted-task checkpoint lineage, separate role-memory hydration from that
   task, and keep the exact frozen Runner input for recovery.
3. Independent tracing additionally found frozen execution bodies crossing raw
   Run/WorkUnit public responses. A dedicated public DTO projection is being
   implemented; an entire-response canary and unchanged internal frozen recovery
   payload are required, not only assertions on task.prompt.

No GUI pass, new package, commit/push/PR/main or total E6 completion is claimed
by this source report. Next: close these regressions, final delta review, save
checkpoint, reviewed-input package and new full original two-required C01 task.

Still open separately: relative `../` binding/command cwd semantics, real
SSE/Daemon recovery, dynamic delegation/Office matrix, and H09 hard output cap.
