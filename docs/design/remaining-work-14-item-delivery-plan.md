# Remaining Work 14-Item Delivery Plan

Status: active execution plan; integration evidence recorded in [PR #732](https://github.com/ling-stack-org/ling-stack/pull/732)
Owner: Ling maintainers; each delivery batch needs an integration owner and a platform contact
Last verified: 2026-11-18
Initial branch-cut baseline (historical M0 snapshot): `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63`
Execution branch: `codex/automations-p2-completion`
Integration baseline for PR #732: `origin/main@acf448a9c7e825ad362d5e4adaf5096100e1e8b5`
Execution PR: [#732](https://github.com/ling-stack-org/ling-stack/pull/732); exact head is re-read from GitHub
at each hosted gate.
Target worktree: `<isolated-worktree>`
Release-candidate target: 2027-03-15, subject to platform resources and external acceptance

This plan turns the 14-item status review into an execution queue. It distinguishes source code,
local verification, hosted review/merge, and platform or paid-provider acceptance. A local source
implementation never closes a platform gate by itself.

## Current baseline

- The protected root worktree `<workspace-root>` remains on `codex/ling-companion`
  with uncommitted WIP. Batch integration and verification use an isolated worktree.
- PR #732 includes the F5, External Work, context processing, restart recovery, policy preview
  and Automations slices. GitHub records hosted checks, review and merge state for the current head.
- PR #717 merged the Companion character delivery into `main` as `9ba748f12`.
  The root worktree's `codex/ling-companion` branch is independent and contains separate WIP.
- Remaining cross-feature PRs and platform gates stay with their owning plans.

## Four completion classes

| Class | Meaning | Evidence required |
|---|---|---|
| Code + verification | The current source needs a bounded implementation slice and regression proof | Source diff, owning tests, typecheck/build, and the relevant daemon/Web path |
| Integration + verification | The source body exists, but the real path, restart, packaging or ownership boundary still needs proof | Runtime integration, restart/reopen, browser or package evidence as applicable |
| External acceptance | Local source is sufficient for the recorded boundary; the remaining gate needs a real provider, platform, paid operation or release environment | Named resource, authorization, result artifact and independent acceptance record |
| Decision/follow-up | The item is intentionally outside this delivery queue until product or architecture reopens it | Decision owner, outcome, date and the contract that will change |

## 14-item delivery ledger

| # | Work item | Current class | This plan's next deliverable | Completion boundary |
|---:|---|---|---|---|
| 1 | Memory and Skill Learning release gates | External acceptance | Reserve packaged macOS/Windows FTS/native and CPA rate checks | Source/PR/CI/main merge are already recorded; package and CPA evidence remains open |
| 2 | Provider Hardening and Media Adapters | Code + verification | Finish Jimeng signing and image generation, stored-artifact input materialization, timeout/cancel/error regressions | Real provider smoke and paid-provider authorization remain separate gates |
| 3 | Two-Layer Configuration | Code + verification | Complete provider-profile CRUD/import/snapshot/provenance and explicit local-secret/keychain cleanup flow | Doctor and migration evidence must be safe, redacted and restartable |
| 4 | Workspace State Storage | Integration + verification | Exercise clean-host migration, active-daemon rejection, backup/rollback and registry ownership | Rollout owner and packaged path must be recorded |
| 5 | AI Councils | Code + verification | Finish template catalog, routing policy, workflow defaults and remaining health/governance surfaces | Browser and packaged health evidence closes the product boundary |
| 6 | Governance Notifications | Integration + verification | Verify restart, duplicate-trigger idempotency, routing coverage and redacted message bodies | Multi-user seen semantics stay a separately approved architecture item |
| 7 | Conversation Memory Citations | Code + verification | Add normal-conversation footer/source detail and unify transcript/source references | Citation scope, source grouping and privacy behavior need browser evidence |
| 8 | Activity Summary and Exploration Batching | Integration + verification | Wire package/build, SSE reconnect, restart recovery and source lineage | Real browser evidence must cover stale and reconnect states |
| 9 | Input Materialization | Integration + verification | Verify caches, boundaries, restart and Web/Desktop paths; harden M6 evidence/details UI | Local OCR worker remains a follow-up unless explicitly reopened |
| 10 | Media Production Image To Video | External acceptance | Run authorized provider smoke with timeout/cancel/failure and verify final artifact | Paid provider evidence is required; mock-only tests do not close it |
| 11 | Multi-Agent Requirement Shaping | Code + verification | Implement specialist contribution packet, collection/fan-in validation and detail route | Existing safe-concurrency and packet ownership rules remain mandatory; ordinary write parallelism stays closed |
| 12 | Native Skill Recording | Code + verification | Complete message-overflow source refs, draft entry and Web/accessibility regression | Settings remains the existing Skill Library entry; no parallel authority surface |
| 13 | SQLite Modularization | Integration + verification | Verify persistence, CAS, heartbeat, stale recovery, reopen and stable public `RunStore` API | Further mechanical splitting is excluded without ownership design |
| 14 | Automations | Integration + verification | The [P2 slice](automations-p2-completion-plan-2026-11-18.md) implements monitor snapshots, admitted Run links, finding artifacts, notification history and the Web projection. Hosted status is tracked in PR #732; P3 destinations and approval-backed actions have their own scope. | Desktop notification permission, live messaging and real Provider acceptance need separate evidence. |

The ledger is a plan, not a claim that all source bodies are currently complete. The owning design
documents and tests remain authoritative for each row.

## Delivery sequence

### P0 — Baseline and scope reconciliation

**Exit:** the target branch is isolated, the protected WIP is untouched, the 14 rows have a class and
owner, and open PRs are mapped without treating them as merged. The branch cut and worktree steps are
complete for this execution branch. Named owners, platform contacts, decision outcomes and resource
reservations remain open M0 work in the baseline packet.

### P1 — Integration hardening

Process items 4, 6, 8, 9 and 13 in that order:

1. Run owning package tests and typechecks.
2. Exercise SQLite reopen and daemon restart paths.
3. Verify SSE reconnect, cache invalidation, idempotency and source lineage.
4. Run browser or packaged checks where the item changes a user-visible path.
5. Update the item ledger and owning status only after evidence is captured.

### P2 — Local code delivery

Process items 2, 3, 5, 7, 11, 12 and 14 as bounded slices. Every slice must include its contract,
daemon or Web implementation, a behavior test, and the owning package typecheck. Cross-cutting
permission work is delivered first because it gives the other slices a single daemon-owned authority
preview.

The first local slice in this plan is `POST /runs/policy-preview?cwd=/path/to/workspace`. It uses the
same `resolveSessionRunPolicy` resolver as run dispatch, validates channel/task scope and approval
profiles, marks full access as confirmation-required, and does not create a Run, Approval, Artifact or
state transition. Its local evidence is two HTTP regression tests plus Contracts/Core/API Client/Daemon
typechecks and the Daemon build.

### P3 — External and platform acceptance

Keep these gates separate from source work:

- packaged macOS/Windows Memory and Skill Learning acceptance;
- authorized paid media provider smoke, timeout/cancel/failure and final artifact verification;
- clean-host Workspace State Storage migration and rollback;
- real browser, Desktop, accessibility and packaged verification for Councils, Citations, Skill Recording
  and Automations;
- provider, Chrome, Office/WPS, CUA/PiP and messaging/destination resources where the owning plan calls
  for them.

No paid or external operation starts without an explicit budget, approval path, stop condition and
redacted evidence destination.

### P4 — Review and release closure

For each completed row:

1. run the narrowest relevant tests, then the owning package typecheck/build;
2. update the owning design, this ledger and `implementation-status.md`;
3. create or update a PR only after the local diff is reviewable;
4. record CI, review, merge commit and deployment as separate facts;
5. move only truly closed behavior into its owning contract and remove it from the unfinished queue.

## Exit criteria

The 14-item plan can close only when every row has one of these outcomes:

- source, local verification, hosted merge and required platform acceptance are evidenced;
- a named external acceptance gate has an owner, resource, authorization and scheduled next action;
- a product/architecture decision is recorded as approve, defer or reject with rationale and date; or
- the row is explicitly moved to the next-cycle follow-up pool with its contract and reason.

PR #732 covers one delivery batch. Release Candidate and deployment status require independent
evidence for the applicable work items and platforms.
