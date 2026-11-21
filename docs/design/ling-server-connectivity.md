# Ling Server Connectivity and Communication Design

Status: proposed design, implementation and device acceptance pending
Owner: Ling platform maintainers
Last verified: 2026-11-20
Document type: enrollment, peer transport, relay, and synchronization contract

Related documents:
[Mobile Remote Access](mobile-remote-access.md) ·
[Mobile Remote Access Detailed Design](mobile-remote-access-detailed-design.md) ·
[Device Developer Execution and Connectivity](ling-device-developer-execution.md) ·
[Device Runtime Contract](ling-device-support-platform-runtime-contract.md) ·
[D12 implementation and evidence](ling-device-support-platform-implementation-plan.md#d12-ling-server-connectivity)

## 1. Decision

Ling Server is the first-party connectivity service for Ling Mobile and Ling PC. The
operator runs enrollment, HTTPS/WSS signaling, STUN, and TURN under one Ling Server
installation. The clients use WebRTC DataChannel for ordered, reliable peer messages.
They use a verified LAN or cross-network direct path when available and the
installation's TURN relay when direct connectivity fails. Communication requires no
third-party VPN, account, hosted STUN, or hosted relay.

The PC Remote Gateway authorizes paired phones and exposes eligible Ling messages.
The daemon owns PC conversations and tasks. The phone owns tasks it runs on its
device connection, including PC-assisted tasks. Ling Server handles connectivity
metadata. Peer keys, credentials, transcripts, task journals, and artifact content
stay with their respective endpoints.

## 2. Architecture and implementation boundaries

~~~mermaid
flowchart LR
  Mobile["Ling Mobile and local task owner"]
  PC["Ling PC Remote Gateway and daemon"]
  Device["Authorized external device"]

  subgraph Server["Ling Server installation"]
    Control["Enrollment, presence and peer signaling"]
    Store[("Peer and revocation metadata")]
    STUN["STUN address discovery"]
    TURN["TURN relay"]
    Control --> Store
    Control -->|"Relay admission and configuration"| TURN
  end

  Mobile <-->|"HTTPS/WSS control"| Control
  PC <-->|"HTTPS/WSS control"| Control
  Mobile -->|"Gather address candidates"| STUN
  PC -->|"Gather address candidates"| STUN
  Mobile <-->|"Direct WebRTC DataChannel"| PC
  Mobile <-->|"Endpoint-encrypted data"| TURN
  TURN <-->|"Endpoint-encrypted data"| PC
  Mobile -->|"Mobile-owned task"| Device
  PC -->|"PC-owned task"| Device
~~~

| Component | Responsibilities |
| --- | --- |
| Ling Server control plane | Operator setup, enrolled installation and public-key registry, signed pair projections, presence, short-lived candidate exchange, and relay admission. |
| STUN and TURN | Use a self-hosted coturn deployment for address discovery and relay, with endpoint-restricted network policy, expiring credentials, and allocation limits. |
| Endpoint transport | Use WebRTC ICE, DTLS and SCTP, with a reliable ordered DataChannel. Candidate selection and peer authentication run on the participating devices. |
| PC and Mobile integrations | Pion WebRTC in a bundled PC worker and a native libwebrtc-backed React Native module on Mobile are the library candidates. The PC worker has a private typed channel to the Gateway route adapter. iOS and Android use a native build. Verify the concrete libraries in the shipped runtimes. |
| Ling application protocol | Reuse the Gateway capability allowlist, signed protocol framing and receipts, and the Remote Client sync state machine. Use D6 and D11 for their device-task and collaboration message families. |

The peer transport adapter presents a connected, message-oriented channel to the
Gateway. The Gateway hands validated messages to its existing typed facade. The
daemon's general HTTP and RPC listeners stay local. The signaling and relay services
have no route to those listeners. A PC transport worker receives peer transport
configuration and bytes for this facade through private IPC, with process lifetime
managed by the host.

## 3. Server enrollment and peer trust

### 3.1 Server and installation identity

An operator sets up the server's administrator access locally and registers the
server's configured HTTPS origin and application key. An operator-issued, expiring
enrollment grant authorizes a PC installation to register its public key after proof
of possession. Consume the grant atomically and allow a retry by the same installation.
The PC checks the configured TLS trust and server application-key fingerprint at
bootstrap. The phone obtains the server address and fingerprint through the PC's
locally displayed QR. Server sessions use a fresh proof and expire. Network addresses
can change while the installation identity stays stable.

Use the existing P-256/ES256 profile and domain-separated canonical signing defined
for Remote Access. Server identity, PC Gateway identity, and Mobile device identity
use distinct keys. If server application keys are rotated, require a signed transition
from the pinned key or explicit local re-enrollment. Rotate TLS certificates through
the operator's normal certificate lifecycle.

### 3.2 Pairing and the authoritative record

~~~mermaid
sequenceDiagram
  actor User as User
  participant PC as PC Remote Gateway
  participant S as Ling Server
  participant M as Ling Mobile
  User->>PC: Open pairing locally
  PC->>S: Reserve expiring invitation for the enrolled PC
  PC-->>User: Show QR with PC and server identity pins
  User->>M: Scan QR
  M->>S: Open claim and send phone key proof
  S->>PC: Forward scoped claim
  PC-->>M: Return signed Gateway challenge via Ling Server
  M->>PC: Return pairing proof via Ling Server
  PC-->>User: Display candidate and verification phrase
  User->>PC: Approve the exact phone
  PC->>PC: Commit binding, device epoch and audit
  PC->>S: Publish PC-signed binding
  S-->>M: Forward signed binding after registration
  M->>M: Verify Gateway pin and persist the binding
~~~

The QR contains server origin and fingerprint, Gateway ID and key fingerprint,
pairing ID and expiry, a one-time routing invitation, and the PC-generated pairing
secret. The routing invitation authorizes claim traffic for that reservation. The
existing high-entropy pairing secret and HMAC proof authorize the Gateway pairing
transcript. Use the secret on the phone and PC only. Ling Server forwards the
challenge and proof and sees only the public claim data and proof, not the secret.
Bind both peer keys, the server identity and the invitation to the pairing transcript.
The phone verifies the Gateway signature and its QR pin before proving the secret.
Use the Gateway's single-candidate reservation and locally compared phrase.

The PC commits the active phone record and next device epoch in its existing durable
pairing transaction. Ling Server stores the PC-signed routing projection of that
binding. Publish the signed update from durable PC state and retry it idempotently.
If publication fails, show pending registration and resume with the same binding.
The phone persists a completed pairing only after checking the PC-signed acceptance
and its own key fingerprint. If a pending reservation expires, the PC can issue a
fresh one. The server enforces unique active binding per Gateway and monotonically
increasing binding revisions. A delayed accept from an earlier revision cannot undo a
revocation.

### 3.3 Revocation

Local revoke closes the PC's active Gateway session, bumps its device epoch, and
prevents further PC access before contact with Ling Server is required. The PC
publishes the signed revocation on reconnect. Ling Server stops signaling and relay
credential issuance for the binding, broadcasts the invalidation to online peers, and
closes affected relay allocations through the deployment's revocation mechanism
where supported. Active relay allocations and existing direct routes have bounded
lifetimes or authorization leases. For disconnected peers, server-originated
revocation takes effect on reconnection or lease expiry. A revoked phone cannot use
a new route to restore eligibility at the Gateway.

## 4. Signaling and endpoint authentication

The control channel authenticates the underlying installation proof and scopes every
message to the active PC-signed peer binding. A route negotiation authorizes exchange
between exactly those endpoints and records its deadline and candidate generation.
PC and Mobile sign their SDP offer or answer and candidate updates. The transcript
covers the server identity, binding and epoch, route attempt ID, both peer identities
and roles, protocol major and features, expiry, and digest of the exact SDP bytes.
WebRTC validates the DTLS certificate fingerprint authenticated in that SDP. Verify
the key, signature, epoch and negotiation scope before installing the remote
description or accepting candidates. Scope ICE restart to a new route attempt.

For a registered route, the peers read the service instance ID at
`GET /v1/signaling/instance` and submit ES256-signed messages to
`POST /v1/signaling`. The active binding supplies each role's key fingerprint.
The signature covers the instance, installation, application key, epoch, route,
roles, features, expiry and exact signaling message. Each sender has an ordered
lane. The other role polls it with a signed, single-use nonce and a cursor. The
service keeps the signed payloads in memory until expiration. Restart, revoke and
relay fallback invalidate the earlier signaling scope.
[Signaling protocol](../../packages/remote-protocol/src/ling-server-signaling.ts)

After the DataChannel opens, authenticate again at the Remote Gateway using the
paired keys and a fresh application session challenge bound to the verified route.
Perform protocol negotiation and capability filtering before projection or command
handling. This makes application trust independent of possession of a relay credential
or control account. TURN connections relay encrypted DTLS/SCTP traffic between peers.
TURN/TLS also protects each client-to-relay leg.

Use strict schemas and bounded message, signaling queue, ICE candidate, and frame
sizes. The application lane uses reliable ordered messages. Keep D11 artifact transfer
chunked, scoped to the task, and paced so live task and conversation updates remain
responsive. Artifact manifests bind the digest and size. Installation and use continue
through the device task's normal authorization and verification.

## 5. Route selection and restoration

~~~mermaid
flowchart TD
  Start["Authenticate to Ling Server and find the paired peer"]
  Direct["Exchange host and STUN candidates"]
  Reachable{"Verified direct ICE candidate pair?"}
  Relay["Authorize TURN on the Ling Server deployment"]
  Selected{"Relay candidate pair available?"}
  Connect["Verify the peer and establish a Gateway session"]
  Sync["Resume the owner projection and receipts"]
  Offline["Report the unavailable route and retry with backoff"]

  Start --> Direct --> Reachable
  Reachable -->|"LAN or cross-network direct"| Connect
  Reachable -->|"Direct checks timed out or failed"| Relay --> Selected
  Selected -->|"TURN over UDP or TLS over TCP"| Connect --> Sync
  Selected -->|"Relay path unavailable"| Offline
~~~

1. Both endpoints register outbound and announce their online state. Presence ages
   out independently from the success of a device or conversation connection.
2. Gather same-network candidates from the active interfaces and server-reflexive
   candidates from Ling Server's STUN endpoint. Use ICE checks with a bounded
   deadline. Prefer eligible LAN candidates and use validated direct IPv4 or IPv6
   routes across networks when available. mDNS or stored local address hints identify
   candidates. The same peer authentication applies to every address.
3. If the direct attempt fails, issue expiring TURN credentials per endpoint and
   route. Try TURN over UDP and TURN over TLS/TCP on the operator's fallback
   listener, including TCP 443 for UDP-restricted networks. Devices behind a policy
   that blocks TURN/TLS require another reachable network path.
4. Re-authenticate on network change, retry, and route migration. A replacement route
   may negotiate while the previous route is live. The Gateway activates one
   application session at a time by replacing the old session epoch or fence. Close
   the old path when the new session takes over. A session with a stale fence cannot
   start an action. Commands already committed are reconciled by receipt.
   Recheck a direct path after a meaningful network change when relay is active.
   Keep the working route until the new path verifies.

The control plane checks route issuance against the paired installation record. TURN
credentials are infrastructure credentials. coturn provides allocation authentication
and lifetime, peer-address, allocation-count, bandwidth, and relay limits. The
deployment allows only the approved relay traffic ranges, denies private and special
destination networks, and tests per-installation abuse controls. Keep coturn's admin
interface private. Record the maximum remaining lifetime of an allocation when a pair
is revoked. Gateway authorization uses the live binding independently.

The local operator control API accepts the binding ID, route-attempt ID and role
at `POST /v1/routes/relay-credential` once the route enters relay checks.
`POST /v1/routes/transport-config` includes a server-issued credential for a
connected relay route. The shared secret is supplied to the control plane through
its transport configuration. The credential expiry in the response matches the
whole-second expiry in the coturn REST username. Issuance counts are process-local.
Existing coturn allocations follow the deployment's allocation policy.
[Control plane](../../packages/daemon/src/features/ling-server/control-plane.ts)

Local execution, including a phone task with an authorized external-device link,
can continue during a Ling Server outage. A live direct peer route can continue
within its already authorized lease while it remains reachable. New cross-network
negotiation and new relay credentials require the control plane. Mobile foreground
resume reconnects and refreshes the owner projection. The design uses endpoint
recovery for background suspension.

## 6. Compatibility, synchronization, and command recovery

### 6.1 Gateway integration and migration

The existing Remote Client uses a Gateway HTTPS origin for pairing, challenge, and
WebSocket endpoints. Keep that origin's meaning in old protocol records. Introduce a
negotiated Ling Server routing profile with explicit server and Gateway identities and
separate signaling and app protocol versions. The server origin locates the control
plane. The pinned Gateway identity identifies the application peer. Update the QR and
authentication transcripts explicitly for the new route profile. Reuse the existing
validation, pairing primitives and session handler through typed transport adapters
in the client and daemon. Existing endpoint paths and routing are a code baseline
until D12 is implemented and accepted.

To switch an existing pairing, the PC owner opts in locally, the PC signs a new
server-bound peer record using its existing Gateway identity, and the phone verifies
the new server pin through the local confirmation flow. When the existing keys or
protocol cannot prove the new binding, perform local QR pairing. Keep conversation
IDs, read state and durable receipts with their owner through the migration. A changed
server identity needs its own verified trust transition.

### 6.2 Reconnect and cursors

Use the owner's stream identity, snapshot/generation, event sequence and durable
receipt contracts. Apply a delta range only if the client still has the corresponding
materialized snapshot and the retained range is contiguous. Otherwise load a bounded
current snapshot and subscribe to ordered events, covering updates that occur during
the snapshot read. Advance the acknowledged cursor only after applying its events.
A cold start without the matching snapshot requests a new one. Transport sequence
and connection IDs change when a peer session reopens. The owning journal identity and
accepted command IDs persist.

The peer journal scopes its cursor to the transport generation and direction. It
returns a snapshot requirement for an old generation or a missing frame. The owner
commits the frame and its sequence together. On route cutover, each direction starts
at sequence zero in the new generation. Sending, receiving and resuming check the
current binding epoch, including when a request repeats a retained frame.

Keep one durable logical command ID for retries within the existing retry horizon.
The owner returns the recorded receipt for the same command and normalized input and
reports a conflict if the ID is reused with different input. For device work, keep
the owning task, target, authorization and attempt ID attached to the record. If the
device action's outcome is unknown after disconnect, the owner reads back target state
and reconciles the original attempt before any follow-up write. A transport
acknowledgment describes delivery. Device verification is recorded by the execution
owner separately.
[Remote Access Detailed Design](mobile-remote-access-detailed-design.md) ·
[Device Runtime Contract](ling-device-support-platform-runtime-contract.md)

## 7. Control surface and data lifecycle

The control contract defines the following operations. Application mutations, device
operations and artifact bytes travel over the authorized peer channel.

| Operation | Authoritative checks and storage |
| --- | --- |
| Consume enrollment grant | Operator-issued, expiring grant and installation key proof. Persist installation identity, revocation and revision. |
| Pair reserve and claim | Registered PC, one expiring invitation, bounded candidate/attempt rate, and candidate key proof. Expire pending claims and public proof material. |
| Publish binding and revoke | PC-signed binding revision and epoch, atomic update and acknowledgement. Store current metadata and revocation tombstones. |
| Open presence and negotiate | Fresh installation proof, paired scope, route deadline, and version agreement. Expire presence, signed SDP, and candidate exchange when the attempt ends. |
| Issue TURN credentials | Active binding and registered route attempt, per-role credentials, lease limit, and quota. Track allocation status and duration. |
| Health and administration | Public health provides basic reachability. Operator-only management controls enrollment, rate limits, key rotation, relay workers, and redacted diagnostics. |

Persist trust and audit metadata in the Ling Server store. Retain raw network candidate
data only while a negotiation needs it. Log route class, state transitions, failure
category, byte counts, connection durations and peer-scoped opaque IDs. Use separately
scoped, redacted diagnostics when troubleshooting. Display control reachability,
partner presence, direct or relay route, peer trust, and projection freshness as
distinct states. This helps a user distinguish a reachable server from a synced PC
or a reachable external device.

## 8. Deployment and operations

| Listener or component | Deployment |
| --- | --- |
| HTTPS/WSS signaling | Ling-controlled TLS on TCP 443 at the configured server origin. Guests authenticate an explicitly initiated pairing claim or present a valid installation proof. |
| STUN and TURN | Operator-provided DNS and addressed listeners for UDP and TURN/TLS, plus the configured UDP allocation range. Publish only these configured endpoints to clients. |
| TURN/TLS on TCP 443 | Use a dedicated listener address for relay if HTTPS signaling also uses 443. The services can share a host with separate bind addresses. Verify the actual NAT and firewall reachability of the advertised relay address and port range. |
| Metadata and admin | Package control and coturn together as the self-hosted installation with SQLite metadata for a single node. Bind admin and database access to private interfaces. |
| Scaled installation | Keep peer binding epochs and revocations in a shared PostgreSQL store. Use an authenticated internal trust channel and relay-specific credentials. Preserve affinity for active relay allocations and drain them before cycling a worker. |

The operator can run Ling Server or deploy it under Ling-operated infrastructure.
Use the existing TLS trust store or a supported operator-managed trust anchor.
Configure the WebRTC adapters with the installation's own STUN/TURN configuration
and verify public reachability and the selected path. The normal deployment opens
the Ling Server's listeners. PC and Mobile initiate outbound control connections
and perform coordinated peer checks. Local workspace services retain their local
bindings.

Back up server identity and binding metadata under operator control. Verify restores
preserve validated epochs and replay existing revocation tombstones. If freshness
cannot be established after restore, refresh bindings from PC authority before granting
new routes. Rehearse relay outage, certificate rotation, rollback, and reachability
with both mobile platforms. Run control and relay health checks independently and
measure concurrent sessions, traffic, reconnection latency, relay share and peak egress
before scaling. Relay capacity is sized for concurrent encrypted bytes on both legs.

## 9. Open-source and standards references

| Source | Use |
| --- | --- |
| [Pion WebRTC](https://github.com/pion/webrtc) and [Pion ICE](https://github.com/pion/ice) | PC transport candidate and ICE reference. |
| [React Native WebRTC](https://github.com/react-native-webrtc/react-native-webrtc) | Mobile native DataChannel candidate. Verify current Ling Expo/native build and physical-device interoperability. |
| [coturn](https://github.com/coturn/coturn) | STUN/TURN inside the Ling Server deployment. Verify credential expiry, revocation behavior, and TLS interoperability on the chosen revision. |
| [Headscale](https://github.com/juanfont/headscale) and [NetBird](https://github.com/netbirdio/netbird) | Reference self-hosted node enrollment, peer coordination, and direct/relayed path diagnosis. |
| [libp2p](https://github.com/libp2p/go-libp2p) and [Syncthing](https://github.com/syncthing/syncthing) | Reference peer discovery, relay separation, and resumable peer transfer. Ling's owner/journal policies define conversation and device sync. |
| [ICE](https://www.rfc-editor.org/rfc/rfc8445) · [STUN](https://www.rfc-editor.org/rfc/rfc8489) · [TURN](https://www.rfc-editor.org/rfc/rfc8656) · [WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831) | Protocol standards for the data path. |

Record exact library versions, licenses, and reproducible compatibility evidence before
packaging. The acceptance environment uses only the configured Ling Server services
for enrollment, signaling, address discovery, and relaying.

## 10. Acceptance and evidence

| Scenario | Evidence required |
| --- | --- |
| First pairing | Local PC confirmation, server and Gateway pins, invitation expiry, collision and stale binding rejection, and recovery after the PC commits before the server acknowledges. |
| LAN and internet direct | Verify working conversation sync over both selected path types. Record selected candidates, both platforms and the absence of application traffic on the relay. |
| Difficult NAT and UDP blocked | Verify the actual TURN route, then TURN/TLS over TCP 443 in a controlled network. Confirm both are usable with no third-party communications services configured. |
| Authentication, revoke and expiry | Reject mismatched SDP fingerprint, wrong peer, replayed or stale signaling, and unauthorized route or allocation requests. Compare local revoke timing, server propagation, and bounded allocation expiration. |
| Route and process change | Switch Wi-Fi/cellular and direct/relayed paths during a conversation and device task. Restart the PC and the app. Confirm owner, snapshot/cursor, terminal receipt, and physical verification converge. |
| Server and relay outage | Record what each endpoint can continue locally, how offline state appears, and how resync behaves after recovery. |
| Confidentiality and operational limits | Confirm encrypted relay data using controlled test payloads, and verify redacted diagnostics, bounded backpressure, resource limits and restore behavior. |
| Migration | Move a paired PC and phone to the Ling Server route. Verify trust, conversation history, durable receipts, and behavior with an incompatible or revoked binding. |

Track each result in D12 with the server and client builds, phone OS, PC OS, network
conditions, chosen route, reconnect trace, and verification evidence. Both physical
mobile platforms run the complete owner-sync path.
