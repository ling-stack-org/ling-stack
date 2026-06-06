# Codex-Inspired File And Text Display v1

Status: design baseline for implementation planning
Date: 2026-06-06
Scope: conversation text rendering, local file references, attachments, artifacts,
diff/file-change previews, and evidence drawer drill-downs

## Summary

Ling Stack should borrow Codex's file and text display model at the product and data
shape level, not at the terminal UI level.

The target experience is:

```text
readable conversation text
-> compact file and artifact chips
-> safe inline previews for common text formats
-> folded diff/file-change evidence
-> raw content only in explicit drill-downs
```

The main feed must remain a conversation. Files, tool output, Markdown, logs, JSON, and
diffs should be available in context, but they should not turn the chat surface into a
raw event log or file explorer.

This document extends:

- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Codex-Inspired File And Text Display Implementation Plan](codex-inspired-file-text-display-implementation-plan.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)

## Reference Boundary

References checked on 2026-06-06 against `openai/codex` main commit
`87b808bb570f01f4b6fc8485c5459052fac0e320`:

- `codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`
- `codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts`
- `codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts`
- `codex-rs/tui/src/markdown_render.rs`
- `codex-rs/tui/src/diff_render.rs`
- `codex-rs/tui/src/history_cell/`

Useful Codex ideas:

- one thread item model covers user text, agent text, reasoning, command output, file
  changes, MCP calls, dynamic tools, web search, image view, and image generation,
- user input is structured, so text, images, skills, and mentions are not collapsed into
  one opaque string,
- Markdown rendering treats local file links as first-class workspace references,
- Markdown tables and long token-heavy text get width-aware fallback treatment,
- file changes are represented as structured `path + kind + diff`,
- diff rendering separates summary, file block, line number, gutter sign, wrapped text,
  and optional syntax highlighting.

Ling-specific changes:

- every file, artifact, and diff must preserve workspace/channel/teammate scope,
- private attachment filenames must not leak across channel or teammate boundaries,
- file previews are evidence, not proof the AI consumed the file,
- run artifacts remain daemon-served content under `.ling-stack/artifacts`,
- side-effect authority stays in approvals, not in a preview component,
- multi-teammate ownership must be visible on work summaries and evidence items.

Do not borrow:

- terminal glyph styling as the default Web visual language,
- single-agent assumptions,
- raw `ThreadItem` names as user-facing labels,
- app-server JSON-RPC wholesale,
- automatic AI ingestion of attached or previewed files,
- default display of raw logs, raw tool output, raw prompts, or raw approval payloads.

## Current Ling Anchors

Existing Web code already has partial building blocks:

- `apps/web/src/shared/conversation/MessageRow.tsx`
- `apps/web/src/shared/conversation/ConversationAttachmentStrip.tsx`
- `apps/web/src/shared/conversation/EvidenceDisclosure.tsx`
- `apps/web/src/shared/components/ArtifactRow.tsx`
- `apps/web/src/lib/artifacts.ts`
- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/features/runs/EventRow.tsx`

Existing daemon/core contracts already support:

- channel messages with `body`, `attachmentIds`, and `linkPreviewIds`,
- teammate private messages with `body` and `attachmentIds`,
- channel and private attachment metadata,
- run artifacts with `type`, `path`, `title`, `contentType`, and `sizeBytes`,
- artifact content serving through the artifact content endpoint,
- run events that can announce `artifact_created`.

The missing layer is not storage. The missing layer is a coherent Web presentation
contract for text, file references, previewable artifacts, and file-change evidence.

## Product Principles

### Main Feed Is Not A File Viewer

Default message rows should show:

- human or teammate text,
- compact attachment chips,
- compact artifact chips when the artifact is the conversational object,
- one-line evidence summaries such as `Changed 3 files` or `Preview available`,
- blocked, failed, approval-needed, or permission-denied states.

Default message rows should not show:

- full file bodies,
- full logs,
- full JSON payloads,
- full diffs,
- every command output chunk,
- raw local absolute paths unless explicitly needed for workspace authority.

### Preview Is Evidence

Previewing a file or artifact only means the user can inspect it. It does not mean:

- the teammate has read it,
- the file was added to model context,
- the file is safe to mutate,
- the content is allowed to cross memory or channel boundaries.

If a future "include file in AI context" flow is added, that must be a separate audited
action with explicit inclusion evidence.

### Show Stable User-Facing Names

Visible copy should use:

- display filename,
- relative workspace path when safe,
- artifact title,
- teammate name,
- task/run title,
- status labels.

Raw ids belong in expanded evidence or raw detail views:

- `run_...`,
- `artifact_...`,
- `att_...`,
- event ids,
- tool call ids,
- full filesystem paths outside the active workspace root.

## Target Information Model

The Web layer should derive a display model before rendering any row.

```ts
type ConversationContentKind =
  | "markdown_text"
  | "plain_text"
  | "code"
  | "json"
  | "log"
  | "diff"
  | "image"
  | "pdf"
  | "office"
  | "unsupported";

interface ConversationFileRef {
  readonly id: string;
  readonly source: "attachment" | "artifact" | "workspace_path" | "run_file_change";
  readonly scope: "channel" | "teammate_private" | "run" | "external_work" | "workspace";
  readonly label: string;
  readonly displayPath?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly href?: string;
  readonly previewable: boolean;
  readonly aiIncluded?: boolean;
  readonly redacted?: boolean;
}

interface ConversationTextBlock {
  readonly id: string;
  readonly kind: ConversationContentKind;
  readonly text: string;
  readonly language?: string;
  readonly sourceRef?: ConversationFileRef;
  readonly truncated?: boolean;
  readonly redactionNotes?: readonly string[];
}

interface ConversationFileChange {
  readonly id: string;
  readonly path: string;
  readonly kind: "add" | "delete" | "update" | "rename";
  readonly diff: string;
  readonly status: "in_progress" | "completed" | "failed" | "declined";
  readonly sourceRunId?: string;
  readonly approvalId?: string;
}
```

Rules:

- this display model may be derived from existing tables and events before adding new
  durable tables,
- `ConversationFileRef.scope` must be checked before displaying filenames or content,
- `aiIncluded` defaults to `false`,
- `previewable` is based on content type, size, policy, and current user scope,
- `ConversationFileChange.diff` may come from an artifact, run event, or action preview,
  but the rendered state should be one file-change evidence object.

## Text Rendering

Introduce a shared `MessageBodyRenderer`.

Recommended source:

```text
apps/web/src/shared/conversation/
  MessageBodyRenderer.tsx
  LocalFileLink.tsx
  CodeBlock.tsx
  MarkdownTable.tsx
```

Responsibilities:

- render plain text as paragraphs with stable wrapping,
- render Markdown from assistant/user bodies with a safe allowlist,
- render code fences with language labels and copy actions,
- render local file links as workspace-aware file references,
- render web links as normal external links with safe `rel`,
- keep table content readable on narrow widths,
- never use unsafe HTML rendering for untrusted message text.

Implementation guidance:

- prefer a small Markdown parser dependency only when implementation starts; do not
  hand-roll Markdown parsing beyond trivial plain-text fallback,
- if `marked`, `react-markdown`, `remark`, or `rehype` is introduced, disable raw HTML
  or sanitize it explicitly,
- local file links should render from the destination, not from arbitrary link text,
  matching the Codex principle that transcripts reveal the real file target,
- long paths, URLs, hashes, and JSON keys should wrap without forcing the message row
  wider than the conversation column,
- code blocks and preformatted logs must scroll horizontally only when wrapping would
  destroy readability.

### Local File Links

Supported input forms:

```text
[app.tsx](/abs/path/app.tsx:12)
[/workspace/src/app.tsx](/workspace/src/app.tsx)
src/app.tsx:12
file:///workspace/src/app.tsx
```

Display rules:

- if the target is inside the active workspace root, show a relative path,
- if the target is outside the active workspace root, show a redacted or absolute path
  only when the current scope is allowed,
- preserve location suffixes such as `:12` or `#L12`,
- do not resolve symlinks in the UI renderer,
- clicking opens a drawer preview when supported; otherwise it opens/downloads through
  the safe daemon route.

## Artifact Preview

Introduce a shared `ArtifactPreview`.

Recommended source:

```text
apps/web/src/shared/conversation/
  ArtifactPreview.tsx
  ArtifactPreviewDrawer.tsx
  ArtifactPreviewToolbar.tsx
```

Preview tiers:

| Tier | Content | Default surface |
| --- | --- | --- |
| Chip | all attachments/artifacts | message row or summary row |
| Inline preview | short text, Markdown, JSON, diff, image thumbnail | evidence disclosure |
| Drawer preview | full safe text, image, JSON, diff | right drawer |
| Download/open only | PDF, Office, oversized text, unsupported binary | artifact row action |

Previewable content types:

- `text/plain`,
- `text/markdown`,
- `text/csv`,
- `application/json`,
- `application/x-ndjson`,
- `text/x-diff`,
- `image/png`,
- `image/jpeg`,
- `image/webp`,
- `image/gif`.

Non-goals for v1:

- editing files inside the previewer,
- PDF page rendering,
- Office document rendering,
- binary hex viewer,
- notebook rendering,
- semantic code navigation.

Preview safety rules:

- fetch content only when the user opens the preview or drawer,
- cap preview byte size before rendering,
- show truncation state clearly,
- preserve download/open actions,
- never execute scripts from artifact content,
- do not trust artifact `contentType` alone; the daemon should keep extension/content
  validation as the authority where possible.

## Diff And File-Change Evidence

Introduce `FileChangeEvidencePanel`.

Recommended source:

```text
apps/web/src/shared/conversation/
  FileChangeEvidencePanel.tsx
  DiffViewer.tsx
  DiffFileSummary.tsx
```

Display hierarchy:

```text
collapsed evidence:
  Changed 3 files: 2 updated, 1 added

expanded evidence:
  file list with status and +/- counts
  selected file diff preview
  approval/status metadata

drawer raw detail:
  full diff
  raw artifact links
  run/action ids
```

Borrowed Codex rendering ideas:

- separate file-level summary from line-level diff,
- preserve add/delete/update/rename distinction,
- show `+` / `-` gutters,
- show line numbers when available,
- wrap long lines while preserving gutter alignment,
- syntax-highlight only when cheap and reliable,
- degrade to plain diff text when parsing fails.

Ling-specific rules:

- file-change evidence is attached to a run, approval, action, or artifact,
- approval-needed and failed states must remain visible while the diff is collapsed,
- declined or failed changes must not look like applied workspace state,
- if a stale runner completion is ignored, record it in runtime evidence instead of
  flipping the visible file-change status to success.

## Composer Input Structure

Do not keep growing a single opaque message `body` forever.

Future composer input should support structured spans:

```ts
type ComposerInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachmentId: string }
  | { readonly type: "workspace_file"; readonly path: string; readonly line?: number }
  | { readonly type: "teammate_mention"; readonly teammateId: string }
  | { readonly type: "skill_mention"; readonly skillId: string };
```

v1 can remain backward-compatible by persisting `body` plus structured attachment ids.
The renderer should be written so structured spans can be added later without replacing
the message row contract.

Rules:

- `@teammate` mentions route collaboration intent,
- `@skill` mentions request skill selection, not permission grants,
- file mentions create file references, not automatic AI ingestion,
- pasted images/files become pending assets before send,
- every attached file retains scope metadata.

## Daemon/API Requirements

The current artifact content route is enough for a first preview slice, but preview UX
needs stricter metadata and bounded reads.

Recommended API additions:

```text
GET /artifacts/:id/preview?cwd=/path/to/project&maxBytes=65536
GET /attachments/:id/preview?cwd=/path/to/project&maxBytes=65536
```

Response shape:

```ts
interface PreviewContentResponse {
  readonly ref: ConversationFileRef;
  readonly kind: ConversationContentKind;
  readonly text?: string;
  readonly imageUrl?: string;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly redactionNotes: readonly string[];
}
```

Rules:

- preview endpoints must enforce the same root/scope checks as content endpoints,
- text previews must have a hard byte cap,
- unsupported content returns metadata and `previewable: false`,
- artifact content remains served only from `.ling-stack/artifacts`,
- attachment preview must respect channel/private ownership,
- preview endpoints must not mutate memory, message state, or AI context.

## Component Integration

### MessageRow

Use `MessageBodyRenderer` for `bodyNode` on channel and private messages.

Add optional slots:

- `fileRefsNode`,
- `previewNode`,
- `evidenceNode`.

Keep `MessageRow` simple. It should not fetch artifact content itself.

### ConversationAttachmentStrip

Upgrade chips to understand:

- previewable state,
- included-in-context state,
- private scope warning,
- blocked/redacted state,
- remove action for pending assets only.

### EvidenceDisclosure

Evidence sections should render file and artifact evidence with structured panels:

- `UsedMemorySummary`,
- `FileChangeEvidencePanel`,
- `ArtifactPreview`,
- `RuntimeEvidencePanel`,
- `ApprovalEvidencePanel`.

Do not pass arbitrary page-specific JSX once the shared evidence bundle shape is ready.

### RightDrawer

Right drawer owns full previews:

- artifact detail,
- attachment detail,
- file-change diff,
- raw event payload,
- approval preview,
- resume context preview.

The drawer should preserve back navigation so opening a file preview from a run summary
does not navigate away from the conversation.

## Rollout Plan

### P0: Safe Message Text Rendering

- Add `MessageBodyRenderer`.
- Render Markdown safely for message bodies.
- Render local file links as workspace-aware references.
- Keep code blocks readable with copy action.
- Add narrow-width tests for long paths, URLs, code, and tables.

Validation:

- `corepack pnpm --filter @ling-stack/web typecheck`,
- focused component tests if available,
- Playwright smoke on channel chat and private teammate chat.

### P1: Artifact Preview

- Add preview endpoint for artifacts.
- Add `ArtifactPreview` and drawer detail.
- Inline preview text/Markdown/JSON/diff under evidence.
- Keep image artifacts using existing open/download actions plus optional thumbnail.

Validation:

- daemon route tests for preview caps and path containment,
- Web smoke for text artifact, image artifact, unsupported binary,
- verify large artifact truncation.

### P2: File Change Evidence

- Derive `ConversationFileChange` from run events/action artifacts.
- Add `FileChangeEvidencePanel` and `DiffViewer`.
- Show collapsed `Changed N files` summary in conversation evidence.
- Show approval/failure/declined states in collapsed summary.

Validation:

- unit tests for diff summary counts,
- malformed diff fallback test,
- Playwright run thread smoke with file-change evidence expanded.

### P3: Structured Composer Spans

- Add internal composer span model.
- Preserve existing `body + attachmentIds` API.
- Add `@teammate`, `@skill`, and file-reference parsing as UI spans.
- Only add durable schema after the UI contract is proven.

Validation:

- keyboard input tests,
- send compatibility test with old daemon contract,
- scope tests for private attachments.

## Risks

| Risk | Failure mode | Mitigation |
| --- | --- | --- |
| Markdown injection | untrusted HTML or script execution | sanitize or disable raw HTML |
| scope leakage | private filenames/content shown in channel | enforce scope in preview derivation and daemon routes |
| feed noise | previews dominate conversation | keep full previews in evidence/drawer |
| false AI context | user assumes previewed file was read by AI | show `Not included in AI context` when relevant |
| large files | UI locks while rendering | byte caps, lazy fetch, truncation |
| diff parser failure | broken or generated diff crashes viewer | plain-text fallback |
| stale run state | failed/declined changes look applied | status chips and evidence source labels |

## Open Questions

- Should artifact preview responses be cached in the Web layer, or should the drawer
  refetch on every open?
- Should channel attachments and run artifacts share a unified `FileRef` API endpoint,
  or stay separate for clearer scope enforcement?
- Should Markdown rendering support tables in v1, or should tables initially degrade to
  preformatted plain text?
- Should diff syntax highlighting be added in P2, or deferred until plain diff rendering
  is proven stable?

## Success Criteria

- A normal user can read a long conversation without raw artifacts or logs flooding the
  feed.
- A power user can open exact Markdown, JSON, log, image, and diff evidence from the same
  conversation context.
- Private attachment scope remains visible and enforced.
- File changes are summarized as user-facing work evidence, not as raw run events.
- Previewing a file never mutates memory, model context, approvals, or workspace state.
