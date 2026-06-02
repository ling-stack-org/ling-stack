# Channel Workspace v1.18 Unified Composer Actions

## Status

Implemented in the Web client only. This slice simplifies the channel Chat composer
without adding daemon contracts.

## Intent

v1.18 removes the composer `Discuss` / `Task` mode switch. A channel message and a task
are still different durable objects, but the user should not have to choose a mode
before typing. The composer now behaves as one input surface with explicit actions:

- `Send` stores the current input as a normal channel discussion message.
- `Task` creates a durable task from the same input.

This keeps ordinary chat lightweight while preserving the audit boundary for runnable
work.

## Interaction Model

The Chat composer shows one textarea, inline `@` teammate suggestions, drag/drop or
paste file attachment handling, and automatic safe URL preview detection. The top
segmented mode control and task title input are removed.

When the user clicks `Task`, the Web client creates a task from the current textarea
content. The task title is derived from the prompt. The assignee is the first selected
AI teammate mention, falling back to the channel default teammate when no mention is
selected. Ready attachment filenames and ready link metadata may be appended as plain
prompt context, but file or webpage body ingestion remains out of scope.

After successful task creation, the client opens the `Tasks` tab so the created task can
be reviewed or run. Normal `Send` still stays in Chat and can request an AI reply only
when an AI teammate is explicitly mentioned.

## Non-Goals

- No automatic conversion of every discussion into a task.
- No combined backend object for messages and tasks.
- No task attachment id contract or file/webpage body ingestion.
- No new provider preflight, approval, or run behavior.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel activity supports mentions, messages, files, links, and task creation|language switcher toggles Chinese and English UI labels"
corepack pnpm --filter @ling-stack/web build
git diff --check
```
