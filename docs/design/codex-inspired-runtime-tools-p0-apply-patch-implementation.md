# Codex-Inspired Runtime Tools P0: Apply-Patch Implementation

## Status

Implemented for the P0 patch-shaped mutation path.

The first shipped slice adds a Ling-owned apply-patch parser/planner in
`@ling-stack/core`, daemon-side approval preview and post-approval application for
patch-shaped `write`/`edit` requests, runner-pi `edit`/`write` overrides that let the
daemon return handled patch results, and CLI/Web summaries for structured patch
approvals. Legacy non-patch `edit`/`write` requests still use the existing approval path
and Pi's original tool implementations after approval.

This document details P0 from
[Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md): introduce a
Ling-owned apply-patch engine for `edit` and patch-shaped `write` operations while
preserving Ling's core tool, approval, runner, daemon, Web, and CLI boundaries.

## Goal

Make file mutations more auditable and safer by replacing ad hoc edit/write payload
handling with a structured patch path:

```text
runner proposes patch
-> daemon parses and validates patch
-> daemon creates preview artifact and approval request
-> user approves or denies
-> daemon applies patch only after approval
-> daemon records result artifact and execution action evidence
```

This is not a switch to Codex's product model. Ling keeps `edit` and `write` as core
tools governed by approval policy and allowed write paths.

## Non-Goals

- No direct dependency on Codex runtime crates.
- No replacement of `runner-pi`.
- No shell-only fallback for file edits.
- No bypass around `allowedWritePaths`.
- No mutation before approval.
- No Web-only patch parsing.
- No Plugin Manager involvement.
- No P1 unified exec implementation in this slice.

## Existing Boundaries To Preserve

- `edit` and `write` default to `ask`.
- The daemon owns approval creation, approval decisions, artifacts, and state
  transitions.
- The runner can request a file mutation, but it does not apply it if approval is
  required.
- Denied, expired, or cancelled approvals must leave files unchanged.
- Path policy is evaluated relative to the run execution `cwd`, with explicit support
  for absolute allowed paths only where current approval policy already permits it.
- Web and CLI display durable server-generated previews. They do not independently
  interpret unsafe patch input.

## Patch Format

Use a Codex-compatible subset first. The parser should accept this envelope:

```text
*** Begin Patch
*** Add File: path
+new line
*** Update File: path
@@
 context line
-old line
+new line
*** Delete File: path
*** End Patch
```

P0 deliberately supports a narrow subset:

- add file;
- update file with hunk context;
- delete file;
- optional `*** End of File`;
- optional `*** Move to: path` only if it can be implemented safely in the same
  validation model.

P0 rejects:

- absolute patch target paths;
- `..` path traversal after normalization;
- symlink traversal outside allowed scope;
- binary patch bodies;
- unknown directives;
- empty patches;
- patches that touch zero files;
- patches that modify files outside `allowedWritePaths`;
- patches that cannot be applied against the current file content.

The first implementation can omit `Move to` if rename semantics would delay the safe
path. A compatible subset is better than broad grammar with weak validation.

## Data Model

Add a shared core representation so daemon, tests, Web contracts, and CLI outputs can
refer to one shape:

```ts
type PatchOperationKind = "add" | "update" | "delete";

interface PatchPlan {
  readonly format: "ling-apply-patch-v1";
  readonly operations: readonly PatchOperation[];
  readonly touchedPaths: readonly string[];
  readonly summary: PatchSummary;
  readonly rawPatchSha256: string;
}

interface PatchOperation {
  readonly kind: PatchOperationKind;
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
  readonly oldSha256?: string;
  readonly newSha256?: string;
}

interface PatchHunk {
  readonly oldStart?: number;
  readonly oldLines?: number;
  readonly newStart?: number;
  readonly newLines?: number;
  readonly lines: readonly PatchLine[];
}

interface PatchLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

interface PatchSummary {
  readonly fileCount: number;
  readonly addCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly moveCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
}
```

The wire response and artifacts should store normalized paths and summaries, not raw
absolute host paths.

`move` / rename semantics remain a future extension. P0 rejects `*** Move to:` rather
than carrying unused destination fields in the shipped plan shape.

## Package Placement

Recommended package layout:

```text
packages/core/src/patch/
  apply-patch-types.ts
  parse-apply-patch.ts
  validate-apply-patch.ts
  plan-apply-patch.ts
  render-patch-preview.ts
  index.ts

packages/daemon/src/features/runs/
  patch-actions.ts
```

Core owns pure parsing/planning utilities because they are testable without daemon state.
Daemon owns filesystem reads, path policy, artifact writing, approval creation, and final
mutation.

Do not put the parser in Web. Web receives durable preview artifacts and structured
approval payloads.

## Daemon Flow

### 1. Runner Tool Request

When the runner requests `edit` or patch-shaped `write`, the daemon should normalize the
request into:

```ts
interface PatchApprovalInput {
  readonly toolName: "edit" | "write";
  readonly cwd: string;
  readonly patchText: string;
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
}
```

If the runner sends legacy non-patch edit/write payloads, P0 may either:

- convert them to patch format only when deterministic and lossless; or
- keep the existing path and mark it as legacy in approval previews.

The safer first implementation is to support patch-shaped requests first, then migrate
legacy payloads in a later cleanup.

### 2. Parse

Parsing produces either:

- `PatchPlan`, or
- a structured parse error with line number, directive, and readable message.

Parse errors fail closed before approval creation because there is no safe preview.

### 3. Validate Paths

For each touched path:

- resolve against run `cwd`;
- normalize;
- reject traversal;
- reject paths outside allowed write scopes;
- reject writes to `.ling-stack` internal state unless explicitly allowed by policy and
  a future system-owned operation needs it;
- resolve symlinks for existing path ancestors;
- reject symlink escapes outside allowed scopes.

Validation should produce a `PatchPolicyDecision`:

```ts
interface PatchPolicyDecision {
  readonly ok: boolean;
  readonly deniedPaths: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly reason?: string;
}
```

Denied path policy should create a denied approval/action record only if the current run
flow already records denied tool attempts. It must not create a user-actionable approval
that could bypass policy.

### 4. Plan Against Current Content

Before approval:

- read current content for update/delete operations;
- verify hunk context applies;
- compute old and candidate new hashes;
- compute summary counts;
- generate a unified diff preview from the plan.

If any target changed between parse and preview, fail before approval. The final apply
step must re-check the same old hashes.

### 5. Create Preview Artifact

Create two preview artifacts where practical:

```text
approval-preview/<approvalId>/patch.json
approval-preview/<approvalId>/patch.diff
```

`patch.json` contains `PatchPlan`, path policy summary, and conflict diagnostics.
`patch.diff` contains a redacted text diff suitable for Web/CLI display.

Artifact rules:

- no raw secret values;
- no absolute host paths when a relative path is enough;
- bounded diff size with truncation metadata;
- artifact paths stay under `.ling-stack/artifacts`.

### 6. Approval Request

The approval payload should include:

```ts
interface PatchApprovalPayload {
  readonly actionType: "edit" | "write";
  readonly patchFormat: "ling-apply-patch-v1";
  readonly touchedPaths: readonly string[];
  readonly summary: PatchSummary;
  readonly previewArtifactIds: readonly string[];
  readonly rawPatchSha256: string;
}
```

The user approves the planned patch, not a vague "edit files" action.

### 7. Apply After Approval

After approval:

- re-read current target files;
- verify old hashes and hunk context still match;
- create parent directories for add operations only after validation;
- apply changes;
- fsync or otherwise use the strongest practical atomic write pattern available in Node;
- record result artifact with final hashes and changed paths.

If content changed after approval but before apply, fail closed with a conflict result.
Do not try to auto-merge in P0.

### 8. Result Artifact

Create:

```text
execution-result/<toolCallId>/patch-result.json
```

It should include:

- status: `applied`, `conflict`, `denied`, or `failed`;
- touched paths;
- final hashes when applied;
- diagnostics when not applied;
- preview artifact references.

## Web Behavior

Approval cards should render server-provided patch previews:

- summary row: file count, additions, deletions;
- touched path list;
- diff preview from artifact;
- conflict or policy denial reason;
- approve/deny actions using existing approval endpoints.

Web must not parse raw patch text independently. It may render `patch.diff` and structured
`patch.json` returned by daemon APIs.

## CLI Behavior

`ling-stack approvals show <id>` should display:

- action type;
- touched paths;
- summary counts;
- preview artifact ids;
- a bounded diff excerpt when available.

`ling-stack approvals approve <id>` and `deny` continue to use existing endpoints. The
CLI does not apply patches locally.

## Runner-Pi Behavior

P0 should keep runner-pi's external contract stable:

- it still declares support for `edit` and `write`;
- it still pauses before side effects;
- the daemon-side approval bridge owns patch validation and application.

If Pi produces non-patch edit/write payloads today, add a capability flag or prompt
instruction only after the daemon can safely reject malformed patch text.

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Parse error | Fail closed before approval; record readable tool error |
| Path outside scope | Deny/fail closed; no approval can override policy |
| Hunk conflict before approval | Fail closed; no approval created |
| Hunk conflict after approval | Do not apply; record conflict result artifact |
| Approval denied | No file mutation; preview remains for audit |
| Approval expires | No file mutation |
| Daemon crashes after preview | Approval remains pending or terminal; no mutation happened |
| Daemon crashes during apply | On restart, result is reconstructed from filesystem and artifacts where possible; no stale runner completion overwrites terminal state |
| Artifact write fails | Fail closed before approval if preview cannot be persisted |

## Tests

Core tests:

- parse add/update/delete;
- reject malformed directives;
- reject empty patches;
- reject path traversal;
- compute summary counts;
- render bounded diff preview;
- detect hunk conflicts.

Daemon tests:

- approval is created before mutation;
- denied approval leaves files unchanged;
- allowed write paths are enforced;
- post-approval conflict fails without partial writes;
- preview artifacts are created for valid patch approvals;
- result artifacts are linked for applied patches;
- redaction removes configured secret values from preview/result artifacts;
- `.ling-stack` internal paths are rejected by default.

Runner conformance tests:

- `edit` and `write` remain interceptable before mutation;
- malformed patch output fails closed;
- approved patch result is reported back to the runner.

CLI tests:

- `approvals show` displays patch summary and preview references;
- approve/deny still use daemon APIs only;
- `--json` output includes patch summary without raw absolute paths.

Web tests:

- approval card shows patch summary and diff preview artifact;
- denied patch approval stays visible with no result artifact;
- conflict result is visible after failed apply.

## Implemented Slice

Implemented in this P0 pass:

- pure parser, planner, preview renderer, and hash recheck helpers in
  `packages/core/src/patch/`;
- daemon patch normalization, path policy validation, `.ling-stack` rejection, symlink
  escape checks, preview artifacts, approval payload enrichment, post-approval apply,
  and result artifacts;
- runner-pi same-name `edit`/`write` tool overrides that delegate to Ling approval first
  and return daemon-handled patch results when present;
- Web and CLI patch summaries from server-generated approval payloads;
- tests for core parser/planner/conflicts and daemon approval/deny/path-policy flows,
  including resolved provider secret redaction in approval previews and artifacts.

Deferred beyond P0:

- converting legacy Pi `edit` `path+edits` payloads into unified patch plans;
- feature flag wiring for staged rollout;
- richer `approvals show` diff excerpt fetching from artifacts;
- full Web artifact diff viewer improvements;
- optional `Move to` / rename semantics.

The original rollout checklist remains useful for future hardening:

1. Keep parser/planner tests in `packages/core` as the first regression line.
2. Expand daemon patch tests before narrowing legacy edit/write behavior.
3. Add a feature flag if this is enabled outside local development.
4. Remove or narrow legacy edit/write handling only after current Pi payloads are known
   to be patch-shaped or safely convertible.

Potential future feature flag:

```ts
runtime.applyPatchEdits = false
```

Default to off until parser, approval, and conflict tests pass.

## Acceptance Criteria

- A patch-shaped `edit` request creates a preview approval before any mutation.
- Approving the request applies exactly the previewed patch or fails with a conflict.
- Denying the request leaves all files unchanged.
- `allowedWritePaths` is enforced before approval and before apply.
- Preview and result artifacts are durable and redacted.
- Web and CLI can inspect the same server-generated preview.
- Plugin Manager remains unchanged and never lists `edit` or `write` as plugin cards.
- Pi remains the default runner.

## Open Questions

- Should `Delete File` require an additional stricter approval profile than update/add?
- Should new file parent directory creation be part of `write` only, or allowed for
  `edit` when the patch contains `Add File`?
- Should patch previews include full diff by default or only bounded excerpts plus
  downloadable artifacts?
- Should `.ling-stack` paths be fully denied or allow system-authored patches in future
  maintenance workflows?
