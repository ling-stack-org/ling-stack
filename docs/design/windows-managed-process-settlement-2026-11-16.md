# Windows managed process settlement — 2026-11-16

Status: implemented for GitHub-hosted Windows packaging
Scope: `runManagedNode` observation and lease release; not whole-host sandboxing,
clean-machine installation, signing acceptance, or public release readiness.

## Problem

The POSIX supervisor proves settlement by probing the detached process group for
`ESRCH`. Windows previously returned `group_observation_unsupported` for every
run, so managed resource preparation could never complete even when the direct
child exited successfully. That made the Desktop release Windows job impossible
before packaging started.

## Contract

- The supervisor records the direct child PID, then samples
  `Win32_Process(ProcessId, ParentProcessId, CreationDate)` through the built-in
  PowerShell while the child runs.
- Descendants are followed from observed parent links. PID plus creation time
  prevents a reused PID from being accepted as the prior process.
- After the direct child closes, a fresh process-table observation must show
  every tracked PID absent before the managed lease may be released.
- A failed or unavailable observation is `unknown`, not absence. A still-live
  tracked PID is `present`. Both retain the lease and failed scratch.
- Failure termination applies `taskkill /T /F` to the root and every tracked
  descendant PID. Termination is intent; only a later fresh absence observation
  authorizes release.
- A descendant that leaves the observable Windows parent relationship before any
  snapshot is outside this bounded proof. GitHub-hosted ephemeral VM teardown is
  not treated as process-settlement evidence inside the job.

## Validation Boundary

Focused portable tests cover nested descendants, live residual children, empty
snapshots, and PID reuse. The definitive runtime check is the Windows x64
`desktop-package-build` workflow executing the managed browser contracts and
`prepare-desktop-candidate.mjs`. This evidence does not claim signed Windows
installation, GUI acceptance, or `releaseReady=true`.
