# Conversation Error Ownership And Feedback Isolation

Status: implemented and locally verified on `gansx/conversation-error-ownership-hardening`.
Scope: normal conversation, channel root, channel branch, channel topic reply,
and teammate private chat. Theme/background work is outside this document and
must not be included in the implementation PR.

## Problem

The previous fix stopped one provider error from being copied into a second
generic AppShell error owner when a failed assistant reply was already
persisted. It did not establish a complete ownership contract:

- channel feedback was keyed by `surface + channelId`, so root, branch, topic,
  and different workspaces could overwrite or clear one another;
- topic loading and topic sending shared one `error` state, so a load refresh
  could erase a send failure and a send failure could be rendered as a generic
  channel composer failure;
- channel composer local state and the global channel feedback store could both
  present the same send failure;
- callers that invoke the channel send action directly could treat a terminal
  stream error as success because the error was returned as data and not
  checked by the caller.

## Ownership contract

Every stream error is classified before it is projected into UI state.

```text
workspace cwd + surface + channel + branch/topic thread + operation
                         -> one error owner
```

The owner rules are:

| Situation | Sole owner | Presentation |
| --- | --- | --- |
| Failed/blocked assistant reply has a persisted reply item | assistant reply | The failed message/timeline row |
| Channel root or branch transport/terminal error without a reply item | channel composer for that exact cwd/channel/branch scope | Composer inline feedback or retry state |
| Topic transport/terminal error without a reply item | topic reply controller for that exact cwd/channel/topic scope | Topic composer alert |
| Normal conversation stream error without a reply item | normal conversation error store | Normal conversation surface |
| Teammate private stream error without a reply item | teammate workspace request owner | Private chat surface |

No stream error is written to both a surface-level feedback store and a local
composer owner. Non-stream mutations may continue to use the generic channel
feedback controller, but their identity is also workspace-scoped.

## Scope keys and stale-result protection

Channel feedback entries include `workspaceCwd` and are queried with the active
workspace. Composer identities include:

```text
[workspaceCwd, channelId, branchRootThreadId || "root"]
```

Topic state uses:

```text
[workspaceCwd, channelId, topicThreadId]
```

The topic controller keeps `loadError` and `sendError` independently. A load
request may clear or replace only `loadError`; sending may clear or replace only
`sendError`. Request epochs prevent an old workspace/topic request from
publishing into a newly selected scope.

## Stream result protocol

The channel send action returns a terminal `errorOwner` when the daemon emits a
terminal error after the stream has been parsed. `assistant-reply` means the
feed already contains the authoritative failed reply and callers must not show
another error. `channel-composer` and `topic-thread` tell their respective
local controller to render the failure. Transport exceptions still reject the
promise so retry/recovery logic remains the single caller-owned path.

Direct channel actions must inspect this result before showing success. A failed
assistant reply is never reported as a successful goal continuation or plan
action, while its failure remains visible in the feed.

## Implementation steps

1. Extend the shared stream classification helper with channel-specific owners
   while preserving normal/private behavior.
2. Make the channel feedback store workspace-aware and make the workspace view
   query the active scope.
3. Remove channel stream-error writes from the generic feedback store; return a
   typed terminal owner instead.
4. Split topic `loadError` and `sendError`, including composer snapshots and
   panel rendering.
5. Update channel composer, topic, goal, and proposed-plan callers to honor the
   typed result and suppress duplicate success/error feedback.
6. Add regression coverage for assistant-reply ownership, root/branch/topic
   isolation, workspace isolation, load/send independence, and direct-action
   success suppression.

## Verification gates

- Typecheck and targeted unit tests for scope keys and stream classification.
- Targeted Playwright coverage for channel root, branch, topic, normal, and
  teammate private failure flows.
- Full web CI test command when dependencies are available.
- `git diff --check` and a staged diff audit confirming no theme/background
  files or theme design documents are in the PR.

## Implementation result

The plan is implemented across the channel action boundary, workspace feedback
store, channel composer, topic reply controller, and AppShell wiring. Channel
stream errors now return a typed owner instead of being written into a generic
feedback store. Every channel feedback read, write, and clear operation carries
the trimmed workspace cwd; composer identities also carry the selected branch
root. Topic snapshots retain separate load and send errors and use the shared
topic scope key. Goal continuation and proposed-plan callers inspect terminal
send results before showing success.

## Local verification evidence

The final source snapshot passed:

- workspace dependency builds for localization, UI React, conversation UI,
  API client, core, and daemon;
- `corepack pnpm --filter @ling-stack/web typecheck:ci`;
- `corepack pnpm --filter @ling-stack/web test:ci` (598 passed);
- `corepack pnpm --filter @ling-stack/web lint`;
- `corepack pnpm --filter @ling-stack/web build:ci`;
- Chromium regression `ui2-channel-error-ownership.spec.ts` (4 passed),
  including a failed post-stream refresh that cannot replace the persisted
  assistant-reply owner;
- topic send/reopen recovery coverage (5 passed), goal lifecycle coverage (1
  passed), and proposed-plan failed-action coverage (1 passed).

The PR must contain this document and the error-ownership implementation only.
Theme/background source and theme design documents remain outside the branch.
