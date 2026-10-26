# Automatic Memory + Memory Citations in Transcripts

## Status

Status: design approved for implementation
Owner: Memory / Conversation UI / Daemon
Last verified: 2026-10-26

## Background and competitive reference

Codex Desktop maintains automation memory; ZCode silently persists durable
user/project facts and recalls them in later sessions. Ling has teammate
memory (markdown files, prompt consolidation, export/import) — but it is
*manual*: nothing is captured from conversations, and when memory shapes a
response the transcript does not say so (`docs/design/conversation-memory-citations-and-sources.md`
records the citations design as not implemented). Users experience both ends
of the same failure: "it doesn't remember anything" and "why does it think
that?"

## Goal

1. Durable facts surfaced by a teammate's conversation are captured as
   candidate memories with explicit review (bounded admission, no silent writes).
2. When memory content is included in a prompt, the transcript shows a
   compact, inspectable citation ("from memory: preferences.md").

## Design

### 1. Capture: candidate queue, human-reviewed admission

Reuse the existing skill-recording review pattern (`skill-*.ts` governance
modules) rather than inventing one:

- The runner emits `memory_candidate` evidence when the model's turn includes
  a durable-fact statement (detected by a bounded heuristic on the *model's own
  output tool-call*: a new optional tool `memory_suggest` the model may call —
  structured `{ fact, scope, source_message_ref }`, not free-text scraping).
- Candidates land in a review queue (web: Teammate detail → Memory →
  "Suggestions"); approving writes the markdown memory file through the
  existing memory file service. Declining records a negative signal (bounded
  counter) so repeated suggestions decay.
- This matches Ling's approval-first philosophy and the existing
  "fenced admission" language used across harness features.

### 2. Citations: prompt-assembly side channel

- Today memory consolidation injects file content into the prompt invisibly.
  Change: the runner records *which* memory files (and byte ranges) were
  included in the invocation input alongside the existing per-invocation SDK
  context budgets (`capture immutable per-invocation SDK context budgets` is
  already implemented — this rides the same structure).
- Contracts: `ConversationMemoryCitation { memoryId, path, title, excerpt }`
  attached to the conversation item metadata (additive, optional).
- UI: a small "memory" chip on the turn; expanding shows title + excerpt +
  "open file" (reuses teammate memory file viewer).

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Teammate memory files | unchanged | Capture only *proposes* writes through existing file service; format untouched, export/import keeps working. |
| Context budgets capture | reuse | Citations read from the same per-invocation capture; no second instrumentation. |
| Conversation item schema | additive | Optional metadata field; older clients/renderers ignore unknown metadata (projection code is field-tolerant — same pattern as handoff blocks). |
| Memory review policy | reuse | Candidate admission flows through existing policy/health modules. |

### 4. Incompatible-case upgrade path

If citation metadata grows (e.g. per-excerpt spans), the contract carries a
`citationVersion`; renderers fall back to title-only display for unknown
versions. Memory files themselves are plain markdown — no migration ever
required, which is the point of keeping capture file-backed.

## Implementation plan

1. Contracts: candidate + citation types; `memory_suggest` tool schema.
2. Runner/daemon: tool registration (approval-gated), candidate persistence,
   prompt-assembly capture of included memory refs, citation attachment to
   conversation items.
3. Web: suggestions review queue UI; memory chip in transcript turn renderer.
4. Tests: runner unit (suggest → candidate persisted; decline decays),
   citation attachment unit (budget capture → citation), Playwright spec with
   mocked daemon: turn with citation shows chip and opens excerpt, screenshot
   evidence.

## Acceptance

- A mocked turn that calls `memory_suggest` produces a review-queue entry;
  approving writes a memory file (unit + Playwright).
- A turn whose prompt included memory files renders the citation chip;
  expand shows excerpt (Playwright, screenshot).
- Existing memory/skill suites stay green.
