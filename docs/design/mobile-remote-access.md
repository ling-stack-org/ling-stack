# Ling Mobile Remote Access

Status: proposed; architecture locked for isolated implementation, not approved for `main`
Date: 2026-07-31

Related documents:

- [Mobile Remote Access Detailed Design](mobile-remote-access-detailed-design.md)
- [Mobile Remote Access Implementation Plan](mobile-remote-access-implementation-plan.md)
- [Mobile Conversation UI 2.0 Detailed Design](mobile-conversation-ui2-detailed-design.md)
- [Contracts and API Client](contracts-api-client.md)
- [Platform Architecture](platform-architecture.md)
- [Ling Framework](ling-framework.md)
- [Channel Message Streaming](channel-message-streaming.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation UI Package Extraction Implementation Plan](conversation-ui-package-extraction-implementation-plan.md)
- [Channel Workspace Design](channel-workspace.md)

## Decision

Ling should add a first-party iOS and Android client under `apps/mobile`, while the PC
remains the authority for workspaces, channels, runs, approvals, and artifacts.

The mobile app must not connect to the existing daemon HTTP server directly. A dedicated
Remote Gateway runs locally on the PC as a second, opt-in listener with a small remote
allowlist. The default V0 connection uses Tailscale networking and HTTPS/WSS. It does not
require a Ling-hosted cloud service.

V0 enforces a one-device trust relationship for each PC Gateway:

- one PC has at most one active mobile device;
- the first-party app keeps one active PC pairing in its local product state, but this is
  a UX constraint rather than a cross-PC cryptographic guarantee;
- pairing is initiated locally on the PC, expires, and can be used only once;
- the mobile device proves possession of its private key on every connection;
- revocation closes active sessions and prevents reconnecting;
- replayed authentication frames and commands are rejected.

UI 2.0 has landed, and the isolated Mobile branch has been synchronized with that baseline.
The native conversation design is now locked for a narrow V1 that synchronizes channels,
normal conversations, and teammate-direct conversations. Shared visual values are mapped
through app-local native tokens; Web DOM/CSS components remain outside Mobile.

## Why This Shape

The user goal is remote conversation continuity, not a second independent Ling runtime.
Keeping execution on the PC preserves the existing workspace, tools, credentials,
approvals, and session history. The phone becomes another trusted surface over the same
daemon-owned state.

A cloud-hosted Ling relay is not required for the first version. Tailscale normally forms
an encrypted peer-to-peer path and may fall back to an encrypted DERP relay when direct
NAT traversal fails. The relay cannot decrypt the tailnet payload. A self-hosted control
plane can be evaluated later with Headscale or NetBird.

## Current Repository Baseline

The live `origin/main` baseline already has:

- `apps/web`: the browser client and current conversation implementation;
- `apps/desktop`: an Electron alpha shell that packages the Web UI and local daemon;
- `packages/daemon`: the authoritative local service and runtime owner;
- `packages/contracts`: shared daemon wire types;
- `packages/api-client`: the broad local daemon client;
- `packages/conversation-ui-core`: DOM-free conversation policies and view-model types;
- `packages/conversation-ui-react`: DOM/CSS-oriented React presentation primitives.

The workspace glob already includes `apps/*` and `packages/*`, so `apps/mobile` and new
shared packages can live in the current monorepo without changing workspace discovery.

The existing daemon defaults to `127.0.0.1:17891` and its general routes are not remotely
authenticated. That loopback service must stay private. Remote access is a new security
boundary, not a host-binding change to the current daemon server.

## Goals

- Pair one mobile app installation with one local Ling PC.
- Show secure QR pairing only while unpaired; launch a paired app directly into
  synchronized conversations.
- Place PC-side enable, QR generation, local confirmation, paired-device status, and revoke
  under `Settings -> Device -> Mobile Access`, never inside a conversation.
- List locally authorized channels, normal conversations, and teammate-direct
  conversations without exposing arbitrary workspace paths.
- Open any authorized conversation, load a sanitized transcript snapshot, and receive
  ordered updates.
- Send a plain-text message or follow-up into the existing conversation owner.
- Keep Mobile-originated text at a conversation-comment/conversational-reply ceiling; it
  must not auto-start workflows, execution proposals, or tool-backed runs in V1.
- Keep execution/run/approval surfaces out of the Mobile V1 UI.
- Reuse the PC user-profile identity and appearance vocabulary through a minimal `My`
  page; Mobile appearance remains device-local.
- Survive backgrounding, network changes, and reconnects without duplicating commands.
- Let the PC revoke the phone immediately.
- Reuse semantic contracts and headless conversation logic from the monorepo.
- Keep UI 2.0 integration behind a narrow mobile adapter.

## Non-Goals for V0

- No Ling-hosted account, cloud database, or mandatory Ling relay.
- No direct exposure of `17891`, `/rpc/stream`, or the broad daemon API.
- No arbitrary `cwd`, file path, shell, provider, MCP, broad settings, or secret endpoints.
- No remote permission-preset escalation.
- No remote approval, run-status, or execution-control surface in V1.
- No file upload/download, raw artifact content, terminal attachment, or Computer Use
  control.
- No browser/PWA remote client; the device-key boundary is first-party mobile only.
- No multi-PC or multi-phone account model.
- No attempt to share Web DOM components with React Native.
- No PC theme creation/import, arbitrary theme-package transfer, Token/activity analytics,
  or remote mutation of the PC theme from Mobile.

## Architecture

```text
 iOS / Android
 apps/mobile
      |
      | HTTPS/WSS + device challenge signature
      | inside an encrypted tailnet path
      v
 Tailscale / Headscale-compatible network
      |
      | tailscale serve -> 127.0.0.1:17892
      v
 Remote Gateway listener (opt-in, remote allowlist only)
 packages/daemon/src/features/remote-access
      |
      | typed RemoteAccessService facade
      | no reuse of the general daemon router
      v
 Ling daemon authority
 channels / transcripts / control-plane events / runs / approvals
      |
      v
 Local workspace, runners, tools, credentials, and artifacts
```

The first implementation keeps the Gateway in the daemon process but on a distinct
listener. This avoids a second service lifecycle while preventing a Tailscale proxy
mistake from exposing the general daemon router. The Gateway receives a restricted
`RemoteAccessService`, not the complete `DaemonContext`.

If remote access later includes file transfer, Computer Use, or multiple users, the
Gateway should be reconsidered as a separate least-privilege process with an authenticated
local daemon capability. That added isolation is not needed for the communication-only V0.

## Ownership Boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Ling daemon | Workspaces, channels, messages, runs, approvals, artifacts, event order | Mobile presentation state |
| Remote Gateway | Pairing, device registry, authentication, remote session, allowlist, projection, replay defense | Independent channel/run state or general daemon routing |
| `packages/contracts` | Stable remote wire types and semantic DTOs | Crypto implementation, React, storage |
| `packages/remote-protocol` | Runtime frame validation, canonical signing input, version negotiation | Network sockets, daemon calls, UI |
| `packages/remote-client` | Mobile-safe connect/auth/sync/reconnect/command state machine | React Native screens or daemon business rules |
| `apps/mobile` | Native navigation, secure-key adapter, notifications, conversation rendering | Web imports, daemon authority, raw workspace paths |
| `apps/web` / UI 2.0 | Web interaction and visual system | Mobile connection/auth implementation |

## Connectivity Modes

| Mode | V0 support | Server requirement | Notes |
| --- | --- | --- | --- |
| Tailscale Serve inside one tailnet | Required path | No Ling server | Gateway remains loopback-only; HTTPS/WSS is exposed only to the tailnet. |
| Headscale with compatible tailnet clients | Evaluation path | Self-hosted control plane | Keeps coordination under user control; compatibility must be tested. |
| NetBird | Later adapter | Managed or self-hosted control plane | Requires a separate TLS/listener recipe; not part of the first acceptance path. |
| Same-LAN direct TLS | Development only | None | Requires certificate pinning and safe interface binding; not the default Internet solution. |
| Public port forwarding | Unsupported | None | Too easy to expose the Gateway or daemon incorrectly. |
| Ling cloud relay | Deferred | Ling infrastructure | Only justified for zero-setup onboarding or offline message delivery later. |

The PC can connect directly to the phone when the network permits it. “No Ling server”
does not mean “no network coordination at all”: an overlay network still uses a control
plane for peer discovery and may use an encrypted relay for difficult networks.

## Mobile App and Reuse

`apps/mobile` uses React Native with an Expo development build and a native secure-key
module. The current baseline is Expo 57, React Native 0.86, and React 19; UI 2.0 Web
packages remain on their existing ReactDOM boundary.

Safe reuse:

- `@ling-stack/contracts` for conversation/transcript/remote DTOs;
- `@ling-stack/remote-protocol` for validated frames and signing input;
- `@ling-stack/remote-client` for connection and synchronization state;
- `@ling-stack/conversation-ui-core` for pure policy and view-model helpers.

Do not reuse directly:

- `@ling-stack/conversation-ui-react`, because it renders DOM elements, accepts
  `HTMLElement` refs, and relies on Web class/CSS contracts;
- `apps/web` components, stores, routes, projectors, CSS, or browser APIs;
- `@ling-stack/api-client` as the mobile transport, because it exposes the broad local
  daemon API and has no Remote Gateway device-auth contract.

The mobile conversation surface owns a narrow adapter:

```text
RemoteConversationSnapshot / RemoteConversationEvent
                  |
                  v
MobileConversationAdapter
                  |
                  v
conversation-ui-core view models
                  |
                  v
React Native message / work-cell / composer components
```

Only the adapter should need meaningful changes when UI 2.0 changes semantic transcript
or view-model shapes.

## V0 Capability Surface

| Capability | V1 | Later |
| --- | --- | --- |
| Pair/revoke one phone | Yes | Multiple devices and PC switching |
| Secure QR pairing and PC confirmation | Yes | Separately threat-modeled manual/account discovery |
| Channel, normal conversation, and teammate-direct list/open | Yes | Search, creation, rename, archive, administration |
| Snapshot and live transcript | Yes | Raw detail and full artifact exploration |
| Send message/follow-up | Yes | Attachments and rich composer commands |
| Conversational AI reply | Yes, tools/workflow auto-start disabled | Explicitly reviewed remote task capability |
| Observe run status | No | Separate execution inspector after V1 |
| Cancel active run | No | Separate opt-in control design after V1 security review |
| See pending approvals | No | Read-only summary or approve/deny after separate review |
| Notifications | Connection plumbing only | Message/mention actions after separate design |
| User profile | Read/update display name and bounded avatar | Activity/Token/skill analytics |
| Mobile appearance | Follow system, Ling Light, Ling Dark | Sanitized mobile-compatible PC theme packs |
| Offline queue | No | Explicitly designed bounded queue |
| Computer Use | No | Separate high-risk design |

The Gateway rejects capabilities outside this table even if the local daemon already has
an endpoint for them.

## Product Flow

### Pair

1. The PC owner enables Remote Access locally.
2. The PC opens a short pairing window and displays a QR code plus a local confirmation.
3. The phone scans the QR, creates a device key in platform secure storage, and submits a
   signed pairing request over the tailnet.
4. The PC displays the phone name and a short verification phrase.
5. The owner confirms locally; the Gateway records the phone public key as the only active
   device and closes the pairing window.
6. The phone verifies the Gateway identity fingerprint from the QR and enters sync.

### Connect and Converse

1. The app reconnects to the saved Gateway origin.
2. The Gateway sends a fresh challenge; the phone signs it with the paired device key.
3. The Gateway sends a workspace/channel summary; the phone supplies an acknowledged
   event cursor only when the current process still has its matching snapshot baseline,
   otherwise it requests a fresh snapshot.
4. Opening a channel returns a bounded snapshot followed by ordered delta events.
5. Sending uses a unique `commandId`; retries return the prior result instead of creating
   another channel message.

### Revoke

1. The owner revokes the phone locally or disables Remote Access.
2. The Gateway increments the authorization epoch, deletes the device public key, closes
   all sessions, and clears replay/idempotency state.
3. The phone moves to `revoked`, clears cached content and connection credentials, and
   requires a new local pairing ceremony.

## UI 2.0 Coordination

The two workstreams can proceed in parallel under these ownership rules:

| Workstream | Primary ownership | Shared review required |
| --- | --- | --- |
| UI 2.0 | `apps/web`, `packages/conversation-ui-react`, Web CSS/tokens | Semantic changes in contracts/core |
| Mobile remote access | `apps/mobile`, `packages/remote-*`, daemon remote-access | Semantic changes in contracts/core |
| Existing shared contract | Existing conversation DTOs and cross-surface semantics in `packages/contracts` | Both owners approve |
| Remote-only contract extension | `packages/contracts/src/remote-access.ts` plus its root export | Mobile owner may implement; UI 2.0 owner reviews the overlap at final sync |
| Headless conversation model | `packages/conversation-ui-core` | Both owners approve |
| Lockfile | One owner regenerates after final sync | Never manually merge competing lockfile edits |

Rules for the synchronized Mobile branch:

- limit `apps/web` changes to the new UI 2.0 `Mobile Access` settings surface and shell
  registration; do not modify or copy Web conversation components;
- do not move or rename `conversation-ui-react` components;
- keep native visual tokens inside `apps/mobile`;
- use fixtures and a mobile adapter rather than the current Web projector;
- keep remote protocol types in a dedicated file to reduce contract merge conflicts;
- record any desired core change as a small, separately reviewable commit.

Final integration gate after the UI 2.0 design sync:

1. synchronize this branch with the latest `main`;
2. review every `contracts` and `conversation-ui-core` overlap with the UI 2.0 owner;
3. update `MobileConversationAdapter` and semantic mobile tokens;
4. regenerate the workspace lockfile once from the integrated tree;
5. run shared package, daemon, mobile, Web, and Desktop compatibility checks;
6. review the final diff before opening or merging the implementation PR.

## Failure and Recovery Principles

- A network drop never cancels the PC run.
- A reconnect never resends a non-idempotent command without the original `commandId`.
- A missing event range produces a fresh snapshot instead of guessed local state.
- Authentication or protocol-version failure is fail-closed and never falls back to the
  general daemon API.
- A second device cannot replace the active phone without local revocation/confirmation.
- Mobile backgrounding closes or suspends the remote session; foregrounding performs a
  new challenge-response.
- The Gateway never accepts a client-provided filesystem path.
- Mobile-originated text cannot inherit the local Web/Desktop workflow auto-start behavior;
  the server-owned Mobile policy is a lower authority ceiling.
- The mobile app distinguishes `offline`, `reconnecting`, `revoked`, and `PC unavailable`
  instead of showing stale state as live.

## Distribution and Operations

V0 distribution must include the whole path, not only source code:

- Desktop/CLI can enable, disable, pair, inspect, and revoke the local Gateway.
- Desktop packaging includes the Gateway because it is part of the daemon bundle.
- iOS builds go through an internal TestFlight track first.
- Android builds go through an internal testing track or signed internal APK/AAB.
- Release notes state that the phone and PC must join the same supported tailnet.
- Diagnostics expose safe connection state, protocol version, and paired device id, but
  never private keys, pairing secrets, transcript content, or raw IP credentials.

CI design must keep mobile jobs separate from normal Web/daemon checks so unavailable
Apple runners or account billing limits do not block unrelated repository validation.

## Alternatives Rejected for V0

### Expose the Existing Daemon on `0.0.0.0`

Rejected. The daemon has a broad local API and local WebSocket RPC without the device
authentication required for Internet-facing access.

### Reuse the Web App as a Mobile Web Page

Rejected as the primary path. It weakens device-key storage, background behavior,
notifications, and one-device enforcement, and it couples the mobile release to UI 2.0.

### Build a Ling Cloud Account and Relay First

Rejected for V0. It adds identity, hosting, retention, abuse, compliance, and operations
before proving the local remote-channel use case.

### Copy Web Conversation Components into Mobile

Rejected. ReactDOM/CSS components are not React Native components, and copying them would
create two diverging product models during UI 2.0.

## NOT in Scope

- Multi-device account and organization management.
- Cloud history synchronization or offline delivery.
- Public Internet port forwarding documentation.
- Remote file browser, shell, terminal, secrets, provider settings, or Computer Use.
- A shared cross-platform visual component library before a second native consumer exists.
- A complete Desktop settings design in this first branch slice.

## Acceptance Criteria

- Remote Gateway is opt-in, loopback-only behind the supported overlay-network recipe,
  and cannot route arbitrary daemon requests.
- The existing daemon listener remains `127.0.0.1` by default.
- Pairing is local, expiring, reserved to one candidate, consumed once, and locally
  confirmed; rejection rotates the QR secret.
- Exactly one paired device can authenticate; a second device fails closed.
- Revocation terminates the active connection and blocks reconnect.
- Duplicate challenges, frames, and commands are rejected or idempotently replayed.
- The phone can list/open authorized channels, normal conversations, and teammate-direct
  conversations, follow live transcript state, and send a message through existing daemon
  authority without gaining run-control or tool-backed workflow execution.
- An unpaired/revoked app displays the secure pairing flow; a paired app launches directly
  into conversations and exposes profile/appearance through the top-right avatar.
- PC settings can generate a fresh expiring QR, confirm/reject one candidate, and inspect
  or revoke the paired phone without exposing pairing controls in conversation UI.
- Mobile profile updates are limited to display name and a bounded validated avatar;
  appearance changes are local to the phone and never mutate PC theme state.
- Network interruption and resume do not duplicate a message or lose authoritative state.
- `apps/mobile` imports no code from `apps/web` or `conversation-ui-react`.
- Shared Web and Desktop builds remain green after the final UI 2.0 synchronization.
- No implementation is merged to `main` until the final cross-workstream review is
  explicitly approved.

## Unresolved Decisions

No product or UI decision blocks the two-page Mobile V1 implementation. Before live
integration, the channel-specific remote protocol must be expanded and reviewed for the
three conversation kinds described in the Mobile Conversation UI 2.0 design. Android
hardware-backed key evidence remains a release gate, not a UI-design blocker.
