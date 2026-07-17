# Cua Driver Plugin Shell

This bundled Ling plugin shell describes how Ling can connect to an already installed
`cua-driver` MCP server on macOS or Windows.

The package does not include native binaries, app bundles, installers, or download logic.
Users must install and permission the local driver separately before applying the trusted
local MCP preset.

The Windows preview integration is based on the maintained open-source Cua Driver Rust
provider. Version `0.8.3` publishes an x86_64 Windows artifact and returns structured
`window_id` (HWND) plus `pid` identities from `list_windows`. Ling consumes only those
explicit target identities; it never guesses from the foreground window, z-order, or title.

On Windows, the driver and Ling Desktop must run in the same interactive user session.
Session 0 has no usable interactive desktop and must fail health checks instead of being
treated as a valid provider.
