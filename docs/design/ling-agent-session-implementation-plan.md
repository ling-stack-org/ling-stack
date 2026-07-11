# Ling Agent Session Implementation Plan

Status: implementation plan for the first product-control-plane slices
Date: 2026-06-12

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md)
- [Ling Agent TerminalReport Implementation Plan](ling-agent-terminal-report-implementation-plan.md)

## Summary

This plan implements the Ling Agent session model without replacing the existing
workflow, run, approval, thread, or evidence primitives.

Implementation status:

- P1 initial projection helper is implemented in
  `packages/daemon/src/features/channels/ling-agent-session-view.ts`.
- P1 focused daemon tests cover open channel, draft task confirmation, active workflow
  approval wait, terminal workflow final result, and terminal failed run states.
- P2 initial coordinator ordering is implemented in
  `packages/daemon/src/features/channels/messages.ts`.
- P2 active-session handling queues additive follow-up instructions as durable
  `queue_followup` interventions before ordinary routing. Interrupt/redirect language
  returns a `requires_confirmation` active-session action and does not cancel the source
  run until a dedicated UI/endpoint confirms it.
- P3 initial terminal final report projection is implemented without a migration:
  daemon session views derive `finalResult` from workflow steps, linked runs, artifacts,
  and resolved approvals; Web completed workflow cards hide raw proposal/process rows by
  default and keep evidence expandable.
- The next terminal-report slice must follow the canonical `TerminalReport` protocol:
  current `LingAgentFinalResultView` remains a compatibility projection, runner summaries
  remain step evidence, and daemon/core owns validated report publication.
- P4 initial permission UX integration is implemented on the existing proposal and
  approval surfaces: pre-execution cards use permission-oriented task confirmation copy,
  while runtime approvals still resolve through durable `ApprovalRequest` records and do
  not mutate workspace approval policy.
- P5 initial execution is implemented with the built-in `ling_agent` identity for bounded
  single-step tasks when no configured specialist can run. The next profile slice should
  promote this identity into a protected system teammate that appears in roster, channel
  membership, mentions, and private chat.
- P6 initial Web acceptance hardening is implemented in `apps/web/e2e/channel.spec.ts`
  with regression coverage for executable task confirmation, filename-only continuation,
  ordinary chat routing, active run guidance/redirect interventions, inline runtime
  approvals, and terminal final reports.

The first implementation should add a product control-plane read model and route order:

```text
Ling Agent Session View
  -> TurnEnvelope builder
  -> active-session continuation / approval handling
  -> attachment/link/file-ref materialization
  -> executable intent detection
  -> auto-start or workflow/task confirmation
  -> ordinary chat routing
  -> terminal final report
```

The next conversation UI implementation should add a second read model:

```text
ConversationTranscript
  -> ConversationTurn[]
  -> TranscriptBlock[]
  -> active OperationCell / AgentActivitySpan mutation
  -> committed folded process history
```

`LingAgentSessionView` remains the coarse state summary. `ConversationTranscript` owns the
ordered user-facing cell stream. Do not merge them into one report-shaped object.

The goal is to make Ling feel like one coherent agent session while preserving the lower
layers that already enforce state, permissions, runner behavior, and audit.

## Implementation Principles

- Prefer derived views before new tables.
- Keep executable work on the existing workflow/run path.
- Keep permissions on the existing approval path.
- Treat proposal records as auditable task plans, not mandatory user-facing stop signs.
- Treat attachments, link previews, composer file refs, and active-run guidance payloads
  as first-class turn input, not UI decorations or optional message metadata.
- Keep process details expandable, not default transcript content.
- Keep completed process rows folded in the transcript; terminal summary must not delete
  or replace the process history.
- Make Ling Agent a protected built-in system teammate and default executor identity, not
  a permission authority.
- Make user interjections durable interventions, not hidden prompt injection.
- Ship in narrow slices with daemon tests first, then Web behavior tests.

## Current Code Anchors

| Area | Current anchor |
| --- | --- |
| Channel message entry | `packages/daemon/src/features/channels/messages.ts` |
| Turn envelope and context packs | `packages/daemon/src/features/channels/context-packs.ts` |
| Executable/collaboration detection | `packages/daemon/src/features/channels/channel-intent-selector.ts` |
| Ordinary chat routing | `packages/daemon/src/features/channels/channel-message-router.ts` |
| Proposal to workflow confirmation | `packages/daemon/src/features/channels/proposal-workflows.ts` |
| Workflow orchestration | `packages/daemon/src/features/channels/orchestrator.ts` |
| Workflow progress Web model | `apps/web/src/lib/workflow-progress.ts` |
| Conversation work cell Web model | `apps/web/src/lib/conversation-work-cell.ts` |
| Conversation work cell UI | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` |
| Channel workspace UI | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` |
| Inline approvals | `apps/web/src/lib/inline-approvals.ts`, `apps/web/src/features/approvals/InlineApprovalStrip.tsx` |
| Run interventions | `packages/daemon/src/features/runs/interventions.ts` |
| Execution actions | `packages/daemon/src/features/runs/execution-actions.ts` |
| Thread/evidence APIs | `packages/daemon/src/features/runs/thread-routes.ts` |
| Current Web turn projection prototype | `apps/web/src/lib/conversation-turn-projector.ts` |
| Current Web operation projection prototype | `apps/web/src/lib/conversation-work-cell.ts` |
| Future shared transcript contracts | `packages/contracts/src/conversation-transcript.ts` |

## P1: Session View Projection

### Goal

Add a `LingAgentSessionView` read model that derives one coherent session state from
existing channel messages, proposals, workflows, runs, approvals, interventions, and
thread evidence.

Do not add `ling_agent_sessions` storage in P1.

### Contract

Start with a pure builder that can run in daemon or Web tests:

```ts
type LingAgentSessionViewStatus =
  | "open"
  | "shaping"
  | "ready_for_confirmation"
  | "running"
  | "waiting_for_approval"
  | "reporting"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

interface LingAgentSessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly status: LingAgentSessionViewStatus;
  readonly owner: "ling_agent";
  readonly objective: string;
  readonly activeWorkflowId?: string;
  readonly activeRunId?: string;
  readonly pendingApprovalIds: readonly string[];
  readonly pendingInterventionIds: readonly string[];
  readonly confirmation?: LingAgentConfirmationView;
  readonly progress?: LingAgentProgressView;
  readonly finalResult?: LingAgentFinalResultView;
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}
```

Implemented source location for the first coarse session view:

```text
packages/daemon/src/features/channels/ling-agent-session-view.ts
```

Shared contract target:

```text
packages/contracts/src/conversation-transcript.ts
packages/core/src/conversation-transcript-projector.ts
packages/daemon/src/features/channels/conversation-transcript.ts
```

Use `packages/contracts` for wire types, a pure projector in `packages/core` when it can
avoid daemon-only dependencies, and daemon feature glue for store queries and endpoints.
Web and Desktop should consume the daemon transcript snapshot/delta API instead of
duplicating projection logic.

### Derivation Rules

- Draft executable proposal -> `ready_for_confirmation`.
- Non-terminal workflow or run -> `running` or `waiting_for_approval`.
- Pending inline-eligible approval for active run/channel -> `waiting_for_approval`.
- Terminal workflow/run without a final report -> `reporting`.
- Terminal workflow/run with final result -> `succeeded`, `blocked`, `failed`, or
  `cancelled`.
- No active work and no draft proposal -> `open`.

### Daemon Work

- Add a pure projection helper.
- Add focused tests for proposal, active run, waiting approval, terminal succeeded,
  terminal failed, and no-work states.
- If an endpoint is needed, add a read-only endpoint such as:

```text
GET /channels/:channelId/ling-agent-session?cwd=...
```

Do not make this endpoint an authority for approval, run, or workflow state.

### Web Work

- Use the view to decide which conversation work cell, confirmation card, approval strip,
  and final report should be visible.
- Keep legacy proposal/workflow/runs loaded until the view is stable.
- Do not remove existing evidence links.
- Treat current Web projection helpers as prototype code. Once the transcript contract is
  stable, migrate grouping, terminal-state ownership, command folding, and agent span
  lifecycle into shared projector code.

### Shared Transcript Work

- Define `ConversationTranscript`, `ConversationTranscriptTurn`, `TranscriptBlock`,
  `OperationCellBlock`, `AgentActivitySpanBlock`, `RawDetailRef`, and transcript delta
  events in `packages/contracts`.
- Add a pure projector that groups by root user turn, stable operation id, and actor.
- Preserve running-to-terminal mutation on the same block id.
- Keep command stdout/stderr bounded in inline detail and full output behind raw/detail
  refs.
- Add a daemon snapshot endpoint and optional SSE stream for transcript updates.
- Keep CLI as a consumer. CLI may render transcript blocks as text or TUI cells, but it
  must not own the projection.

Acceptance:

- Web and Desktop can render the same transcript JSON with different visual chrome.
- The transcript snapshot contains no raw workflow/run/work-unit labels in default display
  fields.
- Completing work changes block status and labels; it does not remove completed operation
  rows.
- No projector phase relies on matching coordinator body prefixes such as `确认需求` or
  `完成`.

### Tests

```bash
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/daemon exec node --test --test-name-pattern "ling agent session view" test/channel-workspace.test.mjs
```

## P2: Coordinator Entry Order

Status: implementation corrected and first TurnEnvelope slice landed. Ling Agent now
treats intent-selector `no_reply` as "not executable work" and continues into ordinary
reply handling instead of ending the channel message. Ordinary root messages,
auto-route fallbacks, model-selected ordinary routes, and deterministic clarify questions
render from `ling_agent`. Suppressed ordinary-route and intent-selector evidence is
retained for diagnostics but no longer renders as route/intent chrome in the default
feed. The daemon now builds a `LingAgentTurnEnvelope` for channel turns, passes it through
active-session handling, intent selection, ordinary routing, and AI reply context packs,
allows attachment-only messages through the root turn path, materializes bounded text
attachment previews, and blocks attachment-dependent executable work when required
content is unavailable. Next hardening slice: demote `requestAiReply` and explicit
mentions to coordinator signals, then add TargetResolver so executable follow-ups do not
fall into ordinary chat.

### Goal

Make channel message handling look like one Ling Agent Coordinator entry point, while
reusing the existing selector and router modules internally.

Target priority:

```text
persist user message
-> build LingAgentTurnEnvelope from body, mentions, attachments, links, file refs, and guidance
-> active-session handling
-> materialize attachment/link/file-ref context needed for the decision
-> TargetResolver resolves current-turn, recent-message, asset, active proposal/workflow,
   run, and pending approval targets
-> executable intent selector
-> workflow/collaboration selector
-> ordinary chat auto-route
-> visible Ling outcome, or no visible reply only for non-eligible system/AI/thread inputs
```

### Daemon Work

Refactor `packages/daemon/src/features/channels/messages.ts` toward a small coordinator
function:

```ts
async function handleLingAgentChannelMessage(input: LingAgentChannelMessageInput): Promise<LingAgentChannelMessageResult> {
  const active = await maybeHandleActiveSessionMessage(input);
  if (active) return active;

  const intent = await selectChannelWorkflowIntent(input);
  if (intent.action !== "single_reply" && intent.action !== "no_reply") {
    return renderIntentOutcome(input, intent);
  }

  return maybeRouteOrdinaryReply(input);
}
```

This is a shape, not the exact API. The important change is ownership and ordering.

### P2A: Coordinator Signal Demotion And TargetResolver

The P2A implementation should remove the last user-visible dependency on "ordinary chat
vs executable work" as a first branch.

Required changes:

- Treat `requestAiReply`, `@Ling Agent`, selected teammate chips, and explicit teammate
  mentions as `TurnSignal`s. They may influence responder, participant, or answer
  expectation, but they must not skip executable intent handling.
- Treat `ChannelMessage.threadId` as discussion grouping, not execution eligibility.
  Thread replies should enter Ling Agent Session for active-session, approval, target,
  executable, and clarification checks; `threadId` may only narrow ambient auto-route or
  auto-start policy.
- Add a TargetResolver helper before ordinary answer routing. It should return a resolved
  target with source refs or a reason to clarify.
- Target sources, in priority order:
  1. current-turn explicit path, file name, command, attachment, link preview, or file ref;
  2. active approval, active run, active workflow step, queued intervention, or proposal;
  3. same-thread Ling/user messages and thread root when the turn is a thread follow-up;
  4. recent same-session Ling/user messages with exactly one file target;
  5. recent workflow/proposal/run evidence for filename-only edits.
- If multiple targets are plausible, return `clarify`. If no target exists and the user
  asks "how/why", return `answer`. If no target exists but the phrasing is execution-shaped,
  return `clarify`.
- `answer` is the last ordinary outcome, not the first branch. The coordinator should not
  create "I cannot directly modify files" replies for turns that can become
  `direct_workflow`, confirmation, clarification, or blocked work.

Regression tests:

- `@Ling Agent 在工作区创建 login.html` creates `direct_workflow`, not an ordinary reply.
- After Ling mentions one file target, `可以直接在工作区帮我做好吗？` resolves that file and
  creates `direct_workflow`.
- In a channel thread, after Ling mentions one file target, `你直接帮我写到里面` resolves
  that same-thread target and creates `direct_workflow`.
- `@Designer 你好` remains an ordinary explicit reply.
- If the previous context contains two possible file targets, the same follow-up asks one
  clarifying question.
- If a same-thread follow-up has two possible file targets, it asks one clarifying
  question in the same thread instead of starting work.
- A "how do I create login.html?" question remains `answer`, not `direct_workflow`.

### Turn Envelope Contract

Before calling any selector/router, message handling should build a `LingAgentTurnEnvelope`
from the persisted channel message and available channel assets.

Minimum fields:

- source message id, channel id, thread id, author;
- `body`, mentions, response-language hints;
- attachment refs with filename, kind, content type, size, and preview/extraction status;
- link preview refs with URL, title/status, and bounded summary when available;
- composer workspace file refs parsed from the current input;
- active-run guidance payload when the turn is intended for a running session.

The envelope is the only input object passed to:

- active session guidance/redirect classification;
- executable/collaboration intent selector;
- ordinary answer router;
- proposal/workflow prompt generation;
- final answer context assembly.

Do not let helper modules re-read only `sourceMessage.body` and forget attachments. A
text-empty turn with attachments, links, or guidance is still a valid Ling Agent turn.

### Attachment And Link Materialization

Materialization is not unrestricted tool execution. It is bounded context preparation for
the current user-provided turn.

Rules:

- Use safe metadata first: filename, kind, MIME type, size, uploaded id, link title/status.
- Add preview text only when the existing preview/extraction path supports the file type
  and size.
- For images/PDF/Office files, record whether content is `available`, `unsupported`,
  `blocked`, or `not_loaded`.
- If a task depends on unavailable content, Ling should ask for clarification, request an
  explicit extraction path, or create a blocked proposal; it should not auto-start a write
  or shell task that depends on unseen attachment content.
- Ordinary replies may say "I can see an attached file named X" when metadata is present,
  but must not claim to have read body contents unless preview/extraction was supplied in
  the envelope.
- Runtime approvals remain unchanged for file writes, `bash`, Git, deploy, external send,
  provider changes, credentials, and broad data mutation.

### Detailed Implementation Slices

Status: Slice 1 through the first half of Slice 5 is implemented for channel turns.
Durable storage remains unchanged: `attachmentIds` and `linkPreviewIds` are still the
persisted source refs, while the daemon envelope is the decision/prompt input.

Implement the TurnEnvelope migration in small slices so the product boundary changes
without rewriting the workflow/run stack.

#### Slice 1: Envelope Builder

Add a daemon-only builder near the existing channel context pack code. It should be pure
and deterministic: input is a persisted `ChannelMessage` plus store-readable channel
assets; output is a `LingAgentTurnEnvelope`.

```ts
interface BuildLingAgentTurnEnvelopeInput {
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly activeRunId?: string;
  readonly guidancePayload?: LingTurnGuidancePayload;
}

function buildLingAgentTurnEnvelope(input: BuildLingAgentTurnEnvelopeInput): LingAgentTurnEnvelope;
```

Responsibilities:

- preserve `body`, author, channel, thread, mentions, attachment refs, link refs, file
  refs, response-language hints, and active-run target;
- resolve attachment and link metadata from existing channel-scoped assets;
- never throw away a turn only because `body.trim()` is empty;
- mark missing or cross-channel assets as `blocked` with a reason that can be rendered in
  clarification or diagnostics;
- keep preview text bounded so the envelope can be used by no-tools routing prompts.

Non-goals:

- starting a run;
- granting tool permission;
- reading arbitrary workspace files;
- fetching remote link bodies outside existing preview state.

#### Slice 2: Envelope-Aware Channel Entry

Change `handleLingAgentChannelMessage` so the first step after persistence is envelope
construction.

```text
persist user message
-> build LingAgentTurnEnvelope
-> active-session handling
-> executable intent selector
-> ordinary answer router
```

`maybeHandleActiveSessionMessage`, `selectChannelWorkflowIntent`,
`maybeRouteChannelMessage`, `createAiChannelReply`, proposal prompt builders, and final
context assembly should receive the envelope or a context object that contains it. During
the migration, it is acceptable to keep `sourceMessage` for durable ids and audit fields,
but helper code must not reconstruct meaning from `sourceMessage.body` alone.

Acceptance criteria:

- attachment-only and link-only turns reach Ling Agent Session;
- explicit executable work with attachments reaches the executable selector before
  ordinary answer routing;
- `ChannelIntentDecision.action = "no_reply"` means "not executable work", not "no
  visible Ling outcome";
- ordinary answer routing can still decline non-root or AI-authored messages.

#### Slice 3: Materialization Policy

Add a small materialization classifier that answers two questions before auto-start:

```ts
interface LingTurnMaterializationDecision {
  readonly canReasonFromEnvelope: boolean;
  readonly missingRequiredInputs: readonly LingMissingInput[];
  readonly mayAutoStartExecutableWork: boolean;
}
```

Rules:

- metadata-only is enough for questions such as "what did I attach?" or "which file is
  this?";
- preview/extraction content is required for "summarize this attachment", "copy this
  attachment into README", "fix UI according to this screenshot", or any task where the
  attached content changes the output;
- if required content is unavailable, the selector should return `clarify` or a blocked
  proposal with a concrete reason;
- auto-start may proceed only when every required attachment/link/file input is either
  materialized or irrelevant to the first safe inspection step.

This policy prevents two bad outcomes: answering as if Ling read a file it did not read,
and starting a write/edit/bash task whose required input was never placed in context.

#### Slice 4: Prompt And Evidence Migration

Update prompt/context builders to render envelope facts explicitly:

- body text;
- mentions and requested visible participants;
- attachment metadata and preview status;
- bounded preview or extraction text when available;
- link preview title/status/summary;
- active run target and queued guidance context.

Do not render raw ids alone unless the prompt also includes enough user-facing metadata
to understand what the id refers to. Durable evidence records may stay compact by storing
source ids, but inspect views should make it clear which envelope inputs affected the
decision.

#### Slice 5: Web And Diagnostics

The Web composer already permits attachment-only sends. The Web work for this slice is
mostly display and diagnostics:

- keep attachment/link chips visible on the user message;
- do not show selector/router rows as default transcript content;
- when Ling asks for clarification because attachment content is unavailable, show the
  missing input in normal assistant copy, not in raw router JSON;
- active-run guidance previews should summarize attached files/links as queued guidance,
  not only show `Attachments: <id>`.

#### Slice 6: Backward Compatibility And Cleanup

After selectors consume envelopes:

- keep old storage fields such as `attachmentIds` and `linkPreviewIds`;
- keep decision rows compact and source-id based;
- remove or quarantine helpers that return false solely from `message.body.trim()`;
- rename diagnostics from public `auto_route` language to internal route evidence where
  the UI exposes it;
- keep feature flags as rollout controls, not product-mode concepts.

### Follow-Up Detailed Design For Remaining Envelope Work

Status: backend follow-up slice implemented for materialization status vocabulary,
explicit `file:`/`path:` workspace refs, enriched active-run intervention payloads, and
continuation prompt rendering. Composer-native file refs are now a persisted message
contract via `file_refs_json`, Web composer path chips send `fileRefs`, message rows render
file chips, and active-run follow-ups preserve file refs in queued payloads. Rich
image/PDF/Office body extraction and full remote link body extraction remain separate
follow-up slices.

Detailed contracts for the remaining input and browser-acceptance work live in:

- [Input Materialization Detailed Design](input-materialization-detailed-design.md)
- [Web E2E Acceptance Matrix](web-e2e-acceptance-matrix.md)

The first envelope slice fixes the top-level product owner problem: every root user turn
enters Ling Agent Session before helper modules decide executable work, active-run
guidance, specialist context, or ordinary answers. The remaining work should not reopen
that architecture. It should fill in materialization, rendering, and test coverage around
the same envelope contract.

#### Extraction Pipeline Detailed Contract

Goal: add real extraction for rich inputs without making ordinary chat a hidden tool
runner.

Extractor interface:

```ts
type LingMaterializationSourceKind = "attachment" | "link_preview" | "workspace_file_ref";
type LingMaterializationContentKind =
  | "plain_text"
  | "ocr_text"
  | "vision_summary"
  | "pdf_text"
  | "office_text"
  | "html_text"
  | "metadata";

interface LingMaterializationRequest {
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly requestedBy: "turn_envelope" | "workflow_inspection" | "user_action";
  readonly maxBytes: number;
  readonly maxChars: number;
}

interface LingInputExtractor {
  readonly id: string;
  readonly supportedSourceKinds: readonly LingMaterializationSourceKind[];
  supports(input: LingMaterializationRequest): boolean;
  materialize(input: LingMaterializationRequest): Promise<LingMaterializationResult>;
}

interface LingMaterializationResult {
  readonly status: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly contentKind: LingMaterializationContentKind;
  readonly contentText?: string;
  readonly structuredSummary?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}
```

Durable cache:

Add a channel-scoped materialization cache before adding multiple extractors. The cache is
source evidence, not a new conversation object.

```ts
interface ChannelInputMaterialization {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId: string;
  readonly contentKind: LingMaterializationContentKind;
  readonly status: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly contentText?: string;
  readonly structuredSummaryJson?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Storage rules:

- key cache lookup by `sourceKind + sourceId + sourceFingerprint + extractorId`;
- keep `contentText` bounded and safe for prompt assembly;
- if extracted text exceeds the prompt budget, store a bounded preview plus an artifact or
  source pointer for a managed run to inspect later;
- never store provider secrets, cookies, auth headers, raw forms, or external-send payloads
  in materialization rows;
- materialization rows may be referenced from intent decisions, proposals, run
  interventions, and evidence drawers.

Trigger policy:

| Trigger | Allowed first action |
| --- | --- |
| Small text attachment | Synchronous preview in envelope. |
| Image/PDF/Office upload with no content-dependent request | Metadata only; no extraction required. |
| `summarize/fix/copy according to this image/PDF/Office` | Try supported extractor, otherwise clarify/block. |
| Clear executable task that depends on rich content | Auto-start only if extractor output is `available`, or first step is a safe managed inspection. |
| Link-only message | Use cached preview metadata; full body extraction only if user asks or task requires it. |
| Workspace file ref | Metadata before run; body read through managed inspection/run path. |

Attachment extraction:

- Image v1 should support OCR/vision summary only when an extractor is configured. Without
  extractor output, screenshots stay `unsupported` or `not_loaded`.
- PDF v1 should extract bounded text and page metadata. If text extraction fails, return
  `blocked` with a concrete reason instead of falling back to invented summaries.
- Office v1 should extract bounded plain text for supported document types. Unknown or
  encrypted documents become `unsupported` or `blocked`.
- Archive and binary attachments remain metadata-only until a separate unpacking design
  exists.

Link body extraction:

- Reuse the existing link-preview SSRF boundary: block localhost, private IP ranges,
  file/data/javascript schemes, and unsafe redirects.
- Limit redirects, response size, content type, and wall-clock time.
- Only unauthenticated public GET is eligible for context materialization.
- Authenticated fetch, browser session use, forms, checkout/account-changing pages, and
  external sends must use managed tools and runtime approvals.
- Link extraction should store final URL, content type, title, extraction timestamp, and
  failure reason.

Rollout phases:

1. Add materialization cache and extractor registry with no new extractors enabled.
2. Move current text attachment preview into the cache-backed interface.
3. Add PDF/text extraction and link body extraction behind feature flags.
4. Add image/OCR/vision and Office extraction behind feature flags.
5. Wire materialization evidence into proposal cards, run interventions, and Web evidence.

#### Web Composer And E2E Detailed Contract

Goal: make file chips and missing input states visible to users while keeping internal
selector/router diagnostics hidden.

Message request contract:

```ts
interface ChannelMessageFileRefInput {
  readonly path: string;
  readonly label?: string;
  readonly source?: "composer" | "explicit_text" | "api";
  readonly line?: number;
}

interface ChannelMessageRequest {
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRefInput[];
}
```

Persistence options:

- Preferred: add `file_refs_json` to channel messages so composer-native file chips
  survive reload, active-run guidance, and evidence drilldown.
- Transitional: continue parsing `file:`/`path:` text refs into envelope refs, but do not
  treat this as the final composer contract.
- Do not overload `attachmentIds` for workspace files; uploads and workspace refs have
  different permission and trust boundaries.

Daemon rules:

- validate `fileRefs` count and path shape at message creation;
- normalize file refs into `LingTurnWorkspaceFileRef` before active-session handling,
  intent selection, ordinary routing, and AI reply prompt assembly;
- mark outside-workspace refs `blocked` unless an explicit policy-approved source exists;
- file ref metadata may be available before a run, but body content is read only by a
  managed inspection/run step;
- active-run interventions must preserve file refs in the queued payload.

Web rendering:

- User message rows show attachment chips, link chips, and file chips consistently.
- Blocked/clarify Ling copy names the concrete input and status:
  `I can see screenshot.png, but its image content is not available yet. Start an inspection task?`
- Proposal cards blocked by missing materialization show:
  input name, source kind, status, reason, and first unblock action.
- Queued guidance previews show file/link/attachment names and statuses, never only raw
  ids.
- Evidence drawers may show materialization ids, extractor ids, source fingerprints, raw
  decision ids, and debug status. The default transcript must not.

Browser/E2E acceptance matrix:

| Flow | Expected visible result |
| --- | --- |
| Empty text + uploaded screenshot | User message shows screenshot chip; Ling asks to inspect or explains unsupported extraction. |
| Screenshot task with extractor disabled | No invented visual details; blocked/clarify copy names screenshot and missing extractor. |
| PDF summarize with extractor enabled | Ling answer/proposal cites extracted text status and hides raw materialization JSON. |
| Link-only message | Ling uses title/description metadata or asks what to do. |
| `summarize this link` with extraction failure | Visible blocked/clarify with URL and reason. |
| Composer file chip only | Ling receives a valid turn; file chip persists after reload. |
| Composer file chip outside workspace | Visible blocked/clarify; no hidden file read. |
| Active run follow-up with attachment/link/file chip | Queued guidance preview names each input and status. |
| Content-dependent proposal blocked | Proposal card shows missing input and unblock action; no stale start confirmation. |
| Completed work | Default transcript shows final result, not duplicate process/router rows. |

#### Follow-Up A: Image, PDF, And Office Materialization

Goal: make unsupported rich attachments explicit and safe, without letting Ling pretend it
read content that never entered context.

Contract:

- extend attachment refs with a stable materialization status vocabulary:
  `available`, `metadata_only`, `not_loaded`, `unsupported`, and `blocked`;
- keep the existing `previewStatus` field as a compatibility alias during migration, but
  prefer the broader materialization status in prompts and diagnostics;
- use current metadata first: file name, kind, MIME type, size, uploaded id, and preview
  or extractor status;
- only mark rich attachment content `available` when an image/OCR/PDF/Office extractor
  has actually produced bounded text or structured summary for the envelope;
- if a user request depends on unavailable rich attachment content, return a visible
  clarify or blocked proposal before auto-starting content-dependent edits or shell work;
- allow auto-start only for a safe first inspection step when the first step itself is to
  materialize or inspect the attachment through the managed run/tool path.

Non-goals:

- do not add a hidden image/PDF reader inside ordinary chat prompts;
- do not treat a filename or MIME type as evidence of visual/document content;
- do not grant write, edit, bash, network, or external-send permission from
  materialization status.

Acceptance cases:

| Case | Expected result |
| --- | --- |
| `根据这个截图修 UI` + image with no extractor output | blocked/clarify, no invented screenshot details |
| image with extractor summary | Ling may reason from the extractor summary and include it in proposal/context evidence |
| `总结这个 PDF` + unsupported PDF | visible limitation and request for extraction/alternate input |
| Office document with bounded extracted text | ordinary answer/proposal may use the extracted text under token budget |

#### Follow-Up B: Link Body Extraction

Goal: distinguish cached link-preview metadata from full page/body understanding.

Contract:

- envelope link refs should always include URL, preview title, description/status, and
  cached summary when already available;
- full remote body fetch is a separate materialization step, not an implicit ordinary-chat
  side effect;
- if link extraction is added, record fetch status, content type, final URL, size budget,
  extraction timestamp, and failure reason;
- unauthenticated public GET extraction may be treated as bounded context
  materialization only when product policy allows it; authenticated pages, forms,
  account-changing flows, and external sends must use managed tools and approvals;
- ordinary Ling replies may summarize only preview metadata until extraction content is
  `available`.

Acceptance cases:

| Case | Expected result |
| --- | --- |
| link-only with cached title/description | Ling answers from metadata or asks what to do |
| `总结这个链接` without extracted body | clarify or offer extraction path; no body summary invented |
| extracted article body under budget | Ling may summarize extracted content and cite link status in evidence |
| extraction timeout/blocked | visible blocked/clarify result with URL and failure reason |

#### Follow-Up C: Workspace File References

Goal: let composer file refs participate in the same Ling Agent turn model without hiding
workspace reads in pre-run prompt assembly.

Contract:

```ts
interface LingTurnWorkspaceFileRef {
  readonly path: string;
  readonly label?: string;
  readonly rootRelation: "inside_workspace" | "outside_workspace" | "unknown";
  readonly kind: "file" | "directory" | "glob" | "unknown";
  readonly materializationStatus: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly previewText?: string;
  readonly blockedReason?: string;
}
```

Rules:

- parse file refs from composer metadata or explicit user text into normalized paths;
- resolve only metadata that is safe and cheap before a run: root relation, type, and
  user-facing label;
- do not read arbitrary workspace file bodies into ordinary chat merely because a path was
  mentioned;
- when file content is required, create a managed inspection step or use the existing
  run/tool path so evidence and approval policy stay attached;
- block refs outside the active workspace unless the user explicitly provides a supported
  attachment or a policy-approved path.

Acceptance cases:

| Case | Expected result |
| --- | --- |
| `看一下 README.md 是否要改` | proposal/run may start with safe read/inspection step |
| `把 /tmp/private.txt 内容写进 README.md` outside workspace | blocked/clarify unless provided as attachment or policy-approved input |
| composer file chip with no text | Ling receives a valid turn and asks/acts from file-ref metadata |
| missing file ref | visible blocked/clarify result; no uncaught exception |

#### Follow-Up D: Active Run Intervention Rendering

Goal: keep queued guidance faithful to the original turn instead of degrading to raw ids.

Contract:

- `RunIntervention` may store compact source ids, but its prompt rendering input must be
  reconstructed from `LingAgentTurnEnvelope`;
- continuation prompts should render body text, file names, URLs, preview status, bounded
  preview text when available, and missing-input reasons;
- UI previews should say "Queued guidance" with file/link names and statuses, not
  `Attachments: <id>`;
- if a queued intervention contains unavailable content, continuation should pause or ask
  for materialization before applying content-dependent instructions.

Acceptance cases:

| Case | Expected result |
| --- | --- |
| active run follow-up with text attachment | queued guidance prompt includes file name and preview text |
| active run follow-up with image unsupported | queued guidance names image and marks content unavailable |
| active run follow-up with link preview | queued guidance renders URL/title/status, not only id |

#### Follow-Up E: Text-Only Helper Cleanup

Goal: remove remaining root-turn decisions that accidentally depend only on
`sourceMessage.body`.

Rules:

- helpers that only generate deterministic titles or language hints may keep reading body
  text when their output cannot affect whether Ling responds or starts work;
- any helper that decides reply-worthiness, executable intent, materialization, active-run
  guidance, proposal eligibility, or prompt context must consume the envelope;
- empty `body` plus attachments, links, file refs, or guidance payload is a valid root
  turn and must never be treated as "nothing to do";
- `no_reply` remains valid for AI-authored/system/internal messages, but not as a terminal
  result for ordinary root local-user turns.

Acceptance cases:

| Case | Expected result |
| --- | --- |
| empty body + attachment | reaches Ling outcome path |
| empty body + link | reaches Ling outcome path |
| empty body + file ref | reaches Ling outcome path |
| AI/system message | helper may still decline visible reply |

#### Follow-Up F: Web Blocked/Clarify Display

Goal: make missing input understandable without exposing selector/router internals.

Contract:

- user message rows keep attachment/link/file chips visible;
- Ling blocked/clarify copy names the missing input and status:
  `I can see screenshot.png, but its image content is not available yet. Start an
  inspection task?`;
- default transcript hides selector/router rows, raw confidence, JSON, and raw id lists;
- evidence expansion may show compact source ids plus materialization status for
  debugging;
- proposal cards that are blocked by unavailable content should show the first concrete
  unblock action, such as "extract PDF text" or "attach the file as text".

Acceptance cases:

| Case | Expected result |
| --- | --- |
| unsupported screenshot request | ordinary transcript shows a clear Ling clarification, not route diagnostics |
| blocked proposal | card shows missing input and next action |
| active queued guidance | preview names files/links and statuses |

#### Follow-Up G: Browser And E2E Verification

Goal: verify the product behavior users actually see after daemon-level tests pass.

Coverage:

- attachment-only send creates a visible Ling outcome;
- screenshot attachment with unsupported materialization produces blocked/clarify copy;
- text attachment preview can feed README/write proposal or auto-start when policy allows;
- proposal blocked by unavailable content does not show stale confirmation or raw router
  rows;
- active-run guidance with attachments renders file/link names in the queued preview;
- final transcript shows user turn, Ling outcome, and final report without duplicate
  process cards.

Use Playwright/browser verification only after the daemon behavior is covered by focused
tests. The Web tests should assert visible copy and hidden diagnostics, not raw internal
decision JSON.

### Detailed Test Matrix

Add focused daemon tests before broad Web e2e coverage:

| Case | Expected result |
| --- | --- |
| empty body + one text attachment | Ling creates a visible answer/clarify outcome, not silent no-op |
| `总结这个附件` + previewable text attachment | selector may choose `single_reply` or `direct_workflow` with preview in context |
| `把附件内容写进 README.md` + text attachment without preview | blocked proposal or clarify, no auto-start |
| `根据这个截图修 UI` + image without image materialization | clarify or blocked proposal, no invented screenshot details |
| link-only turn | ordinary Ling reply asks what to do or summarizes available link metadata |
| active run follow-up with attachment | queued guidance preserves attachment refs and metadata |
| `好的` root user turn | visible Ling acknowledgement is allowed; selector `no_reply` is not terminal |
| AI-authored/system message | router may return no visible user-facing reply |
| missing/cross-channel attachment id | blocked/diagnostic outcome, not uncaught exception |

### Active-Session Handling

If a session has active run/workflow state:

- approval-looking responses should resolve approval through existing endpoints only when
  unambiguous and explicitly supported;
- additive instructions should become `queue_followup`;
- direction-changing instructions should become `interrupt_redirect`;
- ordinary status questions can answer from durable state;
- unrelated chat can fall through to ordinary chat without changing the run.

The first slice may implement only classification and UI affordance. It does not need to
auto-resolve approvals from natural language.

Implemented initial behavior:

- additive follow-up text such as `完成后也更新 docs` creates a durable
  `queue_followup` run intervention and appends intervention audit events;
- redirect text such as `停，改用 daemon API` returns a `requires_confirmation`
  active-session action, but does not create an intervention or cancel the source run;
- both paths run before executable selector and ordinary auto-route, so they do not create
  route decisions or execution proposals.
- follow-up interventions must preserve the full envelope payload, not just the text body,
  so attachments and link previews remain available when the queued guidance is rendered
  into a run prompt.

### Guardrails

- Auto-route must not run before executable intent detection.
- No selector/router may be called with only the text body when the source turn includes
  attachments, link previews, file refs, or active-run guidance payload.
- Intent-selector `no_reply` is not terminal; it falls through to ordinary chat routing.
- `Channel.defaultTeammateId` must not become the visible ordinary-chat author. It is a
  preferred specialist hint for assignment, workflow participation, and evidence.
- Explicit AI teammate mentions and explicit visible multi-reply requests are the paths
  where specialist teammates appear as visible reply authors.
- Suppressed/no-reply route decisions and intent-selector decisions must not render under
  ordinary user messages.
- Missing runnable providers produce a visible blocked Ling reply, not silent no-reply.
- `ChannelMessageRouteDecision` remains ordinary-chat evidence only.
- `ChannelIntentDecision` remains executable/collaboration evidence only.
- No selector or router output can grant tools or start side effects directly.

### Tests

Add daemon tests for:

- file create request creates proposal, no ordinary route decision;
- attachment-only turn creates a Ling reply, clarification, or blocked proposal rather
  than being dropped because `body` is empty;
- attachment-dependent execution request does not auto-start until required attachment
  content is materialized or the user clarifies the target;
- README follow-up resolves recent target before ordinary route;
- ordinary question still creates one visible Ling Agent reply when a runnable provider is
  available, even if a default teammate is configured;
- acknowledgement, punctuation, and repeated greeting still create a visible Ling outcome;
- active run follow-up creates or previews intervention instead of ordinary reply.

## P3: Terminal Final Report

Status: initial implementation complete. Reports are deterministic projections over
existing workflow/run/artifact/approval records; no final report table or model-generated
summary is introduced in this slice.

### Goal

When workflow/run execution reaches terminal state, Ling Agent should produce one final
result report and collapse process detail by default.

### Contract

```ts
interface LingAgentFinalResultView {
  readonly title: string;
  readonly summary: string;
  readonly outcome: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly changedPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly checks: readonly LingAgentResultCheck[];
  readonly approvals: readonly LingAgentResultApprovalSummary[];
  readonly nextActions: readonly string[];
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}
```

### Source Priority

Build final reports from durable data, not transient UI state:

1. workflow terminal `resultSummary`;
2. terminal workflow step summaries and output packets;
3. linked run terminal summaries;
4. artifacts, changed paths, approvals, execution actions, and diagnostics;
5. fallback deterministic summary if no generated summary exists.

### Daemon Work

- Add a deterministic final report builder first.
- Optionally persist final report later if recomputation becomes expensive.
- Avoid model-generated final reports in the first slice unless the existing runner output
  already provides a terminal summary.

### Web Work

- Render completed work as one `ConversationWorkCell` in completed mode.
- Move raw workflow/run/proposal process details behind evidence expansion.
- Do not show both raw process cards and final report as default rows for the same work.

### Tests

Add tests for:

- completed workflow has a final result;
- blocked workflow carries blocker and next action;
- approval-denied run mentions denied approval in summary;
- evidence expansion still links to workflow steps, runs, artifacts, and approvals.

## P4: Permission UX Integration

Status: initial implementation needs one follow-up slice. The first slice updated Web
confirmation copy and tested the existing inline runtime approval path. The next slice
must allow clearly scoped local executable requests to auto-accept their proposal and
start the existing workflow/run path, while still using durable runtime approvals for
side effects.

### Goal

Separate intent acceptance, optional pre-execution confirmation, and runtime approval
without making the user learn workflow/run/approval internals.

### Auto-Start Policy

For clear executable work, Ling Agent should create proposal evidence, auto-accept it,
and start the existing task/run or workflow path immediately when required tools are not
denied:

```text
user asks for clear executable work
-> create ChannelExecutionProposal with requiredTools
-> mark it accepted and persist autoStartReason evidence
-> call the existing proposal-to-workflow/run adapter
-> runtime write/edit/bash approvals still follow workspace policy
```

Auto-start is allowed for explicit executable work when:

- the target file, command, task scope, or first inspection step is explicit enough to
  create a bounded run;
- a runnable executor is available;
- required tools are not `deny` under workspace approval policy;
- the resulting run request can be represented through existing proposal/workflow/run
  state and approval policy.

Auto-start must fall back to clarification, confirmation, or blocked proposal when:

- required scope is missing and cannot be inspected safely inside a run;
- the model cannot confidently resolve target, content, or acceptance;
- no runnable executor/provider is available;
- one or more required tools are `deny` under workspace approval policy;
- a workspace/channel policy explicitly requires confirmation before run creation.

### Pre-Execution Confirmation

Use confirmation copy only when auto-start is not allowed. Copy should be permission
oriented, such as:

```text
Need write permission to create /path/README.md for this task.
Start task?
```

The confirmation card should include:

- concrete action;
- target path, command, or MCP tool;
- required tool family: `write`, `edit`, `bash`, `mcp_tool_call`;
- executor: Ling Agent or specialist teammate;
- note that runtime approval may still be requested.

The card should not be shown for every ordinary clear task. It is a scope/risk gate, not
the normal start mechanism.

### Runtime Approval

Runtime approval stays on existing durable approval records:

```text
ApprovalRequest / ExecutionAction
-> InlineApprovalStrip for active local work
-> Review Queue or approval page as fallback
```

Rules:

- no mutation of workspace approval policy from task confirmation;
- no second approval store;
- Ling Agent may auto-accept a start proposal only under the Auto-Start Policy above;
  it must never auto-approve runtime `ApprovalRequest` records;
- high-risk or external actions stay governed by runtime approval policy; `ask` pauses at
  the tool call, `allow` proceeds, and `deny` blocks.

### Code Anchors

- confirmation card data from proposal/session view;
- `apps/web/src/lib/inline-approvals.ts` for active approval selection;
- `apps/web/src/features/approvals/InlineApprovalStrip.tsx` for active local approval UI;
- `apps/web/src/features/approvals/ApprovalCard.tsx` for detailed payload rendering.

### Tests

Add tests for:

- clear file create auto-starts through proposal/workflow/run and then waits on runtime
  `write` approval when policy is `ask`;
- clear file edit auto-starts through proposal/workflow/run and then waits on runtime
  `edit` approval when policy is `ask`;
- clear project command auto-starts through proposal/workflow/run and then waits on
  runtime `bash` approval when policy is `ask`;
- high-risk file/delete/push/deploy/provider/credential requests auto-start only when
  required tools are not denied; runtime approval policy still gates the side effect;
- incomplete creation requests ask one clarifying question and do not create an ordinary
  "I cannot execute" reply;
- runtime approval still resolves through existing approval endpoint;
- approving a runtime permission does not change workspace policy.

### P4A Follow-Up Slice: Auto-Start Execution

Implement auto-start as a follow-up to the existing P4 permission UX work:

- add an auto-start eligibility helper beside executable intent detection;
- persist proposal evidence before any run/workflow starts;
- mark eligible proposals `accepted` and persist auto-start reason in decision/workflow
  evidence, such as `autoStartReason`;
- call the existing proposal-to-workflow/run adapter rather than adding a new runner
  entry point;
- render running progress immediately instead of a stale confirmation card;
- keep runtime approval behavior unchanged.

P4A must not teach the ordinary answer router to create work. It belongs to Ling Agent
Session after executable detection and before ordinary answer mode.

### P4A Detailed Implementation Contract

P4A is a daemon coordinator change, not a Web shortcut. The user message handler should
make the start decision after executable intent detection and before ordinary answer
routing.

Required order:

```text
persist user message
-> build LingAgentSessionView
-> handle active-session approval/follow-up/redirect cases
-> detect executable or collaboration intent
-> create ChannelExecutionProposal when intent is executable
-> evaluate auto-start eligibility
-> if allowed: call confirmChannelExecutionProposalWorkflow service directly
-> if denied by risk/policy: leave proposal as draft/blocked and render confirmation
-> if incomplete: ask one clarifying question and do not create an ordinary answer
-> only then allow ordinary answer routing
```

The manual Web route remains the same:

```text
POST /channel-proposals/:proposalId/confirm-workflow?cwd=...
```

Auto-start should call the same daemon service function that powers that route,
`confirmChannelExecutionProposalWorkflow`, with a server-side caller. Do not add a second
workflow compiler, task runner, or hidden run creation path.

#### Eligibility Helper

Add a small pure helper near executable intent handling:

```ts
type LingAutoStartRisk = "low" | "medium" | "high";

type LingAutoStartBlockReason =
  | "missing_target"
  | "missing_content"
  | "ambiguous_acceptance"
  | "high_risk_action"
  | "external_side_effect"
  | "credential_or_provider_change"
  | "approval_policy_change"
  | "deploy_release_publish"
  | "git_push_or_merge"
  | "broad_delete_or_move"
  | "missing_executor"
  | "policy_requires_confirmation";

interface LingAutoStartDecision {
  readonly allowed: boolean;
  readonly risk: LingAutoStartRisk;
  readonly reason: string;
  readonly blockReason?: LingAutoStartBlockReason;
}
```

The helper must be deterministic from normalized intent, proposal data, channel policy,
workspace approval policy, executor availability, and current session state. It should
not depend on model prose after the proposal is already built.

Allowed by default:

- create or edit one or a small set of named local files;
- update a known docs/code section where target and acceptance are clear;
- run a narrow local command such as a test, typecheck, lint, or smoke command;
- inspect/read/summarize local project state when tool execution is required;
- explicit push/merge/deploy/release requests when the needed tool family is not denied;
  runtime approval policy gates the mutation step.

Runtime-gated by default:

- broad deletes, moves, cleanups, or filesystem rewrites;
- Git push, merge, release, deploy, publish, or external-send work;
- credential, provider, plugin, approval-policy, memory-authority, or permission-scope
  changes;
- paid actions, account mutations, or actions against external services.

These classes do not automatically block run creation. They raise risk and should cause
the runner to hit runtime approval when the workspace policy is `ask`. They block only
when the required tool family is `deny` or no supported runtime gate exists.

Denied before run creation:

- required tool family is `deny` under workspace approval policy;
- no runnable executor/provider is available;
- missing target, missing content, ambiguous command, or unclear acceptance that cannot
  be safely resolved by an initial inspection step.

#### Proposal And State Semantics

Do not add a new proposal status for the first P4A slice.

Use existing states:

```text
draft proposal
  -> accepted + linkedWorkflowId when auto-start succeeds
  -> draft or blocked when confirmation is required or validation fails
  -> cancelled or superseded through existing user actions
```

Auto-start evidence should be auditable without a schema migration:

- `ChannelExecutionProposal.status = "accepted"` means the plan was accepted, whether by
  user click or auto-start policy;
- `linkedWorkflowId` links to the started workflow;
- `channel_intent_decisions` should record that the accepted outcome came from Ling Agent
  Session auto-start, including `LingAutoStartDecision.reason` and any block reason;
- workflow metadata may include `sourceProposalId`, `sourceMessageId`,
  `autoStartSource: "ling_agent_session"`, and `autoStartReason` when metadata is
  available;
- proposal schema changes are deferred unless evidence cannot be reconstructed from
  intent decisions plus workflow metadata.

#### Confirmation And Clarification Semantics

When auto-start is denied because scope is incomplete, do not create a proposal card that
contains guessed work. Ask one targeted clarification question.

When auto-start is denied because run-start policy blocks execution, keep or create the
proposal card and render it as a start gate. The card should explain the concrete block
reason:

- `tool_denied`: "Workspace policy denies bash/edit/write for this task."
- `missing_executor`: "No runnable executor/provider is available."
- `missing_target`: "The target is missing and cannot be safely inspected."
- `policy_requires_confirmation`: "Workspace/channel policy requires confirmation before
  run creation."

#### Runtime Approval Semantics

Auto-start is not runtime approval.

The first side-effecting tool call still flows through existing approval records:

```text
auto-started workflow running
-> runner requests write/edit/bash/MCP
-> ApprovalRequest or ExecutionAction is created
-> policy ask pauses the run
-> inline approval strip appears
-> user approves or denies
```

P4A must not:

- mutate workspace approval policy;
- pre-grant `write`, `edit`, `bash`, MCP, external-send, deploy, or credential authority;
- let Ling Agent approve its own runtime request;
- hide approval denial inside a final report without showing the blocked state.

#### Web Rendering Contract

For auto-started work:

- hide the proposal confirmation card from the default feed once the linked workflow is
  running;
- show one active mutable process cell;
- show inline runtime approval when the run is waiting for approval;
- collapse completed process detail under the Ling Agent final report;
- keep proposal, intent decision, workflow, run, and approval evidence available through
  expansion.

For confirmation-required work:

- show the proposal card with the block reason and concrete required permission family;
- do not show a running process cell until the user starts it;
- after user confirmation, reuse the same rendering path as auto-started work.

#### Minimum Tests

Daemon tests should cover:

- clear file create intent creates a proposal, auto-confirms it through
  `confirmChannelExecutionProposalWorkflow`, and links a workflow;
- clear file edit intent does the same with required tool `edit`;
- narrow test command intent does the same with required tool `bash`;
- runtime approval policy `ask` still creates a waiting approval after auto-start;
- high-risk Git push/deploy/delete/provider/credential requests auto-start when required
  tools are not denied and then rely on runtime approval policy for the side effect;
- required tool `deny` creates a blocked/confirmation proposal and does not auto-start;
- missing target/content asks clarification and does not create an ordinary answer;
- ordinary non-executable chat still reaches the ordinary answer router.

Web tests should cover:

- auto-started work shows running progress instead of a stale confirmation card;
- waiting runtime approval appears inline for an auto-started task;
- confirmation-required work still shows the proposal card;
- terminal auto-started work collapses process detail under the final report.

## P5: Ling Agent Built-In Executor

### Goal

Let Ling Agent execute safe work when no specialist teammate is configured or required.
Specialists remain optional collaborators.

### Executor Identity

Initial implementation uses the protected built-in executor identity:

```ts
const LING_AGENT_EXECUTOR_ID = "ling_agent";
```

P5 represents Ling Agent as a built-in executor in channel proposal and workflow paths.
P7 promotes the same identity into a protected system teammate profile. This keeps the
existing proposal, workflow, run, approval, artifact, and evidence state machines
unchanged. It does not introduce a second approval authority.

### Selection Rules

Use Ling Agent direct execution when:

- the task is single-step or can be scoped without specialist judgment;
- no matching specialist is available in the channel with the required tools;
- the user addresses Ling directly;
- the selected specialist has no runnable provider but the workspace has a runnable
  provider for Ling Agent;
- policy does not require a specialist role.

Use specialists when:

- the user explicitly names one;
- channel default teammate is relevant and runnable;
- a workflow step requires a role;
- specialist skill/profile materially changes the prompt, tool scope, or approval gates.

### Missing Specialist UX

Show a non-blocking recommendation only when useful:

```text
No dedicated Engineer teammate is configured. Ling Agent can handle this task now, or you
can add an Engineer teammate for future runs.
```

Do not show this for every ordinary task.

### Tests

Add tests for:

- file creation with no runnable Docs teammate creates a `ling_agent` proposal and
  auto-starts when the scope is clear and required tools are not denied;
- code edit with no runnable Engineer teammate creates a `ling_agent` proposal and
  auto-starts when the scope is clear and required tools are not denied;
- ambiguous fallback proposals clarify; policy-denied fallback proposals remain
  `ready_for_confirmation` or blocked;
- an accepted/auto-started fallback proposal creates a workflow step assigned to
  `ling_agent`;
- the started run receives only the proposal's task-scoped required tools.

- no Docs teammate, README create still uses Ling Agent executor;
- no Engineer teammate, simple code edit can use Ling Agent executor;
- explicit teammate mention still selects that teammate when runnable;
- missing required specialist blocks only when workflow policy says the role is required.

## P6: Web Acceptance And Regression Matrix

Initial implementation status: complete for the first Ling Agent session acceptance
matrix. The Web E2E suite now covers the high-risk user-facing seams; broader live smoke
can stay as a release checklist item.

### Required User Flows

1. Create file:

```text
User: 在 /tmp/example 下创建 README.md
Expected: confirmation card with write scope, not Docs shell snippet.
```

2. Filename-only continuation:

```text
Prior work: created /tmp/example/README.md
User: 在 README.md 中添加一句测试语句
Expected: edit confirmation for /tmp/example/README.md.
```

3. Ordinary question:

```text
User: 这个 workspace 里面都有谁？
Expected: one ordinary Ling Agent answer.
```

4. Active follow-up:

```text
Active run exists.
User: 完成后也更新 docs
Expected: queued follow-up affordance/intervention, not hidden prompt injection.
```

5. Stop and redirect:

```text
Active run exists.
User: 停，改用 daemon API
Expected: interrupt-and-redirect affordance/intervention.
```

6. Runtime approval:

```text
Run asks to edit a file.
Expected: inline approval strip near active session, durable approval evidence.
```

7. Terminal report:

```text
Workflow succeeds.
Expected: final Ling Agent result report, process detail collapsed, evidence expandable.
```

### Suggested Validation Commands

Narrow backend checks:

```bash
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/daemon exec node --test test/channel-workspace.test.mjs
corepack pnpm --filter @ling-stack/daemon exec node --test test/approval-policy-run.test.mjs
```

Web checks after UI slices:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts
```

Always run:

```bash
git diff --check
```

## P7: Protected Ling Agent Teammate Profile

### Goal

Make Ling Agent visible and usable as the default built-in teammate instead of a hidden
fallback. Ling Agent should feel like a normal teammate in roster, channel membership,
mentions, and private chat, while keeping system-owned lifecycle and permission boundaries.

### Profile Contract

Use one canonical identity everywhere:

```ts
const LING_AGENT_ID = "ling_agent";
```

The profile must expose at least:

```ts
interface LingAgentSystemProfile {
  readonly id: "ling_agent";
  readonly kind: "system_teammate";
  readonly displayName: string;
  readonly avatar?: LingAgentAvatarConfig;
  readonly description?: string;
  readonly protected: true;
  readonly removable: false;
  readonly editableFields: readonly ["displayName", "avatar", "description", "userInstructions"];
  readonly userInstructions?: LingAgentUserInstructionsRef;
}
```

Implementation may start with a virtual profile and later migrate to durable storage if
personalization requires it.

### Channel Rules

- New channels include Ling Agent by default.
- Existing channels synthesize or migrate Ling Agent membership if missing.
- UI must not expose remove, delete, disable, archive, or hide actions for Ling Agent.
- Channel settings should not ask users to choose Ling Agent as a default teammate; Ling
  Agent is always the coordinator. Preferred specialist remains separate.
- Mention picker includes Ling Agent.
- Private teammate chat can open Ling Agent using the same conversation shell as other AI
  teammates.

### Personalization Rules

Allowed:

- display name;
- avatar image, initials, color, or accent;
- short description;
- user-added Ling Agent instructions.

Not allowed:

- changing `id = "ling_agent"`;
- deleting, disabling, archiving, hiding, or removing Ling Agent from a channel;
- editing the built-in product-owned Ling Agent instruction document;
- granting tools, provider access, memory authority beyond protected defaults,
  credentials, deploy authority, or external-send authority;
- bypassing Ling Agent Session auto-start/confirmation policy, runtime approval, runner
  registry, or audit.

### Instruction Layering

Represent the system instruction and user addition as separate sources:

```text
LING_AGENT.md
LING_AGENT.user.md
```

`LING_AGENT.md` is product-owned and versioned with the app. `LING_AGENT.user.md` is
workspace/user-owned preference material. Prompt assembly should order product rules before
user additions, and conflicts must resolve in favor of product rules.

### Tests

Add coverage for:

- new channel includes Ling Agent membership;
- old channel without explicit membership renders Ling Agent anyway;
- remove/delete/disable actions are unavailable for Ling Agent;
- display name/avatar personalization changes presentation but not stored author id;
- user-added instructions are included after built-in instructions;
- user-added instructions cannot bypass approvals or change protected lifecycle;
- Ling Agent private chat opens and replies through the normal teammate conversation path.

## P8: Always-On Teammate Memory And Ling Agent Memory Panel

### Goal

Make memory a default teammate capability rather than a setup toggle. Every AI teammate
has isolated private memory, channel membership provisions that teammate's own channel
memory, and Ling Agent exposes protected coordinator memory in its teammate Memory panel.

### Storage Rules

- Every AI teammate gets `private-chat-summary` and `private-notes`.
- Every channel membership gets `channel-brief` and `channel-decisions` for that teammate
  and channel.
- Default scopes are synthesized/backfilled on teammate creation, teammate listing,
  channel membership changes, and memory-scope reads.
- Default scopes cannot be removed or disabled. Compatibility clients may send
  `enabled:true`; `enabled:false` is rejected.
- Ling Agent scopes are protected system memory and cannot be replaced through the normal
  teammate memory endpoint.

### UI Rules

- Creation and settings surfaces must not show memory source checkboxes or off switches.
- The Memory tab shows scope status as active and explains that review controls manage
  content, not recall availability.
- Ling Agent sees the Memory tab even though other protected lifecycle tabs remain hidden.
- Empty states say memory is being prepared, not that memory is disabled.

### Tests

Add coverage for:

- built-in Ling Agent has private and channel scopes after channel creation;
- newly created teammates have private scopes by default;
- channel membership adds channel scopes;
- `enabled:false` is rejected at store and daemon API boundaries;
- replacing a subset of scopes preserves all required defaults;
- protected Ling Agent memory remains visible but not replaceable.

## PR Slicing

Recommended order:

1. P1 projection helper and daemon tests.
2. P2 coordinator entry ordering and regression tests.
3. P3 final report projection and Web completed-cell behavior.
4. P4 permission copy plus inline approval integration polish.
5. P5 Ling Agent built-in executor.
6. P4A auto-start policy for clear executable work.
7. P6 Web E2E and smoke hardening.
8. P7 protected Ling Agent teammate profile and personalization.
9. P8 always-on teammate memory and Ling Agent Memory panel.

Avoid combining P2 routing changes with P3 Web final-report UI in the same PR unless the
diff stays small. Routing bugs and UI-collapse bugs have different failure modes.

## Data Migration Policy

P1-P8 plus P4A should not require database migrations.

Allowed without migration:

- derived session view;
- new TypeScript helper types;
- final result projection built from existing records;
- UI copy and view-model changes;
- metadata fields inside existing proposal/workflow/run metadata only when already
  versioned and guarded.

Require a separate migration proposal if:

- final reports need durable persistence;
- Ling Agent sessions need first-class storage;
- executor identity cannot fit existing teammate/workflow metadata;
- auto-start/confirmation cards need a new durable decision record beyond existing
  proposals.
- Ling Agent personalization requires durable profile or instruction storage that cannot be
  represented as a virtual profile plus existing workspace settings.

## Acceptance Criteria

- Users see Ling Agent process and results, not selector/auto-route/workflow/run names.
- Executable requests become durable proposal evidence before ordinary chat routing.
- Explicit executable requests auto-start through existing workflow/run paths when
  executor/provider/scope is available and required tools are not denied.
- Ambiguous requests clarify; policy-denied requests show confirmation/blocking instead
  of auto-starting.
- High-risk side effects such as Git push/merge, deploy/release/publish, broad delete,
  external send, or credential/provider changes are runtime-gated by approval policy
  rather than blocked before run creation.
- Confirmation cards, when shown, name the concrete permission family and target.
- Runtime tool approval still uses existing durable approvals.
- Missing specialists do not block safe Ling Agent direct execution.
- Ling Agent appears as a protected built-in teammate in every channel.
- Ling Agent private chat is available through the teammate conversation surface.
- Ling Agent display name/avatar/user-added instructions are customizable without changing
  `ling_agent` identity or approval behavior.
- AI teammate memory is always on, per-teammate, and not user-disableable.
- Ling Agent protected coordinator memory is visible in its Memory panel.
- Active follow-ups and redirects use durable intervention semantics.
- Completed work shows one final result report by default.
- Evidence remains expandable and complete.
- No product behavior depends on hidden runner memory or browser state.
- No slice creates a second approval system or bypasses runner registry.

## Open Decisions

Product boundary decisions: none for this plan.

Implementation decisions to close during P1-P8 plus P4A:

- exact location of the shared `LingAgentSessionView` type after the first daemon/Web
  slice proves the shape;
- whether final reports should be persisted or recomputed;
- whether the protected Ling Agent profile is virtual, durable, or migrated from a seeded
  teammate row;
- where user-added `LING_AGENT.user.md` instructions are stored and versioned;
- exact Web copy for pre-execution confirmation versus runtime approval.
