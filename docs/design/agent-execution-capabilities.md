# Agent Execution Capabilities

Status: C1–C3, A1/A2 and R1–R3 locally implemented; release gates open
Owner: Runner and daemon maintainers
Last verified: 2026-11-16
Document type: design contract

## Scope And Existing Owners

This contract covers code intelligence, Code Mode, lifecycle Hooks, external-event
automations, selective rerun and evidence-based Goal supervision. Delivery
order and acceptance live in the [implementation plan](agent-execution-capabilities-implementation-plan.md).

The baseline is `main@878dfa13`. Ling already owns tool hydration, MCP, Skills,
approvals, cancellation, sandbox selection, prepared Runner input, Goal continuation,
automations and workflow rerun admission. These owners remain authoritative:

- [Runtime control plane](runtime-control-plane-detailed-design.md)
- [Automations](automations.md)
- [Plan and Goal](conversation-plan-and-goal-modes.md)
- [Workflow rerun](ling-framework-complementary-detailed-design.md)
- [Internal registry](internal-registry-plugin-sdk.md)

## Execution Boundary

The daemon selects and freezes capabilities before preparing the model input. The
Runner registers only those schemas. Execution requires a current Run/Attempt fence,
the live Host handlers and the selected tool inventory. Configuration, tool discovery
and a successful script are never authorization grants.

The daemon enables these capabilities for ordinary Pi Runs. Code intelligence also
requires `read` in the selected tools. Workflow steps, delegated execution and
external/native runners do not inherit them. Restricted read-only and isolated-file
workflow profiles reject the new capabilities and retain their closed inventories.

Every nested tool call must retain its own identity and pass the existing validation,
tool-before, approval, execution and result pipeline. Cancellation closes new dispatch;
an aborted script does not prove an already-dispatched external effect was stopped.
Neither Hooks nor Code Mode may auto-replay a mutating call after timeout or restart.

## Code Intelligence

### First Language Adapter

The first adapter supports TypeScript and JavaScript, including TSX/JSX, using the
TypeScript language service over a bounded, immutable workspace snapshot. It starts no
language-server process. The repository's TypeScript 7 build tool has a different API;
the language-service dependency is pinned separately rather than using unstable build
compiler internals.

The `code_intelligence` tool accepts an operation and a workspace-relative path:

| Operation | Additional input | Result |
|---|---|---|
| `definition` | one-based `line`, `column` | declaration locations |
| `references` | one-based `line`, `column` | reference locations and write-access flags |
| `hover` | one-based `line`, `column` | type/signature and documentation |
| `symbols` | optional `query` | file declarations |
| `diagnostics` | none | syntactic and semantic diagnostics |
| `repo_map` | optional `query`, `limit` | bounded file/symbol/import overview |

Positions use UTF-16 columns, matching the language service. Results include source
snapshot identity, bounds, omitted/truncated evidence and relative paths with exact
locations. Missing files, invalid positions and unsupported operations are explicit
errors. An empty result in a partial snapshot is not proof that no references exist.

### Files And Freshness

The Host owns the workspace root and rechecks the current execution fence around I/O.
The snapshot excludes repository state, credentials, private Ling configuration,
symlinks, hardlinks, generated directories and dependency trees. Reads use bounded
no-follow regular-file access and verify file identity before and after reading.
Imports and tsconfig cannot cause reads outside that snapshot. No compiler plugin,
project script, package install, network fetch or emit operation is allowed.

The snapshot defaults to the source file's directory, or `path` for `repo_map`.
Optional `scope` selects a workspace-relative directory; the target must remain within
it. Snapshot reads pass the ordinary Host `read` approval policy for that directory.
The compiler profile is fixed to strict ES2022/bundler, with JS/JSX support; it does
not load tsconfig, path aliases or package types. Diagnostics describe this profile,
not the project's build configuration. Dependencies are always reported as excluded.

Initial limits: 256 source files, 1 MiB per file, 8 MiB total source, 4,096 traversal
entries, depth 16, five seconds for capture and 32 KiB returned JSON. Queries return
at most 100 items (default 50). The language service runs in a separate worker with a
192 MiB heap limit, ten-second deadline and two-worker process capacity. Cancellation
terminates the worker. A fresh snapshot is built per query, so successful edits are
visible on the next call without a background watcher. A persistent index and
multi-language LSP management are later adapters.

Example tool inputs:

```json
{"operation":"definition","path":"src/example.ts","scope":"src","line":12,"column":9}
```

```json
{"operation":"repo_map","path":"src","query":"handler","limit":30}
```

Results include `snapshot`, `compilerProfile`, `coverage` and `truncated`. Coverage
reports the selected scope, captured files/bytes, known omissions and partial capture.
Bounds and dependency exclusion must be considered before interpreting an empty result.

## Code Mode

`code_mode({code})` executes an async JavaScript body in the existing Pi QuickJS/WASM
worker runtime. It supports `await`, `Promise.allSettled`, `tools.<name>(input)`,
`ALL_TOOLS`, `text()` and returned JSON. Script storage is execution-local and is not
a durable checkpoint or cross-run memory.

The Host exposes only the session's selected, callable tools. Recursive Code Mode,
permission escalation and run-control/delegation tools are excluded in the first
release. Tool schemas are discoverable without granting execution rights. MCP calls
remain behind the existing MCP approval and broker paths, including hydrated tools.
No Node globals, filesystem, network, imports, timers, credentials or direct model API
are exposed to the VM.

Limits are 64 KiB code, 30 seconds, 64 MiB VM memory, 32 KiB returned text, 32 nested
calls and four script workers per process (shared with script Hooks). Up to four
read tools overlap; an effect or unclassified tool waits for earlier reads and
excludes later calls. Calls launched without awaiting them count toward the budget.
Exhausting the call budget aborts the script even if it catches a tool rejection.
Output truncation is explicit. Failed nested calls reject in JavaScript so scripts
can choose `allSettled`; partial output and call receipts remain on script failure.

Pending nested calls have two seconds to drain after VM termination. An interrupted
effect or an undrained child closes the Run boundary; the model cannot continue or
automatically replay the call. A child deadline cancels its own pending approval using
the captured execution fence. A Run-wide cancellation retains the existing cleanup.

Use the existing SDK nested executor rather than calling a tool's `execute` method
directly. Nested events retain `parentToolCallId` in durable Run events. Preparation
registers schemas only and cannot start a worker or call a tool.

Example `code_mode` body, returning only the selected data to the model:

```javascript
const results = await Promise.allSettled([
  tools.code_intelligence({ operation: "symbols", path: "src/a.ts" }),
  tools.code_intelligence({ operation: "symbols", path: "src/b.ts" })
]);
text(results.map(result => result.status === "fulfilled"
  ? JSON.parse(result.value.content[0].text).items
  : { error: String(result.reason) }));
```

## Lifecycle Hooks

### Configuration And Trust

Hooks are selected by the Host, not registered from arbitrary SDK extension paths.
User configuration is `${resolveUserConfigPaths().rootDir}/hooks.json`, normally
`~/.ling-stack/hooks.json` and respecting `LING_STACK_HOME`. This file must be outside
the workspace, owned by the current user and not group/other writable. Configuration
reads reject symlinks and hardlinks, cap files at 64 KiB and verify file identity.
A workspace may propose `.ling/hooks.json`; it is loaded only when the user file pins
the canonical workspace root and exact SHA-256 digest of its bytes. Editing the
project file revokes that pin until deliberately updated. Configurations are strictly
parsed and frozen into prepared execution input. Recovery rejects configuration drift.

Each hook declares a unique id, lifecycle event, optional exact tool names, timeout,
error policy and either a JavaScript policy script or a shell command:

- `before_tool`: may deny a call with a reason; cannot grant access or rewrite input.
- `after_tool`: observes success/error; cannot replace tool output or mark failure as success.
- `run_start`: runs after execution admission, before the first model request.
- `run_end`: runs after normal model settlement, before the durable settled checkpoint;
  cancellation and failure do not start cleanup commands.

Script hooks run in the same bounded QuickJS VM with JSON event input and no tool or
model access. A `before_tool` script may return `{decision:"deny", reason:"..."}`.
Other results are observations. Command hooks enter the existing Host `bash` approval
and execution path with event JSON supplied as a safely quoted environment value.
They require `bash` in the original selected tools and cannot use another tool's grant.
No configuration setting skips approval, selects a new workspace or enables network.

For a Git workspace with `bash` selected, a user configuration can require a final
whitespace check through the ordinary command approval:

```json
{
  "schemaVersion": 1,
  "hooks": [
    {
      "id": "git-whitespace",
      "event": "run_end",
      "kind": "command",
      "command": "git diff --check",
      "timeoutMs": 20000,
      "failurePolicy": "block"
    }
  ],
  "trustedProjects": []
}
```

A project proposal can restrict generated-file writes:

```json
{
  "schemaVersion": 1,
  "hooks": [
    {
      "id": "generated-sources",
      "event": "before_tool",
      "tools": ["write", "edit"],
      "kind": "script",
      "code": "return {decision: event.input.path.startsWith('generated/') ? 'deny' : 'allow', reason: 'Generated sources are managed by the build.'};"
    }
  ]
}
```

After reviewing the project file, compute its digest with `shasum -a 256 .ling/hooks.json`
and put `{"root":"/absolute/canonical/project","digest":"sha256:<64 hex digits>"}` in
the external user file's `trustedProjects`. The digest covers exact bytes, including
whitespace. Tool matching is exact; this example covers `write`/`edit`, not shell writes.
No project configuration is loaded without that explicit pin.

### Dispatch, Failure And Audit

Hook order is deterministic. Exact event/tool matching avoids executable regular
expressions. Hook-generated command calls do not recursively dispatch Hooks. Nested
Code Mode calls do dispatch Hooks once for their own event. Limits apply per hook and
per run. At most 32 definitions are selected, with unique ids across both sources;
source is limited to 16 KiB, event JSON to 32 KiB and dispatch to 256 invocations.
Timeout defaults to five seconds and accepts 10–30,000 ms. Run cancellation prevents
later dispatch. An observer script timeout follows its declared failure policy.

`before_tool` and `run_start` fail closed by default. `after_tool` and `run_end` record
failure and continue by default; an explicit blocking policy stops later execution
but cannot undo a completed effect. An interrupted command always closes the Run
boundary, including when its failure policy is `continue`. A blocking failure survives
the SDK's diagnostic-only exception handling. Audit receipts identify hook id, config
digest, event, source tool call, outcome and elapsed time. Existing event redaction
still applies; Hook source/configuration must not contain credentials.

Recovery does not replay `run_start`. Command Hooks reject execution during compaction,
ordinary-progress or approved-tool recovery and require a fresh Run; this avoids
repeating an effect without durable reconciliation. Script Hooks may observe restored
execution. A restored complete view does not dispatch `run_end` again.

Hooks are a lifecycle extension mechanism. They do not implement an arbitrary plugin
runtime, marketplace, automatic self-modification or an external event scheduler.

## External-Event Automations

Signed ingress reuses AutomationDefinition/AutomationRun and ordinary Run admission:

```text
authenticated source -> durable inbox -> matching rule -> AutomationRun -> Run
                                                        -> delivery outbox
```

Migration 221 owns sources, inbox events, dispatch leases, deliveries and receipts.
Source management uses `GET/POST /automation-event-sources?cwd=...` and
`GET/PUT /automation-event-sources/:id?cwd=...`. POST/PUT takes `{source,
expectedRevision}`; updates require the current revision. A source binds an adapter
(`webhook`, `github` or `business`), one or two secret references, enabled state,
optional GitHub repository and rules. A rule selects one existing automation, exact
event types, optional dot-path equality predicates and up to eight existing enabled
IM destination ids. Configuration never accepts raw secrets. A second secret reference
permits key rotation; replacing the source increments its revision and revokes queued
work under the prior revision.

`POST /automation-event-sources/:id/events?cwd=...` accepts a UTF-8 JSON object of at
most 64 KiB. Generic/business requests supply `x-ling-event-id`, `x-ling-event-type`,
`x-ling-event-timestamp` (ISO timestamp) and `x-ling-signature-256`. The signature is
`sha256=<lowercase hex HMAC-SHA256>` over the exact bytes
`timestamp.eventId.eventType.` followed by the raw request body. GitHub uses its
`x-github-delivery`, `x-github-event` and `x-hub-signature-256` raw-body signature;
only `issues` and `issue_comment` from the configured `owner/repository` are accepted.
Types normalize to `github.issues.<action>` or `github.issue_comment.<action>`.
The generic timestamp, or the issue/comment `updated_at`, must be within five minutes
of receipt. Delayed GitHub events outside this window are rejected.

Only this exact ingress POST bypasses daemon bearer authentication; its HMAC is
mandatory. The workspace must already be initialized and trusted. Management routes
remain local-service-only. Authentication precedes persistence; source/external id
retries return the original event, changed bytes under the same id are rejected, and
GitHub also deduplicates raw payload digests. Limits are 100 accepted events per source
per minute and 5,000 pending dispatches per workspace. Payloads are redacted untrusted
task data and cannot change tools, workspace, approvals or destinations.

Source revision, enabled definition and definition digest are rechecked immediately
before execution. A durable lease and stable event/definition idempotency key recover
accepted work through the existing automation owner. Busy automations retry every two
seconds, with a 100-attempt dispatch cap; failures remain visible in
`GET /automation-events?cwd=...`. The worker starts for enabled persisted sources when their trusted workspace opens,
accepted ingress and scheduler registration; it does not scan arbitrary workspaces.

Terminal Runs create one outbox item per explicitly bound destination. Delivery uses
the existing secret-resolved, egress-pinned IM dispatcher with redirects disabled,
a ten-second request deadline and a stable `idempotency-key`. The body contains Run id,
terminal status and bounded redacted final assistant text/error. Source configuration
is the explicit authorization for this result relay; model output cannot add recipients.
An AutomationRun that fails before creating a Run remains visible locally and has no
Run-result delivery. Other automation output proposals retain their existing approval
path.

A send has a thirty-second durable lease. Pre-dispatch failures and explicit HTTP 429
responses have bounded backoff and five attempts. Uncertain remote outcomes and
interrupted sending leases become `unknown` and are never automatically replayed.
`GET /automation-deliveries?cwd=...` exposes delivery state;
`POST /automation-deliveries/:id/reconcile?cwd=...` requires
`{expectedUpdatedAt,decision,reason}`, where decision is `delivered`, `retry` or `failed`.
The local user's CAS decision records a receipt before an explicit retry. Run success
and delivery success remain separate facts; remote exactly-once delivery is not promised.

## Selective Rerun

F5-01/02/03 retain pure evaluation, Host observation and the read-only admission plan.
`POST /runs/:id/node-rerun/submit?cwd=...` consumes `{intent,planFingerprint}`. It
re-observes the source and current policy inside the same Host writer transaction,
requires a matching reviewed plan, and atomically records the submission and successor
workflow. `GET` on the same path with `idempotencyKey=...` reads its result.

The source workflow must be terminal and quiescent, with settled effects, no active
lease/Attempt or pending approval. Unknown and pending effects block submission;
known external effects on invalidated nodes also block replay. This implementation
supports ordinary materialized workflow graphs. Template compilation, participant
manifests/intent authority, delegated requirements, execution plans and safety/isolation
profiles remain explicitly unsupported and fail closed.

Only the target and transitive downstream nodes become queued successor steps.
Unaffected successful/skipped nodes retain their results and immutable artifact pins.
Historical workflows, steps and Runs remain intact; the source workflow is durably
retired from dispatch. Duplicate submissions return the same successor, while changed
intent, plan, source snapshot or a second request for the same source conflicts.

The normal workflow orchestrator owns dependency scheduling, fresh Run/WorkUnit/Attempt
creation, current-policy approval and cancellation. Fences are new Attempt-bound tuples;
their numeric token need not differ across distinct WorkUnits. Durable supervision
recovers pending successors after restart and checks reused step/artifact pins before
dispatch. Missing or changed reused evidence blocks the successor. Cancelling a
successor never resumes its retired source or authorizes replay of an uncertain effect.

## Goal Acceptance And Long-Term Supervision

Migration 222 stores rerun submissions and adds Goal criteria, criterion/evidence
bindings and supervision policy. Existing Goal create/replace/PATCH routes accept
`acceptanceCriteria` and `supervisionPolicy`; the complete route accepts
`acceptanceEvidence` alongside current completion evidence and a verification summary.
Criteria declare `id`, `description`, `kind` (`run_succeeded`, `workflow_succeeded` or
`artifact`), optional exact `evidenceId` and optional artifact `contentSha256`.

Completion verifies persisted evidence in the writer transaction: thread/workflow scope,
creation after the Goal, terminal success, complete workflow steps and sealed artifact
content digests. Pending Runs or approvals prevent completion. Each declared criterion
needs a matching evidence binding among the submitted current proof. Historical refs
remain stored, including failed Runs, but do not become required successful proof for a
later completion. An agent's completion without criteria still needs explicit verified
evidence and a summary; a model summary alone is insufficient.

Policy defaults retain three continuations and two no-evidence continuations.
`maxContinuations` accepts 1–1,000, `maxNoEvidenceContinuations` 1–10, and optional
`maxTimeSeconds` 1–2,592,000. `autoContinue` defaults true; `retryFailedRuns` and
`autoComplete` default false. Automatic completion additionally requires all criteria
to name exact evidence ids. Token/time budgets, user pause, plan mode, blockers, pending
work/approvals, authority changes and no-evidence limits stop scheduling visibly.

Continuation accounting and a fixed source/Goal intervention key commit atomically.
Restart recovers visible queued interventions through the existing Run owner. Explicit
resume can requeue an intervention stopped by changed Goal authority without consuming
another continuation depth. The supervisor does not create a second task engine or
replace existing Host recovery. Acceptance, execution completion and external delivery
are independent states.

## Validation And Release

Use behavior and boundary tests in TypeScript, discovered and typechecked by their
owning packages. Cover real Runner registration/dispatch and Host snapshot integration,
in addition to parser/unit tests. Required negative cases include restricted profiles,
stale fences, symlink/secret escape, configuration drift, blocked approval, nested call
limits, recursion, worker timeout and cancellation. Existing recovery, prepared-input,
approval and workflow safety regressions must remain green.

Local source/test completion does not establish live Provider quality, native runner
support, packaged Windows/macOS resource lookup, publication, merge or deployment.

C1–C3 have local Pi/daemon behavior and boundary coverage, including a loopback Provider
fixture through real SDK dispatch, SQLite, the approval API and the journaled Host
command executor. The fixture verifies cross-file code lookup, nested event lineage,
Hook receipts and frozen configuration. It makes no external Provider or messaging
request. A1/A2 tests exercise signed ingress, durable claim/reopen, matching and
unknown-delivery reconciliation. A loopback HTTP -> Pi -> Host -> SQLite -> mock IM
fixture verifies one Run per event, explicit destination scope and redacted delivery.
R1/R2 tests cover A -> B -> C with independent D, atomic successor/reuse, stale plan,
reopen, duplicates, effect rejection and real local Host execution. R3 tests verify
criterion binding, terminal/sealed evidence, atomic continuation, pause/budgets and
restart supervision. These fixtures send no real external message.
