# Runtime Approval Composer Gate Detailed Design

Status: active contract. The earlier global blocking Dialog is superseded by the
session-owned Composer gate below.

## Summary

Runtime approval is a blocking decision for one conversation, not for the whole Ling
application. Channel, normal conversation, and teammate private chat share one approval
gate component and one ordering rule, but each surface renders only approvals owned by
its current session.

When a background session needs approval, its Sidebar row shows a visible green
`Waiting for approval` label. The user can keep working elsewhere, switch to that row,
and decide there. Inside the owning session, the approval gate replaces the Composer
until the user allows or denies the current request. It never mounts a page-level modal,
backdrop, focus trap, or global keyboard lock.

## Product Model

```text
runner persists pending approval
-> daemon keeps run waiting_for_approval
-> AppShell projects approval ownership to Sidebar objects
-> background owner shows Waiting for approval
-> selected owner renders RuntimeApprovalComposerGate in the Composer slot
-> user allows or denies one request
-> surface refreshes its authoritative runtime snapshot
-> next owned approval appears, or the Composer returns
```

The approval record, policy, audit history, expiry, and resume semantics remain owned by
the daemon. Web only chooses where the current decision is presented.

## Ownership

Approval ownership must be derived by the shared runtime-approval owner resolver, in this
order:

1. `approval.channelId` owns the approval directly and wins over conflicting linked data.
2. `approval.runId -> RunSession -> WorkUnit` resolves a channel, teammate-private, or
   normal conversation owner. A channel Run belongs to its channel. For non-channel Runs,
   `WorkUnit.kind=conversation_run` belongs to the normal conversation and
   `WorkUnit.kind=teammate_direct_reply` belongs to the teammate-private conversation.
   A teammate-private Run's Ling execution `threadId` is not the visible direct-message
   thread ID. Resolve the visible owner through the Work Unit source message, linked reply,
   or a direct message carrying the same `linkedRunId`; all available links must identify
   one teammate and one direct-message thread.
   `teammateId` alone is not a surface discriminator because normal Ling Agent Runs also
   carry it. Legacy Runs without a Work Unit may fall back to the existing thread signals.
3. `approval.taskId -> Task.channelId` and
   `approval.workflowStepId -> ChannelWorkflowStep.channelId` resolve channel ownership.
4. Compatibility payload fields `runId` and `requestedByRunId` may resolve through the
   same Run rules only when no durable direct link resolved an owner.

An approval whose referenced Work Unit is not yet loaded, or which otherwise has no
provable owner, remains available in the Approval Inbox. Web must not guess the current
session, the foreground session, the newest session, or another private chat for the same
teammate. Conflicting source-message, linked-reply, or linked-Run thread evidence also fails
closed to the Approval Inbox.

Sidebar waiting state, Composer gating, and compact transcript suppression must consume
this same resolved owner. A global or previously selected `activeRunId` is not ownership
evidence and must never attach an approval to the foreground session.

## Surface States

### Background Session

- Show `Waiting for approval` in green on the corresponding expanded Sidebar row.
- Keep the complete row clickable so the user can navigate to it.
- Do not open an overlay, steal focus, switch sessions, or disable another Composer.
- In the collapsed rail, aggregate the existing section status rather than squeezing
  text into the icon-only rail.

### Selected Session With Pending Approval

- Replace the Composer with `RuntimeApprovalComposerGate` in the same stable Composer
  slot.
- The feed, header, Sidebar, right dock, terminal, and other sessions remain usable.
- The selected session cannot send another message until its approval queue is empty.
- The gate shows one request at a time using the existing risk/time ordering from
  `buildInlineApprovalViews`.
- Resolving one request advances to the next pending request without briefly revealing
  the Composer.

### Selected Session Without Pending Approval

- Render the normal Composer with its draft, attachments, permission preset, model, and
  focus state intact.
- Removing or resolving the final approval restores the Composer in the same slot.

## Approval Gate Content

The default gate contains only:

- the fixed decision title `Allow this action?`;
- one localized action sentence, for example `Run command: pnpm test` or
  `Modify file: src/App.tsx`;
- one-line mutation feedback when a decision fails;
- `Deny` and `Allow once` actions.

For an eligible Bash approval, `Allow once` becomes a split button. Its primary action
still approves only the current request. The adjacent arrow opens a compact menu with
`Allow once` and `Allow similar commands`. The second decision persists only the
daemon-proposed command-prefix rule for the current workspace. It does not grant Bash as
a whole, does not apply to another workspace, and does not add a second confirmation
Dialog.

The arrow is absent unless the approval carries a daemon-validated
`proposedCommandRule` and lists `approve_command_rule` in `availableDecisions`. Web must
never infer a rule from the displayed command. File, MCP, network, deploy, credential,
runtime-permission, and task-proposal decisions keep the ordinary two-button layout.

For Bash, `proposedCommandRule` is a Host fact, not a model fact. The runner may attach a
`prefix_rule` hint, but the Daemon reparses the actual command into bounded literal argv
segments, rejects expansion/redirection/pipelines/unsupported operators, and verifies that
the proposed prefix covers every segment that would otherwise require a reusable rule.
The Host may derive a narrower known-safe prefix when the hint is missing or invalid. Shell
wrappers such as `bash -lc` are never persisted; only a validated inner command such as
`cargo build` may become the rule. If one reusable prefix cannot safely account for the
compound command, the arrow stays absent and the user can only allow once or deny.

The gate does not show risk badges, Run IDs, workspace absolute paths, approval titles,
raw payloads, permission deltas, queue counts, decision reasons, technical details, or an
approve-all action. Full payload and decision history stay in Run detail, Approval Inbox,
and audit surfaces.

## Shared Decision-Gate Shell

`ConversationDecisionGate` owns only the stable Composer-slot layout: decision title,
one human-readable sentence, one optional mutation-error line, and deny/allow buttons.
It has no approval DTO, proposal DTO, navigation, daemon request, or audit knowledge.

`RuntimeApprovalComposerGate` adapts an ordered runtime approval into this shell.
`ChannelExecutionProposalComposerGate` adapts one actionable channel proposal into the
same shell. The task sentence names the task, assigned Agent, and localized permission
categories without rendering a table or technical tool identifiers. Runtime approval
always has priority when both decisions belong to the selected channel.

Neither adapter uses a Dialog, portal, backdrop, close button, Escape dismissal, reason
field, technical disclosure, or secondary editing path. A task proposal in a background
channel never gates the selected channel.

The first action target may use monospace presentation when it is a command, relative
file path, or tool name. The UI must use the compact target projection and must not reveal
a workspace prefix already established by the session.

## Interaction

- `Deny` receives initial keyboard focus when the gate first appears.
- `Escape` does not resolve or dismiss the approval.
- Sidebar navigation remains available because the gate is not a modal.
- While a decision request is in flight, both decision buttons are disabled and the
  selected action shows progress.
- The split menu supports Arrow Up/Down, Enter, Escape, outside-click dismissal, visible
  focus, and focus return to its arrow. Opening or closing it never resolves an approval.
- Choosing `Allow similar commands` resolves immediately. A save or fingerprint failure
  keeps the same approval visible and exposes the existing one-line retry state.
- A mutation failure keeps the same request visible and changes only the attempted action
  to `Retry`.
- Returning to a session with a still-pending approval restores the gate, not the
  Composer.
- Focus returns to the Composer only after the owning queue becomes empty.

## Transcript Projection

The owning Run may keep one compact, non-interactive `Waiting for approval` marker in the
transcript. While the gate owns a pending approval, the transcript must not render a
second approval card, decision buttons, raw permission labels, or expandable technical
evidence for that same request.

Resolved approval history remains immutable and compact. The gate is never persisted as
message content.

## Full Access Boundary

Full access confirmation is a separate, explicit permission-change Dialog. Selecting
`Full access` opens that Dialog before the preset changes. The Dialog explains files and
folders, terminal commands, Internet and connected apps, and the risk of sensitive data
exposure or prompt injection. Cancel leaves the previous preset unchanged; Confirm records
the existing conversation-scoped confirmation and then activates full access.

Full access does not use `RuntimeApprovalComposerGate`. Agent/Skill mandatory approval,
external send, deploy, credential mutation, and other independent boundaries may still
create runtime approvals after full access is confirmed.

## Interfaces

```ts
interface RuntimeApprovalComposerGateProps {
  readonly approvals: readonly InlineApprovalView[];
  readonly approvalErrors: Readonly<Record<string, string>>;
  readonly resolvingApprovals: Readonly<Record<string,
    "approve_once" | "approve_command_rule" | "deny">>;
  readonly onResolve: (
    approvalId: string,
    decision: "approve_once" | "approve_command_rule" | "deny",
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => void;
}
```

The component consumes view data and callbacks only. It does not fetch, mutate global
navigation state, inspect another session, derive command rules, or own approval policy.
The command-rule DTO, persistence, matching, and audit authority remain in Core and the
Daemon.

## Placement

```text
apps/web/src/features/approvals/
  ConversationDecisionGate.tsx
  RuntimeApprovalComposerGate.tsx

channel
  WorkspaceClientView -> runtime approval gate -> task proposal gate -> normal Composer

normal conversation
  ConversationHome -> NormalConversationPage Composer slot

private chat
  TeammateWorkspace -> TeammatePrivateChatSurface Composer slot

sidebar
  AppShell owner projections -> SidebarNavigation -> SidebarObjectRow
```

## Accessibility

- Gate root is a labelled region, not a Dialog.
- Decision feedback uses a polite live region.
- Buttons retain visible focus and minimum target dimensions.
- `Waiting for approval` is real text in the expanded Sidebar and has a status role.
- Color is supplementary; screen-reader labels include the approval count when known.
- Reduced motion does not change ownership or decision behavior.

## Tests

### Projection

- channel, normal conversation, and private chat approvals map to the correct Sidebar row;
- an approval owned by one channel never gates another channel even when a stale global
  Run selection still points at the owner Run;
- explicit channel ownership wins over conflicting Run, task, workflow, or payload links;
- a pending approval outranks running, failed, paused, and unread presentation;
- approvals with no provable owner do not attach to the selected session;
- multiple approvals for one owner produce one Sidebar label with an accessible count.

### Interaction

- a background approval does not open an overlay or disable the active Composer;
- selecting the owner replaces only that Composer;
- allow, deny, retry, expiry, stale removal, and ordered multi-item progression work;
- primary `Allow once` never persists a command rule;
- eligible Bash approvals expose `Allow similar commands`, persist the proposed prefix,
  and stop asking for matching commands in the same workspace;
- ineligible or stale proposals render no arrow and cannot be submitted as a rule;
- another Sidebar row remains clickable while the gate is visible;
- the final decision restores the preserved Composer draft and focus.
- an actionable task proposal uses the same shell only in its owning channel;
- its compact feed summary reselects the proposal gate without opening a modal;
- denying or allowing the last actionable proposal restores the channel Composer.

### Full Access

- selecting full access opens the dedicated confirmation Dialog before changing the
  preset;
- Cancel preserves the previous preset, draft, and focus;
- Confirm stores the existing scoped evidence and changes the preset;
- normal conversation, channel, and private chat share the same confirmation content and
  behavior.

### Visual

- expanded Sidebar shows a clear green `Waiting for approval` label;
- the Composer gate is contained at `1280x800` and `1440x960` in light and dark themes;
- the gate shrink-wraps its decision content with equal inline insets and no reserved
  transcript, footer, or empty-message height below the actions;
- an eligible Bash split button renders one contiguous primary action plus a fixed arrow
  segment; labels remain centered and neither segment wraps, overlaps, or separates;
- no horizontal overflow, page-level backdrop, feed overlap, or Composer flash appears.

## Non-Goals

- No global notification center or OS push in this slice.
- No global Bash allow, session-wide approval, or bulk approval.
- No persistent rule for file, MCP, network, deploy, credential, runtime-permission, or
  task-proposal decisions.
- No external-action review redesign.
- No task proposal editor or technical-detail surface in the Composer decision path.
- No mobile acceptance target.
