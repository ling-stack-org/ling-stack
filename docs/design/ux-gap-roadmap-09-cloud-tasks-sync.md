# Cloud Task Execution + Cross-Device Sync

## Status

Status: design approved (architecture); not scheduled for this branch
Owner: Daemon / Remote Access / Infrastructure
Last verified: 2026-10-26

## Background and competitive reference

Codex, MiniMax, and WorkBuddy all execute in a cloud+local hybrid: tasks can
continue when the laptop is closed, and state follows the user across devices.
Ling is local-first with a loopback daemon — a deliberate strength (privacy,
BYOK, no vendor lock-in) — but it means: computer off = everything stops, and
mobile access is a paired mirror, not a peer.

## Goal

Long-horizon architecture decision record (ADR) plus a phased path that
*preserves* local-first as the default rather than abandoning it:

1. **Phase A — relay-resident daemon (bring-your-own-cloud).** The daemon can
   run on a machine the user owns (home server, VPS, any always-on box);
   desktop/web/mobile are already thin clients over its loopback HTTP, so
   "cloud" is deployment, not a new runtime. Deliverables: headless daemon
   packaging, TLS + token auth for non-loopback binding, pairing flow reuse
   from `remote-access`.
2. **Phase B — vendor-hosted optional relay.** A hosted relay (auth +
   encrypted tunnel to a *user's own* daemon, zero server-side conversation
   storage). This is an infrastructure product decision requiring a billing
   identity; explicitly out of scope for the source-alpha repo.
3. **Phase C — device sync.** Conflicts resolve daemon-authoritative: devices
   are views, never forks. Sync scope limited to settings/preferences +
   notification journal + conversation index metadata; conversation bodies
   stay on the daemon (they already do).

## Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Thin-client architecture | advantage | No client changes to move the daemon; this is why the daemon/client split was kept. |
| Mobile remote access (`remote-access`, `remote-protocol`) | reused | Pairing auth becomes the non-loopback auth story in Phase A. |
| Approvals / authority | constraint | Remote approval from mobile already exists (offline approvals); cloud mode inherits it unchanged. |
| Local-only desktop features (Office driver, Computer Use, CUA) | boundary | These are *device-resident* capabilities; a remote daemon must advertise capability absence (already modeled: desktop authority gates) so agents don't promise what the host can't do. |

## Incompatible-case upgrade path

If Phase B relay materializes, the daemon gains an outbound-only tunnel mode
(no inbound ports); the security review that currently gates mobile access
reopens first — this is recorded as a hard dependency, matching the existing
implementation-status note.

## Implementation plan (Phase A slice for this branch)

1. Daemon: `--bind` + `--auth-token` configuration, TLS termination guidance
   doc, capability advertisement for device-resident tools.
2. CLI: `ling daemon serve --bind 0.0.0.0 --auth-token <ref>` with explicit
   non-loopback confirmation.
3. Docs: self-hosting guide (reverse proxy examples).
4. Tests: auth-token enforcement unit tests, capability advertisement unit tests.

## Acceptance

- Daemon refuses non-loopback binding without an auth token (unit test).
- Capability absence for device-resident tools is asserted in contracts tests.
