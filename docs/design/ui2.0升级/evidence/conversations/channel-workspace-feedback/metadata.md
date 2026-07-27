# T13-P.6-G Channel Workspace Feedback Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-27` P8 feedback ownership recapture |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Base Channel state with pending approval; success workspace actions are delayed `300ms`; failure fixture adds Research and returns intentional `503`, `409` and `500` responses before recovery |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-scoped-success-toast.png` | `1440x960`, `ling-light`, `en-US` | Managed worktree creation produces one `channel:channel_engineering:workspace-binding` Toast; no local success row | `8d9aa378fc24014d1a17304d7e9684c16796d4ec1255b465f9cc3cc78c2a0a7f` |
| `1280x800-ling-dark-persistent-refresh-failure.png` | `1280x800`, `ling-dark`, `en-US` | Refresh failure remains in Workspace Settings after `3.2s` and a General/Workspace tab round trip | `a1411fb5cb0dfd8d393983516ba4ce21ddb03d9f09a9788cc9c92a81cc17be31` |

## Runtime And Geometry

- Console errors: `0` unexpected; generic Chromium failed-resource lines from the intentional HTTP failures are excluded. Page errors: `0`.
- Document horizontal overflow was numerically asserted at `<= 1px`.
- Busy state remains on the triggering action only. Editing the external path, retrying, or switching Channel clears only the owning failure.
- Dark fixture emulates reduced motion; a recovered Toast later in the same test computes `0.001s`. The captured persistent failure has no transition-dependent meaning.
- No focus-specific acceptance is claimed for this Settings action slice.
- Both PNGs were inspected at original dimensions and show no clipping, overlap or theme leakage.

P8 recapture ran Channel Workspace, Model feedback and Settings MCP together at `14/14`. Protocol and Composer
transient success/info now share the same provider-owned Toast lifecycle; their actionable failures remain in the owning
Inspector/Composer without Feature timers.
