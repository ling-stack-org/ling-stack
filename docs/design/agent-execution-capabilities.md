# Agent Execution Capabilities

Status: C1–C3 locally implemented; automation/rerun planned; release gates open
Owner: Runner and daemon maintainers
Last verified: 2026-11-16
Document type: design contract

## Scope And Existing Owners

This contract covers code intelligence, Code Mode and lifecycle Hooks. It also defines
the integration boundaries for external-event automations and selective rerun. Delivery
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

## External-Event Automation Boundary

Planned ingress reuses AutomationDefinition/AutomationRun and the ordinary Run queue:

```text
authenticated source -> durable inbox -> matching rule -> AutomationRun -> Run
                                                        -> delivery outbox
```

The first source is a generic signed Webhook; later adapters normalize GitHub issues,
messaging, alerts and business events into the same envelope. An envelope includes
source id, external event id, type, timestamp, workspace binding, payload digest and
bounded redacted payload. Authentication/signature verification precedes persistence;
source+event id deduplicates retries, with digest conflicts rejected. Timestamp windows,
rate limits and source scope are enforced before queueing. Secrets are resolved by the
Host and never embedded in prompt templates or event rows.

Definitions select allowed event types and deterministic field predicates. Payloads
are untrusted task data. A trigger cannot widen workspace/tool permissions, bypass an
approval, send a message or execute a shell command. Disabled definitions do not launch
work. A durable claim creates at most one AutomationRun per matched definition/event;
restart, bursts, backpressure and dead-letter handling preserve that relationship.

Results first appear in Ling's existing automation thread. External delivery is an
explicit, destination-scoped policy backed by an outbox with retry, idempotency and
delivery receipts. A completed Run and a delivered result are separate states. Unknown
external submission remains unknown until reconciled, rather than being blindly retried.
Hooks may observe ingress/delivery later, but ingress never depends on running a hook.

## Selective Rerun And Long-Term Completion Boundary

F5-01/02/03 already provide pure evaluation, Host observation and a read-only admission
plan. Actual submission must consume a still-current plan in one Host transaction:

1. Recheck source graph/input/artifact revisions, terminal state, leases, effects,
   policy and the idempotency key. A plan digest is evidence, not authority.
2. Create a successor execution revision, Run/WorkUnit/Attempt and fresh fence. Keep the
   original successful results and immutable lineage; never rewrite historical success.
3. Invalidate only the transitive dependency closure whose pinned inputs changed.
   Unaffected successful nodes retain their verified artifacts and are not resubmitted.
4. Queue through the normal admission/approval path. Prior approvals and completed
   external effects are never inherited as permission to repeat an operation.
5. Reconcile duplicate requests, cancellation, restart and uncertain effects before
   scheduling dependents. Unknown effects block the affected closure.

Goal continuation remains a supervisor over visible queued work. A bounded continuation
chain must use actual evidence delta and explicit acceptance criteria; model text alone
cannot mark an objective achieved. Budgets, no-progress detection, pending approvals,
user pause and blocker handling stop continuation. Extend policy only after selective
rerun submission/recovery works; do not obtain long-running behavior by simply removing
the current three-continuation guard. Acceptance evidence, execution completion and
result delivery are independent facts.

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
request. Automation ingress/delivery and selective rerun remain design-only.
