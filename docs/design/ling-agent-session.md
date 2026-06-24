# Ling Agent Session Control Plane

Status: design baseline for the product-level session model
Date: 2026-06-12

Related docs:

- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Input Materialization Detailed Design](input-materialization-detailed-design.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Web E2E Acceptance Matrix](web-e2e-acceptance-matrix.md)

## Summary

The user-facing product model is Ling Agent sessions, not selectors, auto-routes,
workflows, proposals, runs, or approval tables. Workflows, runs, approvals, artifacts,
and route decisions are implementation and audit primitives. They surface only as
process, permission prompts, final summaries, and optional evidence details.

Ling Agent is the always-available session owner and built-in system teammate. It should
behave like the default AI teammate in channels and private chat, while remaining protected
from deletion, disablement, or removal from channels. Specialist teammates are optional
collaborators. Missing specialists may produce a visible recommendation, but must not
prevent executable work when Ling Agent can safely run it through existing workflow, run,
approval, and evidence paths.

Target user experience:

```text
user sends a turn with text, mentions, attachments, links, file refs, or guidance
-> Ling Agent builds one TurnEnvelope
-> Context Processing Layer builds the relevant Channel Context View
-> TargetResolver resolves the referenced thing: current text, prior message,
   attachment, file ref, active proposal, workflow, run, or approval
-> IntentRouter decides one outcome: answer, clarify, direct workflow, workflow
   proposal, visible multi-reply, active-session follow-up, approval response, or no-reply
-> @mentions, selected teammates, and requestAiReply are preference signals, not
   top-level route branches
-> Ling Agent auto-starts clearly scoped safe work, or asks one clarifying question
-> Ling Agent shows confirmation only when scope or policy requires it
-> Ling Agent uses specialists when useful and available
-> execution flows through workflow/run/approval
-> active process stays visible as one operation cell while running
-> terminal process commits once and remains as folded transcript history
-> evidence remains expandable
```

## Conversation Projection Boundary

The concrete transcript projection is defined in
[Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md).

That document merges these product concerns:

- `CoordinatorMessageCell`: Ling Agent owns user-facing narration, clarification,
  blocked-state explanation, and final synthesis.
- `OperationCell`: executable work appears as one visible work object that mutates while
  active and commits once when terminal.
- `AgentActivitySpan`: specialist teammates appear as compact latest-action rows inside
  the operation unless the user is directly chatting with that teammate.
- `EvidenceDetail`: commands, stdout/stderr, raw events, workflow packets, JSON, provider
  metadata, and ids remain in expandable evidence or diagnostic detail.

This boundary prevents the same task from rendering as a Ling Agent message, workflow
card, run card, collaboration card, right-drawer duplicate, and raw log row at the same
time.

### Shared Transcript Boundary

Ling Agent Session View and Conversation Transcript are related but not the same read
model:

| Model | Owns | Does not own |
| --- | --- | --- |
| `LingAgentSessionView` | coarse session state, active workflow/run ids, pending approvals, final result summary | ordered transcript rows, command output folding, per-agent process history |
| `ConversationTranscript` | ordered user-visible turn blocks, active/terminal operation cells, agent activity spans, artifact strips, raw/detail refs | runtime authority, approval decisions, runner execution |

The session view can answer "what state is Ling Agent in right now?". The transcript can
answer "what did the user see, what is running, and what process history remains folded?".

For Web and future Desktop parity, the transcript projection should move behind shared
contracts:

```text
channel messages, workflows, runs, approvals, artifacts, interventions
  -> daemon/core transcript projector
  -> packages/contracts ConversationTranscript
  -> Web renderer / Desktop renderer / CLI renderer
```

The current Web projection may remain a prototype while the UI design settles, but the
long-term owner must not be `apps/web`. Desktop should not copy Web-specific grouping
logic, and CLI should not become the source of truth for message projection.

Coordinator prose is not the structure. The transcript projector must not decide start,
terminal, delegation, or blocked states by matching generated phrases such as
`确认需求` or `完成`. Those states come from turn/cell metadata and lower-level records.

## Problem

The current channel design exposes too much of the implementation model:

- ordinary chat, executable work, and continuation are split across auto-route, selector,
  proposal, workflow, run, and thread surfaces;
- a request like "create README.md in this path" can be misread as a Docs answer instead
  of a task that needs write permission;
- a message such as "look at this attachment" can preserve `attachmentIds` in storage but
  still fail to put attachment metadata or preview content in the agent's reasoning path;
- attachment-only, link-only, or composer-guidance turns can be ignored by text-first
  selectors because `body` is empty or underspecified;
- after execution, the UI can leave raw process or proposal rows above the conversation
  instead of replacing them with a final task report;
- follow-up text can miss the prior executable context and get treated as a new ordinary
  chat message;
- when no specialist teammate matches the request, the product has no obvious default
  executor even though Ling itself can safely execute through the existing run path.

These are not isolated selector bugs. They point to a missing product-level owner: the
Ling Agent session.

## Product Model

Ling Agent owns the conversation session. It is the product-level coordinator that:

- receives every user turn in the active Ling collaboration surface as one structured
  envelope, not just the text body;
- consumes a layered channel context view produced by the Context Processing Layer.
  Ling Agent decides how to collaborate and respond; it does not hand-build prompt
  context from raw channel data;
- appears as a built-in teammate in workspace roster, channel membership, mentions, and
  private chat;
- resolves what the user is referring to before deciding how to respond;
- decides one structured turn outcome: answer, clarify, direct workflow, workflow
  proposal, visible multi-reply, active-session follow-up, approval response, no-reply;
- chooses one or more specialist teammates when they improve the work;
- falls back to direct execution when no specialist is required or available;
- turns executable intent into an auditable proposal, task, or workflow;
- auto-accepts and starts clearly scoped safe local work when the user's message already
  grants task intent;
- keeps running process visible without making internals the default transcript;
- reports terminal results in user language;
- links evidence for audit.

## Coordinator Decision Contract

Ling Agent Coordinator is the only first-class channel turn entry point. "Ordinary chat"
is not an entry mode. It is the `answer` outcome after higher-priority session, target,
execution, approval, and clarification paths decline the turn.

Channel thread shape is not an execution boundary. A `ChannelMessage.threadId` only
identifies the discussion thread used for rendering, context lookup, and reply placement.
It may narrow ambient auto-reply and auto-start policy, but it must not prevent the
coordinator from evaluating active-session follow-ups, approval responses, target
resolution, clarification, or direct executable work.

```ts
type TurnDecision =
  | { kind: "answer"; responderHint?: string }
  | { kind: "clarify"; question: string; missing: readonly string[] }
  | { kind: "direct_workflow"; target: ResolvedTarget; requiredTools: readonly RunTool[] }
  | { kind: "workflow_proposal"; target?: ResolvedTarget; steps: readonly WorkflowStepDraft[] }
  | { kind: "visible_multi_reply"; teammateIds: readonly string[] }
  | { kind: "active_session_followup"; mode: "queue" | "interrupt"; targetRunId: string }
  | { kind: "approval_response"; approvalId: string; decision: "approve" | "deny" | "revise" }
  | { kind: "no_reply"; reason: "system_noise" | "duplicate" | "non_root" };
```

The names above are design roles, not required exported TypeScript names. The invariant is
that every user-visible response is derived from one coordinator decision. Lower-level
selector, router, workflow, run, approval, and evidence records may be created, but they
must not become competing top-level conversation concepts.

### TargetResolver

Target resolution runs before answer routing. It may resolve targets from:

- explicit current-turn text, such as `login.html`, `/Users/.../README.md`, a command, or
  a quoted file ref;
- uploaded or pasted assets in the TurnEnvelope;
- the latest active proposal, workflow step, run, pending approval, or queued
  intervention;
- recent same-session messages when the current turn is a follow-up such as "直接做好",
  "落到工作区", "按刚才那个改", or "帮我保存";
- recent workflow/proposal evidence when the user gives a filename-only follow-up such
  as "在 README.md 里加一句".

When the source turn is inside a channel thread, same-thread messages and the thread root
are searched before broader channel history. This keeps follow-ups such as "写到里面"
bound to the file target established in that discussion instead of drifting to unrelated
recent channel work.

TargetResolver must be conservative:

- one clear target -> pass it to IntentRouter with a source ref;
- multiple plausible targets -> `clarify`;
- no target and the request is execution-shaped -> `clarify`;
- no target and the request is informational -> `answer`;
- never infer broad workspace mutation from a vague acknowledgement.

### IntentRouter

IntentRouter consumes the resolved target, TurnEnvelope, active-session state, mentions,
and policy hints. It returns a `TurnDecision`; it does not execute tools. It may use
deterministic rules first and model-assisted classification behind strict JSON
validation, but model output cannot grant tools, approvals, secrets, provider access,
deploy authority, external-send authority, or memory authority.

`@Ling Agent`, `@Designer`, selected teammate chips, and `requestAiReply` are input
signals. They may influence `responderHint`, participant selection, or whether an
ordinary `answer` is expected. They must not short-circuit executable intent handling.

### Policy Gate

Policy Gate converts a work decision into one of:

- auto-start through the existing workflow/run path when scope is clear and required
  tools are not denied;
- confirmation card when scope is clear but user confirmation is required;
- inline runtime approval when the run reaches a side-effecting tool;
- blocked task explanation when provider, runner, workspace, or policy prevents work;
- clarification when target or acceptance is missing.

Policy Gate is the only layer that decides whether execution can start. IntentRouter can
say "this is work"; it cannot say "this write is approved."

The user should not need to understand:

- selector;
- auto-route;
- workflow graph;
- proposal internals;
- run id;
- workflow step id;
- approval request id;
- route decision ids.

Those names can remain in developer docs, logs, diagnostics, and evidence drawers.

## Turn Envelope

The first product object after persistence is a Ling Agent turn envelope. It is the
stable input to every downstream decision. Selectors, ordinary-answer routing,
workflow proposal generation, active-run guidance, and attachment handling consume this
same envelope; none of them decide whether Ling Agent receives the turn.

```ts
interface LingAgentTurnEnvelope {
  readonly sourceMessageId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachments: readonly LingTurnAttachmentRef[];
  readonly linkPreviews: readonly LingTurnLinkPreviewRef[];
  readonly fileRefs: readonly LingTurnWorkspaceFileRef[];
  readonly guidancePayload?: LingTurnGuidancePayload;
  readonly activeRunId?: string;
}

interface LingTurnAttachmentRef {
  readonly id: string;
  readonly fileName: string;
  readonly kind: "image" | "text" | "pdf" | "office" | "archive" | "other";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly previewStatus: "available" | "blocked" | "unsupported" | "not_loaded";
  readonly materializationStatus: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly previewText?: string;
}
```

## Layered Channel Context

The current turn envelope is necessary but not sufficient for ordinary conversation.
Ling Agent should answer from a bounded channel context pack, not a single latest-message
prompt and not an unbounded shared transcript.

The detailed source collection, filtering, log handling, per-agent views, and memory-use
isolation are defined in [Channel Context Processing Layer](channel-context-processing-layer.md).

Channel reply context layers:

1. **Current turn envelope:** current text, mentions, attachments, links, file refs, and
   materialized safe previews.
2. **Channel state:** channel name, bound workspace/path, response language, collaboration
   protocol, runtime policy summary, and the current teammate identity.
3. **Recent visible conversation:** a bounded same-channel transcript before the latest
   user turn.
4. **Compacted channel context:** durable channel summaries, source refs, decisions,
   handoffs, workflow packet summaries, and relevant artifact summaries.
5. **Active work context:** active proposal, workflow, run, approval, queued follow-up, or
   interrupt/redirect state when the latest turn is related to active work.
6. **Relevant memory:** scoped teammate/channel memory recall, never wholesale memory dump.

Recent visible conversation is evidence, not a new instruction. It exists so a short
follow-up can continue or revise the previous topic without forcing the user to repeat
themselves.

Examples:

- `300字的小说` followed by Ling Agent's story, then `400字` means rewrite or continue the
  same request at roughly 400 characters, not ask for a new topic.
- `继续` after an explanation continues the previous answer.
- `改短点` after a draft revises the draft.

The context pack must exclude the current pending assistant placeholder so model input
does not contain `Thinking...` or `AI teammate is preparing a reply...` as if it were
real conversation history. If the context budget is tight, optional layers are trimmed or
compacted before the current turn itself is dropped.

This boundary matches the behavior users expect from modern agent assistants: the visible
conversation feels continuous, while the runtime still uses a budgeted and privacy-aware
context pack instead of blindly replaying everything.

Rules:

- `body` can be empty when attachments, link previews, file refs, or guidance payload are
  present. Empty text is not an empty turn.
- Attachment ids are not enough for agent reasoning. The envelope must include safe
  metadata and, when available, bounded preview text or image/PDF/office extraction
  summaries.
- Ling Agent must not claim to inspect attachment bodies that were not materialized, but
  supported current-turn attachments should be materialized automatically before Ling
  answers.
- If an executable request depends on a supported attachment whose content is still
  pending, Ling should wait for bounded materialization or start with a safe
  materialization step. It should not ask the user to request inspection. Clarification is
  for unsupported, missing, blocked, or policy-sensitive inputs.
- Reading user-uploaded attachment previews for the current turn is input-context
  materialization. Writing files, running shell commands, Git push/merge, deploy,
  external sends, credentials, provider changes, and broad data mutations remain runtime
  approval concerns.
- Composer guidance during an active run must preserve the same envelope payload:
  `body`, attachments, links, file refs, and target run/session metadata.

## Input Materialization Boundary

Ling Agent may receive more than plain text, but every non-text input must declare what
was actually materialized before any selector, router, proposal, run, or ordinary answer
uses it.

Input statuses:

| Status | Meaning | Allowed behavior |
| --- | --- | --- |
| `available` | Safe bounded content was put in the envelope. | Ling may reason from the supplied preview or extraction text and cite it as available context. |
| `metadata_only` | Filename, URL, MIME type, size, title, or status is known, but body content was not loaded. | Ling may acknowledge the input exists, but must not summarize, copy, edit from, or claim to inspect its body. |
| `not_loaded` | The type can be materialized later, but no preview/extraction has run yet. | Ling should automatically schedule materialization and wait within a bounded deadline when the current answer depends on it. |
| `unsupported` | The current system has no reader for this type. | Ling should explain the limitation only when the current request depends on that content, then ask for a supported form or pasted content. |
| `blocked` | The input is missing, cross-channel, too large, policy-denied, or otherwise unsafe. | Ling should produce a visible blocked/clarify outcome with the concrete reason. |

Per-input contract:

| Input | Envelope may include before a run | Body/content read contract |
| --- | --- | --- |
| Text attachment | filename, type, size, bounded preview text when stored locally and under budget | Preview is current-turn context materialization. Large or unavailable text becomes `not_loaded` or `blocked`. |
| Image attachment | filename, type, size, bounded vision/OCR summary when configured | Supported current-turn images are automatically materialized. Without a summary, Ling may mention the image file but must not infer screenshot details. |
| PDF attachment | filename, type, size, page/count metadata when available, bounded extraction text | Supported current-turn PDFs are automatically materialized. Unsupported/encrypted PDFs clarify only when the request depends on body content. |
| Office attachment | filename, type, size, bounded extractor summary | Supported current-turn Office files are automatically materialized. Unsupported formats may request a supported export or pasted content. |
| Link preview | URL, title, description/status, cached preview/body summary when policy allows | Public unauthenticated page body extraction may run automatically behind URL policy; local/private/authenticated pages remain controlled tool work. |
| Workspace file ref | normalized path, workspace root relation, user-visible label, optional existence/type metadata | File body reads should happen through the managed run/tool path or an explicit safe inspection step, not through hidden pre-run prompt stuffing. |
| Active-run guidance | body, attachments, links, file refs, target run/session id | Queued guidance must render the same metadata/preview status later; it must not degrade to raw ids. |

Permission boundary:

- Current-turn upload preview and cached link-preview metadata are context preparation.
- Workspace file writes, edits, shell commands, Git operations, deploys, provider changes,
  credential handling, external sends, and broad data mutations remain runtime approval
  concerns.
- Reading arbitrary workspace files is not the same as reading a user-uploaded
  current-turn preview. If the file content affects executable work, use a managed
  inspection step or the existing run/tool path so evidence and policy remain attached.
- Auto-start eligibility must evaluate materialization first. A clear task can start only
  when missing content is irrelevant to the first safe step or every required input is
  `available`.
- User-facing copy should name files, links, and missing content directly. It should not
  expose selector, router, workflow, or raw id terminology in the ordinary transcript.

### Extraction Pipeline Product Model

Rich extraction is a materialization pipeline, not a new agent mode. Its job is to turn a
user-provided input into bounded, inspectable context that Ling Agent may cite.

Rules:

- Extraction must be source-scoped and auditable: every extracted summary points back to an
  attachment, link preview, or workspace file ref.
- Extraction should run automatically for safe, bounded, current-turn attachments that
  are already inside the workspace/channel trust boundary. Larger or policy-sensitive
  inputs require a visible inspection step or a blocked/clarify outcome.
- The extractor result must record the extractor id, source fingerprint, content kind,
  status, byte/token budget, truncation, and failure reason.
- Extraction never grants mutation rights. It may make context `available`; it cannot
  approve writes, shell commands, external sends, credentials, provider changes, Git, or
  deploys.
- Full remote link body extraction is network access. Public unauthenticated fetch may be
  allowed only through the link materialization policy; authenticated pages, forms,
  account-changing pages, localhost/private network targets, and external sends must use
  managed tools and approvals.

User-visible behavior:

- If extraction succeeds, Ling may say it read the extracted summary/text and use it in
  ordinary answers or executable proposals.
- If extraction is unavailable, Ling should name the missing input and ask for the next
  safe action instead of producing a generic refusal.
- If extraction is blocked by policy, Ling should show the concrete blocker and the first
  unblock path.

### Composer And Web Contract

Composer file chips are first-class turn inputs. They should not be encoded only as plain
text or inferred from prose.

Message creation should accept explicit `fileRefs` alongside `body`, `attachmentIds`, and
`linkPreviewIds`. A file ref should carry at least:

```ts
interface ChannelMessageFileRefInput {
  readonly path: string;
  readonly label?: string;
  readonly source?: "composer" | "explicit_text" | "api";
  readonly line?: number;
}
```

Rules:

- Implemented v1: `file_refs_json` is persisted on channel messages; Web composer path
  tokens send `fileRefs` with `source: "composer"`; Ling Agent envelope merges persisted
  file refs with legacy `file:`/`path:` text refs.
- Empty `body` plus `fileRefs`, attachments, links, or active-run guidance is a valid Ling
  Agent turn.
- The daemon normalizes file refs into `LingTurnWorkspaceFileRef` before selector/router
  helpers run.
- Web should render file chips on user messages, queued guidance previews, blocked
  proposals, and evidence drawers using the same name/status vocabulary.
- The default transcript should show user intent and Ling's result. Selector/router/raw
  materialization diagnostics stay behind evidence expansion.
- Browser/E2E tests should assert visible copy, chip presence, and hidden diagnostics; they
  should not depend on raw JSON decision shapes.

## Built-In System Teammate

Ling Agent is a first-class product participant, not a hidden fallback route.

Canonical identity:

```ts
const LING_AGENT_ID = "ling_agent";
```

Rules:

- Every workspace has exactly one Ling Agent system teammate.
- New channels include Ling Agent by default.
- Existing channels that predate the model should synthesize or migrate Ling Agent
  membership on read/write so the UI never shows a missing coordinator.
- Ling Agent cannot be deleted, disabled, archived, or removed from a channel.
- Ling Agent can be mentioned, can reply in channel, and can have a private conversation
  using the same teammate conversation surfaces as other AI teammates.
- Ling Agent has protected always-on coordinator memory and a dedicated Memory panel. Users
  can review or manage memory content, but cannot disable recall or grant new memory
  authority to Ling Agent.
- Ling Agent has protected default skill bindings for non-strict general-purpose planning,
  implementation, QA, documentation, browser-evidence, and context handoff workflows.
  These bindings make the built-in coordinator usable without requiring a specialist
  teammate for common tasks, but they do not grant tools or approvals by themselves.
  When a bound skill has a reviewed source snapshot, Ling Agent may use that source as
  bounded run context only after Effective Skill checks pass.
- Ling Agent coordinates AI Councils but is not a normal council member. A council can
  provide routing evidence, member rosters, workflow defaults, and governance ceilings,
  but Ling Agent remains the visible coordinator and council membership never grants
  tools, provider access, MCP access, credentials, deploy authority, or approval bypass.
- Ling Agent is the default visible responder for ordinary root channel messages unless
  the user explicitly mentions a specialist or asks for a visible multi-participant reply.
- `Channel.defaultTeammateId` must not point at Ling Agent for default-speaker semantics.
  It remains a legacy storage field for preferred specialist context until a future schema
  rename such as `preferredSpecialistId`.

### Editable Personalization

Users may personalize the presentation layer:

- display name;
- avatar image, initials, color, or accent;
- short user-facing description;
- user-added Ling Agent instructions.

These edits must not change the durable identity. Historical messages, mentions, workflow
assignments, approvals, evidence, and audit records continue to reference `ling_agent`
even if the user renames the visible label.

### Core Instructions And User Additions

Ling Agent has a built-in default instruction document maintained by the product. Users
must not directly edit or replace that core document. Instead, the product may expose an
append-only or editable user addition, for example:

```text
LING_AGENT.md              # built-in, product-owned, versioned
LING_AGENT.user.md         # user-owned additional preferences
```

Prompt assembly should treat these as layered inputs:

```text
system/product Ling Agent rules
-> workspace and project policy
-> user-added Ling Agent preferences
-> channel/private-chat context
-> current message or task
```

Conflict rule: product/system rules win. User-added instructions can express tone,
workflow preference, naming conventions, project norms, and recurring collaboration
preferences. They cannot grant tools, bypass approvals, change provider access, enable
credentials, remove audit requirements, edit the built-in system prompt, or change Ling
Agent's protected lifecycle.

## Default Channel Message Handling

Every root channel message should enter one Ling Agent coordinator path. The coordinator
may reuse selector and router modules internally, but their intermediate labels are not
user-facing product modes.

The required order is:

```text
persist user message
-> build LingAgentTurnEnvelope
-> active session handling
-> attachment/link/file-ref materialization or clarification when needed
-> executable/collaboration intent detection
-> auto-start or confirmation decision
-> ordinary Ling answer mode
-> no reply
```

`ChannelIntentDecision.action = "no_reply"` must not be treated as a terminal channel
message result. It means only "this message is not executable work or collaboration."
After that decision, Ling Agent still decides whether the message deserves an ordinary
reply. For example:

- "在 README.md 里添加一句测试语句" becomes proposal evidence and either an
  auto-started run or a confirmation card before chat routing.
- "晚上好" can receive a normal Ling reply when the channel reply mode allows it.
- "好的", "。。", and repeated greetings receive concise visible Ling replies instead of
  being suppressed by reply-worthiness heuristics.
- If Ling Agent cannot reply because no runnable provider is configured, the user should
  see a blocked Ling reply with the configuration reason, not a silent `no_reply`.

This keeps the product model simple: users talk to Ling Agent; Ling decides whether to
answer, clarify, prepare work, start a run, request approval, or stay silent.

The coordinator must never branch on "ordinary chat vs task" before it has the complete
turn envelope. Ordinary answer, task proposal, auto-start, visible multi-reply, active-run
guidance, and clarification are outcomes of the same Ling Agent session turn.

The old "auto reply" product layer is no longer a top-level decision layer. Ordinary
reply generation remains as an internal `answer` outcome owned by Ling Agent Session.
It must run only after active-session handling and executable intent handling decline the
message. It must not be allowed to catch executable requests and respond with "I cannot
execute"; those requests should become a clarification, an auto-started run, or a
confirmation card.

`Channel.defaultTeammateId` is not the visible default speaker under this model. It is a
preferred specialist hint for task assignment, workflow participation, and routing
evidence. Ordinary root channel messages and Ling clarification questions should render
from `ling_agent` unless the user explicitly mentions a specialist or asks for visible
multi-participant replies.

When a message does not produce a visible reply because it is empty, non-root, authored by
AI/system, already has an existing Ling reply, or hits a hard runtime blocker, the
ordinary feed must not show "not auto-replied" or "why no reply" badges. Those are
implementation diagnostics from the pre-session auto-reply model. The default feed should
show only user messages, Ling replies, task confirmations, active work, approvals, final
reports, and real blocked/error states. It must not attach route or intent explanations
such as "not auto-replied", "why no reply", "direct workflow proposal", or "why this
handling" under ordinary messages.

Route and intent decisions may still be stored for audit and debugging, but suppressed
routes, direct-workflow classifications, and other selector/router outputs are not
user-facing conversation artifacts.

## Non-Goals

- Do not remove workflow, run, approval, thread, evidence, or route-decision primitives.
- Do not bypass the existing runner path. Ling Agent work still runs through
  `RunnerRegistry`, Pi by default, and the normal run lifecycle.
- Do not add a second approval system.
- Do not let Ling Agent self-grant tools, write scopes, MCP access, credentials, deploy
  authority, external-send authority, provider access, or memory authority beyond the
  protected always-on defaults.
- Do not treat Ling Agent's protected default skill bindings as a bypass around allowed
  tools, provider capabilities, channel policy, approval policy, or run state machines.
- Do not let raw skill source snapshots bypass Ling Agent's turn envelope, confirmation
  decisions, or approval policy.
- Do not let user personalization override Ling Agent's protected identity, lifecycle,
  core system instructions, approval policy, or audit requirements.
- Do not inject follow-up prompts into an active Pi `session.prompt(...)`.
- Do not make multi-agent collaboration a shared long-context group chat.
- Do not force users to create custom specialist teammates before Ling can execute common
  file, code, command, or documentation tasks.
- Do not expose raw selector confidence, JSON, prompt text, scoring, or route internals in
  the default channel feed.

## Architecture Layers

Ling Agent is an ownership layer above existing execution primitives.

```text
Ling Agent Session
  product control plane:
  intent, context continuity, worker selection, progress narrative, final report

Workflow
  orchestration layer:
  steps, dependencies, handoffs, gates, fan-out, fan-in

Run
  execution layer:
  one runner attempt against one scoped objective

Approval
  permission layer:
  task confirmation, runtime permission requests, tool approvals, external action gates

Evidence and Audit
  durable trace:
  events, actions, artifacts, decisions, diagnostics, packets, summaries
```

The important boundary:

```text
Ling Agent decides what should happen next.
Workflow/run execute only through existing state machines.
Approval decides whether side effects may happen.
Evidence records what happened.
```

## Session Ownership

A Ling Agent session is the active product owner for a conversation lane. In v1, the
session can be derived from existing channel, thread, workflow, and run records. A later
slice may persist first-class `ling_agent_sessions` rows if derived state becomes too
fragile.

Suggested durable shape if first-class storage is needed:

```ts
type LingAgentSessionStatus =
  | "open"
  | "shaping"
  | "ready_for_confirmation"
  | "running"
  | "waiting_for_approval"
  | "reporting"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "archived";

interface LingAgentSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly objective: string;
  readonly status: LingAgentSessionStatus;
  readonly owner: "ling_agent";
  readonly activeWorkflowId?: string;
  readonly activeRunId?: string;
  readonly activeApprovalIds: readonly string[];
  readonly lastUserMessageId?: string;
  readonly lastResultSummary?: string;
  readonly evidenceBundleId?: string;
  readonly responseLanguage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules:

- Ling Agent is always present for the session.
- Ling Agent is always present in channel membership and available for private chat.
- A session may delegate to specialists, but delegation does not transfer authority to
  bypass workflow/run/approval.
- At most one active execution should own the primary session lane unless a workflow graph
  explicitly allows parallel branches.
- Session status is derived from active workflow/run/approval state, not browser state.
- The final result report belongs to the session, even when the underlying work was done
  by a specialist step.

## Session State Machine

```text
open
  -> shaping
  -> ready_for_confirmation
  -> running
  -> waiting_for_approval
  -> running
  -> reporting
  -> succeeded

running
  -> blocked | failed | cancelled

running
  -> continuation_requested
  -> running | cancelled -> running
```

State meanings:

| State | Meaning | User-facing surface |
| --- | --- | --- |
| `open` | Session has no active task. | Normal composer. |
| `shaping` | Ling Agent is clarifying or planning. | One concise question or plan card. |
| `ready_for_confirmation` | Executable task/workflow is prepared but not safe or complete enough to auto-start. | Confirmation card with required permissions. |
| `running` | Workflow/run is active. | Mutable process row, progress popover, optional detail drawer. |
| `waiting_for_approval` | Existing approval system is blocking execution. | Inline approval strip near active context. |
| `reporting` | Work reached terminal state and Ling Agent is producing final summary. | Short "preparing result" state if needed. |
| `succeeded` | Final result report is ready. | Collapsed result cell plus optional evidence. |
| `blocked` | Work cannot proceed without user or environment change. | Blocker report and next action. |
| `failed` | Work failed after execution. | Failure report with evidence and retry action. |
| `cancelled` | User or system cancelled the active work. | Cancelled summary and continuation options. |

The `reporting` state is important. It prevents a terminal workflow from leaving only raw
process UI. Ling Agent should produce a user-facing final result, then the process rows
collapse under evidence.

## Intent Handling

Ling Agent Coordinator is the public entry point. The existing selector and auto-route
logic become internal helper modules. "Auto reply" is not a sibling path next to
workflow/proposal/run; it is only the ordinary-answer outcome after the coordinator has
ruled out active work, executable intent, approval handling, and clarification.

```text
persist user message
-> attach message to Ling Agent session
-> if active work exists, classify as approval response, queued follow-up, or redirect
-> otherwise classify as ordinary chat, executable work, or collaboration request
-> for executable work, create an auditable proposal record
-> auto-accept/start when the task is clear and policy allows auto-start
-> call internal modules as needed:
   - ordinary reply router
   - executable intent detector
   - workflow proposal builder
   - workflow selector
   - specialist selector
-> render one product outcome
```

User-visible outcomes:

- ordinary answer from Ling Agent;
- one clarifying question from Ling Agent;
- auto-started executable task with progress;
- executable task confirmation card when scope, executor, or policy requires it;
- multi-step collaboration proposal;
- queued follow-up confirmation;
- stop-and-redirect confirmation;
- inline permission request;
- final result report.

Coordinator decision order is a product contract, not an implementation suggestion:

```text
1. active session intake
   - approval response
   - status question
   - queued follow-up
   - stop-and-redirect
2. executable or collaboration intent detection
3. auto-start eligibility for clear local work
4. pre-execution confirmation for incomplete or policy-gated work
5. one clarifying question for incomplete executable work
6. ordinary answer mode
7. no reply only for system-noise cases
```

Executable or collaboration intent must never fall through into ordinary answer mode
with a "cannot execute" reply. If Ling Agent cannot start safely, it must produce one of
these visible outcomes: clarification, confirmation card, blocked task explanation, or
policy error.

Internal outcomes:

- `single_reply`;
- `visible_multi_reply`;
- `workflow_proposal`;
- `direct_workflow`;
- `SelectorDecision`;
- `ChannelMessageRouteDecision`;
- `ExecutionAction`;
- `ApprovalRequest`;
- `RunIntervention`.

Internal outcomes are audit data. They are not the user mental model.

## Worker Selection And Fallback

Ling Agent can use three execution patterns.

### 1. Ling Agent Direct Execution

Use when:

- the task is single-step or can be safely scoped by Ling Agent;
- no specialist teammate is configured;
- specialists would add overhead without changing the outcome;
- the user explicitly asks Ling to handle it.

Examples:

- create or edit a README;
- run a known test command;
- inspect a local file and summarize;
- update a small doc section;
- apply a narrow code fix when no specialist policy is needed.

### 2. Specialist Delegation

Use when:

- the channel has a relevant specialist with a runnable provider;
- the task clearly maps to a role such as Docs, Engineer, QA, Security, Release, or
  Designer;
- a specialist has different tools, prompt, skill, or approval profile that changes the
  work boundary.

Delegation creates workflow steps or scoped runs. The specialist does not own approval
authority.

### 3. Multi-Agent Workflow

Use when:

- the user asks for ordered collaboration;
- planning, implementation, QA, review, and release are separate phases;
- fan-out/fan-in or handoffs are useful;
- the work is risky enough that role separation improves quality.

If a requested specialist is missing, Ling Agent may show:

```text
No dedicated Engineer teammate is configured for this channel. Ling Agent can handle this
task with the current workspace permissions, or you can add an Engineer teammate for
future runs.
```

This is a recommendation, not a blocker, unless policy requires that role.

## Permission And Approval Boundary

Permissions are not approved all at session start. Ling uses three related but distinct
moments:

### 1. Intent Acceptance And Auto-Start

When the user clearly asks Ling to do bounded local work, Ling may create an internal
proposal and immediately mark it accepted, then start the task/run:

```text
user: "在 README.md 里加一句测试说明"
-> Ling creates proposal evidence with requiredTools=["edit"]
-> proposal is auto-accepted because the target and action are clear
-> task/run starts
-> runtime edit approval follows the workspace policy
```

Auto-start is allowed only when all are true:

- the message is authored by the local user in the active root session;
- the requested work is clearly scoped enough to create a bounded task/run;
- the target is known or can be resolved by the run through normal inspection, or the
  first run step is explicitly to inspect and resolve it;
- the selected executor has a runnable provider and compatible tool boundary;
- the required tools are not denied by workspace approval policy;
- starting the run does not itself grant broad future permissions.

Auto-start is forbidden when:

- the target, content, acceptance, or command is missing and cannot be safely inferred;
- the request is a question about whether Ling can execute instead of a task request;
- the selected executor or provider is unavailable;
- any required tool is `deny` under workspace approval policy;
- policy requires explicit human review before creating a run.

If the task is incomplete, Ling asks one clarifying question. If the task is executable
but runtime side effects are risky, Ling should still start the run when policy permits;
the first side-effecting tool call is then governed by runtime approval.

Auto-start classification should be explicit and deterministic before any model wording
is generated:

| Request class | Default outcome | Notes |
| --- | --- | --- |
| Create or edit a named local file | Auto-start | Runtime `write` or `edit` approval may still pause the run. |
| Update a small known docs/code section | Auto-start | Allowed when target and acceptance are clear from the message or same-session context. |
| Run a narrow local check command | Auto-start | Runtime `bash` approval still follows policy. |
| Inspect/read/summarize local project state | Auto-start or ordinary answer | Auto-start when it needs tool execution; ordinary answer only when no tool work is needed. |
| Delete, move broad data, clean directories | Auto-start when policy permits; runtime-gated | If `bash/edit/write=ask`, pause at the tool call with target/blast radius. If denied, block. |
| Git push, merge, release, deploy, publish | Auto-start when policy permits; runtime-gated | If `bash=ask`, start inspection/preflight and pause before mutation. If `bash=allow`, it may proceed. |
| Credentials, provider settings, approval policy, memory authority | Auto-start only when represented through an allowed run tool; otherwise block or settings flow | Product settings changes are not silently granted by Ling Agent. |
| External send, paid action, account mutation | Auto-start only when a runtime approval/tool policy can gate it | Otherwise block or show confirmation. |
| Missing target/content/acceptance | Clarification | Ask one concrete question; do not create a generic answer. |

### 2. Pre-Execution Confirmation

When auto-start is not allowed but the work is otherwise executable, Ling Agent should
show the bounded task scope:

```text
Need write permission to create /path/README.md for this task.
Start task?
```

This confirms intent and starts the existing workflow/run path. It does not grant broad
workspace permission. A confirmation card is a start gate, not the primary execution
model for every task.

The confirmation card should include:

- action summary;
- target path, command, MCP tool, or external target;
- derived required tools such as `write`, `edit`, `bash`, or `mcp_tool_call`;
- selected executor, usually Ling Agent or a specialist;
- policy note if runtime approval may still be required.

### 3. Runtime Approval Requests

When a running tool call or permission escalation needs approval, the existing approval
system creates a durable request:

```text
runner proposes edit/write/bash/MCP/external action
-> daemon creates ApprovalRequest / ExecutionAction
-> run waits when policy requires ask
-> inline approval appears near active session
-> user approves or denies
-> run resumes, blocks, or continues through a linked continuation
```

Rules:

- Ling Agent cannot approve its own requests.
- Runtime approval does not mutate workspace approval policy.
- Grants are scoped to the run or continuation.
- Auto-started tasks still obey the same runtime approval policy; `ask` means pause and
  ask before the side effect.
- External sends, deploys, credentials, provider changes, paid media actions, and broad
  filesystem changes remain explicit approvals.
- Review Queue and Work Board remain separate external/background work surfaces. Inline
  runtime approval is for the active local run.

## Continuation Rules

User messages during active work must be explicit session events, not hidden prompt
injection.

When active work is running:

- short status questions can get an ordinary Ling Agent status answer from durable state;
- additive guidance becomes a queued follow-up;
- direction-changing guidance becomes stop-and-redirect;
- approval responses resolve approval requests through the existing approval endpoint;
- unrelated chat can stay ordinary chat without mutating the active run.

Allowed flows:

```text
active run + user says "also update the docs"
-> create queued follow-up
-> active run finishes
-> continuation run starts with explicit lineage
```

```text
active run + user says "stop, use the daemon API instead"
-> create interrupt request
-> cancel source run
-> preserve partial output and evidence
-> start continuation run with source lineage
```

Forbidden flows:

- appending the new text into the active Pi prompt;
- silently merging interjection text into current run context;
- letting stale runner completion overwrite cancelled/interrupted state;
- granting new tools because the interjection asked for them.

## UI Visibility Model

Default channel feed:

- user messages;
- Ling Agent ordinary replies;
- explicitly mentioned or explicitly requested multi-participant teammate replies;
- confirmation cards;
- one active mutable process cell;
- inline approval prompt when relevant;
- final result report.

Hidden by default but expandable:

- selector decisions;
- auto-route decisions;
- workflow graph internals;
- step packets;
- raw run events;
- tool logs;
- approval payload JSON;
- artifacts and diagnostics.

Terminal behavior:

```text
active process cell
-> terminal run/workflow
-> Ling Agent final result report
-> collapse process detail under evidence
```

Final reports should include:

- what changed or was produced;
- files, artifacts, commands, or checks when relevant;
- whether approvals were used or denied;
- blockers or follow-up actions;
- a link to evidence.

They should not include raw internal ids unless the user expands evidence.

## Migration From Selector And Auto-Route

No existing primitive needs to be deleted.

| Current concept | New role under Ling Agent Session |
| --- | --- |
| Channel auto reply router | Internal ordinary-chat router used by Ling Agent. |
| Channel intent selector | Internal executable/collaboration detector used by Ling Agent. |
| Workflow selector | Internal workflow-step coordinator. |
| Workflow proposal | Confirmation card implementation detail. |
| Run | Execution attempt implementation detail. |
| Approval request | Permission gate implementation detail with inline active surface. |
| Thread / Work History | Durable lineage and evidence surface. |

Routing priority should become:

```text
Ling Agent Coordinator
  -> active-session continuation / approval response handling
  -> executable intent handling
  -> auto-start eligibility
  -> confirmation or clarification
  -> workflow/collaboration proposal handling when multi-step work is required
  -> ordinary chat routing
  -> no-reply suppression
```

This prevents an executable request from being answered by Docs with shell instructions
before Ling has a chance to create proposal evidence, auto-start safe work, or show the
right confirmation/clarification surface.

## Implementation Slices

Detailed implementation slices are tracked in
[Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md).

### P0: Documentation And Boundary Alignment

- Add this design as the product-level owner.
- Mark selector and auto-route docs as internal module docs.
- Keep current workflow/run/approval docs as lower layers.

### P1: Session Projection

- Build a `LingAgentSessionView` from existing channel proposals, workflows, runs,
  approvals, and thread evidence.

### P2: Coordinator Entry Order And Active-Session Intake

- Route all non-mention channel messages through Ling Agent Coordinator first.
- Let coordinator call the intent selector and auto-route router internally.
- Ensure executable intent wins over ordinary chat routing.
- Keep route/selector evidence available only in diagnostics/evidence.

- Add composer choices for queued follow-up vs stop-and-redirect when a session is active.
- Persist interventions through the existing run-intervention design.

### P3: Terminal Final Report

- Add a terminal `finalResult` projection for completed workflow/run cells.
- Collapse terminal process rows by default after final report generation.
- Show continuation lineage in evidence and final reports.

### P4: Permission Prompt Integration

- Make pre-execution confirmation copy permission-oriented.
- Render active local approvals through the inline runtime approval surface.
- Keep external/background approvals in Review Queue or Work Board.
- Preserve the existing approval policy; task confirmation does not grant broad future
  runtime actions.

### P4A: Auto-Start Policy

- For explicit executable work, create durable proposal evidence and start the existing
  workflow/run path automatically when the required tools are not denied.
- Show clarification instead for ambiguous work; show confirmation/blocking only when
  executor/provider/scope is unavailable, required tools are denied, or a product policy
  requires human review before run creation.
- Keep runtime approval unchanged: `ask` still pauses before `write`, `edit`, `bash`,
  MCP, Git push/merge through `bash`, deploy/release commands, or other side effects.
- Hide the proposal card after successful auto-start; show the active process cell,
  inline approval if needed, and final report when terminal.

### P5: Built-In Ling Agent Executor And Specialist Recommendation

- Add Ling Agent as a built-in system teammate executor when no specialist is required or
  no configured specialist can run the bounded task.
- If a specialist is missing, show a recommendation but do not block safe work.
- Preserve specialist delegation when configured and useful.

### P6: First-Class Session Storage If Needed

- Add `ling_agent_sessions` only if derived projections cannot reliably support active
  state, terminal reporting, and continuation.
- Until then, avoid adding storage that duplicates workflow/run/thread authority.

### P7: System Teammate Profile And Personalization

- Add a protected Ling Agent teammate profile with fixed `id = "ling_agent"`.
- Ensure every channel includes Ling Agent by default and blocks removal.
- Reuse teammate private-chat surfaces for Ling Agent.
- Allow display-name, avatar, accent, and short-description personalization.
- Add a user-owned Ling Agent additional-instructions document layered after product rules.
- Keep core instructions, lifecycle, provider access, approval policy, and audit behavior
  non-overridable by personalization.

### P8: Always-On Teammate Memory And Ling Agent Memory Panel

- Provision private memory scopes for every AI teammate by default.
- Provision channel memory scopes automatically when a teammate joins a channel.
- Keep memory availability always on; expose review and content management, not disable
  toggles.
- Show Ling Agent's protected coordinator memory in the same teammate Memory surface while
  blocking self-authorization or removal of protected defaults.

## Acceptance Criteria

- A clear request to create or edit a local file creates durable proposal evidence and
  auto-starts the existing workflow/run path when required tools are not denied; runtime
  approval still pauses before `write` or `edit` when policy is `ask`.
- A high-risk explicit request creates proposal evidence and starts when required tools
  are not denied; runtime approval still gates the first side effect. Ambiguous work asks
  one clarifying question instead of producing a Docs shell snippet.
- A filename-only follow-up can resolve against recent same-session work context before
  ordinary chat routing.
- A short ordinary follow-up can resolve against the layered channel context pack before
  Ling Agent asks for a missing topic or treats it as a new request.
- Missing Engineer, Docs, QA, or Release teammates do not block safe work that Ling Agent
  can execute through current policy.
- New channels include Ling Agent as a protected built-in teammate.
- Ling Agent can be opened as a private chat participant.
- Ling Agent has a visible protected Memory panel.
- Every AI teammate has default private memory scopes, and channel membership adds
  channel-scoped teammate memory.
- UI does not expose memory disable/off controls for AI teammates.
- Users can personalize Ling Agent display name/avatar and user-added instructions without
  changing `ling_agent` identity, lifecycle, approval policy, or core instructions.
- Pre-execution confirmation scopes the task but does not approve all future actions.
- Runtime tool requests still create durable approval records and use inline approval for
  active local runs.
- User interjections during active work become queued follow-up or interrupt-and-redirect
  records, not hidden prompt injection.
- Completed work produces a final Ling Agent result report.
- Completed process UI collapses by default, with evidence expandable.
- Selector, route, workflow, run, and approval internals do not appear as the default user
  mental model.
- Existing workflow/run/approval tests remain the compatibility boundary.

## Open Decisions

Unresolved product boundary decisions: none. Ling Agent Session is the user-facing owner;
workflow, run, approval, and evidence stay as lower-level primitives.

Implementation decisions to settle per slice:

- whether `LingAgentSessionView` can remain a derived read model or needs first-class
  `ling_agent_sessions` storage;
- where final report generation lives: daemon projection, runner terminal summary, or Web
  presentation layer backed by evidence;
- whether Ling Agent system teammate profile is stored as a durable row, a virtual row, or
  a migrated built-in row;
- where user-added `LING_AGENT.user.md` instructions are stored and versioned;
- which exact UI copy distinguishes task confirmation from runtime approval without
  making users learn the approval system.
