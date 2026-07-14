# Conversation Work Cell Operation Records

Status: implementation record
Date: 2026-07-10
Scope: channel feed, teammate private chat, normal conversation work cells,
multi-agent operation projection, operation row disclosure, and validation notes

Related docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Conversation UI Design Conformance Recovery Plan](conversation-ui-design-conformance-recovery-plan.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Conversation Operation Bubble And Performance Store](conversation-operation-bubble-and-performance-store.md)
- [Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md)

## Purpose

This document records the final UI decision from the Helio / Grok / local demo review:
Ling should not turn agent work into public-channel chat bubbles or a heavy card stream.
The shipped direction is a clean `ConversationWorkCell` with row-style operation records.

The temporary demo served only to settle the interaction. The production component,
the opt-in local Engineering channel demo fixture, and the channel e2e fixtures are now
the canonical demo.

## Final UX Contract

One user task still maps to one visible work object. The work object can contain live
operation rows, multi-agent spans, artifacts, evidence summaries, approvals, and final
result state, but it should not expose workflow ids, run ids, provider metadata, raw
JSON, raw logs, or packet internals as first-level conversation concepts.

Active work cells stay expanded. Each meaningful action streams as its own row:

```text
Edited WorkspaceClientView.tsx
Ran command
Searched channel message renderer
Checked typecheck
```

Completed work cells collapse by default:

```text
Processed 2m 10s  Conversation work cell was rendered from thread-backed run data.
```

When the completed cell is expanded, the collapsed summary copy is hidden and the
operation history remains visible. The process is not merged into a single "done" line.
Second-wave or retry work appears as separate rows in the correct semantic position,
instead of being merged into an earlier completed row.

Single-agent, private chat, and ordinary conversation surfaces do not need an outer
"agent participation" block. They render the internal operation rows only. Multi-agent
work renders agent spans only when more than one specialist actually participates.
Untriggered agents are not shown.

Each disclosure controls only itself:

- the completed shell expands or collapses the work cell body;
- expanding the completed shell reveals every participating agent's operation rows;
- each operation row expands only that row's detail;
- agent headers are static and do not add a second folding layer;
- expanded work-cell agent headers show identity/status only, without repeating the
  latest-action summary;
- each agent's concise latest-action summary belongs to the post-result teammate
  participation panel below the final Ling summary;
- clicking an operation row must not collapse the parent shell or sibling rows.

## Visual Rules

The operation record surface is intentionally quiet:

- no chat bubbles around operation records;
- no default card or bubble shell for read, search, model, or workflow rows;
- no "view records" button when the whole row can be clicked;
- no visible round labels such as "round 2";
- no top-level running icon when there is no meaningful row to show;
- no repeated explanatory copy above rows when the row detail already says the same
  thing;
- real tool-operation row text is dimmer than normal conversation text;
- hover and keyboard focus raise tool-operation rows to normal conversation contrast;
- thought, intent, and pre-action narrative rows have no reserved icon slot and use the
  same text color and semibold weight as normal conversation copy, while using one larger
  font step than real tool-operation titles;
- real tool-operation titles use regular weight rather than bold text;
- operation kind labels use icons rather than text labels such as `READ`, `CMD`, `CHECK`,
  `MODEL`, or `THINK`.

Read and search rows are one-line records by default. Expanding them can show the files,
query, or bounded result summary, but not inside a bubble. Shell and code operations keep
a code-block feel only inside the expanded detail.

Edit rows use their linked diff artifact as the authority:

- after the file label, show the actual `+additions -deletions` count when the complete
  diff preview is available;
- clicking the edit row reveals a bounded inline diff excerpt with line numbers and
  add/delete highlighting;
- each changed hunk includes at most three unchanged source lines before and after the
  actual edit so the user can understand the surrounding code without opening the file;
- hunks separated by no more than six unchanged lines merge into one preview range;
  wider gaps remain separate and render an explicit `N unmodified lines` fold marker;
- context lines use neutral styling and never contribute to the addition/deletion totals;
- large or truncated previews remain partial and must not claim an exact change count;
- edit actions without a diff artifact keep the normal row treatment and do not invent
  counts from filenames or prose.

## Final Artifact Strip

The final Ling summary owns a compact artifact strip below the teammate participation
summary. It separates produced files from source changes:

- non-diff artifacts render first as normal output rows;
- diff artifacts are not repeated as normal output files;
- one changed-files group always renders last;
- the group title shows `Edited N files` and exact total `+additions -deletions` only
  after complete diff artifacts have been parsed;
- clicking the group expands its changed-file list;
- the expanded list shows at most three files initially, followed by `Show N more files`
  when additional files exist;
- each changed-file row shows its exact additions and deletions when available;
- the changed-files group itself is always open and has no outer disclosure control;
- only the bounded `Show N more files` row may expand or collapse additional files;
- hovering a previewable output or changed-file row for two seconds opens a bounded
  floating preview;
- the floating diff preview uses the same three-line hunk context contract as inline
  edit-row detail and keeps a bounded internal line limit;
- the floating preview prefers the space immediately above its source row and only falls
  back below when the viewport does not have enough room above;
- keyboard focus or clicking the row opens the same compact preview immediately;
- moving the pointer outside both the source row and floating preview hides it;
- the default preview does not open the full-page artifact lightbox or duplicate its
  open, download, copy, and close chrome.

Workspace-backed output rows also expose a persistent `Open with` action at the right
edge of the row:

- the main row remains the preview target while `Open with` is a separate sibling
  control, so opening the application menu never triggers the hover preview;
- the conversation surface uses the complete `Open with` label; the narrower right dock
  keeps the compact `Open` label;
- the action is shared by channel, normal-conversation, and teammate-private surfaces;
- only rows carrying a structured `workspaceFilePath` render the action;
- `workspaceFilePath` is projected from a TerminalReport artifact only when exactly one
  user-visible `file` source reference resolves to one of that report's structured
  changed paths;
- arbitrary Run Artifact storage paths, labels, hrefs, and `.ling-stack/artifacts`
  locations never gain workspace-open authority through string guessing;
- the daemon remains authoritative for current file existence, workspace containment,
  regular-file validation, and installed-application discovery;
- failed or stale targets remain non-mutating and report the daemon error inside the
  menu rather than falling back to an unrestricted local file URL.

The changed-files row carries a structured recovery target rather than an optional bare
run id:

- a normal conversation, teammate-private run, or single-run work cell uses
  `{ kind: "run", id: runId }`;
- a channel multi-agent workflow uses `{ kind: "workflow", id: workflowId }` even when
  its visible artifacts came from several Agent runs;
- the shared artifact-strip component selects the matching status, undo, and reapply API
  from that target and keeps the same button placement on every conversation surface;
- a workflow target is never downgraded to its latest run because that would expose a
  partial undo under an aggregate changed-files count.

Once the final summary and artifact strip are present, the completed work cell's compact
evidence disclosure shows references only. Changed-item and check counts are omitted
because the operation stream and final changed-files group already own those facts.
Expanding this reference disclosure renders only the reference links, not duplicated
change/check groups. Message-level used-memory citations remain a separate disclosure
below the Ling response and must still render when memory was used. The collapsed row is
the only memory summary and shows the real memory count plus latest usage time; expanding
it renders the memory references directly without a nested card, repeated heading,
repeated count, or second disclosure.

File counts may come from structured changed-file evidence. Addition and deletion totals
must come from complete diff artifacts; prose and filenames are never used to fabricate
them.

## Model Waiting Rule

`正在思考` is a live-only latest indicator for "the runtime is waiting on a model
response". It is not historical evidence.

Rules:

- show only the latest/current model-waiting indicator;
- remove it once the model response arrives;
- do not persist it into completed operation records;
- do not show suffixes such as `Ling runtime`;
- do not show extra lifecycle copy such as "waiting for model response" or "model
  response completed" in the main feed.

## Operation Vocabulary

The shared view model exposes these operation kinds:

| Kind | Current icon | Default use |
| --- | --- | --- |
| `plan` | `ListChecks` | planning or scoped task breakdown |
| `read` | `BookOpen` | file reads, inspections, directory reads |
| `edit` | `FilePenLine` | writes, patches, generated docs, file changes |
| `run_command` | `SquareTerminal` | shell commands and command-like checks |
| `search` | `Search` | code search, web/search-like lookup rows |
| `approval` | `ShieldCheck` | approvals and waiting gates |
| `verify` | `CheckCircle2` | typecheck, lint, tests, smoke checks |
| `handoff` | `GitBranch` | agent handoff, workflow step assignment |
| `watch` | `Clock3` | fallback or passive observation |

Failed rows use `CircleAlert` regardless of kind. Waiting rows and approval rows use
`ShieldCheck`.

## Codex-Inspired Command Execution Batches

Long runs of successful shell commands should not dominate the conversation after their
meaningful work is complete. Ling may project adjacent low-risk command actions into one
compact command batch while preserving every underlying `ExecutionAction` and run event.

The product contract is:

- command batching is a UI projection only; it never rewrites, deletes, or coalesces
  persisted events;
- the latest executing command remains a standalone row, stays expanded, and shows a
  bounded live output tail;
- a completed batch renders as `Ran N commands` with an optional elapsed-time suffix;
- a batch is created only when at least three eligible completed commands are adjacent;
- expanding the batch reveals every command as a separate row in execution order;
- the batch disclosure controls only the child command list;
- each child command controls only its own output detail;
- completed batches default to collapsed, including when the containing completed work
  cell is expanded later;
- failed, cancelled, approval-gated, or safety-sensitive commands always stay visible as
  standalone rows;
- Git commit, Git push, deployment, credential, provider, external-send, and other
  consequential actions are never hidden inside a generic command count;
- command batches never cross agent, run, retry, handoff, narrative-note, edit, approval,
  failure, or workflow-step boundaries;
- ordinary conversation, teammate private chat, and channel work cells use the same
  batch component and rules; multi-agent channels additionally scope batches to one
  participating agent span.

Example while work is active:

```text
Ran 3 commands
Running pnpm test
  latest bounded output...
```

Example after expanding a completed batch:

```text
Ran 4 commands
  pnpm install                 0 · 8.2s
  pnpm typecheck               0 · 4.1s
  pnpm lint                    0 · 2.7s
  pnpm test                    0 · 12.6s
```

The compact batch header does not replace the final Ling summary, artifact strip, or
verification section. It only reduces repetitive process chrome in the operation stream.
The detailed runtime contract, deterministic grouping algorithm, live refresh path, and
implementation slices are defined in
[Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md).

## Runtime And View Model

The current implementation keeps the semantic shape shared and the visual projection in
Web:

```text
runtime / workflow / thread evidence
  -> ConversationOperationCellViewModel
  -> ConversationWorkCell
  -> row-style operation records
```

Important code surfaces:

| Surface | Role |
| --- | --- |
| `packages/conversation-ui-core/src/work-cell-view-model.ts` | shared work-cell types, operation kinds, `elapsedMs`, rows, groups, artifacts |
| `apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx` | row renderer, shell folding, agent spans, row disclosure, icons |
| `apps/web/src/shared/conversation/blocks/ConversationArtifactStrip.tsx` | output rows, changed-file disclosure, delayed hover preview |
| `apps/web/src/lib/conversation-work-cell.ts` | thread/run evidence projection for normal and private conversation cells |
| `apps/web/src/lib/workflow-progress.ts` | workflow progress projection and multi-agent spans |
| `apps/web/e2e/channel.spec.ts` | real fixture coverage for collapsed/expanded cells and evidence disclosure |

`ConversationWorkCellRow.detailLines` holds bounded details. `presentation: "shell"`
and `commandText` are used when a row should reveal a command/code detail after
expansion. The command is not rendered as a standalone card in the collapsed row.

## Demo And Validation Record

The local demo conclusion was folded into the production UI instead of being committed
as a separate prototype. The production fixture is the Engineering channel work-cell
case in `apps/web/e2e/channel.spec.ts`.

There is also an opt-in local display fixture for manual review:

```js
localStorage.setItem("ling-stack.workCellDemo", "true");
```

Or open the local Web app with:

```text
http://127.0.0.1:5173/?workCellDemo=1
```

After setting either flag and reloading the local Web app, the Engineering channel
receives one synthetic completed workflow work-cell. It is assembled from the same
front-end read-model inputs as real data: workflow, workflow steps, run sessions,
execution actions, and artifacts. The fixture is gated behind `import.meta.env.DEV`,
is not persisted to the daemon, and should not be used as product state.

The fixture covers:

- a completed folded shell with the main task summary;
- Architect, Designer, Engineer, and QA agent spans;
- Engineer doing a second follow-up step after QA without merging it into the earlier
  completed row;
- read/search/edit/command operation rows;
- command detail expansion without default shell-card chrome;
- one user-facing output artifact followed by a five-file changed group, while internal
  log/context/output artifacts remain hidden from the main conversation;
- three changed files shown initially, with two more behind the compact disclosure;
- delayed hover diff preview without the large artifact lightbox;
- a message-level used-memory disclosure that remains below the final Ling response and
  expands directly into references without nested evidence chrome;
- no historical `正在思考` or `Ling runtime` rows.

Manual browser validation recorded on 2026-07-10:

- Engineering channel loaded with one real conversation work cell;
- the completed shell was collapsed by default;
- expanding the shell revealed every participating agent's operation rows without a
  second agent-level disclosure;
- clicking a shell/code row expanded only that row's detail;
- read/search/workflow rows stayed borderless and did not render bubble cards;
- shell details did not render `.conversation-work-cell-shell-card`;
- there was no `Copy summary` operation action;
- the shell background remained transparent;
- no browser console errors were observed.

Temporary screenshots were saved outside the repository as validation artifacts:

- `/var/folders/wv/szx379kx7r135_kzktxrrs680000gn/T/ling-work-cell-ui-check/engineering-work-cell-expanded.png`
- `/var/folders/wv/szx379kx7r135_kzktxrrs680000gn/T/ling-work-cell-ui-check/mobile-shell.png`

These are not product assets and should not be committed.

Automated checks already covered this slice:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g "work cell|conversation work cell|workflow"
git diff --check
```

The focused channel e2e run covered 17 tests.

## Non-Goals

- Do not copy Helio's public-channel style literally.
- Do not make each agent produce an independent chat transcript by default.
- Do not show untriggered agents.
- Do not persist model-waiting rows after a response arrives.
- Do not expose provider, token, JSONL, raw log, packet, or internal id details in the
  main feed.
- Do not move the same operation detail into a right-drawer-only experience.
- Do not add visible round labels or fixed report sections.
- Do not use text-only heuristics as the long-term authority for semantic projection.

## Follow-Ups

- Add a mobile visual regression fixture for the work-cell row surface if the screenshot
  suite grows a stable gallery.
- Move more of the Web projection into the shared transcript contract once the row-style
  UI has settled.
- Keep the legacy `OperationBubble` components only as compatibility pieces until all
  imports and docs have converged on `ConversationWorkCell`.
