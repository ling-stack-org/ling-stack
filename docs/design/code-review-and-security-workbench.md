# Code Review And Security Scan Workbench

Status: active product and architecture design; implementation not started
Owner: Ling Stack maintainers
Last verified: 2026-11-16 against the local `main` baseline `90cad44198b156064f1ccac401873fe202550729`
Branch: `codex/code-review-security-design`

Related contracts:

- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Codex-style Hunk Diff Review](codex-style-hunk-diff-review.md)
- [Workspace Change Review, Recovery, And Open Actions](workspace-change-review-recovery-and-open-actions.md)
- [Work Board, Review Queue, And Inline Approval Boundaries](work-board-review-queue.md)
- [GitHub Automation Design](github-automation.md)
- [Approval Policy](approval-policy.md)
- [State Machines And Recovery](state-machine-recovery.md)
- [Secrets And Keychain](secrets-keychain.md)

## Decision Summary

Ling should add a review and security workbench with one shared shell and two independent
work types:

```text
Review & Security workbench
  Code review
    local workspace changes
    branch/base diff
    commit
    GitHub pull request (later)
  Security scan
    local diff (first release)
    branch/repository scan (later)
    deep or external scanner (later)
```

The shell owns navigation, target selection, revision identity, source permissions,
progress, evidence, file/line navigation, and responsive layout. Code review and security
scan keep separate records and state machines because their completion semantics differ:

- A code review is a read-only assessment attached to a normal Ling Run/Conversation. It
  produces findings and a review artifact. It does not change the workspace.
- A security scan is a durable assessment of one pinned snapshot. It records threat model,
  coverage, candidate findings, validation evidence, triage, remediation, and verification.
  A scan can outlive its execution Run and can be resumed or compared with later scans.

Both work types use the existing workspace change readers, Run, Artifact, approval,
Evidence, and Right Dock foundations. No closed-source Codex Desktop code is copied into
Ling. Codex and Claude Code are interaction and contract references only.

The first implementation is deliberately local:

1. Review uncommitted changes or a local branch/base diff.
2. Run a security scan against the same bounded local diff snapshot.
3. Display findings in the Right Dock and in a full workbench view.
4. Keep review and scan read-only by default; remediation is a separate approved Run.

GitHub PR review, full-repository scanning, deep threat analysis, external scanner
adapters, automatic patch application, and organization policy management are later
stages. They must use the same contracts instead of creating a second product path.

## Why This Is Needed

Ling already has useful pieces, but they answer different questions and cannot yet form a
durable review product:

| Existing capability | Current value | Missing product boundary |
| --- | --- | --- |
| `WorkspaceChangeReviewPage` | Shows current Git status, file tree, bounded diff, refresh, and file open actions | No review target identity, findings, comments, or history |
| `WorkspaceChangeReview` and Run/Turn/Workflow change contracts | Preserve scoped net diffs and recovery provenance | They describe workspace mutations, not an assessment result |
| `ReviewQueuePage` and review queue projections | Show approvals, external actions, and repair items | No code-review or security-scan lifecycle |
| `review` and `cso` built-in skills | Provide prompts and role/approval affinity | A skill invocation is not a traceable scan or finding record |
| Right Dock shell | Provides a compact secondary workbench | No review/security page manifest or target selector |
| GitHub automation design | Defines future external actions and approval boundaries | PR review UI and read-only review result contract remain unspecified |

The implementation must preserve the distinction between “there are no findings” and
“the scan failed or was incomplete.” A provider timeout, truncated source, unavailable
file, or failed validation is a visible scan status and coverage gap, never a clean result.

## Product Goals

- Give a user one obvious place to start a code review or security scan.
- Make the exact source revision, workspace, branch, and snapshot digest visible.
- Show useful findings with file/line locations, severity, confidence, evidence, and a
  short actionable explanation.
- Reuse the existing diff/file navigator and Right Dock instead of creating a parallel
  editor-like surface.
- Preserve a durable history that can be reopened after the Run or conversation ends.
- Keep review and scan execution read-only unless a separately approved remediation Run is
  started.
- Make cancellation, partial results, truncation, stale revisions, and recovery explicit.
- Keep secrets, credentials, arbitrary paths, and external mutations inside existing
  workspace and approval boundaries.
- Support a narrow Dock and a wider workbench without changing the underlying result model.

## Non-Goals

The following are intentionally outside the first implementation:

- Replacing GitHub's native review, branch protection, CODEOWNERS, or required checks.
- A generic SAST/SCA/secrets scanner marketplace.
- Always-on background scanning or a hosted multi-tenant security service.
- Full repository indexing before the local diff path is reliable.
- Automatic code writes, commits, pushes, merge requests, deployments, or secret rotation.
- A second approval database or a second Run execution engine.
- Copying Codex Desktop's visual styling, proprietary components, or closed implementation.
- Treating a model's severity label as a vulnerability truth without validation evidence.

## Reference Findings From Codex And Claude

### Patterns to borrow

The supplied Codex reverse-engineering package and public Codex material show a coherent
review workbench pattern:

- target selection for uncommitted changes, base branch, commit, custom target, and later
  pull requests;
- a changed-file tree paired with a focused diff viewer;
- unified, split, and automatic diff modes;
- path filtering, empty-line/import/word-wrap controls, and foldable hunks;
- finding or comment locations anchored to a path, revision, and line range;
- a read-only review execution path that can be inline in the current conversation or
  detached into a separate session;
- a summary before the raw file-by-file changes;
- review history and a list/detail split for repository-backed work.

Codex Security adds a separate scan workbench pattern:

- top-level `Scans`, `Findings`, and `Repositories` views;
- an explicit `+ Scan` action and scan history;
- visible stages for preparation, threat model, code review, validation, finding
  synthesis, and completion;
- finding details with summary, severity, confidence, root cause, attack path, validation,
  recommended fix, and code location;
- a remediation sequence of generate patch, apply patch, and verify fix;
- an explicit close reason for dismissed findings;
- APIs for cancellation, pagination, truncated results, resume, rename, and context update.

Claude Code's security review guidance adds two quality rules:

- prioritize high-confidence, exploitable issues and filter false positives rather than
  producing a large style report;
- distinguish a failed scan invocation from an empty result and retain enough evidence for
  a human to reproduce the conclusion.

### Patterns not to copy directly

- Codex Desktop's dark, editor-centered chrome does not match Ling's light conversation UI.
- A PR-only navigation model would hide local workspace work, which is the P0 use case.
- A finding score without source revision, coverage, or validation evidence is not an audit
  record.
- A one-click apply-patch action would bypass Ling's existing write-scope and approval
  policy.
- A scanner-specific database would split Run, Artifact, approval, and recovery history.

## Information Architecture

### Entry points

The user can reach the workbench from three places:

1. **Right Dock launcher**: `Review` opens the review landing page; `Security` opens the
   scan landing page. These are compact pages over the current conversation/workspace.
2. **Workspace or project navigation**: `Review & Security` opens the wider workbench with
   list/detail layout and persistent history.
3. **Run and changed-files summaries**: a `Review changes` action opens a preselected local
   target, preserving the current `cwd`, conversation, and Run scope.

The first release does not add a new top-level sidebar item if the current IA has no stable
slot for it. A contextual entry and a Settings/workspace-tools entry are sufficient for P0;
promotion to a primary navigation item is a product decision after usage evidence.

### Full workbench layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Review & Security     [Code review] [Security scans] [Findings] [Repositories] │
│ target: worktree • branch • revision • digest                 [New review] │
├───────────────────┬───────────────────────────────────────┬────────────────┤
│ filters / history │ selected run or scan                  │ detail         │
│                   │ summary / progress / findings         │ source context │
│ item rows         │ changed files + diff                  │ finding detail │
│                   │                                         │ evidence       │
└───────────────────┴───────────────────────────────────────┴────────────────┘
```

The full workbench may use a three-column arrangement at wide widths, but the data model
must also render as a two-column list/detail view. The source context and detail pane are
disclosure panels, not mandatory permanent columns.

### Right Dock layout

```text
Workspace tools → Review
  Review changes / Start review
  current target and status
  findings list
  file navigator
  selected finding detail

Workspace tools → Security
  Start scan
  scan phase and coverage
  findings list
  selected finding detail
```

The Dock is an inspection surface. It does not contain a second conversation transcript,
an unbounded raw log, or a separate approval queue. A user can open the associated Run,
Artifact, conversation, or full workbench when more context is needed.

## Code Review Design

### Review target picker

The target picker is the first page action and remains visible in the page header after a
review starts. P0 supports:

| Target | Source identity | Comparison |
| --- | --- | --- |
| Working tree | trusted workspace `cwd`, current branch, `HEAD` | staged, unstaged, and untracked changes |
| Branch diff | repository root, base ref, head ref | merge-base or explicit base policy |
| Commit | repository root, commit SHA | parent or selected base policy |

P1 adds a Pull Request target with repository, PR number, base SHA, and head SHA, and a
read-only GitHub source adapter. P2 may add a custom source only when it can provide a
stable revision and bounded content.

The picker must show a clear error when the path is outside the trusted workspace, the
ref cannot be resolved, the repository is not available, or a dirty target cannot be
captured consistently. It must never silently fall back to a different revision.

### Review page hierarchy

```text
Review header
  target badge / revision / digest
  status and last updated
  refresh / cancel / open run

Review summary
  findings by severity and confidence
  changed-file count and +/- statistics
  coverage and warnings
  review instructions disclosure

Review body
  changed-file tree (path filter, groups, stats)
  focused diff (unified/split/auto, fold, whitespace, imports, wrap)
  finding markers and line anchors

Finding detail
  summary / severity / confidence / status
  rationale and affected behavior
  code location and surrounding hunk
  suggested fix and validation evidence
  comment or follow-up action
```

The existing `WorkspaceChangeReviewPage` remains the source of truth for current Git
status and diff rendering. The new review page composes it with a review summary and
finding overlay; it does not duplicate Git parsing in React.

### Review controls

- `Review changes`: starts a read-only review using the selected target.
- `Refresh target`: re-resolves Git metadata and creates a new snapshot; it never mutates
  the previous review.
- `Open in conversation`: creates or links a normal Run with `turnTrigger: "code_review"`.
- `Open detached`: creates a review-specific conversation/run while keeping the result in
  the workbench.
- `Add instructions`: stores user-provided review instructions in the Run input snapshot;
  instructions are bounded, visible, and do not change permission policy.
- `Comment`: creates a review comment anchored to the finding revision and line range.
  Posting an external PR comment remains a separately approved action in P1.

Review controls must expose a read-only badge while the assessment is running. A review
cannot directly call write/edit tools, apply patches, commit, push, or send external
messages.

### Findings view

Default ordering is severity, confidence, file path, and line. The UI must not imply that
an empty list means clean code if `coverage.complete` is false or the review is partial.
Each row shows:

- severity (`critical`, `high`, `medium`, `low`, `info`);
- confidence (`high`, `medium`, `low`);
- status (`open`, `acknowledged`, `resolved`, `dismissed`, `stale`);
- concise title and path/line;
- a coverage or validation warning when applicable.

Line anchors are revision-bound. If a refresh changes the snapshot digest, the previous
finding remains readable but is marked `stale`; the UI must not move it to a new line by
guessing.

## Security Scan Design

### Scan creation

`+ Scan` opens a bounded creation form:

1. repository/workspace and trusted `cwd`;
2. target (`local diff` in P0, branch/repository later);
3. profile (`standard` in P0, `deep` later);
4. optional threat-model context and allowed paths;
5. provider/model selection within the existing provider policy;
6. network/dependency access disclosure, defaulting to disabled;
7. `Start scan` with the estimated scope and approval requirements.

The form summarizes what will be read and what will not be changed. If a scan requires
dependency installation, network access, credential access, or a tool outside the
read-only profile, the scan pauses at an approval boundary rather than broadening itself.

### Scan page hierarchy

The full workbench exposes three primary tabs:

- **Scans**: scan history, status, target, coverage, phase, and selected details.
- **Findings**: cross-scan findings filtered by repository, revision, severity, status,
  confidence, and owner.
- **Repositories**: P1/P2 repository profiles, default scope, retention, and policy links.

The Right Dock renders only the Scans and Findings subsets needed for the current
conversation. It uses the same result DTOs and does not create a Dock-specific scan model.

### Scan phases

The progress header shows the current phase and completed phases:

```text
preparing
  → threat_model
  → collecting_source
  → reviewing_code
  → validating_candidates
  → synthesizing_findings
  → completed
```

Every phase can end as `completed`, `partial`, `failed`, `cancelled`, or `blocked`. A
phase failure includes an actionable reason and the evidence collected before failure.
The scan summary displays `coverage` independently from the phase state.

### Finding detail

The detail pane uses this order so a user can decide quickly and then inspect evidence:

1. finding summary and status;
2. severity and confidence with the reason for both;
3. affected path and line range tied to the snapshot digest;
4. root cause and concrete attack path;
5. validation steps and validation result;
6. recommended fix and safer alternatives;
7. supporting artifacts, commands, and model/provider metadata allowed by privacy policy;
8. remediation and close actions.

The UI must label model-generated content as an assessment. A finding becomes
`validated` only when the validation contract has evidence; a model assertion alone is
`candidate`.

### Finding lifecycle actions

```text
candidate → validated → open
open → acknowledged | resolved | dismissed | stale
resolved → verify_pending → verified | reopened
```

Dismissal requires a reason (`false_positive`, `accepted_risk`, `not_reproducible`,
`duplicate`, or `out_of_scope`) and optional explanation. The reason is durable evidence,
not a local UI toggle.

Remediation is a separate flow:

```text
Generate patch (read-only proposal)
  → user reviews patch and write scope
  → Apply patch (approved write Run)
  → re-scan the exact changed target
  → Verify fix and update finding
```

`Apply patch` is disabled until the generated patch has a bounded `PatchPlan`, file hashes,
write scope, and an explicit approval. The security scan itself never applies the patch.

## Responsive UI Contract

The new pages follow the existing Right Dock contract rather than inventing a third
responsive system:

- above `900px`, the Dock is an inline, resizable column with real layout reservation;
- at or below `900px`, the Dock is unavailable and fully hidden; the workbench uses a
  full-page route or a modal page stack;
- `requestedOpen`, `available`, and `renderedOpen` are computed by the shared controller;
- a hidden Dock must not leave a blank reserved column, resize handle, or active
  `aria-expanded` state;
- the selected finding and selected file are URL/state-addressable so collapsing the Dock
  does not lose context;
- findings, file paths, phase labels, and severity controls remain keyboard accessible;
- the diff surface owns horizontal scrolling; the surrounding conversation document must
  not gain horizontal overflow;
- the narrow Dock renders one detail at a time. It does not compress the diff and finding
  panes into unreadable side-by-side columns.

Visual language stays consistent with Ling: light theme, existing button/input primitives,
soft panel elevation, compact rows, and restrained severity color. The Codex reference
contributes hierarchy and density, not dark styling.

## Proposed Domain Contracts

The following are proposed contracts. They are design targets, not declarations that these
types already exist in the repository.

### Shared source and snapshot identity

```ts
type ReviewTargetKind = "working_tree" | "branch_diff" | "commit" | "pull_request";

interface ReviewSourceRef {
  readonly kind: ReviewTargetKind;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly headRef?: string;
  readonly headSha?: string;
  readonly commitSha?: string;
  readonly externalRepository?: string;
  readonly externalNumber?: number;
}

interface ReviewSnapshot {
  readonly id: string;
  readonly source: ReviewSourceRef;
  readonly revision: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly truncated: boolean;
  readonly paths: readonly string[];
}
```

`revision` is a human-readable stable description. `digest` is the authority for finding
anchors and comparison. A working-tree digest must include the relevant HEAD, index,
unstaged content, and bounded untracked-file content. It must not be derived from a UI
timestamp or a mutable path alone.

### Review record and findings

```ts
type ReviewRunStatus =
  | "queued" | "running" | "completed" | "partial"
  | "failed" | "cancelled" | "stale";

interface CodeReviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly target: ReviewSourceRef;
  readonly status: ReviewRunStatus;
  readonly instructionArtifactId?: string;
  readonly resultArtifactId?: string;
  readonly findingIds: readonly string[];
  readonly coverage: ReviewCoverage;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type FindingKind = "code_review" | "security";
type FindingStatus = "candidate" | "open" | "acknowledged" | "resolved" |
  "dismissed" | "stale" | "verify_pending" | "verified" | "reopened";
type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
type FindingConfidence = "high" | "medium" | "low";

interface ReviewFinding {
  readonly id: string;
  readonly kind: FindingKind;
  readonly workspaceId: string;
  readonly reviewId: string;
  readonly scanId?: string;
  readonly snapshotId: string;
  readonly status: FindingStatus;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence;
  readonly title: string;
  readonly summary: string;
  readonly rootCause?: string;
  readonly attackPath?: string;
  readonly recommendation?: string;
  readonly location?: FindingLocation;
  readonly validation?: ValidationSummary;
  readonly evidenceArtifactIds: readonly string[];
  readonly closeReason?: FindingCloseReason;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FindingLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
  readonly hunkDigest?: string;
}
```

`ReviewFinding` is shared for UI projection, but the server validates `kind`-specific
required fields. A code review finding may omit attack path; a security finding cannot
become `validated` without validation evidence or an explicit `not_validated` reason.

### Coverage and validation

```ts
interface ReviewCoverage {
  readonly complete: boolean;
  readonly requestedPaths: number;
  readonly inspectedPaths: number;
  readonly skippedPaths: readonly { readonly path: string; readonly reason: string }[];
  readonly truncatedPaths: readonly string[];
  readonly unavailablePaths: readonly string[];
  readonly toolChecks: readonly {
    readonly name: string;
    readonly status: "passed" | "failed" | "skipped" | "not_run";
    readonly artifactId?: string;
  }[];
}

interface ValidationSummary {
  readonly status: "validated" | "not_reproduced" | "inconclusive" | "not_run";
  readonly method?: string;
  readonly artifactIds: readonly string[];
  readonly checkedAt?: string;
}
```

Coverage is immutable for a completed result. A refresh produces a new snapshot and new
coverage; it does not edit old evidence.

### Security scan record

```ts
type SecurityScanPhase =
  | "preparing" | "threat_model" | "collecting_source"
  | "reviewing_code" | "validating_candidates"
  | "synthesizing_findings" | "completed";

interface SecurityScanRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly profile: "standard" | "deep";
  readonly phase: SecurityScanPhase;
  readonly status: ReviewRunStatus;
  readonly threatModelArtifactId?: string;
  readonly coverage: ReviewCoverage;
  readonly findingIds: readonly string[];
  readonly reportArtifactId?: string;
  readonly parentScanId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type FindingCloseReason =
  | "false_positive" | "accepted_risk" | "not_reproducible"
  | "duplicate" | "out_of_scope";

interface RemediationRecord {
  readonly id: string;
  readonly findingId: string;
  readonly sourceSnapshotId: string;
  readonly patchArtifactId?: string;
  readonly applyRunId?: string;
  readonly verifyScanId?: string;
  readonly status: "proposed" | "awaiting_approval" | "applied" | "verified" | "failed" | "cancelled";
  readonly writeScope?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

The scan record references the normal Run for execution and the snapshot/artifacts for
audit. It is not a duplicate transcript. `parentScanId` links a verification or refreshed
scan to the previous assessment without mutating the previous result.

## Persistence And API Shape

### Storage boundary

Add a review/security storage slice alongside existing Run and Artifact persistence. The
slice should expose repository methods rather than letting the Web or a skill write
tables directly:

```text
ReviewStore
  createSnapshot / getSnapshot
  createCodeReview / updateCodeReview
  createFinding / updateFinding / listFindings
  createSecurityScan / updateSecurityScan / listScans
  createRemediation / updateRemediation
  appendReviewEvent
```

The first migration stores immutable snapshot metadata, review/scan state, normalized
finding rows, and references to existing artifact IDs. Large diff bodies, reports,
validation logs, and threat-model text remain bounded Artifacts. The store records content
digests and sizes; it does not accept arbitrary browser paths or unbounded JSON blobs.

### API families

The exact route names are to be decided during implementation, but the boundary is:

```text
GET  /workspaces/:id/review-targets
POST /workspaces/:id/review-snapshots
POST /workspaces/:id/code-reviews
GET  /workspaces/:id/code-reviews
GET  /workspaces/:id/code-reviews/:reviewId
POST /workspaces/:id/code-reviews/:reviewId/cancel

POST /workspaces/:id/security-scans
GET  /workspaces/:id/security-scans
GET  /workspaces/:id/security-scans/:scanId
POST /workspaces/:id/security-scans/:scanId/cancel

GET  /workspaces/:id/findings
POST /workspaces/:id/findings/:findingId/acknowledge
POST /workspaces/:id/findings/:findingId/close
POST /workspaces/:id/findings/:findingId/remediation
POST /workspaces/:id/remediations/:remediationId/verify
```

List endpoints are paginated and filter by workspace, source, snapshot, status, severity,
confidence, and updated time. Detail endpoints return bounded summaries first; diff and
artifact content use existing content-preview routes with size limits.

Events should be streamable through the existing Run/event mechanism. The client must be
able to reconnect and receive a current projection, not depend on replaying an unlimited
event log in the browser.

## Execution Chain

### Shared snapshot pipeline

```text
user chooses target
  → daemon validates workspace and target refs
  → daemon resolves repository metadata
  → daemon captures bounded source/diff snapshot
  → daemon computes revision and snapshot digest
  → snapshot is persisted before model execution
  → review or scan Run receives the immutable snapshot reference
```

The snapshot capture reuses the existing workspace-change reader for local working-tree
and scoped Run/Turn/Workflow views. It preserves staged, unstaged, untracked, added,
deleted, renamed, truncated, and unavailable states. An unavailable or truncated path is
included in coverage and cannot be silently omitted.

### Code review execution

```text
create CodeReviewRecord(status=queued)
  → start normal read-only Run(turnTrigger=code_review)
  → inspect snapshot and review instructions
  → analyze changed files in bounded batches
  → validate each finding's path, line range, and snapshot digest
  → persist findings and evidence artifacts
  → publish summary and coverage
  → complete / partial / failed / cancelled
```

The reviewer uses the existing `review` skill prompt or a future dedicated review runner,
but the output is parsed into the structured finding contract. Unparseable model output is
stored as a diagnostic artifact and causes a partial/failed result; it is not presented as
a clean review.

### Security scan execution

```text
create SecurityScanRecord(status=queued)
  → prepare target and policy
  → build threat model artifact
  → collect source and dependency context allowed by policy
  → review code and produce candidates
  → validate high-confidence candidates with read-only checks
  → synthesize findings, coverage, and report artifact
  → complete / partial / failed / cancelled
```

Candidate generation and validation are separate steps. Validation may run a bounded test,
static query, or local reproduction only when the profile permits it. A failed validation
does not automatically dismiss a candidate; it sets `inconclusive` and records the reason.

### Run and conversation relationship

- Code review uses one normal Run and may surface results inline or detached.
- Security scan uses one normal Run per execution phase group and one durable Scan record.
- Remediation creates a new implementation Run linked to the finding and source snapshot.
- Verification creates a new scan linked by `parentScanId`.
- Review/scan UI reads projections; it does not infer completion from an approval row or a
  conversation message.

## State And Recovery Rules

### Review and scan state transitions

```text
queued → running → completed
queued → cancelled
running → partial | failed | cancelled
completed → stale       (when its source is superseded or invalidated)
partial → stale         (same rule)
```

Only the daemon may advance terminal states. Reconnect after daemon restart first reads
the persisted record, then reconciles an active Run. A missing Run or provider result
becomes `failed` with a recovery reason; it does not disappear from history.

### Cancellation

Cancellation is cooperative:

1. mark the review/scan as cancellation requested;
2. stop admitting new batches;
3. let the active read-only tool call settle or time out;
4. persist partial findings and coverage;
5. transition to `cancelled` with a cancellation event.

The UI keeps a cancelled result and offers `Run again` against a new snapshot. It does not
reuse a possibly changed working tree under the old digest.

### Refresh and stale findings

Refreshing a dirty workspace creates a new snapshot. Findings from the old snapshot remain
available for comparison but are `stale` when their location or source hash no longer
matches. The server must reject an update that claims to resolve a finding against a
different snapshot unless the caller supplies an explicit migration/verification link.

## Permissions And Security Boundaries

### Review profile

The default review profile is read-only:

- read files only inside the trusted workspace and selected repository;
- read Git metadata needed to resolve the target;
- no write/edit/patch/commit/push/merge actions;
- no credential reads;
- no external network unless an explicit future adapter and approval allow it;
- no arbitrary shell commands; permitted checks must be allowlisted and bounded.

The reviewer is displayed with a `Read-only` policy badge. This is an execution policy,
not merely a prompt instruction.

### Security profile

Security scans use the stricter security approval profile from the `cso` skill family:

- workspace and path containment are checked before every read;
- secrets are redacted before model/provider transmission where the existing redaction
  contract allows it;
- environment variables, keychain entries, tokens, SSH keys, and credential files are
  never included by broad directory traversal;
- network, dependency installation, external scanner calls, and credential use require a
  distinct policy decision;
- scan output is treated as untrusted text and cannot become an executable command or
  automatic external action;
- generated patches inherit the finding's workspace and file-scope boundary.

### GitHub and external actions

P1 PR review may read GitHub data through the existing GitHub source adapter. Posting a
comment, requesting changes, labeling, pushing a branch, or merging stays in the external
action approval path described by `github-automation.md`. A local review result cannot
silently become an external PR mutation.

### Privacy and retention

The UI shows the source, provider, and data-scope summary before starting. Snapshots and
artifacts obey existing workspace retention and deletion rules. Finding rows retain
digests and references rather than duplicating full source files. Redacted evidence must
remain useful for validation; if redaction makes validation impossible, coverage says so.

## Architecture Options And Selection

Complexity warrants comparing two shapes before implementation.

### Option A: run-only review model

```text
Review button → normal Run → Run artifacts → UI derives findings
```

Advantages:

- smallest schema and implementation surface;
- immediate reuse of Run, conversation, Artifact, and existing event streaming;
- natural inline/detached review behavior.

Costs:

- security scan history and finding lifecycle become fragile projections of free-form
  artifacts;
- re-scan, cross-scan comparison, close reasons, and remediation links require parsing
  old output;
- a finished review cannot be addressed reliably when the Run is compacted or archived.

### Option B: first-class review/scan aggregates

```text
Review/Scan aggregate → normal Run for execution → normalized findings + artifacts
```

Advantages:

- stable target, revision, digest, finding, coverage, and remediation identity;
- clean list/detail UI and resumable state machines;
- security scan can outlive one Run and compare with later scans;
- external PR review can attach without changing local review semantics.

Costs:

- new contracts, storage, migrations, APIs, and projections;
- requires careful reconciliation so the aggregate cannot diverge from Run truth;
- more work before the first visible result.

### Selected shape: hybrid first-class aggregate

Use Option B for durable `CodeReviewRecord`, `SecurityScanRecord`, snapshots, findings,
coverage, and remediation. Use the existing normal Run/Conversation for actual model and
tool execution. This preserves Ling's execution and approval boundary while giving the UI
stable records and the security workflow its own lifecycle.

The aggregate owns product state and immutable source identity. The Run owns execution
events and tool evidence. A reconciliation adapter links the two and marks aggregate
failure when the Run cannot be recovered. Neither side writes the other's internal store.

## Architecture Review

- **Boundary**: snapshot capture belongs in daemon/workspace infrastructure; findings and
  scan lifecycle belong in a review domain slice; rendering belongs in Web and shared
  conversation UI. No Git parsing or security policy belongs in React.
- **Source of truth**: Git/workspace readers own current source; persisted snapshots own
  historical target identity; Run owns execution events; review/scan records own product
  state; Artifacts own large evidence content.
- **Failure semantics**: partial, failed, cancelled, stale, and incomplete coverage are
  first-class states. There is no clean fallback for a missing result.
- **External boundaries**: GitHub and scanner adapters create source/evidence records and
  proposed actions; they do not bypass Ling's scheduler, approval, or action executor.
- **Migration**: P0 can add new tables/contracts without rewriting existing workspace
  change records. Existing current workspace review remains available during rollout.
- **Recovery**: all mutations remain in a separate remediation Run and therefore reuse
  existing patch provenance and undo/reapply safeguards.

## Code Quality Review

- Keep DTOs in `packages/contracts` and runtime orchestration in `packages/daemon`/`packages/core`.
- Use discriminated unions for target kind, phase, status, and closure reason.
- Validate all server inputs at the boundary: workspace ID, target refs, paths, line ranges,
  pagination, instruction size, and artifact references.
- Reuse the existing `WorkspaceChangesResponse` and `WorkspaceChangeReview` projections;
  do not create subtly different `ReviewFile` and `ChangeFile` shapes in each UI package.
- Keep model output parsing isolated behind a schema validator. Do not let arbitrary JSON
  from a provider become a persisted finding.
- Keep comments and labels descriptive of current behavior. Historical rationale belongs
  in this design or Git history, not in product code comments.
- Prefer small view-model adapters for Dock/full-workbench differences rather than two
  independent data-fetching implementations.

## Test Review

Testing follows the repository testing policy and must cover behavior and boundaries.

### Contract and unit tests

- target normalization for working tree, branch, commit, and invalid/missing refs;
- snapshot digest changes when HEAD/index/unstaged/untracked content changes;
- path containment, symlink escape, bounded file size, truncation, and redaction;
- finding schema validation, line-range validation, duplicate identity, and stale digest;
- coverage projection distinguishes clean, partial, failed, and unavailable;
- state-machine transitions, illegal transitions, idempotent cancel, and restart recovery;
- close reasons and remediation status transitions;
- pagination/filter ordering and deterministic summary counts.

### Daemon and integration tests

- create review/scan, stream progress, reconnect, complete, and reopen history;
- provider timeout, malformed output, tool failure, and cancellation preserve evidence;
- review uses read-only policy and cannot invoke write/edit/commit/external actions;
- security scan pauses for network/dependency/credential approval and resumes correctly;
- apply-patch remediation creates a separate approved Run and verifies exact file hashes;
- stale finding cannot be resolved against a different snapshot without a verification link;
- GitHub adapter (P1) cannot post a comment without an external action approval.

### Web and UI tests

- target picker validation and explicit revision/digest display;
- list/detail filters, severity/status labels, finding-to-file navigation, line anchors,
  refresh and stale state;
- unified/split/auto diff controls and bounded lazy loading;
- narrow Dock availability at `900px`, resize behavior above the threshold, keyboard focus,
  and no horizontal document overflow;
- scan phase timeline, coverage warning, cancellation, partial result, and failed-scan
  copy;
- remediation dialog shows write scope and approval state; no direct write action from
  review/scan pages.

### Acceptance fixtures

Maintain small deterministic repositories containing:

- staged, unstaged, untracked, renamed, deleted, binary, and oversized files;
- a high-confidence security issue, a false positive, a duplicate, and an inconclusive
  validation;
- a changed line that moves after refresh;
- a provider failure after candidates are emitted;
- a remediation patch that conflicts because a user edited the file afterward.

## Performance And Resource Review

Performance must be measured on fixtures before budgets are finalized. The initial targets
are:

- opening the review/scan shell must not wait for full diff bodies or model output;
- changed-file metadata and summary should render from one bounded response, with selected
  diff bodies loaded lazily;
- no single API response may contain unbounded source, findings, logs, or artifact text;
- large file lists use pagination or virtualization; file tree filtering is indexed in the
  view model rather than repeatedly scanning the DOM;
- at most one active local scan per workspace in P0 unless the existing concurrency policy
  explicitly permits more;
- model input is batched by bounded bytes/tokens, with a visible skipped/truncated path;
- cancellation stops admission of new batches and releases the workspace/run lease;
- report generation and list queries use indexed workspace, snapshot, status, severity,
  and updated-at fields;
- repeated refreshes are deduplicated by target digest and do not create duplicate active
  scans for the same request.

The implementation should collect timings for snapshot capture, first summary, first
finding, final result, peak bytes, and cancellation latency. A slow scan is acceptable if
the UI exposes progress and partial evidence; an unbounded scan is not.

## Implementation Plan

This is a design plan only. The following phases name likely files and ownership so the
implementation can start without reopening the product decisions.

### P0 — Local review and local diff security scan

**Outcome**: a user can review local working-tree/branch changes and run a standard
read-only security scan against the same immutable snapshot.

**Contracts and storage**

- Add proposed review/scan/finding/coverage/remediation contracts under
  `packages/contracts/src/` and export them from the contract index.
- Add a daemon/core review store and migration next to existing Run/Artifact storage.
- Add target normalization and snapshot capture adapters that reuse
  `packages/daemon/src/features/previews/workspace-changes.ts` and current workspace
  review contracts.
- Add strict model-output schemas and normalized finding validation.

**Execution**

- Add a read-only code-review coordinator that starts a normal Run with the
  `code_review` trigger and persists a `CodeReviewRecord`.
- Add a standard security-scan coordinator with explicit phases, coverage, and
  cancellation/restart reconciliation.
- Link evidence artifacts and source refs to the existing Run/Artifact model.

**API and UI**

- Add review/scan/finding API clients under `apps/web/src/api/`.
- Extend the shared Right Dock page manifest and `WorkspaceRightDock` with Review and
  Security pages.
- Add the full workbench route/page and view models; compose the existing
  `WorkspaceChangeReviewPage` and `ReviewQueuePage` primitives.
- Add target picker, summary, finding detail, phase timeline, coverage warning, and
  read-only/remediation disclosures.

**P0 verification**

- contract, store, state-machine, target/snapshot, and redaction tests;
- daemon integration tests for success, partial, failure, cancel, reconnect, and stale;
- Web tests at wide and narrow Dock widths;
- `check:docs`, package typechecks, and the owning targeted tests.

### P1 — GitHub pull-request review

**Outcome**: a user can open a read-only PR review with stable base/head identity and
optionally propose an external inline comment through approval.

- Implement a GitHub source adapter using `github-automation.md` boundaries.
- Add PR target fields, repository/branch/PR list filters, and `created by / needs my
  review / team review` views.
- Add inline comment proposal artifacts and an external action approval path.
- Reconcile webhook/poll changes by creating a new snapshot and marking old findings stale.
- Add GitHub permission, branch protection, rate-limit, and external-action tests.

### P2 — Full repository, deep scan, and remediation verification

**Outcome**: users can run explicit full/deep scans and verify approved fixes without
blurring local and external permissions.

- Add repository profiles, scope exclusions, retention, and organization policy hooks.
- Add deep threat-model and dependency/context phases behind an explicit profile.
- Add external scanner adapters with normalized evidence and coverage contracts.
- Add patch generation/apply/verify UI backed by normal approved Runs and exact hash checks.
- Add cross-scan comparison, trends, export/report artifacts, and repository-level findings.

Each phase must leave the prior path functional and must not silently upgrade a local
read-only review into an external or write-capable workflow.

## Proposed Implementation File Map

Names are placeholders for implementation planning; maintainers may choose existing module
names when the owning package has a better home.

```text
packages/contracts/src/review.ts
packages/contracts/src/security-scan.ts
packages/contracts/src/index.ts

packages/core/src/review-types.ts
packages/core/src/security-scan-types.ts
packages/core/src/review-output-validation.ts

packages/daemon/src/features/review/review-store.ts
packages/daemon/src/features/review/review-coordinator.ts
packages/daemon/src/features/security/security-scan-coordinator.ts
packages/daemon/src/features/security/security-policy.ts
packages/daemon/src/features/previews/workspace-changes.ts  (reuse/extend only)

apps/web/src/api/code-review.ts
apps/web/src/api/security-scans.ts
apps/web/src/features/review/ReviewWorkbenchPage.tsx
apps/web/src/features/review/ReviewTargetPicker.tsx
apps/web/src/features/review/ReviewFindingDetail.tsx
apps/web/src/features/security/SecurityScanPage.tsx
apps/web/src/features/security/SecurityFindingDetail.tsx
apps/web/src/features/workspace/right-dock/WorkspaceRightDock.tsx  (page wiring only)

packages/conversation-ui-react/src/dock/ReviewWorkbenchPage.tsx
packages/conversation-ui-react/src/dock/review-view-model.ts
```

The file map is an ownership guide, not permission to create duplicate data access layers.
Before implementation, confirm the current package boundaries and existing migration
conventions.

## Acceptance Matrix

| Area | Acceptance evidence |
| --- | --- |
| Local review | Working tree, branch diff, staged/unstaged/untracked, rename/delete, and empty states render with stable digest |
| Security scan | Standard local diff scan shows phases, coverage, findings, partial/failure, cancel, and reopen behavior |
| Finding integrity | Every location resolves against its snapshot; changed revision marks findings stale |
| Read-only boundary | Review/scan cannot write files, invoke unapproved network/credentials, or perform external actions |
| Evidence | Run, snapshot, finding, validation, coverage, and Artifact references remain after the conversation closes |
| Remediation | Patch generation is read-only; apply and verify require a separate approved Run and hash checks |
| UI | Wide workbench and narrow Dock share data, preserve keyboard access, and avoid document overflow |
| Recovery | Daemon restart, provider failure, malformed output, and cancellation leave an explicit durable state |
| GitHub P1 | PR source identity and external comment proposal stay inside GitHub adapter and approval contracts |
| Docs | This design and the design index reflect actual implementation state after each delivery phase |

## Open Decisions And Defaults

These choices do not block P0; the listed defaults should be used unless implementation
evidence requires a change:

| Question | Default for this plan | Revisit when |
| --- | --- | --- |
| Primary entry point | Right Dock plus workspace-tools contextual entry | Usage shows a stable need for primary sidebar promotion |
| First target | Local working tree and local branch diff | P0 result history and snapshot capture are reliable |
| Scan profile | Standard read-only diff scan | Threat-model and validation fixtures support deep mode |
| Provider | Existing configured Ling provider/model policy | Provider-specific structured output needs a dedicated adapter |
| Network | Disabled by default | An adapter documents scope, approval, and evidence requirements |
| Comments | Local finding/comment record first | GitHub adapter and external action approval are ready |
| Patch application | Separate approved implementation Run | Hash/provenance and undo/reapply tests pass |
| Retention | Existing workspace/Run/Artifact retention | Repository-level policy and export requirements are accepted |

## What Is Not Yet Implemented

At this design baseline Ling does not have the first-class review/scan records, target
picker, scan phases, finding lifecycle, or remediation workflow described above. Existing
workspace diff/review and Review Queue capabilities remain available and are the intended
foundation. This document should be updated from actual code and verification evidence as
each phase lands; it must not be treated as proof of runtime support before then.
