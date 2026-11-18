# Code Review And Security Scan Workbench

Status: Local implementation and scoped acceptance complete; packaged-client acceptance unverified
Owner: Ling Stack maintainers
Last verified: 2026-11-17
Branch: `codex/code-review-security-design`

Related contracts:

- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Codex-style Hunk Diff Review](codex-style-hunk-diff-review.md)
- [Workspace Change Review, Recovery, And Open Actions](workspace-change-review-recovery-and-open-actions.md)
- [Work Board, Review Queue, And Inline Approval Boundaries](work-board-review-queue.md)
- [GitHub Automation](github-automation.md)
- [Approval Policy](approval-policy.md)
- [State Machines And Recovery](state-machine-recovery.md)
- [Secrets And Keychain](secrets-keychain.md)
- [Shared Component Theme Contract](component-theme-presentation.md)

## Product Decision And Scope

Ling provides one **Code review and security** workbench with two assessment kinds:
`review` and `security`. Both assess a bounded, immutable local Diff. Review focuses on
correctness and regressions; security focuses on concrete attacker control, reachable
trust boundaries and impact. Security findings remain unverified candidates.

The local workbench supports working-tree, branch and commit targets, custom review
instructions, durable phase history, snapshot freshness, finding triage/comments and
line markers. A review uses one ordinary tool-free Pi Run. A security assessment uses
a threat-model Run followed by a code-review Run over the same immutable snapshot,
with separate sealed artifacts. Both use the existing workspace Run/Artifact store.
The full page and compact Right Dock compose the same contracts and feature components.

GitHub pull-request sources, whole-repository/deep scans, dependency/external scanners,
exploit reproduction, cross-scan deduplication and patch generation/apply/verify remain
separate roadmap stages. Completing a local Diff assessment does not certify a repository
as secure. A resolved disposition is a human triage state and remains unverified.

## Reference Patterns And Existing Foundations

The supplied Codex research package and UI references inform the interaction hierarchy:
target selection, history beside a selected result, summary before Diff, path/line
anchors, severity filters and a compact inspection surface. Codex Security contributes
visible coverage, candidate/validation separation and a reason when dismissing a finding.
Claude Code security guidance contributes evidence-based findings and explicit failure
rather than an empty success result. No closed-source implementation or visual assets
are copied into Ling.

The existing `WorkspaceChangeReviewPage` continues to show current workspace changes.
Its bounded Git Diff process helper and the shared `DiffViewer` are reused. An assessment
captures historical input, so it owns a separate snapshot DTO rather than pretending that
the live workspace-change projection is immutable. `ReviewQueuePage` continues to own
approvals and external-action review; it is not a code-finding database.

## User Experience

### Entry Points

- The primary navigation opens **Code review and security**. The workbench switches
  between **Code review** and **Security scan**, each with its own history.
- Right Dock **Review** preserves the existing **Changed files** view and adds a
  **Code review** tab.
- Right Dock **Security scan** opens the same assessment feature in compact security
  mode. It reads the effective project `cwd` and available chat models.

The workbench has one primary entry and two Dock tools. Each analysis phase links to its
ordinary Run through existing navigation; identifiers and artifact references remain in
technical details. No additional transcript or public Run trigger is introduced.

### Workbench Layout And Actions

```text
Code review and security                         Refresh
[Code review] [Security scan]
┌──────────────────────┬─────────────────────────────────────────┐
│ Target / base ref    │ Status / captured files       Run again  │
│ Model                │ Snapshot → analysis → report             │
│ Start                │ Coverage / summary / freshness           │
│                      │ Findings + search/severity/confidence/status │
│ History              │ Captured file selector and Diff          │
│ Load more            │ Coverage and technical details           │
└──────────────────────┴─────────────────────────────────────────┘
```

The user chooses working tree, branch Diff or a full commit SHA and an enabled chat
model. Branch mode requires a base ref; commit mode optionally accepts a base revision
and otherwise uses its first parent (the empty tree for a root commit). Custom review
instructions are bounded task data, retained with the assessment and reused by **Run
again**; they cannot expand tools, source scope or output contracts.

**Start** captures a new snapshot. **Cancel** persists cancellation and stops admission
of later analysis phases. **Run again** creates a new assessment and snapshot. **Refresh**
reloads history and the selected persisted result. **Check for changes** compares a fresh
capture of the same target and persists current, stale or unknown with a check time.
A stale finding keeps its captured path/line; it is never silently remapped to live code.
Unknown checks retain an already established stale state.
A new capture also refreshes older results for the same target: a changed digest marks
their findings stale, while an identical complete snapshot restores current freshness.
An identical active request reuses its existing assessment; a different active request
returns a conflict.

Findings show severity, confidence, rationale, exact evidence, old/new location and an
unverified label. Results sort by severity, confidence, file path and line; search,
severity, confidence and status filters include informational and stale candidates.
The execution surface displays its read-only scope. Selecting a location lazily opens its captured file, expands folded
content, scrolls and focuses the exact line. Line markers can select the corresponding
finding and clear filters. File navigation groups paths by directory, filters metadata,
and shows additions/deletions without fetching all Diff bodies. The shared viewer supports
unified, true side-by-side split and auto layouts (split at a container width of 840px),
plus line wrapping. Late file responses cannot replace a newer selection.

Triage states are open, acknowledged, resolved and dismissed. Resolve and ignore require
a typed close reason plus explanation. Resolve requires an immediate server freshness
check against the same captured target; stale or unknown input is rejected. Reopening
clears close metadata. Neither resolve nor ignore changes validation from unverified.
Comments are plain text tied to the finding's complete snapshot/path/side/range anchor;
each finding supports at most 100 comments of at most 4,000 characters. Comments load only
when expanded and persist across reconnects and daemon restarts.

Completed and partial results can be exported as JSON, including snapshot, report
metadata and current dispositions. The sealed Run artifact preserves the original
analysis report; triage changes the finding projection and export, not that artifact.
History is paginated. The history API supports kind, target type, snapshot digest,
assessment status, finding severity/confidence and inclusive updated-time filters,
with a filtered total. Severity and confidence must match the same finding. Source or
model text is never interpreted as a command or HTML.

### State, Theme And Responsive Presentation

The UI uses shared Button, Input, Select, Textarea, Field, Badge, DataRow and InlineFeedback
components and semantic background, text, border and status tokens. Feature CSS owns
layout and scrolling. It does not branch on theme IDs or paint shared controls.
All six built-in themes use the same structure and defaults. Chinese and English source
copy are maintained together; catalog-generated translations require separate language
review before native-speaker quality can be claimed.

The full page collapses to one column at narrow widths. The existing Dock controller
continues to hide the Dock at or below 900px without reserving blank space. The compact
page stacks setup, history and detail. Diff/code blocks scroll internally. Long paths,
digests and evidence must not enlarge the surrounding document.

Loading, empty history, no matching findings, running, model/API error, partial coverage,
cancelled and interrupted states remain distinct. Failed/cancelled/interrupted results
show that no report was produced. An empty completed report says only that no supported
finding was reported in the assessed content. Partial coverage keeps a visible warning.

## Domain And Ownership

The authoritative DTOs and parsers are in
`packages/contracts/src/code-assessments.ts`:

| Contract | Responsibility |
| --- | --- |
| `CodeAssessmentTarget` | `working_tree`, `branch` + `baseRef`, or full `commitSha` + optional `baseRef` |
| `CodeAssessmentSnapshot` | Target, captured time, revision identity, digest, bounded files and exclusions |
| `CodeAssessment` | Kind, status, phase history, metrics, freshness, instructions, phase Runs/artifacts, summary and counts |
| `CodeAssessmentFinding` | Snapshot-bound location, evidence, severity, confidence, optional CWE and disposition |
| `CodeAssessmentDetail` | Assessment, immutable snapshot and current findings; `CodeAssessmentOverview` omits Diff bodies |
| `CodeAssessmentComment` | Plain text and exact digest/path/side/range finding anchor |
| `CodeAssessmentFreshness` | `current`, `stale` or `unknown`, plus `checkedAt` |

Finding validation is always `unverified`. Disposition is independently `open`,
`acknowledged`, `resolved` or `dismissed`. Close reasons are `false_positive`,
`accepted_risk`, `not_reproducible`, `duplicate` and `out_of_scope`. Severity is
critical/high/medium/low/info; confidence is high/medium/low. A later scan does not verify an
older finding or rewrite its source identity.

Ownership follows the existing package boundaries:

- Contracts owns request and output parsing, path checks and hunk evidence validation.
- Core owns the store interface, SQLite migration and transactional state invariants.
- Daemon owns authorized workspace access, Git capture, prompt construction, Run lifecycle,
  the tool-free execution policy and report materialization.
- API client owns transport and encoded workspace/assessment/finding identities.
- Web owns presentation and async selection state; it never reads Git or SQLite directly.
- Conversation UI Core owns the shared Dock page-kind union, including `security`.

## Snapshot Capture And Privacy

### Targets And Revision Identity

Working-tree capture compares the net state against pinned `HEAD`: staged, unstaged and
untracked content are included, and a staged edit subsequently reverted in the working
tree is not falsely reported. Branch capture resolves the base and HEAD to commits,
computes their merge-base and reads committed changes through the pinned HEAD. Dirty
working-tree files are ignored for branch targets. Commit capture pins the requested
40-hex commit and compares its first parent, or an explicitly resolved base revision. A
root commit compares the empty tree; a shallow checkout missing its parent fails visibly.
The commit digest is independent of the currently checked-out branch and dirty files.

The already opened, trusted workspace must be the repository root and must have a HEAD
commit. Missing/invalid refs, unavailable repositories, unsupported paths or moving
captures fail visibly. There is no fallback to another revision. Target parsing rejects
option-like refs and unsupported syntax, and Git receives argv with literal pathspecs.

A snapshot contains head SHA and base SHA where applicable. Working-tree/branch targets
include the current branch; commit targets omit it and use the assessed commit as head SHA.
Each file has a hash of its raw bounded Diff, the redacted Diff, kind and optional old
path. The snapshot digest covers the target, revisions, captured files, their raw-content
hashes and exclusions. IDs and capture timestamps are not part of the content digest.
Two consecutive captures must have the same digest before a snapshot is accepted.
This detects movement between captures; it is not a filesystem transaction.

### Budgets And Coverage

| Boundary | Limit or behavior |
| --- | --- |
| Candidate file traversal | First 80 sorted paths are eligible for capture; remaining paths are exclusions |
| Per-file source/Diff | 96 KiB; larger content is excluded |
| Total captured Diff | 256 KiB budget |
| Persisted snapshot | At most 1 MiB JSON |
| Git Diff process | Existing bounded process helper, with a 15-second kill timeout |
| Model report | At most 256 Ki characters and 50 findings |
| Finding location | At most 21 consecutive captured hunk lines |
| History page | Default 30, maximum 100 |

Binary files, symlinks/gitlinks, sensitive paths, oversized content and budget omissions
are recorded as explicit exclusions. Private-key blocks cause file exclusion. Conventional
credential filenames are excluded before reading content. Secret-like values in readable
Diffs use existing redaction plus literal credential-assignment redaction. Files are
excluded when redaction would change Diff line anchors. Redaction is best effort;
repository owners should still avoid sending private material to an untrusted provider.

Any exclusion or redaction makes coverage partial. Raw-content hashes distinguish two
secret changes even if their displayed redacted Diff is identical. Partial captures
always return freshness unknown because omitted content cannot certify equality.
Freshness results describe the explicit check time, not continuous monitoring. Request-driven
reconciliation only inspects active rows, and creation refreshes a bounded recent history
window; older terminal rows remain available through paginated history or an explicit freshness check.

Untracked files are read through a bounded regular-file descriptor, with no-follow,
single-link, inode/device checks plus parent realpath containment. Git capture disables fsmonitor,
hooks, external Diff/textconv, submodule recursion and configured clean/smudge/process
filters. Repository-configured content filters must not execute during this read path.
These controls do not constitute an OS sandbox or protect against an attacker concurrently
rewriting the local Git configuration.

## Execution, Output Validation And Recovery

The daemon verifies an enabled chat provider and builds an ordinary Pi Run with
`tools: []`, read-only permissions, no memory recall and a daemon-owned assessment/digest
binding. The public Run request parser cannot set that marker. Source code is task data;
the system prompt contains trusted assessment instructions and the output schema.
The security prompt asks for concrete attacker control and impact; the review prompt
asks for observable correctness/regression failures.

The assessment policy checks the stored assessment, snapshot, workspace, runner and
active state. It rejects teammate/skill execution and a non-Pi adapter. It clears tool,
MCP, host, media, delegation, user-input, permission and hydration surfaces during
preparation, frozen preparation and immediately before execution. Tool-before handling
also denies tool execution. The provider call still uses the ordinary configured model
and provider preflight; tool-free does not mean offline model inference.

Security first produces strict threat-model JSON containing the snapshot digest,
summary, assets, trust boundaries, attacker controls and assumptions. It is validated,
redacted and sealed before the second Run is admitted. The second Run receives that
artifact as analysis context, never as trusted instructions or independent evidence.
Review targets start directly with the code-review Run. The daemon-owned internal marker
binds assessment, digest and phase; no unsupported public `code_review` trigger is added.

The code-review model must return one bounded JSON report matching the snapshot digest. Unknown
fields, invalid enums/CWE, paths outside the snapshot, invalid old/new hunk ranges and
fabricated evidence are rejected. Evidence must be an exact excerpt from the selected
captured lines, without Diff markers. Output is redacted before report persistence.
Malformed output fails the assessment rather than publishing an empty success result.
Malformed and failed Runs retain a sealed diagnostic artifact bound to their Run and
snapshot. Its error and last assistant output are redacted; the output excerpt is capped
at 32 Ki characters and marked when truncated. Diagnostics never become findings.

```text
queued → analyzing → completed | partial | failed | cancelled | interrupted
queued             → failed | cancelled | interrupted
```

`completed` requires complete captured coverage. `partial` is a finished report over
partial captured input; it is not a streamed, unfinished report. Failures and cancellation
cannot publish findings. Terminal records cannot be revived by late callbacks. Phase history records:

```text
preparing → collecting_diff → [threat_model] → reviewing_code
  → validating_output → validating_candidates → synthesizing_findings → terminal
```

Only security uses threat_model. validating_output checks JSON syntax/object shape;
validating_candidates checks schema, digest, captured hunks and exact evidence. It does
not execute tests or reproduce exploits. The aggregate validation is inconclusive after
a report and not_run before one. Phase Runs retain their identities and individual
completed/failed/cancelled/interrupted states.

The Run-ready callback binds the Run before returning its identity to the client.
A pending-admission set prevents concurrent reads from misclassifying in-process startup
as an orphan. There is one active assessment per workspace across both kinds; capture
is also serialized. SQLite enforces the active slot independently.

On code-review terminal success, the daemon reads the final assistant message, validates it, creates
a sealed JSON artifact and atomically stores the findings and assessment terminal state.
Artifact creation and that terminal transaction are separate; a failed terminal write can
leave an unreferenced artifact, but cannot publish a partial finding transaction.

Cancellation uses ordinary durable Run cancellation and active-run stop handling, then
persists the assessment terminal state. If the Run already finished, its terminal result
is materialized instead. GET/list requests reconcile persisted records: terminal Runs
materialize reports; work with neither live execution nor queue custody becomes
interrupted. Reconciliation is request-driven, not a separate startup service. A terminal
threat-model Run found after restart may have its artifact materialized, then the
assessment becomes interrupted; reconciliation does not admit a new phase. Run again
captures fresh input. Ordinary Run queue custody remains in force. Duplicate terminal
callbacks and cancellation before the second Run-ready callback cannot admit extra work.

## Storage And API

SQLite migration 230 creates `code_assessment_snapshots`, `code_assessments` and
`code_assessment_findings`, with history/ownership indexes and a unique active-assessment
index. Migration 231 adds lifecycle/metrics projections to existing JSON rows; migration
232 adds digest-bound finding comments and their ownership index; migration 233 indexes
history and finding filters. Migration shape and marker checks are fail-closed and idempotent. Creation stores
snapshot and assessment in one transaction. Finalization binds the Run and digest and
stores all findings in one transaction. A duplicate or invalid insert rolls back the
whole finding batch. Triage requires the expected digest, valid transition metadata and a bounded close
explanation. Comments atomically enforce the per-finding cap.

All assessment routes require the existing local-origin/trusted-workspace guard and an
initialized workspace store. `cwd` is a required query parameter, including on mutations.
These routes do not silently open an arbitrary repository.

| Method and route | Purpose |
| --- | --- |
| `GET /workspace/code-assessments` | History filtered by kind, targetType, snapshotDigest, status, severity, confidence, updatedAfter/updatedBefore; limit/offset pagination and filtered total |
| `POST /workspace/code-assessments` | Create from `{kind, target, providerPresetId, instructions?}`; `view=overview` omits Diff bodies |
| `GET /workspace/code-assessments/:id` | Persisted detail; `view=overview` returns metadata/stats without Diff bodies |
| `GET /workspace/code-assessments/:id/snapshot-file?path=...` | One captured file plus snapshot digest; never reads the live file |
| `POST /workspace/code-assessments/:id/cancel` | Cancel or return the terminal result |
| `POST /workspace/code-assessments/:id/freshness` | Explicit current/stale/unknown check |
| `POST /workspace/code-assessments/:id/findings/:findingId` | Digest-bound triage and typed close metadata |
| `GET/POST /workspace/code-assessments/:id/findings/:findingId/comments` | List/add comments with exact captured anchor |

The API client uses the shared transport. IDs and `cwd` are encoded and no Computer Use
route token is attached to these endpoints. Untrusted origins and foreign workspaces
are rejected; a trusted but unopened workspace returns not loaded.

## Implementation And Verification Plan

The local delivery uses the following acceptance boundaries:

| Slice | Source and acceptance |
| --- | --- |
| Contracts | Shared DTOs, strict request/model parsing, captured hunk and forged-evidence tests |
| Storage | Migration, transactional create/bind/finish/triage, reopen and terminal-fencing tests |
| Capture | Real temporary Git repositories for net working-tree, pinned/diverged branch, commit/root/merge/shallow targets, rename/delete, exclusions, redaction and filter suppression |
| Execution | Tool-free Pi policy, ordinary Run/artifact lifecycle and local-origin/workspace guard |
| Integration | Real daemon, HTTP, SQLite and Pi SDK with scripted provider transport; success, malformed report, partial coverage, two-stage security, duplicate callbacks, cancellation, durable stale/typed triage and actual stop/start recovery |
| UI | Shared full/Dock components, models, history, filters, lazy captured Diff, layouts/line anchors, comments, instructions, triage, export and explicit failure states |
| Acceptance | Owning package typechecks/tests, Web lint/i18n, six-theme and narrow/wide browser evidence, existing Dock regressions, docs/license/public checks |
| Release | Independent code review, required CI, PR and verified mainline merge |

Relevant local commands, from the repository root after building the owning packages:

```bash
node --test packages/contracts/test/code-assessments.test.ts
node --test packages/core/test/code-assessment-store.test.ts
node --test packages/daemon/test/code-assessment-snapshot.test.ts packages/daemon/test/code-assessment-policy.test.ts packages/daemon/test/code-assessment-integration.test.ts
node --test packages/api-client/test/code-assessments.test.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/code-assessments.spec.ts
corepack pnpm --filter @ling-stack/web typecheck:ci
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/localization catalog:check
corepack pnpm check:docs
corepack pnpm check:licenses
corepack pnpm check:public
```

Package tests import built output. Changed TypeScript tests must also pass their owning
`typecheck:ci`; the Web E2E spec is explicitly included in `tsconfig.e2e.json`.
Scripted provider and browser-mocked daemon tests establish execution contracts. A separate
six-case synthetic smoke used the local CPA text model `gpt-6.1-sol` for nine real requests;
independent inspection matched each finding and abstention to its fixture rationale and
captured evidence. This small sample does not establish real-repository recall or precision.
Packaged macOS/Windows and native assistive-technology acceptance are separate
release checks. No deployment is implied by source implementation or a merged PR.

## Performance And Resource Review

The initial screen reads bounded overview metadata. A selected file is fetched separately;
export explicitly requests the full captured snapshot. Capture admits at most 80 files
and 256 KiB of Diff. History is paginated, comments are capped and only one assessment
is active per workspace. These bounds avoid needing an unbounded tree or report DOM.

Persisted metrics include capture duration, snapshot/Diff/report bytes, time to summary,
first finding, final result and durable cancellation latency. Summary and first-finding
timestamps measure availability after the complete report has been parsed, not streaming
model tokens or the earlier threat-model summary. Final latency includes capture and
both security Runs. Cancellation latency measures the service cancellation path through
durable Run cancellation, ending before the aggregate terminal write; it does not measure
SDK process exit or the complete HTTP request. Byte metrics describe payload sizes; no
peak-memory measurement is claimed.
The assessment row is created only after capture succeeds; its earlier preparation and
capture timestamps are recorded afterward. This is not resumable capture progress.

## Acceptance Matrix

| Area | Required evidence and boundary |
| --- | --- |
| Local review | Real Git working tree/branch/commit, staged/unstaged/untracked, rename/delete, root/merge/shallow and immutable digest tests |
| Security | Two ordinary Pi Runs, bounded sealed threat model, schema/hunk checks, explicit phases and unverified findings |
| Integrity | Exact old/new captured location, digest-bound comments/triage, persistent stale without live-line remapping |
| Read-only | Forged/stale/phase-mismatched admission rejected, public marker unavailable, tools/MCP/host/media/delegation disabled |
| Evidence | SQLite, Run, snapshot, phase/artifact and finding/comment references survive daemon stop/start |
| Recovery | Provider/malformed output/cancel/orphan and duplicate/late callbacks have explicit durable outcomes |
| UI | Full page and Dock, commit/instructions/comments, real layouts, lazy responses, keyboard location, six themes and narrow overflow checks |
| Performance | Bounded real Git fixtures, overview/single-file sizes and durable metrics; no peak-memory claim |
| Quality | Scripted integration plus an independently inspected six-case/nine-request real text-model smoke; real-repository recall/precision remain unmeasured |
| Docs/release | Owning typechecks, Web/localization/docs checks, independent review, required CI, PR and mainline merge |
| Remediation/GitHub | Later stages below; local triage provides no write/external-action permission |

The original design's `code_review` trigger is implemented as an internal, validated
assessment marker on ordinary Runs because the public trigger does not exist. Network
approval/resume and patch-conflict fixtures belong to the deferred scanner/remediation
adapters; the current tool-free profile rejects those capabilities. The original local
comment, commit, lifecycle, line marker, lazy loading and instrumentation requirements are
part of this delivery rather than deferred UI follow-ups.

## Roadmap Beyond The Local Workbench

### P1: GitHub Pull-Request Targets

Add read-only GitHub adapters with repository identity, pinned base/head SHAs and source
provenance. Capture the same bounded snapshot before execution. PR filters, authorship
and review ownership belong to that adapter. External comments must first be proposed
as artifacts and pass existing GitHub external-action approval. Local findings never
confer permission to post, label, push or merge. Tests cover ref movement, rate limits,
repository access, branch protection, read-only fetches and authorized comment submission.

### P2: Full/Deep Scanning And Remediation Verification

Full-repository input needs explicit scope/exclusions, retained source provenance,
resource budgets and coverage beyond changed hunks. A deep profile may add contextual
source collection, external analysis and exploit reproduction to the existing local
threat-model/review pipeline. Each phase needs its own evidence and durable recovery.
Network, dependency installation, credentials and external scanners use separately
approved existing action paths; the local tool-free profile must never acquire those tools.

Validated findings need reproducible evidence tied to the source snapshot and validation
Run, with root cause, attacker control, impact, recommended fix and uncertainty. A model
assertion alone cannot advance `unverified` to validated. Cross-scan identity and stale
mapping require a stable defect fingerprint and explicit comparison evidence.

Remediation is a separate proposal/apply/verify flow: generate a bounded patch artifact,
show affected files and expected hashes, obtain write approval through an ordinary Run,
then scan the resulting exact revision. Dismissed, resolved and verified remain separate
facts. Conflicting user edits fail the expected-hash check. Tests cover rejected writes,
conflicts, cancellation, restart, invalid validation evidence and stale source links.

Repository profiles, cross-scan findings, retention, organization policy and trends are
future product work, not hidden P0 completion criteria. Each phase requires its own
approved implementation plan and acceptance evidence before delivery.
