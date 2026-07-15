# Desktop App

Desktop packaging has not started. The approved first implementation boundary is a
minimal Electron shell over the local daemon and shared Web UI, followed by the
cross-platform Computer Use picture-in-picture slices documented below.

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

Candidate implementation paths:

- Electron for the fastest TypeScript-first alpha.
- Tauri for smaller bundles and stronger native boundaries after the daemon API stabilizes.

The first Computer Use picture-in-picture implementation targets macOS and Windows. It
uses shared React/Electron behavior plus a narrow capture adapter. Hide or window close
must never stop the underlying Computer Use session; stopping remains a separate daemon
command with approval and audit semantics.

The Desktop main window must load the shared Web application instead of copying its page
tree. This lets the shell, contracts, coordinator, and fake PiP renderer land before the
final conversation UI is approved; later UI changes should touch only typed capability
slots, geometry reporters, and visual polish.
