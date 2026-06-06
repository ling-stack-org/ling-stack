# External Work Multi-Forge Adapters

## Purpose

This document defines the design for adding GitLab, Gitea/Forgejo, and Bitbucket
support to Ling external work without weakening the existing GitHub and Linear safety
boundaries.

The key product boundary is:

- External work source adapters read and normalize work items from provider APIs.
- Git remote URLs prepare local workspaces.
- These are related, but they are not the same abstraction.

A plain Git remote URL can clone, fetch, and checkout code. It cannot list issues,
merge requests, pull requests, comments, labels, CI runs, review states, or permission
scopes. Ling must therefore add explicit provider adapters instead of treating every
Git remote as an external work source.

## Current Baseline

The shipped external-work model currently supports:

- `source.kind: github` for GitHub pull requests, issues, CI triage, and
  approval-gated GitHub actions.
- `source.kind: linear` for read-only Linear issue import and polling.
- `WORKFLOW.md` as the channel-bound external-work contract.
- Secret references through `env:` and `keychain:` refs.
- Durable scheduler state, resource leases, local workspaces, evidence artifacts,
  approvals, and stale-target revalidation.

The current source-kind type is intentionally narrow:

```ts
export type ExternalSourceKind = "github" | "linear";
```

Adding more forge providers should extend this explicit source adapter model. It should
not introduce an untyped "git" source that guesses behavior from a remote URL.

## Goals

- Support GitLab, Gitea/Forgejo, and Bitbucket as first-class external work sources.
- Keep provider-specific API behavior behind small adapters.
- Preserve the current scheduler, workspace, artifact, approval, and action boundaries.
- Make self-hosted providers explicit through `baseUrl`.
- Keep repository checkout transport separate from work-item source identity.
- Ship read-only provider support before external mutations.
- Keep all raw token values out of `WORKFLOW.md`, SQLite, logs, artifacts, and renderer
  state.

## Non-Goals

- No generic "any Git URL" external work source.
- No automatic provider detection from `origin` remote.
- No webhook receiver in the first multi-forge slice.
- No mutation support for GitLab, Gitea/Forgejo, or Bitbucket in the read-only MVP.
- No provider-specific permissions hidden behind the existing GitHub action kinds.
- No CI triage for non-GitHub providers until read-only import and poll are stable.
- No support for every Bitbucket deployment flavor in the first Bitbucket slice.

## Architecture

The multi-forge model adds a provider adapter layer around the existing normalized
external-work pipeline.

```text
WORKFLOW.md
-> external source registry
-> provider source adapter
-> normalized external work item
-> existing scheduler claim and reconcile
-> existing workspace preparation
-> existing workflow/task/run state machines
-> existing artifacts and audit surfaces
```

The workspace checkout path stays separate:

```text
workflow.workspace.gitRemoteUrl
-> workspace manager
-> clone/fetch/checkout
-> hooks and local run preparation
```

This lets a GitLab issue source use an SSH remote, a GitLab SaaS API endpoint, or a
self-hosted HTTPS endpoint without forcing the source adapter to parse Git remotes.

## `WORKFLOW.md` Contract

Provider source configuration should remain explicit.

### GitLab

```yaml
source:
  kind: gitlab
  baseUrl: https://gitlab.com
  repository: group/subgroup/project
  events:
    - merge_request.opened
    - merge_request.updated
    - issue.opened
  secretRef: env:GITLAB_TOKEN
workspace:
  gitRemoteUrl: git@gitlab.com:group/subgroup/project.git
```

Rules:

- `baseUrl` defaults to `https://gitlab.com`.
- `repository` is the GitLab path with namespace.
- The adapter URL-encodes the project path for REST calls.
- `workspace.gitRemoteUrl` is optional; when omitted, the workspace manager may derive
  a provider default for hosted GitLab only.

### Gitea/Forgejo

```yaml
source:
  kind: gitea
  baseUrl: https://git.example.com
  repository: owner/repo
  events:
    - pull_request.opened
    - pull_request.updated
    - issue.opened
  secretRef: keychain:LING_STACK_GITEA_OWNER_REPO_TOKEN
workspace:
  gitRemoteUrl: git@git.example.com:owner/repo.git
```

Rules:

- `baseUrl` is required. Gitea and Forgejo are commonly self-hosted.
- `repository` is `owner/repo`.
- Version differences must fail readably when an endpoint is unavailable.
- Forgejo should use the same adapter unless a concrete API divergence requires a
  separate `forgejo` source kind later.

### Bitbucket

```yaml
source:
  kind: bitbucket
  baseUrl: https://api.bitbucket.org/2.0
  repository: workspace/repo_slug
  events:
    - pull_request.opened
    - pull_request.updated
    - issue.opened
  secretRef: env:BITBUCKET_TOKEN
workspace:
  gitRemoteUrl: git@bitbucket.org:workspace/repo_slug.git
```

Rules:

- The first Bitbucket slice targets Bitbucket Cloud.
- Bitbucket Server/Data Center should be a later explicit compatibility mode because
  the API shape and deployment model are different.
- Issue support may be unavailable for repositories that disable Bitbucket issues. The
  adapter should surface a provider capability warning, not fail the whole workflow.

## Source Adapter Contract

The implementation should promote the existing internal adapter interface into an
adapter registry before adding any new provider. The current code already has
`ExternalWorkSourceAdapter`, `createGitHubExternalWorkAdapter`, and
`createLinearExternalWorkAdapter`; Phase 8.0 makes that boundary the central routing
path instead of leaving GitHub/Linear branches in poll, import, and reconcile code.

```ts
export interface ExternalSourceAdapter {
  readonly kind: ExternalSourceKind;
  readonly capabilities: ExternalSourceCapabilities;

  normalizeConfig(config: ExternalWorkflowSourceConfig): NormalizedExternalSourceConfig;
  listOpenItems(input: ExternalSourceListInput): Promise<ExternalWorkItem[]>;
  normalizeWebhookPayload?(input: ExternalSourceWebhookInput): ExternalWorkItem | undefined;
  loadTargetSnapshot?(input: ExternalSourceTargetInput): Promise<ExternalTargetSnapshot>;
}
```

Initial capabilities:

```ts
export interface ExternalSourceCapabilities {
  readonly issues: boolean;
  readonly changeRequests: boolean;
  readonly ciTriage: boolean;
  readonly comments: boolean;
  readonly labels: boolean;
  readonly reviews: boolean;
}
```

The first multi-forge milestone should set mutation capabilities to `false` for new
providers. The existing GitHub adapter can keep its current mutation and CI support.

## Normalized Work Item Model

The normalized item shape should continue to hide provider details from the scheduler.
New provider-specific values should be added through source-specific metadata rather
than widening core scheduler logic.

Required normalized fields:

- `sourceKind`
- `kind`
- `id`
- `identifier`
- `title`
- `description`
- `url`
- `state`
- `author`
- `updatedAt`
- `repository`
- `subjectKey`
- `idempotencyKey`
- provider target metadata needed for stale-target revalidation

New work item kinds:

```ts
export type ExternalWorkItemKind =
  | "github_pull_request"
  | "github_issue"
  | "linear_issue"
  | "gitlab_merge_request"
  | "gitlab_issue"
  | "gitea_pull_request"
  | "gitea_issue"
  | "bitbucket_pull_request"
  | "bitbucket_issue";
```

The scheduler should continue to key duplicate protection by `(sourceKind,
idempotencyKey)`.

## Provider-Specific Mapping

### GitLab

- Merge request -> `gitlab_merge_request`.
- Issue -> `gitlab_issue`.
- Target snapshot should include project path, numeric project id when available, IID,
  source branch, target branch, head SHA, state, and updated timestamp.
- CI triage should later map pipelines, jobs, traces, and merge request head SHA.

### Gitea/Forgejo

- Pull request -> `gitea_pull_request`.
- Issue -> `gitea_issue`, excluding PR-shaped issues when the API exposes both.
- Target snapshot should include owner, repo, index, head SHA, base branch, head branch,
  state, and updated timestamp.
- CI support is provider-installation dependent and should be deferred.

### Bitbucket Cloud

- Pull request -> `bitbucket_pull_request`.
- Issue -> `bitbucket_issue` only when repository issues are enabled.
- Target snapshot should include workspace, repo slug, PR id, source branch, destination
  branch, source commit hash, state, and updated timestamp.
- Pipeline support should be deferred until the Cloud read-only path is stable.

## Workspace Checkout Transport

`workspace.gitRemoteUrl` should be added as a checkout hint. It does not replace
`source.repository`.

```yaml
workspace:
  gitRemoteUrl: git@gitlab.com:group/project.git
  mode: per_subject
```

Rules:

- The workspace manager may use `workspace.gitRemoteUrl` in default clone preparation.
- Hooks remain supported and can override checkout behavior.
- The source adapter must not shell out to Git.
- A `gitRemoteUrl` must not grant external-work API permissions.
- Redaction should treat embedded credentials in remote URLs as secrets.

## Security Boundaries

- `secretRef` continues to accept only supported secret refs such as `env:NAME` or
  `keychain:NAME`.
- Provider adapters receive resolved token values only at call time.
- Adapters must redact authorization headers and token query parameters from evidence.
- Provider errors should include endpoint category and status class, not raw request
  headers or token values.
- Self-hosted `baseUrl` values must be validated as absolute HTTP(S) URLs.
- Mutation adapters must remain unavailable until they have durable action records,
  approval policies, explicit execute calls, and stale-target revalidation.

## Rollout Plan

### Phase 8.0: Adapter Registry Refactor

Goal: introduce the adapter boundary with no behavior change.

- Add `ExternalSourceAdapter` and registry types.
- Move GitHub read-only listing behind the registry.
- Move Linear read-only listing behind the registry.
- Keep current routes, CLI commands, and SDK shape working.
- Add tests proving GitHub and Linear outputs are unchanged.

Detailed plan: [External Work Phase 8.0 Adapter Registry Implementation](external-work-phase-8.0-adapter-registry-implementation.md).

### Phase 8.1: Workspace Git Remote Hint

Goal: support explicit checkout transport without adding new source providers.

- Add `workspace.gitRemoteUrl` parsing.
- Add validation and redaction for credential-bearing remotes.
- Teach workspace preparation to use the hint when no hook overrides checkout.
- Keep hooks as the highest-control path.

Detailed plan: [External Work Phase 8.1 Workspace Git Remote Implementation](external-work-phase-8.1-workspace-git-remote-implementation.md).

### Phase 8.2: GitLab Read-Only Adapter

Goal: prove the multi-forge model with the most complete non-GitHub forge.

- Accept `source.kind: gitlab`.
- Support GitLab SaaS and self-hosted `baseUrl`.
- Poll open merge requests and issues.
- Normalize work items and persist scheduler state through the existing path.
- Add fixtures for merge request and issue payloads.
- Add local-only status and parser tests.

### Phase 8.3: Gitea/Forgejo Read-Only Adapter

Goal: support common self-hosted lightweight forges.

- Accept `source.kind: gitea`.
- Require `baseUrl`.
- Poll open pull requests and issues.
- Normalize work items through the shared path.
- Surface endpoint/version incompatibility as provider capability warnings.

### Phase 8.4: Bitbucket Cloud Read-Only Adapter

Goal: support Bitbucket Cloud with a narrow, explicit scope.

- Accept `source.kind: bitbucket`.
- Default to Bitbucket Cloud API.
- Poll open pull requests and issues when enabled.
- Normalize work items through the shared path.
- Document that Server/Data Center is not covered by this slice.

### Phase 8.5: Mutations and CI Expansion

Goal: add higher-risk provider actions only after read-only source support is stable.

- Add provider-specific action kinds, not generic GitHub action reuse.
- Require approval and stale-target revalidation for every external mutation.
- Add GitLab comment/label/review-equivalent actions first.
- Add CI triage provider by provider.
- Keep push, merge, release, and state-change mutations deferred until a separate
  policy review.

## Testing Strategy

Each provider slice should include:

- Parser tests for valid and invalid `WORKFLOW.md` source config.
- Secret ref validation tests.
- Fixture normalization tests for issue and change-request payloads.
- Mock API poll tests for pagination, auth failure, rate limits, and disabled features.
- Scheduler idempotency tests using `(sourceKind, idempotencyKey)`.
- Redaction tests for authorization headers, token query params, and credential-bearing
  Git remote URLs.
- Status surface tests showing provider kind, target, secret readiness, and capability
  warnings without making implicit network calls.

## Failure Modes

- Self-hosted provider uses an unsupported API version.
- Repository path is renamed or moved.
- Token lacks issue or merge-request read scope.
- Provider returns PRs through an issue endpoint and causes duplicates.
- Bitbucket repository has issues disabled.
- Git remote URL works for clone but provider API token fails.
- Provider API works but SSH clone fails.
- Base URL points to an internal network target the operator did not intend to access.
- Rate limits or pagination hide work items without explicit evidence.

Each failure should produce a local status or evidence artifact that lets the operator
tell whether the source API, checkout transport, token, or workflow config failed.

## Open Questions

- Should Forgejo eventually get a separate `source.kind: forgejo` if API behavior
  diverges from Gitea in live deployments?
- Should Bitbucket Server/Data Center be `bitbucket_server` instead of a compatibility
  flag under `bitbucket`?
- Should hosted providers allow default `gitRemoteUrl` derivation, or should the first
  implementation require explicit checkout URLs for every non-GitHub source?
- Which provider action should be the first non-GitHub mutation: comment, label, or
  review-equivalent?
- Should Web Settings expose provider-specific setup forms in one panel, or should it
  keep the current GitHub/Linear setup and add advanced YAML editing first?

## Acceptance Criteria

The multi-forge adapter work is ready to start when:

- GitHub and Linear are behind the new adapter registry with no behavior regression.
- `WORKFLOW.md` validation distinguishes source provider config from workspace checkout
  config.
- `workspace.gitRemoteUrl` is parsed, redacted, and ignored by source API adapters.
- The first GitLab read-only slice can be implemented without touching scheduler state
  machines, approval storage, or run orchestration.
