# Ling native sandbox: T0 protocol boundary

Status: in progress. This executable implements the bounded native handshake and a
Unix-only, read-only input snapshot entry point for isolated command copies.
It does not execute commands, mutate files, initialize accounts, grant permissions, or
report OS enforcement as ready. It is not wired into daemon readiness or Desktop packaging.

## Responsibility and upstream boundary

The daemon owns policy compilation, approved grants, Run/Attempt/fence and canonical facts.
The helper will own platform process/filesystem enforcement through a private inherited
pipe; it must not import conversation, model, telemetry, PTY or provider implementations.

Reference: OpenAI Codex commit a9896da3febcaf30e1c5d7b452fb6334b1a0bc51, inspected 2026-09-07.

- [Windows Cargo manifest](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/codex-rs/windows-sandbox-rs/Cargo.toml)
- [Windows session request](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/codex-rs/windows-sandbox-rs/src/unified_exec/mod.rs)
- [Apache-2.0 license](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/LICENSE)

The upstream crate directly depends on codex-protocol, codex-utils-pty,
codex-utils-absolute-path, codex-utils-string and codex-otel; its session request carries
PermissionProfile, AbsolutePathBuf, WindowsSandboxLevel and SpawnedProcess. It is not a
standalone dependency for Ling. This first module has zero Codex workspace dependencies
and no copied OpenAI implementation. Its MIT license is the repository license.
Extraction of privileged Windows enforcement/setup code remains unverified. Any subsequent
source reuse must preserve the pinned source license/NOTICE, attribution and local patches;
this handshake is not evidence that the complete extraction or sandbox is finished.

## Private wire format

The handshake invocation is --stdio-handshake. stdin/stdout are inherited pipes, not TCP listeners.
One request is consumed; the process replies once and exits. No second request or execute
method is processed in this probe. Future execution uses a distinct reviewed entry point.

Frame: 4-byte unsigned big-endian body length, then UTF-8 JSON, maximum 262144 bytes.
Empty, oversized, truncated, invalid UTF-8/JSON and duplicate/unknown fields fail closed.
Input parsing keeps serde's nesting limit. Diagnostics contain fixed codes only, never
input values, paths, command text, environment, credentials or serde error strings.

Request fields (camelCase; all required; no additional fields):

- protocolVersion = 1, operation = handshake.
- requestId: nonempty bounded opaque identifier; nonce: 64 lowercase hexadecimal digits.
- expectedHelperVersion = the exact compiled Cargo package version.
- parentPid: observed immediate parent PID, positive. An unexpected parent fails.
- identity: workspaceId, runId, workUnitId, attemptId, runtimeInstanceId, fencingToken.
  All six identifiers must be nonempty, bounded and free of control characters.

The hello response echoes requestId, nonce and identity, plus helper version, platform,
architecture, PID and observed parent PID. executionSupported and enforcementReady are
always false; capabilities is empty. An exit code 0 means handshake only, never readiness.
Malformed input returns a framed error and exit 2; inability to write the response exits 3.

PID matching and the nonce detect mismatched/stale communication. They are NOT caller
authentication, approval, executable-signature verification, a sandbox, or a quiescence
receipt. The future daemon launcher must verify the trusted bundled path, binary hash and
version, create its own pipes, apply a handshake deadline, and bind the response to the
captured fence. Do not use project/PATH binaries or model-provided verification flags.

## Anchored input capture

`--read-input` accepts a separate closed framed request: `handshake` (the complete
identity/version/parent request above), `root`, decimal-string `rootDevice` and
`rootInode`, canonical relative `path`, and `maxBytes` (1 through 67108864).
It is Unix-only and does not start a command or write the source. Host owner and
permission checks remain the caller's responsibility; supplying an identity is not
a grant. No model-facing tool or public route exposes this entry point.

The reader walks every absolute-root and relative-path component with directory
FDs, `openat`, `O_NOFOLLOW`, `O_CLOEXEC` and nonblocking opens. It rejects symbolic
links, non-regular files, unknown multi-link files, changed roots and size overflow.
After a bounded read it compares file identity/size/mtime/ctime/link count and
reopens the original path through anchored directory handles. A mismatch rejects
the entire capture before any content is emitted. This captures an observed input
revision; it does not lock the source against future user changes.

A verified capture returns `input_started` (requestId, nonce, identity), ordered
16 KiB hex `input_chunk` frames and `input_completed` (path, root identity, source
metadata, size). Empty files have no chunk frames. The consumer must require the
complete sequence and successful process exit, bound memory/time, and discard all
chunks on cancellation, truncation, mismatch or lost owner. This capture path does
not claim native execution readiness, dependency closure, output import, or complete
descendant termination. Those production connections remain incomplete.

## Build and inspect

The evidence build entry point uses `rustup run 1.97.1` without `--install`, offline
locked Cargo operations, and an exclusive new output directory. It does not overwrite
an existing output, change the global toolchain, or install the helper into an app:

    node native/sandbox/scripts/build.mjs --target aarch64-apple-darwin --out /absolute/temporary/new-output
    node --test native/sandbox/tests/build-evidence.test.mjs

Supported build targets are aarch64-apple-darwin, x86_64-apple-darwin and
x86_64-pc-windows-msvc. A target check and real release link must succeed before a
manifest is written. Cross-target builds explicitly record process tests as not run;
Windows release linking still requires the actual Windows build toolchain/environment.
The build does not invoke setup, repair, uninstall, UAC, signing or OS probes.

`manifest.json` records source/lock/binary hashes, exact dependency versions and all
collected license/notice texts, including the Unicode license. Unknown license or
non-registry dependency changes require review and stop the build. These are inventory
and local integrity facts, not a vulnerability audit, upstream extraction proof or a
trusted distribution manifest. A macOS linker ad-hoc signature is not publisher identity.
The packaged launcher must authenticate the binary and its manifest together; accepting
a workspace-provided hash file would not establish trust. Both executionSupported and
enforcementReady stay false. Per-step logs are retained in the new output directory.

The toolchain is pinned; Cargo.lock is generated and retained. No toolchain or system
installation is performed by the helper. Place build output in a task-owned temporary
directory, outside the user's workspace and the packaged application:

    CARGO_TARGET_DIR=/absolute/temporary/build cargo test --offline --locked --manifest-path native/sandbox/Cargo.toml
    CARGO_TARGET_DIR=/absolute/temporary/build cargo build --offline --locked --manifest-path native/sandbox/Cargo.toml
    CARGO_TARGET_DIR=/absolute/temporary/build cargo check --offline --locked --manifest-path native/sandbox/Cargo.toml --target x86_64-pc-windows-msvc
    node native/sandbox/tests/protocol-smoke.mjs /absolute/temporary/build/debug/ling-sandbox-runner

Windows cargo check verifies compilation/type compatibility only, not linking, UAC,
restricted tokens, ACLs, Job Objects, WFP, private desktops, or real-machine enforcement.
Final Windows builds and tests must run on the approved Windows environment.

## Remaining T0 and next dependencies

T0 still requires the reviewed extraction/build closure for Windows privileged modules,
setup/repair/uninstall owned-manifest protocol, vulnerability/license review for any
additional upstream extraction and authenticated packaged binary
identity. T1 must compile the complete immutable execution policy before T2/T3 execution.
T4 must capture every command/file tool with no raw Pi/Host fallback. T5/T6 retain settings,
native probes, process-tree stop proof and the full original macOS/Windows acceptance plan.
