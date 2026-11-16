# Ling Companion

Status: character renderer, streaming/recovery, proactive controls, and independent desktop window implemented
Owner: repository maintainers
Last verified: 2026-11-17
Document type: product and architecture contract
Code and test anchors: `packages/contracts/src/companions.ts`,
`packages/core/src/companion-types.ts`, `packages/core/src/storage/sqlite/companion-store.ts`,
`packages/daemon/src/features/companions`

## Goal

Ling Companion is a durable, presentation-independent intelligent partner. It gives an
existing Ling AI teammate a companion presence: a name, manifest of supported emotions and
actions, deterministic state, event history, and optional proactive behavior.

The companion is a domain layer inside Ling. It does not introduce a second model
configuration, provider registry, credential store, memory system, or permission system.
The `teammateId` binding is the only model association. Ling resolves the teammate's
`workspace_default` or `fixed` model binding through the existing provider configuration.
DeepSeek is one possible provider preset; it is neither required nor special to the
Companion contract.

## Reference decision

The relevant DeepSeek open-source reference is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
not a separate pet model. Its official architecture describes an everything-is-a-plugin
runtime, typed services and events, configurable profiles/bundles, and durable session
events. Those seams are useful precedent for Ling's surface and event integration. The
official core does not define a pet or companion domain or a second model-configuration
path; pet implementations found around the Harness ecosystem are host plugins and
community extensions. Ling therefore borrows the extension and event boundaries while
keeping model selection in the existing `AiTeammate` and Adapter configuration.

The complete target is:

```text
Companion profile
  -> existing AiTeammate
       -> existing model binding and provider adapter
       -> existing private thread, memory scopes, tools, and permissions
  -> deterministic companion state reducer
  -> validated semantic event stream
  -> any Ling surface (chat, web avatar, desktop surface, or future client)
```

## Boundaries

`AiTeammate` remains the authority for system prompt, model selection, provider
credentials, private chat, teammate memory, tools, skills, MCP bindings, and approvals.
`CompanionProfile` owns only partner presentation and behavior policy. A companion never
stores `model`, `baseUrl`, `apiKey`, or a provider-specific setting.

The manifest describes capabilities, not renderer implementation. An action such as
`greet` or `think` is a semantic event. A UI may map it to an animation, sound, or text
decoration, but the daemon does not execute arbitrary local commands from model output.

The Ling web renderer uses a transparent, non-pixel full-body pose atlas for 澜星/Yui
(`apps/web/public/companions/yui-poses.png`). Its three columns and two rows contain
idle, thinking, greeting, celebrating, waiting, and attention poses. Phases and manifest
actions select a registered pose; `tired` and `sad` emotions select the waiting and
attention poses while idle. Breathing and celebration motion use CSS transforms and
respect reduced-motion preferences. The fixed companion surface contains separate character
and conversation columns: messages, status, actions, settings, and the composer stay in the
conversation column. Below 640 CSS pixels, the character occupies its own row above the
conversation. Controls never overlap the character. Conversation surfaces use Ling's
current semantic theme tokens with opaque reading backgrounds. System scheduler prompts
are excluded from the rendered transcript. Text input and model execution remain separate
from the visual asset.

## Contracts

The public contract is in `packages/contracts/src/companions.ts`.

- `CompanionProfile` binds one companion to one `teammateId` and stores its manifest,
  behavior policy, and lifecycle status.
- `CompanionState` stores `idle`, `thinking`, `speaking`, `reacting`, or `error`, one
  manifest-declared emotion, bounded intensity, bounded energy, and interaction time.
- `CompanionEvent` is an append-only semantic record. Events include message, emotion,
  action, memory candidate, presence, proactive prompt, milestone, and error categories.
- `CompanionReply` is the provider-neutral structured result used by the dialogue route.
  Text is displayable output; emotions and actions are requests that require manifest
  validation; memory candidates remain reviewable until explicitly accepted.

Malformed structured output must not discard usable text. The parser keeps text, clamps a
finite emotion intensity to `0..1`, drops malformed action and memory entries, and leaves
execution to the manifest validator.

## Runtime flow

1. A surface selects a Companion and sends a message or semantic interaction.
2. Ling resolves the bound teammate and uses its existing private-message/provider path.
3. The Companion dialogue route adds the manifest and current state as bounded context,
   then calls the bound teammate's existing direct-reply execution path.
4. Ling validates every requested emotion and action against the manifest.
5. The daemon persists messages through the existing teammate direct store and persists
   companion state transitions and semantic events through the Companion store.
6. A surface consumes the event stream and decides how to render it.

When a reply contains a `memoryCandidates` item, the daemon creates a teammate-scoped
`MemoryObject` with `reviewState: "candidate"`, `enabled: false`, `private` sensitivity,
and a source reference to the reply. It also creates the existing governance notification
for the teammate direct surface. The candidate is not recalled by the model until the
existing Memory review API approves it; `approve` promotes it to `active`, while reject,
archive, or quarantine keeps it out of normal recall.

The dialogue MVP exposes a Companion-id convenience route while keeping the same direct
thread and message store. It accepts a message body and an optional idempotency key; model selection, Provider
credentials, tools, permissions, and workspace execution are resolved from the bound
`AiTeammate`. Structured output is optional: ordinary text remains displayable, and a
trailing `LING_COMPANION_META:` JSON object supplies validated emotion, action, and memory
candidate facets.

## State and safety rules

State transitions are deterministic. The model may request an emotion or action, but it
cannot set permissions, provider configuration, memory visibility, relationship authority,
or arbitrary energy values. The reducer clamps energy to `0..100`, clamps emotion intensity
to `0..1`, rejects undeclared actions/emotions, and rejects interactions for disabled
companions.

`paused` prevents proactive behavior while retaining history. `disabled` is a soft-delete
state and rejects new interactions. Event payloads are JSON objects and are treated as
data, never as executable instructions.

All Companion collection and item routes validate the request origin and workspace
before accessing the store. Requests require an allowed local origin, when present,
and a daemon-trusted workspace root through the existing workspace access policy.

## API surface

```http
GET    /companions?cwd=...
POST   /companions?cwd=...
GET    /companions/:id?cwd=...
PATCH  /companions/:id?cwd=...
DELETE /companions/:id?cwd=...              # soft-disables
GET    /companions/:id/state?cwd=...
GET    /companions/:id/events?cwd=...
POST   /companions/:id/interactions?cwd=...
POST   /companions/:id/proactive?cwd=...
GET    /companions/:id/messages?cwd=...
GET    /companions/:id/messages?cwd=...&idempotencyKey=...
POST   /companions/:id/messages?cwd=...
POST   /companions/:id/messages/stream?cwd=...
```

Companion message routes resolve the bound `teammateId` and reuse its direct thread,
message store, workspace preparation, provider binding, memory visibility, tools, and
permissions. Companion requests cannot supply a `providerPresetId` or create a second
model configuration. The stream emits the same execution milestones as teammate direct
replies and adds the parsed Companion state and reply on `done`. Message reads accept
`limit` and `beforeMessageId`; event reads accept `limit`, `beforeCreatedAt`, and
`beforeEventId`. Responses expose `hasMore` and the next cursor while retaining the
original array fields. Message writes accept an optional `idempotencyKey`; completed
outcomes, including recorded reply failures, replay the existing user/AI pair. A failure
before a reply is persisted permits a retry with the original user message, including
after a daemon restart. Concurrent requests join the same in-flight result across JSON
and streaming transports. Reusing a key with different text returns
`409 companion_message_payload_mismatch`. A read with `idempotencyKey` returns an
`accepted` or `unknown` submission receipt, its persisted user/reply messages when
available, and current state; it does not dispatch a provider run. A persisted pending reply returns `companion_message_in_progress`
instead of dispatching another run.

The proactive scheduler is daemon-owned and uses the same direct-reply service as a user
message. It scans active Companions, skips disabled or paused records, and enforces
`proactiveEnabled`, `quietHours`, and `cooldownMs`. Each trigger writes a durable
`proactive_prompt` event with an idempotency key after persisting the reply outcome.
An in-process in-flight map joins concurrent duplicate requests and enforces cooldown
while a reply is pending. Completed outcomes replay after restart; startup failures
retain error state and permit retries with the original prompt. An incomplete prompt
marker without a reply does not count as a completed outcome. The manual endpoint
accepts `{ "force": true, "idempotencyKey": "..." }`; force bypasses cooldown and quiet
hours only for that local trigger.

## Delivery phases

1. **Foundation (delivered):** contracts, manifest validation, structured reply parser,
   SQLite profile/state/event storage, CRUD/state/event/interaction API, and focused tests.
2. **Dialogue MVP (delivered):** resolve the bound teammate, reuse direct-message
   execution, add bounded Companion context, persist validated reply events, and preserve
   streaming text.
3. **Memory review bridge (delivered):** turn model memory candidates into the existing
   teammate-scoped promotion inbox and governance notification flow. Candidates remain
   inactive until review.
4. **Proactive scheduler (delivered):** enforce status, policy, cooldown, quiet hours,
   durable idempotency, and single-flight execution through the existing direct-reply path.
5. **Surface contract (delivered):** stable state, event, and message APIs with cursor
   pagination and idempotent writes for Web/Desktop clients.
6. **Conversation renderer (implemented and locally verified):** render the transparent
   six-pose character atlas beside the conversation, consume reply text through SSE, and
   map validated semantic phases/actions to poses. Keep a pending idempotency key in
   localStorage, scoped by workspace and Companion; message text stays in the daemon.
   A reconnect or reload looks up the receipt before retrying the same message and key.
   A restored key keeps the composer disabled until its original message is recovered;
   a failed receipt lookup cannot bind newly typed text to an earlier submission.
   Fetch 40 messages at a time and preserve the older-history cursor across background
   synchronization. Abort streaming on surface disposal and ignore stale session results.
   Sync state/history/events every five seconds when not sending, and resume on visibility
   or online events. This is bounded polling for background semantic events, not a separate
   live event transport.
7. **Proactive controls (implemented and locally verified):** new UI-created Companions
   default to proactive behavior off and a 15-minute minimum interval. Settings expose
   enablement, 5/15/30/60/240-minute intervals, and optional hourly quiet periods using the
   daemon computer's local time. Existing custom intervals remain selectable. Clearing a
   quiet period writes `quietHours: null`; equal start/end is rejected by the UI.
8. **Native surface (implemented and locally verified on macOS arm64):** the main window
   opens a separate transparent, frameless, always-on-top Electron window, initially
   760 by 680 pixels and clamped to the display. It can move, resize, close independently,
   and open Companion Settings in the main window. Closing the owning main window closes
   the Companion; hiding it leaves the Companion usable. The dedicated sandboxed preload
   exposes only workspace/daemon context and close/settings commands, not `lingDesktop`.
   IPC and opaque-origin request projection require the owned, trusted top-level document.

Deterministic daemon/provider fixtures cover recovery and policy boundaries. They are
separate from the real-provider acceptance described below. There is no additional model
or credential configuration for the Companion.
Completion means a Companion can be created for any active teammate, converse through the
same configured model path, preserve private history and memory boundaries, emit validated
semantic events, pause/resume proactive behavior, and switch between any Ling provider
without changing Companion data.

## Completion work plan

The following work tracks the Web and desktop companion surfaces. A milestone is
complete only after its implementation and relevant acceptance checks pass.

- [x] **Character resources:** use a transparent, non-pixel full-body Yui pose atlas based
  on the supplied character reference. Register idle, thinking, greeting, celebration,
  waiting, and attention poses; size the character for readable adult proportions on
  desktop and smaller viewports. Respect reduced-motion preferences.
- [x] **Conversation surface:** consume the existing streaming message endpoint, retain
  one idempotency key per pending user message across retries and reloads, load older
  history with the existing cursor, and reconcile messages/state after connectivity
  returns. Isolate pending requests and drafts by workspace and companion.
- [x] **Proactive controls:** expose proactive enablement, cooldown, and optional quiet
  hours in Settings. Make creation defaults explicit and preserve the remaining policy
  fields when editing one setting.
- [x] **Independent desktop window:** provide a transparent companion window with its
  own bounded preload/IPC authority, workspace/companion selection, native dragging and
  close behavior. Keep it usable while the main Ling window is hidden. Include the
  renderer, preload, and character assets in desktop builds.
- [x] **Local acceptance:** cover streaming, retries, pagination, reconnection,
  settings, and native-window boundaries with focused behavior tests; run production and
  test typechecks, browser visual checks, a real-provider multi-turn session, a sustained
  runtime check, and local desktop packaging/runtime checks.

Integration is tracked in [PR #717](https://github.com/ling-stack-org/ling-stack/pull/717),
which records the final source revision, CI gates, review threads and merge status.

## Acceptance evidence and limits

- Focused daemon Companion suites: 17 tests passed, including receipt lookup, retry
  deduplication, changed-text rejection, restart recovery, memory, proactive scheduling,
  quiet-hour clearing, and origin/access checks.
- Production-build Web end-to-end acceptance: 13 tests passed, covering chunked SSE before completion,
  truncated-stream retry, receipt recovery after reload, older-history pagination,
  session changes during receipt recovery, delayed receipts after a newer submission,
  composer locking while a restored key's receipt is unavailable,
  proactive defaults and settings, refresh-safe unsaved settings, exact custom cooldown retention,
  compiled Chinese controls, and non-overlapping character/chat layout.
  Layout was exercised across all six built-in themes, a 1440 by 1000 desktop viewport, a 390 by 844 narrow
  viewport, and reduced motion. These are configured mock-provider browser checks.
- Actual Electron 45.3.1 on macOS arm64: a separate sandboxed window loaded packaged Web
  build files, displayed history, sent a real-model reply, moved and resized, closed
  without closing the main window, reopened, and was cleaned up when its owner closed.
  The Companion renderer had no page errors and did not receive the main-window bridge.
- An isolated daemon used the existing loopback provider with `gpt-5.6-sol` for real
  multi-turn streaming, context recall, native-window dialogue, a daemon-owned proactive
  tick, quiet-hour refusal, cooldown refusal, and idempotent replay. The original
  workspace's credentials/model settings were not modified. Its configured `gpt-5.5`
  model was unavailable at the proxy, so the available model was selected only in the
  isolated acceptance workspace. After 41.7 minutes of continuous daemon operation, a
  fresh request still recalled the initial test code correctly and completed in 2,817 ms.
- Full macOS `package:mac` uses an
  [independent native prerequisite review](../../native/office-local/reviewed-packaged-source-v1-review.md#companion-and-native-runtime-review-2026-11-17)
  of the exact Apple-signed local compiler/SDK 27.2 profile and actual Electron
  45.3.1 / Node 24.22.2 runtime, retaining all native source, OS and signing bounds.
  Standard packaging produced an App, ZIP and DMG. Local checks matched the complete
  archive payloads to the App, verified distribution materials, decoded the character
  asset, checked native binary architecture and deep strict ad-hoc signatures, and
  started the pinned embedded runtime. The package-owned browser passed first download,
  interaction, offline cache reuse and restart with an unavailable proxy.
- The complete macOS App started its own packaged daemon in an isolated workspace and
  profile. Its Companion completed a real-model reply, wide/narrow layout, moving and
  resizing, operation with the main window hidden, independent close/reopen, and owner
  cleanup, with no renderer page errors. Existing native-messaging registrations were
  restored after the check. Archive/runtime receipts bind their exact source snapshot
  separately from the earlier sustained-model session.
- These are local development artifacts with ad-hoc signatures. Developer ID,
  notarization, clean-machine installation and Windows GUI acceptance remain unverified;
  archive and CI results do not establish those acceptance scopes.

Additional characters, speech, articulated Live2D animation, and work-event-driven
proactive behavior remain separate enhancements.
