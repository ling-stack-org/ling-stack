# Mobile Approval and Creation Detailed Design

Status: proposed; design locked for the isolated Mobile branch, implementation pending
Date: 2026-08-01
Parent: [Ling Mobile Remote Access](mobile-remote-access.md)

Related documents:

- [Mobile Remote Access Detailed Design](mobile-remote-access-detailed-design.md)
- [Mobile Remote Access Implementation Plan](mobile-remote-access-implementation-plan.md)
- [Mobile Conversation UI 2.0 Detailed Design](mobile-conversation-ui2-detailed-design.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)

## Outcome

The paired iPhone must be able to finish the two remote-user loops that conversation-only
Mobile leaves incomplete:

1. unblock a PC Agent that is waiting for an approval decision; and
2. start a normal conversation, create a basic channel, start a direct conversation with
   an existing teammate, or add an existing teammate to a channel.

These capabilities remain narrow Remote Gateway operations. They do not turn Mobile into
a remote daemon console, a second runtime, or a place to configure providers, tools,
workspace permissions, or new AI teammate identities.

## Locked Product Decisions

- Mobile and PC consume and resolve the same daemon-owned durable approval. There is no
  phone-only approval table or state machine.
- Mobile can approve only one pending request at a time and only with `allow_once`; it
  cannot update workspace policy, permission presets, allowed paths, provider settings, or
  persistent tool defaults.
- Every pending approval that can be tied to an allowed conversation may be shown through
  a redacted projection. The server, not Mobile, decides whether approval is Mobile-
  eligible.
- Low/medium eligible approvals expose `Allow once` and `Deny`. High-risk eligible
  approvals require an explicit detail review, a decision reason, and local OS
  authentication before the app sends `Allow once`.
- Critical approvals and sensitive action families remain PC-only for approval. Mobile
  may deny them after an explicit destructive confirmation, or leave them pending for PC.
- Tapping `New conversation` creates only a device-local draft. The daemon conversation
  is created atomically with the first sent message, matching the current PC behavior and
  avoiding abandoned empty conversations.
- Mobile channel creation accepts only a name and existing teammate ids. Workspace
  binding, runtime defaults, Ling Agent membership, tools, provider, permissions, and
  response policy are server-owned defaults.
- `Add teammate` means selecting an existing active teammate. Creating or configuring a
  new AI teammate remains PC-only.
- A direct teammate draft is created locally and becomes durable with its first message.
- Foreground approval attention is part of this scope. Reliable background push is not:
  a local-only PC Gateway cannot reliably wake a suspended iOS app without an APNs-capable
  service.

## Strongest Counterargument

A phone has less context than the PC. A one-tap remote approval can authorize a shell,
write, external send, deployment, credential change, or provider mutation while hiding
the evidence needed to judge it. The design therefore does not mirror the broad PC
approval endpoint. It projects a redacted decision card, applies a server-owned
eligibility policy, uses `allow_once`, keeps sensitive/critical approvals PC-only, and
requires the same durable decision side effects as the local PC flow.

## What Already Exists

| Existing capability | Reuse decision |
| --- | --- |
| `ApprovalRequest`, approval checkpoints, risk/status, expiry, and runtime permission payloads | Reuse as the sole approval authority. |
| PC approve/deny behavior and runtime permission waiter/continuation grant | Extract one application-level decision service used by both PC routes and Remote Gateway. |
| Remote Gateway pairing, device challenge, capability allowlist, command lifecycle, replay defense, and durable receipts | Extend with narrow typed commands; never mount the general daemon router. |
| Remote projection outbox and ordered workspace/conversation streams | Project approval, channel, membership, and newly started conversation changes after commit. |
| Normal-conversation first-message creation path | Preserve its user behavior, but enter through a bounded Mobile application service. |
| Channel store and workspace defaults | Reuse behind a Mobile-specific channel creation service that accepts no path/runtime fields. |
| Teammate catalog and channel membership storage | Expose a sanitized active catalog and one additive membership service; do not reuse the broad replace-all route. |
| Unified Mobile conversation index/detail and remote-client reducer | Extend with typed approval/creation state; screens do not parse wire frames. |

## Capability Boundary

The extension adds these independently removable capabilities:

```text
approval.read
approval.resolve
conversation.start
channel.create
teammate.read
channel.member.add
```

The protocol adds these lifecycle commands and projections while the feature remains
unreleased on the isolated branch:

```text
approval.list
approval.resolve
conversation.start
channel.create
teammate.list
channel.member.add

approval.list_snapshot
approval.delta
teammate.list_snapshot
```

`conversation.start` covers both a normal Ling conversation and a direct conversation
with one existing teammate. The discriminator determines which server-owned creation
path is used:

```ts
type RemoteConversationStartTargetV1 =
  | { readonly kind: "conversation" }
  | { readonly kind: "teammate_direct"; readonly teammateId: string };

interface RemoteConversationStartCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly target: RemoteConversationStartTargetV1;
  readonly body: string;
  readonly issuedAt: string;
  readonly retryUntil: string;
}
```

The first-message transaction creates the thread, user message, bounded reply dispatch
intent, command receipt, and projection-outbox rows atomically. A retry with the same
semantic hash returns the same thread/message result.

`channel.create` is deliberately smaller than the PC request:

```ts
interface RemoteChannelCreateCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly teammateIds: readonly string[];
}
```

It accepts no `cwd`, bound path, provider, default teammate, tools, runtime policy,
permission preset, auto-reply mode, response language, or arbitrary metadata. Names are
trimmed, non-empty, and at most 80 Unicode code points. At most 20 unique active,
non-hidden teammate ids may be supplied. Ling Agent membership and all runtime defaults
come from the daemon's locally bound workspace policy.

`channel.member.add` accepts one allowed channel id and one active catalog teammate id.
It is additive and idempotent. It cannot remove a teammate, replace the full membership
set, select a default teammate, or modify memory/skill/MCP bindings.

## Approval Projection

The Gateway never serializes `ApprovalRequest.payload` directly. It resolves provenance,
classifies eligibility, and emits a remote-specific summary:

```ts
type RemoteApprovalDecisionModeV1 =
  | "allow_once_or_deny"
  | "deny_or_pc"
  | "pc_only";

interface RemoteApprovalSummaryV1 {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly runId?: string;
  readonly actionType: string;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly title: string;
  readonly description: string;
  readonly scopeLines: readonly string[];
  readonly decisionMode: RemoteApprovalDecisionModeV1;
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
}
```

Projection rules:

- resolve `runId`, `taskId`, `workflowStepId`, and source-message ownership to exactly one
  conversation in the paired workspace;
- withhold the request if provenance is missing, ambiguous, or outside the Remote Access
  conversation allowlist;
- remove absolute paths, environment values, secrets, raw command lines, raw MCP
  arguments/results, terminal output, artifact bytes, and provider payloads;
- convert an in-workspace path to a reviewed workspace-relative label only when the
  redactor can prove containment; otherwise show a generic scope label and force PC-only;
- bound title, description, and scope-line lengths and count before allocating Mobile
  state;
- project only pending items by default, with terminal deltas retained long enough for an
  open phone to reconcile its UI.

## Mobile Approval Eligibility

The daemon owns one explicit policy table. Client code cannot upgrade eligibility:

| Request | Mobile action |
| --- | --- |
| Low/medium, safely redacted, conversation-owned | `Allow once` or `Deny`. |
| High, safely redacted, not in a sensitive family | Detail review, required reason, local OS authentication, then `Allow once`; or `Deny`. |
| Critical risk | Approve on PC; Mobile may explicitly deny. |
| `credential_change`, `provider_change`, `deploy`, `external_send`, or other configured sensitive family | Approve on PC regardless of lower supplied risk; Mobile may explicitly deny. |
| Missing/ambiguous provenance or unsafe redaction | Not projected, or `pc_only` if a safe existence-only card is possible. |
| Already resolved, expired, or cancelled | Read-only terminal state; no decision buttons. |

Local Face ID/Touch ID/passcode is a device-side safeguard, not a new server identity and
not a claim that the Gateway can cryptographically attest which biometric was used. The
signed device command remains the remote authorization proof. A rooted/jailbroken phone
is outside the existing threat model.

For `runtime_permission_request`, `Allow once` creates only the existing run- or
continuation-scoped grant. It never changes workspace approval policy or the active run's
tool registry behind the user's back.

## Approval Decision State Machine

```text
daemon creates durable ApprovalRequest(PENDING)
                    |
                    v
Gateway resolves provenance -> redacts -> projects approval.delta
                    |
                    v
Mobile shows inline card / approval inbox
                    |
        +-----------+------------+
        |                        |
        v                        v
   ALLOW_ONCE                  DENY
        |                        |
        +------ signed approval.resolve ------+
                                                |
                                                v
                          shared ApprovalDecisionService
                             UPDATE ... WHERE status='pending'
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
                  CAS wins                          CAS loses
          checkpoint/events/resume sync       return latest terminal state
                     |                                 |
                     +---------------+-----------------+
                                     v
                           PC and Mobile converge
```

The current read-then-unconditional-update approval store is not sufficient for a PC and
phone race. Implementation must change resolution to one atomic compare-and-set. Exactly
one transition from `pending` may win. The loser receives `approval_not_pending` plus the
latest sanitized terminal summary; it never overwrites the first decision.

The Remote Gateway must call the same `ApprovalDecisionService` as the PC route. That
service owns checkpoint synchronization, control-plane events, workflow/media side
effects, runtime waiter wake-up, continuation grants, audit, and projection-outbox writes.
Calling `store.approveApprovalRequest` directly from Remote Gateway is forbidden.

`approval.resolve` contains `commandId`, `workspaceId`, `approvalId`, `decision`, and an
optional/required bounded reason. Its durable semantic hash includes the device epoch,
approval id, decision, normalized reason, and policy version. A network loss after commit
replays the same terminal result instead of applying a second decision.

## Mobile Information Architecture

Approvals and creation extend the existing conversation product without adding a new
primary tab.

```text
Conversation Index
  header: title | approval badge | + | avatar
     |
     +-- approval badge -> Pending Approvals screen
     |
     +-- + -> action sheet
              |-- New conversation
              |-- New channel
              `-- Start teammate direct

Conversation Detail
  transcript
     `-- inline pending approval card -> Approval Detail sheet
  channel header menu
     `-- Add existing teammate -> teammate picker
```

### Approval attention

- A pending approval for the open conversation appears as an inline transcript card with
  Agent, action, risk, expiry, and `Review`.
- A header shield/badge shows the total pending count. It opens a bounded approval list
  grouped by conversation and ordered by expiry/creation time.
- The app may present one non-blocking foreground sheet the first time a new approval
  arrives in the currently open conversation. Dismissing it keeps the inline card and
  badge. It never reopens on every delta or app foreground.
- The detail sheet shows the complete sanitized summary before decision buttons. Critical
  or PC-only items show `Handle on PC` and an optional explicit `Deny` action.
- Decision controls disable immediately after submission, survive navigation, and update
  from the authoritative terminal delta.
- A stale tap shows `This request was already handled on another device` with the final
  state instead of a generic error.

### Creation

- `New conversation` opens an empty native detail draft. Backing out leaves no daemon
  object. The first message runs `conversation.start` and then binds the local draft to
  the returned authoritative conversation id.
- `New channel` opens a sheet with channel name and an optional existing-teammate picker.
  After success it opens the authoritative channel detail. Retrying reuses the same
  `commandId`.
- `Start teammate direct` selects one existing teammate and opens a local direct draft.
  The first message creates or returns the single authoritative direct thread.
- `Add existing teammate` is available only inside an active channel. The picker excludes
  existing members, hidden/disabled teammates, and the protected Ling Agent.
- Offline/reconnecting state preserves local drafts but disables all remote mutations.
  There is no offline creation or approval queue.

## Background and Notification Boundary

Without a Ling-hosted relay/APNs provider, iOS may suspend the app and its WebSocket. The
PC cannot rely on a direct tailnet socket to wake it. Therefore:

- an approval received while the app is connected in foreground may trigger a local,
  content-free notification or foreground attention treatment;
- notification text contains only `Ling needs your approval`, PC name, and count, never
  command, path, message, teammate, or transcript content;
- on foreground, the client reauthenticates and requests a fresh approval snapshot before
  showing current counts;
- guaranteed background push/wake remains a separately hosted or user-provisioned
  notification design and is not claimed by this local-only release.

## Module Boundaries

```text
packages/contracts/src/remote-access.ts
  remote approval/catalog/creation DTOs and capability names

packages/remote-protocol
  strict validators, canonical hashes, result discriminators

packages/core
  atomic approval CAS, generic command receipts, creation transactions/outbox

packages/daemon/src/features/remote-access
  RemoteApprovalFacade, RemoteCreationFacade, projection/redaction/eligibility
            |
            +--> shared ApprovalDecisionService
            +--> bounded conversation/channel/teammate application services

packages/remote-client
  approval/catalog/creation reducers, pending commands, reconnect/resync

apps/mobile/src/features
  approvals/ native cards/list/detail
  conversations/ local drafts, + action sheet, channel/teammate pickers
```

Screens dispatch typed intents. They do not classify approval risk, redact payloads,
choose daemon defaults, mutate broad membership sets, or call PC routes.

## Failure and Recovery Matrix

| Failure | Required handling | User-visible result |
| --- | --- | --- |
| PC approves while Mobile approves/denies | Atomic pending-state CAS; first decision wins; return latest state | `Already handled on PC` plus terminal status. |
| Network drops after Mobile decision commits | Durable receipt and terminal projection replay | No duplicate decision; brief reconnect then final status. |
| Approval expires while detail is open | Expiry transition/delta disables controls | `Request expired`. |
| Approval cannot be safely redacted | Withhold or force PC-only | No sensitive data; `Handle on PC` when safe. |
| Runtime grant is approved but continuation cannot resume | Existing checkpoint records `resume_failed` | Approval result remains visible with a PC follow-up message. |
| Face ID/passcode fails or is cancelled | Do not send the approve command | Detail stays pending; retry remains possible. |
| App is suspended before approval event | Fresh snapshot on foreground | Badge/card appears after reconnect; no false push guarantee. |
| User exits a new-conversation draft before send | Keep/remove device-local draft per normal draft policy | No empty PC conversation. |
| First-send response is lost | Replay `conversation.start` receipt | Same thread/message; no duplicate Agent work. |
| Channel name/member selection is stale | Server revalidates all ids in one transaction | Targeted validation error; no partial channel. |
| Channel is created but projection response is lost | Durable receipt plus outbox replay | Same channel opens after reconnect. |
| Teammate already belongs to the channel | Additive command returns existing membership | Success/no duplicate row. |
| Teammate becomes hidden/disabled before add | Server rejects before mutation | Refresh picker and explain unavailability. |
| Revoke races an approval/create command | Device epoch/policy barrier fences the transaction | Command rejected or completed under one recorded epoch, never both. |

No failure may leave Mobile showing `pending`/`online` indefinitely without a refresh,
terminal state, or clear recovery action.

## Test Coverage

```text
APPROVAL PROJECTION
  |-- allowed-conversation provenance -------- [UNIT + INTEGRATION]
  |-- ambiguous/disallowed provenance withheld [UNIT + INTEGRATION]
  |-- payload/path/secret redaction ------------ [REGRESSION + FUZZ]
  |-- bounded pending snapshot/delta ----------- [INTEGRATION + PERF]
  `-- reconnect/expiry/terminal convergence ---- [CLIENT + E2E]

APPROVAL DECISION
  |-- low/medium allow_once and deny ----------- [UNIT + E2E]
  |-- high reason + local-auth gate ------------ [NATIVE + REAL DEVICE]
  |-- critical/sensitive approve blocked ------- [POLICY + INTEGRATION]
  |-- PC/Mobile race, first CAS wins ------------ [STORE + E2E]
  |-- response loss and same-command replay ----- [STORE + E2E]
  `-- runtime grant/checkpoint/resume outcome ---- [INTEGRATION]

CONVERSATION START
  |-- tap/back without send creates nothing ----- [MOBILE UNIT]
  |-- normal first send creates thread/message --- [STORE + E2E]
  |-- teammate direct creates/returns one thread - [STORE + E2E]
  `-- retry/crash creates no duplicate work ------ [STORE + E2E]

CHANNEL CREATE
  |-- server defaults and Ling membership -------- [STORE + INTEGRATION]
  |-- invalid/duplicate/oversized name/members ---- [UNIT + INTEGRATION]
  |-- atomic channel + memberships + outbox ------- [STORE + CRASH]
  `-- lost response/same-command replay ----------- [E2E]

ADD EXISTING TEAMMATE
  |-- sanitized active catalog ------------------- [UNIT + INTEGRATION]
  |-- additive idempotent membership -------------- [STORE + E2E]
  |-- stale/hidden/disabled/disallowed rejected ---- [INTEGRATION]
  `-- cannot remove/default/configure teammate ----- [CAPABILITY NEGATIVE]

MOBILE UX
  |-- badge, inline card, list, detail, stale state [NATIVE UI]
  |-- + menu, drafts, forms, pickers, offline state [NATIVE UI]
  |-- 320/390 pt, 200% text, VoiceOver, dark mode -- [VISUAL + A11Y]
  `-- background/foreground fresh snapshot -------- [REAL DEVICE]
```

Performance limits:

- at most 100 pending approval summaries per snapshot;
- at most 200 active teammate catalog entries;
- at most 20 teammates in one channel-create command;
- approval provenance is batch-resolved and indexed, never one database query per card;
- projection deltas update by stable id/revision instead of refetching the full workspace;
- rapid duplicate taps coalesce behind one pending `commandId` in the remote client.

## Implementation Slices

1. **A: shared approval correctness**: atomic approval CAS and one reusable
   `ApprovalDecisionService`, with PC regression tests before any remote endpoint.
2. **B: remote contracts and projection**: approval/catalog/creation DTOs, validators,
   capability negotiation, redaction, provenance, and fixtures.
3. **C: daemon commands**: generic durable action receipts, `conversation.start`, bounded
   `channel.create`, and additive `channel.member.add` application services.
4. **D: remote client and native UI**: reducers, approval attention surfaces, `+` menu,
   local drafts, forms, pickers, local-auth gate, and accessibility.
5. **E: cross-device acceptance**: PC/Mobile race, response loss, reconnect, background/
   foreground, revoke race, and real-iPhone Release validation.

Slices A and the Mobile-only fixture work may begin independently. B locks shared
contracts before C/D integrate. E starts only after A-D converge. `packages/contracts`,
`packages/core`, and `pnpm-lock.yaml` retain one owner per integration window.

## NOT in Scope

- Creating, cloning, editing, disabling, deleting, or configuring a new AI teammate.
- Provider/model/runner/tool/skill/MCP/memory/permission settings from Mobile.
- `Always allow`, approval-policy edits, workspace-wide grants, or arbitrary path grants.
- Mobile approval of critical or configured sensitive action families.
- Run cancellation, interruption, terminal control, Computer Use, deploy control, or
  external-send composition.
- Channel rename/archive/delete, teammate removal/default selection, broad membership
  replacement, channel runtime settings, or workspace binding/path selection.
- Offline mutation queues or a claim of reliable background push without an APNs-capable
  service.
- Multiple phones, multiple PCs, account/cloud administration, or public port forwarding.

## Decision Verdict

The design is complete enough to implement in phased slices. The load-bearing rules are:
one durable approval authority, atomic first-decision-wins resolution, server-owned
eligibility/redaction, `allow_once` only, PC-only critical approval, atomic first-message
conversation creation, server-default channel creation, and additive existing-teammate
membership only.

NO UNRESOLVED DESIGN DECISIONS
