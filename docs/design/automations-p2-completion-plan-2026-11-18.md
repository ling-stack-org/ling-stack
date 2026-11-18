# Automations P2 Completion Plan

Status: local source complete; hosted checks and merge recorded in [PR #732](https://github.com/ling-stack-org/ling-stack/pull/732)
Owner: Automations domain
Last verified: 2026-11-18
Source branch: `codex/automations-p2-completion`
Integration baseline: `origin/main@acf448a9c7e825ad362d5e4adaf5096100e1e8b5`
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
| Poll admission and recovery | A matching snapshot advances only after its own ordinary Run is linked. An unadmitted poll can retry at the next slot. Replaying a slot reuses its Run; returning to a prior fingerprint in a new slot creates a distinct Run. | Scheduler regressions cover A→B→A, same-slot replay, failed and occupied admission, doctor counts, timer selection and confirmation retry. |
| Monitor notification | The daemon journals `automation_monitor_finding`, applies the existing global/event/quiet-hour preferences, and keeps delivery auxiliary to durable Run state. | Contracts tone test, notification API preference round-trip and monitor integration journal assertion. |
| Web monitor projection | Scheduler items expose `lastMonitorFingerprint` and `lastMonitorOutcome`; the Automations page renders source, outcome, summary and last poll for active monitor definitions. | Web typecheck/tests and the monitor view-model boundary test. |
| Documentation | The Automations contract, implementation status, remaining-work plan and design index state the new local closure and its external acceptance boundary. | Markdown-link and diff checks; GitHub records the checked head and merge commit. |

## Data flow

```text
monitor timer
  -> compare bounded local snapshot with the stored fingerprint
  -> unchanged / nonmatching: skip or retain no-op history
  -> matching: admit an ordinary AutomationRun / RunSession for the poll slot
  -> attach context and finding artifacts to the admitted Run
  -> persist matched fingerprint and outputArtifactIds
  -> scheduler item + notification journal
  -> Web monitor projection
```

The snapshot remains untrusted facts. It cannot grant tools, permissions, approvals,
workspace access or delivery authority. `unchangedPolicy=skip` and
`record_noop` retain their existing behavior; no-op rows do not create a finding
artifact because there is no execution Run to own one. Matching observations that cannot
create or link their own Run leave the fingerprint eligible at the next poll.

## Verification plan

Run the narrow checks first:

```text
corepack pnpm --filter @ling-stack/contracts test:ci
node --test --test-concurrency=1 packages/daemon/test/automation-monitor.test.ts
node --test --test-concurrency=1 packages/daemon/test/automations-api.test.mjs packages/daemon/test/notifications-hub.test.mjs packages/daemon/test/notifications-api.test.mjs
corepack pnpm --filter @ling-stack/web typecheck
```

Then run the owning package typechecks/builds, `git diff --check`, documentation
link checks and the repository checks required by CI. Hosted CI, review threads and
mergeability are separate gates from local source and test evidence.

## Deliberate boundaries

- Desktop OS notification permission and native delivery remain the P3/platform gate.
- Live GitHub CI triage, real Providers, live IM delivery and signed packaged-client
  acceptance remain external gates.
- General external action proposals and new monitor sources are outside this batch.
- A local test, PR creation or PR merge does not imply deployment or platform acceptance.
