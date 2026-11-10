# Explicit packaged QA delegation selection

This is a Host startup configuration, not model-provided authority, a successful
evaluation, an Office source approval, or release permission.

## Baseline and explicit opt-in

The existing `qa-profile.json` and `lingHumanQaPackage` identify the isolated QA
namespace. On their own they do not enable dynamic delegation or model calls.
The baseline profile's `modelExecution: false` and `humanConfirmation: false`
must not be used as evidence that later authorized runs are synthetic or that a
user has authenticated. Actual source/evaluation records retain their own facts.

The user has separately authorized bounded real-model E6 acceptance using only
dedicated QA cases/artifacts. To select dynamic workflows, the Host must explicitly
install a separate private `qa-harness.json` beside the baseline marker. Its exact
schema is:

```json
{
  "schemaVersion": 1,
  "kind": "isolated-qa-delegation-selection",
  "modelExecution": "host-authorized-budgeted",
  "workspaceCwd": "/absolute/private/qa-profile/workspace",
  "selectedWorkflowIds": ["exact-existing-workflow-id"],
  "maxDepth": 2,
  "rootBudget": { "tokenBudget": 4096, "wallTimeBudgetMs": 60000 }
}
```

Numbers above are illustrative, not an installed policy. Both budgets must be
positive safe integers; depth is at most the existing Host limit of 16. Workflow
IDs must be distinct exact IDs (1–100), never wildcards. Money budgets, price
overrides, permissions, arbitrary feature flags and extra keys are rejected.

This file explicitly supersedes the baseline no-model selection for these
workflows only. The combined QA run is therefore **not synthetic-only**. A new
pending Office review packet covering this combination must describe dedicated-QA
data plus Host-selected budgeted model execution; it must not copy an older
packet's `synthetic: true, modelExecution: false` scope. The concrete packet and
its frozen hashes still require the user's approval before a fresh package.

## Custody and flow

Desktop reads both files before importing Main or mutating environment/userData.
Directories must be canonical, owned by the current UID and exactly 0700. Policy
files must be regular, canonical, same-owner, single-link, exactly 0600 and at
most 4096 bytes. O_NOFOLLOW plus descriptor/path identity checks detect replacement
or in-place modification during the read. Only ENOENT means no optional policy.
This is the agreed same-user controlled-process boundary, not protection from
arbitrary Full Access software running as that user.

All non-OS/locale inherited variables are removed. Valid selection emits a typed
snapshot plus the existing continuation/tool/delegation enforce flags. Daemon
requires the packaged flag, loopback host, port 17928 and the exact selected
workspace before resolving that snapshot. Invalid input fails before native,
skill or Daemon startup side effects. Ordinary launches remain unchanged.

Resolving configuration does not start a workflow. Actual dispatch still requires
the original Host workflow selector, frozen Run snapshot, live parent fence,
permission/deadline/budget checks and genuine prepared-input acceptance. No
evaluation model gate, human-decision capability, secret inheritance, approval
bypass or Full Access setting is enabled by selection. QA source tests with
stubbed side-effect boundaries are composition evidence, not packaged GUI or
real-model acceptance.

## Run-level freeze and restart

Each new Run's Host feature snapshot persists an independent exact
`delegationSelectedWorkflowIds` list. Dynamic bind/spawn/resume/recovery requires
both that frozen list to contain the actual workflow ID and the current selector
to still permit it. Child preparation inherits its parent's frozen snapshot.
Missing, invalid or unselected historical snapshots fail closed. Changing the
private startup file cannot retroactively enroll an old Run; removing a workflow
immediately revokes its current admission. No persisted Run or old QA history is
rewritten to add a selection.
