# Mobile Remote Access Implementation Plan

Status: Slice 1 repository implementation complete; UI 2.0 baseline synchronized and
Mobile conversation UI designed; Android, protocol expansion, and Tailscale gates pending
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
- V0 networking uses Tailscale Serve to a loopback-only Gateway listener.
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

## What Already Exists

| Existing capability | Reuse decision |
| --- | --- |
| Daemon-owned conversations, messages, runs, approvals, and SQLite state | Keep as sole authority. |
| Conversation message creation and AI routing | Extract shared daemon application services; do not copy route handlers. |
| Shared conversation/transcript DTOs in `packages/contracts` | Reuse, then add isolated remote-access DTOs. |
| Control-plane sequence/replay/redaction concepts | Reuse ordering concepts only; V1 UI does not project run/approval surfaces. |
| `packages/conversation-ui-core` pure policies/view models | Reuse behind `MobileConversationAdapter`. |
| `packages/api-client` transport conventions and error model | Reuse patterns or small extracted primitives only; do not expose the broad client from Mobile. |
| Desktop daemon lifecycle | Extend later to display/operate Gateway state; keep the first management path in CLI. |
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

packages/daemon/src/features/remote-access/
  server.ts
  service.ts
  pairing.ts
  installation-state.ts
  authorization-coordinator.ts
  device-auth.ts
  session-registry.ts
  projection.ts
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
- record V0 capability exclusions and the UI 2.0 merge checkpoint.

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
- fix V0 to protocol version 1 and ES256; no downgrade/algorithm negotiation;
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
  deterministic reply/work-unit refs, and entity-linked audit;
- enforce one active device per Gateway at the database layer;
- add an in-process authorization read/exclusive barrier: commands hold an epoch/binding/
  policy lease through the workspace commit, while revoke/replace/disable/rebind excludes
  new work and invalidates sessions;
- expose a narrow store facet instead of the whole `RunStore` surface;
- extract a daemon application service for creating a local-user channel message so the
  local HTTP route and Remote Gateway share routing behavior;
- add an atomic `executeRemoteSendText` transaction that writes the command receipt,
  channel message, and durable dispatch intent together;
- reconcile the dispatch intent after commit and on daemon startup, using the source
  message id as the idempotency boundary before entering AI/channel routing;
- implement dispatch leases, unique `(sourceMessageId, authorityCeiling, policyVersion)`
  keys, deterministic pending-reply/work-unit ids, compare-and-set terminal publication,
  and recovery that reuses those ids;
- add bounded receipt retention maintenance.

Failure cases to cover:

- process crash before receipt insert;
- crash after receipt insert but before message insert;
- crash after message insert but before command response;
- crash after message/receipt commit but before AI routing starts;
- same command id with same body;
- same command id with different body;
- concurrent duplicate commands;
- replace/revoke racing an in-flight command.
- Mobile-originated text uses the lower `channel_comment` ceiling and cannot auto-start a
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

COMMAND
  |-- allowed conversation.send_text -------- [INTEGRATION + E2E]
  |-- unknown capability/cwd/path injection - [INTEGRATION]
  |-- duplicate same payload --------------- [STORE + E2E]
  |-- duplicate changed payload ------------ [STORE + INTEGRATION]
  `-- crash before response ---------------- [STORE + E2E]

STREAM
  |-- snapshot then ordered delta ----------- [INTEGRATION + E2E]
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
| Event cursor is too old | Integration | `resync_required` plus snapshot | Brief syncing state |
| PC sleeps or daemon restarts | E2E | Backoff, reauth, resync | PC unavailable/reconnecting |
| Second device connects | Integration | Reject pairing or replace same paired session only | Existing pairing remains active |
| Owner revokes | Integration/E2E | Epoch bump, close socket, clear mobile state | Pairing required |
| Slow mobile consumer | Perf/integration | Bounded queue, force resync | Brief syncing state |
| Invalid workspace/conversation | Integration | Allowlist rejection without path disclosure | Access unavailable |
| Gateway is reached directly on loopback | Integration | Proxy headers ignored; device auth still required | Authentication required |
| Mobile process is killed with an old cursor | Native/E2E | Clear cursor and force snapshot | Brief syncing state |
| Mobile text tries to trigger a workflow/tool | Policy/integration | `conversation_comment` ceiling blocks it | Conversational reply or explicit blocked state |
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
| Installation state | `packages/daemon/test/remote-installation-state.test.mjs` | One device across workspaces, authorization barrier, epoch/rebind/revoke races, workspace identity |
| Gateway | `packages/daemon/test/remote-access.test.mjs` | Listener isolation, pairing race/rotation, auth, allowlist, redaction, limits, revoke |
| Client | `packages/remote-client/test/client.test.mjs` | State machine, reconnect, cold-start snapshot, sequence gap, command retry |
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

## Final Merge Gate

The implementation is eligible for a PR only when:

- UI 2.0 has landed and the Mobile branch remains synchronized with its reviewed shared
  boundary;
- this branch is synchronized with the latest `main`;
- no remote code path mounts, proxies, or exposes the general daemon router;
- daemon stays loopback-only and Gateway startup fails on unsafe binding;
- hardware/OS-keystore device proof passes on iOS and Android release builds;
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

## NOT in Scope

- Remote approval decisions or run cancellation.
- File/attachment/artifact transfer.
- Terminal, shell, Computer Use, provider/tool/permission/settings control.
- PC theme creation/import, remote PC-theme mutation, or user activity/Token analytics.
- Multiple phones, multiple PCs, Ling accounts, cloud relay, or offline mutation queue.
- A shared native component package before a second native consumer exists.
- Public port-forwarding support.

## Unresolved Decisions

No unresolved UI decision blocks the Mobile conversation shell. Live integration is
blocked on a reviewed generic remote-conversation projection because the implemented
Slice 1 protocol is channel-specific. Android hardware-backed key evidence and Tailscale
transport evidence remain release gates. A failed native-key gate is not permission to
weaken authentication.
