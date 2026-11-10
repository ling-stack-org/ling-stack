# P3 isolated QA: standing authorization application

2026-10-23, Asia/Shanghai. Internal isolated QA only; no release permission.

The human user's current instruction is `批准，不用再问我了`, following the
standing `批准，不发布，只验证` and authorization to continuously complete the
existing implementation/QA chain. This records process authorization for necessary
internal QA, not a claim that the human reviewed or authenticated new file bytes.
The earlier specific cold-bootstrap packet approval remains scoped to its own
hash; it is not relabeled as approval of this new packet.

## Frozen source and applicable independent review

- Implementation checkpoint: `2adfab1c3f68a1031026561035b3e46d2ec6a476`, pushed
  and independently read back from `refs/heads/codex/e6-safe-continuation`.
- Frozen pending packet: `office-human-qa-p3-delta-frozen-20261023.json`, SHA256
  `487b8e74a7e6b17b641a388b30228dcf97b8980c645ba08014209fb18b90c873`.
  It remains unchanged and `approved=false`; the generator cannot update approval.
- Old formal record SHA256:
  `67d5e91eb3aad2fa4188edc656c9be927532e604803d51297ba0ff29fd72e872`.
- New formal record SHA256:
  `a2101cb33860669399da6967e61185663b69906374b52b40cb4e0c579ed8a78e`.
- Exactly 74 existing packaging hashes changed and one new input was added;
  15 native source inputs and toolchain/runtime/signing facts are unchanged.
  No old evidence, tests, packet or source was deleted or rewritten.
- Inventory/provenance independent report SHA256:
  `e87a6c820d49e7367cc7d6e4c3ee989f12c8e79bc966331be2d9a25780cd043c`.
- The inventory report's eleven dependency-only content gaps were subsequently
  closed by the runtime/projection content delta report SHA256
  `24c5939fd6375e4f4e7961e0b6160824ee15e7b10d2bd8b8ed462f9b38cf0d40`.
  It reuses exact prior whole-content baselines, reads complete current deltas,
  the complete new projector and the stated relevant seams; it does not claim
  to have reread every unchanged whole file.
- The other seven runtime deltas retain the exact-hash private Host and budget
  independent reviews listed in the frozen packet. Generated catalog provenance
  and fixed-list changes have their own inventory report coverage.
- No remaining confirmed findings in these selected reviewed deltas. This does
  not assert that the entire remaining E6 runtime acceptance is complete.

The primary agent applied only these reviewed hashes with a verified patch;
the original production reader then independently accepted all 1594 packaging
and 15 native inputs and the unchanged toolchain/runtime/signing tuple.
No hash guard, reader, source-snapshot policy, signing gate or package check was
disabled. A first relative-path patch attempt failed before any write; the exact
absolute E6 path was then used successfully. The default checkout was not changed.

## Limits and next execution

The activity writer moved into the independent `conversation-activity-pr` worktree.
The E6 tracked tree was saved clean at this checkpoint; the frozen input inventory
was reread unchanged before applying the formal delta. Work in that separate PR
is not silently imported or represented as part of this snapshot. Any later
adopted fixes need a separate applicable byte/delta check.

Only the original `LING_DESKTOP_PACKAGE_HUMAN_QA=1 ... package:mac` chain and
the existing isolated profile/17928 may consume this record. This is not a new
explicit human review of the concrete packet, a system identity confirmation,
formal publication or deployment approval. New package identity, current GUI,
real collaboration/recovery/Office and H09 all require their own evidence.
H09 hard output cap remains unproved; no pilot or shared CPA change is authorized
by this receipt, and the agent must not perform human authentication on behalf
of the user.
