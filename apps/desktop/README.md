# Desktop App

Desktop packaging is in alpha implementation. The current branch has a minimal
Electron shell over the local daemon and shared Web UI, plus the first Computer Use
picture-in-picture slices. It is not release-ready: unsigned macOS real capture and
bounded daemon/renderer recovery, real Electron fake-source DOM tests, and zero-residue
process profiling are implemented. The current host also passes the unsigned packaged
fake/window/display provenance matrix, Cua native-window handoff, and real MediaStream
performance comparison. The unresolved release gates are Developer ID
signing/notarization and Gatekeeper,
clean-host TCC plus the operating-system capture indicator, Windows interactive
provider/DPI/dual-display acceptance, Authenticode/SmartScreen/signed NSIS, hosted CI,
clean-machine install/update/uninstall, and real VoiceOver/Narrator/NVDA acceptance.

The desktop app should be a shell over the local daemon and shared Web UI. It should own
daemon lifecycle, menu/tray, notifications, file picker, keychain, and update UX, but it
must not fork the Ling Stack product model or bypass daemon state machines.

AI Council health and badge state should come from `@ling-stack/core/ai-council-view`
plus daemon/API-client data, not from copied Web DOM labels or Web-only helpers.

Design source of truth:

- [Desktop Shell](../../docs/design/desktop-shell.md)
- [Desktop Computer Use Picture-in-Picture](../../docs/design/desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](../../docs/design/desktop-computer-use-picture-in-picture-detailed-design.md)
- [Desktop Computer Use Picture-in-Picture Implementation Plan](../../docs/design/desktop-computer-use-picture-in-picture-implementation-plan.md)
- [Desktop Release Acceptance](../../docs/release/desktop.md)
- [Desktop Windows Release Decisions](../../docs/release/desktop-windows-release-decisions.md)

Electron is the selected Desktop shell for the current alpha. Tauri is not an active
implementation path for this slice; reconsidering it would be a separate architecture
decision after the daemon and capture contracts stabilize.

The presentation contract targets macOS and Windows, but real source support is gated
per platform. The selected Windows provider is the maintained open-source Cua Driver Rust
provider (`cua-driver-rs-v0.8.3`, exact reviewed allowlist). Its current upstream artifact
is an unsigned prerelease, so public release remains blocked even after internal/beta VM
acceptance unless that risk is explicitly accepted or a signed stable provider replaces it.
Windows real capture remains blocked until the provider is installed and the x64 VM
source/lifecycle matrix passes. The main window
reuses the shared React application while the PiP uses a small isolated renderer plus a
narrow capture adapter. Hide or window
close must never stop the underlying Computer Use session; stopping remains a separate
daemon command with approval and audit semantics.

Desktop keeps one fixed loopback daemon authority per workspace. A compatible daemon is
reused; an incompatible external daemon triggers a native Retry/Quit prompt before the Web
window opens. Desktop never kills that process or launches a second full daemon against the
same workspace. Startup is single-flight, and headless smoke remains fail-closed.

After a ten-second zero-frame deadline, V1 does not listen for resume/unlock/user-active.
Recovery requires explicit Show/Retry, a new descriptor identity, or an explicit Desktop
restart; the Computer Use task continues throughout.

Packaged Desktop builds copy the bundled Cua Driver plugin shell into
`resources/bundled/cua-driver`. That resource contains only the Ling plugin
manifest, MCP configuration metadata, and README. It deliberately does not include the
user-installed `cua-driver` binary, native app bundles, credentials, or permission state.

The Desktop main window must load the shared Web application instead of copying its page
tree. This lets the shell, contracts, coordinator, and fake PiP renderer land before the
final conversation UI is approved; later UI changes should touch only typed capability
slots, geometry reporters, and visual polish.

Focused verification commands:

```bash
corepack pnpm --filter @ling-stack/desktop test:renderer
node --test apps/desktop/tests/*.test.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
corepack pnpm --filter @ling-stack/desktop performance:computer-use:real
node apps/desktop/tests/run-computer-use-smoke.mjs --display
corepack pnpm --filter @ling-stack/desktop verify:windows-provider
corepack pnpm --filter @ling-stack/desktop smoke:computer-use:windows-provider
corepack pnpm --filter @ling-stack/desktop exec electron tests/screenshot-app
```

`smoke:computer-use:windows-provider` is intentionally Windows-only. On macOS/Linux it exits
with an explicit skip; on Windows it requires an unlocked interactive desktop and
an installed `cua-driver` (override the executable with
`LING_CUA_DRIVER_COMMAND`). It first requires a schema-v1 `health_report` with the
interactive-session, UIA, and screen-capture checks passing, then starts two isolated
targets and calls `cua-driver call list_windows {"pid": ...}` for each exact PID/HWND
pair. It verifies first frame, Hide/Show, descriptor revision replacement, isolation
when the old target closes, Desktop restart with descriptor replay, and bounded stall
recovery when the current target closes without stopping the runtime. The existing
`smoke:computer-use:real` command is a direct Electron source-ID smoke and must not be
used as Windows provider evidence.

`performance:computer-use:real` includes ten one-second Show/Hide churn cycles plus a
hidden-idle baseline and 30-second continuous-capture sample with per-process CPU and
working-set reporting. Together with the `--display` smoke it is current-host engineering
evidence only; neither replaces signed/notarized release, TCC-state, capture-indicator, or
Windows provider measurements.

Current local closure evidence (2026-07-16–17):

- the final verification matrix passes **170/170 Desktop Node tests**, **17/17 PiP renderer
  tests**, **51/51 focused contracts/API/daemon/plugin tests**, **16/16 focused Web
  tests**, and **10/10 macOS screenshot baselines**. Local lifecycle, corner-snap,
  aspect-ratio, and Stop
  interaction/acknowledgement gaps are closed;
- packaged arm64/x64 `.app` bundles and both mounted DMGs pass fake, real-window, and
  primary-display provenance smokes;
- Cua native-window handoff passes in dev Electron and both packaged `.app` bundles.
  Electron source ID is used only as the test oracle; the Ling descriptor carries only
  the Cua provider PID and `nativeWindowId`, with no title, foreground-window, or z-order
  fallback;
- real MediaStream first decoded frame p50/p95 is **168.09 / 177.84 ms** and
  Hide-to-release p50/p95 is **2.16 / 3.65 ms**;
- the 30-second active-preview delta is **0.21%** of one CPU core with **11,763,712 bytes**
  working-set overhead; ten-cycle Show/Hide churn is **6.04%** main-process CPU with
  **17,661,952 bytes** app working-set growth;
- the fake ownership/crash lane records **415.27 ms p95**;
- twelve capture activations perform exactly **12 source enumerations**, reuse **1 renderer
  document**, and make **0 `applyConstraints()` calls**;
- final window, renderer, process, track, timer, subscription, IPC, adapter-source, and
  raw-listener residue is **0**;
- Vite empties the preview `outDir` before building, and packaged `app.asar` contains only
  the current seven preview-subtree entries (two directories and five files).
- macOS bundles carry the committed Ling `icon.icns`, while the Windows app and NSIS carry
  all nine frames from the committed Ling `icon.ico`; neither package uses Electron's
  default icon. The Windows installer is explicitly one-click, per-user, `asInvoker`, and
  contains no elevation helper.

One full daemon parallel-suite run hit scheduling-sensitive fluctuation in the
`channel auto_route` unit test and left its worker alive. The same test passed in isolation,
and the focused contracts/API/daemon/plugin matrix remained **51/51**; this is a parallel
test-harness issue, not a Desktop PiP product failure.

Final unsigned artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| arm64 DMG | `e42b944b84bf67174d18dec422637cbde6988c4d2283f503597b09aae50727fb` |
| x64 DMG | `a9e8aa208af6dc9baff96b9550166095660adc1b596c4f86544287ac0ca19258` |
| arm64 ZIP | `6c9ac51d212a7a4b930cf8bcb8c93f7e4b4f07bb17b93d1205f01b2ff99face5` |
| x64 ZIP | `49a8bc3d5dce9def59c49b7a53f9fb31fea72e960dd9e99f806809d995bb695e` |
| Windows x64 unpacked app | `3f6ad1bbb45816bb46b15d2e23eb7a60843eb2a8fbc25ae0e541fb29af1d596e` |
| Windows x64 NSIS | `52b115f2ef02394ed0e352c28f60052ec572eec02f708c2a942bd64d9b4de5e2` |

Both DMGs and ZIPs pass their integrity checks. The unpacked Windows application and NSIS
PE certificate-table sizes are both **0**, and no Apple Developer ID identity is installed.
Developer ID signing/notarization/Gatekeeper, clean-host TCC/capture-indicator evidence,
Windows interactive provider/DPI/dual-display execution,
Authenticode/SmartScreen/signed NSIS, hosted CI, clean-machine install/update/uninstall,
and VoiceOver/Narrator/NVDA evidence are still open release gates.
