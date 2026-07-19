# Mobile Remote Access Detailed Design

Status: proposed; security and protocol design ready for implementation
Date: 2026-07-19
Parent: [Ling Mobile Remote Access](mobile-remote-access.md)

## Purpose

This document defines the Remote Gateway security boundary, pairing ceremony, device
identity, protocol envelopes, remote capability allowlist, durable idempotency, event
resume behavior, storage, and validation requirements.

The design assumes that remote channel content is sensitive and that an attacker may:

- be another authenticated member of the same tailnet;
- observe, delay, reorder, duplicate, or reconnect network traffic;
- obtain an expired or photographed pairing QR;
- send arbitrary WebSocket frames and oversized payloads;
- race a legitimate phone during pairing or reconnection;
- steal a paired phone without unlocking the PC;
- know the PC tailnet name and Gateway endpoint;
- exploit accidental route reuse or a permissive CORS configuration.

The design does not claim to protect a rooted/jailbroken phone, a fully compromised PC,
or a PC owner who locally approves an attacker during pairing.

## Current Security Baseline

The existing local daemon is intentionally a trusted-loopback service:

- it defaults to `127.0.0.1:17891`;
- its HTTP router does not have a general device-authentication layer;
- JSON responses currently use permissive CORS headers;
- `/rpc/stream` accepts local WebSocket upgrades without device authentication;
- many routes accept `cwd` and expose high-privilege run, approval, terminal, file,
  provider, plugin, and settings behavior.

Therefore Remote Access must not:

- change the main daemon host to `0.0.0.0`;
- forward arbitrary remote paths to the daemon router;
- attach authentication to only a few existing routes and assume the rest are safe;
- expose `/rpc/stream` through Tailscale Serve, NetBird, LAN, or port forwarding;
- trust tailnet membership as sufficient Ling authorization.

## Security Invariants

1. The existing daemon listener remains loopback-only by default.
2. Remote Gateway is a distinct opt-in listener with an explicit protocol allowlist.
3. No business data is returned before device authentication and protocol negotiation.
4. The transport is encrypted, and the phone separately authenticates the Gateway's
   application identity from the local pairing QR.
5. Long-term device authentication uses proof of private-key possession, not a bearer
   token.
6. Each PC has one active device, and that device has one active remote session. A mobile
   installation's one-PC pairing is a product UX rule, not a server-enforced global
   identity claim when no Ling account/cloud exists.
7. Pairing requires a fresh local PC action and local confirmation.
8. Pairing secrets are random, short-lived, single-candidate, consumed on acceptance, and
   never persisted in plaintext.
9. Remote commands are allowlisted, expiring, ordered, and durably idempotent.
10. The client never supplies `cwd` or any local filesystem path.
11. The Gateway maps opaque workspace/channel ids to a locally approved allowlist.
12. Revocation invalidates the device epoch, closes sockets, and blocks old signatures.
13. Outbound projections omit raw daemon events, secrets, absolute paths, raw tool output,
    stdout/stderr, and artifact bytes.
14. Protocol downgrade, unknown frame type, invalid field, and oversized input fail closed.

## Network Topology

V0 uses this topology:

```text
Mobile app
   |
   | wss://<pc-tailnet-name>/remote/v1/session
   | TLS plus the tailnet's encrypted transport
   v
Tailscale Serve
   |
   | loopback proxy only
   v
127.0.0.1:17892  Remote Gateway

127.0.0.1:17891  General daemon API (not proxied)
```

The external leg is always HTTPS/WSS. In the supported Tailscale Serve mode, Serve
terminates TLS and forwards its loopback backend over HTTP/WS; that backend hop is allowed
only because the Gateway is bound to `127.0.0.1` and still performs the full Ling device
challenge. It is not a substitute for authentication.

Required deployment rules:

- Gateway binds only to loopback when Tailscale Serve is used.
- Tailscale Serve forwards only the Remote Gateway listener, never the general daemon.
- Public Funnel mode is unsupported.
- Plain `ws://` and `http://` are accepted in production only for the loopback backend of
  an explicitly selected `tailscale_serve` mode; they are rejected on any non-loopback
  interface and in direct-overlay mode.
- Production startup fails if configured with external plaintext transport, wildcard host,
  an unrecognized proxy mode, or the same port/router as the daemon.
- A process connecting directly to the loopback Gateway cannot bypass device auth; proxy
  headers and source IP are never treated as a Ling principal.
- Gateway does not rely on Tailscale identity headers for Ling device authorization.

The QR pins a long-lived Gateway application identity key, not a rotating public TLS
certificate. The mobile app still performs normal TLS validation, then verifies the signed
Gateway handshake against the QR fingerprint. A later direct-overlay adapter may pin a
dedicated TLS SPKI, but it cannot silently replace application-level verification.

## Identity and Key Material

### Gateway Identity

The Gateway owns a P-256 signing key:

- private key stored under the daemon-owned state root with owner-only permissions;
- public key encoded as a canonical JWK;
- fingerprint `base64url(SHA-256(canonical-public-jwk))`;
- key created once per Ling installation, not once per pairing;
- explicit “reset remote identity” action revokes the device and creates a new key.

P-256/ES256 is selected for V0 because iOS Secure Enclave, Android Keystore, and Node's
standard crypto implementation can support the same verification contract. V0 does not
negotiate alternative signing algorithms; algorithm agility would create a downgrade path.

### V1 Cryptographic Encoding Profile

The three runtimes use one byte-level profile; platform defaults are not wire contracts:

- canonical JSON is RFC 8785 JCS over the I-JSON subset; invalid Unicode, non-finite
  numbers, sparse arrays, `undefined`, and non-plain objects fail closed;
- a public P-256 JWK contains exactly `crv`, `kty`, `x`, and `y`; `crv` is `P-256`, `kty`
  is `EC`, and `x`/`y` are 32-byte unpadded base64url coordinates;
- binary values use unpadded canonical base64url; SHA-256 digests, nonces, secrets, and
  fingerprints are 32 bytes;
- signing input is `UTF8(domain) || 0x00 || UTF8(JCS(named-object))`; the NUL separator
  and named canonical object make concatenation unambiguous;
- ES256 wire signatures are the JWS/IEEE-P1363 fixed 64-byte `r || s` representation.
  Apple Security and Android `SHA256withECDSA` return X9.62 DER, so the Mobile adapter
  performs strict DER/P1363 conversion without exposing private-key material;
- V1 does not require low-S normalization. Challenges are single-use and command identity
  is independent from signature bytes; both mathematically valid S forms verify;
- HMAC proof uses HMAC-SHA-256 over the same pairing transcript bytes;
- Gateway/device fingerprints are
  `base64url(SHA-256(JCS({ crv, kty, x, y })))` without a signing-domain prefix;
- QR and device-proof validators recompute that fingerprint from the supplied JWK and
  compare decoded bytes before displaying or reserving an identity; a separately declared
  but mismatched fingerprint is never accepted;
- timestamps use exactly UTC RFC3339 milliseconds (`YYYY-MM-DDTHH:mm:ss.SSSZ`), clock skew
  is at most 30 seconds, an auth challenge lives at most 30 seconds, and a command frame
  lives at most 60 seconds.

The V1 signing domains and named fields are fixed:

| Domain | Canonical object fields |
| --- | --- |
| `ling-remote-pair-challenge-v1` | `gatewayOrigin`, `gatewayId`, `pairingId`, `serverNonce`, `issuedAt`, `expiresAt`, `protocolVersion` |
| `ling-remote-pair-proof-v1` | `gatewayOrigin`, `gatewayId`, `pairingId`, `serverNonce`, `clientNonce`, `deviceId`, `displayName`, `platform`, `devicePublicKeyJwk`, `devicePublicKeyFingerprint`, `protocolVersion` |
| `ling-remote-pair-accepted-v1` | `gatewayOrigin`, `gatewayId`, `pairingId`, `deviceId`, `deviceEpoch`, `protocolVersion`, `pairedAt` |
| `ling-remote-auth-challenge-v1` | `gatewayOrigin`, `gatewayId`, `challengeId`, `candidateSessionId`, `serverNonce`, `deviceEpoch`, `issuedAt`, `expiresAt`, `supportedProtocolVersions` |
| `ling-remote-auth-v1` | `gatewayOrigin`, `gatewayId`, `challengeId`, `candidateSessionId`, `serverNonce`, `clientNonce`, `deviceId`, `deviceEpoch`, `protocolVersion`, `resumeHash` |
| `ling-remote-command-v1` | `gatewayId`, `deviceEpoch`, `commandKind`, `workspaceId`, `channelId`, `body`, `remotePolicyVersion` |

`resumeHash` is unpadded base64url SHA-256 over JCS of the resume cursors sorted first by
ASCII `streamId` and then by ASCII `snapshotId`; duplicate stream ids fail. The stable
fixture corpus is `packages/remote-protocol/fixtures/v1/` and is consumed unchanged by
Node and the iOS/Android development build.

### Device Identity

The mobile app creates a non-exportable P-256 signing key when the native platform permits:

- iOS: Secure Enclave/Keychain-backed signing key;
- Android: hardware-backed Android Keystore key when available;
- device private key never enters JavaScript as raw bytes in a release build;
- public key is registered only during locally confirmed pairing.

Release policy is platform-specific but never falls back to a JavaScript key. iOS requires
the Secure Enclave and reports unsupported when it is unavailable. Android requires a
non-exportable `AndroidKeyStore` key (`privateKey.encoded == null`); StrongBox or TEE is
used when reported by `KeyInfo`, while a reported `software` security level remains usable
for V0 with reduced-assurance diagnostics because the OS keystore still keeps the key out
of JavaScript. The pairing record and local audit retain the Android security level.

The secure-key implementation is a release blocker. A mock or JavaScript-exportable
software key may be used in unit tests and local simulator development, but production
must not fall back to that key or to a long-lived bearer token when native signing or OS
key storage is unavailable. AndroidKeyStore reporting `software` is still native OS key
storage and is handled by the explicit reduced-assurance rule above.

### Device Record

The PC persists only public and administrative data:

```ts
interface RemoteDeviceRecord {
  readonly gatewayId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly displayName: string;
  readonly platform: "ios" | "android";
  readonly publicKeyJwk: JsonWebKey;
  readonly publicKeyFingerprint: string;
  readonly protocolVersion: 1;
  readonly status: "active" | "revoked";
  readonly pairedAt: string;
  readonly lastAuthenticatedAt?: string;
  readonly revokedAt?: string;
}
```

The database has a uniqueness rule allowing only one `active` device per `gatewayId`.
Replacement requires a local revoke/replace transaction that increments `deviceEpoch`.

## State Machines

### Gateway Pairing State

```text
DISABLED
   | local enable
   v
UNPAIRED
   | local open-pairing
   v
PAIRING_OPEN ---- expires/restart/cancel ----> UNPAIRED
   | valid mobile proof
   v
WAITING_LOCAL_CONFIRMATION
   | reject/expire --------------------------> UNPAIRED
   | local confirm
   v
PAIRED_OFFLINE <---- disconnect ------------ PAIRED_ONLINE
   |                                              ^
   | valid authenticated connection              |
   +----------------------------------------------+
   |
   | local revoke/replace/disable
   v
REVOKING -> UNPAIRED or DISABLED
```

Pairing intermediate state is intentionally not recovered after a process restart. A new
local pairing action is required.

### Mobile Connection State

```text
UNPAIRED
   | scan QR
   v
PAIRING -> VERIFYING_GATEWAY -> OFFLINE
                                |
                                v
CONNECTING -> AUTHENTICATING -> SYNCING -> ONLINE
     ^              |              |         |
     |              +-- failure ---+---------+
     |                                      network loss
     +------------- RECONNECTING <-----------+

Any state -> REVOKED / INCOMPATIBLE / PAIRING_REQUIRED
```

UI must never label cached content as live while outside `ONLINE`.

## Pairing Ceremony

### Local Preparation

`ling remote pair` or the future Desktop settings surface:

1. verifies Remote Access is enabled and the Gateway is reachable through the configured
   supported network mode;
2. refuses to open pairing while another device is active unless the owner explicitly
   selects replace/revoke;
3. creates `pairingId`, a 32-byte random `pairingSecret`, and a five-minute expiry;
4. stores only a hash for durable diagnostics and keeps the usable secret in memory;
5. emits a QR payload without logging it.

```ts
interface RemotePairingQrV1 {
  readonly kind: "ling_remote_pairing";
  readonly version: 1;
  readonly gatewayId: string;
  readonly gatewayOrigin: string;
  readonly gatewayIdentityPublicKeyJwk: JsonWebKey;
  readonly gatewayIdentityFingerprint: string;
  readonly pairingId: string;
  readonly pairingSecret: string; // 32 random bytes, base64url
  readonly expiresAt: string;
}
```

The QR encoding uses `ling-pair-v1:<base64url(canonical-json)>`. The secret is never sent
as an HTTP query parameter, cookie, analytics property, crash report, or log field.

### Mobile Pairing Request

The phone:

1. validates QR kind/version/expiry and the HTTPS/WSS origin;
2. creates its device signing key;
3. connects to `/remote/v1/pair`;
4. receives a fresh server nonce;
5. sends its public key, device metadata, client nonce, and an HMAC proof over the
   canonical pairing transcript using `pairingSecret`;
6. signs the same transcript with its new device private key.

The Gateway checks expiry, reservation state, HMAC, device signature, payload limits, and
that no active device already exists. It reserves the pairing secret to the first valid
device-key fingerprint for a short confirmation window (the same candidate may safely
retry); other fingerprints cannot burn or steal that reservation. The secret is consumed
only on local acceptance. A local rejection or confirmation timeout invalidates the
pairing id and immediately rotates the QR secret, so the owner can continue pairing by
scanning the newly displayed QR rather than being stranded by a raced request.

### Local Confirmation

Both PC and phone render a short verification phrase derived from the transcript hash.
The PC shows the device name, platform, public-key fingerprint, and phrase. Only a local
PC action can accept it.

On accept, one SQLite transaction:

- verifies there is still no conflicting active device;
- writes the active `RemoteDeviceRecord` and next `deviceEpoch`;
- writes a security audit event;
- closes the pairing window.

On reject, timeout, or daemon restart, the pending candidate and usable secret are cleared
from memory and the pairing UI generates a fresh pairing id/secret. Rate limits and the
short reservation window bound a tailnet peer's ability to hold the PC in a pending state.

The Gateway returns a `pair.accepted` frame signed by its identity key. The phone verifies
that signature against the fingerprint in the QR before persisting the pairing.

## Connection Authentication

No long-lived access or refresh token exists. Each WebSocket connection performs a fresh
challenge-response.

### Challenge

```ts
interface RemoteAuthChallengeV1 {
  readonly version: 1;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly serverNonce: string; // 32 random bytes
  readonly candidateSessionId: string;
  readonly deviceEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string; // <= 30 seconds
  readonly supportedProtocolVersions: readonly [1];
  readonly gatewaySignature: string; // ling-remote-auth-challenge-v1
}
```

### Device Proof

```ts
interface RemoteAuthProofV1 {
  readonly version: 1;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly candidateSessionId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly clientNonce: string;
  readonly protocolVersion: 1;
  readonly resume: readonly RemoteResumeCursorV1[];
  readonly signature: string;
}

interface RemoteResumeCursorV1 {
  readonly streamId: string;
  readonly snapshotId: string;
  readonly lastAckServerSeq: number;
  readonly hasMaterializedSnapshot: true;
}
```

The signature input is canonical and domain-separated:

```text
"ling-remote-auth-v1" ||
gatewayOrigin || gatewayId || challengeId || candidateSessionId ||
serverNonce || clientNonce || deviceId || deviceEpoch || protocolVersion ||
hash(resume)
```

The Gateway rejects the proof before returning data when:

- the challenge is missing, expired, or already consumed;
- gateway, session, device, epoch, or origin binding differs;
- the device is not active;
- the signature is invalid;
- the protocol version is not exactly supported;
- an active session transition loses the atomic compare-and-swap.

A valid new connection from the paired device atomically replaces its older connection.
The old socket is closed with `session_replaced`, and its session id is immediately invalid.

## Remote Envelope

Post-authentication frames use one validated base plus direction-specific sequencing fields.
The same value is never duplicated in both the envelope and payload:

```ts
interface RemoteFrameBaseV1<TType extends string, TPayload> {
  readonly version: 1;
  readonly type: TType;
  readonly messageId: string;
  readonly gatewayId: string;
  readonly sessionId: string;
  readonly sentAt: string;
  readonly requestId?: string;
  readonly payload: TPayload;
}

interface RemoteClientCommandFrameV1<TType extends string, TPayload>
  extends RemoteFrameBaseV1<TType, TPayload> {
  readonly clientSeq: number;
  readonly expiresAt: string;
}

interface RemoteServerEventFrameV1<TType extends string, TPayload>
  extends RemoteFrameBaseV1<TType, TPayload> {
  readonly streamId: string;
  readonly eventId: string;
  readonly serverSeq: number;
  readonly occurredAt: string;
}

interface RemoteStreamAckV1 {
  readonly streamId: string;
  readonly ackServerSeq: number;
}
```

Protocol rules:

- strict runtime schema validation; unknown top-level fields are rejected;
- a duplicate-name scanner runs before `JSON.parse`, including nested payload objects, so
  escaped or literal duplicate member names cannot be overwritten into a different frame;
- UTF-8 JSON for V0, no `eval`, polymorphic class hydration, or arbitrary patch format;
- max frame size 256 KiB and max text message body 32 KiB;
- WebSocket compression disabled for authenticated content;
- `clientSeq` exists only on client command frames and must increase by exactly one inside
  a session;
- `serverSeq`/`eventId`/`streamId` exist only on server stream events; acknowledgements
  name one stream and one cumulative sequence;
- duplicate/out-of-order client frames close the session after a bounded error response;
- every command frame has a short expiry and a maximum accepted clock-skew window;
- every lifecycle command payload has one `commandId`; `stream.ack` is transport control,
  has no command id, and never produces `command.accepted/completed/failed`. This prevents
  an acknowledgement-completion feedback loop. `messageId` identifies a transport frame,
  and a server `requestId` may reference that frame without replacing the stable command
  id. Only `channel.send_text` persists the command id across sessions in V0;
- `command.completed` and `command.failed` repeat `commandId` plus `commandType`, and the
  result discriminator must match that type;
- server events are ordered per remote stream and acknowledged cumulatively;
- `session.ready` and command lifecycle events use the authenticated session's control
  stream, so they follow the same `streamId`/`serverSeq` event envelope rather than a
  second unsequenced server-frame shape;
- heartbeats contain no business data.

## Remote Capability Allowlist

V0 command kinds:

```text
session.ping
stream.subscribe
stream.unsubscribe
stream.ack
snapshot.request
channel.list
channel.open
channel.send_text
```

V0 server event kinds:

```text
session.ready
workspace.summary
channel.list_snapshot
channel.snapshot
transcript.delta
run.summary
approval.summary
command.accepted
command.completed
command.failed
stream.resync_required
security.revoked
```

Explicitly forbidden in V0:

- arbitrary HTTP method/path forwarding;
- client-supplied `cwd`, filesystem path, environment, provider, model, teammate, tools,
  permission preset, or approval decision;
- direct run start/cancel/intervention commands;
- terminal, file, artifact bytes, attachment, plugin, settings, secret, memory export,
  Computer Use, or admin operations;
- any unknown command or payload field.

### Mobile Message Ceiling

`channel.send_text` is a communication capability, not a hidden remote task endpoint.
The Gateway passes a server-owned context into a dedicated daemon application service:

```ts
interface RemoteMessageExecutionPolicyV1 {
  readonly sourceSurface: "mobile";
  readonly authorityCeiling: "channel_comment";
  readonly allowAiReply: true;
  readonly allowToolCalls: false;
  readonly allowWorkflowAutoStart: false;
  readonly allowExecutionProposal: false;
}
```

The service may create a conversational AI reply with tools disabled, but it must not call
the generic local-user channel handler without this ceiling. `/`, `@`, hidden proposal
markers, teammate routing, provider/model overrides, and natural-language instructions
cannot raise the ceiling. If the daemon cannot enforce this context end-to-end, V0 falls
back to durable comment-only delivery and does not start an AI route.

The durable dispatch intent records `sourceSurface`, `deviceId`, `sessionId`, policy version,
and authority ceiling. This lets the dispatcher and audit layer distinguish a Mobile
comment from a local Web/Desktop message. A future remote task capability needs a separate
policy, audit, approval, and threat-model review; it is not an extra field on this command.

`channel.send_text` contains only:

```ts
interface RemoteSendTextCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string; // opaque id, never cwd
  readonly channelId: string;
  readonly body: string;
}
```

The Gateway constructs the local author/source metadata and invokes the bounded daemon
application service. The phone cannot set `authorType`, runtime routing, permission, model,
provider, teammate, tool, attachment, or file-reference fields. Any permitted conversational
reply remains subject to the daemon's existing provider readiness and audit state, but it
cannot auto-start a workflow or tool-backed run.

## Workspace and Channel Authorization

V0 binds the Gateway to one local workspace at enable/pair time:

```ts
interface RemoteAccessPolicyV1 {
  readonly workspaceId: string;
  readonly localWorkspacePath: string; // PC-side only; never serialized remotely
  readonly channelAccess:
    | { readonly mode: "selected"; readonly channelIds: readonly string[] }
    | { readonly mode: "all_in_workspace" };
  readonly capabilities: readonly RemoteCapabilityV1[];
}
```

`channel.read` is mandatory while Remote Access is enabled. The other three V0
capabilities are independently removable by the local owner, so the wire policy can express
a least-privilege subset but can never introduce a capability outside the V0 allowlist.

The local binding also stores a canonical identity, not only the display path:

```ts
interface RemoteWorkspaceBindingV1 {
  readonly workspaceId: string;
  readonly canonicalRoot: string;
  readonly storageDatabasePath: string;
  readonly storageIdentity: string; // platform file-id/device+inode or equivalent
  readonly boundAt: string;
}
```

At local enable, the daemon resolves symlinks, derives its normal storage paths, and
records the storage identity. Every remote command revalidates the canonical root,
database identity, and workspace metadata before using the already-bound store handle. A
move, symlink swap, missing database, or identity mismatch disables Remote Access and
requires a local rebind. The Gateway never calls `RunStoreRegistry.getStore()` with a
remote-provided string.

The PC owner explicitly selects the channel mode locally. The remote `workspaceId` is an
opaque alias looked up by the Gateway. Unknown aliases, channels outside the policy, and
any path-shaped input fail closed without revealing whether a local path exists.

Run and approval summaries are never workspace-global in V0. Before projection, the
Gateway must resolve each run/approval through its source message/workflow/task provenance
to an allowed `channelId`. If that binding is missing, ambiguous, or outside
`channelAccess`, the event is withheld. Tests cover a permitted channel and a simultaneous
non-permitted channel so metadata cannot leak across the allowlist.

## Durable Command Idempotency

In-memory deduplication is insufficient. A disconnect can happen after the daemon writes a
user message but before the phone receives `command.completed`; blindly retrying would
create a duplicate message and may trigger duplicate AI work.

The daemon store adds a durable receipt keyed by `(gatewayId, deviceEpoch, commandId)`:

```ts
interface RemoteCommandReceipt {
  readonly gatewayId: string;
  readonly deviceEpoch: number;
  readonly commandId: string;
  readonly commandKind: "channel.send_text";
  readonly sourceSurface: "mobile";
  readonly authorityCeiling: "channel_comment";
  readonly policyVersion: 1;
  readonly requestHash: string;
  readonly status: "accepted" | "completed" | "failed";
  readonly resultRef?: string;
  readonly dispatchRef?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
```

`requestHash` is the SHA-256 hash of a domain-separated canonical semantic command:

```text
"ling-remote-command-v1" || gatewayId || deviceEpoch || commandKind ||
workspaceId || channelId || body || remotePolicyVersion
```

Transport-only `sessionId`, `clientSeq`, `sentAt`, `expiresAt`, and `requestId` are not part
of this hash, so a legitimate retry in a new session matches the original semantic command.
They are still validated before a new command is accepted.

`channel.send_text` follows one `BEGIN IMMEDIATE` transaction:

1. load the receipt by primary key;
2. if it exists with the same request hash, return the stored result;
3. if it exists with a different hash, return `idempotency_conflict`;
4. otherwise insert the receipt, create the user channel message, and write a durable
   dispatch intent keyed by that source message;
5. record the message/dispatch ids as the command result and commit;
6. after commit, a reconciled dispatcher claims the intent and enters the bounded
   channel-comment reply path using the source message id as its idempotency boundary.

The message, receipt, and dispatch intent must be atomic. A deterministic message id may
provide an extra uniqueness guard, but it does not replace the request hash and receipt.
The dispatch intent closes the crash window between committing the message and starting the
bounded conversational reply. Startup reconciliation resumes an unclaimed intent without
creating another user message. The dispatcher uses a unique `(sourceMessageId,
authorityCeiling, policyVersion)` route intent and deterministic pending-reply/work-unit
ids. It provides exactly one durable visible reply/work-unit record; an external provider
call may be retried after an unobservable crash, so the protocol does not claim exactly-once
provider billing or network side effects. Receipts are retained long enough to exceed every
supported reconnect/retry window and are removed only by bounded maintenance after terminal
state.

The durable dispatch state machine is explicit:

```text
PENDING -> LEASED -> REPLY_RESERVED -> COMPLETED
   ^          |            |
   |          | lease      | recover/retry provider work against the same ids
   +----------+ expires ---+

Any state -> FAILED_TERMINAL only through a compare-and-set transition.
```

- a unique index protects the route-intent key;
- claiming uses a lease/compare-and-set so two workers cannot own the same attempt;
- the pending assistant message and supervised work-unit ids are reserved durably before
  the provider call;
- recovery reuses those ids and never calls `createAiChannelReply` as a fresh operation;
- terminal publication is compare-and-set/idempotent;
- provider retries are counted and visible only in local audit/diagnostics.

## Snapshot, Delta, and Resume

The daemon remains authoritative. The mobile app never reconstructs missing truth from a
partial local event log.

```text
connect/authenticate
       |
       v
request stream with an in-memory lastAck (only when a matching snapshot baseline exists)
       |
       +-- cursor available --> replay seq N+1..current --> ONLINE
       |
       +-- cursor too old/gap --> resync_required
                                  |
                                  v
                            bounded snapshot
                                  |
                                  v
                            deltas after barrier seq
```

Snapshot creation uses a subscribe-before-read barrier so a write cannot disappear between
the snapshot query and listener registration:

1. under the projection-hub lock, allocate a new `streamId` generation, register its
   listener/buffer, and capture the current `barrierSeq`;
2. build the bounded snapshot in one consistent SQLite read after registration;
3. send `{ snapshotId, streamId, barrierSeq, transcript }`;
4. flush every buffered event with `serverSeq > barrierSeq`, then switch to live delivery;
5. apply events by stable entity/block id and revision, so a mutation already visible in
   the snapshot but also present in the buffer is an idempotent duplicate rather than a
   second row.

All remote-visible mutations must publish their projection event after the underlying
transaction commits, and sequence assignment is serialized by the same projection-hub
lock used for registration/barrier capture. The listener is registered before the snapshot
read, so a commit is
either visible in the snapshot, buffered as a later event, or both; it is never in neither.
If the daemon restarts, the hub generation/`streamId` changes and every cursor from the old
generation receives `resync_required`. Buffer overflow has the same result.

Requirements:

- each projected remote stream has a monotonic `serverSeq`;
- a cold mobile process has no valid resume cursor because V0 does not persist the
  transcript snapshot; it must request a fresh snapshot before applying deltas;
- duplicate deltas are safe to ignore by `(streamId, serverSeq, eventId)`;
- a gap pauses application of later deltas and requests a snapshot;
- snapshot includes `snapshotId`, `streamId`, and the captured barrier sequence so deltas
  can continue without a subscribe gap;
- PC sleep, daemon restart, and network changes use the same resume path while a process
  remains alive; a mobile process restart always starts with `hasMaterializedSnapshot=false`
  and receives a fresh snapshot;
- a network drop never cancels or changes the local run;
- mobile does not maintain an offline mutation queue in V0.

Existing control-plane replay/redaction utilities may be reused for safe run/approval
summaries, but channel transcript changes need their own snapshot/delta projection because
the current control-plane domains do not own channel messages.

## Remote Projection and Redaction

Allowed outbound data:

- stable workspace alias and user-approved channel ids/names;
- bounded channel message and transcript semantic DTOs;
- assistant/user text visible in the channel;
- high-level operation labels and terminal status;
- redacted run and pending-approval summaries;
- safe timestamps, ids, revisions, and sequence cursors.

Removed or replaced:

- local absolute paths and `cwd` -> omitted or safe workspace-relative label;
- secret/env/config refs -> omitted;
- raw tool arguments and results -> summarized state only;
- stdout/stderr and terminal output -> omitted;
- raw artifact bytes/content -> metadata omitted in V0;
- internal daemon/provider payloads -> omitted;
- stack traces -> stable remote error code plus safe message.

User-authored and assistant-authored message text is intentionally visible; the Gateway
does not claim content-based DLP over text the user chose to place in a channel. Structured
secret fields and raw execution payloads are still removed before serialization.

## Revocation and Key Rotation

Local revoke/replace/disable is one atomic security operation:

1. change device status to `revoked` and increment `deviceEpoch`;
2. invalidate candidate challenges and active session ids;
3. close the current socket with `security.revoked` when possible;
4. remove unconsumed pairing state;
5. write an audit event;
6. tell the mobile app to clear cached transcript content and pairing metadata.

Old device signatures fail because the epoch no longer matches even if the old public key
record is retained for audit. Resetting Gateway identity also performs revocation and makes
the prior QR fingerprint invalid.

## Installation and Workspace Storage Domains

The one-device invariant is installation-wide, while message idempotency must be atomic
with one workspace's channel message. Those records cannot all live in a workspace-local
SQLite database.

Installation-global state under the daemon/Desktop user-data root owns:

- Gateway identity metadata and private-key reference;
- the single active device, `deviceEpoch`, and active session generation;
- the selected canonical workspace binding and remote policy version;
- pairing/auth/revoke security audit records.

The selected workspace SQLite database owns:

- remote command receipt;
- local channel message;
- bounded-reply dispatch intent, lease, and deterministic result references;
- command/dispatch audit records tied to workspace entities.

This preserves one active phone across all workspaces while keeping
receipt/message/dispatch in one workspace transaction. Opening a different workspace does
not create another Gateway identity or active-device row.

Because SQLite cannot atomically commit across these two storage domains, the single daemon
process uses an authorization barrier:

```ts
interface RemoteAuthorizationLeaseV1 {
  readonly gatewayId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly workspaceBindingId: string;
  readonly remotePolicyVersion: number;
  readonly sessionId: string;
  readonly expiresAt: string;
}
```

Before a workspace transaction, the Gateway acquires a short in-process read lease from
the installation-global coordinator and holds it through commit. Revoke, replace, disable,
or workspace rebind takes the exclusive barrier, prevents new leases, waits for or
explicitly invalidates in-flight work according to the local action, updates global epoch/
policy, then closes sessions. The workspace receipt snapshots `deviceEpoch`, binding id,
and policy version. On restart there are no active sessions or leases, so reauthentication
and global binding validation happen before any workspace receipt can be replayed.

If Remote Gateway later becomes multi-process, this in-process barrier is insufficient and
must become a durable installation-global lease/transaction protocol before that change
ships.

## Storage Rules

PC:

- Gateway private key: owner-only installation file or supported OS keychain adapter;
- device record, policy, device epoch, selected workspace binding, and pairing/auth audit:
  installation-global Remote Gateway state;
- command receipts, channel messages, dispatch intents, and entity-linked command audit:
  the bound workspace SQLite state;
- active challenges, pairing secret, sessions, and nonce cache: memory only;
- no duplicate transcript database in the Gateway.

Mobile:

- device private key: platform hardware-backed keystore;
- Gateway public identity, endpoint, and pairing ids: secure app storage;
- last-ack cursors are memory-only and are sent only when the same process still owns the
  corresponding materialized snapshot id;
- transcript: memory-only in V0, cleared on sign-out/revoke;
- no pairing secret after pairing completes or fails.

Secrets and content must not enter analytics, crash metadata, notification previews by
default, or ordinary logs.

## Rate and Resource Limits

Initial limits, adjustable only from local configuration:

- one pairing request in flight;
- pairing/auth failures: bounded per peer and globally with exponential backoff;
- one active authenticated socket;
- 256 KiB maximum frame, 32 KiB maximum text body;
- 20 protocol frames/second sustained with a small burst;
- 10 text-message commands/minute;
- bounded unacknowledged event queue; overflow produces `resync_required` and closes;
- WebSocket compression disabled;
- idle and unauthenticated timeouts;
- malformed-frame threshold closes the connection without verbose parser details.

Exact numeric defaults should be benchmarked, but release tests must prove that limits are
enforced before allocation or daemon work grows without bound.

## Audit Events

Security-relevant events record safe metadata:

```text
remote.enabled / remote.disabled
pairing.opened / pairing.expired / pairing.rejected / pairing.confirmed
device.authenticated / device.auth_failed / device.revoked / session.replaced
command.accepted / command.replayed / command.conflict / command.rejected
stream.resync_required
```

Each record may contain `gatewayId`, `deviceId`, `deviceEpoch`, `sessionId`, command kind,
safe target id, result code, timestamp, and source surface `mobile`. It must not contain
private/public key material beyond a short fingerprint, pairing secret, signature, message
body, raw payload, local path, or transcript content.

## Threat Controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Another device on the tailnet calls Gateway | Device challenge signature and active-device record | Compromised paired phone remains trusted until revoke. |
| QR is photographed | Five-minute candidate reservation, QR rotation on reject, plus PC-local device confirmation | Owner can approve the wrong device if they ignore the phrase/name. |
| Captured auth proof is replayed | Fresh single-use server challenge, origin/session/epoch binding | Compromised Gateway process can issue valid challenges. |
| Command is replayed after disconnect | Expiry, session sequence, durable command receipt | Retention must exceed retry horizon. |
| Same command id carries different text | Request hash conflict | Client bug surfaces as explicit failure. |
| Second phone pairs concurrently | Active-device uniqueness and local compare-and-swap | Local replace intentionally revokes the first phone. |
| Public daemon route becomes reachable | Separate listener/router and startup binding assertions | PC compromise or deliberate unsafe proxying is outside the boundary. |
| Client supplies a sensitive path | No `cwd`/path fields; opaque allowlist mapping | User message text can still mention a path. |
| Protocol downgrade | V0 exact version/algorithm binding | Future version negotiation needs a new review. |
| Oversized/hostile frame | Pre-parse size limit, strict schema, rate limit | Parser/library vulnerabilities still require dependency updates. |
| PC sleeps during a run | Reauth and snapshot/delta resume | Phone cannot control the run while PC is unreachable. |
| Phone is stolen | OS lock, hardware key, PC revoke | An unlocked stolen phone is usable until revoke. |

## Error Codes

Stable remote codes include:

```text
pairing_closed
pairing_expired
pairing_consumed
pairing_confirmation_required
device_already_paired
device_revoked
device_epoch_mismatch
challenge_expired
challenge_replayed
signature_invalid
protocol_incompatible
session_replaced
sequence_invalid
command_expired
idempotency_conflict
workspace_not_allowed
channel_not_allowed
capability_not_allowed
payload_too_large
rate_limited
resync_required
pc_unavailable
```

Authentication failures return a generic close reason over the network; detailed cause is
available only in local safe diagnostics.

## Validation Plan

### Protocol Unit Tests

- canonical serialization produces identical signing bytes on Node, iOS, and Android;
- malformed, unknown, extra-field, wrong-version, and oversized envelopes fail;
- signing verification fails on any changed bound field;
- challenge expiry, consumption, nonce replay, epoch mismatch, and downgrade fail;
- sequence, acknowledgement, duplicate, reorder, gap, and resync rules are deterministic;
- fuzz/property tests cover validators and canonicalization.

### Gateway Integration Tests

- main daemon remains loopback-only and its router is never mounted on the Gateway;
- no business response is sent before authentication;
- expired, wrong, and consumed pairing secrets fail;
- concurrent phone pairing yields exactly one locally confirmed active device;
- changing the selected workspace cannot create a second installation-level active device;
- revoke/rebind racing a workspace command is serialized by the authorization barrier and
  records the winning epoch/policy outcome;
- a second active session replaces and invalidates the old session atomically;
- revoke closes the socket and old signatures cannot reconnect;
- unknown workspace/channel/command and path-shaped injection fail closed;
- workspace realpath/storage-identity changes, symlink swaps, and missing database state
  disable the binding instead of opening another store;
- rate, body, frame, unauthenticated timeout, and queue limits are enforced;
- outbound projection contains no structured secrets, absolute paths, raw tool payloads,
  stdout/stderr, or artifact bytes.

### Idempotency and Recovery Tests

- disconnect before `command.completed`, then retry, creates exactly one user message;
- same command and payload returns the stored result;
- same command with different payload returns `idempotency_conflict`;
- simulated crash at each transaction boundary leaves no duplicate-capable state;
- simulated crash after commit but before routing is recovered from the durable dispatch
  intent without a duplicate visible reply/work-unit record (provider retry is observable
  only in local audit);
- Mobile-originated text cannot auto-start a workflow, execution proposal, or tool-backed
  run even when the same body would do so from a local surface;
- duplicate and out-of-order deltas do not corrupt the mobile view;
- a mutation committed between stream registration and snapshot completion appears in the
  snapshot, buffered events, or idempotently both, but is never absent;
- event gap and stale cursor force a bounded snapshot;
- daemon restart/stream-generation mismatch forces a fresh snapshot rather than replaying
  an old-generation cursor;
- daemon restart, PC sleep, phone background/foreground, Wi-Fi/cellular switch, and relay
  fallback all converge to daemon-authoritative state.

### Real-Device Security Acceptance

- iOS release build proves the private key is hardware/Keychain backed and non-exportable;
- Android release build proves Keystore-backed key generation and signing;
- both platforms reject a changed Gateway identity fingerprint;
- a third device in the same tailnet cannot authenticate to Ling;
- local revoke works while the phone is online and while it is offline;
- proxy inspection confirms no credentials are placed in URLs, no plaintext traffic leaves
  loopback, and the external phone-to-Serve leg is HTTPS/WSS;
- a focused penetration test covers pairing race, replay, frame fuzzing, downgrade, route
  confusion, rate-limit bypass, and log/diagnostic leakage.

## Security Review Verdict

The architecture is acceptable for implementation only with the distinct listener,
hardware-backed device proof, local pairing confirmation, durable idempotency, fixed
workspace mapping, and strict allowlist described here. Removing any one of those controls
changes the trust boundary and requires another review.

Remote approval decisions, attachments, files, terminal output, run cancellation, and
Computer Use remain excluded from V0. They must not be enabled as “small endpoint additions”
because each introduces a new authorization and data-loss boundary.
