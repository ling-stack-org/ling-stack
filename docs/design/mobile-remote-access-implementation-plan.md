# Mobile Remote Access Implementation Plan

Status: Mobile V1 execution plan locked; Slice 1 security spike complete; generic
conversation protocol, live Gateway, native UI, and cross-device acceptance pending
Date: 2026-07-31
Base: current `origin/main` architecture at design start

Related documents:

- [Ling Mobile Remote Access](mobile-remote-access.md)
- [Mobile Remote Access Detailed Design](mobile-remote-access-detailed-design.md)
- [Mobile Conversation UI 2.0 Detailed Design](mobile-conversation-ui2-detailed-design.md)
- [Platform Architecture](platform-architecture.md)
- [Ling Framework](ling-framework.md)
- [Channel Message Streaming](channel-message-streaming.md)

## Outcome

Deliver an opt-in local Remote Gateway and first-party iOS/Android client that let one
paired phone read and send text in approved Ling channels, normal conversations, and
teammate-direct conversations over an encrypted tailnet path.
The PC daemon remains authoritative. The implementation must not expose the existing
daemon router, accept remote filesystem paths, or merge to `main` before the Mobile shared
boundary and security review is complete.

## Locked Decisions

- Mobile is a React Native app under `apps/mobile`, using an Expo development build unless
  the native secure-key spike proves Expo cannot meet the release security requirements.
- V1 networking uses Tailscale Serve to a loopback-only Gateway listener.
- Remote Gateway runs in the daemon process on a separate listener and receives a narrow
  service facade; it never mounts the general daemon router.
- V1 permits synchronized list/open/read and plain-text send for channels, normal
  conversations, and teammate-direct conversations.
- Mobile text is tagged `sourceSurface=mobile` and capped at `conversation_comment`: a
  tool-disabled conversational reply is allowed, but workflow/proposal auto-start is not.
- V1 excludes approval and run surfaces, attachments, files, terminal, broad settings,
  providers, tools, secrets, and Computer Use.
- V1 includes a minimal `My` page for synced user identity, device-local appearance,
  paired-PC status, and confirmed unpair; it does not expose the PC settings center.
- One PC has one active phone and one authenticated session.
- Production authentication uses a hardware/OS-keystore P-256 device key and fresh
  challenge-response; there is no long-lived bearer token.
- Message retry safety is backed by a durable daemon receipt transaction, not Gateway
  memory.
- Mobile imports no `apps/web` or `conversation-ui-react` code.
- Final visual convergence follows
  [Mobile Conversation UI 2.0 Detailed Design](mobile-conversation-ui2-detailed-design.md).

## Mobile V1 Development Cut

The first implementation is an internal iPhone-first development build, not a public
App Store/Play release. It must prove the complete conversation loop against one real PC:

```text
PC: enable Gateway -> show QR -> confirm phone
                                |
                                v
Phone: pair -> sync index -> open transcript -> send text -> receive live reply
          |          |               |                 |
          v          v               v                 v
       My/profile  unread cursor   reconnect/resync  same-command retry
```

Android stays in the shared codebase and must compile and pass emulator tests during V1.
The lack of a physical Android device does not block the iOS internal build, but it blocks
claiming that the Android release-security gate is complete.

### V1 Definition of Done

- An unpaired phone scans the PC QR, verifies the pinned Gateway identity, waits for the
  PC owner to accept, and stores a non-exportable device key.
- A paired launch enters one activity-sorted conversation index covering `channel`,
  `conversation`, and `teammate_direct`.
- The phone reads bounded history, receives ordered live changes, reconnects after PC
  sleep/network change, and performs a full resync after a stale or missing event range.
- Plain-text send works for all three conversation kinds under a server-owned
  `conversation_comment` authority ceiling. Mobile cannot select a path, provider, model,
  teammate route, tool, permission, attachment, approval, or workflow action.
- Retry reuses the same durable `commandId`; a network failure after commit cannot create
  a second visible message or a second AI work unit.
- When the target already owns an active reply/run, V1 returns `conversation_busy` and
  keeps the draft/retry action visible. It does not queue, interrupt, or start parallel
  hidden work.
- Unread state is not a phone-only approximation. The daemon owns one read cursor per
  local user and conversation; PC and Mobile update it through narrow application
  services and converge through the normal projection stream.
- `My` supports profile read, display-name update, bounded avatar update, device-local
  Light/Dark/System appearance, paired-PC status, and confirmed unpair.
- PC `Settings -> Device -> Mobile Access` can enable/disable, generate/rotate the QR,
  confirm/reject, inspect reachability, and revoke the single paired phone.
- Native screens match the Mobile UI 2.0 design at 320 pt and 390 pt widths, support
  200% text scaling, and import no DOM/Web component or CSS.

### Explicit V1 Boundary

The following are deferred even when matching PC components already exist:

- create a normal conversation, create a channel, or add a teammate;
- search, attachments, files, terminal, approvals, run control, Computer Use, settings
  center, theme packages, language/response settings, and notification content previews;
- multiple phones, multiple PCs, cloud relay, public port forwarding, and offline sends.

The first follow-up is V1.1 `conversation.create` for a normal Ling conversation only.
Channel creation follows later with a separate mobile form and permission review. Adding
teammates remains PC-only until there is evidence that remote administration is needed.

## Executable Milestones

These milestones replace a layer-only implementation order with three user-visible
checkpoints. The detailed Slice sections later in this document remain the engineering
checklists for each module.

| Milestone | User-visible result | Detailed slices | Exit gate |
| --- | --- | --- | --- |
| M0: baseline | Existing key spike still works on the UI 2.0 baseline | S1 | Expo Doctor 20/20, RN 0.86.2, existing suites green |
| M1: fixture app | Pairing, list, detail, My, Light/Dark render from shared fixtures | S1, S5, S6, S8 | All three kinds and every empty/error state render natively |
| M2: secure read path | A real iPhone pairs and reads live PC conversations | S2-S5, S7 | Identity pin, auth, list/open/read, unread cursor, revoke, resync pass |
| M3: complete V1 | The phone sends text, receives replies, edits profile, and survives reconnect | S2-S9 | Durable retry, authority ceiling, profile limits, real-device E2E pass |

### Phase P0: Baseline and Dependency Readiness

Modules:

- `apps/mobile`
- workspace lockfile only after dependency selection is final

Work:

1. Upgrade React Native from `0.86.0` to Expo 57's required `0.86.2` and regenerate the
   lockfile once.
2. Preserve the secure-device-key spike as a developer diagnostics screen or test harness;
   do not leave it as the production app root.
3. Record current contract/protocol/core/Mobile test counts as the regression baseline.
4. Add only the native dependencies required by the locked screens: navigation, QR/camera,
   safe local preferences/drafts, and virtualized list support. Do not add a Web renderer.

Verification:

```bash
corepack pnpm --filter @ling-stack/mobile run doctor
corepack pnpm --filter @ling-stack/mobile typecheck
corepack pnpm --filter @ling-stack/mobile test
git diff --check
```

Done when Expo Doctor reports 20/20 and the secure-key fixture still passes on the real
iPhone. Estimated engineering effort: 0.5-1 day.

### Phase P1: Generic Conversation and Profile Wire Contract

Modules:

- `packages/contracts`
- `packages/remote-protocol`
- Mobile/Node/native fixture corpus
- the V0/channel-specific portions of the detailed design

Work:

1. Replace the unshipped `channel.list/open/send_text` surface with
   `conversation.list/open/send_text/mark_read`; do not carry branch-local compatibility
   aliases into protocol version 1.
2. Add `RemoteConversationKindV1`, summary, identity, message, snapshot, delta, read-state,
   and pagination contracts for all three kinds.
3. Add `profile.read` and `profile.update`. The update accepts only an 80-character
   `displayName` and a bounded PNG/JPEG/WebP avatar data URL with decoded-byte and pixel
   limits; `handle` is returned read-only and paths are never accepted.
4. Remove run/approval summary capabilities from the V1 Mobile allowlist because the UI
   and product scope do not consume them.
5. Rename the policy ceiling from `channel_comment` to `conversation_comment` and require
   the same ceiling for every conversation kind.
6. Keep strict unknown-field rejection, fixed protocol version/algorithm, canonical signed
   bytes, time/size limits, and shared mutation fixtures.
7. Bind the original command time and server-validated `retryUntil` into the command hash.
   Automatic retry is allowed for at most 24 hours; after that the client keeps the failed
   row and requires an explicit new send with a new command id.

Output:

```text
contracts types
      |
      +--> strict protocol validators --> Node fixtures
      |                               `--> native/Hermes fixtures
      `--> daemon projection/client reducers compile against the same DTOs
```

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/remote-protocol test
corepack pnpm --filter @ling-stack/remote-protocol typecheck
corepack pnpm --filter @ling-stack/mobile test
git diff --check
```

Done when no channel-only command or projection remains in the public V1 contract and
shared fixtures cover all three kinds plus profile/read-state boundaries. Estimated
engineering effort: 1.5-2.5 days.

### Phase P2: Daemon Conversation Facade and Durable State

Modules:

- `packages/core` SQLite stores/migrations
- `packages/daemon/src/features/remote-access`
- existing normal/channel/teammate-direct application services

Work:

1. Create one narrow `RemoteConversationFacade` with three internal source adapters. It
   may read existing stores, but it does not expose `RunStore` or the general daemon router.
2. Normalize the three existing message models only at the remote projection boundary;
   do not rewrite local conversation storage.
3. Add installation-global device/policy state and workspace-local durable command receipt,
   dispatch intent, and audit storage.
4. Add a daemon-owned conversation read cursor and narrow `markRead` service. The cursor
   is a monotonic conversation activity sequence, not only a message id: a later edit or
   revision can remain unread, and channel mention state is derived from activities after
   the cursor. Update the PC channel unread selector to consume this state instead of its
   current in-memory `seenAt` ref; extend normal/direct surfaces only where they display
   unread state.
5. Implement one transaction for command receipt + user message + dispatch intent, with
   deterministic reply/work-unit ids and startup reconciliation.
6. Add a durable remote-projection outbox/change log in the same transaction as every
   remote-visible message, revision, profile, and read-state mutation. A projection worker
   assigns stream sequence and publishes only committed rows; startup drains unprocessed
   rows. Do not rely on route handlers remembering to emit an in-memory event.
7. Reject send with `conversation_busy` while that conversation has an active bounded
   reply/run. V1 has no queued follow-up, interrupt, or parallel-send semantics.
8. Route every kind through a server-owned `RemoteConversationAuthorityContext`. If any
   existing reply path cannot guarantee `allowToolCalls=false`,
   `allowWorkflowAutoStart=false`, and `allowExecutionProposal=false`, that kind remains
   read-only until the enforcement exists.
9. Extract the existing profile validation into a reusable local application service, then
   wrap it with the stricter Mobile allowlist. Do not call the cwd-based HTTP route.
10. Retain full command receipts/results beyond the 24-hour retry window and keep a compact
    `(commandId, bodyHash, terminalResult)` tombstone for at least 7 days. A command past
    `retryUntil` is rejected even if its full receipt has been compacted.

The send transaction is the load-bearing data flow:

```text
signed conversation.send_text
  -> auth/policy/read lease
  -> resolve opaque conversation id
  -> reject if conversation is busy or retry window expired
  -> BEGIN workspace transaction
       receipt(commandId, bodyHash)
       + local user message
       + dispatch intent(authority=conversation_comment)
       + projection outbox row
     COMMIT
  -> publish projection delta
  -> claim/reconcile deterministic reply work
  -> command.completed (or replay the same result)
```

Verification:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/core typecheck
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/daemon typecheck
git diff --check
```

Done when crash/retry/race tests prove at-most-one visible send, no committed message loses
its dispatch intent or projection event, PC/Mobile read cursors converge, and no Mobile
text can raise its authority. Estimated engineering effort: 4-5 days.

### Phase P3: Remote Gateway and PC Mobile Access Surface

Modules:

- daemon `remote-access` listener/auth/session/projection
- local-only daemon management routes
- `apps/web/src/features/settings/mobile-access`
- settings shell registration and tests

Work:

1. Start a loopback-only listener on a separate port behind explicit Tailscale Serve
   configuration. Reject wildcard/plaintext external binding.
2. Implement pairing reservation, QR rotation/expiry, PC confirmation, challenge-response,
   Gateway pin verification, replay protection, one-device compare-and-swap, session
   replacement, revoke, and disable.
3. Drain the durable projection outbox into sanitized conversation/profile events, then
   apply subscribe-before-read buffering, bounded snapshots/pages, monotonic sequence,
   acknowledgement, backpressure, and forced resync on overflow or generation change.
4. Add local management endpoints for the Settings UI. These endpoints can operate the
   Gateway but are never mounted on the remote listener. Mutations require a short-lived
   management capability plus strict allowlisted Origin and CSRF validation; reject a
   missing Origin and never inherit wildcard CORS from the generic JSON helper. A future
   Desktop-only IPC bridge may replace the HTTP capability without changing Gateway code.
5. Add the `Mobile Access` item next to `Computer Control` in the existing Device settings
   group and implement disabled, unpaired, pairing, confirmation, paired, unreachable,
   revoked, and error states.

Verification:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Done when no business bytes leave before auth, no path/cwd input is accepted, the general
router is unreachable from the Gateway, and disable/revoke closes the active socket.
Estimated engineering effort: 3-4 days.

### Phase P4: Platform-Neutral Remote Client

Modules:

- new `packages/remote-client`
- injected Mobile transport, signer, secure metadata, reachability, and clock adapters

Work:

1. Implement pairing, pin verification, auth, command correlation, snapshot/delta reducer,
   read cursor, and profile state without React Native imports.
2. Implement explicit offline/connecting/authenticating/syncing/online/reconnecting/
   revoked/incompatible states.
3. Retry only an already-created mutation with the same `commandId`; never create an
   offline send queue.
4. A gap, stale cursor, daemon restart, or overflow discards the invalid baseline and
   requests a fresh bounded snapshot.
5. Revoke/unpair clears secure metadata, in-memory transcript, drafts, and persisted
   non-secret indexes in a defined order.
6. Namespace every cache/draft/cursor by server-issued `workspaceBindingId`. A rebind or
   binding mismatch clears all old workspace content before reauthentication/snapshot,
   while preserving the hardware device key only when the device itself remains paired.

Verification:

```bash
corepack pnpm --filter @ling-stack/remote-client test
corepack pnpm --filter @ling-stack/remote-client typecheck
git diff --check
```

Done when a fake transport and deterministic clock cover every state transition and every
network drop point. Estimated engineering effort: 1.5-2.5 days.

### Phase P5: Native Mobile Shell and UI 2.0 Screens

Modules:

- `apps/mobile/src/features/pairing`
- `apps/mobile/src/features/conversations`
- `apps/mobile/src/features/profile`
- `apps/mobile/src/theme`
- `apps/mobile/src/platform`

Work order:

1. typed native Light/Dark/System theme and app/navigation shell;
2. pairing welcome, scanner, PC-confirmation wait, expiry/reject, accepted, and sync states;
3. unified conversation index, kind filters, unread badges, partial/offline states;
4. shared detail page, virtualized/paged transcript, streaming row, per-conversation draft,
   and plain-text composer with pending/sent/failed/same-command retry;
5. `My`: synced profile, local appearance, paired-PC state, confirmed unpair;
6. accessibility, keyboard, safe-area, Dynamic Type, VoiceOver/TalkBack, and reduced-motion
   behavior.

Screens consume typed feature state and dispatch intents. They do not parse wire frames,
own reconnection, access secure keys directly, or call daemon routes.

Verification:

```bash
corepack pnpm --filter @ling-stack/mobile typecheck
corepack pnpm --filter @ling-stack/mobile test
corepack pnpm --filter @ling-stack/conversation-ui-core test
rg -n "apps/web|@ling-stack/conversation-ui-react|react-dom|document\.|HTMLElement" \
  apps/mobile packages/remote-client packages/remote-protocol
git diff --check
```

The import guard must have no production-source matches. Done when the fixture app covers
three conversation kinds and every loading/empty/partial/offline/reconnecting/send-failed/
revoked state at 320 pt, 390 pt, and 200% text scale. Estimated engineering effort: 3-4
days.

### Phase P6: Live Integration, Security, and Internal Distribution

Modules:

- real daemon + Gateway + Tailscale Serve
- real iPhone development build
- Android emulator build
- CI/package workflows isolated from unrelated jobs

Acceptance path:

```text
pair -> initial list -> open all three kinds -> mark read -> send each kind
 -> receive reply/delta -> drop network after commit -> retry same command
 -> PC sleep/wake -> daemon restart/resync -> revoke -> local data cleared
```

Required evidence:

- real iPhone Secure Enclave and changed-Gateway rejection;
- Tailscale direct and relay path, Wi-Fi/cellular switch, background/foreground;
- second-device rejection, QR expiry/rotation, auth replay, unsafe binding failure;
- large transcript pagination, bounded slow-client queue, and memory/scroll stability;
- Mobile conversational-reply eval proving useful text replies while tools, proposals, and
  workflows stay blocked;
- Android compile/emulator UI evidence, with the physical Android keystore check recorded
  as the remaining cross-platform release gate;
- signed internal iOS artifact and a rollback drill using local disable/revoke.

Final verification:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/desktop build
corepack pnpm --filter @ling-stack/mobile run doctor
git diff --check
```

Done when the iOS internal build passes the complete E2E matrix and disabling Remote
Access restores the pre-feature local PC behavior without daemon data loss. Estimated
engineering effort: 2.5-4 days plus signing/account wait time.

### Effort and Recommended Execution Order

For one engineer working sequentially, the implementation is approximately 17-24 focused
engineering days, excluding App Store/Play review and unavailable Android hardware. This
is an estimate for planning, not a calendar promise.

Recommended order in the current branch:

```text
P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6
            |           |
            |           `-- P5 fixture UI may start after P1
            `-- P4 fake-transport client may start after P1
```

For the first pass, keep one integration owner and one lockfile owner. If parallel
worktrees are used, only P2/P3 (daemon lane) and P4/P5 (client/UI lane) should run in
parallel after P1; neither lane may independently edit contracts, shared fixtures, or the
lockfile.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1 day / Codex-assisted: ~0.5 day)** — Mobile baseline — align
  Expo dependencies and preserve the secure-key evidence harness outside the production
  app root.
  - Surfaced by: P0 baseline and Expo Doctor's React Native mismatch.
  - Files: `apps/mobile/`, `pnpm-lock.yaml`.
  - Verify: Mobile doctor, typecheck, tests, iPhone key fixture.
- [ ] **T2 (P1, human: ~2.5 days / Codex-assisted: ~1.5 days)** — Wire contract — replace
  channel-only DTOs with generic conversation/read/profile contracts and strict shared
  fixtures.
  - Surfaced by: implemented protocol does not represent normal or teammate-direct chat.
  - Files: `packages/contracts/`, `packages/remote-protocol/`, protocol design sections.
  - Verify: contract/protocol/typecheck/native fixture suites.
- [ ] **T3 (P1, human: ~5 days / Codex-assisted: ~3 days)** — Daemon state — implement
  the narrow three-kind facade, durable send receipt/dispatch, read cursor, profile
  allowlist, projection outbox, retry tombstone, busy policy, recovery, and authority
  ceiling.
  - Surfaced by: PC stores are authoritative but currently expose three different message
    paths and in-memory channel unread state.
  - Files: `packages/core/`, `packages/daemon/src/features/remote-access/`, bounded local
    conversation/profile services.
  - Verify: store crash/race tests, daemon integration tests, authority eval.
- [ ] **T4 (P1, human: ~3.5 days / Codex-assisted: ~2 days)** — Gateway and PC surface —
  add loopback listener, pairing/auth/session/projection, Tailscale checks, local management
  capability/Origin/CSRF guards, and Device settings UI.
  - Surfaced by: no live Gateway or PC pairing surface exists yet.
  - Files: daemon remote access, `apps/web/src/features/settings/mobile-access/`, settings
    shell, CLI.
  - Verify: listener isolation, auth/replay/revoke/redaction tests, Web build.
- [ ] **T5 (P1, human: ~2.5 days / Codex-assisted: ~1.5 days)** — Remote client — build
  the UI-independent auth/sync/reconnect/command state machine with injected platform
  adapters and workspace-binding-scoped cache clearing.
  - Surfaced by: screens must not own signed protocol or reconnect behavior.
  - Files: `packages/remote-client/`.
  - Verify: deterministic fake-transport transition suite.
- [ ] **T6 (P1, human: ~4 days / Codex-assisted: ~2.5 days)** — Native UI — ship pairing,
  unified index/detail, drafts/send states, My/profile/unpair, UI 2.0 tokens, and
  accessibility.
  - Surfaced by: `apps/mobile/App.tsx` is currently only the secure-key spike.
  - Files: `apps/mobile/src/features/`, `apps/mobile/src/theme/`, app navigation/platform
    adapters.
  - Verify: fixture/component tests, 320/390 pt visual evidence, 200% text scale, import
    guard.
- [ ] **T7 (P1, human: ~4 days / Codex-assisted: ~2.5 days)** — Live acceptance — connect
  the real iPhone to the real PC and close security, retry, reconnect, performance,
  rollback, and internal signing evidence.
  - Surfaced by: simulator/unit evidence cannot prove Tailscale or hardware-key behavior.
  - Files: cross-module integration tests, Mobile E2E evidence, isolated CI/package jobs.
  - Verify: the complete P6 acceptance path and final repository-wide gates.

## What Already Exists

| Existing capability | Reuse decision |
| --- | --- |
| Daemon-owned conversations, messages, runs, approvals, and SQLite state | Keep as sole authority. |
| Conversation message creation and AI routing | Extract shared daemon application services; do not copy route handlers. |
| Shared conversation/transcript DTOs in `packages/contracts` | Reuse, then add isolated remote-access DTOs. |
| Local user-profile route and store validation | Extract the validation/service, then wrap it with a stricter Mobile field allowlist; never reuse its `cwd` HTTP shape. |
| PC channel unread calculation in `AppShell` | Replace the in-memory `seenAt` ref with a daemon read cursor so Mobile and PC converge; do not create a second phone-only unread model. |
| Control-plane sequence/replay/redaction concepts | Reuse ordering concepts only; V1 UI does not project run/approval surfaces. |
| `packages/conversation-ui-core` pure policies/view models | Reuse behind `MobileConversationAdapter`. |
| `packages/api-client` transport conventions and error model | Reuse patterns or small extracted primitives only; do not expose the broad client from Mobile. |
| Desktop daemon lifecycle and Settings `Device` group | Reuse for Gateway lifecycle and add `Mobile Access` beside `Computer Control`; keep CLI as a diagnostic/automation path. |
| Web/`conversation-ui-react` visual components | Do not reuse in React Native. |

## Target Modules

```text
apps/mobile/
  modules/ling-secure-device-key/
    ios/
    android/
    src/
  app/ or src/navigation/
  src/features/pairing/
  src/features/connection/
  src/features/profile/
  src/features/conversations/
    domain/
    data/
    screens/
    components/
    state/
    MobileConversationAdapter.ts
  src/theme/
  src/platform/secure-device-key/
  src/platform/notifications/
  test/

apps/web/src/features/settings/mobile-access/
  MobileAccessSettingsPage.tsx
  MobilePairingQrPanel.tsx
  MobilePairingConfirmationPanel.tsx
  PairedMobileDevicePanel.tsx

packages/contracts/src/
  remote-access.ts

packages/remote-protocol/
  src/canonical.ts
  src/envelopes.ts
  src/errors.ts
  src/es256.ts
  src/hmac.ts
  src/sequence.ts
  src/sha256.ts
  src/validators.ts                 # stable public re-export surface
  src/validation/
    command-payloads.ts
    event-payloads.ts
    frames.ts
    handshake.ts
    json-input.ts
    json-members.ts
    policy.ts
    primitives.ts
    projections.ts
    time.ts
  src/index.ts
  test/

packages/remote-client/
  src/client.ts
  src/auth.ts
  src/connection-state.ts
  src/reconnect.ts
  src/stream-reducer.ts
  src/transport.ts
  src/index.ts
  test/

packages/core/src/storage/sqlite/
  remote-command-store.ts
  remote-command-mappers.ts
  conversation-read-state-store.ts
  remote-projection-outbox-store.ts

packages/daemon/src/features/remote-access/
  server.ts
  service.ts
  pairing.ts
  installation-state.ts
  authorization-coordinator.ts
  device-auth.ts
  session-registry.ts
  projection.ts
  projection-outbox-worker.ts
  conversation-facade.ts
  profile-service.ts
  command-executor.ts
  schemas.ts
  audit.ts

packages/cli/src/remote/
  enable.ts
  status.ts
  pair.ts
  revoke.ts
  disable.ts
```

During Slice 1, `apps/mobile` contains only the Expo development-build key harness and the
app-local `ling-secure-device-key` module. Navigation, production screens, and conversation
state remain Slice 6 work; the spike does not import Web UI code.

The exact split may be adjusted to match nearby repository conventions, but these
responsibilities must stay separate:

- protocol parsing/canonicalization is pure and shared;
- `packages/remote-protocol` imports the DTO types from `packages/contracts`; it must not
  redeclare a second wire model. Validators return the contract types and shared fixtures
  compile against both sides;
- secure key access is a mobile platform adapter;
- reconnect/sync state is UI-independent;
- Gateway routing/auth is not mixed into conversation business logic;
- message idempotency is durable store behavior;
- native rendering remains app-local until there are two native consumers.

## Dependency Graph

```text
S0 docs/source-of-truth
        |
        v
S1 contracts + protocol + native-key spike
        |                         |
        v                         v
S2 durable store/app service   S5 remote client
        |                         |
        v                         v
S3 Gateway auth/session        S6 mobile shell + mock data
        |                         |
        +------------+------------+
                     v
              S7 live integration
                     |
                     v
              S8 UI 2.0 convergence
                     |
                     v
              S9 distribution/acceptance
```

## Delivery Boundaries

This plan is larger than one safe review unit. The branch can remain the isolated staging
line requested for the feature, but implementation should be kept in independently
reviewable commits and, if UI 2.0 does not land promptly, split into these PR boundaries:

1. protocol, durable idempotency/dispatch, Gateway security, and CLI management;
2. remote client, native-key adapter, and Mobile shell/live communication;
3. UI 2.0 convergence, distribution, and final release acceptance.

No PR may merge to `main` without the user's final confirmation. Splitting review units
does not authorize early mainline merge; it only prevents one long-lived, cross-platform
diff from becoming unreviewable.

## Slice 0: Design and Source-of-Truth Alignment

Scope:

- add the three Mobile Remote Access design documents;
- update platform/framework/streaming docs so Mobile is shown behind the Gateway rather
  than as a broad daemon client;
- record V1 capability exclusions and the UI 2.0 merge checkpoint.

Validation:

```bash
git diff --check
rg -n "mobile|Mobile|Remote Gateway" docs/design/platform-architecture.md \
  docs/design/ling-framework.md docs/design/channel-message-streaming.md \
  docs/design/mobile-remote-access*.md
```

Done when the docs contain no blocking architecture decision and agree on authority,
networking, security, and message-resume behavior.

## Slice 1: Contracts, Protocol, and Secure-Key Spike

Scope:

- add remote pairing, identity, policy, capability, envelope, snapshot, delta, command,
  result, and error DTOs to `packages/contracts/src/remote-access.ts`;
- add `packages/remote-protocol` with strict runtime validators and canonical signing
  bytes;
- lock the V1 encoding profile to RFC 8785 JCS, SHA-256/HMAC-SHA-256, unpadded base64url,
  NUL-separated domain bytes, and fixed 64-byte IEEE-P1363 ES256 wire signatures;
- fix the first shipped protocol to version 1 and ES256; no downgrade/algorithm
  negotiation;
- replace the implemented branch-local channel command/projection DTOs with the reviewed
  generic conversation, read-state, and profile DTOs before live integration;
- build a minimal iOS/Android native-key spike that generates, signs, and verifies a
  P-256 key without exporting the release private key;
- verify that Gateway application-key pinning and Tailscale Serve TLS work on both mobile
  platforms;
- add import guards proving protocol code has no Node-only or React dependency unless a
  platform adapter explicitly supplies it.

Security gate:

- If an Expo development build cannot provide non-exportable platform signing and Gateway
  identity verification, stop Mobile release work and move `apps/mobile` to a React Native
  native project. Do not substitute a persistent bearer token or JS-exportable production
  key.

Tests:

- canonical bytes match shared fixtures across Node/iOS/Android;
- all five pairing/auth signing domains and the pairing HMAC match in the Mobile/Hermes
  fixture, with Node-generated Gateway/device signatures verified by native crypto;
- validators reject extra fields, unknown types, wrong version, invalid time, and
  oversized values;
- frame fixtures keep stream id/event id/server sequence and client sequence/expiry in one
  direction-specific location; duplicate envelope/payload fields are rejected;
- every signed field mutation fails verification;
- deterministic property/fuzz cases cover canonical object ordering and strict frame
  boundary mutations;
- private-key export is unavailable in the real-device release adapter.

Validation:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/remote-protocol test
corepack pnpm --filter @ling-stack/remote-protocol typecheck
corepack pnpm --filter @ling-stack/mobile typecheck
corepack pnpm --filter @ling-stack/mobile test
corepack pnpm --filter @ling-stack/mobile run doctor
git diff --check
```

The current development machine may close the TypeScript, Node interoperability, Expo
configuration, autolinking, and standalone Swift Security checks. S1 is not release-closed
until a physical iPhone proves Secure Enclave generation/signing/private-key export failure,
a physical Android device proves Android Keystore signing with `privateKey.encoded == null`
and records its security level, and both devices reject a changed Gateway identity. Hosted
simulators may prove compile/autolink and fail-closed behavior but are not hardware evidence.

The iOS half of this gate is recorded in the
[Mobile real-device evidence](../../apps/mobile/README.md#recorded-slice-1-device-evidence).
Android physical-device and real Tailscale Serve transport evidence remain pending, so S1
is not yet release-closed.

Checkpoint: this slice is safe to implement while UI 2.0 is active. Any change to an
existing shared conversation type requires joint review; remote-only DTOs do not.

## Slice 2: Durable Device, Policy, and Command Stores

Scope:

- add installation-global state for Gateway identity metadata, active device, device epoch,
  canonical workspace binding, remote policy, and pairing/auth audit;
- add workspace SQLite schema/migration for command receipts, dispatch intents, leases,
  deterministic reply/work-unit refs, projection outbox rows, conversation activity/read
  cursors, and entity-linked audit;
- enforce one active device per Gateway at the database layer;
- add an in-process authorization read/exclusive barrier: commands hold an epoch/binding/
  policy lease through the workspace commit, while revoke/replace/disable/rebind excludes
  new work and invalidates sessions;
- expose a narrow store facet instead of the whole `RunStore` surface;
- add a narrow remote conversation facade over the existing normal, channel, and
  teammate-direct stores/services without exposing the general daemon router;
- add one daemon-owned read cursor per local user/conversation and make PC/Mobile unread
  projection converge through that cursor;
- record every remote-visible message/revision/profile/read mutation in a durable outbox
  in the same local transaction, then publish committed rows with stable activity/event
  sequence;
- add an atomic `executeRemoteSendText` transaction that writes the command receipt,
  kind-specific local-user message, and durable dispatch intent together;
- reconcile the dispatch intent after commit and on daemon startup, using the source
  message id as the idempotency boundary before entering bounded conversational routing;
- implement dispatch leases, unique `(sourceMessageId, authorityCeiling, policyVersion)`
  keys, deterministic pending-reply/work-unit ids, compare-and-set terminal publication,
  and recovery that reuses those ids;
- reject Mobile send as `conversation_busy` instead of queueing, interrupting, or starting
  parallel hidden work;
- enforce a signed 24-hour maximum retry window and retain compact command tombstones for
  at least 7 days after full receipt compaction;
- add bounded receipt/outbox retention maintenance only after those replay windows.

Failure cases to cover:

- process crash before receipt insert;
- crash after receipt insert but before message insert;
- crash after message insert but before command response;
- crash after message/receipt commit but before AI routing starts;
- crash after a local mutation commits but before its projection event publishes;
- same command id with same body;
- same command id with different body;
- same command id after the retry deadline or full-receipt compaction;
- concurrent duplicate commands;
- send while a local/Mobile reply is already active;
- message edit or mention after the shared read cursor;
- replace/revoke racing an in-flight command.
- Mobile-originated text uses the lower `conversation_comment` ceiling and cannot auto-start a
  workflow, execution proposal, or tool-backed run.
- canonical workspace realpath/storage-identity mismatch, symlink swap, and missing
  database fail closed and require local rebind.
- switching workspace does not create a second installation device record, and a revoke
  racing a workspace commit has one documented linearization outcome.

Validation:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/core typecheck
git diff --check
```

Checkpoint: do not proceed to a real network listener until all crash/idempotency tests
prove one command creates at most one user message and a committed message cannot lose its
durable dispatch intent.

## Slice 3: Gateway Listener, Pairing, and Authentication

Scope:

- add `remoteAccess` daemon config with `enabled=false`, loopback host, separate port, and
  explicit supported network mode;
- create the independent HTTP/WebSocket listener; allow loopback HTTP/WS only as the
  backend of explicitly configured Tailscale Serve, and refuse wildcard or externally
  reachable plaintext configuration;
- expose only minimal unauthenticated health and pairing/session WebSocket paths;
- implement Gateway identity creation, pairing-window lifecycle, HMAC/device proof, local
  confirmation, single-candidate reservation/QR rotation, active-device compare-and-swap,
  challenge-response, device epoch, single-session replacement, and revocation;
- enforce protocol subprotocol, pre-auth timeout, frame size, rate limits, disabled
  compression, strict schemas, and generic remote auth errors;
- add safe security audit events and redacted diagnostics;
- add CLI `enable/status/pair/revoke/disable` commands;
- add the UI 2.0 PC companion surface under `Settings -> Device -> Mobile Access` for
  enable, QR generation, candidate confirmation/rejection, paired status, and revoke;
- add a Tailscale Serve setup/status check without automatically changing the user's
  tailnet configuration.

Hard guards:

- the Gateway module must not import or call the general daemon `routeRequest` function;
- startup tests assert daemon and Gateway ports/listeners differ;
- sensitive local management mutations require a short-lived management capability,
  allowlisted Origin, and CSRF proof; missing Origin and wildcard CORS fail closed;
- no endpoint accepts a path or `cwd`;
- no business data is serialized before successful auth;
- disabling Remote Access closes the listener and active session immediately.

Validation:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/cli test
git diff --check
```

## Slice 4: Remote Conversation Projection, Snapshot, and Delta Stream

Scope:

- define a sanitized remote conversation index spanning channel, normal-conversation, and
  teammate-direct summaries;
- project a bounded conversation transcript snapshot from daemon-owned state;
- project the shared read cursor and accept only `conversation.mark_read` updates through
  the authorized conversation facade;
- drain the durable projection outbox as the single reliable source of live deltas across
  all three existing message write paths;
- implement a subscribe-before-read barrier: register/buffer a new stream generation,
  capture its sequence watermark, build a consistent snapshot, then flush buffered events
  above the watermark before live delivery;
- add monotonic stream sequence, bounded replay, acknowledgement, queue limits, and
  `resync_required` behavior;
- omit raw details, paths, stdout/stderr, tool payloads, and artifact bytes;
- add subscription cleanup on socket close/session replacement/revoke;
- prove a daemon restart or stale cursor converges via snapshot.
- prove a conversation mutation committed between listener registration and snapshot completion
  is present after sync (snapshot, buffered delta, or idempotently both) and never lost;
- prove a mutation committed before process crash publishes from the outbox after restart;
- force resync when stream generation changes after restart or buffer overflow.

Performance budgets to measure:

- auth plus initial summary should not require loading every workspace record;
- snapshots are bounded by item count and serialized byte size;
- slow clients cannot grow an unbounded event queue;
- a large conversation is chunked or truncated with an explicit older-page cursor;
- background mobile connections use heartbeat/idle values compatible with battery limits;
- Mobile renders bounded/virtualized transcript pages and never materializes unbounded raw
  event history.

Validation:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/contracts test
git diff --check
```

## Slice 5: Remote Client State Machine

Scope:

- implement a platform-neutral `RemoteLingClient` over injected WebSocket, clock, signer,
  and secure-metadata adapters;
- implement pairing, Gateway identity verification, challenge signing, auth, stream
  subscription, acknowledgement, and request/result correlation;
- implement explicit `offline`, `connecting`, `authenticating`, `syncing`, `online`,
  `reconnecting`, `revoked`, and `incompatible` states;
- implement exponential backoff with jitter and reachability hints;
- preserve `commandId` across retry but never queue new offline mutations;
- apply snapshot/delta ordering and request a resync on gap;
- keep resume cursors only while the corresponding in-memory snapshot is materialized;
  every cold app start sends no cursor and requires a fresh snapshot;
- namespace local indexes, drafts, and cursors by `workspaceBindingId`; binding change
  clears the old namespace before new content is shown;
- clear sensitive state on revoke/unpair.

Tests use a fake transport and deterministic clock. They cover every transition, network
drop point, duplicate/reordered event, session replacement, revoke, version failure, and
cold start with no transcript baseline.

Validation:

```bash
corepack pnpm --filter @ling-stack/remote-client test
corepack pnpm --filter @ling-stack/remote-client typecheck
git diff --check
```

Checkpoint: this slice can run in parallel with Gateway work after protocol fixtures are
locked. Both sides consume the same fixture corpus from `remote-protocol`.

## Slice 6: Mobile Conversation Shell and Mock Data

Scope:

- create `apps/mobile` with isolated React Native/Expo dependencies and native development
  builds;
- keep the existing pair/revoke security flow separate from the conversation shell;
- implement unpaired welcome, QR scanner, PC-confirmation wait, rejection,
  expiry, accepted, and initial-sync screens;
- implement the two-page navigation stack: unified conversation index and shared
  conversation detail;
- cover channel, normal-conversation, and teammate-direct fixtures in the same native
  list/detail components;
- implement connection state as an inline status strip rather than a third primary page;
- add a top-right user-avatar entry to one minimal `My` page containing personal identity,
  Mobile appearance, paired-PC status, and confirmed unpair;
- implement the production secure-device-key adapter from Slice 1;
- use `RemoteLingClient` through app state hooks; screens never own protocol logic;
- create `MobileConversationAdapter` from remote semantic DTOs to
  `conversation-ui-core` view models;
- build native message/composer components locally with UI 2.0 semantic tokens;
- use fixture snapshots/deltas until Slice 7 connects to a real Gateway;
- keep notification previews content-free by default.

Import guards:

```bash
rg -n "apps/web|@ling-stack/conversation-ui-react|react-dom|document\.|HTMLElement" \
  apps/mobile packages/remote-client packages/remote-protocol
```

The command must return no source matches except an explicit negative-test fixture.

UI 2.0 boundary:

- follow `mobile-conversation-ui2-detailed-design.md` for hierarchy, states, tokens,
  accessibility, and component boundaries;
- do not extract `conversation-ui-native` in this slice;
- do not copy the current Web projector or CSS;
- keep the adapter and semantic token mapping app-local until a second native consumer
  exists;
- do not add work cells, approvals, run control, attachments, files, terminal, broad PC
  settings, or Computer Use to the V1 conversation shell.
- do not copy PC Token/activity analytics, language/response settings, theme studio,
  theme import/create, or arbitrary theme packages into Mobile;
- profile updates are dedicated allowlisted commands; Mobile theme selection is local and
  cannot change the PC theme.

## Slice 7: Live End-to-End Integration

Scope:

- pair a real phone with a real PC through Tailscale Serve;
- list locally allowed channels, normal conversations, and teammate-direct conversations;
- open snapshot and consume live deltas from PC-originated and mobile-originated messages;
- send plain text with durable command receipts;
- open/mark-read on PC and Mobile and prove the unread cursor converges;
- attempt send while a reply/run is active and prove the server returns
  `conversation_busy` without queueing or interrupting;
- retry before/after the signed deadline and after full-receipt compaction, proving the
  tombstone prevents a duplicate and expired commands cannot restart work;
- test Wi-Fi/cellular changes, background/foreground, PC sleep/wake, daemon restart,
  Tailscale direct/relay paths, revoke online/offline, and second-device rejection;
- add safe diagnostics for user-visible connection errors.
- run a conversational-reply eval/fixture suite proving normal questions still receive a
  useful reply while tool calls, hidden proposals, and workflow auto-start remain blocked;
  compare against the local Web/Desktop baseline for the same prompt set.

Required regression:

```text
Mobile sends command C
  -> daemon persists message M
  -> daemon persists dispatch intent D in the same transaction
  -> network drops before command.completed
  -> Mobile reconnects and retries C
  -> Gateway returns M
  -> D is reconciled after a crash/restart if needed
  -> exactly one M and one durable bounded-reply/work-unit record exist
  -> any provider retry is local/audited, not a second visible remote turn
```

This is a release-blocking E2E/integration test, not a manual-only scenario.

## Slice 8: UI 2.0 Convergence Checkpoint

Start condition met on 2026-07-31: UI 2.0 is on `main`, and this isolated branch was
rebased onto that baseline. The remaining work is implementation and joint review, not
visual-direction discovery.

Steps:

1. fetch and synchronize with the latest `main` in this isolated worktree;
2. review changed exports/types in `packages/contracts` and
   `packages/conversation-ui-core` with both owners;
3. update `MobileConversationAdapter` only where semantic models changed;
4. implement the typed native token map defined by the Mobile Conversation UI 2.0 design
   without importing Web CSS;
5. align the conversation index, message rows, status strip, and plain-text composer;
6. regenerate `pnpm-lock.yaml` once from the integrated package graph; never hand-merge
   two generated lockfile versions;
7. run Mobile plus Web/Desktop regression builds;
8. inspect the final overlap diff before any PR is opened or merged.

If UI 2.0 is still moving and this feature branch has materially drifted, stop and ask
whether to split the already-stable protocol/Gateway work into its own PR and keep native
visual convergence in a fresh branch. Do not silently create or merge that split.

## Slice 9: Distribution, Rollout, and Rollback

Scope:

- include Gateway code/config in daemon and Desktop package builds;
- add user-facing CLI/Desktop diagnostics for enabled, reachable, paired, online, and
  revoked states;
- build signed iOS internal/TestFlight and Android internal/AAB artifacts;
- document Tailscale prerequisite and setup verification;
- keep mobile CI jobs isolated from normal Web/daemon jobs so mobile signing/runners or
  account billing limits cannot block unrelated checks;
- conduct focused security review and real-device acceptance;
- ship behind `remoteAccess.enabled=false` and local opt-in.

Rollback:

- local disable closes Gateway immediately without stopping the daemon;
- revocation invalidates the phone before code rollback;
- removing the mobile app does not change daemon/channel state;
- database additions remain backward-tolerant and contain no required migration of
  existing channel messages;
- the general daemon listener and Web/Desktop local flows continue unchanged.

## Test Coverage Diagram

```text
PAIRING
  |-- valid reserved/accepted QR ------------ [UNIT + INTEGRATION]
  |-- expired/wrong/consumed secret -------- [UNIT + INTEGRATION]
  |-- concurrent phones/local reject/rotate - [INTEGRATION]
  `-- Gateway identity mismatch ------------ [UNIT + REAL DEVICE]

AUTHENTICATION
  |-- valid hardware-key proof ------------- [UNIT + REAL DEVICE]
  |-- wrong key/epoch/version/origin -------- [UNIT + INTEGRATION]
  |-- challenge/nonce replay ---------------- [UNIT + INTEGRATION]
  `-- session replacement/revoke ----------- [INTEGRATION + E2E]

LOCAL MANAGEMENT
  |-- valid capability + Origin + CSRF ------ [WEB + INTEGRATION]
  |-- missing/foreign Origin rejected ------- [INTEGRATION]
  |-- wildcard CORS not inherited ---------- [STATIC + INTEGRATION]
  `-- stale/replayed management token ------- [INTEGRATION]

COMMAND
  |-- allowed conversation.send_text -------- [INTEGRATION + E2E]
  |-- allowed conversation.mark_read -------- [STORE + WEB/MOBILE E2E]
  |-- unknown capability/cwd/path injection - [INTEGRATION]
  |-- duplicate same payload --------------- [STORE + E2E]
  |-- duplicate changed payload ------------ [STORE + INTEGRATION]
  |-- busy conversation rejected ----------- [POLICY + E2E]
  |-- retry deadline/tombstone ------------- [STORE + E2E]
  `-- crash before response ---------------- [STORE + E2E]

PROFILE
  |-- profile.read safe projection ---------- [UNIT + INTEGRATION]
  |-- display-name/avatar update ------------ [UNIT + E2E]
  |-- handle/path/oversized image rejected -- [UNIT + INTEGRATION]
  `-- update converges on PC and Mobile ----- [WEB/MOBILE E2E]

READ STATE
  |-- Mobile open advances daemon cursor ---- [STORE + E2E]
  |-- PC open advances same cursor ---------- [WEB + E2E]
  |-- stale cursor cannot move backward ----- [STORE + INTEGRATION]
  `-- concurrent new message/read ---------- [STORE + INTEGRATION]

STREAM
  |-- snapshot then ordered delta ----------- [INTEGRATION + E2E]
  |-- committed outbox row after crash ------ [STORE + INTEGRATION]
  |-- write during snapshot/subscribe barrier  [INTEGRATION]
  |-- duplicate/reorder/gap/stale cursor ---- [UNIT + INTEGRATION]
  |-- slow consumer/queue overflow ---------- [INTEGRATION + PERF]
  `-- daemon restart/PC sleep/network switch  [E2E + REAL DEVICE]

MOBILE
  |-- state-machine/error surfaces ---------- [UNIT + NATIVE UI]
  |-- background/foreground ---------------- [REAL DEVICE]
  |-- secure storage/revoke clearing -------- [REAL DEVICE]
  `-- no Web/DOM dependency ---------------- [STATIC GUARD]

CONVERSATIONAL REPLY
  `-- Mobile ceiling, no tools/workflow auto-start [→EVAL + INTEGRATION]
```

## Failure-Mode Matrix

| Failure | Test | Handling | User-visible result |
| --- | --- | --- | --- |
| Pairing expires | Unit/integration | Consume/clear state | Pairing expired; retry locally |
| Wrong or replayed device proof | Unit/integration | Fail before data, rate limit | Cannot authenticate |
| Network drops after message commit | Store/E2E | Durable receipt returns same message | Reconnects; no duplicate |
| Full receipt was compacted before a late retry | Store/E2E | Signed retry deadline plus compact tombstone | Existing result or explicit expiry; never duplicate |
| Send arrives while a reply/run is active | Policy/E2E | Reject `conversation_busy`; no queue/interrupt | Draft remains and can retry later |
| PC and Mobile mark read concurrently | Store/integration | Monotonic cursor compare-and-set | Badge converges; never moves backward |
| New message/edit/mention arrives while mark-read commits | Store/integration | Stable activity-sequence cursor and later delta | Only later activity remains unread; mention badge preserved |
| Process crashes after local commit before event publish | Store/integration | Startup drains durable projection outbox | Brief resync/delay, then event appears |
| Event cursor is too old | Integration | `resync_required` plus snapshot | Brief syncing state |
| PC sleeps or daemon restarts | E2E | Backoff, reauth, resync | PC unavailable/reconnecting |
| Second device connects | Integration | Reject pairing or replace same paired session only | Existing pairing remains active |
| Owner revokes | Integration/E2E | Epoch bump, close socket, clear mobile state | Pairing required |
| Slow mobile consumer | Perf/integration | Bounded queue, force resync | Brief syncing state |
| Invalid workspace/conversation | Integration | Allowlist rejection without path disclosure | Access unavailable |
| Gateway is reached directly on loopback | Integration | Proxy headers ignored; device auth still required | Authentication required |
| Browser calls local management route without capability/Origin/CSRF | Integration | Fail before mutation; no wildcard CORS | Operation rejected on PC |
| Mobile process is killed with an old cursor | Native/E2E | Clear cursor and force snapshot | Brief syncing state |
| PC rebinds to another workspace | Client/E2E | Binding mismatch clears old cache/drafts before auth | New workspace sync; no stale content |
| Mobile text tries to trigger a workflow/tool | Policy/integration | `conversation_comment` ceiling blocks it | Conversational reply or explicit blocked state |
| Profile update contains a handle/path/oversized avatar | Unit/integration | Strict allowlist and byte/MIME/dimension validation | Clear validation failure; old profile remains |
| Remote projection sees raw sensitive field | Redaction regression | Drop field/fail safe serialization | Safe incomplete detail, never raw payload |

No listed V1 failure may be silent while leaving the UI labeled `online`.

## Parallel Worktree Strategy

After Slice 1 locks shared fixtures, independent lanes are possible:

| Lane | Modules | Depends on |
| --- | --- | --- |
| A: persistence/Gateway | `packages/core`, `packages/daemon`, `packages/cli` | Slice 1 |
| B: remote client/mobile | `packages/remote-client`, `apps/mobile` | Slice 1 |
| C: source docs/ops | `docs/design`, packaging/setup docs | Slice 1 decisions |
| D: integration | daemon + remote client + mobile | Lanes A and B |
| E: UI convergence | contracts/core adapter + mobile visuals | UI 2.0 and Lane D |

Lanes A, B, and C can proceed in parallel only if each has its own sibling worktree and
no one independently edits shared contracts or the lockfile. `packages/contracts`,
`packages/conversation-ui-core`, and `pnpm-lock.yaml` have a single designated owner per
integration window. Lane D starts after A+B merge into this feature line; Lane E starts
after UI 2.0 is stable.

## Test File Map

Implementation should place the critical tests in the repository's existing style rather
than hiding them in one end-to-end script:

| Area | Required test artifact | Main assertions |
| --- | --- | --- |
| Protocol | `packages/remote-protocol/test/protocol.test.mjs` | Canonical bytes, strict frames, replay/expiry/version failures, stream field ownership |
| Store/idempotency | `packages/core/test/remote-command-store.test.mjs` | Receipt/message/dispatch atomicity, unique route intent, lease/CAS recovery |
| Projection outbox | `packages/core/test/remote-projection-outbox.test.mjs` | Same-transaction mutation/outbox, crash drain, duplicate publish, retention |
| Read cursor | `packages/core/test/conversation-read-state.test.mjs` | Monotonic activity cursor, edits/mentions, concurrent message/read ordering, unread convergence |
| Installation state | `packages/daemon/test/remote-installation-state.test.mjs` | One device across workspaces, authorization barrier, epoch/rebind/revoke races, workspace identity |
| Gateway | `packages/daemon/test/remote-access.test.mjs` | Listener isolation, pairing race/rotation, auth, allowlist, redaction, limits, revoke |
| Local management | `packages/daemon/test/remote-access-management.test.mjs` | Capability, strict Origin/CSRF, missing Origin, CORS, replay, disable/revoke |
| Profile | `packages/daemon/test/remote-profile.test.mjs` | Read projection, display name/avatar allowlist, handle/path/size/MIME rejection, convergence |
| Client | `packages/remote-client/test/client.test.mjs` | State machine, reconnect, cold-start snapshot, sequence gap, retry deadline, busy, binding change |
| Mobile unit | `apps/mobile/test/remote-connection-state.test.ts` | Secure-key adapter boundary, UI error states, adapter projection |
| Real-device E2E | `apps/mobile/e2e/remote-access.real-device.md` plus the selected iOS/Android harness | Tailscale Serve, Wi-Fi/cellular, background/foreground, PC restart, revoke |

The real-device artifact is a release checklist, not a substitute for the unit and
integration tests. If the Mobile framework uses a different test runner, preserve these
logical file boundaries and assertions.

## Verification Commands

Narrow checks first:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/remote-protocol test
corepack pnpm --filter @ling-stack/remote-client test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/mobile typecheck
git diff --check
```

Final shared compatibility after UI 2.0 sync:

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
corepack pnpm typecheck
corepack pnpm test
git diff --check
```

Real-device/security acceptance cannot be replaced by those commands.

## Final Merge and Release Gates

The implementation is eligible for a reviewed PR and user-approved merge behind
`remoteAccess.enabled=false` when:

- UI 2.0 has landed and the Mobile branch remains synchronized with its reviewed shared
  boundary;
- this branch is synchronized with the latest `main`;
- no remote code path mounts, proxies, or exposes the general daemon router;
- daemon stays loopback-only and Gateway startup fails on unsafe binding;
- hardware/OS-keystore device proof passes on the real iPhone and the Android native
  module compiles, autolinks, and fails closed in emulator tests;
- unique device/session, pairing expiry, replay, revoke, route allowlist, path injection,
  redaction, durable idempotency, and snapshot/delta recovery tests pass;
- installation-global device/epoch state and workspace-local command transactions pass
  cross-workspace and revoke/rebind race tests;
- `apps/mobile` has no Web/DOM imports;
- shared contract/core overlaps have joint review;
- the lockfile was regenerated once from the integrated tree;
- Web, Desktop, daemon, shared packages, Mobile, and real-device smoke checks pass;
- the final diff and security boundary receive explicit review;
- the user explicitly approves merging to `main`.

Public cross-platform release has an additional gate: a physical Android device must prove
non-exportable Keystore signing, record the hardware security level, reject a changed
Gateway identity, and pass the pairing/reconnect/revoke smoke suite. Until then the code
may merge disabled and the iOS internal build may be used, but Ling must not advertise the
Android client as release-ready.

## NOT in Scope

- Remote approval decisions or run cancellation.
- File/attachment/artifact transfer.
- Terminal, shell, Computer Use, provider/tool/permission/settings control.
- PC theme creation/import, remote PC-theme mutation, or user activity/Token analytics.
- Multiple phones, multiple PCs, Ling accounts, cloud relay, or offline mutation queue.
- A shared native component package before a second native consumer exists.
- Public port-forwarding support.

## Decision Verdict and Remaining Gates

There are no unresolved product or architecture decisions for Mobile V1. The first build
is iPhone-first, keeps Android source/build coverage, uses a generic conversation protocol,
implements daemon-owned cross-device read cursors, and excludes all creation/admin flows.

Implementation is still gated by work, not a choice: replace the implemented channel-only
protocol, enforce the generic authority ceiling in all three send paths, prove real
Tailscale transport, and complete the iOS E2E matrix. Physical Android hardware evidence
remains the public Android release gate. A failed native-key gate is not permission to
weaken authentication.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | ---: | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | — | V1 scope was locked directly with the user |
| Codex Review | `/codex review` | Independent second opinion | 1 | ISSUES FOUND | Claude fallback found 6 gaps; 6/6 folded into the plan |
| Eng Review | `/plan-eng-review` | Architecture and tests (required) | 1 | CLEAR | 10 issues resolved, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | Mobile UI/UX gaps | 3 | CLEAR | Latest score 9/10, 6 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not required before P0 |

**CROSS-MODEL:** The outside voice added six correctness requirements: protected local
management, durable projection outbox, bounded retry/tombstone, busy-send rejection,
workspace-rebind clearing, and activity-sequence unread semantics. All six are now in the
phase plan, failure matrix, and test map.

**VERDICT:** ENG + DESIGN CLEARED — ready to implement P0 on the isolated feature branch.

NO UNRESOLVED DECISIONS
