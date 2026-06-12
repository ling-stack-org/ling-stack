# Input Materialization Detailed Design

Status: detailed design with first implementation slice and Smart UX delta landed. This
document expands the materialization boundary in `ling-agent-session.md` into an
implementation-ready contract for rich inputs. It does not replace the Ling Agent Session
entry order, workflow/run stack, or approval system.

Implemented first slice:

- `LingAgentTurnEnvelope` carries attachment/link/file-ref materialization status.
- Text attachments under the inline budget can provide bounded preview text.
- Content-dependent screenshot/PDF/Office or link-body requests produce a visible Ling
  clarify reply when required content is not materialized.
- File create/edit requests that depend on unavailable attachment content still create a
  blocked proposal instead of auto-starting.
- Web E2E covers the visible screenshot clarify behavior and hidden routing details.
- Smart UX delta keeps internal materialization reasons in decisions/proposal diagnostics
  while the default transcript uses natural Ling copy without implementation vocabulary.

## Purpose

Ling Agent can receive more than plain text: uploads, images, PDFs, Office files, links,
and workspace file references. The product problem is not "how do we stuff more bytes into
the prompt". The product problem is: Ling must know exactly what it has actually read,
what is only metadata, and what is blocked.

This design makes that state explicit to the runtime before any ordinary answer,
executable proposal, auto-start decision, or active-run follow-up uses the input. It
does not require exposing that state as default UI. Ling is an intelligent collaboration
product, not a debugging console.

## Product Precedents

The design borrows concepts from current agent products, but keeps Ling Stack's local
workspace and approval model.

- Codex separates agent freedom from enforced boundaries: sandboxing lets routine work run
  inside limits, while approvals are reserved for actions outside the boundary. Reference:
  [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing) and
  [agent approvals and security](https://developers.openai.com/codex/agent-approvals-security).
- Claude Code documents a read-first posture and explicit permission before modifying
  files or running risky commands. Reference:
  [Claude Code security](https://code.claude.com/docs/en/security) and
  [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).
- ChatGPT treats uploaded files and project files as reference material, while connected
  app actions that mutate outside systems require clear user control. Reference:
  [ChatGPT file uploads](https://help.openai.com/en/articles/8555545-file-uploads-faq)
  and [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt).
- Grok/xAI exposes tool calling as a conversation-time capability: the model requests a
  call, and the caller/runtime controls execution. Reference:
  [xAI function calling](https://docs.x.ai/developers/tools/function-calling) and
  [xAI tools overview](https://docs.x.ai/developers/tools/overview).

What Ling Stack should copy:

- use boundaries to reduce approval fatigue;
- keep mutation authority separate from context preparation;
- make tool/materialization results explicit to the runtime;
- surface blockers only when they change what Ling can safely do.

What Ling Stack should not copy blindly:

- hidden remote fetches as ordinary chat side effects;
- treating a filename, MIME type, or URL title as body evidence;
- putting every rich input into the prompt without budgets, source ids, or policy state.

## Vocabulary

### Source Kinds

```ts
type LingMaterializationSourceKind =
  | "attachment"
  | "link_preview"
  | "workspace_file_ref";
```

Source ids:

- `attachment`: `ChannelAttachment.id`
- `link_preview`: `ChannelLinkPreview.id`
- `workspace_file_ref`: `channelMessageId + fileRef index + normalized path`

### Content Kinds

```ts
type LingMaterializationContentKind =
  | "plain_text"
  | "ocr_text"
  | "vision_summary"
  | "pdf_text"
  | "office_text"
  | "html_text"
  | "metadata";
```

### Statuses

| Status | Meaning | Ling may do |
| --- | --- | --- |
| `available` | Bounded extracted content is in the envelope or cache. | Reason from it, summarize it, cite it as available context. |
| `metadata_only` | Name, type, size, URL, title, relation, or status is known, but body is not loaded. | Acknowledge that the input exists, but not summarize body contents. |
| `not_loaded` | A supported extractor could run later, but has not run. | Ask for extraction, create an inspection step, or block content-dependent work. |
| `unsupported` | No configured extractor supports this source/content kind. | Explain the limitation and ask for another input or inspection path. |
| `blocked` | Policy, size, missing file, cross-channel id, outside-workspace path, SSRF, or fetch failure blocks materialization. | Prevent dependent work and offer a safe path when the user requested that content. |

## Core Rule

Materialization can make context available. It never grants action permission.

This means:

- reading a small current-turn text attachment preview can be context preparation;
- extracting public unauthenticated link text can be context preparation only if policy
  allows it;
- reading arbitrary workspace files should happen through a managed run/tool inspection
  path, not hidden pre-run prompt stuffing;
- writes, edits, shell commands, Git, deploys, provider changes, credential access,
  external sends, and account-changing web actions remain runtime approval concerns.

## Product UX Principle

Materialization state is a system contract, not default UI chrome.

Ling should behave like an intelligent agent product:

- rich inputs are normal conversation material, not a separate debugging workflow;
- eligible text/image/PDF/Office/link materialization should run automatically inside
  configured budgets and policies;
- file, image, link, and workspace-reference chips stay simple by default;
- internal statuses such as `metadata_only`, `not_loaded`, `blocked`, `unsupported`, and
  `truncated` are not shown as permanent labels in the transcript;
- Ling only interrupts when the user's requested outcome depends on content that is not
  available or crosses a permission/safety boundary;
- copy in the main conversation should be short, natural, and action-oriented;
- detailed extractor ids, fingerprints, policy errors, byte counts, and truncation facts
  belong in optional evidence/details surfaces.

Default user experience:

1. User attaches or references material.
2. Ling automatically prepares safe context where possible.
3. Ling answers or proposes work from available context.
4. If a required input cannot be used, Ling explains the minimum reason in plain language
   and offers the next safe action.

This avoids both failure modes: pretending to read content that was not available, and
turning the channel into a status-heavy debugging tool.

## Smart UX Implementation Delta

The first code slice already added deterministic materialization clarification. The Smart
UX delta keeps that runtime protection but changes the user-facing layer from status
reporting to natural Ling behavior.

Implemented delta:

- keep `LingAgentTurnEnvelope` materialization status fields unchanged;
- keep deterministic guards before model intent selection and auto-start;
- replace status-heavy transcript copy with product copy;
- store technical reasons in intent decisions, proposal diagnostics, or evidence/details,
  not in the default transcript;
- update Web mock daemon and E2E assertions so tests enforce the smarter UI boundary.

Runtime placement:

1. `channel-intent-selector.ts`
   - `detectMaterializationClarify` should return a structured issue:
     `sourceLabel`, `issueKind`, `technicalReason`, and `requestedActionKind`.
   - `createMaterializationClarifyReply` should persist `technicalReason` in the intent
     decision `reason`, while message `body` comes from a user-copy renderer.
   - The renderer must not leak internal status names, extractor ids, SSRF wording,
     fingerprints, byte budgets, or raw ids.

2. Auto-start blockers
   - `attachmentMaterializationBlocker` and future gates should keep exact internal
     reasons for blocking auto-start.
   - If a blocked proposal is visible, the primary copy should explain the next safe
     action. Detailed diagnostics may be attached to evidence/details.

3. Link extraction policy
   - Private/local/unsafe URLs remain blocked by policy.
   - Main chat copy should say local/private links are not opened automatically.
   - The word `SSRF` and low-level network classification belong only in diagnostics.

4. Web transcript
   - file, image, PDF, Office, and link chips stay visually simple;
   - no permanent status badges are added to ordinary messages;
   - evidence/details can show status only after the user opens it.

5. Tests
   - daemon tests should assert the decision reason preserves technical truth;
   - Web E2E should assert natural user copy and absence of internal vocabulary in the
     default transcript.

Copy mapping:

| Internal issue | Main transcript copy | Evidence/details copy |
| --- | --- | --- |
| `image unsupported/not_loaded` | `I can inspect screenshot.png first, or you can paste the key detail.` | image extractor status, file size, failure code |
| `pdf unsupported/not_loaded` | `I can inspect report.pdf first, or you can paste the section to use.` | PDF extractor availability, parser error, truncation |
| `office unsupported/not_loaded` | `I can inspect the document first, or you can paste the part that matters.` | Office extractor status, format, parser error |
| `private/local link blocked` | `I will not open local/private links automatically. Paste the content or ask me to inspect it as a controlled task.` | URL classification, network policy decision, redirect chain |
| `workspace file outside root` | `That path is outside this workspace. Use a workspace file, or ask me to inspect it as a controlled task.` | normalized path, root relation, policy reason |
| `content truncated` | no default warning unless it affects the answer | original size, extracted size, prompt preview length |

## Data Model

Add a durable materialization cache after the current `fileRefs` message contract is
stable.

```ts
interface ChannelInputMaterialization {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly contentKind: LingMaterializationContentKind;
  readonly status: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly contentText?: string;
  readonly structuredSummaryJson?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated: boolean;
  readonly policyDecisionJson?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}
```

Recommended SQLite table: `channel_input_materializations`.

Indexes:

- unique: `(channel_id, source_kind, source_id, source_fingerprint, extractor_id)`
- lookup: `(channel_id, source_kind, source_id, updated_at)`
- status review: `(channel_id, status, updated_at)`

Do not store:

- API keys, cookies, bearer tokens, session headers;
- raw HTML forms or external-send payloads;
- full huge file bodies;
- private browser session data;
- workspace file body content read outside the managed run/tool path.

## Modular V1 Implementation Plan

Status: M1 cache and registry skeleton landed. M2 text attachment migration landed for
small text attachments. M3 public link body extraction landed for explicit link-body
requests. Rich extraction for PDF/Office parsing and image inspection remains in M4-M5.

The complete v1 must be modular. Do not grow `channel-intent-selector.ts`,
`ling-agent-turn-envelope.ts`, or `messages.ts` into extractor hubs.

### Module Boundaries

Recommended new modules:

```text
packages/core/src/input-materialization-types.ts
packages/daemon/src/features/channels/materialization/
  cache.ts
  fingerprints.ts
  registry.ts
  budgets.ts
  policy.ts
  gate.ts
  prompt.ts
  copy.ts
  extractors/
    text-attachment.ts
    link-body.ts
    pdf.ts
    office.ts
    image.ts
```

Responsibilities:

| Module | Owns | Must not own |
| --- | --- | --- |
| `input-materialization-types.ts` | shared status/source/content types and DTOs | daemon extraction logic |
| `cache.ts` | read/write/list materialization rows through `RunStore` | parsing attachments or links |
| `fingerprints.ts` | source fingerprints and cache keys | persistence or fetch |
| `registry.ts` | extractor registration and selection | product copy |
| `budgets.ts` | byte/char/timeout defaults | per-source policy decisions |
| `policy.ts` | URL/file/source safety checks | network fetch body parsing |
| `gate.ts` | may-answer/may-auto-start decisions | UI wording |
| `prompt.ts` | bounded prompt rendering from materialized rows | user-visible transcript copy |
| `copy.ts` | natural Ling copy for missing/blocked inputs | technical diagnostics |
| `extractors/*` | source-specific extraction | workflow/proposal creation |

Existing module changes should stay small:

- `ling-agent-turn-envelope.ts` should assemble refs and read existing materialization
  rows; it should not run heavy extractors.
- `channel-intent-selector.ts` should call `gate.ts` and `copy.ts`; it should not know
  extractor internals.
- `messages.ts` should trigger bounded inline/background materialization hooks; it should
  not parse PDFs, Office files, or HTML directly.
- `context-packs.ts` and `ai-replies.ts` should consume `prompt.ts` output only.

### Store API Shape

Add store-level APIs before daemon extractor code uses the cache:

```ts
interface CreateChannelInputMaterializationInput {
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly contentKind: LingMaterializationContentKind;
  readonly status: LingMaterializationStatus;
  readonly contentText?: string;
  readonly structuredSummaryJson?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated?: boolean;
  readonly policyDecisionJson?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly expiresAt?: string;
}

interface ListChannelInputMaterializationsOptions {
  readonly channelId: string;
  readonly sourceKind?: LingMaterializationSourceKind;
  readonly sourceId?: string;
  readonly status?: LingMaterializationStatus;
  readonly limit?: number;
}
```

SQLite migration:

- next migration after `CHANNEL_MESSAGE_FILE_REFS_MIGRATION_VERSION = 62`;
- table: `channel_input_materializations`;
- unique index:
  `(channel_id, source_kind, source_id, source_fingerprint, extractor_id)`;
- lookup indexes:
  `(channel_id, source_kind, source_id, updated_at)` and
  `(channel_id, status, updated_at)`.

### Execution Model

Materialization has three execution modes:

1. **Inline bounded**
   - small text attachment previews;
   - metadata/fingerprint generation;
   - no network fetch, no PDF/Office parse, no model call.

2. **Background safe**
   - public link body fetch;
   - PDF/Office text extraction under size and timeout budgets;
   - retryable and cache-backed.

3. **Managed inspection**
   - provider vision summary;
   - workspace file body reads;
   - private/local links when explicitly requested;
   - anything that needs approval, provider credentials, browser session, or tool work.

The channel message POST path may run inline bounded work and may enqueue/background safe
work. It must not synchronously block on slow network fetches, PDF parsing, Office
parsing, or model vision calls.

### V1 Slice Order

1. **M1 cache and registry skeleton**
   - status: landed;
   - add shared types and store APIs;
   - add SQLite table and mapper tests;
   - add `registry.ts`, `budgets.ts`, `fingerprints.ts`, `cache.ts`;
   - keep behavior unchanged except reading cache rows when present.

2. **M2 text attachment extractor migration**
   - status: landed;
   - move current text preview logic into `extractors/text-attachment.ts`;
   - preserve current prompt content and tests;
   - prove cache hit avoids rereading the file.

### M2 Implementation Notes

`text_attachment_v1` owns the small text attachment body read. `messages.ts` only
triggers `materializeInlineChannelInputs` before turn-envelope construction; it must not
decode or inspect attachment files directly.

Trigger:

- after a channel message is persisted and before `LingAgentTurnEnvelope` is built;
- only for attachments that belong to the active channel and have `kind === "text"`;
- only for the inline bounded budget: 16 KiB read, 8k chars prompt text.

Cache behavior:

- cache key is attachment source fingerprint plus extractor id `text_attachment_v1`;
- if a non-expired cache row exists, the hook must not read the attachment file again;
- `LingAgentTurnEnvelope` consumes cache rows and does not perform direct text file reads;
- a cache hit can still feed active-run guidance, auto-start proposals, and normal Ling
  replies even if the original attachment file is no longer readable.

Status mapping:

| Case | Status | Notes |
| --- | --- | --- |
| small UTF-8 text attachment | `available` | store bounded `contentText`, `byteCount`, `tokenEstimate`, and `truncated` |
| attachment exceeds inline byte budget | `blocked` | offer inspection/pasted-text path for content-dependent tasks |
| attachment file missing | `blocked` | do not auto-start content-dependent work |
| invalid UTF-8 or read failure | `blocked` | no lossy replacement text |
| non-text attachment | no M2 row | existing image/PDF/Office handling remains unchanged |

Default transcript behavior is unchanged: chips remain natural, and internal status names,
extractor ids, cache ids, byte limits, and raw errors stay out of ordinary user-facing
messages.

3. **M3 public link body extractor**
   - status: landed;
   - add `extractors/link-body.ts` and URL policy checks;
   - block localhost/private/link-local/unsafe redirects;
   - fetch only public unauthenticated GET;
   - extract readable text from HTML/plain text under budget;
   - update gate so public link summaries can answer from `available`.

### M3 Implementation Notes

`link_body_v1` owns public link body reads. `messages.ts` continues to call only
`materializeInlineChannelInputs`; the hook decides whether a link-body request is explicit
enough to attempt extraction. Link preview metadata remains separate from full page body.

Trigger:

- after a channel message is persisted and before `LingAgentTurnEnvelope` is built;
- only when the current turn text explicitly asks to read, summarize, extract, inspect, or
  analyze link/page/article content;
- only for link previews that belong to the active channel and are `ready`;
- link-only metadata turns still use title/description and do not fetch full page body.

Network policy:

- allow only unauthenticated public `http`/`https` GET;
- block localhost, loopback, private, link-local, unsafe protocol, and unsafe redirect
  targets before every fetch;
- resolve host addresses before fetch in production; tests may inject a resolver/fetcher;
- use manual redirect handling, redirect budget, byte budget, content-type allowlist, and
  wall-clock timeout;
- do not use browser cookies, provider credentials, session state, forms, checkout flows,
  or account-changing pages.

Content handling:

- accepted content types: `text/html`, `text/plain`, and bounded `application/json`;
- HTML extraction strips scripts, styles, SVG, forms, nav/footer/aside, and tags, then
  stores normalized readable text;
- store bounded `contentText`, `byteCount`, `tokenEstimate`, `truncated`, and a compact
  policy decision such as final URL/content type/redirect count;
- `LingAgentTurnEnvelope` consumes only `link_body_v1` rows for full body text.

Status mapping:

| Case | Status | Notes |
| --- | --- | --- |
| public HTML/plain text under budget | `available` | Ling can answer/summarize from extracted body |
| public body exceeds byte or char budget | `available` with `truncated` | bounded text only |
| local/private/unsafe URL or redirect | `blocked` | natural copy says Ling will not open local/private links automatically |
| timeout, HTTP error, unsupported content type, DNS failure | `blocked` | natural copy offers retry or pasted text |
| link preview not ready | no M3 row | existing metadata/blocked preview behavior remains |

Default transcript behavior is unchanged: no SSRF, extractor ids, redirect details, byte
limits, cache ids, or raw policy codes in ordinary messages. Technical details stay in
decision/evidence surfaces.

4. **M4 PDF and Office extractors**
   - status: landed for daemon/core materialization;
   - `pdf_text_v1` uses pinned `pdf-parse@1.1.1` for embedded PDF text only;
   - `office_text_v1` uses pinned `mammoth@1.12.0` for `.docx` raw text only;
   - `.pptx` and `.xlsx` produce `unsupported` rows in this first slice;
   - materialization runs only when the turn explicitly asks to read, summarize,
     extract, analyze, use, or write from document/attachment content;
   - cache/prompt text stays bounded by read-byte and prompt-char budgets;
   - no layout reconstruction, OCR, embedded image extraction, or table semantics in M4.

5. **M5 image inspection**
   - v1 should prefer managed provider vision summary over local OCR unless a local OCR
     dependency is intentionally chosen;
   - cache only bounded textual summary, not image bytes.

6. **M6 evidence/details and visual hardening**
   - add opt-in Web details for technical status;
   - keep default transcript chip-only/natural;
   - add desktop/mobile E2E.

### Dependency Policy

Do not add heavy parser dependencies casually.

Rules:

- prefer pure JS dependencies unless a native package is clearly justified;
- avoid dependencies that require system binaries for the default install path;
- pin extractor ids and versions independently from package versions;
- every new dependency must have a fixture-backed test for success, blocked, too-large,
  timeout/failure, and truncation where applicable.

Candidate approach:

| Source | First v1 approach | Notes |
| --- | --- | --- |
| Link HTML | built-in `fetch` + lightweight internal HTML text stripping first | add Readability/JSDOM only if internal stripper is not enough |
| PDF | `pdf-parse@1.1.1` embedded text extraction | chosen over newer native-canvas dependency path for default install stability |
| DOCX | `mammoth@1.12.0` raw text extraction | `.pptx`/`.xlsx` are explicit `unsupported` until separate extractors exist |
| Image | provider vision summary as managed inspection | local OCR later if product really needs offline OCR |

### Acceptance Gates

Each module slice must pass:

- daemon typecheck and build;
- relevant `channel-workspace.test.mjs` cases;
- store migration round-trip test for cache slices;
- targeted Web E2E only when transcript/details behavior changes;
- `git diff --check`.

Default transcript regressions are blockers:

- no raw `metadata_only`, `blocked`, `unsupported`, `extractor`, `SSRF`, fingerprints, or
  raw ids in ordinary channel messages;
- no claim that Ling read unavailable content;
- no auto-start when a required input is unavailable or blocked.

## Fingerprints

Fingerprints decide whether cached materialization is still valid.

| Source | Fingerprint |
| --- | --- |
| Text/image/PDF/Office attachment | attachment id + stored path + size + content type + file mtime/hash when cheap |
| Link preview metadata | normalized URL + title/description/status updatedAt |
| Link body extraction | normalized URL + final URL + ETag/Last-Modified when available + extractor version |
| Workspace file ref metadata | normalized path + root relation + stat kind + size + mtime |
| Workspace file body extraction | avoid v1; if added later, require managed inspection fingerprint and evidence artifact |

Hashing large files synchronously in the channel message path is not allowed. Use size and
mtime first; compute content hash only in a bounded background/materialization step.

## Extractor Registry

```ts
interface LingMaterializationRequest {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly requestedBy: "turn_envelope" | "workflow_inspection" | "user_action";
  readonly maxBytes: number;
  readonly maxChars: number;
  readonly now: string;
}

interface LingInputExtractor {
  readonly id: string;
  readonly version: string;
  readonly supportedSourceKinds: readonly LingMaterializationSourceKind[];
  readonly supportedContentKinds: readonly LingMaterializationContentKind[];
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
  readonly policyDecision?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}
```

Registry rules:

- extractor ids must be stable and versioned;
- an extractor must return a status, not throw for ordinary unsupported input;
- exceptions are converted to `blocked` with an error code;
- each extractor must enforce its own byte, char, timeout, and content-type budgets;
- feature flags decide which extractors are eligible, not hidden environment state.

## Budget Defaults

Initial defaults should be conservative:

| Budget | Default |
| --- | --- |
| Text attachment inline preview | 16 KiB read, 8k chars prompt preview |
| PDF extraction | 2 MiB read, 24k chars cache text, 8k chars prompt preview |
| Office extraction | 2 MiB read, 24k chars cache text, 8k chars prompt preview |
| Image OCR/vision summary | one bounded textual summary, no raw image bytes in prompt unless provider path supports it |
| Link body fetch | 1 MiB response, 8k chars prompt preview, 10s wall clock, 3 redirects |
| Materialization prompt preview | selected by context budget manager, never unlimited |

If extracted text exceeds the prompt budget, store bounded `contentText` and a structured
summary or source pointer. A managed run may inspect the original source later.

## Source Pipelines

### Text Attachments

Current behavior already previews small text attachments. Move it behind the extractor
registry as `text_attachment_v1`.

Statuses:

- `available`: safe text preview read under budget;
- `blocked`: file missing, too large, invalid UTF-8, cross-channel id;
- `unsupported`: binary content type that is not text.

### Image Attachments

Image v1 must not infer visual details from filename or MIME type.

Allowed outputs:

- `metadata_only`: image name, content type, size;
- `available`: OCR text or vision summary produced by a configured extractor;
- `unsupported`: no image extractor configured;
- `blocked`: image too large, unsupported format, missing file, extractor failure.

Content-dependent requests such as "fix UI from this screenshot" require `available` or a
safe first inspection step.

### PDF Attachments

PDF v1 should extract bounded text and page metadata behind a feature flag.

Required metadata:

- page count when cheap;
- encrypted/protected status when detectable;
- extraction status and truncation.

Statuses:

- `available`: bounded text extracted;
- `not_loaded`: supported but not run yet;
- `unsupported`: extractor unavailable;
- `blocked`: encrypted PDF, parser failure, size limit, missing file.

### Office Attachments

Office v1 covers `.docx`, `.pptx`, and `.xlsx` only after an extractor exists.

Rules:

- output plain text plus lightweight structural summary when safe;
- mark macros, encrypted files, unknown formats, or parse failures as `blocked` or
  `unsupported`;
- spreadsheets should avoid dumping entire workbooks into prompt context.

### Link Body Extraction

Link preview metadata is not full page body understanding.

Full link extraction is a separate materialization step with network policy:

- allow only `http` and `https`;
- block localhost, loopback, private IP ranges, link-local ranges, `file:`, `data:`,
  `javascript:`, and unsafe redirects;
- limit redirects, response bytes, content type, and wall-clock time;
- only unauthenticated public GET is eligible for context materialization;
- authenticated pages, browser-session pages, forms, checkout/account-changing pages, and
  external sends must use managed tools and approvals.

Allowed content types:

- `text/html`
- `text/plain`
- selected structured text types such as `application/json` only when bounded and safe

HTML extraction should keep readable article/body text and drop scripts, styles,
navigation, forms, and tracking markup.

### Workspace File References

Workspace file refs are first-class turn inputs, but body reads should stay on the
managed run/tool path.

Before run:

- normalize path;
- determine inside/outside workspace relation;
- detect file/directory/glob/unknown kind when cheap;
- mark outside workspace as `blocked` unless explicitly policy-approved;
- do not read arbitrary file body content into the ordinary chat prompt.

If the user asks content-dependent work on a workspace file:

- create a safe inspection/read step through the run path;
- use existing approval policy for any write/edit/shell work;
- record evidence in run artifacts or materialization rows only when the read path is
audited.

## Auto-Start Eligibility

Materialization gates auto-start.

```ts
interface LingMaterializationGate {
  readonly mayAnswer: boolean;
  readonly mayAutoStart: boolean;
  readonly missingInputs: readonly LingMissingInput[];
  readonly blockedInputs: readonly LingBlockedInput[];
  readonly firstSafeStep?: "inspect_attachment" | "extract_link" | "inspect_workspace_file";
}
```

Rules:

- ordinary metadata questions may answer from `metadata_only`;
- content summaries require `available`;
- content-dependent edits require `available` or a first safe inspection step;
- writes, edits, shell commands, Git, deploys, and external sends still evaluate runtime
  approval even when all inputs are `available`;
- any `blocked` required input prevents auto-start; Ling should surface concise,
  user-facing clarification only when the current request depends on that blocked input.

Examples:

| User turn | Required input | First outcome |
| --- | --- | --- |
| `what did I attach?` + PDF | metadata | answer from metadata |
| `summarize this PDF` + no PDF extractor | PDF body | clarify/block |
| `fix UI from screenshot` + image extractor disabled | image content | clarify/block |
| `update README based on attached text` + text preview available | text body | proposal or auto-start if tools allow |
| `update README based on apps/foo.ts` | workspace file body | first safe inspection/read step |
| `summarize this link` + local/private URL | link body | explain that Ling will not read local/private links by default and ask for approval or pasted text |

## Prompt Assembly

Prompt assembly consumes `LingAgentTurnEnvelope` plus materialization refs.

Rules:

- include status and source name for every non-text input;
- include bounded content only for `available`;
- include internal reasons for `blocked`, `unsupported`, and `not_loaded` so Ling can
  make correct decisions;
- never include raw ids as the only user-visible context;
- context budget manager decides which previews fit;
- optional evidence expansion may expose materialization ids, policy decisions,
  truncation, and fingerprints; the default transcript should not.

## User-Facing Copy

The main transcript should sound like Ling, not an extractor log.

Default copy rules:

- name the affected input only when needed;
- describe the limitation in user language, not status codes;
- offer the next safe action;
- do not mention SSRF, extractor ids, internal status names, fingerprints, raw ids, or
  byte limits in the main conversation unless the user is explicitly debugging.

Examples:

- `I can see screenshot.png, but I have not inspected the image yet. I can inspect it first, or you can paste the key detail.`
- `I can see report.pdf, but I cannot read its contents in this turn yet. I can start a document inspection step.`
- `That link points to a local/private address. I will not open it automatically; paste the content or ask me to inspect it as a controlled task.`
- `I can inspect README.md first, then apply the edit.`

Do not show:

- selector names;
- router names;
- raw JSON;
- raw attachment/link ids as the primary message;
- permanent `available` / `metadata_only` / `blocked` badges in the normal transcript.

## Implementation Phases

1. **Cache skeleton**
   - status: landed as M1;
   - Add `channel_input_materializations`.
   - Add extractor registry with no new rich extractors enabled.
   - Keep current envelope output unchanged except for materialization references.

2. **Text preview migration**
   - status: landed as M2;
   - Move existing text attachment preview into `text_attachment_v1`.
   - Preserve current prompt behavior and tests.

3. **Blocked/clarify policy**
   - Add materialization gate to intent selector.
   - Block content-dependent proposals when required inputs are missing.
   - First slice implemented for unsupported image/PDF/Office attachment requests,
     blocked/metadata-only link body requests, outside-workspace file refs, and
     attachment-dependent file write proposals.

4. **PDF and link extraction**
   - status: link body landed as M3; PDF text landed as M4;
   - Add PDF text extractor with bounded read/prompt budgets.
   - Add public link body extractor behind policy and SSRF checks.

5. **Image and Office extraction**
   - status: DOCX raw text landed as M4; image remains M5;
   - Add image OCR/vision summary behind feature flag.
   - Add Office plain text extractor for `.docx`; keep `.pptx`/`.xlsx` unsupported
     until dedicated modules can preserve acceptable semantics.

6. **Evidence and Web polish**
   - Keep default transcript focused on user input and Ling outcome.
   - Put status, unblock actions, truncation, and policy details in opt-in
     evidence/details surfaces.
   - Avoid permanent status labels on every attachment, link, or file chip.

## Non-Goals

- No hidden browser-session scraping in ordinary chat.
- No automatic workspace file body reads outside the managed run/tool path.
- No mutation permission from materialization status.
- No huge raw file or page body prompt stuffing.
- No replacement of existing approval, workflow, or run systems.

## Open Decisions

- Which PDF extractor implementation should be bundled first.
- Link body extraction defaults on only for explicit public unauthenticated link-body
  requests; ordinary link metadata turns do not fetch full page body.
- Whether image OCR/vision should run locally, through a provider, or only as a managed
  inspection step.
- How long materialization rows should live before expiry.
- Whether workspace file body reads should ever create materialization rows, or always
  remain run artifacts.
