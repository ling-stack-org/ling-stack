# Conversation Turn Response Ownership

Status: accepted implementation increment; net review implemented 2026-10-01.
Packaged normal/private and channel/depth-1 file-card/navigation acceptance passed.
The original late-report case passed real Host GET + production projection, but
has not been reopened in native GUI: it is beyond the five recent entries. A
fresh native nonzero-deletion case also remains unrun after macOS locked. These
are acceptance gaps, not permission to claim the entire E6/Harness completed.
Extends the shared typed transcript/component and visual contracts. This addendum
replaces message-local final actions with response-level ownership, not history.

## Boundaries

- One user Turn may contain multiple model messages, Runs and tool Items.
- Root and each child Agent scope have separate response groups. Child prose is
  not copied into a parent response. User messages retain their own edit/copy.
- Existing canonical/effective-attempt projection remains the history authority.
  This pure display projection must not select retries, infer execution success,
  modify ConversationItems, sort tool events or create another scroll owner.
- A response identity is scoped to its existing Timeline and Turn. Missing Turn
  identity falls back to Run or logical message identity, never a global bucket.

## Ownership

User-message presentation is shared across normal, teammate-direct and channel
surfaces: a right-aligned, content-sized rounded bubble using theme tokens, with
an optional existing right-side avatar. Agent narration and typed tool facts
remain unboxed. The user action row stays outside/below the bubble; this styling
does not change message/Turn ownership or Agent response-copy policy. Multi-line
Markdown, code, attachments and references use the existing body renderers.

1. First narration from each visible speaker owns identity. Subsequent segments
   reserve the same avatar column without repeating the image or changing width.
2. Message attachments/errors keep their existing last-segment owner.
3. A settled report owns the response footer when present. Otherwise the final
   Host-settled message owns it. Commentary or live/waiting state never exposes
   final-response actions. A final-looking text string is not completion evidence.
   Workflow child narration inherits settlement from its validated owning Host
   step. Earlier segments stay commentary; only the last segment receives final
   phase when that step is terminal. Narrow narration polls do not own lifecycle;
   full protocol reads/SSE updates supply terminal status independently.
4. Logical footer ownership and its display position are separate. Rendering
   occurs after the response's last disclosed row, including trailing commands
   after narration and the last child of an expanded batch. Use the complete
   display model, not the viewport's virtual subset, so scrolling cannot move
   final chrome. Hidden child responses have no visible footer. No second
   Timeline and no commands moved inside Markdown.
5. One complete-response copy/feedback bar, hidden until hover/focus. Code block
   copy remains a separate local action. Adapters provide existing feedback/task
   callbacks, but cannot introduce another Agent-message footer.
6. Whole-response copy contains visible narration from this response only;
   multi-message replies retain scoped chronology. The shared footer passes its
   computed copy text into normal/private/channel action callbacks. Adapters may
   provide surface-specific feedback actions, but must not replace that text with
   a last-message body. Absent final narration, commentary plus the privacy-filtered
   report form the result fallback, including when the linked AI message is empty.
   Raw logs, IDs and child/private Agent content are not appended implicitly.

## Completion and changes

- Keep TerminalReport/Completion Gate as authoritative facts, without requiring a
  report card in the visible transcript. A successful response with a settled,
  nonempty final Agent message suppresses the redundant report presentation.
  The original report still owns completion, the final file card and one footer.
  Commentary alone does not count as a final answer: absent final narration,
  the privacy-filtered report remains the final-result fallback.
- Normal transcript DTOs explicitly distinguish `contentSource=run_narration`
  from a synthetic `host_status` placeholder on both stream and history reads.
  Only a settled, published canonical report for the same Turn/Run can suppress
  that placeholder and its raw runtime error. Unknown provenance, real segments,
  live messages and mismatched/unpublished reports preserve the message. No
  prose matching, historical rewrite or new SQLite record is used.
- Report-only non-success endings include their own privacy-filtered critical
  run-level warnings as readable paragraphs (unique prose), including interrupted
  execution and unconfirmed effects. Atomic status remains unchanged. Full
  attention details stay initially open and retain all risk/check identities;
  their header is “Execution details”, not a repeated copy of the user objective.
- Failed/blocked/cancelled/partial outcomes, non-passed checks, incomplete
  participants and unresolved/unverified risks stay visible and initially open.
  A succeeded Host outcome with such attention is labelled as needing attention,
  without rewriting its durable status. Corrections/non-file deliverables may
  supplement successful narration. Hidden/private evidence must be filtered
  before this decision, so it cannot leak through disclosure or attention state.
- Generation/report identities remain in durable audit/API lineage and DOM
  diagnostic attributes, not visible conversation text. Command disclosure reads
  atomic command/output/exit evidence, not a regenerated model report summary.
  Report summaries remain model-authored or deterministic-fallback narration;
  validation does not make every prose sentence an independently verified fact.
- The final file summary appears only for evidenced mutations in this response.
  Use successful atomic file actions and visible committed report changes, not
  Markdown path guesses, approval preview or activity-batch counts.
- Show file icon/count, bounded first-three list, more-files disclosure, full-path
  tooltip and evidence-backed statistics. Repeated edits do not become a fake net
  diff by summing patch counts; unknown statistics remain absent.
- Opening the live file uses the owning atomic action's Host capability. A report
  path alone does not grant access. Historical Review is a separate read-only
  scoped projection; showing its path must not create a live-file capability.
- Undo/reapply reuse existing Turn/Run recovery and provenance/CAS checks; no
  automatic destructive actions or universal-undo promise.
- Failure, partial, cancellation and blocked attention remain visible even when
  successful metadata is compact. Retry/SSE/restart retain stable group ownership.

## Net change Review and navigation

- Host records bounded before/after file content in the mutation's sealed forward
  artifact, never in public event/artifact metadata or model context. The existing
  SQLite mutation records, domain-separated hashes and provenance sequence remain
  authoritative; no new batch/review table is required.
- Run/Turn/Workflow GET returns `WorkspaceChangeReview`, with stable scope,
  workspace/thread/run identities, revision, files, coveredPaths and exact/partial/
  unavailable state. GET reconstructs only from durable records and sealed
  snapshots; it does not read current disk/Git or write back a synthesized history.
- The first before and final after form the net diff only when every selected
  mutation is applied, fingerprints match and same-path history is continuous.
  Edits followed by restoration and create-then-delete have no net row. Their
  coveredPaths prevent old report paths from reintroducing a removed row.
- Exact files provide their own additions/deletions. Aggregate counts exist only
  when every disclosed file is exact. Old missing snapshots, binary content,
  external edit gaps or computation/display budget exhaustion remain unavailable,
  not zero. Recovery's operation-sum statistics and Undo/CAS semantics are unchanged.
- Snapshot budget: 4 MiB / 128 paths. Review read budget: 2000 records, 128 paths,
  32 MiB snapshots and 750 ms. Each diff is bounded by 100 ms / 20000 edit length /
  512 KiB; total displayed diff is at most 2 MiB. Secret redaction and existing
  disclosure/privacy path filtering apply before presentation and copy.
- Root uses its explicit workflow scope, otherwise Turn/Run. Depth-1 always uses
  its own Run, never an inherited parent Turn or sibling Workflow. A scope change
  immediately hides the previous resource; an old pending GET cannot publish into
  the next conversation. Summary and recovery controls share one scoped read.
- The card's “View changes” opens the entire disclosed scoped set in the existing
  right dock. A file click opens that same set with `requestedPath` and highlights/
  locates its diff. It does not fall back to whole-workspace Git/WIP. File identity
  comes from Host path/id, not heuristic parsing of unified-diff headers.
- An effective report appended after a newer Turn is repositioned only in the
  presentation array, after its own response's last non-report item. Canonical
  sequence and evidence identity remain unchanged; unknown/orphan ownership is
  not guessed. The placement is recursive for depth-1 and idempotent.

## Verification

Pure tests: identity/footer separation, multiple messages, Turn isolation, nested
copy isolation, fallback report, live/commentary, scoped optimistic rows, hidden
references, no preview promotion, unknown/repeated-edit statistics.

Rendered tests: all three surfaces and depth-1 use the same component; exactly one
footer per response, complete copy with tools between narration, hidden-hover-focus
behavior, final files outside result disclosure, bounded expansion, denied open,
failure/partial/cancelled and refresh. Browser fixtures do not replace packaged QA.

Packaged macOS: reopen accepted real cases, verify identities and both full/local
copy, inspect final file summaries and actual source/diff. Preserve prior history;
never resend accepted tasks merely to make a prettier screenshot.
