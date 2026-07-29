# T13-P.6-G Model Workbench Feedback Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-27` P8 feedback ownership recapture |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Light: one ready Feedback Relay plus two discovered custom models. Dark: two ready providers, then reload with one ready and one failed provider for partial batch feedback |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-import-success-toast.png` | `1440x960`, `ling-light`, `en-US` | Two imported presets appear in the table with one import success Toast and no local success result | `7c6a9d68fba7254c18bf4fcf9b276f02817e10a1640ad7fad6e42de9ed81335a` |
| `1280x800-ling-dark-partial-failure.png` | `1280x800`, `ling-dark`, `en-US` | Batch check keeps one persistent repair summary for `1 ready / 1 failed`; no success Toast remains | `cdcfa379e9100ff10d30934518345581978795c89cbdb03b4878d694a137352a` |

## Runtime And Geometry

- Console errors: `0` unexpected. Page errors: `0`.
- Document horizontal overflow was numerically asserted at `<= 1px` in both states.
- The focused spec separately verifies save success, import success, all-success batch Toast and partial-failure persistence.
- Dark partial failure emulates and asserts `prefers-reduced-motion: reduce`; no focus-specific acceptance is claimed for this feedback slice.
- Both PNGs were inspected at original dimensions and show no clipping, row overlap or theme leakage.

P8 recapture ran Model, Channel Workspace and Settings MCP together at `14/14`. Model row success additionally uses
`provider:<id>:check`, has no `.provider-check-feedback-row.ok`, expires within five seconds, and keeps a failed row
persistent until retry or provider configuration identity change.
