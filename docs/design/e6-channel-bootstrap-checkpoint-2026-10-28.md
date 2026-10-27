# Channel startup and policy QA checkpoint

Implementation tree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
Package currently available for policy QA: commit `3d5b0174`, ASAR
`d87f3a7f1e3cfec7c46db3ec6e0edb1f2d21927543a2e3a8b44484f2143dd856`.
This is not a full E6 completion or release record.

## Policy behavior already observed

- `CP-AUTO-20261027-01`: native QA submitted once without a separate dependency
  root or ask-first request. Host inherited `channel_effective_policy_v1`,
  prepared the literal Node module closure, and continued the original approved
  command. One Run/tool start/end; exit 0; exact output
  `CHANNEL_POLICY_AUTO_GUI_OK_20261027 sum=73`.
- `CP-ASK-20261028-01`: a separate negative/control case explicitly says
  “请先询问该目录，收到我的回答后再继续原任务”. The screenshot's directory
  question is therefore expected, not an automatic-scope regression. The saved
  Host snapshot contains one clarify decision, the frozen operation/QA manifest
  and one project-input-root slot, with zero resolutions, Runs or tool effects.
- The pending snapshot was saved, but functional capture 005 exited 1 because
  the observer's final console referenced block-scoped variables. The observer
  console is corrected for future phases. Preserve the failed receipt and
  original snapshot; never rerun the consumed pending output or relabel 005 green.
- The prior QA Main/Host are now absent; the launcher handle is unavailable.
  No normal-exit result was obtained for that instance. Resume must use a fresh
  launch claim/consistent backup and the same pending task, never resend it.

Detailed native evidence: `output/e6-20260928/channel-policy-auto-native-result-20261028.md`.

### Later native continuation (2026-10-28)

The earlier pending state above is historical. A fresh one-shot QA launcher
restored the same source and frozen decision in the same isolated profile.
Root supplied the dependency directory once through the native client, then
approved the original exact command once. Capture 006/007/008 each exited 0.
The original Run `run_fb113b09-7b02-4718-889b-7b5bb7df77a2`, step and workflow
succeeded with a verified completion gate, one resolution, one proposal, one
Run and one tool start/end. Actual exit was 0, stdout was
`CHANNEL_POLICY_AUTO_GUI_OK_20261027 sum=73`. Exact graph comparison retained
participants, command and required manifest, adding only scope/answer provenance.
The three audit decisions do not represent three tasks. The actual native
screenshot and Host record are linked in
`output/e6-20260928/channel-policy-ask-native-result-20261028.md`.

This is normal pending-task continuation, not in-flight crash/SSE acceptance.
The previous instance's exit result remains unknown. Electron's
`task_name_for_pid` diagnostic and unverified descendants remain limitations.
The running policy package still excludes the later startup repair `f3ec9834`.

## Startup repair

The native package showed zero sidebar channels although its Host returned the
two existing channels. Navigating through settings restored them, but is not a
cold-start pass. Health changed cwd before React committed the new observation;
the old read was correctly rejected and no committed-owner replacement ran.

The repair keeps observation guards and:

1. Hydrates channels/councils/memory from a healthy, live, committed cwd/epoch.
2. Removes those old-render reads from the health callback.
3. Rejects health results and errors from obsolete epochs; compares the current
   cwd rather than a stale callback before resetting workspace state.
4. Re-requests startup health from a new live epoch when startup is unfinished.
   Once healthy, cwd changes do not repeatedly reapply the Host default.

Deterministic regression results on the final repair:

- Delayed duplicate and stale callback: original 2 failures reproduced, repaired.
- Initial empty cwd with Host pause/resume: independent review found missing
  health takeover; new regression failed 1/1 before repair, then passed.
- Final focused Shell/domain/observation combination: **53/53**, exit 0.
- Full React plus desktop-bridge/API fixture: **1/1**, exit 0. Cold start and
  reload show the two channels without navigation/focus, including the second
  StrictMode health response delayed until after channels are visible.
- Web TypeScript check: exit 0. Browser screenshots retained under
  `output/e6-20260928/channel-sidebar-health-resume-browser-20261028/`.

These are source-level and browser-fixture checks, **not** proof that a macOS
package containing this repair has passed cold start. Fresh package input
review/build and native acceptance remain required. The old policy QA package
does not contain these new Shell bytes.

## Remaining work, not replaced by this checkpoint

CP-ASK slot-only continuation is complete within the limits above. The native
single-file negative case failed: Host misread “执行前…不要询问扩大授权” as a
positive ask-first request and created a directory question, with zero Runs or
tool events. No answer or retry was submitted. Its source guard is now repaired;
new regression reproduced 6 failures before the fix and the rebuilt affected
combination passed 87/87, exit 0. This is not yet a fresh-package pass. Evidence:
`output/e6-20260928/channel-policy-single-native-failure-20261028.md`.
Complete the repaired single-file/revocation/recovery/final ownership cases.
Remote main `37413fe2` (#604) is now integrated locally at `49121df7`;
this merge has not yet been pushed. The 55 catalog conflicts were limited to
`sourceRevision`; merged messages/source hashes were checked against all three
Git stages and the revision recalculated. Catalog check, Contracts/localization
builds, API/Daemon/Web typechecks and Desktop typecheck passed. The new manager
scope/editor-ownership regressions and their exact unchanged replay reproduced
7 failures / 1 pass before repair. The repair is now saved as `8cd5db5f` (Web)
and `3de11693` (Host cancellation/drain). Final affected Host combination is
67/67 (capture 023); Web/transport/real isolated HTTP and owned protocol peers
are 40/40 (capture 026), including 17 new manager cases. Web/Daemon and Desktop
main/preload typechecks passed. One intermediate version-probe timeout remains
recorded, and its exact unchanged replay passed; assertions were not relaxed.
This is source/fixture integration evidence, not packaged-client acceptance.
The wider retained evidence chain remains inconclusive with historical probes
superseded/open; no old failure was rewritten or task resent. Fixed Codex references and the precise
borrowing boundary are recorded in
`execution-engine-lifecycle-codex-cross-check-2026-10-28.md`.
Continue the existing
P3/H09/P5/Office matrix and full E6 plan,
then prepare/review the PR and verify the actual main merge. H09's provider hard
output-cap requirement remains unproven. Do not reopen accepted duration/copy
work, publish a release, enable main CI, upgrade global gstack or test Windows.
