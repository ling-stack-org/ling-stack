# Desktop Computer Use Picture-In-Picture Release Plan

Status: active platform-closure plan
Owner: Desktop Computer Use and release maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Desktop Computer Use PiP](desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use PiP Detailed Design](desktop-computer-use-picture-in-picture-detailed-design.md)
- [Locked Computer Control Policy](locked-computer-control-policy.md)
- [Desktop Release](../release/desktop.md)

## Current Baseline

The local implementation includes the typed Desktop bridge, daemon projection, React PiP
renderer, Deck reconciliation, safe Open/Hide/Close/Stop semantics, theme and locale
propagation, crash recovery, media release acknowledgement, geometry persistence and
fail-closed provider ownership.

Local and unsigned package checks are engineering evidence only. They do not close signed,
clean-host or target-platform release gates.

## Open Release Gates

### Signed macOS

- signed and notarized arm64 and Intel x64 candidates;
- clean install, first launch, restart, update and uninstall;
- TCC denied/prompted/granted/revoked transitions and visible capture indicators;
- real-window and display capture provenance;
- VoiceOver and keyboard-only operation.

### Windows 11 x64

- signed installer, provider and application provenance;
- SmartScreen, install/update/uninstall and clean-host lifecycle;
- 100/125/150 percent DPI, portrait and multi-display geometry;
- Narrator or NVDA, High Contrast and keyboard-only operation;
- interactive provider lifecycle and zero-residue teardown.

### Hosted Release Pipeline

- immutable candidate source and policy binding;
- independent artifact/provider/signature verification;
- release metadata that cannot be converted to PASS by editing one report;
- retained evidence in CI or Release artifacts with an explicit retention period.

## Runtime Invariants

- The daemon remains authoritative for session identity, lifecycle and Stop results.
- PiP cannot appear for an untrusted session or before a usable preview source exists.
- Hide changes presentation only; Close Window does not stop work; Stop requires a daemon
  acknowledgement and negative acknowledgement remains visible as failure.
- Late descriptors, frames, IPC replies and release acknowledgements cannot revive an old
  session or dispose a newer one.
- Media tracks, object URLs, timers and windows are released on terminal state, teardown
  and crash recovery.
- PiP privacy and control authority remain scoped to the exact session, window and request.

## Verification Matrix

- Desktop unit and renderer tests cover lifecycle, races, media ownership and accessibility.
- Web tests cover current-session controls across channel, normal and teammate surfaces.
- Packaged tests cover real OS permissions, geometry, recovery and signed provenance.
- Performance acceptance measures first frame, hide/show, idle overhead and repeated
  activation without storing those run values in this document.

## Closure

Close only when signed macOS, Windows, assistive-technology and clean-host gates pass.
Move durable release rules into the release checklist and delete this plan.
