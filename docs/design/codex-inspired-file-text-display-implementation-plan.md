# Codex-Inspired File And Text Display Implementation Plan

## Status

Implementation breakdown for
[Codex-Inspired File And Text Display v1](codex-inspired-file-text-display-v1.md).

P0 `message-text-renderer` implementation started on 2026-06-06. The first Web slice
uses a small React-rendered safe subset instead of adding a Markdown parser dependency:
plain paragraphs, lists, bold text, inline code, fenced code, safe web links, mentions,
and local path references. It deliberately does not fetch files, mutate daemon state, or
include previewed content in AI context.

P1 `artifact-and-attachment-preview` and P2 `file-change-evidence` were implemented on
2026-06-06 as bounded evidence-only UI. Preview routes return text/image/metadata within
daemon caps and scope checks; diff evidence is derived lazily from diff-like artifacts
instead of adding a new durable file-change table.

P3 `composer-structured-spans` was implemented on 2026-06-06 as a Web-only composer
model. The channel and private teammate composers parse draft text, ready attachments,
workspace file references, teammate mentions, and skill mentions into temporary parts
for chips/tokens, then serialize back to the existing `body`, `attachmentIds`, and
`linkPreviewIds` payloads before send. No durable message schema migration is part of
P3.

This is the patch plan. It does not replace the source design. The goal is to turn the
Codex-inspired file/text display direction into small, reviewable PR slices without
pulling in Codex's terminal UI, runner backend, or app-server JSON-RPC architecture.

## Source Design

Authoritative product behavior lives in:

- [Codex-Inspired File And Text Display v1](codex-inspired-file-text-display-v1.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Codex-Like Execution Experience](codex-like-execution.md)

Implementation must preserve these boundaries:

- Ling Stack remains a Web-first multi-teammate workspace.
- The default runner backend remains the existing embedded Pi library adapter.
- Message, artifact, and diff previews are evidence only; previewing content does not add
  it to AI context or memory.
- Private teammate attachments and channel attachments keep their current scope
  boundaries.
- Full file bodies, raw logs, raw tool payloads, and raw diffs stay out of the default
  feed.
- Do not introduce a wholesale Codex `ThreadItem` or app-server protocol clone. Derive a
  Ling display model from existing records first.

## Existing Code To Reuse

| Concern | Existing code |
| --- | --- |
| Shared message rows | `apps/web/src/shared/conversation/MessageRow.tsx` |
| Shared feed shell | `apps/web/src/shared/conversation/ConversationFeed.tsx` |
| Attachment chips | `apps/web/src/shared/conversation/ConversationAttachmentStrip.tsx` |
| Evidence disclosure | `apps/web/src/shared/conversation/EvidenceDisclosure.tsx` |
| Artifact row and download/open behavior | `apps/web/src/shared/components/ArtifactRow.tsx` |
| Artifact helpers | `apps/web/src/lib/artifacts.ts` |
| Channel attachment UI | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Private attachment UI | `apps/web/src/features/teammates/TeammateWorkspace.tsx` |
| Run evidence and artifacts | `apps/web/src/features/runs/RunHistory.tsx` |
| Run event preview formatting | `apps/web/src/features/runs/EventRow.tsx`, `apps/web/src/lib/run-activity.ts` |
| API URL helpers | `apps/web/src/api.ts`, `packages/api-client/src/client.ts` |
| Artifact content route | `packages/daemon/src/features/runs/routes.ts` |
| Artifact path safety | `packages/daemon/src/features/runs/artifacts.ts` |
| Attachment storage and scope checks | `packages/core/src/storage/sqlite-run-store.ts` |
| Channel attachment routes | `packages/daemon/src/features/channels/` |
| Teammate private attachment routes | `packages/daemon/src/features/teammates/` |
| Contracts | `packages/contracts/src/index.ts` |

One current gap: artifact and attachment content can be opened/downloaded, but there is
no bounded preview route and no shared Web preview model.

## Patch Sequence

Land this as four slices:

```text
P0 message-text-renderer
P1 artifact-and-attachment-preview
P2 file-change-evidence
P3 composer-structured-spans
```

P0 and P1 should be shipped before P2. P3 is intentionally last because it changes input
semantics and should not block file/text display.

## P0 `message-text-renderer`

### Outcome

Channel chat, teammate private chat, and run thread summaries render message body text
through one safe renderer. Markdown, code fences, web links, and local file references
become readable without changing daemon APIs.

### Files

Add:

```text
apps/web/src/shared/conversation/MessageBodyRenderer.tsx
apps/web/src/shared/conversation/LocalFileLink.tsx
apps/web/src/shared/conversation/CodeBlock.tsx
apps/web/src/shared/conversation/message-body.ts
apps/web/src/shared/conversation/message-body.test.tsx
```

Update:

```text
apps/web/src/shared/conversation/MessageRow.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/features/teammates/TeammateWorkspace.tsx
apps/web/src/features/runs/RunHistory.tsx
apps/web/src/styles/components.css
apps/web/src/styles/layout.css
apps/web/src/i18n.tsx
```

If a Markdown parser is added, update:

```text
apps/web/package.json
pnpm-lock.yaml
```

### Responsibility

`MessageBodyRenderer` owns display only:

- plain text paragraphs,
- safe Markdown,
- code blocks,
- inline code,
- web links,
- local file-link display,
- path-like text detection where unambiguous.

It must not:

- fetch files,
- inspect the filesystem,
- mutate messages,
- add AI context,
- create artifacts,
- parse tool output into durable records.

### Proposed Interface

```ts
export interface MessageBodyRendererProps {
  readonly text: string;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly allowMarkdown?: boolean;
  readonly onOpenLocalFile?: (ref: LocalFileReference) => void;
}

export interface LocalFileReference {
  readonly raw: string;
  readonly displayPath: string;
  readonly location?: string;
  readonly insideWorkspace: boolean;
}
```

### Parsing Rules

Start conservative:

1. Treat normal message bodies as Markdown when `allowMarkdown !== false`.
2. Disable or sanitize raw HTML.
3. Render code fences as inert `<pre><code>`.
4. Render web links with `target="_blank"` and `rel="noreferrer"`.
5. For Markdown links whose destination is local-path-like, display the destination path,
   not arbitrary link label text.
6. Preserve suffixes such as `:12`, `:12:3`, `#L12`, and `#L12-L20`.
7. Show workspace-relative paths when `cwd` is known and the path is inside it.
8. For paths outside `cwd`, show a redacted or absolute display according to the current
   surface. P0 can start with non-clickable absolute display and a follow-up TODO.
9. Do not resolve symlinks in the Web renderer.
10. Never use `dangerouslySetInnerHTML` on untrusted message text.

### Styling Rules

- Message text wraps within the existing conversation column.
- Code blocks have stable max width and do not resize rows on hover.
- Copy code uses an icon button with `aria-label` and `title`.
- Long paths and URLs wrap without forcing horizontal page scroll.
- Local file links use code-like styling, not full cards.
- Tables can render as simple blocks in P0; rich table layout can be deferred.

### Tests

Add focused renderer tests for:

- plain text line breaks,
- Markdown bold/inline code/list rendering,
- fenced code block copy action presence,
- unsafe HTML rendered inert or stripped,
- web link attributes,
- local absolute link displayed from destination,
- workspace-relative local link display,
- long path wrapping class or output shape,
- empty string rendering.

Run:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test
```

If the Web package still has no real unit test runner, land renderer tests only after the
test harness is added, and use typecheck plus Playwright smoke for this slice.

### Acceptance Criteria

- Channel and private chat use the same body renderer.
- Existing attachment chips still render unchanged.
- No daemon or core schema changes.
- No raw HTML execution path.
- `git diff --check` passes.

## P1 `artifact-and-attachment-preview`

### Outcome

Users can preview safe text/image artifact and attachment content from conversation
evidence or the right drawer without downloading the file manually. Preview is bounded,
scope-checked, and read-only.

### Files

Add:

```text
packages/core/src/preview-types.ts
packages/daemon/src/features/previews/content-preview.ts
apps/web/src/shared/conversation/ArtifactPreview.tsx
apps/web/src/shared/conversation/ArtifactPreviewDrawer.tsx
apps/web/src/shared/conversation/FileRefChip.tsx
apps/web/src/lib/previews.ts
```

Update:

```text
packages/core/src/index.ts
packages/contracts/src/index.ts
packages/daemon/src/features/runs/routes.ts
packages/daemon/src/features/channels/attachments.ts
packages/daemon/src/features/channels/routes.ts
packages/daemon/src/features/teammates/routes.ts
packages/daemon/src/features/teammates/private-attachments.ts
packages/daemon/src/server/router.ts
packages/daemon/src/server/routes.ts
packages/api-client/src/client.ts
packages/api-client/src/index.ts
apps/web/src/api.ts
apps/web/src/shared/components/ArtifactRow.tsx
apps/web/src/features/runs/RunHistory.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/features/teammates/TeammateWorkspace.tsx
apps/web/src/styles/components.css
apps/web/src/i18n.tsx
docs/daemon-api.md
```

### API Contract

Add read-only preview endpoints:

```text
GET /artifacts/:id/preview?cwd=/path/to/project&maxBytes=65536
GET /attachments/:id/preview?cwd=/path/to/project&maxBytes=65536
```

Response:

```ts
export type PreviewContentKind =
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

export interface PreviewFileRef {
  readonly id: string;
  readonly source: "attachment" | "artifact";
  readonly scope: "channel" | "teammate_private" | "run" | "external_work";
  readonly label: string;
  readonly displayPath?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewable: boolean;
  readonly redacted?: boolean;
}

export interface PreviewContentResponse {
  readonly ref: PreviewFileRef;
  readonly kind: PreviewContentKind;
  readonly text?: string;
  readonly imageUrl?: string;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly redactionNotes: readonly string[];
}
```

### Daemon Rules

- Reuse current artifact root containment checks.
- Attachment preview must verify channel/private ownership before reading bytes.
- `maxBytes` is capped by the daemon; client-provided values cannot raise the server cap.
- Return `previewable: false` for unsupported or oversized binary content.
- Return text only after UTF-8 decode succeeds.
- JSON preview can pretty-print only after successful parse; otherwise render as text.
- Image preview returns the existing safe content URL, not base64.
- Preview endpoints do not create events, memory, messages, or run state.

### Web Behavior

- Artifact rows keep open/download.
- Previewable rows add an icon button: `Preview`.
- Inline preview appears only inside evidence disclosure or drawer content, not as a
  full card in the default feed.
- Drawer preview includes title, content type, size, truncation state, open/download.
- Unsupported content shows metadata and open/download.
- Large text preview shows truncation with a drawer/download path.

### Tests

Daemon:

- artifact preview inside `.ling-stack/artifacts` succeeds,
- artifact path escape is rejected,
- unsupported binary returns metadata only,
- large text truncates,
- invalid UTF-8 text returns unsupported or failed preview without crashing,
- channel attachment scope mismatch is rejected,
- private attachment scope mismatch is rejected.

Web:

- preview button appears for previewable artifacts,
- unsupported artifact keeps open/download only,
- drawer shows truncated state,
- image preview does not fetch bytes into React state.

Run:

```bash
corepack pnpm --filter @ling-stack/core typecheck
corepack pnpm --filter @ling-stack/api-client build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
```

### Acceptance Criteria

- Preview routes are read-only and bounded.
- Artifact and attachment previews use the same response shape.
- Scope failures are visible and do not leak filenames/content.
- Existing content URLs continue working.

## P2 `file-change-evidence`

### Outcome

Run and approval file changes render as structured evidence: collapsed summary in the
conversation, expandable file list, selected diff view, and raw artifact links in drawer
detail.

### Files

Add:

```text
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
apps/web/src/shared/conversation/DiffViewer.tsx
apps/web/src/shared/conversation/DiffFileSummary.tsx
apps/web/src/lib/file-change-evidence.ts
apps/web/src/lib/diff-summary.ts
```

Update:

```text
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/features/runs/RunHistory.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/features/approvals/ApprovalCard.tsx
apps/web/src/lib/run-activity.ts
apps/web/src/styles/runs.css
apps/web/src/styles/components.css
apps/web/src/i18n.tsx
```

Update daemon/core only if existing events/artifacts lack enough data:

```text
packages/daemon/src/features/runs/action-artifacts.ts
packages/daemon/src/features/runs/approvals.ts
packages/contracts/src/index.ts
```

### Display Model

```ts
export type ConversationFileChangeKind = "add" | "delete" | "update" | "rename";
export type ConversationFileChangeStatus = "in_progress" | "completed" | "failed" | "declined";

export interface ConversationFileChange {
  readonly id: string;
  readonly path: string;
  readonly kind: ConversationFileChangeKind;
  readonly diff: string;
  readonly status: ConversationFileChangeStatus;
  readonly additions?: number;
  readonly deletions?: number;
  readonly sourceRunId?: string;
  readonly approvalId?: string;
  readonly artifactId?: string;
}
```

### Derivation Order

Derive file changes in this order:

1. approval preview artifacts with `text/x-diff`,
2. action result artifacts with `text/x-diff`,
3. `artifact_created` run events that point at diff artifacts,
4. run events that already include structured file update data,
5. fallback to raw diff artifact preview text.

Do not create a new durable file-change table in P2 unless the existing event/artifact
record is insufficient for stable UI.

### Diff Viewer Rules

- Render a file summary header with path, status, kind, additions, deletions.
- Render `+` and `-` gutters.
- Keep line-number gutter aligned when line numbers are known.
- Wrap long diff lines without collapsing the gutter.
- Show malformed diff as plain text with a warning label.
- Do not syntax-highlight in the first implementation unless the plain viewer is already
  stable and cheap.
- Collapsed evidence must show approval-needed, failed, declined, or blocked state.

### UX Placement

Channel feed:

- collapsed summary only: `Changed 3 files`.

Run thread:

- collapsed summary plus expand-to-file-list.

Approval card:

- preview diff in the approval detail area when safe.

Right drawer:

- selected file diff and raw artifact links.

### Tests

Unit:

- additions/deletions counted from unified diff,
- add/delete/update/rename kind mapping,
- malformed diff fallback,
- multiple files summarized correctly,
- declined/failed status does not render as applied.

Web smoke:

- run detail shows `Changed N files`,
- expanding evidence shows file list,
- opening file shows diff,
- approval-needed state remains visible when collapsed.

Run:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
```

### Acceptance Criteria

- Raw run event spam is not added to the main feed.
- File changes are visible as evidence attached to the owning run/approval.
- Failed or declined changes cannot be mistaken for applied changes.
- Diff viewer degrades safely on malformed input.

## P3 `composer-structured-spans`

### Outcome

Composer input internally tracks text, attachments, teammate mentions, skill mentions,
and workspace file references as structured spans while preserving the existing persisted
message contract.

### Files

Add:

```text
apps/web/src/shared/components/composer-input-parts.ts
apps/web/src/shared/components/ComposerMentionToken.tsx
apps/web/src/shared/components/ComposerFileReferenceToken.tsx
```

Update:

```text
apps/web/src/shared/components/MessageComposer.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/features/teammates/TeammateWorkspace.tsx
apps/web/src/shared/conversation/ConversationAttachmentStrip.tsx
apps/web/src/i18n.tsx
```

Only after UI behavior is proven, consider contract updates in:

```text
packages/contracts/src/index.ts
packages/core/src/run-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/daemon/src/features/channels/schemas.ts
```

### Internal Model

```ts
export type ComposerInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachmentId: string }
  | { readonly type: "workspace_file"; readonly path: string; readonly raw: string; readonly line?: number }
  | { readonly type: "teammate_mention"; readonly teammateId: string; readonly label: string; readonly raw: string }
  | { readonly type: "skill_mention"; readonly skillId: string; readonly label: string; readonly raw: string };
```

### Compatibility Rule

For P3, send the existing payload:

```ts
{
  body: string;
  attachmentIds: string[];
  linkPreviewIds: string[];
}
```

Structured spans are used to render and validate the composer, but the durable schema
does not change until a later migration is justified.

### UX Rules

- `@teammate` mentions signal collaboration intent.
- `@skill` mentions request skill selection; they do not grant tools or approvals.
- File references are display/context hints; they do not include file content in AI
  context.
- Pending attachment cards keep remove actions.
- Pasted images keep existing object URL preview and cleanup.
- Keyboard navigation must work across tokens and text.

### Tests

- mention token can be inserted and removed,
- file reference token serializes to safe body text,
- existing attachment send flow still works,
- private attachment send flow still works,
- old daemon accepts the payload.

Run:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
```

### Acceptance Criteria

- No durable schema migration in P3 unless separately approved.
- Existing channel and private message send flows remain compatible.
- Structured spans make UI behavior clearer without changing AI inclusion semantics.

## Cross-Cutting Implementation Rules

### Security And Scope

- Preview routes are read-only.
- Scope checks happen server-side, not only in Web code.
- Private filenames are hidden when the current surface is not allowed to see them.
- Preview content is never written into memory or run prompt context.
- Raw HTML in message text is inert.
- Large content is capped before parsing or rendering.

### Accessibility

- Icon-only buttons require `aria-label` and `title`.
- Preview drawers keep focus containment and keyboard close behavior.
- Diff file list and selected diff need semantic labels.
- Truncation and unsupported states must be announced as visible text.

### Performance

- Fetch preview content lazily.
- Do not parse large Markdown/JSON/diff in the main render path.
- Memoize derived summaries for run details with many artifacts.
- Keep virtual feed row heights stable where possible.

### Internationalization

Add translation keys for:

- `Preview`,
- `Open preview`,
- `Download file`,
- `Preview unavailable`,
- `Preview truncated`,
- `Changed {count} files`,
- `{count} additions`,
- `{count} deletions`,
- `Not included in AI context`,
- `Unsupported preview`.

## Out Of Scope

- PDF rendering.
- Office document rendering.
- Editing files from previews.
- Semantic code navigation.
- Notebook rendering.
- Binary/hex viewer.
- Automatic AI file ingestion.
- New runner backend.
- Codex app-server protocol adoption.

## Review Checklist

Before merging any slice:

- `git diff --check` passes.
- Relevant typecheck command passes.
- No unrelated files were reformatted.
- No raw HTML rendering path was introduced.
- Previewed content is not added to AI context.
- Scope failures do not leak private names or content.
- Default conversation feed remains readable without expanding evidence.

## Suggested PR Boundaries

| PR | Scope | Can merge independently |
| --- | --- | --- |
| 1 | P0 renderer and message integration | yes |
| 2 | P1 preview contracts, daemon routes, API client | yes, after PR 1 |
| 3 | P1 Web preview drawer and artifact/attachment integration | yes, after PR 2 |
| 4 | P2 file-change evidence and diff viewer | yes, after PR 3 |
| 5 | P3 composer structured spans | yes, after PR 1; preferably after PR 4 |

If schedule is tight, ship PR 1 and PR 2 first. They deliver the main user-visible
improvement without touching run file-change derivation or composer semantics.
