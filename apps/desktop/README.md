# Desktop App

Desktop packaging is intentionally deferred until the CLI and local daemon are useful.

The desktop app should be a shell over the local daemon and shared Web UI. It should own
daemon lifecycle, menu/tray, notifications, file picker, keychain, and update UX, but it
must not fork the Ling Stack product model or bypass daemon state machines.

Design source of truth:

- [Desktop Shell](../../docs/design/desktop-shell.md)

Candidate implementation paths:

- Electron for the fastest TypeScript-first alpha.
- Tauri for smaller bundles and stronger native boundaries after the daemon API stabilizes.
