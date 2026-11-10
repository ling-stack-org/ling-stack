# Conversation Shared Capabilities

Status: implemented baseline; transcript rendering superseded by v3.7
Date: 2026-07-13
Scope: normal conversation, channel root, channel branch, topic reply, teammate private
chat, shared conversation components, rich content rendering, and latest-user-message edit

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Shared Capabilities Detailed Design](conversation-shared-capabilities-detailed-design.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md)

> v3.7 authority note: this document records the shared capability baseline and product
> policy. Typed transcript item kinds, evidence ownership, renderer selection, batching and
> completion are defined by [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
> and [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md).
> WorkCell references here are migration inputs; v3.7 production rendering uses the single
> `ConversationTimeline` registry.

> **Implementation boundary:** this document is still the authority for content capabilities,
> composer behavior and surface policy, but not for transcript geometry. New work must not
> add a `ConversationWorkCell`/`MessageRow` activity renderer, a second summary row, or a
> route-local Markdown parser. Those concerns are implemented by the v3.7 Timeline registry
> and its document/fact/nested lanes. Existing WorkCell view models may be read by a strict
> migration adapter until the surface cutover removes their production callers.

## Purpose

Ling Stack has a shared conversation system: shared message
rows, action bars, composer primitives, work cells, terminal reports, topic replies,
thread forks, and queued run guidance. Follow-up work must extend that system without
creating a second channel UI, a separate private-chat renderer, or a Codex-shaped
parallel runtime.

This design locks four decisions:

1. Channel, normal conversation, and teammate private chat use one Conversation UI Kit.
2. Shared rendering capabilities include structured Markdown, Mermaid, math, references,
   code, diffs, and artifact previews.
3. Teammate private chat is execution-capable when the selected teammate, workspace,
   tools, skills, MCP, provider, and approval policy permit execution.
4. Editing the latest user message rolls back the latest logical turn and starts again in
   the same thread and current workspace. Existing workspace side effects are retained.

The design is deliberately narrower than a general rich-chat platform. It does not add
arbitrary HTML, arbitrary embeds, a second side-chat product, a second queue system, or a
new branch model.

## Confirmed Existing Capabilities

The following are existing Ling capabilities and must be reused rather than rebuilt:

| Capability | Existing authority | Decision |
| --- | --- | --- |
| Queued guidance during active work | run intervention `queue_followup` | Keep; do not add a second next-turn queue |
| Stop and redirect | `interrupt_redirect` with confirmation | Keep; do not silently inject redirects |
| Channel work branches | `LingThread` parent/turn/run lineage | Reuse for explicit branch actions |
| Topic replies | channel message thread attached to a source message | Reuse for channel follow-up discussion |
| Work process display | canonical typed items + `ConversationTimeline` registry | Replace WorkCell/activity DOM callers; keep strict adapters only until cutover |
| Final result | durable structured `TerminalReport` projected as one `terminalReport` item | Render once inside the Timeline; surface policy controls participant detail |
| Artifact and diff inspection | shared preview and diff primitives | Extend rather than replace |

The implementation must not introduce:

- a new Codex-style side chat while topic replies cover the accepted channel use case;
- a second follow-up queue beside run guidance;
- a second branch table beside `LingThread` lineage;
- assistant-copy parsing to infer tools, participants, changes, or final state.

`conversation_items` is the target canonical transcript spine for every surface. Existing
`channel_messages` and teammate-direct/normal message stores may remain temporarily as
one-way persistence adapters or lookup indexes while E4 migrates write/read paths, but they
must not independently determine order, context, renderer choice or completion. This is a
storage cutover boundary, not an old-client renderer compatibility layer: production DOM has
one typed Timeline throughout the migration.

### Active-Run Follow-Ups

Normal conversation reuses the existing `queue_followup` run intervention when the user
sends another message during active work. The accepted follow-up is projected immediately
as an ordinary local-user message with stable id
`conversation-user:intervention:<interventionId>`; normal conversation does not add a
second visible guidance queue. When continuation starts, the durable turn reuses the same
message id and remains in the original conversation thread, so refresh cannot duplicate
or lose the message.

Normal conversation detail includes approvals and run interventions associated with its
runs. Teammate-private runtime includes approvals associated with linked private runs.
The E4 migration adapters consume these snapshots and emit typed approval/fact items; they
must not mount a second WorkCell or pass an empty approval array to the Timeline.
Approval, artifact, tool and intervention events trigger event-driven detail refresh;
there is no idle conversation polling.

Structured workspace file references travel with normal stream and transcript messages.
They remain references only and never expand tools, workspace access or approval policy.

### Desktop Local File Viewing

Desktop conversation prose links have a separate, user-activated viewing path shared
by normal conversation, channel and teammate private chat. Clicking a local path opens
the existing Right Dock. Markdown link labels are preserved, and the complete path
remains available in the tooltip.

- UTF-8 text/code uses the existing code viewer with line numbers and optional line focus.
  The text preview is capped at 256 KiB; the dock displays a bounded window of 300 lines.
- Raster images up to 10 MiB use the image viewer. Directories show up to 500 entries,
  with explicit navigation to a child or the parent folder.
- Archives, PDF/Office files and other unsupported/binary content show an explanatory
  placeholder with an **Open with** action.
- Right-clicking a link or directory entry opens the native menu: preview in Ling,
  default application, Open with, Save as (files only), Copy path, Copy file contents
  (complete text previews only), and reveal in the file manager. macOS lists actual
  Launch Services associations; Windows uses the system application chooser, and
  Linux provides an executable picker.

The typed `lingDesktop.localFiles` bridge consumes a matching, one-use trusted click
or context-menu gesture. Main validates the current packaged main frame before reads
and actions. Local viewing rejects network shares and special files and does not add
file contents to AI context, expand tool permissions, or issue daemon capabilities.
Browser prose paths remain display-only; typed transcript file capabilities retain
their existing scope and authority checks.

Verification: `apps/desktop/tests/local-files.test.mjs` covers host reading and activation
boundaries; `apps/desktop/tests/run-local-file-smoke.mjs` exercises the actual sandboxed
preload and native menu without launching an external application. Web fixture coverage
is in `apps/web/e2e/local-file-preview.spec.ts`. Windows/Linux chooser behavior requires
platform acceptance; the native smoke is verified on macOS.

## Product Model

The shared system has three independent contracts:

```text
Content Protocol
  -> text, Markdown, code, diff, Mermaid, math, references, artifacts

Interaction Protocol
  -> copy, feedback, edit latest, topic reply, explicit fork, open artifact

Execution Protocol
  -> tools, approvals, typed evidence, queued guidance, terminalReport result
```

The contracts are shared, but each surface enables a different policy projection.

## Unified Component Boundary

The target Conversation UI Kit is:

```text
ConversationSurface
  ConversationShell
    ConversationFeed / ConversationVirtualFeed
      ConversationTimeline
        DocumentRenderer (Markdown / code / path)
        FactRenderer (command / file / tool / approval)
        ResultRenderer (execute terminalReport)
        BatchRenderer (display-only disclosure)
        SubAgentRenderer (depth=1, same registry)
        EvidenceDisclosure
        MessageActionBar
    ConversationComposer
    RightDock
```

Shared components own rendering, layout, accessibility, hover/focus behavior, stable
dimensions, and state vocabulary. Surface adapters own daemon calls, identity scope,
runtime routing, provider resolution, and permission decisions.

No shared component may infer product policy from route names, visible copy, or the
presence of a `threadId`. It receives an explicit surface policy and structured view
model.

## Surface Capability Matrix

| Capability | Channel root/branch | Normal conversation | Teammate private chat | Topic reply |
| --- | --- | --- | --- | --- |
| Shared message/feed/composer | Required | Required | Required | Shared message/feed subset |
| User avatar | Yes | No | Yes | Yes |
| Agent avatar | Actual participating teammates | No | Selected teammate | Source/reply author |
| Multi-agent participation | Yes | No | No | No by default |
| Teammate `@` routing | Yes | No | No | Explicit AI mention only |
| Tool execution | Yes | Yes | Yes | No by default; promote to execution when explicit |
| Work cell | Full conversation mode | Compact | Compact/private | Only when promoted |
| TerminalReport participants | Show actual participants | Hide | Hide | Hide by default |
| Topic reply action | Yes | No | No | Nested reply only |
| Thread fork | Yes | Normal thread fork | Private thread fork only when introduced | No |
| Edit latest user message | Yes | Yes | Yes | Yes for latest own reply |
| Rich Markdown/Mermaid/math | Yes | Yes | Yes | Yes |

Shared capability does not mean identical chrome. Normal conversation intentionally omits
avatars and redundant identity labels. Teammate private chat shows the selected teammate
avatar. Channel is the only default multi-agent collaboration surface.

## Shared Content Capabilities

`MessageBodyRenderer` becomes the single content gateway for:

- paragraphs and line breaks;
- headings;
- ordered and unordered lists;
- task lists;
- block quotes;
- thematic breaks;
- tables;
- inline and fenced code;
- diff blocks;
- Mermaid diagrams;
- inline and display math;
- web links;
- workspace file references;
- memory, PR, commit, issue, and artifact references when backed by structured data.

Raw HTML is not supported. The renderer must not execute arbitrary scripts, render
untrusted iframes, or convert assistant prose into executable controls.

### Mermaid Product Behavior

- A fenced `mermaid` block renders as a diagram after the message block is complete.
- Streaming or incomplete Mermaid remains source text until it is safe to parse.
- The diagram is inline and quiet; it does not introduce a chat bubble inside a message.
- Hover/focus reveals copy-source and expand actions.
- Expanded view supports responsive scrolling and large-diagram inspection.
- Parse failure falls back to the source block without breaking the message.
- Theme changes rerender with shared semantic tokens.
- Size, node, render-time, and security limits are enforced.

### Structured References

User-visible references are concise evidence anchors, not raw internal evidence dumps.
Supported reference kinds include:

- workspace file and line;
- document section;
- web source;
- PR, commit, and issue;
- memory object when the surface policy permits disclosure;
- generated artifact.

The default row shows a compact label or source icon. Hover/focus may preview; click opens
the owning file, source, artifact, or Right Dock page.

## Teammate Private Execution

Private chat is not discussion-only. A private request may execute tools when execution
is allowed by the selected teammate and current direct workspace.

The effective private run configuration is resolved from:

```text
selected teammate
  -> provider/model
  -> runner
  -> enabled/effective skills
  -> MCP authorization
  -> teammate allowedTools
  -> direct workspace binding
  -> composer authorization snapshot
  -> approval policy
```

Persona and skill text may shape the prompt but cannot grant execution authority.

Private execution remains single-agent. Its typed Timeline can show read, edit, shell,
search, approval, check and artifact facts; an execute `terminalReport` does not render a
Participants section. The legacy WorkCell is only a migration adapter and never a second
production renderer.

## Latest User Message Edit

Only the latest local-user message in the active surface lane is editable. The action is
available through the shared hover/focus `MessageActionBar`.

Confirmed behavior:

```text
Edit latest prompt
  -> stop the old active turn when necessary
  -> supersede the latest logical turn and its default projection
  -> retain workspace file and command side effects
  -> replace the visible prompt with the new revision
  -> start a new turn in the same thread / channel branch / private thread
```

The edit does not create a new channel branch and does not switch workspaces.

If the old turn produced write-capable operations, the inline editor shows quiet copy:

```text
This turn changed the workspace. The edited prompt will continue from the current state.
```

There is no blocking confirmation and no automatic file revert.

User-visible behavior resembles replacing the final turn. Durable behavior is safer:

- old prompt revisions remain auditable;
- old assistant rows, operation cells, approvals, and terminal reports remain linked to
  the superseded turn;
- the default transcript hides superseded projection rows;
- developer/audit detail can inspect the prior revision and execution evidence;
- memory generation and follow-up queues do not treat the superseded turn as current.

## Shared Message Actions

The action set is policy-filtered:

| Actor / row | Shared actions |
| --- | --- |
| Latest local-user message | copy, edit; topic reply or fork when surface policy allows |
| Historical local-user message | copy; topic reply or fork when surface policy allows |
| Assistant/teammate message | copy, feedback, open references/artifacts |
| Terminal result | copy summary, open artifacts, explicit follow-up/fork where supported |
| Operation/evidence row | expand/collapse, copy structured detail, open owning artifact/run |

Actions stay hidden until hover/focus unless state-critical. Icon-only actions require a
tooltip, accessible label, and keyboard access.

## Visual Rules

- User messages may use the accepted compact user bubble; assistant and operation content
  remain unbubbled unless the existing shared component requires a framed code/diff tool.
- Rich blocks do not nest decorative cards.
- Mermaid, code, diff, and artifact frames use stable responsive dimensions.
- Structured action icons inherit the adjacent text color and share the same hover/focus
  transition.
- Long titles and summaries wrap; they do not ellipsize required content.
- Rich content must not change the global conversation width.
- Expanded previews appear above or in the Right Dock when bottom placement would cover
  the latest conversation content.

## Non-Goals

- Arbitrary HTML rendering.
- Arbitrary iframe or web-app embeds inside messages.
- Editing arbitrary historical messages in the first implementation.
- Automatically reverting files, database changes, installs, or shell side effects.
- Adding multi-agent participation to normal conversation or teammate private chat.
- Rendering `TerminalReport.participants` outside channel collaboration surfaces.
- Replacing topic replies with a separate side-chat product.
- Replacing queued guidance with live `turn/steer` in this slice.

## Acceptance Summary

The design is implemented when:

- channel, normal conversation, and private chat render through the same document, fact,
  result, batch, nested and composer primitives;
- private chat can perform a real read/edit/shell/check flow under teammate policy;
- normal and private TerminalReports omit Participants;
- fenced Mermaid renders safely and falls back cleanly on invalid source;
- headings, tables, quotes, task lists, and math render consistently across surfaces;
- the latest user message can be edited and rerun in the same thread and current
  workspace;
- superseded work remains auditable but is hidden from the default transcript;
- existing channel branches, topic replies, and queued guidance continue to work without
  parallel replacements.

## Decision Status

No product decision remains open for the first implementation plan.

Deferred beyond this design:

- editing non-latest historical messages;
- live in-flight steer instead of queued continuation;
- mandatory screenshot regression in CI;
- arbitrary embedded interactive applications inside Markdown.
