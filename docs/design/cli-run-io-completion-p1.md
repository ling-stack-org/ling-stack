# CLI Run I/O and Completion P1

## Status

Implemented for the Codex CLI borrowing P1 slice.

Related design docs:

- [CLI v0.1](cli-v0.1.md)
- [Daemon lifecycle and doctor P0](daemon-lifecycle-p0.md)
- [Daemon API](../daemon-api.md)

Reference snapshot:

- Upstream `openai/codex` at `345cf6e`
- Relevant Codex areas: `exec`, `completion`, `doctor`, `app-server`, and `mcp`

## Problem

P0 made `ling-stack` usable as a local operator CLI by hardening daemon lifecycle
and doctor diagnostics. P1 made direct runs reliable for shell automation.

Before P1, the `run` path had four automation gaps:

- prompt input is file/flag/positional only, with no stdin contract,
- `run --json` can share stdout with human progress in the same printer,
- automation has to parse the event stream to capture the final assistant answer,
- completion cannot be generated safely while command metadata lives only inside
  hand-written dispatch branches.

The implementation below closes those gaps; this document now preserves the output and
compatibility contract.

## Current Baseline

Implemented today:

- `packages/cli/src/index.ts` is a thin executable entrypoint.
- `packages/cli/src/main.ts` owns command dispatch, argument parsing, and run
  request building.
- run prompt input, SSE parsing, output routing, and final-message capture live
  under `packages/cli/src/run/`.
- completion metadata and script generation live under
  `packages/cli/src/completion/`.
- `ling-stack run` requires `--provider <providerPresetId>`.
- `ling-stack run` accepts:
  - `--title`,
  - `--task`,
  - `--thinking`,
  - `--system-prompt`,
  - `--append-system-prompt`,
  - `--agent-dir`,
  - `--prompt`,
  - `--prompt-file`,
  - `--output-last-message`,
  - `--tool`,
  - `--skip-preflight`.
- `ling-stack run -`, `--prompt-file -`, piped stdin prompts, and prompt plus
  piped stdin context are supported.
- `run --json` emits JSONL-only stdout; approval help is routed to stderr.
- `--output-last-message <file>` writes the last completed assistant message
  atomically after successful runs.
- `ling-stack completion <bash|zsh|fish>` prints static shell completion scripts.
- `streamRun` consumes daemon SSE events and passes `ready` plus
  `RunEventEnvelope` objects to run output handlers.

Deferred beyond P1:

- `--output-schema <file>`,
- dynamic completion for provider, channel, task, and run ids,
- shared command metadata for help rendering.

## Contract Requirements

- Add a stable stdin prompt contract for `ling-stack run`.
- Make `ling-stack run --json` stdout valid JSONL only.
- Move run progress, warnings, recovery notices, and human approval help to stderr
  when stdout is reserved for machine output or final assistant text.
- Add `--output-last-message <file>` for shell scripts that only need the final
  assistant answer.
- Extract run input, run event handling, and run output handling from `main.ts`
  into small modules.
- Add command metadata that can generate completion scripts and eventually help
  output.
- Add `ling-stack completion <bash|zsh|fish>`.

## Non-Goals

- No JSON-RPC app-server migration.
- No change to daemon `/runs` SSE event shape unless an existing event is missing
  data required by this contract.
- No hidden approval bypass for CLI runs.
- No `--output-schema` implementation in P1. Keep it as a follow-up after the
  runner can produce structured final responses.
- No MCP config/runtime/auth redesign in P1. That remains P2.
- No switch to commander, yargs, clipanion, or cac unless the hand parser blocks
  completion metadata reuse.

## Command Surface

### `ling-stack run`

P1 keeps the existing command and adds stdin plus last-message output:

```bash
ling-stack run --provider <providerPresetId> "Inspect this repo."
ling-stack run --provider <providerPresetId> -
cat prompt.md | ling-stack run --provider <providerPresetId>
git diff | ling-stack run --provider <providerPresetId> "Review this diff"
ling-stack run --provider <providerPresetId> --prompt-file prompt.md
ling-stack run --provider <providerPresetId> --output-last-message out.txt "Summarize"
ling-stack run --provider <providerPresetId> --json "Inspect" | jq 'select(.type=="run_error")'
```

P1 adds one run-specific option:

```text
--output-last-message <file>   Write the last completed assistant message to a UTF-8 file.
```

`--json` stays a global option, but `run --json` has a stricter stream contract
than one-shot JSON commands.

### `ling-stack completion`

```bash
ling-stack completion bash
ling-stack completion zsh
ling-stack completion fish
```

The command prints the completion script to stdout. It does not install shell
files, edit shell profiles, or call the daemon.

## Prompt Input Contract

P1 should define one primary prompt source, then optionally add piped stdin as
context.

Primary prompt sources:

1. `--prompt <text>`
2. `--prompt-file <path>`
3. `--prompt-file -`
4. positional prompt text
5. single positional `-`
6. piped stdin fallback when no explicit prompt source exists

Invalid combinations:

- `--prompt` with `--prompt-file`,
- `--prompt` with positional prompt text,
- `--prompt-file <path>` with positional prompt text,
- `--prompt-file -` with positional prompt text,
- positional `-` with any other positional token,
- `--prompt-file -` when stdin has already been consumed for another purpose.

Valid stdin modes:

| Command shape | Behavior |
| --- | --- |
| `ling-stack run --provider p -` | read stdin as the primary prompt |
| `ling-stack run --provider p --prompt-file -` | read stdin as the primary prompt |
| `cat prompt.md \| ling-stack run --provider p` | read stdin as the primary prompt |
| `git diff \| ling-stack run --provider p "Review this diff"` | append stdin as context |
| `git diff \| ling-stack run --provider p --prompt-file prompt.md` | append stdin as context |
| `ling-stack run --provider p "Review"` with TTY stdin | do not read stdin |

When stdin is used as the primary prompt, it is not appended again as context.

## Stdin Detection Rules

The CLI should make stdin behavior predictable:

- If the user explicitly passes `-` or `--prompt-file -`, read stdin until EOF
  even when stdin is a TTY.
- If stdin is not a TTY and no primary prompt source exists, read stdin until EOF
  and use it as the prompt.
- If stdin is not a TTY and a primary prompt source exists, read stdin until EOF
  and append non-empty content as context.
- If stdin is a TTY and no explicit stdin mode is present, do not block on stdin.
- Decode stdin and prompt files as UTF-8.
- Strip one optional UTF-8 BOM at the beginning of each decoded input.
- Do not trim piped stdin content before embedding it as context.
- If a primary prompt source resolves to empty text, return `missing_prompt`.
- If stdin bytes cannot be decoded as valid UTF-8, return `invalid_prompt_encoding`.

Node's default `readFile(..., "utf8")` replacement behavior is not enough for
the encoding contract. P1 should decode with `TextDecoder("utf-8", { fatal: true })`
for prompt files and stdin.

## Prompt Composition

Inline prompt only:

```text
Review this repository.
```

Piped stdin only:

```bash
git diff | ling-stack run --provider p
```

Final prompt:

```text
[decoded git diff]
```

Prompt plus piped stdin:

```bash
git diff | ling-stack run --provider p "Review this diff for regressions."
```

Final prompt:

```text
Review this diff for regressions.

<stdin>
[decoded git diff]
</stdin>
```

If piped stdin does not end with `\n`, the composer adds one newline before
`</stdin>` so the closing tag is always on its own line. It should otherwise
preserve the decoded stdin content.

## JSONL Output Contract

For `ling-stack run --json`, stdout is newline-delimited JSON only:

```text
{"type":"ready","runId":"run_123"}
{"id":"event_1","runId":"run_123","seq":1,"ts":"...","type":"run_start","data":{...}}
{"id":"event_2","runId":"run_123","seq":2,"ts":"...","type":"assistant_text_delta","data":{"text":"Hello"}}
```

Rules:

- Every stdout line must be parseable with `JSON.parse`.
- The `ready` SSE event is normalized as `{ "type": "ready", "runId": "..." }`.
- Daemon run event envelopes are emitted as one JSON object per line.
- No tables, labels, markdown, spinners, warnings, or approval instructions may
  appear on stdout in JSON mode.
- Human progress, warnings, stream recovery notices, and approval help go to
  stderr.
- CLI usage errors, daemon connection errors, and output-file errors before or
  after the stream go to stderr and preserve the existing exit-code model.
- If a pre-stream error occurs, stdout should be empty.

The JSONL stream is for event consumers. It is not a final JSON summary.

## Default Run Output

Default non-JSON output remains human-friendly, but P1 should separate streams
where practical:

- assistant text deltas go to stdout,
- run id, run start, tool rows, approval instructions, run end, warnings, and
  recovery notices go to stderr,
- `--verbose` thinking and tool update rows go to stderr.

This makes the common shell shape useful:

```bash
ling-stack run --provider p "Write release notes" > release-notes.md
```

Approval instructions still need to be visible, so they stay on stderr while the
run waits.

## `--output-last-message <file>`

Purpose:

- Let scripts capture the final assistant message without parsing JSONL or human
  terminal output.

Behavior:

1. Validate the parent directory before starting the run.
2. Stream the run normally.
3. Track completed assistant messages from SSE events.
4. After a successful terminal run event, write the last completed assistant
   message to the target file.
5. Write atomically with a temp file in the same directory followed by `rename`.
6. Overwrite the target file by default.
7. Write UTF-8 text exactly as collected, without adding a trailing newline.

Rules:

- Do not create missing parent directories.
- Do not write partial assistant text that has not reached `message_end`.
- Do not write thinking, tool output, approval text, or run summaries.
- If the run fails before any completed assistant message exists, leave the
  existing target file untouched and return the run failure exit code.
- If the run succeeds but no completed assistant message exists, leave the file
  untouched and exit with code `4` and error code `no_final_message`.
- If the file write fails after a successful run, exit with code `4` and error
  code `output_write_failed`.

Example:

```bash
ling-stack run \
  --provider provider_local_relay \
  --output-last-message /tmp/answer.txt \
  "Summarize the current repo state."
```

## Final Assistant Message Extraction

The collector should sit beside the printer, not inside the daemon or runner.

State:

```text
currentAssistantMessage: string
lastCompletedAssistantMessage: string | undefined
```

Event handling:

- `assistant_text_delta`: append `data.text` to `currentAssistantMessage`.
- `message_end`: commit `currentAssistantMessage` into
  `lastCompletedAssistantMessage`, then reset `currentAssistantMessage`.
- `run_error`: mark run failure.
- `approval_denied` or `approval_expired`: mark approval-blocked exit state.
- `run_end`: allow `--output-last-message` to write if a completed message exists.

The last completed assistant message wins. P1 should ignore thinking deltas,
tool output, approval messages, and `result` summaries for this file.

If stream recovery is added in the same slice, recovered events must pass through
the same collector in sequence order.

## Error Codes

P1 should keep the existing numeric model:

```text
0  success
1  generic failure
2  bad CLI usage
3  daemon unreachable
4  daemon returned error, output contract failure, or workspace not ready
5  approval denied or expired
6  run failed
7  timeout
```

New or clarified string error codes:

| Code | Exit | When |
| --- | ---: | --- |
| `missing_prompt` | 2 | no prompt source and no piped stdin |
| `ambiguous_prompt` | 2 | multiple primary prompt sources |
| `invalid_prompt_encoding` | 2 | stdin or prompt file is not valid UTF-8 |
| `output_parent_missing` | 2 | `--output-last-message` parent does not exist |
| `no_final_message` | 4 | run succeeded but no completed assistant message exists |
| `output_write_failed` | 4 | atomic write or rename failed |
| `daemon_unreachable` | 3 | daemon cannot be reached |
| `run_failed` | 6 | run emits `run_error` |
| `approval_denied` | 5 | approval is denied or expires |

## Completion Metadata Plan

Completion should be generated from one command metadata model.

Proposed shape:

```ts
interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly subcommands?: readonly CommandSpec[];
  readonly options?: readonly OptionSpec[];
  readonly positional?: PositionalSpec;
}

interface OptionSpec {
  readonly name: string;
  readonly alias?: string;
  readonly value?: "none" | "required" | "optional";
  readonly repeatable?: boolean;
  readonly values?: readonly string[];
  readonly valueHint?: "file" | "directory" | "provider" | "channel" | "task" | "run";
  readonly global?: boolean;
}
```

P1 should include the current public command tree, not every internal parser
detail. Completion must include:

- global options,
- daemon lifecycle subcommands,
- provider/channel/task/run/runs/approval/policy/ui commands,
- `run` options including `--output-last-message`,
- `completion bash|zsh|fish`.

Completion should not make daemon calls in P1. Dynamic completion for provider
ids, channel ids, and task ids can be a later enhancement.

## Module Plan

P0 already split the executable entrypoint and daemon/doctor helpers. P1 should
avoid adding more run automation code to `main.ts`.

Recommended P1 files:

```text
packages/cli/src/run/input.ts
packages/cli/src/run/events.ts
packages/cli/src/run/output.ts
packages/cli/src/run/last-message.ts

packages/cli/src/completion/command-spec.ts
packages/cli/src/completion/scripts.ts
```

Responsibilities:

| File | Responsibility |
| --- | --- |
| `run/input.ts` | prompt source validation, stdin detection, UTF-8 decoding, prompt composition |
| `run/events.ts` | SSE block parsing, ready normalization, event envelope validation |
| `run/output.ts` | human printer, JSONL printer, stderr/stdout routing, exit state |
| `run/last-message.ts` | final assistant message collector and atomic file writer |
| `completion/command-spec.ts` | typed command tree used by completion and tests |
| `completion/scripts.ts` | bash, zsh, and fish script generation |

`main.ts` may continue to own top-level dispatch during P1, but it should call
these modules rather than embedding their logic inline.

## Test Plan

Unit tests:

- prompt source validation rejects ambiguous prompt inputs,
- `run -` reads stdin as the primary prompt,
- `--prompt-file -` reads stdin as the primary prompt,
- no prompt plus piped stdin becomes the primary prompt,
- explicit prompt plus piped stdin appends a `<stdin>` context block,
- TTY stdin with explicit prompt does not block,
- invalid UTF-8 returns `invalid_prompt_encoding`,
- JSONL printer emits only parseable JSON lines to stdout,
- human printer routes progress to stderr when stdout is reserved,
- last-message collector records only completed assistant messages,
- atomic writer does not create missing parent directories,
- completion scripts include current commands and options.

Command tests with a mock daemon:

- `ling-stack run --json` emits `ready` plus event envelopes as JSONL only,
- `ling-stack run --json` keeps progress and approval help off stdout,
- `ling-stack run --output-last-message out.txt` writes the final text after
  `run_end`,
- `ling-stack run --output-last-message out.txt` leaves the previous file
  untouched on pre-final failure,
- `ling-stack completion bash|zsh|fish` exits `0` and prints a non-empty script.

Regression checks:

```bash
corepack pnpm --filter @ling-stack/cli test
git diff --check
```

Manual smoke:

```bash
printf 'Say hello from stdin.\n' | ling-stack run --provider provider_local_relay -
git diff | ling-stack run --provider provider_local_relay "Review this diff"
ling-stack run --provider provider_local_relay --json "Say hello" | jq -c .
ling-stack run --provider provider_local_relay --output-last-message /tmp/ling-answer.txt "Say hello"
ling-stack completion zsh >/tmp/ling-stack-completion.zsh
```

## Implementation Sequence

Detailed patch breakdown: CLI Run I/O and Completion P1.

Implemented file shape:

```text
packages/cli/src/run/input.ts
packages/cli/src/run/events.ts
packages/cli/src/run/output.ts
packages/cli/src/run/last-message.ts
packages/cli/src/completion/command-spec.ts
packages/cli/src/completion/scripts.ts
```

1. Move prompt reading into `run/input.ts` and add stdin-aware tests.
2. Move SSE block parsing and ready/event validation into `run/events.ts`.
3. Split `RunPrinter` into output helpers that can target stdout and stderr.
4. Make `run --json` stdout strict JSONL.
5. Add the last-message collector and atomic writer.
6. Add `--output-last-message` parsing and validation.
7. Add command metadata for the current command tree.
8. Add `ling-stack completion <bash|zsh|fish>`.
9. Add command tests with mock SSE streams.
10. Run the CLI package tests and `git diff --check`.

## Completion Criteria

P1 is complete and covered by CLI tests when:

- `ling-stack run -` and `--prompt-file -` read stdin correctly,
- piped stdin without an explicit prompt becomes the prompt,
- piped stdin with an explicit prompt is appended as `<stdin>` context,
- invalid prompt combinations fail with `ambiguous_prompt`,
- invalid prompt encoding fails with `invalid_prompt_encoding`,
- `ling-stack run --json` stdout is JSONL-only across success, approval, and
  run-error paths,
- `--output-last-message <file>` atomically writes the last completed assistant
  message and leaves existing files untouched on pre-final failure,
- `ling-stack completion bash|zsh|fish` exists and is generated from command
  metadata,
- `packages/cli/src/main.ts` does not absorb the new P1 stateful logic,
- `corepack pnpm --filter @ling-stack/cli test` passes,
- `git diff --check` passes.

## Follow-Ups

- `--output-schema <file>` after runner structured outputs exist.
- Dynamic shell completion for provider, channel, task, and run ids.
- Shared command metadata for help rendering.
- P2 MCP config/runtime/auth separation.
