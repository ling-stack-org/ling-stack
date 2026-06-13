# Web E2E Acceptance Matrix For Ling Agent Inputs

Status: detailed test design updated for default attachment understanding. This document
defines browser-visible acceptance coverage for Ling Agent input materialization,
composer file refs, contextual clarification, queued guidance, and final result display.

Current browser slice:

- Composer workspace file refs are sent as native `fileRefs` and rendered as chips.
- Unsupported screenshot content-dependent requests currently show a Ling clarify reply
  instead of route/proposal internals.
- Screenshot and local/private link clarifications use natural Ling copy and assert that
  implementation/debug vocabulary stays out of the default transcript.
- Active-run guidance rows can render structured file refs from intervention payloads.
- C11 context acceptance adds short-follow-up, materialized PDF/DOCX visible behavior,
  and explicit workflow context inspect coverage.

Target browser behavior:

- Supported attachments are automatically understood after send or before Ling answers.
- Image/PDF/DOCX questions should show Ling's answer from extracted content, not a prompt
  asking the user to inspect the file first.
- The default transcript still shows simple chips only; read/unread/materialization status
  stays out of the ordinary conversation.

## C11 Context Processing Acceptance Slice

This slice validates the "one Ling Agent session" product behavior after Context
Processing, streaming, and automatic materialization landed.

Implemented browser coverage:

1. **Short contextual follow-up**
   - send a terse follow-up such as `继续` after a prior same-channel topic;
   - assert Ling replies from the current channel context;
   - assert route/context/debug/token implementation details stay out of the default
     transcript.

2. **Materialized PDF/DOCX happy path**
   - attach PDF and DOCX files, then ask a natural attachment question;
   - assert the transcript shows simple file links/chips and Ling's natural answer;
   - assert materialization status vocabulary such as `metadata_only`, `not_loaded`,
     `unsupported`, `blocked`, `extractor`, and `fingerprint` is absent from the
     default transcript.

3. **Explicit workflow context inspect**
   - render a completed workflow with context-inspect metadata available;
   - assert the default work cell hides section ids, dropped ids, compaction ids, and
     safety rows;
   - after the user expands details, assert the prompt-safe inspect summary appears and
     raw prompt/log/artifact-body content remains excluded.

Non-goals for this browser slice:

- no real PDF/DOCX parser execution in Playwright;
- no raw prompt text assertions;
- no mobile-specific visual matrix;
- no new default debug UI.

## Purpose

Daemon tests prove the decision path. Web E2E proves the user experience:

- the composer accepts the input;
- the transcript shows the right chips and copy;
- limitations are understandable only when they affect the requested outcome;
- internal selector/router details stay hidden;
- internal materialization/debug status stays hidden by default;
- reload and active-run flows do not lose input context.

This matrix should guide Playwright coverage after each materialization slice.

## Product UX Contract

The Web surface should feel like an AI collaboration product, not a debug console.

Default transcript behavior:

- attachments, links, and file refs render as simple chips or normal message assets;
- no permanent `available`, `metadata_only`, `blocked`, `unsupported`, or `truncated`
  labels appear in ordinary messages;
- Ling automatically prepares and uses safe materialized content for current-turn
  attachments;
- if required content is genuinely unavailable, unsupported, or blocked, Ling gives one
  concise natural-language response with the next safe action;
- detailed extractor status, policy reason, truncation, and source fingerprint belong in
  opt-in evidence/details surfaces.

Browser tests should therefore assert both sides: the needed limitation is visible when it
changes the outcome, and internal status vocabulary is absent from the default transcript.

## Smart UX Implementation Delta

The Smart UX implementation updated existing tests rather than adding a large new suite.
The goal is to lock in the product boundary: internal materialization facts are available
to the runtime, but the user sees simple assets and natural Ling responses.

Implemented test updates:

1. Screenshot fallback clarification
   - keep the current screenshot fallback test only for disabled/failed image extraction;
   - the positive assertion should be natural copy such as `I can't read this image`
     rather than route/proposal/status internals;
   - add negative assertions for `image content is not available`, `metadata_only`,
     `unsupported`, `extractor`, and `SSRF` in the default transcript.

2. Screenshot automatic understanding
   - add a happy-path case with image materialization row `available`;
   - assert Ling answers from the vision/OCR summary without asking the user to inspect
     the image first;
   - assert the file chip stays simple and no read/unread/status badge appears.

3. Local/private link clarification
   - add or update a Web mock-daemon case for a local/private URL;
   - assert the transcript says Ling will not open local/private links automatically;
   - assert `SSRF`, raw policy codes, redirect details, and internal status names are not
     visible unless a details surface is opened.

4. Blocked proposal primary copy
   - when an unavailable attachment blocks auto-start, the visible card should explain the
     next safe action;
   - the test should not require byte limits, extractor ids, or raw status names in the
     card body.

5. Evidence/details
   - if a details drawer exists for the scenario, tests may assert technical status there;
   - if no details drawer exists yet, do not force one only for this slice.

Mock daemon rules:

- preserve internal fields in mock state and response payloads;
- generate natural `aiReply.body` for transcript assertions;
- keep `channelIntentDecisions.reason` technical enough for daemon/debug assertions.

## Test Layering

Use three layers. Do not ask one giant browser test to prove everything.

| Layer | Purpose | Examples |
| --- | --- | --- |
| Core/daemon tests | Prove persistence, schemas, materialization statuses, auto-start gates, and interventions. | `packages/daemon/test/channel-workspace.test.mjs` |
| Web mock-daemon tests | Prove browser behavior against stable API contracts. | `apps/web/e2e/channel.spec.ts` |
| Live smoke | Prove local daemon/web wiring after merge or restart. | `ling restart`, browser smoke, targeted curl |

Browser E2E should assert visible UI, accessibility labels, persistence after reload, and
hidden diagnostics. It should not depend on raw selector JSON unless the test is
specifically a developer diagnostics test.

## Modular E2E Strategy

Each materialization module gets only the browser coverage that proves user-visible
behavior. Parser correctness and cache behavior belong in daemon/core tests.

| Module slice | Browser coverage | Non-browser coverage |
| --- | --- | --- |
| M1 cache/registry | none unless transcript changes | SQLite round trip, cache hit/miss, fingerprint invalidation |
| M2 text attachment | existing README/text attachment flow | extractor success/too-large/missing-file/truncation |
| M3 link body | public link summary and local/private link clarify | URL policy, redirect blocking, timeout, content-type, size limit |
| M4 PDF/Office | PDF/DOCX extracted-answer happy path plus unsupported fallback when visible | daemon parser fixtures for PDF/DOCX success, `.pptx`/`.xlsx` unsupported, too-large/missing/truncated |
| M5 automatic attachment understanding | image vision/OCR happy path, unsupported image fallback, no status-chip regression | provider capability/failure/cached-summary tests |
| M6 details polish | details drawer and mobile visual smoke | payload/schema tests |

This keeps the Web suite product-focused and prevents extractor implementation details
from leaking into browser assertions.

## Test Data Principles

- Keep mock state minimal for each scenario.
- Clear unrelated pending approvals/runs when testing composer-only behavior.
- Use deterministic attachment ids, link ids, file paths, and timestamps.
- Prefer visible labels and aria labels over brittle DOM depth.
- Assert that internal terms such as `selector`, `auto_route`, `routeDecision`,
  `workflow_proposal`, and raw ids are absent from the default transcript.
- Assert that materialization implementation terms such as `metadata_only`, `not_loaded`,
  `unsupported`, `blocked`, `extractor`, `fingerprint`, and `SSRF` are absent from the
  default transcript unless the user has opened a details/debug surface.
- If a scenario needs materialization rows, mock them explicitly instead of making the
  browser test run a real extractor.

## Priority Levels

| Priority | Meaning | Required before |
| --- | --- | --- |
| P0 | User-facing regression blocker for the current slice. | merge |
| P1 | Important cross-flow behavior, can land in the same feature branch or next slice. | release |
| P2 | Broader visual, reload, or mobile coverage. | hardening |

## P0 Matrix

| ID | Flow | Setup | User action | Expected visible result | Hidden/internal assertion |
| --- | --- | --- | --- | --- | --- |
| P0-1 | Composer file ref only | Active channel, no active run, no approvals | Type `apps/web/src/features/workspace/WorkspaceClientView.tsx`, send | User message appears, file chip appears under "Workspace file references", composer clears | POST body includes `fileRefs`; no route/debug chrome appears |
| P0-2 | Empty text plus file ref | Active channel, clean mock state | Send a composer file chip with no other text when supported by UI | Send button is enabled, message persists | Request is accepted with empty `body` and non-empty `fileRefs` |
| P0-3 | Reload preserves file chip | Existing channel message with `fileRefs` | Reload page | File chip still appears on the same user message | No fallback raw JSON or raw id text appears |
| P0-4 | Active run file-ref follow-up | Active run in channel | Send file ref as follow-up | Queued guidance row names the file ref | Intervention payload includes `fileRefs`, not only body text |
| P0-5 | Outside workspace file ref | Channel bound to workspace, file ref points outside root | Send or render outside file ref | Ling explains it will not read that path by default and offers a controlled inspection path | No hidden file read, no auto-start, no raw status badge |
| P0-6 | Screenshot fallback without image extraction | Image attachment, no image extractor or failed extractor | Ask `fix UI from this screenshot` | Ling says it cannot read the image yet and asks for supported input or pasted detail | No invented screenshot details, no extractor/debug vocabulary |
| P0-7 | Text attachment content-dependent task | Small text attachment under budget | Ask to write README from attachment | Proposal/auto-start can use preview when policy allows | Prompt/evidence includes bounded preview status |
| P0-8 | Link-only metadata | Ready link preview, no body extraction | Send only a link or ask what it is | Ling uses title/description metadata or asks what to do | Does not claim to read full page body |
| P0-9 | Local/private link extraction | localhost/private URL | Ask to summarize link | Ling says it will not open local/private links automatically and offers pasted text or controlled inspection | No fetch result or body summary appears, no SSRF/debug vocabulary |
| P0-10 | Completed run transcript | Run completes from proposal | Observe channel after completion | User sees final result/summary, not duplicate process/router rows | Selector/router diagnostics only in evidence/debug surfaces |

## P1 Matrix

| ID | Flow | Setup | User action | Expected visible result | Hidden/internal assertion |
| --- | --- | --- | --- | --- | --- |
| P1-1 | PDF automatic extraction | PDF attachment, materialization completes as `available` | Ask `summarize this PDF` or attach with a PDF question | Ling summarizes naturally from extracted text without asking to inspect first | Raw materialization JSON and status labels hidden |
| P1-2 | PDF unsupported or blocked | Encrypted/unsupported PDF or extractor failure | Ask `summarize this PDF` | Ling says it could not read the PDF and asks for readable upload or pasted text | No PDF summary invented, no status badge |
| P1-3 | Office automatic extraction | `.docx` attachment, materialization completes as `available` | Ask to summarize doc | Ling uses bounded extracted text without asking to inspect first | Truncation details appear only in evidence/details when applicable |
| P1-4 | Office unsupported | `.pptx`/`.xlsx` or extractor failure | Ask to use document content | Ling asks for supported export or pasted content | No document body summary invented, no status badge |
| P1-5 | Image OCR/vision automatic | Image materialization row `available` | Ask a screenshot/UI question | Ling uses extractor summary directly, not filename inference or inspect-first copy | Evidence links to materialization status |
| P1-6 | Link body extraction success | Public link materialization row `available` | Ask to summarize link | Ling summarizes extracted body and shows link chip | Final URL and status in evidence |
| P1-7 | Link body extraction timeout | Public link extraction failed | Ask to summarize link | Ling says it could not read the page and offers retry/paste path | No stale title-only body summary, technical timeout details only in evidence |
| P1-8 | Cross-channel attachment id | Message references attachment from another channel | Send/route message | Ling asks for the file again or a valid attachment | No uncaught exception, no raw id leak |
| P1-9 | Missing attachment file | Attachment row exists, file missing | Ask content-dependent question | Ling says it cannot access the file and asks for re-upload | No auto-start, no raw storage path leak |
| P1-10 | Queued guidance mixed assets | Active run, text + attachment + link + file ref | Queue follow-up | Guidance preview names every asset naturally | Payload preserves body, attachment refs, link refs, file refs, and internal materialization state |

## P2 Matrix

| ID | Flow | Setup | User action | Expected visible result |
| --- | --- | --- | --- | --- |
| P2-1 | Mobile composer file chip | Mobile viewport | Type long file path | Chip wraps or truncates without overlapping controls |
| P2-2 | Right drawer materialization details | Blocked materialization | Open evidence/details | Shows input name, source kind, status, reason, unblock action in the opt-in panel only |
| P2-3 | Long extracted text truncation | Available materialization with truncation | Ask summary | Main reply stays natural; evidence/details says extracted text was truncated |
| P2-4 | Multiple duplicate file refs | Same path repeated in body and fileRefs | Send message | One visible chip or deterministic deduped chips |
| P2-5 | Branch/topic reply file refs | Topic reply composer supports refs if enabled | Send reply | Thread message preserves file refs |
| P2-6 | Visual regression | Desktop and mobile screenshots | Run targeted screenshots | No overlap between chips, message text, footer actions, and drawers |

## Mock Daemon Contract

The Web mock daemon should support these fields on channel messages:

```ts
interface MockChannelMessage {
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly {
    readonly path: string;
    readonly label?: string;
    readonly source?: "composer" | "explicit_text" | "api";
    readonly line?: number;
  }[];
}
```

It should also support materialization fixtures when Web surfaces need blocked/available
state without running real extractors:

```ts
interface MockInputMaterialization {
  readonly sourceKind: "attachment" | "link_preview" | "workspace_file_ref";
  readonly sourceId: string;
  readonly status: "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";
  readonly contentKind: string;
  readonly contentText?: string;
  readonly errorMessage?: string;
  readonly truncated?: boolean;
}
```

## Test Placement

Recommended locations:

- `apps/web/e2e/channel.spec.ts`
  - composer file refs;
  - channel transcript chips;
  - active-run guidance surface;
  - natural clarification transcript copy;
  - absence of internal materialization vocabulary in default transcript.
- `apps/web/e2e/runtime.spec.ts`
  - final run result transcript;
  - active run intervention detail panels.
- `apps/web/e2e/support/mock-daemon.ts`
  - message `fileRefs`;
  - materialization fixture support;
  - materialization responses that affect the requested outcome.

Do not split spec files just to satisfy this matrix. Follow `web-modularization.md`:
split when support boundaries are stable or merge conflicts become a real cost.

## Assertions To Prefer

Prefer:

```ts
await expect(page.getByLabel("Workspace file references").getByText("README.md")).toBeVisible();
await expect.poll(() => state.lastChannelMessageRequest?.fileRefs).toEqual([...]);
await expect(page.getByText("The screenshot shows")).toBeVisible();
await expect(page.getByText("routeDecision")).toHaveCount(0);
await expect(page.getByText("metadata_only")).toHaveCount(0);
await expect(page.getByText("SSRF")).toHaveCount(0);
```

Avoid:

```ts
await expect(page.locator(".message-row > div:nth-child(2) > span")).toHaveText(...);
await expect(page.locator("body")).toContainText("raw_internal_id");
```

## Ship Gate For Materialization Slices

Each materialization implementation slice should pass:

1. relevant daemon tests for schema, status, and auto-start gating;
2. targeted Web typecheck;
3. one P0 Playwright flow for the changed input source;
4. `git diff --check`;
5. a short local browser smoke when UI copy or layout changes.

For larger extractor slices, add:

- extractor unit tests with success, unsupported, blocked, too-large, and timeout cases;
- SSRF/private network tests for link extraction;
- truncation and token-budget tests;
- evidence drawer tests if materialization ids become visible.
- negative transcript assertions that keep implementation/status vocabulary out of the
  default UI.

## Rollout Map

1. **Current fileRefs slice**
   - P0-1, P0-3, P0-4 are required.
   - P0-2 depends on composer UX allowing chip-only input.

2. **Materialization cache skeleton**
   - Status: landed at core/daemon level.
   - No browser case is required while the default transcript is unchanged.
   - Add mock materialization fixtures and P1 evidence/detail tests only when UI renders
     materialization rows or details.

3. **Text/PDF/link extraction**
   - Status: text attachment, public link body, PDF text, and DOCX raw text landed at
     core/daemon level; M5a added automatic current-turn PDF/DOCX attachment triggers.
   - Add P0-8, P0-9, P1-1, P1-2, P1-6, P1-7.

4. **Image/automatic Office extraction**
   - Status: image materialization contract and automatic enqueue landed; provider or
     worker-backed image summarizer remains.
   - Add P0-6, P1-3, P1-4, P1-5.

5. **Polish and visual hardening**
   - Add P2 mobile and visual checks.

## Open Decisions

- Whether chip-only composer sends should be supported by explicit UI action or only by
  parsed path text in v1.
- Whether topic replies should support file refs in the same release as root channel
  messages.
- Whether blocked materialization details belong in the right drawer, inline proposal
  card, or both.
- Which tests should run in default `test:e2e` versus targeted CI jobs when the suite
  grows.
