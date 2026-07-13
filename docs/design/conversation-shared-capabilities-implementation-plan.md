# Conversation Shared Capabilities Implementation Plan

Status: implemented; Slices 0-9 complete
Date: 2026-07-13
Scope: unified conversation policy/component completion, teammate-private execution,
latest-user-message editing, Mermaid and rich Markdown, structured references, and E2E

Related docs:

- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Conversation Shared Capabilities Detailed Design](conversation-shared-capabilities-detailed-design.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Composer Unification Implementation Plan](conversation-composer-unification-implementation-plan.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)

## Delivery Principles

1. Reuse existing channel branches, topic replies, queued guidance, work cells, and
   TerminalReport contracts.
2. Land each slice with its own tests and rollback boundary.
3. Do not combine the rich-content parser migration with the message-edit transaction.
4. Fix private execution before claiming cross-surface execution parity.
5. Keep current workspace side effects when editing and resending the latest prompt.
6. Update design and implementation status in the same PR as each slice.

## Current Branch Progress

Completed on the current branch:

- Slice 1 surface policy and shared action contract:
  - avatar, tool execution, edit, fork, and TerminalReport participant policy;
  - scoped latest-editable-message selection;
  - shared action-bar filtering and accessibility coverage;
  - reusable TerminalReport projection policy;
  - channel keeps Participants while normal conversation and private chat suppress it.
- Slice 2 teammate-private execution boundary:
  - private chat now delegates to the standard `executeRunRequest` path;
  - effective provider, runner, tools, skills, MCP, workspace, permissions, and approval
    policy are resolved from the selected teammate and direct workspace;
  - `LingThread`, `LingTurn`, `RunSession`, `WorkUnit`, private message, runtime events,
    cancellation, approvals, and participant-free TerminalReport are linked;
  - focused daemon tests, Web E2E, and daemon/Web typechecks pass.
- Slice 3 durable storage subset:
  - migration 95 adds `conversation_message_revisions` and
    `conversation_turn_supersessions`;
  - revision conflict detection, idempotent replay, native channel/private message
    updates, old-turn supersession, and replacement lifecycle state are implemented;
  - focused Core migration/store tests pass.
- Slice 3 projection completion and Slice 4 edit orchestration:
  - default transcript/context projection hides superseded turns and dependent replies;
  - audit storage retains prior revisions, superseded runs, and response message ids;
  - `POST /conversation-message-edits` supports normal, channel root, channel branch,
    topic reply, and teammate-private surfaces;
  - replacement retries are idempotent and preserve current workspace changes;
  - a committed revision whose replacement fails remains visible with a durable retry
    action after refresh, and concurrent retries share one replacement start.
- Slice 5 shared inline edit UI:
  - the latest local-user message exposes the shared hover/focus Edit action;
  - inline editing preserves supported message payload fields and resends in the same
    Thread/Branch and current Workspace;
  - ordinary conversation refresh now reloads both the thread list and selected detail,
    preventing superseded assistant responses from remaining in local UI state.
- Slices 6-7 shared rich content:
  - Web delegates block rendering to the shared React renderer instead of maintaining a
    second Markdown tree renderer;
  - GFM tables/task lists/quotes, Mermaid, KaTeX, code, diff, file references, mentions,
    and safe links share one AST pipeline;
  - Mermaid has viewport deferral, 40k source limit, two-render concurrency cap, five
    second timeout, strict mode, unsafe attribute/link cleanup, theme rerender, copy,
    expanded view, invalid-source fallback, and stable render-state selectors;
  - normal, channel, topic, and private surfaces pass the same rich-content E2E fixture.
- Slice 8 structured references and previews:
  - real workspace file refs and ready link-preview records render through one compact
    reference strip;
  - hover/focus previews close after leaving both trigger and preview;
  - file refs open the appropriate Files Dock on channel, normal, and private surfaces;
  - PDF and DOCX previews reuse the existing bounded text extraction adapters;
  - memory, artifact, and TerminalReport references continue using their existing
    structured evidence and artifact projections rather than duplicate chips;
  - PR, commit, issue, memory, and generated artifact references remain data-driven:
    existing TerminalReport/artifact projections render them when native structured data
    exists, while ordinary messages do not synthesize placeholder references.
- Slice 9 cross-surface closure:
  - normal conversation, channel root/branch/topic, and teammate-private adapters use the
    shared action, rich-content, reference, WorkCell, and TerminalReport capability system;
  - normal and private TerminalReports suppress Participants while channel reports retain
    actual participant data and avatars;
  - latest-edit replacement-pending recovery, second-edit revision continuity, private
    approval/tool execution, rich content, previews, and responsive layouts have real E2E
    coverage;
  - obsolete page-local Markdown rendering and private discussion-only tool wiring were
    removed.

No implementation slice remains pending.

## Slice 0: Baseline Audit And Fixtures

Goal: lock the current behavior before changing shared policy or runtime routing.

Work:

- inventory channel, normal, private, and topic adapters that build `MessageRow`,
  `MessageActionBar`, `MessageBodyRenderer`, `ConversationWorkCell`, and
  `TerminalReportBlock` props;
- record the current `ConversationSurfacePolicy` defaults;
- add/refresh deterministic transcript fixtures for:
  - plain normal conversation;
  - channel multi-agent execution;
  - channel branch;
  - topic reply;
  - private plain discussion;
  - private blocked provider;
  - private executable request;
  - TerminalReport with and without participants;
  - superseded-turn projection;
  - Mermaid/table/math content;
- add stable selectors for user action rows and rich content blocks.

Verification:

- existing Web typecheck;
- focused conversation fixture/unit tests;
- existing channel/private/normal E2E remains green.

Exit criteria:

- every later slice has a deterministic fixture;
- no surface-specific behavior is inferred only from screenshots.

## Slice 1: Surface Policy And Shared Action Contract

Goal: make all new behavior policy-driven before adding UI actions.

Work:

- extend `ConversationSurfacePolicy` with avatar, tool execution, latest edit, fork, and
  TerminalReport participant visibility fields;
- extend `MessageActionKind` with `edit_latest`, `fork`, `open_reference`, and
  `open_artifact` where missing;
- add pure helpers that determine the latest editable local-user message per scoped
  surface lane;
- update `MessageActionBar` filtering and accessibility tests;
- add `TerminalReportProjectionPolicy.showParticipants`;
- keep native participant data in the report while hiding it on normal/private surfaces.

Likely files:

- `packages/conversation-ui-core/src/*`
- `packages/conversation-ui-react/src/*`
- `apps/web/src/shared/conversation/tokens/conversation-surface-policy.ts`
- `apps/web/src/shared/conversation/feedback/MessageActionBar.tsx`
- `apps/web/src/shared/conversation/blocks/TerminalReportBlock.tsx`

Verification:

- policy unit tests;
- normal/private reports omit Participants;
- channel reports still show actual participant avatars;
- action icons remain hover/focus reachable.

Exit criteria:

- UI components can receive edit capability without route-specific conditionals.

## Slice 2: Teammate Private Execution Boundary

Goal: remove the hardcoded discussion-only `tools: []` path and make private chat a real
single-agent execution surface.

Work:

- add `resolveTeammateDirectExecutionContext()`;
- resolve direct workspace binding and execution cwd;
- resolve provider/model and runner from the selected teammate;
- compute effective tools from teammate tools, runner capabilities, effective skills,
  MCP authorization, workspace policy, and composer permission snapshot;
- pass effective tools to runner resolution, provider resolution, and `runTask`;
- create/link a supervised work unit, run, turn where applicable, and private AI message;
- project runtime events into the shared private WorkCell;
- render private approval rows;
- synthesize/render a participant-free TerminalReport;
- keep the old discussion-only path behind a temporary feature flag until tests pass.

Likely files:

- `packages/daemon/src/features/teammates/direct-replies.ts`
- `packages/daemon/src/features/teammates/direct-controls.ts`
- teammate execution/context helper modules to be extracted from `direct-replies.ts`
- `packages/core/src/run-types.ts`
- `packages/contracts/src/teammates.ts`
- `apps/web/src/features/teammates/*`

Required module split:

```text
direct-replies.ts
  -> request/reply orchestration only

direct-execution-context.ts
  -> provider, runner, tools, skills, MCP, workspace, permissions

direct-execution-projection.ts
  -> private message/run/work-cell/terminal linking
```

Verification:

- daemon test: private Read request;
- daemon test: private Edit request with approval policy;
- daemon test: private Shell/Check request;
- daemon test: forbidden tool remains unavailable;
- daemon test: private evidence does not appear in channel context;
- Web E2E: real private operation rows and TerminalReport without Participants.

Exit criteria:

- private chat can execute a real code/document change under current teammate policy;
- no `tools: []` remains in the executable direct path.

## Slice 3: Message Revision And Supersession Storage

Goal: establish durable edit semantics before exposing the edit button.

Work:

- add `conversation_message_revisions` migration and store;
- add turn/message supersession record and store;
- expose revision, `editedAt`, and replacement-pending metadata through read models;
- implement lazy revision-1 snapshot on first edit;
- add expected-revision concurrency checks;
- add idempotency keys;
- update transcript projectors to hide superseded dependent rows by default;
- add audit/detail read support for old revisions and superseded evidence;
- exclude superseded turns from default context, memory promotion, and queued follow-up
  selection.

Likely files:

- `packages/core/src/storage/sqlite/migrations.ts`
- new `packages/core/src/storage/sqlite/conversation-message-revision-store.ts`
- new `packages/core/src/storage/sqlite/conversation-turn-supersession-store.ts`
- `packages/core/src/run-types.ts`
- `packages/contracts/src/*`
- transcript projector modules.

Verification:

- migration tests;
- first edit creates revision 1 and 2 atomically;
- stale edit returns `message_revision_conflict`;
- current projection shows revision 2;
- audit projection still shows revision 1 and old work;
- old clients can read the current native message body.

Exit criteria:

- revision/supersession persistence works without starting a replacement run.

## Slice 4: Edit Orchestration API

Goal: implement safe rollback-and-resend behavior across supported surfaces.

Work:

- add `POST /conversation-message-edits` contract and API client;
- implement shared edit service and four adapters:
  - normal conversation;
  - channel root/branch;
  - topic reply;
  - teammate direct;
- validate local ownership, active owner/surface, latest-message identity, expected
  revision, and attachment scope;
- interrupt active runs/replies and await terminal acknowledgement;
- close old pending approvals and queued guidance;
- persist the new revision and supersession record transactionally;
- start the replacement response/run in the same thread and current workspace;
- persist `replacement_pending` recovery state when replacement start fails after commit;
- emit structured edit lifecycle events.

Verification:

- edit latest plain normal message;
- edit latest channel root message;
- edit latest channel branch message without creating a new branch;
- edit latest private message using the selected teammate;
- edit latest topic reply;
- reject non-latest and non-owned messages;
- interrupt active run before resend;
- preserve workspace file changes;
- old approval cannot be approved after supersession;
- replacement retry is idempotent.

Exit criteria:

- backend protocol is complete and recoverable before Web exposes Edit.

## Slice 5: Shared Inline Edit UI

Goal: expose Codex/ChatGPT-like latest-prompt editing through shared components.

Work:

- add edit icon to the shared user `MessageActionBar`;
- show only for the latest editable local-user message on hover/focus;
- add `InlineMessageEditor` built from shared tokenized composer primitives;
- restore body, allowed mentions, attachments, links, and file references;
- add cancel and `Save and resend` actions;
- add interrupting/persisting/starting status states;
- show workspace-retention notice only when structured old-turn evidence reports
  side effects;
- update row in place after success and show quiet `Edited` metadata;
- keep superseded work hidden without inserting a rollback system message;
- preserve keyboard and screen-reader behavior.

Likely files:

- `packages/conversation-ui-react/src/*`
- `apps/web/src/shared/conversation/feedback/MessageActionBar.tsx`
- new shared inline editor component/hook;
- channel, normal, private, and topic adapters.

Verification:

- component tests for action visibility and edit states;
- E2E on all four supported surface adapters;
- layout checks prove surrounding operation rows do not collapse;
- refresh after success shows the revised message and replacement response.

Exit criteria:

- latest-message edit is visually and behaviorally consistent across shared surfaces.

## Slice 6: Mermaid First Rich Block

Goal: add the highest-value rich content block without waiting for the full parser
migration.

Work:

- extend the existing fenced-code parser with explicit fence completeness;
- route completed `language === "mermaid"` blocks to `MermaidBlock`;
- dynamically import Mermaid;
- add offscreen deferral, render generation ids, timeout, source length limit, safe link
  handling, source fallback, theme rerender, copy, and expand;
- notify the feed after deferred SVG layout;
- add a demo/fixture transcript containing valid and invalid Mermaid.

Verification:

- unit tests for fence completeness and block routing;
- component tests for loading/error/stale render;
- E2E desktop/mobile widths, light/dark theme, expanded view, copy, and invalid source;
- bundle inspection proves Mermaid is lazy.

Exit criteria:

- Mermaid works on channel, normal, private, and topic surfaces through one renderer.

## Slice 7: Structured Markdown Parser Migration

Goal: replace regex growth with an AST parser while preserving Ling-specific references.

Work:

- introduce `unified`, `remark-parse`, `remark-gfm`, and `remark-math`;
- map Markdown AST into `ConversationContentBlock[]`;
- implement headings, quotes, tables, task lists, thematic breaks, and nested lists;
- preserve local-file parsing, web links, mentions, code, diff, and Mermaid dispatch;
- add KaTeX renderer with strict fallback;
- keep raw HTML disabled;
- add streaming normalization and stable block keys;
- compare old/new parser fixtures before switching the default.

Rollout:

1. dual-parse fixtures in tests;
2. feature flag in development;
3. switch default after parity tests;
4. remove obsolete regex paths only after production-like E2E passes.

Verification:

- parser fixture suite;
- security tests for HTML/script/unsafe URLs;
- E2E for long tables, nested quotes, task lists, math, code, diff, Mermaid, file refs,
  and mentions;
- performance benchmark on long streamed conversations.

Exit criteria:

- shared renderer supports the approved rich-content set without raw HTML.

## Slice 8: Structured References And Artifact Preview Parity

Goal: finish shared content capability parity without exposing raw evidence.

Work:

- normalize workspace file, document section, web, memory, PR, commit, issue, and
  artifact references;
- render compact labels/source icons from real structured refs only;
- add hover/focus previews where safe;
- open large/rich previews in the existing Right Dock or artifact viewer;
- extend JSON/CSV/document/PDF/image preview adapters;
- prevent preview persistence after pointer/focus leaves transient trigger and overlay;
- keep memory references hidden when surface policy forbids disclosure.

Verification:

- no placeholder source UI without real refs;
- file/line refs open correctly;
- private refs remain private;
- previews do not cover the latest message or remain stuck after scroll;
- artifact preview dimensions remain compact and scrollable.

Exit criteria:

- content references behave consistently across all shared surfaces.

## Slice 9: Cross-Surface E2E And Cleanup

Goal: verify the complete capability set with real cases and remove obsolete paths.

Real scenarios:

1. Normal conversation edits code, runs checks, renders WorkCell and participant-free
   TerminalReport, then edits the latest prompt and reruns from current workspace.
2. Teammate private chat reads and edits a file with the selected teammate, handles an
   approval, and renders the same operation UI without Participants.
3. Channel runs multi-agent work, preserves teammate participation, edits the latest
   prompt in the same branch, and retains existing branch/topic/guidance behavior.
4. Assistant response renders Mermaid, table, math, code, diff, references, and artifact
   previews in one transcript.
5. Invalid/oversized rich content and interrupted edit flows recover without duplicate
   messages or stuck status.

Cleanup:

- remove page-local user action buttons replaced by `MessageActionBar`;
- remove private discussion-only tool wiring;
- remove obsolete parser code after parity is proven;
- update design status sections and implementation checklists;
- run `git diff --check` and documentation link checks.

Exit criteria:

- all three primary conversation surfaces use one capability system;
- real runtime cases match fixtures;
- no known duplicate UI or parallel runtime path remains.

## Verification Commands

Use the narrowest available commands first; exact package test names may change during
implementation.

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core build
corepack pnpm --filter @ling-stack/conversation-ui-react build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
corepack pnpm --filter @ling-stack/daemon test
git diff --check
```

Focused daemon/core Node tests should run directly when the package-level test script is
broader than the current slice.

## Completion Evidence

- Conversation UI Core: 22 tests passed.
- Conversation UI React: 6 tests passed.
- Core: 290 tests passed.
- Daemon: 519 tests passed, including private tool execution, approval resume, revision
  persistence, replacement-pending projection, and concurrent retry idempotency.
- Web lint and i18n audits passed.
- Web production build passed; existing Rollup circular-chunk and large-chunk warnings
  remain outside this capability slice.
- Web E2E: 239 Chromium scenarios passed across normal conversation, channel, topic,
  private chat, runtime, settings, and workspace surfaces.
- Long streaming Markdown benchmark: 35,249 characters parsed 20 times in 917.71 ms,
  averaging 45.89 ms per parse on the implementation workstation.
- Responsive rich-content visual evidence:
  - `/tmp/ling-shared-capabilities-visual/p10-rich-code-diff-desktop.png`
  - `/tmp/ling-shared-capabilities-visual/p10-rich-code-diff-narrow.png`
  - `/tmp/ling-shared-capabilities-visual/p10-rich-code-diff-mobile.png`
- `git diff --check` and local Markdown-link validation passed.

## PR Boundaries

The original staged recommendation was:

1. Surface policy and TerminalReport participant projection.
2. Teammate private execution.
3. Revision/supersession storage and edit API.
4. Shared inline edit UI.
5. Mermaid renderer.
6. Structured Markdown/math migration.
7. Structured references/artifact parity and final E2E cleanup.

Implementation ultimately completed on one coordinated branch because the shared policy,
revision projection, private execution, and E2E fixtures had cross-slice contract changes.
The modules and tests preserve the listed rollback boundaries even though landing is one
atomic implementation PR.

## Module Boundary Note

`TeammatePrivateChatSurface.tsx` remains a large surface adapter. Execution-context and
projection logic were extracted into daemon modules, while the existing Web composition
was kept intact to avoid an unrelated view rewrite during this capability migration.
Future view extraction can split feed, composer, and dock composition without changing
the shared conversation or runtime contracts.

## Decision Status

No unresolved decision blocks implementation.
