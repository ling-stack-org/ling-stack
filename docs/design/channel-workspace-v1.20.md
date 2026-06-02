# Channel Workspace v1.20 Chat Composer Task Action Removal

## Status

Implemented in the Web client only. This slice removes the Chat composer `Task` action
after v1.19 introduced user-confirmed execution proposals.

## Intent

The Chat composer should feel like plain channel discussion. After the multi-agent studio
proposal flow exists, a direct `Task` button under every chat input duplicates the more
intentional path:

```text
discussion -> coordinator reply -> execution proposal -> user confirms -> task/run
```

Removing the composer `Task` button keeps ordinary chat quieter and makes execution
start only through an explicit proposal card or the dedicated Tasks panel.

## Interaction Model

The Chat composer keeps:

- one textarea,
- inline `@` teammate suggestions,
- file drop / paste / attachment handling,
- automatic safe URL preview detection,
- `Send` for normal channel discussion.

The Chat composer no longer creates tasks directly.

Manual task creation remains available from the `Tasks` panel through `New task`.
Proposal-driven task creation remains available from inline execution proposal cards.

## Boundary

- Chat messages remain durable channel messages.
- Agents may propose executable work, but users still confirm before task/run creation.
- Manual tasks are still durable tasks, but the entry point is the task surface instead
  of the chat composer.
- Attachment and link previews in chat are message context only. They are not silently
  converted into task inputs.

## Non-Goals

- No removal of the `Tasks` tab or manual `New task` flow.
- No removal of proposal cards.
- No automatic conversion of every discussion message into a proposal.
- No change to task/run provider preflight, approval policy, or resource leases.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel activity supports mentions, messages, files, links, and task creation"
corepack pnpm --filter @ling-stack/web build
git diff --check
```
