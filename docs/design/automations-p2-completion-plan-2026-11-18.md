# Automations P2 Completion Plan

Status: implemented locally; PR #732 is open and hosted merge verification is pending
Owner: Automations domain
Last verified: 2026-11-18
Source branch: `codex/automations-p2-completion`
Baseline: `origin/main@d613e0ddaf0ef0575e691bef4418b6dbbaf62b36`
Current head: the tip of PR #732, re-read from GitHub at each hosted gate
Code anchors: `packages/daemon/src/features/automations`, `packages/contracts/src/automations.ts`, `packages/contracts/src/notifications.ts`, `apps/web/src/features/automations`

## Objective

Close the remaining locally developable part of the project-monitor P2 slice while
preserving the existing local-first scheduler and ordinary Run ownership. A monitor
finding must be durable, inspectable, notification-aware and visible in the Web
projection. The batch does not claim desktop OS delivery, a real external Provider,
remote CI, live messaging, signed packaging or deployment.

## Scope and completion contract

| Work package | Delivered behavior | Evidence required |
|---|---|---|
| Finding artifact | A condition-matching monitor Run creates a Markdown finding artifact containing the source, condition, fingerprint and bounded snapshot. The artifact is attached to the Run and its ID is persisted in `AutomationRun.outputArtifactIds`. | Daemon monitor integration verifies the artifact metadata, output ID and Run artifact listing. |
| Monitor notification | The daemon journals `automation_monitor_finding`, applies the existing global/event/quiet-hour preferences, and keeps delivery auxiliary to durable Run state. | Contracts tone test, notification API preference round-trip and monitor integration journal assertion. |
| Web monitor projection | Scheduler items expose `lastMonitorFingerprint` and `lastMonitorOutcome`; the Automations page renders source, outcome, summary and last poll for active monitor definitions. | Web typecheck/tests and the monitor view-model boundary test. |
| Documentation | The Automations contract, implementation status, remaining-work plan and design index state the new local closure and its external acceptance boundary. | Markdown-link and diff checks; final PR/merge SHA recorded after hosted verification. |

## Data flow

```text
monitor timer
  -> bounded local snapshot + SQLite fingerprint CAS
  -> matching condition
  -> normal AutomationRun / RunSession
  -> context artifact + monitor finding artifact
  -> outputArtifactIds + Run artifact list
  -> monitor scheduler item + notification journal
  -> Web monitor projection
```

The snapshot remains untrusted facts. It cannot grant tools, permissions, approvals,
workspace access or delivery authority. `unchangedPolicy=skip` and
`record_noop` retain their existing behavior; no-op rows do not create a finding
artifact because there is no execution Run to own one.

## Verification plan

Run the narrow checks first:

```text
corepack pnpm --filter @ling-stack/contracts test:ci
node --test --test-concurrency=1 packages/daemon/test/automations-api.test.mjs packages/daemon/test/notifications-hub.test.mjs packages/daemon/test/notifications-api.test.mjs
corepack pnpm --filter @ling-stack/web typecheck
```

Then run the owning package typechecks/builds, `git diff --check`, documentation
link checks and the repository checks required by CI. Hosted CI, review threads and
mergeability are separate gates from local source and test evidence.

## Deliberate boundaries

- Desktop OS notification permission and native delivery remain the P3/platform gate.
- Real GitHub/Provider, remote CI, live IM delivery and signed packaged-client
  acceptance remain external gates.
- General external action proposals and new monitor sources are outside this batch.
- A local test, PR creation or PR merge does not imply deployment or platform acceptance.
