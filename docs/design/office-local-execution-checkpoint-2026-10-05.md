# Office local execution checkpoint — 2026-10-05

## Current user-requested remote WIP checkpoint

This checkpoint preserves the new work after parent
`5cdd65d5751107110a82fb89794309a116ef61f0` on
`codex/e6-safe-continuation`, for the existing open Draft PR #507. It is a
backup, not a release, merge, version bump or completed E6 verdict. Source,
tests and design documents are included; ignored binaries, logs, QA data,
screenshots and real databases/history are not.

The user confirmed the controlled-process boundary. Unrestricted Full Access,
manual external launches and other unrestricted same-UID processes are outside
the isolation guarantee. **Raw transport alone is not a Full Access grant**:
ordinary conversations without typed workflow metadata also use raw unified
exec after their existing policy/approval checks. Missing restricted dispatch,
legacy workflow status and authorization mode alone must not issue an exemption.

The first uncompleted implementation slice is the original unified-exec raw
physical gate and its durable policy/source separation. This checkpoint does
not implement that gate. Gate refusal must remain genuine no-start; producer
entry, synchronous spawn failure and post-spawn commit failure must preserve
their actual unknown effects. Prepared launches keep their original authority.

The latest icon slice's complete 3244-input manifest still matches at this
checkpoint. Existing focused evidence below is retained without rerunning it;
no new whole-tree build/test, packaged GUI or certified isolation claim is made.
The genuine nested writer positive remains a failing functionality gate.
Remaining Core-owned hooks, per-family profiles/closure, original native
production integration, recovery, packaged Computer Use, combined review and
CI/integration remain open. Public `safe_unavailable` and the U gate stay closed;
the overall D0/E1–E6 goal remains active.

## Fresh pure-replay and cleanup verification (2026-10-05)

Root fresh Core build after the replay source freeze exited **0**, with the actual
terminal result preserved in `office-directory-v2-replay-20261005-01.build-receipt.json`.
The five directory-v2 suites first produced **191/193, exit 1**: two negative
fixture mutators accidentally selected effect parameters instead of binding facts
and threw before the verifier. Only that test helper was changed to visit actual
observation bindings and terminal resource bindings. Both original rejection
assertions remain. Narrow **2/2** and fresh complete **193/193** then exited **0**;
fail/cancel/skip/todo are all zero. The first failure log is retained.

Eight existing Office journal/facts/replay/terminal/migration suites pass
**683/683, exit 0**, also without fail/cancel/skip/todo. All **1296** Core
source/dist/test inputs match the 02 before/after manifests and final full
`shasum -c` check. These facts describe that frozen Core snapshot; subsequent
approval-owner fence work requires its own fresh build and tests.

The verifier returns only frozen `graph_verified_only`, `coreSafe:false`,
`canonicalVisibility:unverified`, `scopeBinding:unbound`, `packaged:false`.
It does not verify SQLite seal authority, a live scope issuer, the absolute
canonical namespace/window, pair settlement or packaged behavior. Cleanup
grammar now accepts actual guarded publication-observer fstat/close history;
unknown resources are not retried or promoted to released state.

The fresh explicit local-addon gate is now **3/3, exit 0**, with zero
fail/cancel/skip/todo: complete actual single-directory and three-directory
OOXML histories pass the full pure replay, and actual FIFO publication failure
passes guarded cleanup observation/history. Generated payloads were 207321 and
207327 bytes, four actual write effects each, with 99 and 119 returned calls.
No fixture calls, snapshots, identities or returned byte hashes replace the
actual native facts. Only preparation/digest/scope-reference envelopes are
explicit pure DTOs, assembled after capture; they do not prove pre-entry
SQLite seals, live issuer or authority. **1881** native-source/addon/Core-dist/
Daemon-dist/conformance inputs match before/after manifests (exit 0).
Log: `office-directory-v2-native-replay-20261005-01.tests.log`.
That manifest is a historical snapshot: the cleanup test was subsequently
hardened so teardown never retries a session close after entry. Its fresh
standalone **1/1, exit 0** and nine-input final hash check are recorded under
`office-directory-v2-cleanup-20261005-04.*`; the full-replay inputs are unchanged.

An independent original-source review exposed a new approval-owner gap: Git
preview refusal occurs after a pending request is created. Root reproduced both
deny and ask paths against the pre-fix Daemon dist: **0/3, exit 1** (parent plus
two children); both durable requests incorrectly remained pending. Log:
`office-approval-preview-failure-20261005-01.red.log`. A second SQLite connection
also reproduced the missing atomic owner/request fence, **4/8, exit 1**.
The source fix now fences the authoritative pending UPDATE by the captured
Run/Attempt and request identity, reconciles the real Harness decision, preserves
the original error and releases only the callback-owned local wait. Unknown
pending state or an external CAS winner is not overwritten. This does not change
administrative decisions which do not carry execution-cleanup authority.

Independent review found one additional contract gap: approve-command-rule
bypassed the deny/cancel-only cleanup guard. Its actual negative test failed
against the old dist (**10/11, exit 1**). A three-line guard at the public approve
entry closes that bypass; approve-once and expiry rejection and existing
administrative behavior remain covered.

Root fresh Core then Daemon builds **04 both exited 0**, with actual tool receipts
in `office-approval-preview-20261005-04.{core,daemon}-build-receipt.json`.
Core focused **11/11** and five adjacent suites **161/161** pass. Daemon focused
**19/19** and ten adjacent approval/Harness/recovery/source-hook suites **205/205**
pass. All fail/cancel/skip/todo counts are zero. The 19 cases include callback
start/abandon failures and two genuinely queued requests with independent pause
ownership; a throwing Host abandon callback is not claimed to prove physical
release. Complete **3242** Core/Daemon source/dist/test before/after manifests and
the final hash check match (exit 0). The first focused **21/24, exit 1** log is
retained: two fixtures injected before preview or omitted the real Host
post-commit event. Only their injection/Host wiring was corrected; execution
fencing and original durable assertions were not weakened. Independent review
found no other confirmed new product defect in this narrow chain.

The post-registration bootstrap failure is separately reproduced against the
pre-fix Daemon dist: **3/7, exit 1**, four targeted failures. Its source-only
fix closes the exact original stage registration, never deletes directories,
and preserves unknown-close evidence. The test-only inventory bypass reaches
that otherwise gated branch and is not production coverage or scope proof.
Fresh Daemon verification is **7/7, exit 0**, with fail/cancel/skip/todo all zero:
`office-native-bootstrap-20261005-02.green.log`. Tests observe actual mkdtemp
creation as well as the original stage registration/FD. Inventory refusal must
create no stage. This still does not prove a complete certified actor inventory,
live scope or packaged GUI behavior.

## Original icon-producer gate (2026-10-05)

The default application-icon producer now exports its exact immutable original
entry. Only an original pre-physical refusal is privately tagged and rethrown
through the two fallback catches; injected runtimes cannot borrow that tag.
Ordinary errors and cache hits retain their existing behavior. The stage refusal
does not enter mdfind/plutil/sips or run the next fallback. The public sips test
uses an explicitly late-attached adversarial gate, preserves earlier unknown
history and observes real temporary-directory cleanup; it is not complete
Supervisor front-door or isolation evidence.

The old-dist public-loader placement failure is preserved in a truthful tool
receipt (Node24, five actual mock-producer entries across two failed cases;
missing-export skips were not successes and are absent from the final tests).
Root Node22 fresh Daemon build exits **0**; focused **11/11** and four adjacent
suites **237/237** pass, all fail/cancel/skip/todo zero. Complete **3244**
Core/Daemon source/dist/test manifests and final check match (exit 0).
Independent review found no confirmed new defect in the frozen source.

An uninstrumented real default-loader run returns the installed VS Code icon as
a **3479-byte PNG**, checks its PNG signature and exact cache object, exit **0**,
simulation=false. The actual native and custom Promise adapters are unchanged.
Log: `office-icon-source-hooks-20261005-02.actual-installed.log`. The first
instrumented run is preserved as a diagnostic only: its observer dropped the
native custom-promisify adapter. Neither run is packaged GUI, certified profile
or descendants-closure evidence. The complete static source manifest stays an
empty sentinel; unknown history is never cleared to obtain a scope.

Logs and receipts use `office-icon-source-hooks-20261005-01.*`. This is a newer
frozen input snapshot than approval-04; the latter's 396 passing tests are not
presented as a whole-tree gate for the icon change. Next: actual unified raw
policy/source separation, Core-owned official-sync/scheduler hooks, remaining
system entries and per-family protection profiles, then original native
production route and the still-open whole-goal acceptance gates.

## Latest directory-v2 continuation (supersedes historical status below)

The controlled-process boundary is confirmed by the user. Full Access/raw/external same-UID processes are not isolated; no privileged helper, different OS principal or ACL change is authorized or implemented. Current HEAD remains `5cdd65d5751107110a82fb89794309a116ef61f0`; subsequent source changes are local WIP, not another push, merge or release.

- Native publication-only 22/22 exit 0 and independent review are closed. Reviewed addon SHA: `157a5435b9dfcbd77e431de6e9a8daf053607951f93272a1a1b232aaefee678f`. This proves original destination-parent-relative historical observations, not the entire canonical absolute namespace or atomic window. Do not rerun the closed native 26/22 slices.
- Core directory-v2 adds exact types/parsers, independent append-only migration 152, records/effects/history/terminal and original journal gate routing. The first actual run was 49/53, exit 1: four real failures shared a nested `readSqliteSnapshot` BEGIN in `launchEffect`. Only two internal reads were changed; public getters retain snapshot semantics. Fresh Core build 02 exit 0 and the unchanged 53 tests pass, exit 0, no skipped/cancelled/todo tests. Complete Core source/dist/test before/after SHA manifests match. Original 01 failures are preserved.
- Daemon build 02 exit 0 follows a corrected TypeScript descriptor-map annotation, with build 01 error preserved. Fresh focused 03 is 26/26, exit 0 (facts 8, graph 5, inventory 8, actual reviewed-artifact identity/cache 5), with complete Daemon source/dist/test plus Core-dist before/after SHA manifests matching. Four failures in focused 02 were read fixtures omitting mandatory original fstat identities; their fixtures were corrected without weakening the parser or assertion targets.
- The separately executed real addon→Daemon→unique Core-schema conformance gate is 2/2, exit 0. It includes real SDK DOCX read/install/publication and an actual foreign FIFO replacement preserving a returned-false result and true node type. This is local Node22 conformance, not protected Host scope, SQLite settlement, Electron packaging or GUI acceptance. Native identity tests live in an explicit `office-local-native-runtime-conformance.mjs` gate, not portable `test:ci`; none were deleted or skipped.
- Real SQLite/Tracker v2 wrapper regressions are now covered by original-entry focused 26/26, exit 0 (Tracker 14, manual UI 2, source hooks 10). Existing adjacent five files pass 87/87 and the separately named dispatch/post-spawn-failure files pass 6/6, all with matching complete 2681-input manifests. The formerly listed nonexistent restricted-command-runtime suite was not executed. See the launcher integration ledger for exact boundaries.
- The next Git/file-open six actual entry exports are connected. Root Daemon build and focused 11/11 exit 0 with complete Core-dist/Daemon-source/dist/test manifests matching. They remain uncertified profiles; raw UI entry identity does not prove a human gesture or isolation. Complete static source manifest remains an empty sentinel.

Logs/manifests are under `output/e6-20260928/office-directory-v2-{core,daemon}-20261005-*` and `office-directory-v2-native-conformance-20261005-01.tests.log`. Only Core 02 and Daemon focused 03 have the matching before/after manifests stated above; the first conformance run is not retroactively presented as a before/after manifested run.

Remaining gates: remaining actual source-owned launcher hooks and certified per-family profiles (the immutable sentinel remains empty); fixed native adapter and original MCP reservation branch; complete replay/canonical namespace/closure/terminal/pair; retained genuine nested positive and independent existing-parent/overwrite/ABA; live recovery and fresh packaged macOS Computer Use; combined review/CI/integration. Post-register original-stage FD failure cleanup and the narrow preview/fence/wait chain are now closed by the evidence above, not whole-goal acceptance. The native directory-picker entry is explicitly the nineteenth raw UI source; it is connected, not a scope/human-gesture proof. Canonical remains unverified, public receipt remains safe_unavailable, and U/whole-goal acceptance remains closed.

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
2. Bind the new native directory primitive to the original Host protected scope,
   Core directory/install graph and fixed writer. The six fixed production MCP
   routes are now connected locally, as detailed below. Untracked legacy calls
   still use `OfficeArtifactService`; that path is not the tracked authority.
3. Restore retained original positive tests, run affected standard suites and
   current-input full gates. Preserve actual failures and do not weaken authority.
4. Complete original live/restart/answer continuation/ACK/delivery/recovery/API/UI
   checks, then fresh packaged macOS Computer Use, combined review and CI.

Full Access currently has no filesystem sandbox. A protected staging namespace
must therefore be demonstrated, not silently assumed; changing OS privilege,
installing a system helper or changing Full Access semantics requires a separate
explicit decision. This backup does not approve such a change or defer the
native functionality requirement. D0/E1–E6, U/T and Harness remain active.

## Continuation after the saved checkpoint

These are new local continuation facts, not another push or completion claim.

- Corrected the externally replaced directory **negative** to expect the exact
  unobserved `office_local_snapshot_changed` fact. It now also checks real mkdir
  replacement, zero byte writes, empty preserved directories, original absent
  ownership, zero publication/resources, only one actual mkdir effect and both
  original blockers. The genuine nested-directory **positive** remains unchanged.
- Current writer file: Node 22.22.1, PID 63229, terminal exit 1, **40/41**, no
  skipped/cancelled tests. The sole failure is the retained nested-directory
  positive at line 731. Local log:
  `output/e6-20260928/office-writer-current-20261005.log`.
- Actual native isolation probe: Host PID 63737, terminal exit 0, five actors
  actually executed under UID 501. The new Seatbelt workspace-write control
  writes its workspace and scratch but receives EPERM for all thirteen tested
  Host staging/ancestor/signal/IPC operations. Real packaged typed runtime uses
  verified existing resources; typed Full Access and workspace preset both
  restrict writes to scratch and reject those Host operations. Raw Full Access
  and external same-UID actors actually mutate the staging/ancestor and connect
  to the disposable IPC fixture. Mode 0700 is not same-UID isolation.
- The initial probe's incorrect preset fixture is preserved as an invalid-label
  run, not Full Access evidence. The corrected script and fourteen input hashes
  match before/after. Local corrected log and bounded report:
  `output/e6-20260928/office-sandbox-domain-probe-20261005.corrected.log` and
  `output/e6-20260928/OFFICE-SANDBOX-DOMAIN-PROBE-20261005.md`.
- The probe proves kernel behavior only for these actors, not Store admission,
  an installed Office creator runtime, all IPC/debug vectors, or GUI acceptance.
  Input refs are empty; there is no input-capture proof in this probe. No product
  permissions, ACLs or installed helper were changed.

The user explicitly selected the controlled-actor boundary: unrestricted Full
Access/external same-UID processes are outside the isolation guarantee. Do not
introduce a different OS principal or privileged service. A native creator
implementation still needs actual protected staging, original directory handles,
atomic no-replace installation and persisted boundary facts; this decision alone
does not turn the existing path-based writer into that capability. Raw legacy
commands cannot be described as sandbox-protected merely from a preset label.
Six-tool production wiring and its admission/exception regressions continue
independently. Do not rerun the completed isolation probe merely after compaction.

## Current production MCP wiring and native primitive

These changes are local WIP after saved HEAD
`5cdd65d5751107110a82fb89794309a116ef61f0`, not another commit/push or merge.

- The original `createMcpToolCallHandler` now synchronously reserves the original
  MCP parent and `office-local-binary` producer before its first await/observer.
  The original registered Office factory dispatches only the fixed six tools to
  the existing coordinator. It does not reserve a generic transport producer or
  invoke the supplied legacy facade callback for tracked owned execution.
- Owned input and a private, once-bound MCP forward-authority frame survive
  reservation-to-plan transfer. Every forward effect checks original source,
  permission revision, factory identity and cancellation before preparation and
  immediately before native launch. Revocation stops new writes without stopping
  original-resource cleanup. Cleanup still requires original Core/resource scope.
- Broker identity uses an own data descriptor, never an accessor. Three captured
  method calls use `Reflect.apply`, not a mutable function `.call` property.
  A cycle/BigInt digest exception before coordinator entry remains genuine
  no-start; it cannot invent a prepared execution or strand a generic producer.

Fresh final Daemon TypeScript build exited 0. Against that exact build on Node
22.22.1: production route file **39/39**, original accessor repro **2/2**, original
function `.call` repro **1/1**, and seven adjacent standard files **128/128**,
all terminal exit 0. Six after-open/before-native revoke/cancel/factory cases
record zero new forward writes/native calls/preparations and one original FD
cleanup close. Nineteen route inputs match before/after SHA256. Local evidence:
`output/e6-20260928/office-local-mcp-*-20261005.reflect-apply*.log` and matching
`office-local-mcp-20261005.reflect-apply.route-inputs-*.sha256`.

The genuine revoke-before-write RED and accessor/function-call replacement REDs
are preserved separately. The earlier incorrectly nested revocation injection
was a fixture failure, not proof of a product vulnerability. No original nested
positive was deleted, skipped or changed to expected-blocked.

New `native/office-local/` contains a synchronous N-API 8 macOS primitive with
original ancestor/resource FDs, exclusive private-tree construction, explicit
write/fsync/close and a single `renameatx_np(RENAME_EXCL)` subtree install.
There is no ordinary rename/copy/merge fallback or unowned path cleanup. FD and
syscall-result slots are allocated before native entry; returned acquisition is
attached without allocation; post-effect exceptions stop new forward effects.
Unknown close tombstones the original integer before one close, never retries it
or closes a later foreign FD reusing that integer.

Final explicit local build `office-native-build-20261005-05` and tests
`office-native-tests-20261005-03`: **14/14**, exit 0, no skips/cancellations, exact
build/test source match, before/after match and no disposable fixture residue.
The independent frozen-source reviewer verified those hashes/results and found
no additional confirmed defect in this narrow primitive. See its README and
local `output/e6-20260928/OFFICE-NATIVE-PRIMITIVE-20261005.md`.

This is **LOCAL_PRIMITIVE_CONFIRMED / PRODUCT_SCOPE_UNBOUND**. Snapshots remain
`scopeBinding=unbound`, `protectedStageVerified=false`, `coreSafe=false`. It does
not issue original Core tickets, receipts, a sandbox manifest or COMMIT ACK.
Real OOM/N-API marshalling faults, close EINTR, EXDEV/ENOTSUP and process-loss
windows are not established by the fourteen tests. Core v2 graph, protected-scope
bootstrap, writer integration, existing-parent overwrite/leaf ABA, packaging and
fresh GUI acceptance remain required. Do not enable this unbound primitive as a
product capability or substitute its positive for the retained writer positive.

Current-input full Daemon verification finished after these MCP changes, with
all Core/Daemon product sources, standard tests and dist frozen: **2949/2950**,
terminal exit 1, zero skipped/cancelled tests. The sole failure is the preserved
genuine nested-directory writer positive at line 731, `office_local_write_failed`.
This is not an all-green result and must not replace the remaining native gate.
Its local log is
`output/e6-20260928/office-mcp-current-daemon-full-20261005.log`, original input
manifest `office-mcp-current-full-20261005.inputs-before.sha256`. All **3833**
inputs match the after manifest; final `shasum -c` and before/after diff exit 0.
The original handle 8306 is collected and closed. Do not wait for or restart
this completed run after compaction or borrow the preceding 2892/2892 result.

### Next bounded integration slices

The original v1 verifier remains strict. The native primitive must not be cast
into a v1 observation or passed to the old writer as a replacement mkdir callback:

1. **Native facts/read lifetime** (native-only work in progress): record actual
   syscall success/errno and full original-FD identity; read original retained
   output bytes before explicit close, with the existing 50 MiB cap, exact byte
   budget plus a real EOF probe and matching before/after original-FD identities.
   A path reopened after publication is not the same resource. A returned
   `success:false`/EEXIST must never become a successful v1 rename observation.
2. **Original Host scope**: existing production restricted-command preparation
   currently passes no protected Host write roots. Add a private Host issuer
   bound to the actual runtime/backend, original execution and actual stage plus
   renameable ancestors. Check the scope at native entry. Caller booleans,
   configuration labels, copied manifests and digests do not issue this scope.
   The user-selected controlled-actor guarantee must be persisted explicitly;
   unrestricted Full Access/external same-UID isolation is not promised.
3. **Core v2 fixed directory/install graph**: cover every acquired ancestor and
   created resource, native entry/return outcome, original parent relationships,
   protected creator window, readback-before-close, one no-replace subtree install,
   all original closes and terminal publication visibility. A batch close must
   retain each original resource's outcome. Failures/unknown ACK preserve the
   original pair and residue; no replay may recreate a ticket, resource or syscall.
4. **Daemon adapter, functionality and package**: fixed writer invokes the bound
   primitive only inside original effect admission. Restore the unchanged nested
   writer positive, then independently prove existing-parent overwrite/leaf ABA.
   Package the addon with final signed App/resource identity and verify Electron
   N-API before any fresh macOS GUI completion claim. The local clang binary and
   fourteen primitive tests are not that product/bootstrap evidence.

These are required implementation gates, not a new product-scope decision or
permission request. Full Access's selected boundary does not relax Core replay,
publication visibility, original resource closure or the public U gate.

## Native facts and readback slice — fresh local evidence

Native protocol 2 now includes explicit syscall return-state/success/errno,
complete original-FD identity (size, mtimeNs, ctimeNs, mode/type, device/inode)
and a retained original-file readback window before explicit close. A caller's
path cannot select the read FD. Initial acquired node/type remains the authority:
a later fstat cannot adopt a foreign descriptor that reused the original integer.

`readFile(session, originalFileCap, expectedBytes, budgetBytes, operationId)`
requires an already-fsynced retained original file, an exact `expectedBytes + 1`
budget and a 50 MiB payload cap. It uses bounded pread chunks, a real one-byte
EOF probe, matching before/after original-FD identity and once-only operation
identity. Each attempt, including EINTR/short IO, consumes the finite syscall
budget; read/write Call slots are reserved before IO. Exhaustion blocks forward
effects and preserves returned facts. This is not a timeout or a promise that a
single blocking pread/fsync can be interrupted. Payload bytes are not cached in
session history for an implicit retry.

Fresh explicit build `office-native-readback-build-20261005-01` and tests
`office-native-readback-tests-20261005-01`: **25/25**, terminal exit 0,
signal null, no skips/cancellations and no disposable fixture residue. The old
fourteen cases remain, plus eleven readback cases. Root independently checked
current source against the final evidence and before/after manifests; both match.
Addon SHA256 is
`083b4c20de4565b32b4cc001ad2b6e94d03a1139b6d133505f8e642de0024a59`.

- Actual 50 MiB reads use 800 preads plus a real EOF probe returning zero.
- Actual path ABA still reads the original inode, not the replacement leaf.
- Actual FD close/foreign-number reuse refuses pread and foreign close; unknown
  close remains unknown and cannot gain read authority.
- Test-only one-byte libc IO wrappers prove finite short-IO budget exhaustion.
  These are explicitly **injected wrapper behavior**, not actual kernel short IO,
  EINTR, ENOTSUP or EXDEV evidence.

The twenty-five-case snapshot is intermediate, not the final native verdict.
Its review found a confirmed original-FD lifetime bug: actual fstat EBADF left
the old integer retained; a later foreign FD reuse could be closed by either
explicit session close or abandonment. Fresh unchanged-runtime build/test
`office-native-readback-*-20261005-02-red` ran **25/26**, exit 1, with the sole
new regression reporting actual EBADF, missing tombstone and foreign FD closed
in both chains. No fake errno or import/fixture failure was used for that RED.

The narrow fix tombstones only actual EBADF to `unknown/-1`; other fstat errors
do not establish that the original lifetime is gone. Fresh build/test
`office-native-readback-*-20261005-03-green` ran **26/26**, exit 0, signal null,
no errors/skips/cancellations/residue. Both real explicit-close/abandonment
chains now preserve the foreign FD. Root checked current source against the
final before/after inputs; all match. Final addon SHA256:
`db4e7ae305c26873697b06d82af7e5a1a42d98dad86ded03df0bb8ecd8098817`.
The independent reviewer completed the final frozen-snapshot review. Eleven
live inputs match all four build/test manifests; the three produced binary
identities match the recorded hashes. No additional confirmed defect remains
in this native-only slice. No completed native run needs to be restarted after
compaction.

Core/Host scope/packaging remain unconnected; all native `unbound/false/false`
flags remain unchanged. The retained writer positive is still the product
functionality gate. The Host protection-domain registration slice is being
implemented separately and has not yet been built/verified. A finite active
scope budget cannot become a permanent per-Daemon command-count limit; completed
stage tombstones and old actor policy coverage must be separated from active
resources without inventing descendant quiescence from child exit.

## Controlled Host protection domain — implementation and first run

The user's selected boundary is controlled processes only. Full Access/raw
commands and external unrestricted same-UID programs are not isolated from Host
staging. No different system user, privileged helper, ACL change or additional
service is introduced. The creator window requires protection from mutations
and file-data/executable-map access; the existing global metadata allowance is
unchanged and does not promise pathname or metadata secrecy.

The Supervisor now owns one registry, shared by the restricted command runtime.
DB-backed original-source tokens bind the Run, owner/fence, workspace policy and
its revision before preparation. Every owned prepared launcher is bound to its
actual policy, profile and backend. Existing actor coverage is conservatively
retained without inferring descendant quiescence from leader exit. Closed stage
tombstones use a weak map; active-stage limits do not become lifetime command
or stage-count limits. Original FD loss/reuse is tombstoned; errors that do not
establish loss preserve the original cleanup obligation.

Fresh Node 22 Daemon build `office-protected-host-staging-20261005-01.build.log`
exited 0. The first focused run exited 1: **21/22**, no skips/cancellations. Its
sole failure was an invalid negative fixture: changing `allowedWritePaths` to
`["."]` did not change the original policy. This is not a demonstrated product
bypass or a passing gate. The original log is retained and the next run must
use a genuinely different policy, without dropping its rejection assertion.

Independent source review also found a real domain-modelling omission: actual
Seatbelt fixed device rules and the imported OS bootstrap profile grant scopes
outside `policy.filesystem.readRoots`. The model must include these actual
implicit permissions before issuing any stage protection. The planned narrow
fix uses a reviewed exact bootstrap-source manifest tied to the real backend,
not a partial Scheme interpreter. Unknown bootstrap versions close only Office
protection; ordinary no-stage restricted commands remain available. Stage
registration and subsequent checks must independently verify this fact, even
when no actor has been prepared yet. Private UID/mode constraints are additional
checks, not creator or kernel-isolation proof.

The correction is now implemented and frozen. Snapshot 02 Daemon TypeScript
build exited 0, as recorded from Root's actual terminal result in
`office-protected-host-staging-20261005-02.build-receipt.json`; an empty build
log is not used as independent proof. The first 02 focused run was **23/24**,
exit 1: the nested scratch fixture's default 0755 triggered the new private-stage
guard before the intended topology rejection. Snapshot 03 changes only that
fixture to explicit 0700 and keeps the strong topology rejection assertion.
Both first-run logs are preserved; neither fixture failure is a product RED.

Final snapshot 03: narrow **1/1**, full focused **24/24**, seven adjacent files
**100/100**. All actual terminal exit 0, zero fail/cancel/skip/todo. The 24
focused cases include 258 real controlled commands and 66 close/re-register
stage lifetimes, before/after-stage actors, bootstrap unknown, source/policy
obsolescence, actual EBADF/FD reuse and explicit cleanup. EIO/EINTR wrappers and
bootstrap byte corruption are test-only injection, not spontaneous kernel faults
or a mutation of the real OS profile. Ten slice inputs match before/after/final;
all 3299 adjacent source/dist/test inputs match before/after and current SHA
checks. Root and the independent reviewer checked the results and bindings.
The review concluded DONE_WITH_CONCERNS for this typed-actor slice only.

The exact reviewed dyld SHA is
`bdfc2354c683c8fb95a39e63fbc8610e9739b0256c89ab880564edefbe73a5ce`.
The manifest deliberately preserves existing non-file dyld syscall/fcntl
permissions and Apple-internal conditional MIG/JETSAM/sysctl privileges; it
does not claim blanket absence of Mach or sysctl access. A different OS source
requires review before this Office protection domain is accepted. It does not
turn an unknown bootstrap into a permanent no-stage command-count restriction.

This registry does not yet issue a native session, Core v2 directory graph or
safe receipt. The original nested writer positive and packaged GUI acceptance
remain incomplete. No current-input all-green Daemon result is claimed.

The typed registry is not all-launcher coverage. The old generic
`platform-native.ts` profile includes `/tmp` and `/private/tmp` writes, while
the runner sandbox binding is not this original prepared launcher. Future
bound native issuance must use the same Supervisor registry and account for all
relevant controlled actors, or explicitly fail closed for unknown coverage.
Do not infer coverage from `policyVerified`, runner labels or stage registration.

The next integration contract is recorded in
`docs/design/office-local-directory-native-v2.md`. It requires a separate strict
missing-subtree-no-replace graph, actual success/errno and per-resource batch
facts, original source/pair authority, canonical publication visibility and
unknown-ACK preservation. This document is a pending implementation contract,
not a new functional or safety completion claim.
