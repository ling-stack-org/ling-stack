# Ling Companion

Status: foundation, dialogue, memory bridge, proactive scheduler, surface contracts, adapter-selection acceptance, and Web renderer delivered
Owner: repository maintainers
Last verified: 2026-11-11
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

The first Ling web renderer uses the verified Codex-compatible v2 pet atlas for 澜星/Yui
(`apps/web/public/companions/lanxing-spritesheet.png`). The atlas stays transparent and
is rendered as CSS sprite frames: companion phases map to `idle`, `running`, `waiting`,
`waving`, `jumping`, or `failed`, while manifest actions map `greet` to `waving`, `think`
to `running`, and `celebrate` to `jumping`. The role-first surface is an independent
fixed overlay and does not resize or restyle the Ling application surface. It has no
enclosing card: the name, state, messages, actions, settings link, and composer are
translucent controls that appear around the character on hover or focus. Text input and
model execution remain separate from the visual asset.

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
and streaming transports. A persisted pending reply returns `companion_message_in_progress`
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
6. **Renderer acceptance (delivered for Web MVP):** render the transparent v2 pet atlas,
   map semantic phases/actions to sprite rows, consume new action events and state/message
   changes through the companion event surface, present the character on a frameless
   role-first surface with translucent controls, and expose the surface from the sidebar
   and Settings. Desktop-native packaging and reconnect coverage remain follow-up work.
   Provider connectivity remains covered by Ling's existing model configuration and
   provider acceptance flows.

The daemon tests use deterministic configured-provider fixtures. They verify that the
Companion does not add model settings and that the bound preset reaches the same direct
execution path. External provider connectivity remains an environment-level concern of
Ling's existing model configuration and provider acceptance flows.

Completion means a Companion can be created for any active teammate, converse through the
same configured model path, preserve private history and memory boundaries, emit validated
semantic events, pause/resume proactive behavior, and switch between any Ling provider
without changing Companion data.
