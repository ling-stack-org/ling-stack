# Bundled CUA Driver Implementation And Release Plan

Status: active platform-closure plan
Owner: Desktop, CUA provider and release maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Bundled CUA Driver](cua-driver-bundled-embedded.md)
- [Bundled CUA Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)
- [Guided Installation](cua-driver-guided-installation.md)
- [Desktop Release](../release/desktop.md)

Those documents own runtime, authority, integrity and safety behavior. This plan keeps only
the unfinished product and target-platform gates.

## Current Baseline

- reviewed bundled descriptors, version pins and integrity verification exist;
- activation is daemon-owned, lease-scoped and fail-closed;
- Desktop capability, IPC and provider composition are typed;
- macOS and Windows package foundations and negative fixtures exist;
- untrusted, missing, mismatched or unhealthy providers remain unavailable;
- external installation remains an explicit fallback rather than a second canonical row.

## Remaining Delivery

### Computer Control Settings

- Ship one user-facing Computer Control surface under Device settings.
- Present installed, unavailable, blocked and repair states without duplicating Plugin or
  MCP ownership.
- Keep raw descriptor, checksum, provider and authority fields in diagnostics only.
- Do not auto-connect or auto-enable bundled CUA merely because it is packaged.

### macOS Release Gate

- Validate a signed and notarized candidate on a clean host.
- Cover denied, prompted, granted and revoked capture/accessibility permissions.
- Verify restart, update, uninstall and provider integrity behavior.
- Confirm the running provider and daemon match the signed candidate provenance.

### Windows Release Gate

- Validate the installed signed x64 application and reviewed provider on Windows 11.
- Cover Authenticode, SmartScreen, DPI, multi-display, restart and uninstall behavior.
- Verify antivirus-style file failures recover or fail closed without partial activation.

### Accessibility And Supply Chain

- Verify keyboard, VoiceOver and Narrator/NVDA paths on packaged candidates.
- Bind release attestations to immutable source, policy, artifact and provider hashes.
- Keep signing identities and secrets outside repository and renderer state.

## Safety Invariants

- CUA remains separate from ordinary model/provider readiness.
- Renderer state cannot grant authority or bypass daemon activation.
- Bundling is not consent; activation still follows explicit product and permission rules.
- Unknown provider versions, integrity mismatch and stale leases fail closed.
- Logs, errors and release artifacts never contain secrets or unrestricted desktop frames.
- Tests or browser fixtures cannot close a real signed target-platform gate.

## Evidence Policy

Store run logs, screenshots, hashes and signed attestations in CI or Release artifacts.
This plan records only the required gates and their open/closed state.

## Closure

Delete this plan after the Settings surface and all signed target-platform gates close.
Keep the contracts and release authority as the long-lived record.
