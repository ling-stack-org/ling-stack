# Desktop Computer Use PiP Source Spike

Status: initial installed `cua-driver` runtime verified on 2026-07-15; provider selection,
current-host native handoff, unsigned packaged provenance, performance, and artifact
integrity evidence updated through 2026-07-17. Later renderer and interaction work did not
change the transport boundary below.

## Verified Runtime Surface

The locally installed runtime reports `cua-driver 0.2.0`. Its public CLI/MCP surface
exposes:

- `list_windows`, returning a process ID and native window ID;
- `screenshot`, returning one ScreenCaptureKit image for one window ID;
- `get_window_state`, returning one accessibility snapshot and optionally one image;
- permission status through `check_permissions` and `doctor`.

It does not expose a continuous preview protocol. It also does not expose:

- a continuous preview frame stream;
- a stable Computer Use session ID;
- a subscription for pause, resume, terminal, source-ended, or permission changes;
- an approved opaque target descriptor that can safely cross into a renderer.

The one-shot screenshot APIs are diagnostic tools. Polling them is not an acceptable PiP
transport because it would add avoidable CPU cost, frame jitter, and a second lifecycle
that is not synchronized with the Computer Use run.

### Selected Windows provider

The initial audit was against the locally installed macOS-only `0.2.0` binary. A fresh
upstream audit found that the maintained open-source `trycua/cua` repository publishes
`cua-driver-rs-v0.8.3` under the MIT license, including:

- `cua-driver-rs-0.8.3-windows-x86_64.zip` and an x86_64 binary artifact;
- a stable `cua-driver mcp` invocation;
- a Windows UIA/Win32/DXGI capture backend;
- `list_windows` structured records containing `window_id` (HWND), `pid`, title, and
  bounds;
- the schema-v1 `health_report` contract with canonical `session_active`, UIA
  (`ax_capability`), and DXGI/D3D (`screen_capture_capability`) checks.

This is now the selected third-party Windows source/identity provider. Ling does not
bundle its binary or copy its native implementation. The provider's explicit `pid` and
`window_id` are converted into the private daemon descriptor, and Desktop resolves that
descriptor through Electron's public `desktopCapturer` boundary. The Windows provider
decision is therefore closed, but the Windows real-capture gate remains open until a
Windows x64 VM proves the actual HWND-to-`window:<HWND>:<suffix>` mapping and lifecycle.

Evidence used for the selection:

- [trycua/cua source repository](https://github.com/trycua/cua)
- [cua-driver-rs-v0.8.3 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.8.3)
- [MIT license](https://github.com/trycua/cua/blob/main/LICENSE.md)

## Verified macOS Capture Evidence

The current public-API Electron path now has real-window evidence on the current Mac:

- dev Electron, unsigned packaged arm64, and unsigned packaged x64/Rosetta;
- a complete fake, real-window, and primary-display provenance matrix for both packaged
  `.app` bundles and both mounted DMGs;
- first frame, Hide, Show, descriptor revision 1 to 2, stale old-source close isolation,
  native current-track `ended`, bounded stalled state without stopping the runtime,
  acknowledged Stop, and terminal close;
- exact Cua Driver native-window handoff in dev Electron and both arm64/x64 packaged
  `.app` bundles;
- read-only Screen Recording probes report `granted` for dev and unsigned arm64/x64
  candidates on this machine.

The direct-source smoke target is a test-owned BrowserWindow resolved through one exact
main-only `electronSourceId`; it does not guess the foreground window or expose the raw
source ID outside Desktop main. The separate native-handoff smoke uses that Electron
source ID only as a test oracle to prove the mapping. The descriptor supplied to Ling
contains only the Cua provider PID and numeric `nativeWindowId`; selection never falls
back to title matching, foreground-window state, or z-order.

This proves the shared Electron/macOS window and display capture path plus the Cua native
window identity handoff on the current host. It does not prove app restart, a stable
Developer ID identity, notarization, or clean-host TCC denied/prompt/granted/revoked
states. The tests do not modify TCC.

## Windows Provider Audit

Repository and runtime audit performed on 2026-07-16:

- Electron 43.1.1 `desktopCapturer` and
  `setDisplayMediaRequestHandler` provide presentation/capture plumbing only. They do
  not constitute a Ling-owned Windows Graphics Capture (WGC), Direct3D, or Media
  Foundation source provider.
- Ling's repository contains no Windows native helper/project or packaged provider
  resource (`.sln`, `.vcxproj`, `.csproj`, `.dll`, or `.exe`). This is intentional: the
  selected provider owns the native Windows implementation and Ling owns only the
  descriptor, presentation, and lifecycle boundary.
- The Windows permission-settings URI
  (`ms-settings:privacy-graphicscaptureprogrammatic`) only opens the OS settings page;
  it is not a permission probe or a provider.
- Electron's Windows screen-permission API is not a provider health signal. The adapter
  now binds its Windows preflight to the exact daemon descriptor and requires a Windows
  target with both canonical HWND and PID; missing or stale descriptors fail closed.
- Native source matching currently relies on the Electron source ID convention
  (`source.id.split(":")[1]`). Windows source-ID mapping, source-ended behavior,
  display-topology changes, revision replacement, and restart recovery have not been
  verified on a Windows machine.
- `CuaDriverComputerUseProjectionProducer` still derives the descriptor platform from the
  actual runtime process and only accepts explicit structured `pid`/`window_id` values.
  Platform metadata alone is not evidence; the provider install and VM lifecycle gate
  remains mandatory.

### Decision

The provider decision is **closed** in favor of the maintained open-source Cua Driver Rust
provider. The Windows implementation is still **release-gated**, not complete: the
provider must be installed in an interactive user session and verified on a Windows x64
VM before Ling claims Windows real capture.

The G3 gate can close only after all of the following exist:

1. the selected Cua Driver provider is installed and healthy in the interactive session;
2. an explicit authorized-target handoff with permission and source lifecycle semantics;
3. implementation and cleanup/revision/restart tests in Desktop main; and
4. Windows x64 VM smoke covering permission, first frame, source-ended, revision
   replacement, and app restart.

Until then, the support matrix is: macOS real capture candidate; Windows provider
integration implemented behind a VM gate; no Windows real Computer Use completion claim.

## V1 Provider Distribution Decision

Ling Desktop packages only the public Cua Driver plugin shell metadata:

- `.ling-plugin/plugin.json`;
- `mcp-server.json`;
- the plugin README.

It does not bundle the `cua-driver` executable, `CuaDriver.app`, native libraries,
credentials, or permission state. The macOS and Windows providers are installed and
permissioned separately from Ling. Runtime resolution accepts an explicit configured
command, `PATH`, the official Windows per-user install locations, `~/.local/bin/cua-driver`,
Homebrew, and `/usr/local/bin/cua-driver`. If no executable is available, setup fails
closed with the structured `plugin_binary_not_found` error rather than silently switching
providers.

The clean-machine release matrix must therefore install and verify Cua Driver before the
real-source smoke. On Windows the expected upstream artifact is
`cua-driver-rs-0.8.3-windows-x86_64.zip`; the provider's own signing/SmartScreen and
interactive-session behavior remain separate release evidence. This boundary lets Ling
ship public integration metadata without taking ownership of the provider's binary,
native permissions, or update channel.

The clean-machine acquisition verifier pins the reviewed release asset rather than
executing the upstream installer:

```text
URL: https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64.zip
SHA-256: 6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0
Size: 10585087 bytes
```

`apps/desktop/tests/verify-windows-cua-driver-provider.mjs` downloads and extracts only
under the OS test temp directory (or `RUNNER_TEMP`), verifies the archive before
extraction, and checks both `cua-driver.exe` and `cua-driver-uia.exe` as PE32+ x86_64.
It never writes to the user's provider installation, updates `PATH`, or invokes
`install.ps1`. On Windows it separately runs the read-only `--version` probe and reports
the actual `Get-AuthenticodeSignature` result without requiring or implying that the
third-party binaries are signed. On macOS it explicitly reports Authenticode as
`not_checked`; checksum and PE architecture are not signature evidence.

Ling's Windows apply/check gate additionally requires `health_report`, `list_windows`, and
`get_window_state` and accepts only the exact reviewed `0.8.3` provider; older or
unreviewed newer versions always fail closed. The exact version must also report schema v1,
`platform=win32`, `overall=ok`, with binary/platform/session/UIA/screen-capture checks all
passing. This protects the runtime from Session 0, missing UIA, or
headless/D3D-unavailable environments, but it is still not a substitute for the Windows
x64 VM real-source matrix.

## Adapter Decision

V1 uses the approved fallback boundary:

```text
Computer Use runtime
  -> daemon projection with opaque descriptorId + revision
  -> trusted Desktop main resolves descriptorId
  -> Electron desktopCapturer opens the authorized source
  -> dedicated PiP renderer receives a revocable stream
```

`cua-driver` native `pid` and `window_id` values may exist only inside the trusted
descriptor resolver. They must not appear in public daemon projection DTOs, API-client
return types, preload snapshots, logs, telemetry, or Web storage.

The implementation has one deliberately narrow exception: the Desktop main process may
call a loopback-only, `no-store` private descriptor handoff with the per-installation
Desktop bridge token. This is a trusted-main transport, not a public API. It must satisfy
all of the following constraints:

- the resolver rejects non-loopback daemon URLs in production;
- the endpoint requires the bridge token and never enables CORS;
- the response is consumed only in Desktop main and is never forwarded to preload/Web;
- the descriptor is revisioned, short-lived, and revoked on terminal state;
- logs and error bodies redact native IDs, tokens, and local paths.

If any of these constraints cannot be guaranteed, replace the handoff with an OS-local
IPC channel before enabling real capture.

The runtime integration that creates the descriptor must use the actual authorized target
returned by the Computer Use operation. It must never infer a target from the foreground
window, z-order, Space, visibility, or title matching. A window catalog is accepted only
when the requested native window ID is explicit, or when the result contains exactly one
unambiguous window.

## Internal Resolved Descriptor

This structure is Desktop-main-only and is intentionally not part of
`@ling-stack/contracts`:

```ts
interface ResolvedComputerUsePreviewDescriptor {
  readonly descriptorId: string;
  readonly revision: number;
  readonly platform: "macos" | "windows";
  readonly target: {
    readonly kind: "window" | "display";
    readonly applicationId?: string;
    readonly processId?: number;
    readonly nativeWindowId?: string;
  };
  readonly authorization: {
    readonly grantId: string;
    readonly expiresAt: string;
  };
}
```

The resolver rejects expired grants, revision mismatches, unsupported platforms, and
descriptors whose native source is no longer present.

## Fake Descriptor Fixture

Tests and the first renderer demo use an opaque public reference:

```json
{
  "descriptorId": "preview_fake_session_01",
  "revision": 1,
  "aspectRatio": 1.6,
  "cursorAvailable": true
}
```

The Desktop-main fake registry resolves it to a synthetic source. No native window ID is
embedded in the public fixture, so fake and real adapters exercise the same trust boundary.

## Final Local Packaging and Performance Evidence

The 2026-07-17 pre-finalization worktree baseline (not commit-bound) passes **196/196
Desktop Node tests**, **17/17 PiP renderer tests**, **16/16 focused Web E2E tests**,
**51/51 focused contracts/API/daemon/plugin tests**, and **10/10 macOS screenshot
baselines**. The fake ownership/crash lane records **415.27 ms p95**.

`git show e20777f5` records **170/170 Desktop Node tests**; the `196/196` count above is
not attributable to that commit. These figures are historical engineering references.
Post-baseline work in the current worktree requires a fresh matrix before any result is
called current or release evidence.

The final current-host real MediaStream run passed the local comparison budgets with:

- first decoded frame p50/p95: **168.09 / 177.84 ms**;
- Hide-to-release p50/p95: **2.16 / 3.65 ms**;
- 30-second active-preview incremental CPU delta: **0.21%** of one core;
- active-preview working-set overhead: **11,763,712 bytes**;
- ten-cycle Show/Hide churn: **6.04%** main-process CPU and **17,661,952 bytes** app
  working-set growth;
- **12 activations = 12 descriptor-matching source enumerations**, with **1 renderer
  document** and **0** post-acquisition `applyConstraints()` calls;
- zero final window, renderer, process, MediaStream track, timer, subscription, IPC,
  adapter-source, and raw listener residue.

The Vite preview build now empties its `outDir` before emitting a new bundle. The packaged
`app.asar` preview subtree therefore contains exactly the current seven subtree entries
(two directories and five files), with no stale hashed preview asset from an earlier build.

Baseline unsigned artifact SHA-256 values @ `e20777f5` (regenerate after the final diff):

| Artifact | SHA-256 |
| --- | --- |
| arm64 DMG | `e42b944b84bf67174d18dec422637cbde6988c4d2283f503597b09aae50727fb` |
| x64 DMG | `a9e8aa208af6dc9baff96b9550166095660adc1b596c4f86544287ac0ca19258` |
| arm64 ZIP | `6c9ac51d212a7a4b930cf8bcb8c93f7e4b4f07bb17b93d1205f01b2ff99face5` |
| x64 ZIP | `49a8bc3d5dce9def59c49b7a53f9fb31fea72e960dd9e99f806809d995bb695e` |
| Windows x64 unpacked app | `3f6ad1bbb45816bb46b15d2e23eb7a60843eb2a8fbc25ae0e541fb29af1d596e` |
| Windows x64 NSIS | `52b115f2ef02394ed0e352c28f60052ec572eec02f708c2a942bd64d9b4de5e2` |

Both DMGs pass container verification and both ZIPs pass archive integrity checks. The
unpacked Windows application is PE32+ x86_64; the NSIS installer uses the normal PE32 x86
bootstrap stub while carrying that x64 application. Both PE certificate-table sizes are
**0**. These remain unsigned engineering artifacts: no Apple Developer ID identity is
installed, and Developer ID/notarization/Gatekeeper, clean-host TCC/capture-indicator,
Windows interactive provider/DPI/dual-display, Authenticode/SmartScreen/signed NSIS,
hosted CI, clean-machine install/update/uninstall, and VoiceOver/Narrator/NVDA gates remain
open.

The rebuilt candidates use the committed Ling application artwork rather than Electron's
default icon. Both macOS bundles contain the exact `icon.icns`; the Windows app and NSIS
contain the nine `icon.ico` frames. The Windows package is explicitly per-user/asInvoker and
contains no elevation helper.

## Reproducible Evidence Commands

```bash
cua-driver --version
cua-driver list-tools
cua-driver describe screenshot
cua-driver describe get_window_state
cua-driver describe list_windows
cua-driver describe check_permissions
cua-driver doctor
node apps/desktop/tests/verify-windows-cua-driver-provider.mjs
node apps/desktop/tests/run-computer-use-smoke.mjs --real
LING_DESKTOP_CUA_NATIVE_HANDOFF_SMOKE=1 \
  node apps/desktop/tests/run-computer-use-smoke.mjs --real
LING_DESKTOP_SMOKE_EXECUTABLE="apps/desktop/release/mac-arm64/Ling Stack.app/Contents/MacOS/Ling Stack" \
  node apps/desktop/tests/run-computer-use-smoke.mjs --real
LING_DESKTOP_SMOKE_EXECUTABLE="apps/desktop/release/mac/Ling Stack.app/Contents/MacOS/Ling Stack" \
  LING_DESKTOP_SMOKE_TIMEOUT_MS=60000 \
  node apps/desktop/tests/run-computer-use-smoke.mjs --real
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs --real
```

`doctor` currently confirms Accessibility and Screen Recording are granted, while bundle
attribution is attached to the invoking shell rather than `CuaDriver.app`. That attribution
warning does not change the source decision: the public tool surface still has snapshots,
not a continuous preview/session protocol.

The default Electron performance harness uses the fake source adapter to prove
BrowserWindow/preload/renderer/IPC ownership and crash cleanup. The `--real` lane measures
the current-host MediaStream path and decoded-frame gate. Neither lane is signed release
evidence or a substitute for the missing clean-host TCC and Windows VM/provider lifecycle
matrices.
