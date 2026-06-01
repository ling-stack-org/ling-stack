# External Work Status Surface

## Summary

External Work orchestration v1 is feature-complete, and UX.1 closes the main
discoverability gap: operators can now see whether the selected channel is connected to
a GitHub repository or Linear project from Web Settings and the CLI.

This document defines the shipped status and setup surface: a local-only status API,
explicit Keychain token setup endpoints, an API client and CLI wrapper, and a Web
Settings panel that shows the configured source, workflow health, token status,
scheduler status, local record counts, and safe next actions.

The goal is not to create a separate GitHub product area. The primary entry is the
existing Settings experience, with a compact read-only summary in the Workspace
Inspector.

## Implementation Status

UX.1 is shipped:

- `GET /external-work/status` returns local workflow, source, secret-status, record-count,
  and background scheduler state.
- `LingDaemonClient.getExternalWorkStatus()` and
  `ling-stack external-work status --channel ...` expose the same response.
- Web Settings shows the External Work panel and explicit Poll once, Reconcile, Start
  background, Stop background, View records, and View CI triage controls.
- Workspace Inspector shows the compact status summary and links users back to Settings.

UX.2 is shipped:

- Web Settings can save a GitHub or Linear token to macOS Keychain for a valid
  `WORKFLOW.md`.
- The daemon writes only `source.secretRef: keychain:...` to `WORKFLOW.md`; it never
  writes the token value to workflow files, SQLite, artifacts, or logs.
- Web Settings can remove a `keychain:` external token while leaving the workflow ref in
  place so the missing-token state remains explainable.
- API client methods expose `configureExternalWorkSecret()` and
  `deleteExternalWorkSecret()` for trusted UI surfaces.

The shipped surface remains local-first: loading Settings does not call GitHub or
Linear, run hooks, start background polling, start a runner, create actions, or execute
approved actions.

## Problem

The current v1 surfaces are powerful but scattered:

- `WORKFLOW.md` is the repository-owned configuration contract.
- CLI and daemon APIs can import, poll, reconcile, start background polling, list
  external work, triage CI, propose actions, and execute approved actions.
- Web Inbox shows approval cards and external action audit details.
- Web Workspace and Inspector show CI triage records and linked artifacts.

What is missing is a single local view that answers:

- Is this channel configured for external work?
- Which repository or Linear project is it pointing at?
- Is `WORKFLOW.md` present and valid?
- Is the required token configured without exposing the token value?
- Is GitHub background polling registered and running?
- How many local external-work records, CI triage records, and pending actions exist?
- What should I do next: create `WORKFLOW.md`, poll once, reconcile, start background,
  stop background, or inspect records?

Without this surface, a user can correctly feel that the feature is finished but not
find where to set it up or verify that it is attached to a real source.

## Goals

- Make external-work setup discoverable from Web Settings.
- Show source connection status without making implicit external API calls.
- Validate local `WORKFLOW.md` presence and parse health.
- Show token readiness as status-only metadata.
- Expose explicit safe actions for poll, reconcile, and background start/stop.
- Keep existing Inbox and Workspace audit surfaces as the places for approvals, actions,
  CI triage, artifacts, tasks, and runs.
- Preserve all v1 safety boundaries: no automatic runner start, no automatic GitHub or
  Linear mutation, and no webhook ingestion.

## Non-Goals

- No new GitHub mutation action.
- No Linear mutation action.
- No webhook receiver.
- No hidden scheduler auto-start.
- No token storage in SQLite, artifacts, logs, browser storage, or CLI output.
- No edit-and-approve workflow.
- No replacement for `WORKFLOW.md` as the repository-owned contract.
- No automatic local runner start from the Settings panel.

## Current Configuration Model

`WORKFLOW.md` remains the source of truth for external-work configuration. The Settings
surface should discover and explain the current state; it should not introduce a second
configuration store.

Minimum GitHub workflow fields:

```yaml
source:
  kind: github
  repository: owner/repo
  secretRef: keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN
events:
  - pull_request.opened
  - issues.opened
```

Minimum Linear workflow fields:

```yaml
source:
  kind: linear
  projectSlug: ling-stack
  secretRef: keychain:LING_STACK_LINEAR_LING_STACK_TOKEN
events:
  - issue.created
```

`env:GITHUB_TOKEN` and `env:LINEAR_TOKEN` remain supported for headless development.
The Web setup path uses `keychain:` refs only because browser-driven setup must not ask
users to export environment variables or restart the daemon.

If the workflow is absent or invalid, Web makes that obvious and provides the
expected file location under the channel bound path. The first implementation can show
the expected path and examples; it does not need an in-browser workflow editor.

## Daemon API

The local-only status endpoint is:

```http
GET /external-work/status?cwd=/path/to/project&channelId=channel_...
```

Optional query:

- `workflowPath`: defaults to `WORKFLOW.md` under the channel bound path. If supplied,
  it must resolve inside the channel bound path.

The endpoint does not call GitHub, Linear, hooks, runners, or external mutation APIs.
It only reads the local channel, workflow file, SQLite state, background scheduler
registry, and secret status metadata.

Response shape:

```json
{
  "cwd": "/path/to/project",
  "channel": {
    "id": "channel_...",
    "name": "Engineering",
    "boundPath": "/path/to/project"
  },
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "error": null,
    "sourceKind": "github",
    "repository": "owner/repo",
    "projectSlug": null,
    "events": ["pull_request.opened", "issues.opened"],
    "secretRef": "env:GITHUB_TOKEN"
  },
  "secret": {
    "ref": "env:GITHUB_TOKEN",
    "purpose": "github_token",
    "status": "configured"
  },
  "records": {
    "externalWork": {
      "total": 3,
      "ready": 2,
      "blocked": 1,
      "retryWait": 0,
      "terminal": 0
    },
    "ciTriage": {
      "total": 1,
      "triaged": 0,
      "taskCreated": 1,
      "runRequested": 0,
      "failed": 0
    },
    "actions": {
      "waitingForApproval": 1,
      "approved": 0,
      "failed": 0,
      "succeeded": 0
    }
  },
  "background": {
    "supported": true,
    "running": true,
    "schedulerId": "external_work_background_...",
    "status": "running",
    "lastTickAt": "2026-06-01T00:00:00.000Z",
    "lastError": null
  },
  "lastErrors": {
    "poll": null,
    "reconcile": null,
    "background": null
  }
}
```

Status enums:

- `workflow.exists`: file presence only.
- `workflow.valid`: parser and local validation result.
- `secret.status`: `configured`, `missing`, `unavailable`, or `not_required`.
- `background.status`: `not_configured`, `running`, `stopped`, `failed`, or
  `unsupported`.

For Linear, `background.supported` is `false` until Linear background polling is
designed and implemented. Linear status still shows workflow health, token status,
and local record counts.

The local Keychain mutation endpoints are:

```http
POST /external-work/secrets/configure?cwd=/path/to/project
POST /external-work/secrets/delete?cwd=/path/to/project
```

`configure` requires `channelId` and `token`, validates the channel-bound workflow, saves
the token under a `keychain:` ref, and updates `source.secretRef` unless
`updateWorkflow: false` is supplied. If no ref is supplied, the daemon derives one from
the source target:

- GitHub: `keychain:LING_STACK_GITHUB_<OWNER>_<REPO>_TOKEN`
- Linear: `keychain:LING_STACK_LINEAR_<PROJECT>_TOKEN`

`delete` removes only `keychain:` refs. It does not edit `WORKFLOW.md`, which lets the
status panel show the now-missing configured ref.

## Web Surface

### Primary Entry: Settings

The External Work section lives on the existing Settings page. It is scoped to the
selected workspace and channel, because the configuration is channel-bound.

Required states:

- No channel selected: ask the user to select or create a channel.
- Channel has no bound path: explain that external work needs a channel bound path.
- Missing `WORKFLOW.md`: show the expected path and links to examples.
- Invalid `WORKFLOW.md`: show a readable parser or validation error.
- GitHub configured: show repository, events, token status, record counts, and actions.
- Linear configured: show project slug, events, token status, record counts, and actions.
- Token missing: show status and required `secretRef`, but never the token value.
- Background running: show scheduler id, last tick time, and Stop background.
- Background stopped or absent: show Start background for GitHub workflows only.

Primary controls:

- `Create WORKFLOW.md` / `Repair WORKFLOW.md`: for missing or invalid workflows, writes
  a minimal local channel-bound `WORKFLOW.md` from a GitHub URL or `owner/repo`, or a
  Linear project slug. This is an explicit local file write and does not call external
  providers.
- `Save GitHub token` / `Save Linear token`: sends the pasted token once to the daemon,
  which stores it in Keychain and updates `WORKFLOW.md` with a `keychain:` ref.
- `Remove token`: deletes the configured `keychain:` ref from Keychain.
- `Poll once`: calls the existing source-specific poll endpoint for valid GitHub or
  Linear workflows.
- `Reconcile`: calls the existing local reconcile endpoint.
- `Start background`: calls GitHub background start only for valid GitHub workflows.
- `Stop background`: stops the registered GitHub background scheduler.
- `View records`: navigates to the existing Workspace or list surface for external work.
- `View CI triage`: navigates to the existing Workspace or Inspector CI triage surface.

The panel should not run any operation on load. Status refresh is a local read. Workflow
creation/repair, poll, reconcile, start, stop, token save, and token removal must be
explicit button clicks.

### Secondary Entry: Workspace Inspector

The Workspace Inspector shows a compact read-only summary:

- source kind
- repository or project slug
- workflow validity
- token status
- background status
- external-work count
- CI triage count
- pending external action count

This summary links back to Settings for setup and control actions. The Inspector remains
an audit and navigation surface, not a second configuration area.

## API Client And CLI

API client helper:

```ts
getExternalWorkStatus(
  cwd: string,
  input: { channelId: string; workflowPath?: string },
): Promise<ExternalWorkStatusResponse>

configureExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretConfigureRequest,
): Promise<ExternalWorkSecretMutationResponse>

deleteExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretDeleteRequest,
): Promise<ExternalWorkSecretMutationResponse>
```

CLI command:

```bash
ling-stack external-work status \
  --channel channel_... \
  [--workflow-path WORKFLOW.md]
```

CLI human output should print:

- channel id/name/bound path
- workflow path, existence, and validity
- source kind and target
- token status only
- external work, CI triage, and action counts
- background scheduler status
- suggested next command

`--json` should print the daemon response unchanged.

## Safety Boundary

The status surface is intentionally local-first:

- Loading the Settings panel does not call GitHub or Linear.
- Loading the Settings panel does not run hooks.
- Loading the Settings panel does not start background polling.
- Loading the Settings panel does not start a teammate runner.
- Loading the Settings panel does not create actions or approvals.
- Loading the Settings panel does not execute approved actions.
- Token values are never returned, rendered, logged, or written to artifacts.
- Token values entered in Web are sent only in the explicit `configure` request and the
  password input is cleared after submit.

The only mutating controls in this surface are local Keychain setup/removal, local
scheduler operations, and existing read-only poll/reconcile operations. GitHub mutations
remain limited to the existing Inbox approval plus explicit `Execute action` flow.

## Implementation Slices

### Slice 1: Local Status API

- Add contracts for `ExternalWorkStatusResponse`.
- Implement `GET /external-work/status`.
- Reuse the existing workflow parser, channel bound-path validation, secret resolver
  status checks, external-work list/count queries, CI triage count queries, action count
  queries, and background scheduler registry.
- Add API client and CLI command.

### Slice 2: Web Settings Panel

- Add the External Work Settings section.
- Fetch status for the selected channel.
- Render missing, invalid, GitHub, Linear, and token-missing states.
- Wire Poll once, Reconcile, Start background, Stop background, View records, and View
  CI triage buttons to existing endpoints and routes.
- Refresh status after each explicit operation.

### Slice 3: Workspace Inspector Summary

- Add compact status summary using the same daemon status response.
- Link to Settings for setup and control actions.
- Keep existing CI triage and approval audit panels unchanged.

### Slice 4: Web Token Setup

- Add daemon Keychain-backed configure/delete endpoints for external work secrets.
- Add API client helpers.
- Add password input, Save token, and Remove token controls to the Settings External
  Work panel.
- Clear the token input after submit and refresh status.

### Slice 5: Web Workflow Bootstrap

- Add a local-only daemon endpoint and API client helper for creating or repairing a
  minimal channel-bound `WORKFLOW.md`.
- Add Settings controls for GitHub URL/`owner/repo` and Linear project slug when
  workflow status is missing or invalid.
- Keep the token input disabled until workflow setup succeeds, avoiding the first-run
  dead end without storing tokens in browser state.

## Test Plan

Core and daemon:

- Missing workflow returns `exists: false`, `valid: false`, and no external API call.
- Invalid workflow returns a readable validation error.
- GitHub workflow returns source kind, repository, events, secret ref, and GitHub token
  status metadata.
- Linear workflow returns source kind, project slug, events, secret ref, and Linear token
  status metadata.
- Token status never includes a resolved secret value.
- Workflow setup creates or repairs a missing/invalid local `WORKFLOW.md`, rejects
  out-of-bound paths, and does not call external providers.
- Configure external-work secret saves only a Keychain ref to `WORKFLOW.md`, never the
  token value.
- Delete external-work secret reports `missing` without editing the workflow ref.
- Background running/stopped status is reflected from the local registry.
- External work, CI triage, and action counts are correct.
- Out-of-bound `workflowPath` is rejected.

API client and CLI:

- SDK method builds `GET /external-work/status?cwd=...&channelId=...` correctly.
- SDK secret configure/delete methods use the expected POST endpoints and preserve the
  daemon response.
- CLI `--json` prints the raw response.
- CLI human output includes workflow health, source target, token status, counts, and
  next command.
- Missing `--channel` and daemon 400 errors produce readable output.

Web:

- Settings shows no-workflow, invalid-workflow, GitHub-configured, Linear-configured,
  token-missing, background-running, and background-stopped states.
- Settings load does not call poll, background start, runner, or action execute
  endpoints.
- Settings load does not call workflow configure or secret configure/delete endpoints.
- Missing/invalid workflow states show Create/Repair `WORKFLOW.md`; after success, the
  token input becomes enabled.
- Token save calls `POST /external-work/secrets/configure`, clears the input, and
  refreshes status.
- Token removal calls `POST /external-work/secrets/delete` and refreshes status.
- Poll once calls the source-specific poll endpoint only after a click.
- Reconcile calls the existing reconcile endpoint only after a click.
- Start/Stop background buttons call the existing GitHub background endpoints only
  after a click.
- Workspace Inspector summary matches the Settings status values.

## Open Questions

- Whether the Settings panel should eventually offer a guided `WORKFLOW.md` generator.
  That is useful, but it should be a later explicit write action.
- Whether background status should include next scheduled tick time. This is useful for
  operations, but the first status slice can ship with last tick and last error.
- Whether Linear should receive background polling after live usage proves that manual
  poll is insufficient.
