# Ling Agent Operation Cell UI

Status: historical baseline; superseded by typed transcript design
Date: 2026-06-14
Superseded: 2026-08-30
Scope: channel conversation feed, Ling Agent session rows, multi-agent collaboration
projection, operation evidence, and interruption entry points

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Conversation Surface Contract](./conversation-surface-contract.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)
- [Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md)
- [Ling Typed Transcript Detailed Design](conversation-typed-transcript-detailed-design.md)
- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)

## 2026-08-30 Supersession Notice

本文保留早期 OperationCell、协作摘要和 Codex 对照的背景，但不再是新实现的渲染
契约。`OperationCell` 在 typed transcript 中只对应 `TimelineFactRow`；
`ConversationTimeline` 是普通会话、队友私聊、频道和子 Agent 的唯一 feed renderer。
本文中“再追加 coordinator summary”“父 WorkCell 拥有完成状态”或“route-local
activity row”的段落均视为历史方案，不能据此新增 UI owner。事实完成、fan-in、审批
和恢复必须以 typed transcript 设计及其 atomic evidence 规则为准。

## Summary

Ling Stack should merge two interaction models:

1. Codex-style operation cells: a running action is one semantic cell that mutates in
   place, commits once, and hides raw details behind evidence.
2. Multi-agent activity visibility, inspired by Grok-like agent surfaces: several
   specialist agents may work in parallel, but the user sees one coordinated task
   surface and one final answer, not a separate chat transcript for every agent.

The default channel feed is a cell stream, not a fixed report template. A turn may
contain coordinator text, operation rows, agent spans, artifact rows, or only an answer,
depending on the normalized events for that turn:

```text
user request
Ling Agent transcript
  TranscriptBlock[]
    coordinator text, only when useful
    OperationCell / AgentActivitySpan / ArtifactStrip as needed
    terminal result text, when there is a result to summarize
```

Terminal result content must consume the structured `TerminalReport` contract. The UI
must not reconstruct outcome, changes, verification, participants, artifacts, or risks
from final prose or from the last workflow-step summary.

It should not read like this:

```text
Ling Agent started
Workflow event
Run event
Docs agent internal note
Engineer raw output
QA raw output
Collaboration card
Ling Agent completed
Right drawer duplicate
```

The product rule is simple: **one user task gets one visible work object**. Raw runtime
records, workflow ids, run ids, work-unit ids, JSON payloads, shell logs, provider
metadata, and packet artifacts are evidence, not first-level conversation concepts.

## Conversation UI Framework Boundary

Ling does not need to copy a terminal UI framework. Codex CLI uses a TUI renderer because
its product surface is a terminal; Ling is a Web application. The transferable layer is
the conversation rendering framework:

```text
raw runtime events
-> normalizer
-> semantic UI model
-> cell render contract
-> surface placement
```

This layer sits between daemon/runtime records and React components. It is responsible for
turning noisy event streams into user-facing cells before any component decides typography,
spacing, iconography, drawer width, or animation.

The first implementation can live in Web while the visible interaction is corrected, but
the layer is not a Web-only concept. The stable form should be a shared semantic
`ConversationTranscript` contract produced by daemon/core and consumed by Web, Desktop,
and CLI renderers:

```text
daemon/core projection
  -> ConversationTranscript / TranscriptBlock[]
  -> Web renderer
  -> Desktop renderer
  -> CLI/TUI renderer
```

CLI may render transcript blocks as terminal rows, but it must not become the owner of
conversation projection. Desktop may use native macOS styling, but it must consume the
same semantic transcript rather than copying Web grouping logic.

Non-goals:

- introducing `workflow`, `run`, `work-unit`, `packet`, or `raw event` as first-level user
  concepts;
- replacing the existing Web layout with a terminal-like UI;
- making the right drawer a second transcript;
- making the floating run popover a log viewer;
- changing storage before a projection model proves the UI contract.

## Adaptive Conversation Framework

The conversation UI is a framework, not a fixed template library. Different tasks produce
different transcript structures according to the operations, actors, approvals, artifacts,
and decisions that actually occurred.

Framework rule:

```text
runtime / workflow / approval / artifact / message events
  -> normalized semantic events
  -> ConversationTurn
  -> TranscriptBlock[]
  -> block renderer registry
  -> main conversation page
```

The projector chooses blocks from state, not from prose or a hard-coded task template.
Examples in this document are fixtures for expected behavior; they are not parser rules,
copy templates, or a required layout for every turn.

### Block Registry

`TranscriptBlock` is a discriminated union. Each block has stable identity, lifecycle
state, render modes, source refs, and ownership.

```ts
type TranscriptBlockKind =
  | "coordinator_message"
  | "operation"
  | "agent_activity"
  | "approval"
  | "artifact_strip"
  | "source_summary"
  | "requirement_shaping"
  | "decision_needed"
  | "final_result"
  | "raw_debug_ref";

interface TranscriptBlockBase {
  readonly id: string;
  readonly kind: TranscriptBlockKind;
  readonly turnId: string;
  readonly ownerId?: string;
  readonly status?: OperationCellStatus;
  readonly display: DisplayLine[];
  readonly expanded?: ExpandedDetail;
  readonly raw?: RawDetailRef;
  readonly sourceRefs: readonly EvidenceSourceRefViewModel[];
}
```

Renderer registry:

```ts
type TranscriptBlockRenderer = {
  readonly kind: TranscriptBlockKind;
  readonly canRender: (block: TranscriptBlockBase) => boolean;
  readonly renderDisplay: (block: TranscriptBlockBase) => ReactNode;
  readonly renderExpanded?: (block: TranscriptBlockBase) => ReactNode;
  readonly renderPreview?: (block: TranscriptBlockBase, targetId: string) => ReactNode;
};
```

Rules:

- A renderer renders one semantic block kind. It must not reach into raw workflow/run
  records to invent additional first-level UI.
- A turn can contain any ordered subset of block kinds. For example, a simple answer may
  render only `coordinator_message`; a coding task may render `operation`, `approval`,
  `artifact_strip`, and `final_result`; requirement shaping may render
  `requirement_shaping`, `decision_needed`, and `source_summary`.
- Blocks are additive and state-driven. Do not pad missing blocks with empty headings.
- Blocks can mutate while active, then commit once at terminal state.
- Block order comes from the projector's semantic ordering, not component mount order or
  raw event arrival order.
- Component code must not check message text such as `确认需求`, `完成`, `Product:`, or
  `QA:` to decide the layout.

### Conditional Composition

The projector composes a turn from normalized events:

| Condition | Blocks generated |
| --- | --- |
| user asks a direct answer, no tools | `coordinator_message` |
| local command/check runs | `operation` with inline `EvidenceDetail` |
| write/edit needs permission | `approval` inside the owning operation/agent span |
| one specialist contributes a bounded view | `agent_activity` |
| multiple specialists shape scope | `requirement_shaping` with contribution spans |
| user decision blocks execution | `decision_needed` |
| files/images/diffs are produced | `artifact_strip` plus preview targets |
| sources affect result | `source_summary` or memory citation footer |
| support opens diagnostics | `raw_debug_ref` |

The UI therefore adapts to task shape:

- research can emphasize sources and synthesis;
- coding can emphasize operations, diffs, approvals, checks, and artifacts;
- design review can emphasize visual evidence, decisions, and screenshots;
- multi-agent planning can emphasize participant contributions and conflicts;
- simple chat can remain plain text.

### External Framework References

Ling should borrow concepts, not outsource the conversation model:

| Reference | Useful idea | Ling boundary |
| --- | --- | --- |
| [assistant-ui](https://www.assistant-ui.com/) | thread/runtime/message primitives, streaming lifecycle, attachments, external store adapters | Do not adopt its thread store as Ling authority; Ling already has channel/workflow/task state. |
| [Vercel AI Elements](https://elements.ai-sdk.dev/) | composable AI UI blocks, streaming/status-aware components, shadcn-style registry | Borrow component composability; do not force Ling into `useChat` message shapes. |
| [Chainlit](https://docs.chainlit.io/) | messages, steps, elements, and actions as separate concepts attached to a conversation | Borrow Message/Step/Element/Action separation; do not expose chain-of-thought or raw steps as default UI. |

The practical design is closest to a headless transcript framework:

```text
Ling-owned state and projection
  -> headless transcript blocks
  -> renderer registry
  -> strict Ling visual system
```

This gives us the flexibility of open-source chat frameworks without making their message
schemas or default component layout the product contract.

### Assistant-UI Polish To Borrow

assistant-ui is most useful as an interaction checklist. Ling should not adopt its state
store, but it should borrow these UI patterns:

| Pattern | Borrow | Ling adaptation |
| --- | --- | --- |
| Thread viewport | Stable scroll container, top turn anchor, scroll-to-bottom affordance, composer height accounting | User turn anchors near the top while the assistant/agent work grows below it; auto-scroll only when the user has not intentionally scrolled up. |
| Message parts pipeline | Render text, image, tool, data, and attachments through typed part renderers | Map Ling `TranscriptBlock` and evidence parts through a renderer registry instead of one giant message component. |
| Grouped parts | Group adjacent tool/reasoning/tool-output parts | Group consecutive tool/file/check rows under the owning `OperationCell` or `AgentActivitySpan`; never expose reasoning by default. |
| Tool UI registry | Per-tool renderer plus fallback renderer | Known Ling operations get rich but compact rows; unknown tools render as safe generic operation evidence, not raw JSON. |
| Human-in-the-loop tool rendering | Tool execution can pause for user input/confirmation | Map to Ling `ApprovalCell` with explicit action, scope, consequence, and approve/deny actions. |
| Streaming state | Partial content can show an in-progress indicator and settle after completion | Keep `Thinking...`, shimmer, or active-row state while running; commit the same row at terminal state. |
| Attachments | Composer attachments, message attachments, image thumbnails, remove action, preview dialog | Keep attachments in the owning conversation turn; image/file preview opens inline/lightbox, not a drawer. |
| Hover action bar | Contextual actions appear only when useful | Add subtle copy/open/download/retry/fork/edit actions on hover/focus, with keyboard access and no visual clutter. |
| Error primitive | Dedicated error display path | Render failed blocks as bounded error rows with recovery action; full stack/raw payload stays in raw/debug detail. |

### Rich Text And Code Rendering

Ling's current conversation UI is too plain for code-heavy work. The conversation
framework needs a first-class rich text renderer:

```text
assistant/coordinator markdown
  -> safe markdown AST
  -> text / table / list / code / link / image renderers
  -> Strict Daylight transcript styling
```

Code block rules:

- Use a real syntax highlighter, preferably Shiki or a Shiki-backed renderer, for
  committed code blocks and file previews.
- Highlight by declared language when available; infer from filename only when safe.
- Show a small language label and copy button in the code block header.
- Disable raw HTML in markdown. Sanitize links and only allow safe protocols.
- Stream code blocks as plain monospace while incomplete; apply expensive syntax
  highlighting after the block is closed or the turn commits.
- Preserve indentation exactly. Do not let proportional fonts, negative letter spacing,
  or wrapping break code layout.
- For long code/log blocks, cap visible height and provide inline expand. Do not push the
  entire conversation away.
- For unknown languages or highlighter failure, fall back to plain monospace with the
  same header/actions.

Diff and patch rules:

- Render file diffs as structured `path + summary + hunk` views, not unparsed wall text.
- Use add/remove gutter signs and subtle green/red backgrounds that work in Strict
  Daylight.
- Keep line numbers optional and compact; avoid turning small diffs into a full IDE pane.
- Pair syntax highlighting with diff highlighting when cheap; fall back to plain diff
  when parsing fails.
- Keep generated edit diffs attached to the agent/operation that produced them.

Inline action rules:

- Every code block, diff, file preview, and command output section should support copy.
- File/path rows can support open/reveal only when the action is local and safe.
- Retry/regenerate belongs to the owning turn or operation, not to arbitrary markdown
  text.
- Feedback actions can exist on final answers, but not on every operation row.

### Conversation Motion And Microinteractions

Ling's conversation UI should feel alive because work state is changing, not because
decorative motion is layered on top. Motion is a semantic state cue.

Useful references:

- assistant-ui's thread surface: auto-scroll, composer accounting, attachments, conditional
  states, and scroll-to-bottom affordance.
- Vercel AI Elements / Streamdown: streaming-safe markdown, code block headers, output
  containers, and status-aware AI UI components.
- Motion for React: layout transitions, presence transitions, gestures, and reduced-motion
  handling.

Motion principles:

- Animate state transitions, not content volume. If a block grows because output streams,
  keep the anchor stable and avoid jumping the viewport.
- Prefer small opacity/translate/layout transitions over scale, bounce, or large motion.
- Active work may shimmer or pulse subtly; completed content must become still.
- New blocks should enter quietly. They should not steal focus unless they require user
  action.
- Collapsed/expanded detail should animate height/opacity only when the content is small
  enough to avoid jank. Large logs, diffs, and file previews should snap or use a capped
  container.
- All non-essential motion respects `prefers-reduced-motion: reduce`.

Recommended motion map:

| UI event | Motion | Duration | Reduced motion |
| --- | --- | --- | --- |
| assistant/coordinator text streaming | subtle caret or inline "typing" presence; no bouncing dots | continuous while streaming | static pending text |
| active operation starts | row fades/slides in by 4px and enters active tone | 120-180ms | immediate state change |
| operation updates in place | content crossfade or text replacement without row remount | 100-160ms | immediate text replacement |
| operation succeeds/fails/blocks | active shimmer stops; status tone settles | 120-200ms | immediate tone change |
| agent span appears | compact row fades in under coordinator context | 120-180ms | immediate row |
| parent work cell expands/collapses | height + opacity transition with preserved scroll anchor | 160-220ms | instant expand/collapse |
| approval appears | blocking row enters with stronger focus ring and no decorative bounce | 120-180ms | static focus ring |
| artifact/image thumbnail appears | placeholder crossfades into thumbnail after load | 120-200ms | immediate image |
| code block commits | syntax color fades in after streaming completes | 100-160ms | immediate highlight |
| diff hunk expands | opacity + slight y transition for hunk body | 120-180ms | instant |
| scroll-to-bottom button appears | fade in/out near composer | 120-160ms | static show/hide |
| in-turn preview/lightbox opens | focused overlay/preview fades in; background does not parallax | 120-200ms | instant open |

Do not use:

- decorative background orbs, bokeh, or animated gradients;
- bouncing typing dots that run forever;
- avatar swarms, flying cards, or large multi-agent choreography;
- animation that hides approvals, checks, command output, or operation evidence;
- automatic movement lasting more than a few seconds without a pause/stop/hide path.

### Spatial And Interaction Polish

The conversation needs a few small product-grade interactions in addition to animation:

- Stable turn anchors: user message stays visually connected to the assistant work below
  it even as blocks stream.
- Smart auto-scroll: follow active work only when the user is already at the bottom; show
  a scroll-to-latest affordance otherwise.
- Hover/focus action bars: copy, open, download, retry, edit/fork, and feedback appear on
  demand without crowding the transcript.
- Selection-safe code blocks: selecting code should not trigger row collapse or drag.
- Keyboard navigation: Tab reaches approvals, action bars, preview close, copy buttons,
  and composer controls in a predictable order.
- Optimistic feedback: copy/open/download actions show a short inline confirmation that
  disappears without adding a transcript row.
- Loading placeholders: use content-shaped skeletons only for attachments/images/previews,
  not for final assistant text.

### Conversation Polish Micro-Specs

These details are small, but they prevent the conversation surface from feeling
unfinished.

#### Toast And Inline Feedback

Use inline feedback first. Toasts are for cross-surface or background events.

| Event | Feedback surface | Copy |
| --- | --- | --- |
| copy code/diff/output | inline label near the action | `已复制` for 1200-1800ms |
| open local file/artifact | inline label if action succeeds | `已打开` |
| download artifact | inline label or browser download affordance | `已开始下载` |
| retry failed operation | owning operation row | `已重新排队` |
| queued follow-up | active operation row and composer status | `已加入队列` |
| background task completes while user is elsewhere | toast plus turn anchor action | `{task} 已完成` + `查看` |
| background task fails or blocks | toast only if user is not viewing the turn | `{task} 需要处理` + `查看` |

Rules:

- Do not create transcript rows for copy/open/download feedback.
- Do not show a toast for events already visible in the active turn.
- Toasts appear bottom-right on desktop and above the composer on mobile.
- Toast actions focus the owning conversation turn, not a drawer.
- Error toasts include one action at most: `查看`.

#### Keyboard Shortcut Discoverability

Shortcuts should be discoverable without adding permanent instructional text to the
conversation.

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Enter` | submit composer |
| `Shift+Enter` | newline |
| `Esc` | close preview, cancel active menu, or blur action bar |
| `Cmd/Ctrl+K` | focus channel/search command surface when available |
| `Cmd/Ctrl+Shift+C` | copy focused code/diff/output block |
| `J` / `K` | move between transcript blocks when the feed has keyboard focus |
| `E` | expand/collapse focused evidence block |
| `R` | retry focused failed operation when allowed |

Discoverability rules:

- Show shortcut hints in tooltips and command palette entries, not as visible transcript
  text.
- The composer may show a faint submit hint only when focused and empty.
- All shortcut-only actions must also have visible mouse/touch affordances.

#### Mobile Composer Gestures

Mobile should keep the composer simple and avoid hidden destructive gestures.

Rules:

- Swipe down on an open preview closes the preview.
- Dragging the composer handle expands/collapses composer height when multiline text
  exists.
- Long-press on a message/code block opens the action menu.
- Horizontal swipe must not delete messages, cancel work, or approve actions.
- Stop/interrupt and approvals require explicit buttons, never gesture-only actions.
- Attachment tray opens from an icon button; drag/drop is desktop-only.

#### Empty State

Empty states should be quiet and task-oriented, not marketing panels.

Channel with no messages:

```text
开始一个任务或问题
```

Optional compact suggestions:

- `让 Ling 检查这个项目`
- `上传文件并总结`
- `创建一个执行计划`

Rules:

- Empty state uses one short title and at most three compact suggestion buttons.
- Do not describe multi-agent internals.
- Do not show hero art, large cards, animated backgrounds, or product-tour copy.
- Once the first user message exists, the empty state disappears completely.

#### Screenshot And Image Compare Viewer

Design, QA, and visual-regression workflows need a focused compare surface.

Viewer modes:

- single image preview;
- before/after side-by-side;
- slider comparison;
- diff overlay when generated by tooling;
- metadata strip: filename, dimensions, source operation, timestamp.

Rules:

- Viewer opens from the owning artifact row or image thumbnail.
- Default width fits the transcript column; full-screen compare is an explicit action.
- Pan/zoom is allowed in full-screen mode only.
- Comparison controls are icon buttons with tooltips.
- Do not crop by default. Preserve aspect ratio and show full image first.
- The viewer never replaces agent operation evidence; it is a preview of one artifact.

#### Code Block Theme Tokens

Code blocks should feel like Ling, not a pasted IDE.

Token guidance:

| Token | Light value guidance |
| --- | --- |
| background | `#F7F7F8` or near-neutral app surface |
| border | `#E5E5E5` |
| header background | slightly darker neutral, not blue/purple |
| line number | muted gray |
| token keyword | restrained blue |
| token string | restrained green |
| token number | muted violet or blue-gray |
| token comment | muted gray, italic optional |
| diff add | soft green background plus `+` gutter |
| diff remove | soft red background plus `-` gutter |
| focus ring | system focus token, visible against code background |

Rules:

- Keep line height around 1.55 for code and 1.45 for logs.
- Font: use a readable mono stack; do not scale code with viewport width.
- Header contains language, path when known, copy action, and optional open action.
- Avoid high-saturation themes and dark code islands inside Strict Daylight unless the
  whole app is in dark mode.

#### Command Output Folding Threshold

Command output must be useful without flooding the conversation.

Default inline limits:

| Output type | Default inline limit | Expansion |
| --- | --- | --- |
| successful command output | 5 lines or 800 chars | `展开输出` |
| failed command output | 12 lines or 1600 chars, prioritizing error tail | `展开完整错误` |
| build/test summary | summary lines plus failed test names | link to artifact/raw detail |
| install logs | hidden unless failed or user asked | raw/debug detail |
| watch/server logs | latest 5 meaningful lines while active | raw/debug detail |
| binary/huge output | no inline body | artifact/download metadata |

Rules:

- Preserve the beginning and error tail for failures; collapse middle sections with
  `...`.
- Strip ANSI only after preserving semantic colors where safe.
- Never append every stdout chunk as a new row.
- Full output opens through explicit raw/debug detail from the same operation row.
- Copy action on collapsed output copies the visible excerpt by default; full-copy is an
  explicit secondary action.

### Framework Hardening Specs

These are the remaining framework-level details worth borrowing from mature design
systems. They should be treated as non-visual product quality requirements.

#### Accessibility And Focus Management

Borrow from React Aria, Radix Primitives, and Primer: accessibility is a behavior layer,
not an afterthought.

Rules:

- Every interactive transcript control has a visible keyboard focus state.
- Focus returns to the triggering element after preview, menu, popover, or modal close.
- Approvals, destructive actions, and missing-input prompts trap focus only while modal.
- Expand/collapse controls use real buttons with `aria-expanded`.
- Code block copy buttons, file open buttons, image preview close buttons, and action
  menus have accessible names.
- Live updates use polite announcements only for user-actionable changes such as
  approval needed, blocked, failed, or completed. Do not announce every streaming token.
- Keyboard navigation order follows transcript order, then action bar, then preview.
- Touch, mouse, keyboard, and screen reader activation paths must trigger the same action
  semantics.

Do not:

- rely on color alone for status;
- hide approvals behind hover-only controls;
- remove focus outlines to make the UI look cleaner;
- make gesture-only actions on mobile.

#### Internationalization And Text Resilience

Ling is Chinese-first but must not assume short English labels.

Rules:

- Every status label, action label, tooltip, empty state, and toast is translated through
  i18n keys, not hard-coded inside components.
- Button text must survive long Chinese and English strings without overlap.
- Use icons for compact actions where possible, with accessible tooltip labels.
- Avoid fixed-width text containers for status copy; use wrapping or truncation with
  tooltip only when the full text is non-essential.
- Timestamps, durations, numbers, and file sizes use locale-aware formatting.
- Do not infer logic from localized copy.

#### Long Conversation Performance

Long active channels must remain usable.

Rules:

- Virtualize or window transcript blocks once the rendered block count becomes large.
- Preserve stable anchors so virtualization does not break "focus owning turn" actions.
- Avoid syntax highlighting huge code blocks synchronously on the main thread.
- Defer image decoding and large preview rendering until the preview is visible.
- Keep active operation rows mounted while running, even if older completed rows are
  virtualized.
- Memoize projector output by turn/block ids and active revision.
- Do not re-render the whole transcript for stdout chunks; update the owning block.

Initial thresholds:

| Case | Threshold |
| --- | --- |
| transcript virtualization candidate | 200 rendered blocks or 100 turns |
| syntax highlight async/deferred | code block over 300 lines or 24KB |
| image lazy load | all images outside the viewport |
| raw/debug payload preview | never eager-rendered |

#### Design Token Governance

The transcript should not accumulate one-off colors and spacing.

Token families:

- `--ling-bg-panel` / `--ling-bg-subtle`
- `--ling-text-default` / `--ling-text-muted` / `--ling-text-soft`
- `--ling-border-default` / `--ling-border-focus`
- `--ling-action-selection` / `--ling-action-accent`
- `--ling-status-success` / `--ling-status-warning` / `--ling-status-danger`
- `--ling-bg-code` / `--ling-border-strong`
- `--ling-status-success-bg` / `--ling-status-danger-bg`
- `--ling-border-default` for agent guide lines

Rules:

- Component CSS consumes the shared `--ling-*` semantic tokens, not route-local aliases or ad hoc hex colors.
- Status color tokens must pass contrast checks in light and dark modes.
- Code and diff colors are part of the conversation token set, not a separate embedded
  IDE theme.
- Spacing uses the app spacing scale: 4, 8, 12, 16, 24, 32.
- Border radius stays 8px or less unless an existing shared token says otherwise.

#### Component Fixtures And Visual Regression

Borrow from Storybook-style component QA: complex conversation states need stable
fixtures, not manual eyeballing.

Required fixtures:

- plain answer;
- streaming answer;
- running operation;
- completed operation with artifacts;
- failed command with folded output;
- approval waiting;
- requirement shaping with multiple participants;
- serial multi-agent;
- parallel multi-agent;
- image artifact and compare viewer;
- long code block;
- malformed diff fallback;
- mobile composer with attachment tray;
- reduced-motion mode;
- Chinese and English long-label variants.

Testing rules:

- Each fixture has desktop, narrow, and mobile viewport screenshots.
- Include at least one dark-mode fixture if dark mode remains supported.
- Run accessibility checks on component fixtures and key e2e flows.
- Visual snapshots should cover hover/focus states for action bars and approvals.
- Regression tests assert that conversation-owned artifacts do not appear in a right
  drawer.

### Shared Conversation UI Package Boundary

Ling should build a shared conversation UI library, but not a generic app-wide UI kit in
the first step. The shared package exists because channel chat, teammate private chat, and
future Desktop/PC surfaces must render the same conversation semantics.

Layering target:

```text
packages/contracts
  ConversationTranscript DTOs

packages/core
  ConversationTranscript projector

packages/conversation-ui-core
  headless transcript types, renderer registry, action contracts, token names

packages/conversation-ui-react
  React components for Web and Electron/Tauri renderer

apps/web
  channel/private-chat assembly, routes, daemon API wiring

apps/desktop
  native shell, daemon lifecycle, notifications, platform menu
  consumes the same transcript and React UI where practical
```

Package responsibilities:

| Layer | Owns | Must not own |
| --- | --- | --- |
| `contracts` | serializable transcript DTOs, preview refs, action refs | React components, CSS, browser APIs |
| `core` | projection from channel/workflow/task/run records into transcript | app routing or DOM state |
| `conversation-ui-core` | headless UI model, renderer registry, design token contract, action contracts | daemon storage, API calls, app shell layout |
| `conversation-ui-react` | transcript renderer, operation rows, agent spans, composer primitives, previews, action bars | channel-specific data fetching, private-memory policy, daemon mutation logic |
| `apps/web` | channel/private assembly, route state, daemon/API client wiring | duplicated transcript rendering logic |
| `apps/desktop` | native shell, OS notifications, file picker, keychain, window/menu behavior | forked conversation semantics |

Initial extraction should be conservative:

1. Keep existing `apps/web/src/shared/conversation` as the staging area.
2. Split components internally by `transcript`, `blocks`, `composer`, `preview`,
   `feedback`, `tokens`, and `fixtures`.
3. Move pure types/helpers to shared packages only after channel and private chat both use
   the same APIs.
4. Extract `packages/conversation-ui-core` before `conversation-ui-react` if dependency
   direction gets unclear.
5. Desktop consumes the shared transcript contract first, then reuses React components if
   the chosen shell supports it cleanly.

Surface-specific adapters:

| Surface | Shared | Adapter-specific |
| --- | --- | --- |
| Channel | transcript blocks, operation cells, artifacts, approvals, composer primitives | channel title, membership, channel route, channel context actions |
| Private chat | message rows, attachment strip, evidence panel, composer primitives, scroll-to-latest | teammate identity, private memory scope, direct reply intervention controls |
| Desktop | transcript DTOs, renderer registry, tokens, most React components if Electron/Tauri WebView | OS notifications, keychain, file picker, menu/tray, native window treatment |
| CLI | transcript DTOs and display/expanded/raw modes | terminal renderer, ANSI width, keyboard bindings |

Token and style sharing:

- Shared package exports token names and semantic class names.
- Web owns CSS implementation initially.
- Desktop may provide a platform-specific theme, but it maps to the same token contract.
- No component may depend on channel-only CSS selectors for core layout.

Do not extract yet:

- app shell navigation;
- right-side workspace utility;
- channel membership/task lists;
- teammate settings;
- daemon API clients;
- policy decisions about private memory/context.

## Complete UI Layer Contract

The missing layer is not another runtime abstraction. It is a Web UI projection layer
that turns existing conversation, workflow, run, approval, artifact, and teammate records
into a Codex-style transcript with Ling-specific multi-agent actors.

The target feed shape is deliberately heterogeneous:

```text
ConversationTurn
  UserMessageCell
  LingAgentTranscript
    blocks: TranscriptBlock[]
```

`TranscriptBlock` is an ordered stream. It can contain coordinator text,
assistant text, operation cells, agent activity spans, approval cells, artifact strips,
and raw/detail references. A block appears only when the underlying semantic event needs
that user-facing shape. Do not pad every turn into the same set of headings.

For single-agent work, a possible rendering is:

```text
User: 创建一个 login.html...

Ling Agent
可以，先创建 login.html，并做一次基础检查。

读取项目结构和现有入口 ˅
创建 login.html ˅
运行 2 条检查命令 ˄
  Searched for login.html | package.json | src in workspace
  Read package.json
  $ node --check login.html

login.html 已创建，检查通过。
产物 login.html · 变更 1 个文件 · 检查 2 项通过
```

For serial multi-agent work, a possible rendering is:

```text
Ling Agent
这个任务交给 Engineer 实现，QA 做验收。

Engineer
  查看项目结构 ˅
  修改 login.html ˅
  运行检查 ˄

QA
  验证页面 ˅
  截图检查 ˅

login.html 已创建，检查通过。协作队友：Engineer、QA。
```

For parallel multi-agent work, the default feed shows one compact branch per active
teammate and only the latest active row for each branch:

```text
Ling Agent
拆成两个并行任务：Engineer 实现，QA 准备验收。

Engineer
  正在修改 login.html

QA
  正在准备检查清单
```

The user's default reading path is the coordinator narrative and the latest state. When
the owning work cell is open, each participating agent's semantic operation rows remain
visible under the corresponding `AgentActivitySpan` without a second disclosure layer.

These examples are illustrative only. They must not become string templates or parser
rules. The UI structure comes from the semantic projection, not from matching phrases
such as `确认需求` or `完成`.

### Requirement Shaping Presentation

Requirement shaping is internal proposal evidence. Once a proposal exists, its compact
proposal summary is the only default feed object. Requirement shaping must not render as
a second operation cell, collaboration card, or raw teammate transcript.

Target shape:

```text
ConversationTurn
  UserMessageCell
  LingAgentTranscript
    ProposalSummary
      assignee avatar
      task title
      assignee
      product status
      open-task action
    DecisionNeededRow?  # only when the user must answer a real question
```

The proposal remains backed by requirement contribution/shaping packets and source refs.
The default feed shows only the decision object:

- The proposal assignee owns the summary identity. Resolve its avatar from
  `assigneeTeammateId` through the same teammate projection used by conversation rows;
  do not reuse the source message author or reserve an empty avatar gutter.

```text
Design a read-only README check · Engineer · Pending confirmation · View task
```

`Requirement shaping`, `coordinated`, internal teammate ids, participant contribution
summaries, and raw packet metadata stay in evidence/debug detail. When clarification is
required, a compact decision-needed row shows the actual user question without exposing
the shaping process.

Conversion rule:

```text
requirement_shaping cell
  -> user approves or edits scope
  -> workflow proposal / ChannelWorkflow
  -> same turn links or mutates into collaboration_task/workflow operation cell
```

This keeps the user's mental model stable: one request, one visible work object, one
evidence trail.

### Existing Agent Operation Preservation

The current channel UI already shows useful per-agent operation evidence inline: agent
label, approval request, generated diff artifact, check result, evidence section, shell
command, and bounded command output. Multi-agent UI work must preserve that behavior.

Concrete rule from the current product surface:

```text
Ling Agent
  Docs · Approve file edit: index.html
    artifact: Generated edit diff
    checks: 1 passed
    evidence: Approve file edit

Ling Agent
  QA · Approve shell command: open index.html
    checks: 1 passed
    evidence: shell command and bounded output
```

These rows are not optional diagnostics. They are normal user-facing operation evidence.

Preservation rules:

- Do not remove existing per-agent operation rows when introducing requirement shaping,
  branch spans, or workflow progress cells.
- Do not move command/file/check/approval evidence exclusively into the right drawer.
  Normal audit must remain available through inline expansion in the owning conversation
  cell.
- Running, waiting-for-approval, and blocked work cells stay expanded enough to show each
  participating agent's current operation, approval, command, check, or artifact row.
- Terminal work cells may collapse after completion, but expanding the parent shell must
  restore every participating agent's operation rows without another agent-level click.
- Completed operation rows may be summarized, but their generated artifacts, approvals,
  checks, and bounded command output remain reachable inline from the same turn.
- Agent labels and ownership must remain visible. If `Docs` requested a file edit and
  `QA` requested a shell command, the UI must not merge both into an anonymous generic
  workflow row.
- Existing artifact strips and evidence groups remain attached to the agent or operation
  that produced them.
- Raw ids, full JSON, and unbounded logs can stay in raw/debug detail, but user-meaningful
  operation evidence stays in the conversation path.

Disclosure policy:

```text
running / waiting_for_approval / blocked
  -> keep participating agent operation rows visible inline

succeeded / failed / cancelled
  -> collapse the parent work cell to summary by default
  -> parent expansion restores agent rows, artifacts, approvals, checks, and output
```

This is different from hiding raw internal agent chatter. The UI should filter private
reasoning and noisy event spam, but it must keep user-facing operations and evidence.

## Raw Event Normalizer

The normalizer is the only layer allowed to understand raw runtime vocabulary. It consumes
daemon/channel/workflow/run records and produces semantic UI inputs.

```ts
type RawEventSource =
  | "message"
  | "intent_router"
  | "target_resolver"
  | "workflow"
  | "run"
  | "tool"
  | "file"
  | "approval"
  | "artifact"
  | "sub_agent"
  | "requirement_shaping"
  | "memory"
  | "interruption";

interface RawEventEnvelope {
  readonly id: string;
  readonly source: RawEventSource;
  readonly occurredAt: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly agentId?: string;
  readonly payload: unknown;
}

interface NormalizedOperationInput {
  readonly turnId: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly actorRole: "coordinator" | "agent" | "tool" | "system";
  readonly semanticKind: OperationKind;
  readonly status: OperationCellStatus;
  readonly displayText: string;
  readonly evidenceRefs: readonly string[];
  readonly rawEventIds: readonly string[];
}
```

Normalizer rules:

- Group events by user turn first, then operation, then actor.
- Use stable semantic operation ids, not raw event ids, as React keys.
- Collapse start/progress/complete events for the same operation into one active cell.
- Preserve every raw event behind `rawEventIds`; do not lose auditability.
- Convert internal vocabulary into user-facing verbs before it reaches React.
- Treat stale, duplicate, and out-of-order events as evidence unless they change the
  current user-facing state.
- Keep `intent_router` and `target_resolver` output internal by default. Surface it only
  when it changes the user's next action, for example "needs confirmation" or "cannot
  resolve target".

## Raw Event Mapping Table

| Raw input | Normalized output | Default feed | Expanded detail | Raw/debug access |
| --- | --- | --- | --- | --- |
| user message committed | `UserMessageCell` | user text | attachments and referenced files | original message metadata |
| coordinator text delta/final | `CoordinatorMessageCell` | natural reply or final result | related operation link | raw model item when debug is enabled |
| intent/router decision | evidence on turn | hidden | route rationale only if user asked | classifier scores, candidates, payload |
| workflow created/updated | `OperationCell` / `plan` row | `已规划 N 步` | semantic steps | workflow JSON, ids |
| requirement shaping started/updated | proposal evidence | proposal summary status; actual unanswered question only | task confirmation or editor | contribution packets, participant records, raw selector metadata |
| run started/progress/completed | active `OperationCell` mutation | current task state | row history | run events, attempt ids |
| tool call start/output/end | `OperationRow` | `读取文件`, `运行检查`, `搜索文档` | command/tool summary and bounded output | full stdout/stderr, tool JSON |
| file read/context packet | `read` row or evidence ref | hidden unless it explains action | file names, snippets if useful | packet payload, context ids |
| file write/patch/artifact | `edit` row plus `ArtifactStrip` | changed file summary | inline changed-file summary; full preview/diff can open result review | raw patch, artifact metadata |
| approval requested/resolved | `ApprovalCell` | waiting/approved/denied state | command/action and risk context | policy payload, request ids |
| sub-agent spawned/updated/completed | `AgentActivitySpan` | agent label and latest action | semantic process rows under the agent span | raw sub-thread events only |
| memory surfaced | memory evidence row | hidden unless it affects answer | memory title/source | raw memory ids and scoring |
| queued follow-up | active operation row | `Queued follow-up` | queued text preview | continuation request payload |
| interrupt/redirect | active operation state | `Stopped and redirected` | lineage and reason | cancellation/run lineage events |

## Codex-Inspired Disclosure Levels

Codex has more than `HistoryCell`, but the conversation feed should borrow these specific
UI layers:

| Layer | Ling translation | Default visibility |
| --- | --- | --- |
| committed history cells | committed user/coordinator/operation rows | visible |
| active cell | one mutable active operation per running span | visible, mutates in place |
| transcript detail | inline expanded operation, agent, source, and artifact detail | collapsed |
| bottom pane / composer | input, queue follow-up, interrupt/redirect, approval affordances | visible near composer |
| approval / ask user surfaces | explicit authority or missing-input requests | visible when blocking |
| artifact/status surfaces | product files, changed files, checks, active status | compact summary |

`OperationCell` remains the main Ling equivalent of a Codex `HistoryCell`, but Ling adds
`Actor` and `AgentActivitySpan` so multi-agent work does not become either raw internal
chat or a separate collaboration card system.

## Codex Source Alignment

The Codex source review on 2026-06-16 creates these Ling design constraints. These are
framework rules, not visual-copy rules.

| Codex source area | Observed mechanism | Ling rule |
| --- | --- | --- |
| `chatwidget.rs` | `active_cell` mutates while a tool/stream is in flight, then `flush_active_cell()` inserts the finalized cell into history. | A running operation updates the same `OperationCell`; terminal state commits the same cell instead of appending a replacement summary. |
| `chatwidget/transcript.rs` | `TranscriptState` owns `active_cell`, `active_cell_revision`, turn flags, and copyable agent markdown. | Keep turn state separate from visible copy. Do not infer UI structure by matching generated coordinator text. |
| `chatwidget/turn_lifecycle.rs` | `agent_turn_running` is derived turn state, independent of any one history cell or overlay. | Running popover/composer affordances derive from turn lifecycle and active cells, and must clear when the turn finishes. |
| `history_cell/mod.rs` | Each `HistoryCell` provides `display_lines`, `raw_lines`, and optional `transcript_lines`. | Every Ling cell needs display, expanded, and raw/detail render contracts. The main feed cannot be the raw/debug surface. |
| `exec_cell/model.rs` | `ExecCell` stores command calls keyed by `call_id`; output chunks append to that call; `complete_call` records output and duration. | Command/tool/file/check operations must have stable operation ids and update their own state in place. Stdout chunks update evidence, not the feed row list. |
| `exec_cell/render.rs` | Exec display switches `Running` to `Ran`/`You ran`; read/list/search calls coalesce into `Exploring`/`Explored`; tool output defaults to bounded lines. | Low-level exploration commands group under semantic rows. User-meaningful commands get compact rows with bounded inline output and full raw detail elsewhere. |
| `history_cell/search.rs` | `WebSearchCell` changes `Searching the web` to `Searched the web` by toggling cell state. | Lightweight browser/search/memory cells use the same status mutation pattern: running label becomes terminal label on the same row. |
| `pager_overlay.rs` | Transcript overlay owns committed cells plus a cached live tail derived from the current active cell; cache key changes on revision/animation/width. | Inline expanded detail can include live active detail, but it must not duplicate the main transcript. Raw/debug detail surfaces must refresh when a cell mutates if they are explicitly open. |
| `chatwidget/streaming.rs` | Assistant text deltas stream through a controller, then consolidate into one final markdown cell; reasoning deltas update status, not transcript. | Coordinator/assistant prose is streamed text inside the same turn transcript, not fixed start/end cards. Internal reasoning/status must not become default conversation rows. |

The transferable model is:

```text
raw event
  -> semantic cell route
  -> active mutable cell
  -> terminal committed cell
  -> display / expanded / raw render modes
```

The non-transferable part is Codex's terminal UI implementation. Ling should not clone
Ratatui layout, terminal keybindings, or English labels such as `Running` and `Ran`.

## Cell Render Contract

Every user-facing cell supports three render modes. Components may style these modes
differently, but they may not invent extra default content outside this contract.

```ts
interface ConversationCellRender {
  readonly display: DisplayLine[];
  readonly expanded?: ExpandedDetail;
  readonly raw?: RawDetailRef;
}

interface DisplayLine {
  readonly icon?: string;
  readonly text: string;
  readonly tone?: "normal" | "muted" | "success" | "warning" | "danger";
  readonly isActive?: boolean;
}

interface ExpandedDetail {
  readonly sections: readonly EvidenceSection[];
  readonly defaultOpenSectionIds: readonly string[];
}

interface RawDetailRef {
  readonly detailTarget: string;
  readonly rawEventIds: readonly string[];
}
```

Render-mode rules:

- `display` is the default transcript. It must be short, stable, and user-readable.
- `expanded` is semantic detail. It can show command names, bounded output, changed files,
  checks, approvals, and branch summaries.
- `raw` is developer/support detail. It owns full JSON, raw events, provider metadata,
  ids, stdout/stderr, and packet payloads.
- Copy/export can choose `display`, `expanded`, or `raw`; the default user copy should not
  include raw event spam.
- Search should index `display` and selected `expanded` fields first; raw fields are debug
  search only.

## Surface Placement Contract

| Surface | Owns | Must not own |
| --- | --- | --- |
| Main conversation feed | user messages, coordinator narrative, operation display rows, active cell, final summary, artifact strip, attachments, links, approvals, checks, source summaries, and conversation-owned artifact/file/diff preview entry points | raw event logs, duplicate collaboration cards, workflow/run ids |
| Floating run popover | current running state, active actor, elapsed time, interrupt affordance, latest one-line action, compact source icons while active | full transcript, raw output, historical collaboration record |
| Inline expansion | semantic evidence needed for normal audit: operation steps, commands, bounded output, files, checks, approvals, agent process rows, source summary, packet/evidence summaries, source/link details, and preview entry points | unbounded logs, JSON dumps, provider metadata |
| In-turn preview / lightbox | larger file, image, diff, artifact, source, or approval preview opened from the owning conversation row | conversation timeline, operation process transcript, copied coordinator text |
| Optional right-side workspace utility | non-conversation settings, global workspace tools, non-conversation file browser, or explicit developer/support raw inspector | conversation timeline, agent operations, operation evidence, attachments, links, source lists, workflow/packet summaries, result review, file/diff/artifact previews from a conversation turn |
| Source summary strip | compact evidence sources from tools, web, memory, files, and apps | operation history, raw events, internal helper tools |
| Modal / blocking view | approval, missing input, permission change, destructive confirmation | passive status or historical logs |
| Composer active-work affordance | normal send, queue follow-up, stop-and-redirect | hidden prompt injection or implicit interruption |

Placement rules:

- The same fact has one default surface.
- If main feed display already says an operation completed, the floating popover hides or
  moves to idle state.
- If inline expansion already exposes semantic evidence, do not add a second conversation
  drawer path for the same evidence. File/diff/artifact/source/approval detail opens from
  the owning conversation row as an in-turn preview, lightbox, or explicit raw/debug
  inspector.
- If a modal is blocking, status surfaces may stay visible but should not compete with the
  blocking decision.
- If multiple agents are active, the floating popover summarizes the coordinator view and
  the main feed shows bounded `AgentActivitySpan` rows.

## Visual Contract

The accepted visual target is:

- design system: `Ling Stack Strict Daylight UX v3 - Channel Drawer v1.24`;
- Stitch project: `projects/3112180709682189824`;
- Stitch screen reference: `频道会话 - Strict Codex Transcript v1`;
- style: Strict Daylight, pure white surfaces, Inter typography, monochrome hierarchy;
- sidebar: the locked v3 Chinese Ling Stack sidebar;
- conversation body: borderless transcript, not a dashboard or card stack.

Default conversation feed rules:

- User messages may use compact bubbles.
- Coordinator messages are plain text with the Ling Agent identity.
- Operation group rows are muted inline rows with a small icon and disclosure chevron.
- Expanded operation detail is indented text; it is not a panel.
- Command output may use one compact code block because it is evidence output.
- Active cells update in place; they do not append a new card or toast for every event.
- Agent spans use small labels, avatars, and faint lane lines, not cards.
- Reasoning, intent, and action narration render as separate outer note rows. Operation titles stay compact, while expanded operation detail is reserved for paths, commands, output counts, and local diffs; it must not repeat action `title`, `summary`, or scope narration.
- Artifact strips may have a very light product affordance; operation logs may not.
- Workflow packet metadata is audit evidence, not conversation content. Context packets,
  output packets, fan-in summaries, packet counts, and packet ids stay out of the default
  transcript and remain available only through explicit workflow evidence or developer
  diagnostics. Real user-facing files still render in the artifact strip below the final
  report.
- A resolved approval-only workflow is also audit evidence when every step is terminal,
  every step is backed only by a resolved workflow-step approval, no run was created, and
  no TerminalReport exists. The conversation must not render a Work Cell, elapsed time,
  recovery summary, checks, or attention rows for that workflow. Pending approvals remain
  visible and actionable until the user resolves them.
- Conversation-owned result review, file/diff/artifact preview, source metadata, checks,
  approvals, attachments, and links stay in the main conversation through inline
  expansion or in-turn previews. A right-side workspace utility, if present, is not a
  conversation/evidence surface.
- Do not show `workflow`, `run`, `work-unit`, `packet`, `attempt`, selector ids, raw
  event labels, provider metadata, token budgets, or JSON in the default feed.

The feed must avoid four-layer repetition:

```text
Coordinator message
+ collaboration card
+ right drawer duplicate
+ raw event log
```

The intended replacement is:

```text
Coordinator narrative
+ operation/agent transcript rows
+ expandable evidence
+ artifact strip
```

## Transcript Visual Polish v4 Addendum

This addendum captures the approved follow-up direction from the Strict Daylight v3 /
Strict Codex Transcript v4 mockup. It is a UI-layer patch, not a new information model.

### Inline Operation Detail

`OperationCell` detail belongs in the main transcript. The default row is compact; the
expanded state reveals semantic process rows in place.

Rules:

- Expand/collapse happens on the operation row itself.
- Expanded content is indented transcript text, not a bordered panel, card, or drawer.
- Commands, tool calls, file modifications, checks, approvals, bounded output excerpts,
  source counts, and agent process rows can appear inline.
- Completion freezes the same `OperationCell` as a committed folded row. The final
  coordinator summary is appended after it; it must not replace it.
- Normal audit should be possible without opening the right drawer.
- Full raw payloads, provider metadata, ids, unbounded logs, and complete stdout/stderr
  remain explicit raw/debug access.

### Result Summary And Artifact Strip

The terminal transcript must show useful outputs in the same turn, immediately after the
coordinator terminal text.

Default shape:

```text
产物 1 · 变更 3 个文件 · 检查 4 项通过

产物
  login.html  HTML · 已创建
  login-preview.png  图片 · 1280×720

变更
  apps/web/src/login.html  +86 -0
  apps/web/src/styles/login.css  +24 -0
```

Rules:

- Show the compact result summary in the conversation; it must not depend on any drawer
  being opened.
- Artifact rows are plain transcript rows with small type/icon affordances, not chips or
  cards.
- Changed-file rows can show path, action, and concise diff stats.
- Check rows can show status and command/check name.
- Diff artifacts are generated with at most three unchanged lines before and after each
  changed range. Ranges separated by six or fewer unchanged lines merge; wider gaps stay
  separate and show the number of omitted unmodified lines. Context lines remain neutral
  and do not affect `+additions -deletions` counts.
- Full file preview, diff review, generated artifact preview, and audit/review detail
  open from the owning conversation row as inline expanded detail, an in-turn preview, or
  a lightbox. They must not move the user into a right drawer to understand the result.

### Inline Image And Screenshot Preview

Images and screenshots produced by a task are first-class transcript artifacts.

Rules:

- Show a small inline thumbnail under the result/artifact section.
- Thumbnail size is constrained and stable; it must not push text into overlap or resize
  the transcript during load.
- Clicking a thumbnail opens a larger preview/lightbox with filename, dimensions when
  available, close action, and optional open/download action.
- The lightbox is a preview surface, not a second transcript or progress surface.
- Images should not also be listed in a conversation drawer. The inline thumbnail and
  lightbox are the normal review path for images produced by the turn.

### Active Shimmer Motion

Use shimmer / scanning highlight / breathing shimmer only to indicate active work.

Rules:

- Apply to active status text or the active operation row background mask only; do not
  animate completed rows, artifacts, final summaries, images, or the full transcript.
- Cycle: `3000ms` total, about `800ms` left-to-right sweep and `2200ms` rest.
- Visual weight: very light neutral highlight on Strict Daylight surfaces. It should feel
  like a subtle breathing status, not a loading skeleton.
- Running state examples: active coordinator thinking line, active `OperationCell`, active
  agent latest-action row, and floating popover latest-action text.
- Terminal transition removes shimmer on the same row when state changes to succeeded,
  failed, blocked, cancelled, or interrupted.
- Respect `prefers-reduced-motion: reduce` by disabling the sweep and using static tone
  or spinner state instead.

### Conversation-Owned Detail Boundary After v4

The main conversation page owns all conversation artifacts and evidence:

- user messages and Ling Agent narrative;
- active and completed agent operation rows;
- approvals, checks, shell/file edit evidence, and bounded command output;
- attachments, links, generated artifacts, changed files, image thumbnails, and previews;
- source summaries, packet summaries, requirement shaping notes, conflicts, and decisions.

The normal inspection path is inline expansion from the owning transcript row. Larger
previews open as in-turn previews or lightboxes. Explicit raw/debug detail can be opened
from developer/support affordances, but it is not a normal user reading path.

A right-side workspace utility, if kept, must not own:

- conversation timeline;
- agent operations or operation process transcript;
- attachments or links from a conversation;
- evidence lists from a conversation;
- workflow/packet summaries required to understand the turn;
- result review, file preview, diff preview, artifact preview, checks, approvals, or
  source metadata for a conversation turn;
- copied coordinator start/final text;
- a root `Progress` page.

## User-Facing Cell Roles

| Role | Default feed behavior | Detail behavior |
| --- | --- | --- |
| `UserMessageCell` | durable user message | attachments and file refs can expand inline |
| `CoordinatorMessageCell` | Ling Agent narrative, plan, clarification, or final result | no raw logs; links to the related operation when needed |
| `OperationCell` | one compact task/process cell, active or terminal | expands to semantic operation rows and evidence |
| `AgentActivitySpan` | one compact latest-action row per participating teammate | expands to prior semantic actions and evidence refs |
| `ApprovalCell` | visible only when user authority is needed | expands to command/action payload and policy context |
| `SourceSummaryStrip` | compact source icons in active popover or inline detail surfaces | expands inline or in metadata detail to source names, urls, tool/app metadata, and related operation refs |
| `MemoryCitationFooter` | compact used-memory footer under the owning coordinator/agent message | expands to memory title, scope, source refs, recall policy, and used-memory event ids |
| `EvidenceDetail` | collapsed by default inside the owning transcript row | exact files, commands, bounded outputs, checks, approvals, source refs; raw events, JSON, and logs only through explicit raw/debug access |

`Workflow`, `Run`, `WorkUnit`, `Attempt`, `Packet`, and `RouteDecision` are data model
and audit terms. They should not appear as default UI labels in the main feed.

Memory citations and source summaries follow
[Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md).
Memory citation is answer evidence. Source summary is context inventory. OperationCell is
execution evidence.

## Coordinator Message Contract

Ling Agent is the coordinator and user-facing narrator. Its messages are for:

- confirming scope when the user needs confidence that work started correctly;
- asking a clarification when intent or safety is unclear;
- explaining a blocked state in human terms;
- summarizing the final result and next action.

Ling Agent messages are not for:

- repeating operation status already shown in an `OperationCell`;
- listing every specialist step;
- telling the user to open a separate evidence drawer when inline evidence already exists;
- exposing workflow, run, work-unit, packet, or selector ids.

Rules:

- A user turn with executable work renders one `ConversationTurnAssistantTranscript`.
  The start copy, operation cell, and terminal copy are segments inside the same Ling
  Agent transcript row. They must not render as two separate Ling Agent replies with
  duplicated avatar/header chrome.
- A started task should not create both a coordinator "start" message and a separate
  "work started" cell unless the coordinator message carries meaningful planning or
  safety context.
- A completed task should have one final result surface. Prefer a terminal
  `CoordinatorMessageCell` plus the same task's terminal `OperationCell`, not multiple
  completion reminders.
- If the `OperationCell` summary already says the task completed, the coordinator
  message should add outcome information, not repeat counts.

## Ling Agent Copy Canon

Ling Agent copy follows the same product principle as the cell model: default text should
describe the user's task, current action, result, or required decision. It should not
describe the UI system itself.

Core rules:

- Use concise Chinese first. Keep English only for product, file, command, model, provider,
  and teammate names.
- First-person wording is allowed when it is the most natural user-facing sentence.
- Do not use empty self-announcement or explain the UI mechanism, for example
  `细节放在折叠证据里`, `主会话会同步状态`, or `查看右侧抽屉了解完整细节`.
- Do not expose internal nouns in default copy: `workflow`, `run`, `work-unit`, `packet`,
  `attempt`, `raw event`, selector ids, provider metadata, token budgets, or JSON.
- Use active, observable verbs: `确认`, `拆分`, `交给`, `读取`, `修改`, `运行`, `检查`,
  `等待`, `完成`, `阻塞`, `取消`, `中断`.
- Keep status text stable while active cells mutate. Prefer replacing the row body over
  appending new near-duplicate lines.
- If a fact already appears in an operation row, coordinator copy should add judgement or
  result, not repeat the same status.

Message examples, not required prefixes:

| Situation | Pattern | Example |
| --- | --- | --- |
| Scope context | natural acknowledgement or plan, only when useful | `可以，先创建 login.html，并做一次基础检查。` |
| Safe delegation | natural delegation sentence | `实现交给 Engineer，验收交给 QA。` |
| Parallel split | compact split sentence | `拆成两个并行任务：Engineer 实现，QA 准备验收。` |
| Clarification | direct question | `登录页是否要接入真实 API？` |
| Blocked | reason plus next action | `缺少写入权限。批准后继续修改文件。` |
| Waiting approval | action that needs authority | `等待审批：运行 pnpm install。` |
| Completed | result and useful verification | `login.html 已创建，检查通过。` |
| Interrupted | what changed and what follows | `已按新的方向停止当前处理。` |
| Cancelled | cancellation result | `已取消，未继续运行检查。` |

No implementation may parse these strings to decide whether a message is start,
terminal, delegated, or blocked. That structure must come from turn/cell metadata.

Operation row copy:

| Operation kind | Running | Succeeded | Failed/blocked |
| --- | --- | --- | --- |
| `plan` | `规划步骤` | `已规划 {n} 步` | `规划受阻：{reason}` |
| `read` | `读取项目结构` | `已读取 {target}` | `无法读取 {target}` |
| `edit` | `修改 {file}` | `已修改 {count} 个文件` | `修改失败：{reason}` |
| `run_command` | `运行 {command}` | `检查通过` or `命令完成` | `检查失败：{command}` |
| `search` | `搜索 {target}` | `已搜索 {target}` | `搜索失败：{reason}` |
| `approval` | `等待审批：{action}` | `审批已通过` | `审批被拒绝` |
| `verify` | `检查 {target}` | `{count} 项检查通过` | `{count} 项检查失败` |
| `handoff` | `{agent} 处理中` | `{agent} 完成` | `{agent} 阻塞：{reason}` |
| `watch` | hidden by default | hidden by default | `监控发现问题：{summary}` |

Surface-specific copy rules:

| Surface | Copy shape | Max default length | Forbidden |
| --- | --- | --- | --- |
| Coordinator message | natural sentence, result-oriented | 1-3 short sentences | empty self-announcement, UI explanation, raw ids |
| Operation row | verb + object + state | one line | paragraphs, raw stdout, JSON |
| Agent span | `{agent} · {latest action}` | one line per agent | full agent transcript by default |
| Floating run popover | `{actor} · {elapsed} · {latest action}` | one line plus optional action icon | history, logs, completed summaries |
| Inline expanded detail | semantic evidence bullets | bounded section | unbounded logs, provider metadata |
| Explicit raw/debug detail | technical labels and exact payloads | folded sections | repeated coordinator summary |
| Approval modal | action + scope + consequence | title plus options | vague `continue?` prompts |

Approval copy must be explicit, for example `等待审批：运行 pnpm install`.

Pending runtime approval decisions are owned by a shared blocking dialog outside the
Composer and virtual transcript. `ApprovalCell` owns only the compact pending marker and
the immutable approved/denied history after resolution. Channel, normal conversation,
and teammate private chat must not render approval action cards inside their Composer.
The dialog handles one decision at a time, preserves the existing risk/time order, and
cannot be dismissed without approve or deny.

When the dialog owns a pending approval, the owning `OperationCell` is replaced by one
non-interactive marker that uses the same localized action sentence. It cannot expand
and cannot expose approval titles, raw permission ids, evidence groups, request ids, or
duplicate approval controls. This rule is a projection boundary, not a CSS visibility
rule. Complete data remains available in explicit Run detail and audit surfaces.

Bad approval copy:

```text
是否继续？
处理权限请求
执行操作
```

Examples to reject in review:

```text
主agent：主会话会同步关键状态和最终结果。
协作记录：workflow run work-unit 已完成。
查看右侧抽屉了解完整细节。
当前 raw event packet 已写入。
Agent finished task successfully.
```

Accepted replacements:

```text
Ling Agent：可以，先创建 login.html。
Engineer：正在修改 login.html。
QA：等待实现完成后验收。
Ling Agent：login.html 已创建，检查通过。协作队友：Engineer、QA。
产物 login.html · 变更 1 个文件 · 检查 2 项通过
```

Copy regression rules:

- Snapshot tests should pin coordinator start, active operation, blocked, approval,
  completed, interrupted, multi-agent parallel, and inline-detail/preview-open states.
- E2E checks should reject visible default text containing `workflow`, `run`, `work-unit`,
  `packet`, `raw event`, `attempt`, `selector`, or JSON braces in the main feed.
- Tests should assert no visible UI-mechanism coordinator phrasing in generated UI fixtures.
- Tests should assert inline detail, previews, and any raw/debug inspector do not duplicate
  the coordinator final summary.

## OperationCell Model

`OperationCell` is the Web translation of Codex's `HistoryCell` idea. It is not a raw
event row. It is a semantic projection of lower-level records.

```ts
type OperationCellStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

type OperationKind =
  | "plan"
  | "read"
  | "edit"
  | "run_command"
  | "search"
  | "approval"
  | "verify"
  | "handoff"
  | "watch";

interface OperationCell {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly coordinatorMessageId?: string;
  readonly title: string;
  readonly status: OperationCellStatus;
  readonly displayLabel: string;
  readonly terminalLabel?: string;
  readonly summary: string;
  readonly activeOperation?: OperationRow;
  readonly operationRows: readonly OperationRow[];
  readonly agentSpans: readonly AgentActivitySpan[];
  readonly evidenceSummary: EvidenceSummary;
  readonly evidenceKey: string;
  readonly updatedAt: string;
}

interface OperationRow {
  readonly id: string;
  readonly kind: OperationKind;
  readonly status: OperationCellStatus;
  readonly label: string;
  readonly activeLabel?: string;
  readonly terminalLabel?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly evidenceKey?: string;
}

interface AgentActivitySpan {
  readonly id: string;
  readonly teammateName: string;
  readonly roleLabel?: string;
  readonly status: OperationCellStatus;
  readonly currentAction?: string;
  readonly resultSummary?: string;
  readonly evidenceKey?: string;
}
```

The UI can derive this model from current workflow, run, approval, artifact, and
legacy collaboration records before adding new storage. Labels are state-derived:
`activeLabel` renders while running, and `terminalLabel` replaces it on the same row
after success, failure, cancellation, or blocking.

## OperationCell Micro-Spec

`OperationCell` is a transcript group, not a card. It should feel like a compact CLI/TUI
history cell adapted to Web typography.

The assistant-ui-inspired visual treatment for this cell is defined by
[Conversation Surface Contract](./conversation-surface-contract.md).
That document supersedes the older "no outer border" visual rule when implementing the
next visual polish slice: an `OperationBubble` may use a subtle inline shell, status chip,
hover/focus action bar, and folded tool-like sections, but it remains the same
`OperationCell` semantic object and must keep all evidence inline. Large code, diff,
image, raw/debug, measured-height, and deep virtualization behavior is defined separately
in [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md).

Geometry:

| Token | Value | Rule |
| --- | --- | --- |
| row min-height | 28px | compact transcript row; do not grow on hover |
| row vertical gap | 2px | adjacent operation rows stay visually connected |
| group top gap | 8px | separates operation group from coordinator text |
| icon slot | 16px | status icon only; no colored badge container |
| chevron slot | 16px | shown only when expanded detail exists |
| content indent | 24px | expanded detail aligns under row text, not under icon |
| nested indent | 16px | command output, files, checks, and branch details |
| max row width | parent text column | do not stretch into drawer gutter |

Default row structure:

```text
[status icon] [label text] [muted metadata] [chevron]
```

No outer border, no card background, no pill button, no shadow. Hover may only reveal a
subtle text color change and focus outline for keyboard users.

State visual table:

| Status | Icon guidance | Text tone | Motion | Chevron behavior |
| --- | --- | --- | --- | --- |
| `queued` | `Clock3` or hollow dot | muted | none | available if detail exists |
| `running` | spinner or pulsing dot | primary | subtle spinner only | available; active row stays in place |
| `waiting_for_approval` | `CircleAlert` | warning text only | none | detail opens approval context |
| `blocked` | `OctagonAlert` | warning/danger | none | detail opens reason and next action |
| `failed` | `CircleX` | danger | none | detail opens failed check/output |
| `cancelled` | `Ban` | muted | none | detail opens lineage if useful |
| `succeeded` | `CircleCheck` | muted success | none | detail opens evidence |

Operation kind icon table:

| Kind | Suggested icon | Example label |
| --- | --- | --- |
| `plan` | `ListChecks` | `规划 3 步` |
| `read` | `FileSearch` | `读取项目结构` |
| `edit` | `PencilLine` | `修改 login.html` |
| `run_command` | `Terminal` | `运行 pnpm typecheck` |
| `search` | `Search` | `搜索相关文件` |
| `approval` | `ShieldCheck` | `等待审批：运行 pnpm install` |
| `verify` | `BadgeCheck` | `检查通过` |
| `handoff` | `Users` | `Engineer 处理中` |
| `watch` | `Activity` | hidden unless it changes next action |

Chevron rules:

- Collapsed rows use a right-facing chevron.
- Expanded rows use a down-facing chevron.
- Rows with no semantic detail do not show a chevron.
- Clicking the row label or chevron toggles expansion.
- Keyboard focus uses the row as one target; Enter/Space toggles expansion.
- Running rows can be expanded, but expansion must not create new active rows.

Expanded detail order:

```text
Operation row
  Summary
  Commands
  Files
  Checks
  Approvals
  Artifacts
  Agent branch details
```

Section limits:

| Detail section | Default max | Overflow behavior |
| --- | --- | --- |
| summary | 2 lines | truncate with ellipsis |
| commands | 3 commands | remaining commands counted |
| command output | 5 lines per command | full output through explicit raw/debug access |
| changed files | 6 files | remaining files counted |
| checks | 5 checks | show failed checks first |
| approvals | 3 decisions | most recent first |
| artifacts | 4 items | remaining artifacts counted |
| agent activity history | latest 3 semantic actions per agent | older semantic actions stay folded under the same agent span |
| raw event ids | hidden | explicit raw/debug access only |

Command detail shape:

```text
  $ pnpm typecheck
    0 errors
    completed in 2.4s
```

File detail shape:

```text
  修改 login.html
  新增 apps/web/src/login.html
```

Check detail shape:

```text
  检查通过 pnpm typecheck
  检查失败 pnpm test --filter login
```

Update behavior:

- `running` mutates the same row text and status icon.
- Running labels and terminal labels are two states of the same row. Example:
  `正在连接浏览器` becomes `已连接浏览器`; it must not append a second row.
- New semantic actions append under the same `OperationCell` only when they are new
  user-visible steps.
- Raw stdout chunks do not append rows. They update bounded command output in expanded
  detail or raw detail.
- `succeeded`, `failed`, `blocked`, `cancelled`, and `interrupted` are terminal for the
  visible row unless a linked redirect creates a new operation.

Command/tool row rules:

- User-meaningful commands can show one command row in the transcript.
- Read/list/search commands should coalesce into an exploration/read-context row unless
  one command changes the user's next action.
- Command output is bounded in inline expanded detail. Full stdout/stderr, exit code,
  raw command array, environment, and call ids belong in explicit raw/debug access.
- Output chunks mutate the command row's evidence; they do not create visible rows.
- Completion records duration and status on the same row.

## AgentActivitySpan Micro-Spec

`AgentActivitySpan` makes multi-agent work visible without turning each teammate into a
separate default transcript.

Default row structure:

```text
[avatar] [agent name] [status] [latest action]
```

Visual rules:

- Use a faint vertical lane line only when two or more agent spans are visible.
- Agent rows are not cards and do not have individual backgrounds.
- Avatar size is 20px; name uses label text; latest action is body text.
- Agent headers remain static while the parent work cell body is visible.
- Failed or blocked agents remain visible until coordinator summary resolves the task.

Display variants:

| Variant | Default display | Detail behavior |
| --- | --- | --- |
| single delegated agent | show agent label only if delegation matters | operation rows remain primary |
| serial agents | show completed prior agent and active current agent | all emitted operation rows stay visible in order |
| parallel agents | show participating agents in stable order | all emitted operation rows stay visible under each agent |
| completed collaboration | parent shell collapses to the final summary | parent expansion restores every agent history |
| direct teammate chat | teammate owns the conversation surface | not an `AgentActivitySpan` |

Ordering rules:

- Preserve the first semantic appearance order of participating agents inside the
  workflow transcript. Status changes may change row tone, but they must not reorder
  spans by severity, state, or label.
- The coordinator terminal line uses the same agent order as the visible
  `AgentActivitySpan` rows.

State table:

| Agent status | Default text | Visibility |
| --- | --- | --- |
| queued | `{agent} · 等待开始` | visible only if parallel plan was announced |
| running | `{agent} · {latest action}` | visible and mutable |
| waiting_for_approval | `{agent} · 等待审批` | visible until resolved |
| blocked | `{agent} · 阻塞：{reason}` | visible and emphasized |
| failed | `{agent} · 失败：{summary}` | visible until coordinator handles it |
| cancelled | `{agent} · 已取消` | visible only if user initiated or affects result |
| succeeded | `{agent} · {result summary}` | visible whenever the parent work cell is expanded |

Latest-action update rules:

- Each agent has one mutable latest-action line.
- Tool/event spam updates evidence, not the latest-action line, unless it changes the
  user's understanding of progress.
- If an agent emits a useful assistant summary, use that as `resultSummary`.
- If an agent only emits tool activity, synthesize a semantic action from the tool kind.
- Do not show raw agent internal reasoning by default.
- Completion changes the row state; it does not delete or independently fold the agent's
  process. Historical semantic actions remain visible whenever the parent work cell is
  expanded.
- Do not surface generic internal step verbs as user-facing latest actions. `Consult`,
  `Review`, `Coordinate`, `Coordinated`, `Reviewed`, and `flagged_risk` are fallback
  implementation labels, not conversation copy.

History folding:

```text
Engineer · login.html 已创建
  查看项目结构
  修改 login.html
  检查通过
```

Lifecycle:

```text
running:
Engineer
  正在修改 login.html

completed, parent collapsed:
已处理 2m 18s

completed, parent expanded:
Engineer
  查看项目结构
  修改 login.html
  运行检查
```

Coordinator message projection:

- Start and terminal coordinator messages are semantic display bodies in the default
  transcript. Generated request text such as `开始 workflow: ... Smoke ID: ...` is not
  repeated back to the user.
- Start copy confirms scope and delegation.
- Terminal copy reports the result and, when applicable, the teammate names.
- Raw coordinator message text can remain reachable through audit/detail surfaces, but
  not in the default conversation reading path.

History limits:

- show all bounded semantic actions emitted for the visible work cell;
- keep failed/blocked action pinned even if older;
- show changed files and checks before raw tool events;
- each operation row expands only its own bounded detail;
- raw sub-thread transcript is raw/debug access only.

Parallel behavior:

- Sort active agents by coordinator-declared order, not event arrival order.
- If more than 3 agents are active, show the first 3 plus `另有 {n} 个队友处理中`.
- The floating run popover summarizes the coordinator state, not every agent.

## Floating Run Popover Micro-Spec

The floating run popover is an ambient status surface. It is not a drawer, transcript, or
collaboration record.

Default shape:

```text
[spinner/status] {actor} · {elapsed} · {latest action} [stop]
```

Placement:

- Desktop: top-right of the channel work area, never covering the composer.
- Optional right-side utility open: hide the popover or reduce it to a one-line header
  status in the channel chrome; do not show both full popover and another active-progress
  surface.
- Mobile: collapse into the composer status strip.

State behavior:

| Operation state | Popover behavior | Primary action |
| --- | --- | --- |
| no active work | hidden | none |
| queued | hidden unless user has queued follow-up | edit queued input |
| running | visible | stop/interrupt |
| waiting_for_approval | visible but points to approval surface | review approval |
| blocked | visible until user sees blocker | resolve blocker |
| failed | visible briefly, then main feed owns failure | view failed row |
| cancelled | hide after terminal feed row commits | none |
| succeeded | hide after final summary/artifact strip commits | none |

Content rules:

- Show one actor. For single-agent work use the executing agent. For multi-agent work use
  `Ling Agent` when coordination is the useful state, or the specific active agent when
  only one branch is currently changing.
- Latest action is one short phrase, not a sentence.
- Inline details max at one extra line; do not show command output.
- Elapsed time updates without changing layout width significantly.
- Completed state must not linger as a second success message.

Actions:

| Action | When visible | Behavior |
| --- | --- | --- |
| stop/interrupt | `running`, `waiting_for_approval`, `blocked` when interruptible | opens confirmation only if destructive or multi-agent fanout is active |
| queue follow-up | when composer has draft during active work | queues continuation; visible in active `OperationCell` |
| redirect | after user chooses stop-and-redirect | creates linked continuation operation |
| view approval | `waiting_for_approval` | focuses approval surface |
| view result/files | after terminal result when files, diffs, screenshots, or review details exist | opens inline result detail, file/diff preview, or lightbox from the owning conversation row |
| raw/debug detail | only from explicit developer/support affordance | opens raw/debug detail |

Do not put `workflow`, `run`, raw ids, stdout, or agent history in the popover.

## Conversation-Owned Result Detail Micro-Spec

Completed result review, files, links, source metadata, approvals, checks, and artifacts
are conversation-owned details. They must not move into a right drawer as the normal
reading path.

Detail pages are opened from explicit artifact, file, approval, review, source-metadata,
or raw/debug actions on the owning transcript row. The surface can be inline expanded
detail, an in-turn preview, a lightbox, or an explicit developer/support inspector. It is
not a conversation drawer, root tab, or second timeline.

Result detail structure:

```text
结果详情
  Files / Links
  Diff / Preview
  Checks
  Approvals
  Artifacts
  Sources
  Raw/debug refs
```

Field rules:

| Section | Allowed fields | Forbidden |
| --- | --- | --- |
| Files / Links | path/url, action, diff stats, artifact link, preview availability | copied artifact strip as the whole page |
| Diff / Preview | rendered image/file preview, text diff, binary metadata | operation process transcript |
| Checks | command/check name, status, duration, failure excerpt | full unbounded logs |
| Approvals | action, scope, decision, actor, timestamp | vague approval labels |
| Artifacts | name, type, size, preview availability | duplicate artifact strip copy |
| Sources | source label, type, target URL/file/app/tool metadata, related operation refs | repeated source explanations from coordinator text |
| Raw/debug refs | event id, source, timestamp, JSON payload | visible by default in normal conversation detail |

Copy rules:

- Detail titles use nouns: `文件变更`, `预览`, `审核`, `审批详情`, `Raw detail`.
- Internal ids may appear only inside folded raw sections.
- Detail should not repeat the final result sentence if the main feed already has the
  final summary.
- Exact command/output text appears in normal inline evidence only when bounded; full
  command/output text requires explicit raw/debug detail. Normal file/review previews
  should not become command transcripts.

Navigation rules:

- Opening a file, result review, source metadata, or raw/debug detail preserves the
  owning conversation turn anchor.
- Closing an in-turn preview or lightbox returns focus to the triggering transcript row.
- Opening preview/detail does not hide existing agent operation rows.
- Mobile previews may become full-screen sheets, but they keep the same
  conversation-owned content contract.

Duplication guard:

- If text appears in `CoordinatorMessageCell.display`, it should not appear verbatim in
  detail Summary.
- If an operation row appears in the main feed, no preview/detail surface should show a
  Timeline that copies the same row. Use inline expansion for semantic operation history.
- If inline expanded detail shows command output, file/review previews should not
  duplicate it. Full command output is raw/debug detail only.
- If an artifact strip lists files, the preview/detail path should open the selected
  preview/diff, not repeat the same list as its first visible section.

## Event-To-Operation Mapping

The main feed maps implementation events into stable semantic rows:

| Lower-level input | Operation row | Default copy |
| --- | --- | --- |
| workflow compiled | `plan` | `已规划 3 步` |
| file read / context packet | `read` | `已读取项目上下文` |
| file write / patch artifact | `edit` | `已修改 README.md` |
| command start/end | `run_command` | `已运行 pnpm typecheck` |
| web/search/tool lookup | `search` | `已搜索文档` |
| approval requested | `approval` | `等待审批` |
| approval resolved | `approval` | `审批已通过：写入 README.md` |
| test/check artifact | `verify` | `检查通过：web typecheck` |
| specialist step started | `handoff` branch row | `Docs 正在审阅` |
| watcher/monitor event | `watch` | hidden unless it changes next action |

Default row text must be user-readable and short. Raw command strings, stdout, JSON,
stack traces, provider metadata, token budgets, packet ids, and event ids go into
`EvidenceDetail`.

## Status Copy Canon

Codex's TUI does not treat `active`, `queued`, and `done` as default transcript
copy. Those states drive a cell lifecycle, while the visible row uses a semantic
verb phrase owned by that cell:

- search: `Searching the web` mutates into `Searched the web`;
- command: `Running <cmd>` mutates into `Ran <cmd>`;
- grouped context gathering: `Exploring` mutates into `Explored`;
- the bottom running indicator stays short, usually `Working`, and only adds
  concise details when they help the user interrupt or inspect the task.

Ling should follow the same rule in localized product copy:

| Internal lifecycle | Default transcript copy | Meta/status chip |
| --- | --- | --- |
| queued/open | `等待开始：{semantic action}` only when no better action exists | hidden by default |
| running/claimed | `正在{semantic action}` or the latest action text | hidden by default |
| waiting_for_approval | `等待审批：{approval/action}` | visible until resolved |
| blocked | `阻塞：{reason/action}` | visible |
| failed | `未完成：{reason/action}` | visible |
| cancelled/superseded | `已停止：{action}` | visible only when it affects outcome |
| succeeded/skipped | `{semantic action}` or `已完成：{action}` when no action verb exists | hidden by default |

Implementation rules:

- `Done`, `Active`, `Queued`, and `Completed` are internal lifecycle words, not
  default row copy for the main transcript.
- A row should not show both a semantic title and a generic status chip when the
  title already communicates the state.
- `AgentActivitySpan.stateLabel` is reserved for waiting, blocked, failed, or
  cancelled states. Running and completed spans rely on the latest action row.
- Operation row `meta` is reserved for approval/failure/blocker diagnostics,
  command snippets, or bounded evidence hints. It must not repeat lifecycle enum
  values.
- The same row may mutate from running wording to terminal wording. Completion
  freezes the row; it does not append a second `Done` row.

## Active Lifecycle

Operation cells follow a single mutable lifecycle:

```text
user message committed
-> operation cell created as queued/running
-> operation rows and AgentActivitySpan rows mutate in place
-> evidence bundle grows behind the disclosure
-> terminal status commits once
-> final coordinator summary appears or updates
```

Rules:

- Active work updates the existing `OperationCell`; it does not append a new runtime row
  for every event.
- A running command, tool, approval, or specialist step may change the current row in
  place.
- Completion should commit the same cell, not create a second completion surface.
- Late/stale completion events are evidence only when the visible state has already moved
  to cancelled, interrupted, or superseded.

## Multi-Agent Branch Display

Multi-agent work should be visible as branches inside the operation, not as independent
chat bubbles. This is an information-architecture rule, not a requirement to clone any
specific product UI.

Default branch row:

```text
Docs       完成       已审阅 README 文案
Engineer   运行中     正在修改 API client
QA         等待       等待实现完成后验收
```

Expanded branch detail:

```text
Docs
  result summary
  changed files
  checks
  evidence links
  raw detail only if requested
```

Rules:

- Specialist teammates can be visible, but they do not own the top-level conversation
  unless the user directly chats with that teammate.
- The final answer is synthesized by Ling Agent unless the user explicitly asks for
  separate specialist opinions.
- Branch rows should use user-facing roles such as `Docs`, `Engineer`, `QA`, `Security`,
  not internal workflow step ids.
- Watchers and monitors are hidden by default. They surface only when they block, fail,
  request approval, or change the next action.

## Evidence Detail

Evidence is still first-class, but it is not first-level conversation.

Inline folded evidence can show:

- changed files;
- checks;
- approval decisions;
- compact agent activity outputs;
- artifact links;
- context/evidence counts.

Deep detail can show:

- command and stdout/stderr;
- raw run event stream;
- workflow packet JSON;
- provider/model metadata;
- token budget and context trim diagnostics;
- raw artifacts and logs.

Conversation detail behavior:

- Use inline expansion for normal evidence and in-turn previews/lightboxes for
  completed result review, file/diff/artifact preview, links, sources, and approval
  detail.
- Do not make a right drawer the only way to inspect evidence already available in inline
  transcript detail.
- Do not render a separate "open work evidence" button inside an operation group that
  already has expandable evidence summary.

## Source Summary Strip

Codex Desktop's environment popover has a useful pattern: it summarizes sources from
structured turn items, not from assistant prose. Ling should use the same idea without
copying the exact UI.

`SourceSummaryStrip` is an evidence summary, not a transcript cell that explains progress.
It answers "what external or contextual sources were involved?" with compact icons and
tooltips.

Source inputs:

| Input event | Source kind | Default icon | Detail target |
| --- | --- | --- | --- |
| MCP/tool call from a user-meaningful server | `tool` or `app` | app logo, plugin icon, or tool glyph | tool detail, MCP server metadata, related operation |
| web search/open page/find in page | `web` | globe | browser/open url, web search detail |
| memory recall or project memory citation | `memory` | memory glyph | memory citation detail |
| file/doc/image attachment or referenced workspace file | `file` | file glyph | file preview or artifact detail |
| generated artifact used as context | `artifact` | artifact glyph | artifact detail |

Filtering rules:

- Do not show internal helper tools as sources: `node_repl`, projector/internal daemon
  helpers, raw shell wrappers, setup/cleanup glue, event normalizers, or hidden model
  routing helpers.
- Do not infer sources from coordinator text. Sources come from structured event,
  attachment, memory, tool, browser, and artifact records.
- Deduplicate by stable semantic key: tool server/app id, normalized URL, memory id,
  workspace file path, or artifact id.
- Prefer user-facing names from plugin/app metadata. If no metadata exists, use a short
  sanitized server or host label. Raw ids appear only in explicit raw/debug detail.
- Keep failed or cancelled source attempts only when they affected the user-visible result
  or blocker.

Lifecycle:

```text
turn started
  -> sourceRefs empty
tool/web/memory/file event observed
  -> append or update sourceRef on the owning operation/agent span
active popover
  -> shows compact source icons while the turn is active
turn completed
  -> sourceRefs freeze as committed evidence summary
source metadata detail
  -> shows source name, type, target, related operation, and raw detail ref
```

Placement:

- Main feed does not show a standalone `Sources` card.
- Operation expanded detail may show a short source count or inline icon strip when it
  helps normal audit.
- The right floating popover may show compact icons because it is already an active status
  surface.
- Source metadata detail opens from the owning transcript row as inline detail or an
  in-turn preview. It must not live in a conversation drawer, and it must not repeat the
  main transcript, OperationCell rows, AgentActivitySpan history, or final coordinator
  result.
- Used-memory detail belongs to the owning message's single memory citation disclosure
  first. Its expanded content is an unframed reference list: no nested card, repeated
  heading, repeated count, or second disclosure. Source summary may count memory as a
  source group, but must not duplicate the disclosure contents.

## User Input During Active Work

The composer has three distinct behaviors while an operation is active:

| User intent | UI action | Runtime behavior |
| --- | --- | --- |
| ordinary new topic | `Send new message` | creates a new conversation turn |
| add guidance after current work | `Queue follow-up` | creates a queued continuation request |
| stop current direction | `Stop and redirect` | interrupts/cancels source work and starts linked continuation |

Rules:

- Do not silently inject text into an active run.
- Do not make normal Send an implicit interrupt.
- If the active runtime cannot accept steering, queue or restore the user input with a
  visible state.
- The active `OperationCell` should show pending queued follow-ups or redirect state in
  one compact row.

## Deduplication Rules

One fact should have one default surface.

Do not show:

- a coordinator start message plus a workflow started row plus a run started row for the
  same fact;
- a coordinator completed message plus a legacy collaboration completion surface plus a
  raw run terminal row with the same summary;
- a right drawer button that duplicates an inline evidence disclosure;
- subagent completion reminders when the branch row already shows `完成`;
- blank completed shell/code execution rows.

Keep visible:

- a concise final result;
- blocked reason;
- approval needed;
- failed/cancelled/interrupted state;
- which teammate or branch owns visible work;
- changed files and check counts;
- the next action the user can take.

## Implementation Slices

Phase 1 implementation is limited to the core message framework:

```text
ConversationTranscriptTurn
  -> coordinator text blocks
  -> OperationCell blocks
  -> AgentActivitySpan blocks
  -> terminal text blocks
  -> ArtifactStrip blocks
```

P0-P8 and the main-feed parts of P11 belong to Phase 1. P9 and P10 are later surface
work. They must consume the transcript model after it is stable; they must not define the
message structure or become a workaround for missing operation/agent history.

### P0. Normalizer Contract

Add a pure projection normalizer before React rendering. It accepts raw event envelopes and
returns semantic UI inputs without changing storage.

Acceptance:

- raw workflow/run/tool/sub-agent events are grouped by turn, operation, and actor;
- UI components receive no raw `workflow`, `run`, `work-unit`, `packet`, or router labels
  for default display;
- duplicate start/progress/completion events collapse into one active operation model;
- raw event ids remain reachable through `RawDetailRef`.

### P1. Projection Model

Add a `ConversationOperationCellViewModel` builder that derives operation cells from
existing workflow, run, approval, artifact, and legacy collaboration data. Keep all raw
records unchanged.

Acceptance:

- a workflow/run pair produces one operation cell;
- no raw `workflow`, `run`, or `work-unit` labels are shown in the default feed;
- terminal workflow and terminal run summaries dedupe into one task surface.

### P2. Active Cell Updates

Route active workflow/run updates into one mutable conversation cell.

Acceptance:

- command/tool/approval progress updates the same visible cell;
- no extra runtime rows appear for routine events;
- stale completions do not override cancelled/interrupted visible state.

### P3. AgentActivitySpan Projection

Render participating teammates as compact `AgentActivitySpan` rows inside the operation
cell.

Acceptance:

- multi-agent work shows agent status without separate teammate chat spam;
- expanding the parent work cell shows every agent's semantic process rows inline;
- agent headers do not create a second disclosure layer;
- final Ling Agent summary synthesizes the result.

### P4. Evidence Detail Boundary

Move command output, raw events, JSON, provider metadata, and logs into
`EvidenceDetail`.

Acceptance:

- default feed remains readable with collapsed evidence;
- expanding the operation row/group shows enough file/check/artifact detail for normal
  audit;
- explicit raw/debug access is still available for support and developer diagnostics.

### P5. Composer Active-Work Actions

Expose ordinary send, queued follow-up, and stop-and-redirect as distinct actions.

Acceptance:

- user text during active work is not silently injected;
- queued follow-up is visible on the active operation;
- interrupt redirect preserves lineage and evidence.

### P6. Copy And Regression Guard

Add UI tests/smoke checks for the no-duplication and copy-canon contracts.

Acceptance:

- no `Open work evidence` button appears when inline evidence exists;
- one terminal task produces at most one coordinator final message and one operation
  cell;
- no raw event spam appears in the default channel feed;
- multi-agent completion does not add duplicate completion reminders;
- default feed copy contains no visible `workflow`, `run`, `work-unit`, `packet`,
  `attempt`, `selector`, or `raw event` labels;
- coordinator fixtures contain no UI-mechanism phrasing such as `主会话会同步状态` or
  `查看右侧抽屉了解完整细节`;
- conversation detail/preview fixtures do not repeat the coordinator final summary.

### P7. OperationCell Microstructure

Replace card-like workflow/run displays with the borderless transcript row structure.

Acceptance:

- operation groups render without outer border, card background, pill shell, or shadow;
- each row has a stable icon slot, label text, optional muted metadata, and optional
  chevron;
- row height, hover state, and active spinner do not cause layout shift;
- expanded detail appears as indented transcript content, not a nested panel;
- command output is bounded to the row limits defined in this document;
- rows with no semantic detail do not show a disclosure affordance.

Expanded detail v1 acceptance:

- detail groups render as transcript sections (`Changed`, `Checks`, `Evidence`,
  `Attention`) with no card border, background, chip shell, or dashboard header;
- group headers may show a short count, but they must not describe UI mechanics or where
  to find deeper logs;
- rows show only user-semantic text by default: file path, check name, failed reason,
  approval state, or bounded output excerpt;
- raw artifact types such as `file`, `diff`, `json`, `log`, and terminal storage names
  are not visible row metadata in the main transcript;
- successful terminal states are represented by the row tone or artifact strip, not by
  visible `succeeded` / `completed` status words;
- if a row title and description are the same apart from owner prefix or punctuation, keep
  one visible line and remove the row chevron;
- evidence links render as plain transcript links; they must not become chips, cards, or
  a second report surface;
- the same fact should not be repeated across coordinator text, operation row, expanded
  row, preview, and raw/debug detail. When duplication is unavoidable in legacy data,
  prefer the most useful semantic surface and hide raw/internal variants.

Command/tool/file detail row v1:

- `ExecutionAction` rows may appear inside expanded `Evidence` when they carry a
  user-meaningful command, file, tool, approval, or output artifact reference.
- Workflow evidence may include `ExecutionAction[]` as a read-model projection from
  linked runs. This is not new workflow storage; it lets workflow transcripts keep the
  same folded command/file/check process rows as thread-backed runs.
- Each action row keeps one default label. Its expanded detail may show up to 5 bounded
  lines:
  - one command line as `$ {command}`;
  - up to 3 file paths touched by the action;
  - one tool/server label when it is user-meaningful;
  - one output summary such as `2 outputs recorded`.
- The inline detail never shows tool call ids, run ids, work-unit ids, artifact ids,
  event ids, raw JSON/log paths, provider metadata, environment variables, or full
  stdout/stderr.
- If more details exist than fit in the 5-line cap, show a count summary instead of
  streaming more rows.
- Failed actions may show the bounded failure summary inline because it changes the
  user's next action. Successful actions should avoid generic `succeeded` copy.

### P8. AgentActivitySpan Rendering

Render multi-agent work as compact agent spans inside the same task transcript.

Acceptance:

- serial work shows only the relevant completed/current teammate rows;
- parallel work shows one mutable latest-action line per active teammate;
- completed teammate history folds to the latest semantic actions and does not emit
  separate completion reminders;
- failed, blocked, or approval-waiting teammates remain visible until the coordinator
  resolves the task;
- more than three active teammates collapse with an overflow count;
- semantic sub-agent process stays inline behind the agent row; raw sub-agent transcript
  is raw/debug access only.

### P9. Floating Run Popover Boundary

Later surface, not Phase 1.

Keep the right floating status surface, but restrict it to ambient active-work state.

Acceptance:

- hidden when no active work exists;
- visible during running, waiting approval, or blocked states;
- hides after final coordinator summary and artifact strip commit;
- shows one actor, elapsed time, one latest-action phrase, and a small action control;
- never shows command output, raw ids, workflow/run labels, or branch history;
- when an optional right-side utility is open, the popover either hides or reduces to a
  channel-header status, but does not duplicate active progress.

### P10. Conversation Detail Boundary

Later surface, not Phase 1.

Keep completed-result review, file/diff/artifact previews, source metadata, checks,
approvals, and packet/evidence summaries attached to the main conversation. A right-side
workspace utility may exist for non-conversation settings/tools, but it is not the
conversation detail surface.

Acceptance:

- active progress remains in the floating popover and durable process remains in the main
  transcript;
- operation process detail expands inline in the transcript;
- file/review previews do not repeat the coordinator final message;
- no detail surface provides a copied operation timeline; semantic operation history
  belongs to inline expansion;
- `Files / Links`, `Diff / Preview`, `Checks`, `Approvals`, `Artifacts`, `Sources`, and
  `Raw/debug refs` follow the field rules above;
- raw ids and JSON are folded by default and never appear in normal conversation detail;
- opening an in-turn preview preserves the owning turn anchor and does not hide agent
  operation rows.

### P11. State Fixture Matrix

Implementation should ship with story fixtures or screenshot fixtures for the states that
caused regressions in this design cycle.

Required fixtures:

| Fixture | Must show | Must not show |
| --- | --- | --- |
| single-agent running | active operation row mutating in place | running modal or duplicate run row |
| single-agent completed | final coordinator result plus terminal operation rows | lingering floating success popover |
| serial multi-agent | coordinator handoff, current agent, folded prior agent | legacy collaboration surface |
| parallel multi-agent | latest action per active teammate | full sub-agent transcripts as default feed |
| waiting approval | approval row and blocking affordance | vague `continue?` copy |
| blocked | human-readable blocker and next action | raw exception as default row |
| interrupted redirect | cancelled source plus linked continuation | hidden prompt injection |
| detail preview open | detail/raw sections only | copied main transcript |
| popover active | one-line active status | command output or branch history |
| artifact result | artifact strip and selected file/detail path | duplicate artifact list in a drawer root |

No unresolved product decisions remain for this design patch. Exact component names,
React file placement, and pixel tuning can be decided during implementation as long as the
surface contracts, copy canon, and no-duplication guards above remain intact.
