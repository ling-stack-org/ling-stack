# External Work Phase 7 Implementation Plan

## Summary

Phase 7 proves that external-work orchestration is a platform abstraction rather than
GitHub-specific code hidden behind generic names. The second concrete source adapter is
Linear, and the first cut is deliberately read-only:

```text
Linear issue fixture or GraphQL poll
-> normalized ExternalWorkItem
-> existing scheduler claim and workspace isolation path
-> local workflow, step, scheduler state, and evidence artifacts
-> local observability through existing external-work list/show APIs
```

This phase must not add Linear mutations, webhook ingestion, background Linear polling,
runner startup, or a separate scheduler database. GitHub remains the only source with
approval-gated external mutations in this slice.

## Required Baseline

Phase 7 assumes these capabilities already exist:

- GitHub PR/issue manual import.
- GitHub read-only poll, local reconcile, scheduler state, leases, isolated workspaces,
  and optional hook evidence.
- Approval-gated GitHub comments, labels, and strict PR review actions.
- GitHub CI triage, local fix task creation, and explicit local fix run bridge.
- Runtime-registered GitHub background polling and reconciliation.
- Local external-work list/show observability across source kinds.

Still enforced:

- No automatic runner start from external work.
- No external mutation without durable proposed action, approval, explicit execute, and
  stale-target revalidation.
- No Linear write action in Phase 7.
- No token persistence in SQLite or artifacts.
- No daemon startup network call unless an operator explicitly registers or invokes a
  source operation.

## Goals

- Add `linear` as the second concrete `ExternalSourceKind`.
- Add `linear_issue` as a normalized `ExternalWorkItemKind`.
- Parse Linear `WORKFLOW.md` source config with `source.kind: linear` and
  `source.projectSlug`.
- Normalize Linear issue fixtures into stable `ExternalWorkItem` records.
- Add a read-only Linear GraphQL adapter for manual poll.
- Reuse the existing import, scheduler-state, lease, workspace, hook, and evidence
  paths instead of adding Linear-specific workflow storage.
- Expose daemon, SDK, and CLI surfaces for manual Linear import and poll.
- Keep local reconcile source-agnostic unless a source-specific terminal check is
  explicitly implemented later.

## Non-Goals

- No Linear comment creation.
- No Linear label mutation.
- No Linear status/state transition.
- No Linear assignment mutation.
- No Linear webhook receiver.
- No Linear background scheduler in the first cut.
- No Linear action approval/execution path.
- No GitLab or Jira adapter in this phase.
- No new Web page; existing external-work list/show surfaces should remain sufficient
  for this read-only slice.

## WORKFLOW.md Contract

Linear workflows use the same Markdown body and prompt renderer as GitHub workflows.
The source binding changes from a repository to a project slug:

```markdown
---
source:
  kind: linear
  projectSlug: ling-stack
  events:
    - issue.created
  secretRef: env:LINEAR_TOKEN
scheduler:
  pollIntervalMs: 30000
workspace:
  mode: per_subject
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
State: {{ item.state }}
Priority: {{ item.priority }}
URL: {{ item.url }}
```

Rules:

- `source.kind` must be `linear`.
- `source.projectSlug` is required.
- `source.repository` is ignored for Linear.
- Phase 7 supports issue events only. Unsupported event types return validation errors.
- `secretRef` resolves through the existing secret resolver with the `linear_token`
  purpose. The token is passed only to the read-only adapter for the current request.

## Normalization

Linear issues normalize into the existing external work item contract:

```ts
{
  sourceKind: "linear",
  kind: "linear_issue",
  identifier: "LIN-123",
  title: "Wire Linear external work",
  description: "...",
  url: "https://linear.app/...",
  state: "Todo",
  priority: 2,
  labels: ["external-work"],
  branchName: "tx/linear-external-work",
  updatedAt: "2026-06-01T00:00:00.000Z",
  payloadRef: "linear:poll:issue:ling-stack:LIN-123",
  idempotencyKey: "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z"
}
```

The idempotency key should include:

- source kind
- item kind
- project slug
- issue identifier
- updated timestamp, or current state when `updatedAt` is absent

The durable `external_work` row, scheduler state, artifacts, and workflow/step records
are the same records used by GitHub external work.

## Read-Only Adapter

The Linear adapter uses GraphQL over `POST https://api.linear.app/graphql`. Phase 7
should query issue fields required for normalization only:

- `id`
- `identifier`
- `title`
- `description`
- `url`
- `priority`
- `branchName`
- `updatedAt`
- `state { name type }`
- `labels { nodes { name } }`
- `project { name slug }`

The adapter filters candidates by `project.slug === source.projectSlug` and returns
normalized `ExternalWorkItem` records. It does not call mutation fields and does not
perform terminal remote reconciliation in the first cut.

## API Surface

Daemon endpoints:

```http
POST /external-work/linear/import?cwd=...
POST /external-work/linear/poll?cwd=...
```

Import request:

```json
{
  "channelId": "channel_...",
  "eventType": "issue.created",
  "payload": {},
  "workflowPath": "WORKFLOW.md"
}
```

Poll request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false
}
```

Responses reuse the existing `ExternalWorkImportResponse` and
`ExternalWorkPollResponse` shapes. `workflowMarkdown` remains available for tests and
manual fixtures, and `workflowPath` remains channel-bound.

SDK methods:

```ts
await client.importLinearExternalWork(cwd, {
  channelId: "channel_...",
  eventType: "issue.created",
  payload,
  workflowPath: "WORKFLOW.md",
});

await client.pollLinearExternalWork(cwd, {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
});
```

CLI commands:

```bash
ling-stack external-work linear import \
  --channel channel_... \
  --event-type issue.created \
  --payload-file issue.json \
  --workflow-path WORKFLOW.md

ling-stack external-work linear poll \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50
```

`--json` should print daemon responses unchanged. Human output should reuse the
existing external-work import and poll summaries.

## Reconciliation

Phase 7 keeps reconciliation conservative:

- Local reconcile remains source-agnostic for lease expiry, missing workflow/step rows,
  terminal local workflow state, and retry backoff readiness.
- GitHub can continue to perform optional single-item terminal checks when a GitHub
  workflow path is provided.
- Linear remote terminal checks are deferred until the read-only adapter has a stable
  single-issue query and clear state mapping.

## Safety Boundary

Linear Phase 7 operations may:

- Read Linear issues through GraphQL.
- Create or reuse local workflows, steps, scheduler state, leases, workspaces, and
  evidence artifacts.
- Run `afterCreate` and `beforeRun` hooks only when `executeHooks` is explicitly true
  and the existing workspace lease and isolation checks pass.

Linear Phase 7 operations must not:

- Start teammate runs.
- Propose hidden external actions.
- Execute Linear or GitHub mutations.
- Store Linear tokens in SQLite or artifacts.
- Add a background poller without a separate explicit design slice.

## Tests

Core:

- Linear `WORKFLOW.md` parses with `source.kind: linear` and `source.projectSlug`.
- Missing `source.projectSlug` returns a validation error.
- Linear issue fixture normalization produces stable `ExternalWorkItem` fields and
  idempotency key.
- Linear GraphQL adapter reads issues and filters by project slug.
- Linear poll uses the shared workflow creation, scheduler-state, lease, workspace, and
  evidence path.
- Duplicate Linear poll does not create a second workflow.
- Hook evidence redacts the Linear token.

Daemon:

- `POST /external-work/linear/import` imports a fixture without starting a runner or
  mutation.
- `POST /external-work/linear/poll` with mock GraphQL creates or reuses local records.
- Invalid channel, workflow path escape, invalid workflow, unsupported source kind, and
  Linear HTTP/GraphQL errors return readable errors.
- Reconcile remains local-only for Linear.

SDK and CLI:

- SDK methods call the expected URLs and preserve daemon responses.
- CLI import and poll support `--json` and human output.
- Missing required flags, invalid payload JSON, mutually exclusive workflow flags, and
  daemon 400s are readable.

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
corepack pnpm typecheck
corepack pnpm test
git diff --check
```

## Completion Criteria

- A Linear issue can be manually imported into the same external-work workflow path as
  GitHub PRs/issues.
- Linear manual poll can discover project issues through read-only GraphQL and create or
  reuse local records idempotently.
- Operators can inspect Linear external-work records and evidence through the same
  list/show/artifact surfaces.
- No Linear mutation, runner start, webhook receiver, or background scheduler is added.
- The scheduler core remains source-neutral; source-specific behavior lives in the
  adapter and normalization layer.

## Handoff To GA

After Phase 7, external-work orchestration v1 has two read sources and one
approval-gated write source. The next work should be GA hardening: live smoke suites,
permission and token-scope audits, audit search/export, admin policy controls,
rate-limit tuning, workspace isolation security review, and recovery documentation.
