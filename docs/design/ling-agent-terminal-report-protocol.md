# Ling Agent TerminalReport Protocol

Status: canonical detailed design; semantic publication/reconnect behavior and explicit
Node 22 transaction ownership exist. Required-participant coverage and the
single-terminal-projection amendment are implemented in the active WIP and focused
regressions are green. The corrected full Daemon aggregate and repository gates must be
rerun before fresh packaged macOS acceptance.
Date: 2026-07-11
Scope: channel workflows, direct runs, normal conversations, teammate private chats,
multi-agent participation, terminal evidence, and shared conversation projection

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)

## Purpose

This document defines the user-facing terminal result protocol for Ling Agent work.

The legacy path preserves runner assistant text as a workflow-step `resultSummary`, then
creates a terminal coordinator message by selecting the last non-generic step summary and
wrapping it in deterministic `Done` / `Result` copy. The active implementation also has
first-class TerminalReport records, evidence collection, synthesis, validation, and an
atomic workflow publication barrier. Focused publication/restart, daemon transport, and
Web reconnect tests and the full deterministic matrix are green; packaged macOS
acceptance remains in progress. The legacy
summary path is durable and simple, but it is not a
complete final-report contract. It cannot reliably explain:

- the final outcome and any necessary correction to the user's premise;
- the important changes and behavior differences across multiple steps;
- which checks actually ran and what their final state was;
- which agents participated and what each contributed;
- which files, documents, pull requests, commits, or other artifacts were produced;
- which risks remain unresolved or which expected checks were not run;
- which durable evidence supports each claim.

The target is not a longer prose template. The target is a typed, evidence-backed
`TerminalReport` that Ling Agent can render naturally for the current task while Web,
Desktop, and CLI surfaces consume the same semantic result.

## Product Rule

Every executed user task gets at most one terminal report for each completed work
generation.

An ordinary `channel_ai_reply` is a conversational answer, not an executed user-task
generation. It never receives a TerminalReport, even when its Run emits tool or evidence
events such as starting a conversation-owned media job. The conversation projection for
that media job owns its queued, running, success, and failure state.

```text
user request
  -> Ling Agent session
  -> optional workflow / run / approval / multi-agent work
  -> terminal evidence snapshot
  -> TerminalReport synthesis
  -> evidence validation
  -> durable report publication
  -> final_result transcript block
```

The report belongs to the Ling Agent session, even when specialists or external runners
performed the work.

Runner terminal text is evidence. It is not automatically the final user-facing report.

Workflow state, run state, approval state, artifacts, and recorded execution actions are
authoritative. Model-generated prose must not override those records.

## Goals

- Produce final answers with enough detail to explain what changed, what was verified,
  and what remains uncertain.
- Keep output adaptive: a small direct edit should stay short, while multi-step work can
  use sections and evidence references.
- Preserve one coordinated Ling Agent answer instead of exposing a raw transcript from
  every participating agent.
- Make every important factual claim traceable to durable evidence.
- Prevent model text from inventing successful tests, file changes, approvals, commits,
  pull requests, deployments, or teammate participation.
- Keep process history folded and expandable after the final result is published.
- Provide a deterministic fallback when synthesis is unavailable or invalid.
- Support normal conversation, channel conversation, and teammate private chat through
  the shared transcript contract.

## Non-Goals

- Do not replace workflow, run, approval, action, artifact, or thread evidence records.
- Do not store raw chain-of-thought or private model reasoning in the report.
- Do not publish hidden teammate prompts or unpromoted private specialist discussion.
- Do not force every report to show all seven sections.
- Do not make the Web renderer infer sections from markdown headings or copy prefixes.
- Do not duplicate full operation logs, diffs, artifact previews, or source inventories
  inside the final prose.
- Do not treat a report as permission to perform another side effect.
- Do not make a terminal report mandatory for a direct conversational answer that did
  not execute work or produce evidence.

## Ownership Boundary

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| Runner | Execute one attempt and emit assistant text, tool events, actions, checks, and artifacts | Claim workflow-wide completion or publish the session report |
| Workflow step | Persist step-local status, blocker, result summary, output packet, and artifact refs | Represent unrelated steps or aggregate the whole workflow |
| Orchestrator | Own legal workflow transitions, approvals, fan-out/fan-in, recovery, and terminal detection | Generate user-facing facts from prose heuristics |
| Terminal evidence collector | Build a bounded deterministic snapshot from durable records | Rewrite source state or infer unsupported success |
| Ling report synthesizer | Organize supported facts into a useful semantic report | Invent evidence or change terminal state |
| Report validator | Enforce schema, status, provenance, privacy, and claim constraints | Improve prose by changing facts |
| Report publisher | Persist the committed report and attach it to the owning turn | Re-run completed work |
| Conversation projector | Project the report into `final_result`, participant, artifact, and evidence blocks | Parse prose to reconstruct the report |
| Renderer | Display semantic fields according to surface policy | Reach into raw workflow/run records to invent extra first-level UI |

The resolved architecture decision is:

**Daemon/core owns evidence normalization, validation, persistence, and publication.
Ling Agent owns semantic synthesis. Web only renders the committed protocol.**

## Two-Layer Contract

Terminal reporting has two different typed objects.

```text
TerminalReportEvidenceSnapshot
  deterministic, source-backed, bounded, not user prose

TerminalReport
  semantic user-facing result, validated against the snapshot
```

This separation is required. Passing raw logs directly to a final model wastes context,
and accepting free-form model prose makes facts unauditable.

## Evidence Source References

Every report item that makes a factual claim has source refs.

```ts
type TerminalReportSourceRefKind =
  | "message"
  | "turn"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "operation"
  | "execution_action"
  | "approval"
  | "artifact"
  | "file"
  | "check"
  | "commit"
  | "pull_request"
  | "deployment"
  | "memory"
  | "context_source"
  | "external";

interface TerminalReportSourceRef {
  readonly kind: TerminalReportSourceRefKind;
  readonly id: string;
  readonly label?: string;
  readonly href?: string;
  readonly visibility: "conversation" | "folded_evidence" | "developer_only";
  readonly sensitivity?: "normal" | "private" | "secret_adjacent";
}
```

Rules:

- `id` is a durable local id or a normalized external identity.
- `href` is allowed only for validated local or external targets.
- Secret-adjacent values never expose body text, tokens, credentials, or raw command
  environment in the default report.
- Private teammate evidence can support the coordinator report only when policy allows
  promotion into the owning session. The report may summarize the contribution but must
  not quote private prompt text by default.
- A source ref can appear in folded evidence without becoming a visible inline citation.

### Privacy lineage enforcement (2026-09-06)

- Host evidence owns both visibility and sensitivity. Validation must compare model
  refs against the strongest policy for the same `(kind, id)`, including duplicates
  across evidence sections. A model may further restrict a ref but cannot downgrade
  `developer_only` to folded/conversation, folded to conversation, or private/secret
  sensitivity to normal/unspecified. Invalid output follows the existing repair/fallback path.
- Report DTO adapters preserve the exact policy markers. Normal/private/channel use
  one shared adapter; the generic Timeline ref type carries these markers through
  normalization. This does not grant file-opening or other Host capabilities.
- Post-model Host enrichment carries the complete evidence section's source refs
  when rebinding participant contributions or artifact references. Retain the model's
  original refs alongside Host refs until validation: overwriting a weaker model alias
  would conceal a privacy downgrade. The shared visibility projection then withholds
  restricted enriched sections; durable evidence and audit content remain unchanged.
- Before synthesis, filter the model-visible snapshot by the same whole-section
  principle. Compute restricted identities from all original Host refs before
  deduplication; remove restricted section bodies as well as links, including mixed
  refs and public aliases. Preserve the original evidence snapshot and fingerprint
  for validation, completion decisions, persistence, and audit.
- The requirement for nonempty verification applies when a successful snapshot has
  model-visible checks. If all checks were withheld by the strongest Host privacy
  policy, their omission must not trigger a repair/fallback loop. Outcome compatibility,
  claimed check evidence, completion gates, and durable checks still use all Host facts.
- Visibility filtering examines whole sections, not only their links. A section tied
  to developer-only, secret-adjacent, or unpromoted private/audit evidence must not
  expose its title, body, command, path, artifact, or copy text. Mixed public/restricted
  refs remain restricted; a public duplicate cannot launder a restricted identity.
- A restricted outcome retains only the Host-owned terminal status expressed using
  existing localized deterministic outcome copy. Its model title/body and corrections
  are omitted. Filtering does not change outcome status, report generation, fingerprint,
  required participant evidence, or stored history.
- Shared Timeline projection, result details, legacy ViewModel adapters still in use,
  and final-result copy use the same policy. Copy may inspect privacy flags but must
  never serialize source identity, private labels, hidden content, or raw evidence.
- Tests must cover Host downgrade rejection, ordinary/private/channel DTO parity,
  mixed/duplicate refs, every section, visible safe content, and copied content.
  No new SQLite table or history rewrite is needed. Packaged verification remains a
  separate gate after source tests; fixture privacy sentinels are not real secrets.

## TerminalReportEvidenceSnapshot

The evidence snapshot freezes the facts used for one report generation.

```ts
interface TerminalReportEvidenceSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly surface: "normal_conversation" | "channel" | "teammate_private_chat";
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly source:
    | { readonly kind: "workflow"; readonly id: string }
    | { readonly kind: "run"; readonly id: string }
    | { readonly kind: "turn"; readonly id: string };
  readonly objective: string;
  readonly language: "zh-CN" | "en-US";
  readonly terminalState: TerminalReportOutcomeStatus;
  readonly terminalAt: string;
  readonly steps: readonly TerminalReportEvidenceStep[];
  readonly operations: readonly TerminalReportEvidenceOperation[];
  readonly checks: readonly TerminalReportEvidenceCheck[];
  readonly participants: readonly TerminalReportEvidenceParticipant[];
  readonly requiredParticipantCoverage: readonly TerminalReportRequiredParticipantCoverage[];
  readonly artifacts: readonly TerminalReportEvidenceArtifact[];
  readonly approvals: readonly TerminalReportEvidenceApproval[];
  readonly risks: readonly TerminalReportEvidenceRisk[];
  readonly references: readonly TerminalReportSourceRef[];
  readonly evidenceFingerprint: string;
  readonly generatedAt: string;
}

type TerminalReportOutcomeStatus =
  | "succeeded"
  | "partially_succeeded"
  | "blocked"
  | "failed"
  | "cancelled";
```

The snapshot is assembled from existing durable state:

| Snapshot field | Current source candidates |
| --- | --- |
| Objective and source turn | channel message, workflow objective/title, task snapshot, thread goal |
| Terminal state | workflow/run/session state machines |
| Steps | `ChannelWorkflowStep`, output packets, fan-in artifacts |
| Operations | execution actions and normalized run events |
| Checks | test/check command actions, check artifacts, step gates, completion verification |
| Participants | actual workflow step assignees, run teammate ids, promoted contribution records |
| Required participant coverage | immutable participant manifest plus committed Completion Gate results |
| Artifacts | run artifacts, output packets, changed paths, validated external work refs |
| Approvals | approval requests and checkpoints |
| Risks | blockers, failures, denied approvals, skipped required checks, unresolved diagnostics |
| References | source refs already attached to packets, actions, artifacts, memory, and context |

### Evidence Step

```ts
interface TerminalReportEvidenceStep {
  readonly id: string;
  readonly title: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "skipped";
  readonly teammateId?: string;
  readonly runId?: string;
  readonly resultSummary?: string;
  readonly blocker?: string;
  readonly changedPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

`resultSummary` remains step-local. The snapshot must never present it as a workflow-wide
result without aggregation.

### Evidence Operation

```ts
interface TerminalReportEvidenceOperation {
  readonly id: string;
  readonly kind:
    | "read"
    | "search"
    | "edit"
    | "command"
    | "check"
    | "browser"
    | "approval"
    | "external"
    | "other";
  readonly title: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "unknown";
  readonly runId?: string;
  readonly teammateId?: string;
  readonly changedPaths: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Raw stdout and full command payloads remain folded evidence. The snapshot carries only
the bounded semantic title, state, affected paths, and refs needed for synthesis.

### Evidence Check

```ts
type TerminalReportCheckStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "not_run"
  | "unknown";

interface TerminalReportEvidenceCheck {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalReportCheckStatus;
  readonly command?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly runId?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

The collector must distinguish `passed`, `skipped`, `not_run`, and `unknown`. Missing
evidence never becomes `passed`.

### Evidence Participant

```ts
interface TerminalReportEvidenceParticipant {
  readonly agentId: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly status: "completed" | "failed" | "blocked" | "cancelled";
  readonly workflowStepIds: readonly string[];
  readonly runIds: readonly string[];
  readonly contributionSummaries: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Participation is based on actual execution or a promoted contribution record. Roster
membership, selector candidacy, or an unstarted workflow step does not count.

Required coverage is a separate audit fact and is not a contribution summary:

```ts
interface TerminalReportRequiredParticipantCoverage {
  readonly agentId: string;
  readonly status: "satisfied" | "missing" | "blocked" | "failed" | "cancelled";
  readonly workflowStepIds: readonly string[];
  readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
  readonly reasonCode?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

The collector emits one row for every manifest participant whose requirement is
`required`, even when no step or Run started. `participants` continues to mean actual
contributions; `requiredParticipantCoverage` proves whether fan-in was satisfied. A
`missing`, `blocked`, `failed`, or `cancelled` required row affects the report outcome and
produces a source-linked blocker/risk. It cannot disappear because the contribution
summary omits unstarted agents. Optional participants remain contribution-only facts and
never enlarge the required quorum unless the immutable graph marks them as a dependency.

The Ling Agent coordinator is not repeated as a participant unless it performed a
distinct recorded contribution that is useful to the user. It remains the report owner.

### Evidence Artifact

```ts
type TerminalReportArtifactKind =
  | "file"
  | "diff"
  | "document"
  | "image"
  | "test_result"
  | "commit"
  | "pull_request"
  | "deployment"
  | "external"
  | "other";

interface TerminalReportEvidenceArtifact {
  readonly id: string;
  readonly kind: TerminalReportArtifactKind;
  readonly title: string;
  readonly path?: string;
  readonly href?: string;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly changedPaths: readonly string[];
  readonly status?: "created" | "updated" | "published" | "merged" | "failed";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Git commits, pull requests, and deployments require validated external-work or Git
evidence. A model-written URL is not sufficient.

### Evidence Approval

```ts
interface TerminalReportEvidenceApproval {
  readonly id: string;
  readonly title: string;
  readonly actionType: string;
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

### Evidence Risk

```ts
interface TerminalReportEvidenceRisk {
  readonly id: string;
  readonly severity: "info" | "warning" | "critical";
  readonly status: "unresolved" | "mitigated" | "accepted" | "unverified";
  readonly summary: string;
  readonly nextAction?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Risks include failed checks, checks that were expected but not run, partial output,
blocked approvals, unresolved merge conflicts, unavailable services, and evidence that
could not be verified.

## TerminalReport

`TerminalReport` is the canonical semantic result consumed by conversation projectors.

```ts
interface TerminalReport {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly source:
    | { readonly kind: "workflow"; readonly id: string }
    | { readonly kind: "run"; readonly id: string }
    | { readonly kind: "turn"; readonly id: string };
  readonly status: "draft" | "validating" | "committed" | "fallback" | "failed";
  readonly language: "zh-CN" | "en-US";
  readonly outcome: TerminalReportOutcome;
  readonly changes: readonly TerminalReportChange[];
  readonly verification: readonly TerminalReportVerification[];
  readonly participants: readonly TerminalReportParticipant[];
  readonly requiredParticipantCoverage: readonly TerminalReportRequiredParticipantCoverage[];
  readonly artifacts: readonly TerminalReportArtifact[];
  readonly risks: readonly TerminalReportRisk[];
  readonly references: readonly TerminalReportSourceRef[];
  readonly evidenceSnapshotId: string;
  readonly evidenceFingerprint: string;
  readonly synthesis: TerminalReportSynthesisMetadata;
  readonly createdAt: string;
  readonly committedAt?: string;
}
```

### Outcome

```ts
interface TerminalReportOutcome {
  readonly status: TerminalReportOutcomeStatus;
  readonly title: string;
  readonly summary: string;
  readonly corrections: readonly TerminalReportCorrection[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

interface TerminalReportCorrection {
  readonly id: string;
  readonly originalAssumption: string;
  readonly correctedFact: string;
  readonly confidence: "high" | "medium";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Corrections are optional. They appear only when the supplied evidence materially
contradicts an assumption relevant to the result. Low-confidence speculation must not be
presented as a correction.

### Changes

```ts
interface TerminalReportChange {
  readonly id: string;
  readonly kind: "behavior" | "code" | "configuration" | "documentation" | "data" | "other";
  readonly title: string;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Changes explain user-visible or technically important differences. They do not repeat
every edit operation. File-level detail remains in the artifact strip and diff preview.

### Verification

```ts
interface TerminalReportVerification {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalReportCheckStatus;
  readonly summary?: string;
  readonly command?: string;
  readonly durationMs?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Only verification items backed by check evidence can claim `passed` or `failed`.

### Participants

```ts
interface TerminalReportParticipant {
  readonly agentId: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly status: "completed" | "failed" | "blocked" | "cancelled";
  readonly contribution: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

Rules:

- Omit `participants` when no specialist actually participated.
- Do not show unstarted, merely selected, or ambient observer teammates.
- Always persist required-participant coverage for workflow reports. The default UI may
  omit satisfied rows that add no useful contribution text, but it must render every
  non-satisfied required row in the blocked/failed/partial outcome.
- Multiple rounds by the same agent aggregate into one participant contribution in the
  final report; process history keeps each round in its original row.
- Agent display names are presentation data. Stable identity remains `agentId`.

### Artifacts

```ts
interface TerminalReportArtifact {
  readonly id: string;
  readonly kind: TerminalReportArtifactKind;
  readonly title: string;
  readonly path?: string;
  readonly href?: string;
  readonly summary?: string;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

The report may mention important artifacts, but the conversation projector owns the
artifact strip below the final result. The renderer must not render the same artifact as
both a nested report card and a second artifact card.

### Risks

```ts
interface TerminalReportRisk {
  readonly id: string;
  readonly severity: "info" | "warning" | "critical";
  readonly status: "unresolved" | "mitigated" | "accepted" | "unverified";
  readonly summary: string;
  readonly nextAction?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}
```

`risks` is not a generic disclaimer section. It contains only concrete residual risk,
missing verification, blockers, or failed conditions present in the snapshot.

### Synthesis Metadata

```ts
interface TerminalReportSynthesisMetadata {
  readonly mode: "model" | "runner_reuse" | "deterministic_fallback";
  readonly model?: string;
  readonly providerPresetId?: string;
  readonly promptVersion: string;
  readonly attemptCount: number;
  readonly validationCodes: readonly string[];
}
```

Model/provider metadata belongs to durable evidence and developer detail. It is not
displayed in the ordinary final report.

## Generation Lifecycle

```text
workflow/run becomes terminal
  -> verify that the source is eligible for terminal reporting
workflow/run emits a terminal candidate
  -> verify that the source is eligible for terminal reporting
  -> determine owning Ling session and turn
  -> reconcile delegated outcomes and recompute completion gate from canonical state
  -> require an atomically committed compatible workflow terminal state
  -> enter reporting state
  -> wait for terminal approval reconciliation and artifact import
  -> collect bounded evidence snapshot
  -> compute evidence fingerprint
  -> select synthesis mode
  -> generate TerminalReport draft
  -> validate schema, facts, refs, privacy, and terminal state
  -> persist committed report
  -> publish one coordinator message / final_result block
  -> collapse completed process detail
  -> enter succeeded / blocked / failed / cancelled session state
```

### Reporting Barrier

Terminal run state alone is not enough to publish.

The reporting barrier waits until:

- workflow and step state reconciliation is complete through the same kernel used by
  online callbacks and startup recovery;
- the workflow completion gate has evaluated the immutable required-participant manifest,
  typed delegated outcomes, graph coverage, dependencies, and `fanInPolicy`;
- every required participant has a satisfied or explicit non-success result; an absent
  required participant is not treated as an empty successful branch;
- approval-backed tool work has been folded into one `ExecutionAction` lifecycle by
  `(runId, toolCallId)`; an `approved` approval without matching terminal tool evidence
  remains non-successful;
- every required operation declared by each workflow step has a persisted successful
  verification result with matching `ExecutionAction` ids;
- every required synthesis/review participant with no operation plan has a validated
  workflow output-packet artifact bound to the same workflow, step, participant, and
  resolvable source/output refs; naked runner prose is not reportable completion;
- pending post-step approval resolution is reflected in step/workflow state;
- output packet and expected artifact import attempts have completed;
- in-flight execution actions for the terminal run have settled or timed out;
- the terminal source has a stable `terminalAt` timestamp;
- no required fan-in step remains non-terminal.

The barrier has a bounded timeout. Timeout does not fabricate operation completion. A
missing optional check may add an `unverified` risk and permit fallback publication, but
missing required operation evidence blocks the step/workflow and must produce a
compatible blocked or failed report instead of a succeeded report.

TerminalReport is a consumer of completion truth, not a second evaluator that can repair
it. Before publishing a successful report, the coordinator re-runs canonical completion
evaluation and compares its `basisFingerprint` to the atomically committed workflow gate.
A mismatch, stale snapshot, missing participant, or changed evidence aborts successful
publication and schedules reconciliation. Negative/blocked reports may describe the
canonical blocker, but report synthesis never mutates step outcomes or actions.

Pre-publication calls the same daemon semantic reconciler used by online callbacks,
post-step approval, and startup. The reconciler does not import or call TerminalReport
synthesis; it returns the refreshed workflow/gate and whether publication reconciliation
is needed. This one-way dependency prevents recursive reporting and keeps a report retry
from re-running delegated work.

### Eligibility And Recovery

Terminal-report eligibility is one daemon-owned rule reused by real-time scheduling,
direct processing, startup recovery, report APIs, and conversation projection.

- workflow sources remain eligible;
- explicit executed-task runs and turns remain eligible when their evidence satisfies
  this protocol;
- runs owned by a `channel_ai_reply` WorkUnit are ineligible, including legacy runs whose
  WorkUnit link must be recovered through the reverse `linkedRunId` relation;
- startup recovery must not reinterpret an ordinary completed reply as a task merely
  because it contains tool, action, or artifact evidence;
- a previously committed or published ineligible report remains in durable storage for
  audit and compatibility, but report collection/detail APIs and the channel timeline do
  not expose it;
- eligibility never depends on matching visible markdown, titles, or phrases such as
  `Done` or `任务已完成`.

This filtering is intentionally non-destructive. It repairs the user-facing projection
without rewriting or deleting historical user data.

### Synthesis Mode Selection

Use `model` synthesis when any condition is true:

- the source is a multi-step workflow;
- more than one agent participated;
- changes, verification, artifacts, and risks require cross-source synthesis;
- the result needs a correction to the user's premise;
- step summaries conflict or describe only local work;
- the runner final message does not satisfy the report contract.

Use `runner_reuse` only for a single direct run when:

- the runner final message is present and complete;
- deterministic evidence confirms every factual claim needed for the report;
- there are no conflicting steps or participants;
- report normalization can map the message into the structured contract without prose
  parsing heuristics.

If those conditions cannot be proven, use model synthesis.

Use `deterministic_fallback` when:

- the model/provider is unavailable;
- synthesis times out;
- structured output is invalid after the retry budget;
- validation detects unsupported claims;
- policy blocks sending the evidence to the configured model.

## Model Synthesis Contract

The model receives:

- the objective and response language;
- the bounded `TerminalReportEvidenceSnapshot`;
- explicit instructions that source state is authoritative;
- the target JSON schema;
- section selection and writing rules;
- no raw secrets, hidden prompts, or unbounded logs.

The model does not receive permission to call tools or continue the workflow. Terminal
report synthesis is a read-only reporting operation.

Preferred path:

```text
provider supports structured final output
  -> request TerminalReport JSON schema directly
```

Transitional path:

```text
provider lacks structured final output
  -> request strict JSON
  -> parse and validate
  -> retry once with validation errors
  -> deterministic fallback
```

Do not accept markdown as the canonical report object. Markdown is a render product.

### Writing Rules

- Lead with the actual outcome.
- Include a correction only when evidence requires it.
- Group related changes by behavior or ownership boundary, not by raw chronological log.
- Report exact verification status; never turn missing checks into implied success.
- Mention agent participation only when it adds useful accountability.
- Mention important artifacts and references without duplicating the artifact strip.
- State unresolved risks plainly.
- Omit empty sections.
- Keep simple work concise.
- Use headings only when they improve scanning.
- Do not include raw internal ids in the default prose.
- Do not expose chain-of-thought, hidden prompts, private notes, tokens, or credentials.

## Validation

Validation is mandatory before publication.

### Structural Validation

- `schemaVersion === 1`.
- All required top-level fields are present.
- Enum values are recognized.
- Item ids are unique within each collection.
- Every item source ref resolves to the evidence snapshot or an allowed external ref.
- `evidenceFingerprint` matches the snapshot.

### State Validation

- Report outcome must be compatible with terminal workflow/run state.
- A failed or blocked source cannot be reported as succeeded.
- A non-verified workflow completion gate cannot be reported as succeeded. Report
  synthesis may describe its blockers, but it cannot repair participant coverage or
  create execution evidence.
- A persisted verified gate snapshot is insufficient by itself. Publication requires the
  snapshot's basis fingerprint to match a gate recomputed from the source decision,
  immutable graph, current workflow/step rows, actions, output packets, approvals, and
  termination policy. The atomic publication transaction revalidates the same typed
  expected read-set before it writes the Item, publication marker, Turn event, or
  invalidation.
- Assistant-message `ready` state and statements such as “I will execute” are never
  delegated outcomes and cannot satisfy participant or operation requirements.
- A workflow or step with a missing, failed, cancelled, timed-out, non-zero, or
  out-of-order required operation cannot be reported as succeeded even when its linked
  Run says `succeeded`.
- Command state comes from normalized execution evidence, not raw runner prose. A
  structured unified-exec result requires an explicit numeric exit code for success. A
  terminal legacy Pi bash `tool_end(isError=false)` may normalize to exit 0 only when no
  unified-exec envelope exists; a legacy failure with no numeric code remains a generic
  command failure rather than a fabricated non-zero exit.
- `partially_succeeded` requires both completed output and a failed, blocked, cancelled,
  skipped, or unverified remainder.
- Pending approval cannot be described as approved or denied.

### Claim Validation

- `passed` and `failed` verification statuses require matching check evidence.
- Changed paths require file/diff/artifact/action evidence.
- Line counts require diff evidence.
- Commit, PR, merge, deployment, and service-health claims require matching refs.
- Participant claims require actual workflow step, run, or promoted contribution refs.
- Approval claims require matching approval/checkpoint state.
- A correction requires at least one non-model source ref and cannot use low confidence.

The validator should reject unsupported structured claims rather than trying to repair
them from prose.

### Source turn publication barrier

For an intent/proposal-owned workflow, `workflow.metadata.sourceTurnId` identifies the
original user `LingTurn`. A committed report is published before that source turn becomes
terminal. Publication and closure are idempotent:

```text
verified terminal workflow
  -> committed TerminalReport
  -> atomic publication barrier
       one deterministic final_result Item
       + publishedMessageId
       + CAS source LingTurn to succeeded | blocked | failed | cancelled
       + turn state-transition evidence
       + one durable terminal_report.published invalidation
  -> post-commit best-effort live SSE/RPC notification
```

`partially_succeeded` maps to a blocked source turn because user-visible work remains.
Report synthesis or publication failure keeps the source turn recoverable and
non-terminal. Startup recovery closes an open/running source turn only when it can find
the already committed and published report; it never republishes the same result. When
TerminalReport is disabled, the legacy coordinator final reply is the equivalent
publication barrier and applies the same terminal mapping.

Publication owns one SQLite transaction for the deterministic assistant Item, report
publication marker, compatible source-turn settlement and transition event, and the
content-free `work_units / terminal_report.published` control-plane event. It revalidates
the fresh Completion Gate basis inside that boundary. An incompatible already-terminal
source Turn aborts the whole transaction. Re-entry returns the existing published
lineage, so there is never an Item without its marker, a marker without Turn closure, or
a closed Turn without durable invalidation. The in-memory hub is notified after commit;
a crash before that notification is recovered from the durable event row.

The marker has one source-level uniqueness key:
`(workspaceId, sourceKind, sourceId, sourceTurnId, publicationKind=final_result)`.
Completion Gate basis and report revision are validation/version fields, not publication
identity. Before commit they may replace a draft through compare-and-set. After commit,
re-entry returns the same `terminalReportId` and `finalResultItemId`; a later revision may
update that Item only under an explicitly versioned correction protocol and can never
append a second terminal Item. Web reconciliation keys by the durable Item id and applies
its revision in place.

Transaction participation is explicit. The publication store binds a narrow
`appendControlPlaneEventWithinTransaction()` port; that writer appends the event and
replay watermark but never begins, commits, or rolls back. The public standalone event
append always owns its own transaction and is forbidden inside this barrier. Neither
path may inspect `DatabaseSync.isTransaction` to decide whether it owns the transaction.

The publication method that issued `BEGIN IMMEDIATE` is the only owner. On any exception
it attempts `ROLLBACK` unconditionally, ignores only a rollback failure, and rethrows the
original error. This rule also applies to the reporting-disabled legacy workflow
publication barrier. Fault-injection acceptance must prove both all-or-nothing lineage
and that a new transaction can start on the same connection after the failed call. A
nested `BEGIN`, a skipped rollback, or an in-memory event emitted before commit is a P1
protocol violation.

Core derives the target Turn status from the fresh Completion Evaluation; the daemon does
not pass it as an independent input. Report and evaluation must agree: verified maps only
to succeeded, blocked maps only to blocked/partially-succeeded, failed to failed, and
cancelled to cancelled. Core also validates the complete deterministic committed Item
envelope and its report/workflow/source Item/source Turn refs before insert or duplicate
reuse. A mismatched report outcome, arbitrary message payload, or partial pre-existing
lineage is a typed conflict and writes nothing.

`LingTurn.blocked` is settled but resumable. If a blocked or partially succeeded report
finds the source Turn already blocked, publication commits one deterministic blocked
settlement audit event in the same transaction instead of treating the lack of a state
change as permission to omit audit lineage. `settle_blocked` is publication audit
vocabulary, not a normal Turn state-machine transition, so it does not rewrite the
already-blocked Turn or make it immutable. A later explicit resume may still move it back
to running.

The successful gate read-set validates canonical Run/event/approval/artifact backing rows.
`ExecutionAction` remains their deterministic read model rather than becoming a duplicate
table. Workflow output packets are the stricter case: their artifact row carries canonical
sealed JSON plus a SHA-256 digest. The SQLite transaction recomputes that digest from the
sealed payload before the packet can satisfy a delegated outcome, the Completion Gate, or
publication. The filesystem file is an inspectable projection, not a second authority.

The client re-reads canonical Channel Items and TerminalReports when it consumes that
event. A transient reconnect resumes from the last **applied durable** sequence, not the
last received byte or last opened connection. The cursor advances only after the event's
canonical refresh has applied successfully. Events committed while disconnected then
replay after that cursor. If the cursor is unavailable or outside retention, the client
reads snapshot sequence `S`, subscribes after `S`, and performs one authoritative
selected-Channel refresh covering state at or before `S`; it may not persist or
acknowledge `S` without that refresh. SSE and local RPC register live delivery before
reading replay, then merge by sequence, de-duplicate, and order the handoff batch. An
event whose sequence is already applied is a no-op. Coalesced domains
refresh runtime and the selected Channel
projection once, without also refreshing the unrelated normal-Conversation surface.
Request cancellation/generation fencing prevents an older empty report query from
overwriting a newer committed result. No unbounded polling is part of this protocol.
Equivalent Item snapshots are reconciled by durable Item identity and revision. A
post-publication refresh must not remount an unchanged Item and thereby discard pending
hover, focus, disclosure, selection, or preview state. Interaction state that must cross
an Item revision is stored against stable Item/reference identity outside the replaceable
render instance.
Replay range completeness is evaluated against a captured upper bound and durable
retention floor stored in per-workspace `control_plane_replay_state`. The floor survives
an empty event table; every event append advances the latest watermark, and any future
compaction must advance the floor in the same transaction as deletion. Sequence numbers
belonging to another workspace or a filtered domain do not create a gap. A snapshot
handoff reads sequence `S`, establishes a provisional live subscription after `S` while
buffering, refreshes canonical state through `S`, and only then advances the applied
cursor and drains later events.
If replay lookup, merge, or initial flush throws after live-first registration, setup
rolls back the provisional client and closes its response/listener before propagating the
error. The applied cursor remains at the last successful value. Failed subscription setup
does not leave an orphan that can consume later report invalidations. Reconnect never
resubmits the accepted user request, restarts a Run, or invokes completion logic; it only
reprojects durable state.

### Privacy Validation

- Strip secret-adjacent labels and excerpts from visible fields.
- Do not publish private teammate text unless promotion policy permits it.
- Do not include raw command environment, tokens, credentials, or hidden system prompts.
- External URLs must pass existing URL and evidence policy.

## Deterministic Fallback

Fallback remains useful but must be structurally complete.

```text
outcome
  <- terminal source state + objective/title + blocker

changes
  <- changed paths + file/diff artifacts + successful edit actions

verification
  <- normalized checks and test actions

participants
  <- actual terminal workflow steps/runs only

artifacts
  <- validated artifacts and external-work refs

risks
  <- blockers + failed/not-run/unknown checks + unresolved diagnostics

references
  <- all source refs retained for evidence expansion
```

Fallback prose should be short, but it must not collapse the report back into only the
last step summary.

## Persistence And Idempotency

The canonical target is a first-class durable report record rather than prose-only
message detection.

```ts
interface LingTerminalReportRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceKind: "workflow" | "run" | "turn";
  readonly sourceId: string;
  readonly generation: number;
  readonly status: TerminalReport["status"];
  readonly evidenceSnapshotId: string;
  readonly evidenceFingerprint: string;
  readonly report: TerminalReport;
  readonly publishedMessageId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Recommended storage target:

```text
ling_terminal_reports
  unique(source_kind, source_id, generation)
  index(channel_id, thread_id, created_at)
  index(evidence_fingerprint)
```

Rules:

- Repeated terminal reconciliation with the same fingerprint returns the committed
  report and does not publish another message.
- A synthesis retry updates the same uncommitted generation.
- A user continuation creates a new work generation and a new report. Historical reports
  remain committed and are not merged into the new process row.
- Evidence that arrives before publication can update the draft snapshot and fingerprint.
- Evidence that arrives after publication remains evidence for the historical run. It
  does not silently rewrite the committed user-visible report. A material correction
  requires an explicit correction report or continuation event.
- Stop identifying terminal coordinator replies through body regexes once durable report
  records are available.

A migration-free first slice may persist the snapshot/report as JSON artifacts and keep
the report id in workflow metadata, but that is a compatibility step, not the canonical
long-term owner.

## Relationship To Existing Types

### `ChannelWorkflowStep.resultSummary`

Keep it. It remains step-local terminal text used for dependency context, fan-in,
diagnostics, and fallback evidence. It must not become the canonical session report.

### `ChannelWorkflowStepOutputPacket`

Keep it and use it as a primary evidence source. Its `resultSummary`, `artifactIds`,
`blockers`, `changedPaths`, selector refs, handoff refs, and runner audit already provide
most step-level report input.

### `buildWorkflowEvidence()`

Use it as the starting workflow evidence collector. Extend or adapt it to produce the
bounded terminal snapshot instead of making a second independent store traversal in Web.

### `LingAgentFinalResultView`

Treat the current type as a compatibility projection.

```text
TerminalReport
  -> LingAgentFinalResultView compatibility adapter
  -> existing workflow progress / work cell callers
```

The target is to make `TerminalReport` the shared semantic contract and gradually remove
the reduced `summary + changedPaths + checks + approvals` ownership from daemon-local
session view code.

### `workflowTerminalCoordinatorReplyBody()`

Replace its two-line deterministic wrapper with terminal report publication. The old
wrapper remains only as a fallback compatibility renderer during migration.

### `TranscriptBlock.kind = "final_result"`

Keep it. Extend its typed payload so the block references a committed `TerminalReport`
instead of only display lines.

## Conversation Projection

```text
committed TerminalReport
  -> final_result block
  -> optional participant summary
  -> optional artifact strip
  -> optional memory/source citation footer
  -> folded process evidence
```

### Default Collapsed Result

The default terminal turn shows:

- natural outcome text;
- selected change and verification details when useful;
- a compact participant line only when specialists participated, with 18px teammate profile avatars resolved from `agentId` and role/template fallback;
- important references when the report cites them;
- the artifact strip below the summary;
- the completed process cell folded, but not removed.

### Expanded Result

Expanding the report reveals only report-owned semantic detail:

- complete selected changes;
- complete verification list;
- participant contributions with the same teammate identity and avatar mapping as the collapsed line;
- residual risks;
- evidence links.

It does not duplicate operation rows, full command output, file diffs, or artifact
previews. Those remain independently expandable in their owning blocks.

### Surface Policy

| Surface | TerminalReport behavior |
| --- | --- |
| Normal conversation | Show for executed work; omit for plain conversational answers |
| Channel root/branch | Show one Ling-owned final result for workflows or explicit executed tasks; omit ordinary `channel_ai_reply` answers even when they start conversation-owned media work |
| Teammate private chat | Show executed-work result privately; do not expose channel teammates or private evidence from other scopes |
| Run/thread detail | Show report plus richer evidence links; keep raw runtime detail separate |

### Empty Section Rules

- No actual teammate participation -> no participant line or empty participant heading.
- No artifacts -> no artifact strip.
- No verification evidence -> show a risk only when verification was expected; otherwise
  omit verification.
- No unresolved risk -> no risk section.
- No correction -> do not render corrective framing.

## Multi-Agent Behavior

The process feed preserves actual rounds:

```text
Architect completed
Engineer completed
QA completed
Engineer round 2 completed
```

The final report aggregates by participant:

```text
Architect: defined the state boundary.
Engineer: implemented the fix and follow-up adjustment.
QA: verified approval and recovery paths.
```

Do not collapse historical process rows into one row. Aggregation applies only to the
final participant summary.

Conflicting participant conclusions must not be silently flattened. The report records
the selected conclusion in outcome/changes and keeps unresolved dissent as a risk or
decision with source refs.

## Approval Behavior

- Pending approval prevents terminal success publication.
- Approved or denied approval state is included only after durable reconciliation.
- Approved approval records remain audit evidence but do not need their own visible
  report section unless approval materially affects the result.
- Denied approval that prevents work becomes a blocker/risk and changes the outcome.
- A post-step approval that succeeds must be reflected in workflow/step state before the
  reporting barrier opens.
- `resume_pending` is non-terminal and cannot open the reporting barrier.
- `approval_resume_effect_unknown` is a structured blocker: report the affected
  participant/operation and safe next action from canonical evidence, but do not claim
  the side effect ran or did not run and do not offer an automatic retry.

## Failure, Cancellation, And Partial Completion

### Failed

Report what was attempted, what completed before failure, the failing check or blocker,
any valid artifacts, and the smallest evidence-backed next action.

### Blocked

Report the external condition or user decision required. Do not phrase blocked work as
completed merely because earlier steps succeeded.

### Cancelled

Report what was completed before cancellation and whether partial artifacts exist. Do
not imply that cancelled checks passed.

### Partially Succeeded

Use only when the requested outcome has a meaningful completed subset and a meaningful
uncompleted subset. The report must identify both.

## Localization

- Store semantic status enums independently from visible copy.
- Synthesize in the response language captured by the owning turn/workflow.
- Preserve code identifiers, commands, paths, commit ids, and URLs as literals.
- Do not translate teammate display names unless the profile provides a localized name.
- Deterministic fallback uses the same semantic data and locale-specific copy functions.
- Validation is locale-independent and never depends on matching words in prose.

## Performance And Cost

- Run at most one normal synthesis call per terminal work generation.
- Retry invalid structured output at most once by default.
- Send bounded summaries and refs, not full logs or full file contents.
- Reuse existing context/output packets and normalized execution actions.
- Cache committed reports by source generation and evidence fingerprint.
- Do not block workflow state reconciliation on report model availability; enter
  `reporting`, then fall back deterministically within the reporting timeout.
- Surface the final report only after validation, avoiding visible draft replacement.

## Observability

Record:

- report id and source generation;
- evidence snapshot id and fingerprint;
- reporting barrier wait duration;
- synthesis mode and attempt count;
- provider/model identity in developer-only metadata;
- validation failures by stable code;
- fallback reason;
- publication message/block id;
- synthesis and total reporting latency.

Suggested validation codes:

```text
terminal_report_schema_invalid
terminal_report_source_ref_missing
terminal_report_outcome_mismatch
terminal_report_unverified_success_claim
terminal_report_changed_path_without_evidence
terminal_report_participant_without_activity
terminal_report_external_ref_unverified
terminal_report_privacy_violation
terminal_report_synthesis_timeout
terminal_report_fallback_used
```

## API And Contract Direction

The shared contract should ultimately live outside Web:

```text
packages/contracts or packages/core
  TerminalReport types
  snapshot types
  validation helpers
  compatibility adapters

packages/daemon
  evidence collection
  reporting barrier
  synthesis orchestration
  persistence and publication
  report endpoints

apps/web
  final_result renderer
  participant summary renderer
  artifact/evidence placement
```

Potential read endpoints:

```text
GET /terminal-reports/:reportId
GET /channels/:channelId/terminal-reports?threadId=...
```

The ordinary channel message list still carries the published coordinator message. The
transcript snapshot references the report id for structured rendering.

## Test Plan

### Core Contract Tests

- Valid report parses and preserves every source ref.
- Unknown schema version fails closed.
- Duplicate item ids fail validation.
- Outcome incompatible with source state fails validation.
- Passed verification without check evidence fails validation.
- Changed path without file/diff/action evidence fails validation.
- Participant contribution without actual activity fails validation; a manifest-required
  coverage row may be `missing` without becoming a contribution.
- PR/commit/deployment claim without validated external ref fails validation.
- Secret-adjacent evidence is excluded from visible fields.
- Empty optional sections remain absent rather than rendering placeholders.

### Daemon Tests

- Single direct run produces a concise report with real changed paths and checks.
- Multi-step workflow aggregates all relevant steps instead of selecting only the last
  result summary.
- Multi-agent contribution summary includes only agents that actually started work, while
  required-participant coverage contains every immutable manifest member.
- A second round by one agent remains separate in process history but aggregates in the
  final participant contribution.
- Approval reconciliation completes before report publication.
- Failed, blocked, cancelled, and partially succeeded sources produce compatible reports.
- Invalid model output retries once and then uses deterministic fallback.
- Reporting is idempotent for the same evidence fingerprint.
- Startup recovery does not duplicate a committed terminal report.
- Late pre-publication artifact evidence updates the draft fingerprint.
- Late post-publication evidence does not silently rewrite the report.
- Long runner summaries remain evidence without forcing the final report to repeat them
  verbatim.
- Legacy Pi bash final text is retained once as bounded command evidence, survives
  restart reconstruction, and supports stdout-backed verification without duplicating
  cumulative tool updates.
- An incomplete structured unified-exec result cannot borrow the legacy Pi success
  inference or produce a succeeded TerminalReport.
- Online terminal callback, post-step approval, startup recovery, duplicate callback, and
  pre-publication reconciliation derive the same delegated outcome and completion basis
  from the same canonical rows.
- A stale cached verified gate with removed/changed evidence cannot publish success.
- One completed required participant plus one active, absent, or blocked participant
  cannot publish a succeeded report.
- A required participant with no step/Run appears as `missing` coverage and a visible
  blocker; an optional unstarted participant remains absent from the contribution UI.
- An evidence mutation between gate evaluation and atomic commit fails compare-and-set and
  causes recomputation rather than stale success.

### Web Tests

- Final result renders below the folded process history and above the artifact strip.
- Artifact count/path data is not duplicated inside nested cards.
- Participant contribution summary appears only for actual multi-agent participation;
  required missing/blocked rows still appear in outcome risks/blockers.
- Workflow cards never render a second terminal summary/count after `final_result` is
  committed, including after replay, reconnect, or duplicate callback.
- Empty verification, risk, participant, and artifact sections do not render.
- Expanding final result does not expand or collapse individual operation rows.
- Operation, diff, command, and artifact disclosures preserve their own state.
- Normal conversation and private chat show reports for executed work without channel
  multi-agent chrome.
- Raw ids and provider metadata remain absent from the default conversation surface.
- A delayed reference preview still opens when an equivalent canonical Item refresh lands
  between pointer entry and the preview deadline.
- A reconnect persists only the last applied durable sequence; a refresh failure replays
  the event again rather than skipping the report.
- Reconnect and snapshot fallback never resubmit the accepted Turn or restart delegated
  work.

### Real Scenario Fixtures

At minimum, keep fixtures for:

1. A small single-file edit with one typecheck.
2. A multi-agent UI change with Architect, Engineer, Designer, and QA participation.
3. A workflow where QA fails and Engineer performs a second round.
4. A post-step approval that transitions from waiting to succeeded.
5. A cancelled run with a valid partial artifact.
6. A model synthesis failure that uses fallback.
7. A completed task with no artifacts and no specialist participation.
8. A task with a PR/commit and verified service status.

## Implementation Slices

### P0: Contract And Fixtures

- Add shared snapshot/report types and validators.
- Add representative fixtures matching current conversation UI behavior.
- Add compatibility conversion from `LingAgentFinalResultView`.
- No publication behavior changes yet.

### P1: Deterministic Evidence Collector

- Build snapshots from `buildWorkflowEvidence()`, output packets, actions, approvals,
  artifacts, and direct-run evidence.
- Add evidence fingerprinting and reporting-barrier tests.
- Keep the existing two-line coordinator reply active.

### P2: Synthesis And Validation

- Add the read-only Ling terminal report synthesizer.
- Add structured output handling, one retry, and deterministic fallback.
- Persist draft/committed reports.

### P3: Publication And Session State

- Publish one report-backed Ling coordinator message.
- Derive `reporting` until a report commits.
- Replace body-regex idempotency with durable report ownership.
- Keep old terminal reply rendering only for compatibility fallback.

### P4: Shared Conversation Projection

- Project committed reports into typed `final_result` blocks.
- Render participant summary and artifact strip in their agreed positions.
- Remove duplicate final summary/count presentation from workflow cards.
- After a report commits, workflow/activity cards remain folded progress/evidence only.
  They may link to the report but cannot publish another terminal summary, success count,
  or assistant final message. The publication marker plus `final_result` Item is the
  single user-visible terminal projection.

### P5: Cleanup And Hardening

- Migrate existing terminal `LingAgentFinalResultView` callers.
- Remove prose heuristics and duplicate Web aggregation.
- Add startup recovery, privacy, performance, and external-evidence conformance tests.

## Migration Rules

- Existing workflow/run/approval/artifact records remain valid.
- Existing `resultSummary` data remains readable as audit/context input, but never
  satisfies delegated completion or operation evidence.
- Existing terminal coordinator messages remain transcript history.
- New reports are generated only for new terminal work by default; optional backfill must
  be an explicit migration or maintenance operation.
- During mixed-version operation, prefer a committed `TerminalReport`; otherwise use the
  existing final result view and deterministic terminal reply.
- Do not infer old report structure by parsing old assistant markdown.

## Resolved Decisions

- The final report belongs to Ling Agent Session, not the last runner or specialist.
- Daemon/core owns report state and evidence; Web is not the report authority.
- The canonical report is structured data, not markdown.
- Model synthesis is evidence-bounded and read-only.
- Every factual section carries source refs.
- Empty sections are omitted.
- Actual multi-agent participation is visible; unstarted teammates are omitted.
- Process history remains independently expandable after final reporting.
- Artifacts render below the summary and are not duplicated as nested report cards.
- Deterministic fallback is required.
- Durable idempotency replaces terminal-message body matching.

## Remaining Implementation Parameters

No unresolved product or authority boundary remains.

- `ling_terminal_reports` is the canonical durable report owner. The existing table and
  store remain in use; a compatibility artifact is not an alternative authority.
- Protocol types stay in the current Core conversation/report contract modules for this
  slice. A future shared-package extraction may move files without changing ownership.
- Provider-native structured final output is an adapter capability. Unsupported adapters
  use strict JSON validation, one bounded retry, then deterministic fallback.
- Exact reporting-barrier timeout and retry budgets are versioned runtime policy values
  measured during packaged macOS acceptance, not architecture decisions.
