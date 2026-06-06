# CLI Run I/O and Completion P1 Implementation Plan

## Status

Implemented breakdown for [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md).

This document is the patch plan. It does not replace the P1 boundary design.
The goal is to make P1 implementable as small, reviewable changes without
growing `packages/cli/src/main.ts` further.

## Source Design

Authoritative behavior lives in:

- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [CLI v0.1](cli-v0.1.md)
- [Daemon lifecycle and doctor P0](daemon-lifecycle-p0.md)

Implementation must preserve these boundaries:

- normal run execution still goes through daemon `/runs`,
- no daemon API shape change unless required by a missing event field,
- no approval bypass,
- no MCP config/runtime/auth work in P1,
- no CLI framework migration unless the metadata model cannot support completion.

## Original Hotspots

P1 touched these pre-implementation areas:

| Area | Current owner | P1 issue |
| --- | --- | --- |
| command dispatch | `packages/cli/src/main.ts` | no `completion` command |
| run option parsing | `handleRun` in `main.ts` | no `--output-last-message`; stdin not modeled |
| prompt reading | `readPrompt` in `main.ts` | shared by `run` and `task create`; not stdin-aware |
| SSE parsing | `streamRun`, `handleSseBlock` in `main.ts` | not reusable outside current printer |
| run printing | `RunPrinter` in `main.ts` | stdout and progress output are mixed |
| help text | `printHelp`, `printRunHelp` in `main.ts` | completion has no shared command metadata |
| tests | `packages/cli/test/*.test.mjs` | mock daemon style exists, but run stdio needs new tests |

Do not change `task create` stdin behavior in P1. If shared prompt helpers move,
keep `task create` on the existing file/flag/positional contract unless a later
slice explicitly extends task prompt input.

## Patch Sequence

P1 should land in six implementation patches.

```text
P1.1 run/input
P1.2 run/events
P1.3 run/output
P1.4 run/last-message
P1.5 completion metadata and scripts
P1.6 command tests and docs alignment
```

The patches can be committed together, but they should be written in this order
so each step has a narrow failure surface.

## P1.1 `run/input`

### Files

Add:

```text
packages/cli/src/run/input.ts
```

Update:

```text
packages/cli/src/main.ts
packages/cli/test/run-io.test.mjs
```

### Responsibility

`run/input.ts` owns only `ling-stack run` prompt input. It should not own task
creation prompt input yet.

### Proposed Interface

```ts
export interface RunPromptInputOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly positionals: readonly string[];
  readonly stdin: NodeJS.ReadStream;
  readonly fileBaseCwd: string;
}

export interface RunPromptInputResult {
  readonly prompt: string;
  readonly primarySource:
    | "prompt"
    | "prompt-file"
    | "stdin-flag"
    | "positional"
    | "stdin-pipe";
  readonly appendedStdin: boolean;
}

export async function readRunPromptInput(
  options: RunPromptInputOptions,
): Promise<RunPromptInputResult>;
```

`fileBaseCwd` should initially preserve current behavior. Today
`--prompt-file <path>` is resolved with `resolve(promptFile)`, which is relative
to the CLI process cwd. Do not silently switch it to global `--cwd` in P1.

### Algorithm

1. Build primary source candidates:
   - `--prompt`,
   - `--prompt-file <path>`,
   - `--prompt-file -`,
   - non-empty positional prompt,
   - single positional `-`.
2. Reject more than one primary source with `ambiguous_prompt`.
3. Reject positional `-` combined with any other positional token.
4. Detect piped stdin with `options.stdin.isTTY !== true`.
5. If primary source is `--prompt-file -` or positional `-`, read stdin as the
   primary prompt even if stdin is a TTY.
6. If no primary source and stdin is piped, read stdin as the primary prompt.
7. If a primary source exists and stdin is piped, read stdin as appended context.
8. Decode stdin and prompt files with fatal UTF-8 decoding.
9. Strip one leading UTF-8 BOM from each decoded input.
10. Preserve appended stdin bytes after decoding. Do not trim context content.
11. If the final primary prompt is empty after trimming, throw `missing_prompt`.

### Prompt Composition

Use this exact wrapper for appended stdin:

```text
<primary prompt>

<stdin>
<stdin content>
</stdin>
```

If stdin content does not end with `\n`, add one newline before `</stdin>`.

### Error Mapping

`run/input.ts` can throw `CliError` if `CliError` is moved to a shared module.
If not, it should throw typed local errors and let `main.ts` convert them. Prefer
the smaller move only if TypeScript import boundaries are clean.

Required errors:

| Code | Exit | Trigger |
| --- | ---: | --- |
| `ambiguous_prompt` | 2 | more than one primary prompt source |
| `missing_prompt` | 2 | no prompt or empty primary prompt |
| `invalid_prompt_encoding` | 2 | fatal UTF-8 decode fails |
| `file_read_error` | 2 | prompt file cannot be read |

### Tests

Add `packages/cli/test/run-io.test.mjs` with a reusable mock daemon and `spawn`
helper, because stdin tests need direct stdin writes.

Required cases:

- `run --prompt "hello"` sends `task.prompt === "hello"`,
- `run "hello world"` sends joined positional prompt,
- `printf "hello" | run -` sends `hello`,
- `printf "hello" | run --prompt-file -` sends `hello`,
- `printf "hello" | run` sends `hello`,
- `printf "diff" | run "Review"` sends `Review\n\n<stdin>\ndiff\n</stdin>`,
- `run --prompt a positional` fails with `ambiguous_prompt`,
- `run --prompt-file file positional` fails with `ambiguous_prompt`,
- invalid stdin bytes fail with `invalid_prompt_encoding`.

Use `--skip-preflight` in these tests so provider preflight does not add
unrelated daemon endpoints.

## P1.2 `run/events`

### Files

Add:

```text
packages/cli/src/run/events.ts
```

Update:

```text
packages/cli/src/main.ts
```

### Responsibility

Move SSE parsing and run event validation out of `main.ts`.

### Proposed Interface

```ts
export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: unknown;
}

export type RunStreamRecord =
  | { readonly kind: "ready"; readonly runId: string }
  | { readonly kind: "event"; readonly envelope: RunEventEnvelope };

export function parseSseBlock(block: string): SseBlock | undefined;
export function parseRunStreamRecord(block: string): RunStreamRecord | undefined;
```

`parseRunStreamRecord` should preserve current behavior:

- `ready` SSE blocks must contain a `runId`,
- all non-ready SSE blocks must contain a valid `RunEventEnvelope`,
- invalid JSON or invalid event shape should produce `bad_sse_event`.

### Integration

`streamRun` should become a small streaming loop:

```text
fetch /runs
read chunks
split SSE blocks
parseRunStreamRecord(block)
output.handle(record)
```

Do not add recovery replay in this patch. If recovery is added later, replayed
events must pass through the same `RunStreamRecord` handler.

### Tests

Unit tests can stay inside `run-io.test.mjs` initially if the package does not
yet have TypeScript unit-test wiring for source modules. Command tests should
cover:

- `ready` record emits expected output,
- invalid SSE JSON exits non-zero with `bad_sse_event`,
- non-ready non-envelope exits non-zero with `bad_sse_event`.

## P1.3 `run/output`

### Files

Add:

```text
packages/cli/src/run/output.ts
```

Update:

```text
packages/cli/src/main.ts
packages/cli/test/provider.test.mjs
packages/cli/test/run-io.test.mjs
```

### Responsibility

Replace `RunPrinter` with an output module that has explicit stdout and stderr
writers.

### Proposed Interface

```ts
export interface RunOutputWriters {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface RunOutputOptions {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly writers: RunOutputWriters;
}

export interface RunOutput {
  handleReady(runId: string): void;
  handleEvent(envelope: RunEventEnvelope): void;
  finish(): void;
  exitCode(): number;
}

export function createRunOutput(options: RunOutputOptions): RunOutput;
```

### Stream Routing

JSON mode:

| Data | Stream |
| --- | --- |
| `{type:"ready",runId}` | stdout |
| run event envelopes | stdout |
| progress and approval help | stderr |
| CLI errors | stderr |

Default mode:

| Data | Stream |
| --- | --- |
| assistant text deltas | stdout |
| run id | stderr |
| run start/end | stderr |
| tool start/update/end | stderr |
| approval instructions | stderr |
| verbose thinking | stderr |
| CLI errors | stderr |

This is the main visible behavior change in P1. Existing tests that expect
`Run: run_1` on stdout should move that assertion to stderr.

### JSONL Rules

Use `stdout.write(JSON.stringify(record) + "\n")`. Do not call pretty JSON
helpers for run JSONL.

`ready` must be emitted as:

```json
{"type":"ready","runId":"run_1"}
```

### Exit State

Preserve current exit behavior:

- approval denied or expired returns `5`,
- run error returns `6`,
- otherwise returns `0`.

If both happen, approval-blocked exit `5` wins only if the run did not also emit
`run_error`. If implementation keeps the current order, document the order in
tests.

### Tests

Required command tests:

- `run --json` stdout lines all parse as JSON,
- `run --json` stdout contains no `Run:` or approval prose,
- default run writes assistant text to stdout,
- default run writes `Run: run_1` to stderr,
- approval instructions go to stderr in both default and JSON mode,
- existing `provider.test.mjs` skip-preflight assertions are updated for stderr.

## P1.4 `run/last-message`

### Files

Add:

```text
packages/cli/src/run/last-message.ts
```

Update:

```text
packages/cli/src/main.ts
packages/cli/src/run/output.ts
packages/cli/test/run-io.test.mjs
```

### Responsibility

Track the final completed assistant message and write it atomically after a
successful run.

### Proposed Interface

```ts
export interface LastMessageCollector {
  handleEvent(envelope: RunEventEnvelope): void;
  lastCompletedMessage(): string | undefined;
}

export function createLastMessageCollector(): LastMessageCollector;
export async function validateLastMessageTarget(filePath: string): Promise<void>;
export async function writeLastMessageAtomic(filePath: string, text: string): Promise<void>;
```

### Collector Rules

- Append `assistant_text_delta.data.text` to the current message.
- On `message_end`, commit current text as the last completed message and reset
  current text.
- Ignore thinking deltas, tool output, approval text, and `result`.
- The last completed assistant message wins.
- Do not expose partial text as a completed message.

### Atomic Write Rules

1. Validate parent path exists and is a directory before starting the run.
2. Create temp file in the same directory:

   ```text
   <target basename>.<pid>.<random>.tmp
   ```

3. Write UTF-8 text without adding a newline.
4. Rename temp file to target.
5. Remove temp file on write failure when possible.
6. Overwrite existing target only through the final rename.

### Integration

`handleRun` should:

1. parse `--output-last-message <file>`,
2. validate the parent directory before provider preflight and before `/runs`,
3. create collector,
4. pass every event through output and collector,
5. after `streamRun` finishes, check `output.exitCode()`,
6. write only if exit code is `0` and a completed message exists.

If exit code is `0` but no completed message exists, return `no_final_message`
with exit `4`.

### Tests

Required command tests:

- writes final assistant message after `run_end`,
- overwrites existing target only on success,
- does not create missing parent directories,
- leaves existing target untouched on `run_error`,
- leaves existing target untouched when stream ends without `message_end`,
- writes the second completed assistant message when two messages complete.

## P1.5 Completion Metadata And Scripts

### Files

Add:

```text
packages/cli/src/completion/command-spec.ts
packages/cli/src/completion/scripts.ts
```

Update:

```text
packages/cli/src/main.ts
packages/cli/test/completion.test.mjs
```

### Responsibility

Add static completion generation from a typed command tree.

### CommandSpec Shape

Use the shape from the P1 design:

```ts
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly subcommands?: readonly CommandSpec[];
  readonly options?: readonly OptionSpec[];
  readonly positional?: PositionalSpec;
}
```

The metadata is source of truth for completion in P1. It does not need to
generate help text yet.

### Command Inventory

The P1 metadata must cover:

- global options:
  - `--daemon-url`,
  - `--cwd`,
  - `--json`,
  - `--verbose`,
  - `--no-color`,
  - `--help`, `-h`,
- root commands:
  - `init`,
  - `doctor`,
  - `daemon`,
  - `provider`,
  - `channel`,
  - `task`,
  - `run`,
  - `runs`,
  - `external-work`,
  - `approvals`,
  - `policy`,
  - `ui`,
  - `completion`,
- all public subcommands currently shown in `printHelp`,
- new `run --output-last-message <file>`,
- `completion bash|zsh|fish`.

### Script Generation

Supported shells:

- `bash`,
- `zsh`,
- `fish`.

The scripts can be static. They should not call the daemon.

Minimum behavior:

- complete root commands,
- complete subcommands one level deep,
- complete global options,
- complete command options,
- complete fixed enum values where metadata has `values`.

Dynamic value completion for provider ids, channel ids, task ids, run ids, and
file paths can come later. `valueHint: "file"` can map to shell default file
completion when easy, but it is not required for P1 completion criteria.

### Handler

Add dispatch:

```text
ling-stack completion <bash|zsh|fish>
```

Rules:

- no daemon call,
- stdout is the script,
- unsupported shell returns `bad_completion_shell` with exit `2`,
- `--json` is ignored or rejected for this command. Prefer reject with exit `2`
  so output remains a valid shell script when the command succeeds.

### Tests

Required command tests:

- `completion bash` exits `0` and includes `complete -F`,
- `completion zsh` exits `0` and includes `#compdef ling-stack`,
- `completion fish` exits `0` and includes `complete -c ling-stack`,
- scripts include `--output-last-message`,
- scripts include `daemon start`, `daemon stop`, `runs events`, and
  `external-work github ci triage`,
- unsupported shell exits `2`.

## P1.6 Command Tests And Docs Alignment

### Files

Update:

```text
packages/cli/test/run-io.test.mjs
packages/cli/test/completion.test.mjs
docs/design/cli-run-io-completion-p1.md
docs/design/cli-v0.1.md
README.md
```

### Test Helper Shape

Use `spawn` for stdio-sensitive tests:

```js
function runCliWithInput(daemonUrl, cwd, args, input) {
  // spawn process.execPath with cliPath
  // write Buffer or string to child.stdin
  // collect stdout and stderr separately
}
```

Use a mock daemon that:

- accepts `POST /runs`,
- captures the JSON request body,
- writes SSE `ready`,
- writes requested run events,
- ends the response.

For run input tests, default event sequence can be:

```text
ready
run_start
assistant_text_delta "ok"
message_end
run_end
```

### Existing Test Updates

Expected updates:

- any test that checks `Run: run_1` should read stderr after P1.3,
- any test that parses `run --json` stdout should parse by line, not whole JSON,
- provider preflight tests should keep using `--skip-preflight` for run I/O
  tests that are not about provider gates.

### Documentation Updates

After implementation, update the design status:

- mark P1 doc sections as implemented,
- record any intentionally deferred completion features,
- keep P2 MCP text unchanged.

Do not update docs to claim dynamic completion or `--output-schema` exists until
those features land.

## Review Checklist

Before marking P1 done:

- `packages/cli/src/main.ts` has less run-specific state than before P1,
- stdin logic lives in `run/input.ts`,
- SSE parsing lives in `run/events.ts`,
- run printers do not call `console.log` directly,
- run JSON mode stdout is JSONL only,
- default run mode can redirect stdout to a file without progress text,
- last-message output uses atomic rename,
- completion comes from metadata, not ad hoc string concatenation in the handler,
- no P1 patch writes secrets, tokens, WORKFLOW content, or daemon logs,
- no P1 patch changes MCP storage or auth semantics.

## Validation Commands

Narrow validation:

```bash
corepack pnpm --filter @ling-stack/cli test
git diff --check
```

When output routing changes are implemented, also manually smoke:

```bash
printf 'Say hello.\n' | node packages/cli/dist/index.js --daemon-url http://127.0.0.1:17891 --cwd . run --provider provider_local_relay --skip-preflight -
node packages/cli/dist/index.js --daemon-url http://127.0.0.1:17891 --cwd . run --provider provider_local_relay --skip-preflight --json "Say hello" | jq -c .
node packages/cli/dist/index.js completion zsh >/tmp/ling-stack-completion.zsh
```

Full validation is not required for a docs-only edit. It is required when P1
code changes land.
