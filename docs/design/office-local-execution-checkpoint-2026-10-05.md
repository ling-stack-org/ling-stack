# Office local execution checkpoint — 2026-10-05

This is an additional user-requested WIP backup to existing Draft PR #507,
not a release, merge, production cutover or complete acceptance verdict.
The preceding saved commit is `2efeb51a98f179f4c4b97accfef577c4fb8114a4`.
Only the dedicated E6 continuation branch, `codex/e6-safe-continuation`, is
included. Other worktrees, real databases/history and ignored QA artifacts
are not part of this checkpoint.

## Saved implementation

- `office-local-members.ts` rejects initially absent directory ownership derived
  from a post-mkdir path stat or a caller-supplied directory identity. An existing
  directory transition must retain its original node identity.
- `office-local-authority.ts` latches the original snapshot read before native
  callbacks can reenter settlement. Only its exact successfully returned snapshot
  proves original readonly closure. Failed capture or unknown preparation ACK
  cannot downgrade to generic no-start. Premature settlement closes preparation
  irreversibly, even when that settlement is refused.
- New `office-local-execution.ts` coordinates the fixed six create/edit tools:
  synchronous original-role reservation, owned input/snapshot, real SDK bytes,
  fixed writer and original Core atomic settlement. It does not fall back to the
  old service, open the public U gate or grant execution authority to callbacks.
- New standard directory-boundary and coordinator tests exercise actual native
  FS calls, SDK artifacts, migrated isolated SQLite and original capabilities.

## Current evidence and limitations

The author files were frozen before the Daemon TypeScript build (exit 0).
Two new narrow suites ran against that build on Node 22.22.1:

- Directory boundary: **2/2**, exit 0, PID 52289. The actor really substitutes a
  foreign inode after mkdir returns. Subsequent writer mutations inside that
  directory are zero; no target is published; both blockers remain, releases
  are zero and native FDs close. Caller identity alone cannot claim ownership.
- Execution coordinator: **17/17**, exit 0, PID 52344. Real xlsx/docx/pptx
  create/edit, recovery bytes, reserve-before-await, input ownership, cancellation,
  required-input/source fencing, retained readonly FD, early no-start reentry,
  lost preparation ACK, native write failure and existing-parent paths pass.
- Independent static review found no additional blocking finding in the narrow
  coordinator/authority/member change. It is not a full-branch pre-landing review.

The directory regression previously failed against the old dist: original
real repro **0/1**, exit 1; standard suite **0/2**, exit 1. The foreign directory
received four actual mutations (open, write, link, unlink). The old writer and
terminal reported published even though final Core settlement refused safe.
The new coordinator's initial missing-module import failure is a build/collection
failure, not a product RED. Do not conflate these evidence categories.

### Preserved failing functionality gate

This guard is **containment, not native directory creation support**. The
existing genuine nested-directory positive at
`packages/daemon/test/office-local-writer.test.mjs:731` was run unchanged with
`node --test --test-concurrency=1 --test-name-pattern='^Office real SDK bytes
publish through exact SQLite effects without safe settlement$'
packages/daemon/test/office-local-writer.test.mjs` (one continuous pattern).
It remains **0/1**, exit 1, PID 54459, `OfficeLocalWriterError`. It has not been
deleted, skipped or changed to expected-blocked. Native creator-bound support
must restore this real capability before release or merge.

The previous Daemon full 2892/2892 and Core full 2019/2019 belong to the preceding
observation-boundary input snapshot. They do **not** prove this new WIP is fully
green. No new full-suite, live production-route or packaged GUI acceptance is
claimed by this checkpoint.

## First incomplete gates

1. Establish the actual native authority/threat boundary and implement complete
   creator-bound directory creation/install. Post-mkdir lstat, UUID, mode 0700
   and same-UID advisory locks alone are not creator proof. Existing-parent leaf
   replacement/overwrite races are a separate required boundary.
2. Connect the six fixed production routes through the original handler/factory,
   opaque source and Office reservation/settlement capabilities. Currently the
   production broker still uses `OfficeArtifactService`; generic MCP admission
   rejects the owned Office facade before reaching the new coordinator.
3. Restore retained original positive tests, run affected standard suites and
   current-input full gates. Preserve actual failures and do not weaken authority.
4. Complete original live/restart/answer continuation/ACK/delivery/recovery/API/UI
   checks, then fresh packaged macOS Computer Use, combined review and CI.

Full Access currently has no filesystem sandbox. A protected staging namespace
must therefore be demonstrated, not silently assumed; changing OS privilege,
installing a system helper or changing Full Access semantics requires a separate
explicit decision. This backup does not approve such a change or defer the
native functionality requirement. D0/E1–E6, U/T and Harness remain active.
