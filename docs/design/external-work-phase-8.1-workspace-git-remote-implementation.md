# External Work Phase 8.1 Workspace Git Remote Implementation Plan

## Summary

Phase 8.1 adds `workspace.gitRemoteUrl` as an explicit checkout hint for external work
workspaces. This phase keeps source provider identity separate from Git checkout
transport.

The boundary is:

```text
source.kind + source.repository/projectSlug
-> provider API for issues, pull requests, merge requests, CI, and comments

workspace.gitRemoteUrl
-> optional local Git checkout preparation
```

A Git remote URL is not an external work source. It does not grant permission to call
provider APIs, and Ling must not infer provider behavior from it.

## Required Baseline

Phase 8.1 should follow Phase 8.0 or be implemented in a way that does not conflict
with the adapter registry refactor.

Required existing behavior:

- `WORKFLOW.md` already parses `workspace.root`, `workspace.mode`, and
  `workspace.cleanupTerminalWorkItems`.
- External work polling already allocates a per-subject or per-attempt workspace path.
- Workspace hooks can run `afterCreate` and `beforeRun` commands when `executeHooks` is
  explicitly true.
- Hook output is captured as redacted evidence artifacts.
- Workspace paths are constrained under `workspace.root`.

Still enforced:

- No automatic provider detection from Git remotes.
- No token values in workflow files, logs, artifacts, or renderer state.
- No implicit network checkout when the operator did not opt into workspace preparation
  side effects.

## Goals

- Add `workspace.gitRemoteUrl` to `WORKFLOW.md`.
- Validate common Git remote URL forms without contacting the network.
- Redact credential-bearing remote URLs in all status, artifact, and error surfaces.
- Preserve existing hook behavior.
- Provide a safe default clone path for newly created workspaces when explicitly
  enabled through the existing hook/checkout execution path.
- Make non-GitHub provider examples readable before GitLab/Gitea/Bitbucket adapters are
  implemented.

## Non-Goals

- No GitLab, Gitea/Forgejo, or Bitbucket adapter.
- No source provider inference from `gitRemoteUrl`.
- No credential-bearing HTTPS remote support in examples.
- No SSH key management.
- No branch checkout, sparse checkout, submodule, or LFS support in the first slice.
- No automatic clone on Web Settings status calls.
- No mutation of the external repository.

## `WORKFLOW.md` Contract

Example:

```yaml
source:
  kind: gitlab
  baseUrl: https://gitlab.com
  repository: group/project
  secretRef: env:GITLAB_TOKEN
workspace:
  gitRemoteUrl: git@gitlab.com:group/project.git
  mode: per_subject
```

`workspace.gitRemoteUrl` is optional. Existing workflows without it keep the current
behavior.

Rules:

- `workspace.gitRemoteUrl` is a checkout hint only.
- `source.kind` and source target fields remain required for external-work provider
  operations.
- Hooks remain the highest-control checkout mechanism.
- If `hooks.afterCreate` is configured, Ling must not also run an implicit clone.
- If no `hooks.afterCreate` is configured, Ling may run a default clone only when the
  caller explicitly enables workspace preparation side effects.

## Type Changes

Extend `ExternalWorkspaceConfig`:

```ts
export interface ExternalWorkspaceConfig {
  readonly root?: string;
  readonly mode: ExternalWorkspaceMode;
  readonly cleanupTerminalWorkItems: boolean;
  readonly gitRemoteUrl?: string;
}
```

Parser change:

```ts
function normalizeWorkspaceConfig(raw: Record<string, unknown> | undefined): ExternalWorkspaceConfig {
  return {
    root: readOptionalString(raw?.root, "workspace.root"),
    mode,
    cleanupTerminalWorkItems: readOptionalBoolean(raw?.cleanupTerminalWorkItems, "workspace.cleanupTerminalWorkItems", false),
    gitRemoteUrl: normalizeGitRemoteUrl(readOptionalString(raw?.gitRemoteUrl, "workspace.gitRemoteUrl")),
  };
}
```

`normalizeGitRemoteUrl` should validate shape only. It should not call Git, DNS, HTTP,
or provider APIs.

## Remote URL Validation

Accept common non-credential forms:

- `git@github.com:owner/repo.git`
- `git@gitlab.com:group/subgroup/project.git`
- `ssh://git@git.example.com/owner/repo.git`
- `https://github.com/owner/repo.git`
- `https://gitlab.com/group/project.git`
- `file:///path/to/local/repo.git` only if local file remotes are explicitly allowed by
  a future local-dev flag

Phase 8.1 should accept SSH scp-like, `ssh://`, and plain `https://` remotes. It should
reject `file://` by default because local path remotes complicate workspace confinement.

Reject:

- empty strings
- strings with control characters
- strings with newline characters
- unsupported schemes such as `ftp:`
- `https://user:token@example.com/repo.git`
- `https://token@example.com/repo.git`
- shell fragments or command-looking values

The validation error should name the workflow field:

```text
Unsupported workspace.gitRemoteUrl: credential-bearing HTTPS remotes are not allowed.
```

## Redaction

Even though Phase 8.1 should reject credential-bearing HTTPS remotes, redaction should
still treat remote URLs as potentially sensitive because users may have old configs or
test fixtures.

Add or reuse a helper:

```ts
export function redactGitRemoteUrl(value: string): string
```

Rules:

- `https://user:password@git.example.com/owner/repo.git`
  -> `https://***@git.example.com/owner/repo.git`
- `https://token@git.example.com/owner/repo.git`
  -> `https://***@git.example.com/owner/repo.git`
- `git@git.example.com:owner/repo.git` stays unchanged.
- Query params named `token`, `access_token`, `private_token`, `auth`, or `key` are
  replaced with `***` if a URL parser can read them.

Use the redacted value in:

- validation errors
- status responses
- hook/checkout evidence artifacts
- debug logs
- CLI human output

## Checkout Behavior

Phase 8.1 should avoid hidden network work. The safest first behavior is:

- Parse and validate `workspace.gitRemoteUrl` always.
- Include a redacted checkout hint in status/debug surfaces when useful.
- Run default clone only during explicit workspace preparation.

Default clone eligibility:

1. `workspace.gitRemoteUrl` is configured.
2. The external-work workspace was newly created.
3. The poll/import path has `executeHooks === true` or a future equivalent explicit
   checkout flag.
4. `hooks.afterCreate` is not configured.
5. The workspace directory is empty.

If all conditions pass, run:

```bash
git clone -- <workspace.gitRemoteUrl> .
```

Implementation should use `spawn("git", ["clone", "--", gitRemoteUrl, "."])` with
argument arrays, not shell string interpolation.

If any condition does not pass, no clone happens. This is not an error.

## Hook Interaction

`hooks.afterCreate` remains authoritative. Operators who need custom branch checkout,
submodules, worktrees, sparse checkout, LFS, or private SSH setup should keep using
hooks.

Ordering when default clone is enabled:

```text
allocate workspace path
-> create directory
-> if eligible, default git clone
-> run hooks.beforeRun when configured
-> mark scheduler state ready
```

`afterCreate` is skipped only for implicit clone because a configured `afterCreate`
means the operator owns the create-time setup. `beforeRun` can still run after the
implicit clone.

## Evidence Artifacts

When default clone runs, record a small checkout artifact:

```json
{
  "type": "git_checkout",
  "remoteUrl": "git@gitlab.com:group/project.git",
  "redactedRemoteUrl": "git@gitlab.com:group/project.git",
  "command": "git clone -- <redactedRemoteUrl> .",
  "cwd": "<workspacePath>",
  "exitCode": 0,
  "timedOut": false
}
```

Rules:

- Store redacted command text.
- Bound stdout/stderr using the same size limits as hooks.
- Redact remote URL and known secret values before writing artifacts.
- Do not include provider API tokens.

The artifact can reuse the hook artifact path shape under:

```text
external-work/<externalWorkId>/hooks
```

or move to a clearer:

```text
external-work/<externalWorkId>/workspace
```

The second path is cleaner, but the first path is acceptable if it avoids a broad
artifact UI change.

## Status Surface

External work status should not call Git. It may report:

```json
{
  "workspace": {
    "gitRemoteConfigured": true,
    "gitRemoteUrl": "git@gitlab.com:group/project.git"
  }
}
```

If the remote was rejected during parsing, status should continue to report the workflow
parse error. It should not try to repair the remote.

Web Settings should not ask for Git credentials in this phase.

## Affected Files

Likely core files:

- `packages/core/src/external-work-types.ts`
- `packages/core/src/external-work.ts`
- `packages/core/src/external-work-scheduler.ts`
- `packages/core/src/redaction.ts`
- `packages/core/test/external-work.test.mjs`

Likely daemon files:

- `packages/daemon/src/features/external-work/status.ts`
- `packages/daemon/test/external-work-import.test.mjs`

Likely docs:

- `docs/design/external-work-multi-forge-adapters.md`
- `docs/design/external-work-roadmap.md`
- `docs/daemon-api.md` if the status response shape changes

Avoid touching:

- provider source adapters
- external action execution
- CI triage
- SQLite schema
- Web Settings token setup

## Implementation Slices

### Slice 1: Parse and Validate

- Add `gitRemoteUrl?: string` to `ExternalWorkspaceConfig`.
- Parse `workspace.gitRemoteUrl`.
- Add URL validation helper and tests.
- Keep existing workflows valid.

Validation:

- SSH scp-like remote parses.
- `ssh://` remote parses.
- plain `https://` remote parses.
- credential-bearing HTTPS remote is rejected.
- unsupported scheme is rejected.

### Slice 2: Redaction

- Add `redactGitRemoteUrl`.
- Add tests for userinfo and token query params.
- Use redaction in any new status or artifact fields.

Validation:

- No raw userinfo appears in serialized checkout evidence.
- Git SSH remotes remain readable.

### Slice 3: Default Clone Helper

- Add a helper that runs `git clone -- <url> .` using `spawn` args.
- Reuse existing command timeout and bounded output logic where possible.
- Return a structured result instead of throwing raw child process errors.
- Redact remote URL before creating artifacts.

Validation:

- Mocked or temp local test proves command args are not shell-interpolated.
- Clone is skipped when `executeHooks !== true`.
- Clone is skipped when `hooks.afterCreate` exists.
- Clone is skipped when workspace already exists.

### Slice 4: Scheduler Integration

- Call the checkout helper from `processCandidate` after workspace directory creation
  and before `beforeRun` hooks.
- Include checkout artifact ids in scheduler `hookArtifactIds` or a future
  workspace-artifact list.
- Preserve existing hook artifact behavior.

Validation:

- Existing GitHub and Linear poll tests pass.
- A workflow with `gitRemoteUrl` and no `afterCreate` records checkout evidence when
  explicit execution is enabled.
- A workflow with both `gitRemoteUrl` and `afterCreate` runs only `afterCreate`.

### Slice 5: Status Reporting

- Surface redacted `gitRemoteUrl` status if the current status response already has a
  workspace block.
- If adding a new response field creates too much churn, defer UI exposure and keep
  Phase 8.1 core-only.

Validation:

- Status remains read-only.
- Status does not call Git or the network.

## Security Notes

- `gitRemoteUrl` should never be used to resolve provider API base URLs.
- Credential-bearing remotes should be rejected in new workflow parsing.
- Redaction still handles credential-bearing values for defense in depth.
- Default clone must use argument arrays, not shell interpolation.
- Checkout should run only under the same explicit side-effect gate as workspace hooks.
- Clone output must be bounded and redacted before artifact persistence.
- SSH host key verification is delegated to the user's Git/SSH configuration in this
  phase; Ling should not auto-disable host key checks.

## Failure Modes

- SSH key is missing or requires interactive passphrase input.
- Host key verification fails.
- Remote repository exists but caller lacks clone permission.
- `git` is not installed or not on PATH.
- Workspace directory is not empty.
- `gitRemoteUrl` contains credentials and is rejected.
- `hooks.afterCreate` and `gitRemoteUrl` are both configured, and the operator expected
  both to run.

Each failure should be attributed to checkout transport, not source provider API. The
error text should make that distinction clear.

## Testing Strategy

Core tests:

- Parser accepts `workspace.gitRemoteUrl`.
- Parser rejects unsupported schemes and credential-bearing HTTPS remotes.
- Redactor masks userinfo and token query params.
- Workspace allocation remains under `workspace.root`.
- Checkout helper uses non-shell `spawn` arguments.
- Checkout helper output is bounded and redacted.

Scheduler tests:

- Existing external-work poll tests remain unchanged when `gitRemoteUrl` is absent.
- Default clone is skipped unless explicitly enabled.
- `afterCreate` suppresses default clone.
- Checkout artifact is attached to external work when clone runs.

Daemon/status tests:

- Status response remains read-only.
- Status never returns credential-bearing remote URLs.

Regression:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

## Acceptance Criteria

Phase 8.1 is complete when:

- `workspace.gitRemoteUrl` is parsed and validated.
- Existing workflows without `gitRemoteUrl` behave exactly as before.
- Credential-bearing remotes are rejected or redacted before any output.
- No source adapter uses `gitRemoteUrl` to infer provider identity.
- Optional default clone runs only during explicit workspace preparation and only when
  no `afterCreate` hook owns checkout.
- Checkout evidence is redacted and bounded.
- Existing external-work tests pass.
