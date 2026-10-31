# P3-C01-001 — workflow input snapshot rejected after its first real tool

## Real failure, retained unchanged

The original packaged GUI stage A created workflow
`workflow_7560c256-b048-422f-9844-4c4062598cba` and Engineer Run
`run_1d74e385-1c7a-40fc-b285-fe31130afcc5`. Read succeeded once, then the next
provider boundary rejected `checkpoint.lineage_mismatch`. The required CLI had
not executed; QA stayed queued, fan-in did not succeed, approvals were empty.
This failed original is not retried or rewritten as success.

Real screenshot `p3-live-20261024/c01-checkpoint-blocked.png` and complete AX
`c01-checkpoint-blocked-full-ax.txt` retain the evidence. Public Host capture
`c01-checkpoint-host-lineage.json` SHA256
`78c72539ab1170afcea1e618c0818cf552dccd0d87b55973c50b5821d2a2aef6`
contains only bounded lifecycle/event projections and prompt hashes, not prompts
or credentials. All Task identity fields matched except prompt; prepared-input
fingerprint still matched. No real DB repair was used.

## Root cause and contract

`workflows.ts` intentionally stores the canonical step objective as Task.prompt
and renders a source-bound workflow context pack into runRequest.task.prompt.
`orchestrator.ts` previously replaced the Run's accepted semantic task fields
with the canonical Task row when persisting taskSnapshot/requestSnapshot.task.
Core correctly rejected that mismatched task versus frozen runner execution.
The same mismatch also prevented readStoredRunnerExecution/restart reconstruction.

New Runs retain Task metadata but freeze accepted id/title/prompt/channelId.
Existing Run snapshots and canonical Task rows are unchanged. No lineage,
permission, prepared-input, source-binding or effect guard was relaxed. A changed
snapshot prompt still fails closed. This does not repair historical failed Runs.

## Regression and independent review

The old loopback test had continuations off, so tool execution passed while the
stored snapshot was still invalid. Enhanced test covers off/enforce explicitly:
actual RED2/2 includes enforce failing after exactly one provider/tool round at
the original checkpoint error. With the persistence fix, GREEN2/2 exit0: actual
Pi SDK + loopback SSE read, approve one bounded create, and final response;
each tool once, two settled checkpoints, original Task preserved, recovery input
reconstructed and tampering rejected. This fixture is not a real model/GUI test.

Daemon tsc exit0. Adjacent channel SDK, delegated SDK, suspension and continuation
suite: 28/28, zero skip, actual exit0. Logs `p3-channel-checkpoint-{red,green,adjacent}-20261024.log`.

Independent read-only review `/root/p3_offline_delta_review`: zero confirmed
findings in the selected final scope; independently reran 2/2 under fresh Ling
home/workspace, exit0; diff-check exit0. No reviewer source/dist/DB changes.

Final source SHA256:

- orchestrator.ts: `acf265259df4489e8923d3278193d0198bee4d8e2f6874df21e3ae56076191d6`
- channel-operation-pi-e2e.test.mjs: `110ad48129c2bdb5484d12ca08289b01d0b8707bbc5f4dc38aead122ff03b7bd`
- unchanged prepared-runner-input.ts: `80a4b3ba8bfdf2e8919be4138477a278c2294d3891aeba8c06a52f62fab3eab3`
- unchanged existing-run-request.ts: `08b257664b68a703b4a06eb1ad99c3e613118c13dd8a4c9c47e783586a979711`
- unchanged Core lineage: `ad91c9645eac0ed76acf30ea093edab35c68d94d6e43ce31b56d1bb0bb8a1ab4`

Status: independently reviewed candidate, not yet in the running package. New
packaged two-required-participant collaboration, CLI evidence, file additions and
real restart/reconnect remain open. No release or main merge is claimed.
