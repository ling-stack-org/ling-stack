# Codex-Inspired Runtime Tools P2B: Shell Snapshots Follow-Ups

## Status

P2B-F1 and P2B-F2 are implemented as read-only visibility/diagnostic surfaces.
P2B-F3 remains deferred after the first evaluation pass.

P2B.1 is already implemented as the minimal diagnostic loop:

- automatic `exec_start` and terminal `exec_end` snapshots for approved unified exec
  `bash` calls;
- JSON/text snapshot artifacts under the existing run artifact store;
- read-only daemon list/detail APIs;
- api-client methods;
- CLI inspection commands;
- daemon and CLI tests for feature gating, redaction, deny/ask/success/failure/timeout
  and cancellation paths.

P2B-F1 adds Web run-history rendering over the existing list API. P2B-F2 adds a
read-only `ling-stack doctor` check over runner capability, recent run snapshot APIs,
and run artifact metadata. This document now tracks the remaining follow-ups and,
equally important, what must stay out of the shell snapshot line.

## Related Docs

- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [CLI v0.1](cli-v0.1.md)
- [Daemon lifecycle and doctor P0](daemon-lifecycle-p0.md)
- [Runtime Supervisor](runtime-supervisor.md)

## Problem

P2B.1 creates enough evidence to answer:

- what approved command started;
- whether it exited, failed, timed out, or was cancelled;
- where its bounded redacted output and result artifacts are;
- which approval, run, task, and tool call produced it.

That is useful but intentionally sparse. The next choices are different in kind:

- some are visibility improvements over already-stored P2B.1 evidence;
- some add new runtime capture points while a process is active;
- some are optional infrastructure optimizations;
- one, using snapshots for run recovery, must remain a permanent non-goal.

Without a follow-up split, P2B can easily expand into terminal replay, hidden process
recovery, or a parallel run state system. Those are not the intended product or safety
model.

## Guiding Principles

### 1. Evidence, Not Authority

Shell snapshots are diagnostic artifacts. They may support user understanding, doctor
warnings, or Web inspection. They must not become the source of truth for:

- run status;
- work-unit status;
- continuation state;
- process recovery;
- resume context;
- approval state.

### 2. Read-Only Surfaces Before New Capture Complexity

P2B.1 already stores useful artifacts. Web and doctor can expose those artifacts without
changing runtime execution behavior. Prefer visibility work before adding periodic capture
unless there is clear debugging pressure for active-process snapshots.

### 3. Runtime Capture Must Stay Bounded

Any future active snapshot must have explicit limits:

- max snapshots per tool call;
- min interval between periodic snapshots;
- max bytes per output head/tail;
- max JSON/text artifact size;
- no raw environment values;
- no raw secrets in command, output, events, logs, APIs, Web, or CLI.

### 4. Feature Gates Are Runtime Configuration

Shell snapshot behavior is a runtime feature, not a Plugin Manager installable plugin.
Do not add Plugin Manager cards for shell snapshots or Ling core tools.

### 5. No Hidden Runner Mutation

P2B follow-ups must not mutate Pi's active tool registry, switch to Codex app-server
JSON-RPC, or inject hidden prompts into active runner sessions. Continue using the
embedded Pi library runner path unless a separate runner migration design explicitly
changes that boundary.

## Follow-Up Tracks

| Track | Name | Runtime Risk | User Value | Default Priority |
| --- | --- | --- | --- | --- |
| P2B-F1 | Web read-only snapshot surface | Low | Makes existing evidence visible in run history | Implemented |
| P2B-F2 | Doctor read-only diagnostics | Low | Detects missing/corrupt snapshot artifacts and config mismatch | Implemented |
| P2B-F3 | Active output snapshots | Medium | Captures first output, periodic state, and pre-kill evidence | Deferred pending evidence |
| P2B-F4 | Durable snapshot index/cache | Medium | Speeds lookup only if artifact scanning becomes insufficient | Low |
| P2B-F5 | PTY snapshots | High | Captures terminal visible text after unified exec supports PTY | Deferred |
| P2B-F6 | Manual capture | Medium | Explicit user-triggered diagnostic snapshot | Deferred |
| Permanent | Run recovery source | Unacceptable | Not applicable | Never |

The track names use `F*` to avoid implying that every follow-up must land in numeric
order. Implementation order can change, but each track should keep its boundary.

## Recommended Ship Order

### Step 1: P2B-F1 Web Read-Only Snapshot Surface

Status: implemented.

The Web surface consumes the already implemented P2B.1 APIs from run detail.

Goal:

- expose snapshot count and terminal status in run evidence;
- link to snapshot JSON/text artifacts;
- show compact fields only: status, source, command preview, duration, exit code,
  tool call, and artifact ids;
- avoid rendering unbounded stdout/stderr inline.

Why first:

- no runtime capture changes;
- validates whether users actually inspect snapshots;
- gives a consumer for later active snapshots.

Non-goals:

- no new daemon routes;
- no manual capture button;
- no terminal replay panel;
- no live process attach.

Acceptance:

- Web run history can show snapshots for completed `bash` calls;
- missing snapshots render as "none" or a warning, not an error page;
- no raw secret values appear in DOM, serialized state, logs, or screenshots;
- rendered smoke covers page health and the missing-route/warning path; richer fixture
  coverage can be added when the Web test harness grows mock daemon fixtures.

### Step 2: P2B-F2 Doctor Read-Only Diagnostics

Status: implemented.

Doctor now has one read-only `runtime.shell_snapshots` check over existing P2B.1 state.

Goal:

- report whether shell snapshot runtime capability is advertised by runners;
- inspect recent runs through `GET /runs/:runId/shell-snapshots?cwd=...`;
- compare listed snapshots against run artifact metadata;
- warn when snapshot JSON artifacts are not listable, text pairs are missing, or the
  route cannot be read;
- keep doctor useful after daemon restart when `cwd` is provided.

Data sources:

- daemon health/runtime capability shape;
- run artifact metadata;
- `GET /runs/:runId/shell-snapshots?cwd=...`;
- artifact content APIs only when needed for validation.

Non-goals:

- doctor must not trigger capture;
- doctor must not repair artifacts;
- doctor must not start or stop runs;
- doctor must not treat snapshots as live process state.

Acceptance:

- `ling-stack doctor --json` remains redacted;
- doctor works when no snapshots exist;
- doctor warns, rather than crashes, on corrupt snapshot artifacts;
- tests prove doctor does not call mutation routes.

### F3 Evaluation After F1/F2

Do not implement P2B-F3 in the same slice. F1 and F2 expose the current diagnostic
evidence and the important failure modes without changing runtime capture behavior:

- Web can show snapshot list/detail links when routes are present and a clear warning
  when a running daemon predates the route.
- Doctor can prove whether capability and artifact-backed list APIs are healthy using
  only GET routes.
- P2B.1 already captures start/end evidence, which is enough for completed command
  triage and route/artifact health.

The first version should only add active snapshots if users hit a concrete evidence gap:

- long-running commands fail or hang before terminal `exec_end` is written;
- timeout/cancel evidence is needed before process termination;
- first output is needed to distinguish "started but silent" from "started and producing
  useful output";
- Web or doctor reports enough missing terminal context that start/end artifacts are not
  enough for debugging.

Until one of those appears, P2B-F3 stays deferred. If it is resumed, implement only
`exec_first_output`, `exec_periodic`, `exec_timeout`, and `exec_cancel` with the bounded
limits below. Do not add PTY, manual capture, durable tables, or recovery semantics as
part of F3.

### Step 3: P2B-F3 Active Output Snapshots

Add bounded capture points while unified exec is still running.

Candidate sources:

- `exec_first_output`: first stdout/stderr output after process start;
- `exec_periodic`: coarse interval snapshots for long-running commands;
- `exec_timeout`: snapshot just before timeout termination begins;
- `exec_cancel`: snapshot just before cancellation termination begins.

Design requirements:

- keep one monotonic sequence per `toolCallId`;
- capture from internal redacted stream state, not raw daemon logs;
- use head/tail buffers with byte caps;
- default to a low max snapshot count, for example:
  - first output: max 1;
  - periodic: max 10;
  - timeout/cancel: max 1 each;
- add explicit test fixtures for large output and secret carry-over across chunks.

Runtime boundaries:

- snapshot writes are best-effort diagnostics;
- a snapshot write failure must not fail an already approved command;
- an active snapshot must not delay process termination beyond a bounded small budget;
- no attempt to reconstruct full terminal state for non-PTY commands.

Acceptance:

- long-running command creates bounded periodic snapshots when enabled;
- first-output snapshot appears at most once;
- timeout/cancel snapshots are created before process kill when possible;
- large output does not grow memory unbounded;
- snapshot count limits are enforced.

### Step 4: P2B-F4 Durable Snapshot Index Or Cache

Keep this optional. P2B.1 intentionally uses artifact metadata and JSON content as the
source of evidence.

Consider a durable index only if at least one of these becomes true:

- listing snapshots by run/tool call is measurably slow;
- Web needs pagination/filtering across many snapshots;
- doctor needs cheap health checks over many recent runs;
- retention policy needs explicit snapshot metadata without reading files.

Allowed shape:

- a derived index/cache keyed by `runId`, `toolCallId`, `snapshotId`, `artifactId`;
- rebuildable from artifact metadata/content;
- never authoritative for run status or recovery.

Disallowed shape:

- source-of-truth snapshot table that can diverge from artifacts;
- process recovery state;
- resume context source;
- run/work-unit state mirror.

Acceptance:

- deleting the index and rebuilding from artifacts restores equivalent list/detail
  metadata;
- missing/corrupt artifacts produce warnings, not invented snapshot content;
- run recovery code does not read the snapshot index.

### Step 5: P2B-F5 PTY Snapshots

Defer until unified exec supports PTY execution. P2B must not add PTY capture by itself.

Preconditions:

- unified exec can start PTY-backed commands;
- PTY command input/output semantics are tested;
- terminal size and resize behavior are modeled;
- ANSI parsing and visible text redaction have a bounded implementation plan.

PTY snapshot fields may include:

- rows/cols;
- visible text;
- cursor position;
- process metadata;
- bounded output head/tail.

Non-goals:

- no terminal replay;
- no interactive shell attach;
- no unbounded screen scrollback;
- no hidden keystroke capture beyond explicit unified exec semantics.

Acceptance:

- PTY visible text is redacted;
- ANSI escape parsing cannot create unbounded memory growth;
- resize and non-UTF-8 output are handled predictably;
- PTY snapshots remain artifacts, not recovery state.

### Step 6: P2B-F6 Manual Capture

Defer until automatic snapshots prove insufficient in real debugging workflows.

Allowed version:

- explicit user action;
- read-only diagnostic capture;
- writes one snapshot artifact pair;
- includes actor/reason metadata;
- requires a visible command/API surface and tests.

Disallowed version:

- background automatic manual-like capture;
- capture that sends input to the process;
- capture that changes process state;
- hidden capture triggered by doctor;
- capture as a way to recover or resume runs.

Acceptance:

- manual capture endpoint, if added, rejects terminal runs without active process state;
- user intent is visible in events/artifacts;
- doctor never calls it;
- permissions and audit trail are explicit.

## Permanent Non-Goal: Run Recovery Source

Shell snapshots must never become run recovery source material.

Recovery belongs to:

- run status transitions;
- work-unit state;
- runtime supervisor records;
- runner contracts;
- explicit continuation/interruption metadata;
- durable approvals and grants.

Shell snapshots may be shown beside recovery/debugging UI as evidence, but recovery code
must not parse snapshot artifacts to decide whether a run should resume, retry, or repair
itself.

Tests for any future recovery code should include a guard that deleting all shell
snapshot artifacts does not change recovery decisions.

## API And Contract Evolution

P2B.1 APIs:

```http
GET /runs/:runId/shell-snapshots?cwd=...
GET /runs/:runId/shell-snapshots?cwd=...&toolCallId=...
GET /runs/:runId/shell-snapshots/:snapshotId?cwd=...
```

Future additions should prefer additive fields and query parameters.

Allowed additive fields:

- `captureReason`;
- `actor`;
- `output.stdoutTail`;
- `output.stderrTail`;
- `terminal` fields after PTY support;
- `snapshotLimit`/`snapshotDroppedCount` summaries.

Avoid:

- route names that imply live shell access;
- mutation routes before manual capture is explicitly designed;
- fields named `recoverable`, `resumeState`, `checkpoint`, or similar.

## Test Matrix

Every follow-up should keep the P2B.1 tests and add focused coverage:

| Area | Required Tests |
| --- | --- |
| Redaction | command, stdout, stderr, artifact text, API response, Web state, doctor JSON |
| Bounds | large output, many snapshots, periodic interval, text artifact size |
| Gating | daemon config off, request tries to enable, unsupported runner capability |
| Failure | corrupt JSON artifact, missing text artifact, artifact content 404 |
| Cancellation | pre-kill snapshot best effort, no late run status overwrite |
| Timeout | timeout snapshot best effort, no blocked termination |
| Restart | list/detail works with `cwd`, no process-state reconstruction |
| Recovery guard | snapshots absent or corrupt do not change run/work-unit recovery decisions |

## Open Questions

- Should Web land before doctor, or should both ship together as one read-only visibility
  slice?
- Should active snapshots use a default periodic interval, or require an explicit
  runtime config value before enabling?
- Should text artifacts be generated for active snapshots, or should active snapshots
  store JSON only and render text on demand?
- Do we need a snapshot retention policy, or is existing artifact retention sufficient
  for now?
