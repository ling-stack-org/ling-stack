# Channel Workspace v1.4 Files and Run Artifacts Plan

## Status

Implemented implementation slice after v1.3 chat experience polish.

v1.4 turns the channel `Files` tab into the channel working output center. The tab
already shows user-uploaded attachments and shared links. This slice adds run artifacts,
summary paths, and event log paths for work that belongs to the selected channel.

## Goals

- Show run artifacts in the channel without forcing users to open run history first.
- Keep user uploads, shared links, and run outputs visually separate.
- Make summary and event log paths visible for channel runs.
- Reuse existing run artifact APIs and content-serving safeguards.
- Keep artifact content out of AI context unless a later explicit ingestion slice adds
  that behavior.

## Non-Goals

- No new daemon routes, contracts, or SQLite schema.
- No automatic multi-agent loop.
- No file or webpage body ingestion.
- No notification persistence.
- No custom workflow builder.
- No inline artifact body rendering inside the channel.

## Product Behavior

The `Files` tab has three sections:

1. `Attachments`: channel-scoped user uploads under `.ling-stack/attachments`.
2. `Shared links`: channel link-preview metadata.
3. `Run artifacts`: run-scoped outputs derived from selected-channel work.

Run artifacts are derived in Web:

```text
selected channel
-> tasks where task.channelId === selectedChannel.id
-> runs where run.channelId === selectedChannel.id or run.taskId belongs to a channel task
-> for each run, list artifacts through /runs/:runId/artifacts
-> show summaryPath and eventLogPath when present
```

Artifacts remain run-scoped output records. The channel only aggregates and presents
them as working files. Opening or downloading artifact content must continue to use the
existing artifact content endpoint.

## Implementation Plan

### 1. Web Data Flow

- Add selected-channel artifact loading in the channel workspace data path.
- Derive relevant runs from `run.channelId` first, then from selected-channel tasks.
- Cache artifact lists by run id for the current page session.
- Refresh artifact lists when the selected channel changes, when run/task data changes,
  or when the user opens the `Files` tab.
- Keep artifact loading errors scoped to the `Run artifacts` section.

### 2. Files Tab UI

- Preserve existing attachments and shared links sections.
- Add a `Run artifacts` section that shows:
  - task title when available,
  - run id,
  - run status,
  - summary path,
  - event log path,
  - artifact title, type, size, and created time.
- Reuse the existing artifact row/open/download patterns used by run history.
- Empty state: explain that run artifacts appear after channel tasks produce outputs.
- Loading/error states must not block attachments or shared links.
- The Files tab should fill the available channel tab body. Do not cap the content to a
  half-screen scroll area when the surrounding panel has more vertical space; let run
  artifact groups expand as the main working-files section.

### 3. Safety Boundaries

- Do not fetch artifact content for preview.
- Do not read summary or event log file contents in the channel.
- Do not attach artifacts to AI prompts.
- Do not reinterpret user uploads as run artifacts.
- Keep cross-channel isolation: artifacts from unrelated channels must not appear.

### 4. Documentation

- Update `docs/design/channel-workspace.md` tracker after implementation.
- `docs/daemon-api.md` does not need a route change unless implementation discovers a
  documented mismatch in existing artifact endpoints.

## Test Plan

- Web e2e: `Files` shows artifacts for a run linked to the selected channel.
- Web e2e: artifacts from another channel do not appear.
- Web e2e: summary and event log paths are visible for channel runs.
- Web e2e: artifact open/download links point to `/artifacts/:id/content?cwd=...`.
- Web e2e: channel attachments and shared links still render in separate sections.
- Regression:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

## Acceptance Criteria

- The `Files` tab can be used as a channel working-files view.
- Run artifacts are visible only when they belong to the selected channel.
- Summary and event log paths are visible without reading their contents.
- Existing Activity chat and Tasks detail layout do not regress.
- No backend contract or storage changes are introduced.

## Implementation Notes

- Web derives selected-channel runs from `run.channelId` and channel task ownership.
- Web loads artifacts with existing `/runs/:runId/artifacts` and renders content links
  through existing artifact content URLs.
- Channel attachments, shared links, and run artifacts remain separate sections.
- The implementation does not fetch artifact bodies, parse files, or send artifact
  content to AI context.
