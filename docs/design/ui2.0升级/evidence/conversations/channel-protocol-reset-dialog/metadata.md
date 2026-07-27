# T13-P.6-F Channel Protocol Reset Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Base Engineering Channel plus a Research Channel for stale-target dismissal; success reset is delayed `800ms`, failure reset returns `500 channel_protocol_reset_failed` |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-confirm.png` | `1440x960`, `ling-light`, `en-US` | Protocol Reset confirmation with non-destructive Cancel focused and Channel inspector visible | `2e8727e9bcd0146ee1eae0b896d28722160e88caac9c26f7d82686694c2ca271` |
| `1440x960-ling-light-success-toast.png` | `1440x960`, `ling-light`, `en-US` | One scoped success Toast after one reset request; focus restored to Reset | `e029cfcab3db7f4a438ae31f4f6fc5d389dee0dae25ec10ed88ed6e53d8fd932` |
| `1280x800-ling-dark-persistent-failure.png` | `1280x800`, `ling-dark`, `en-US` | Persistent Dialog failure with retry action under reduced motion and no duplicate AppShell error | `cad0375cfd2372edb84957e9f5ba42ab2c0cf40d217efd35f69b13996c1aaec1` |

## Runtime And Geometry

- Console errors: `0` unexpected; the collector excludes Chromium's generic failed-resource line for the intentional `500`. Page errors: `0`.
- Browser blocking dialogs: `0`; source guard also proves no `window/globalThis.confirm` owner.
- Document plus Dialog/Toast bounds and horizontal overflow were numerically asserted within the viewport.
- Cancel, Escape and channel switching restore focus or close the stale Dialog without a mutation. Busy reset blocks Escape and duplicate requests.
- Dark failure computes `animation-name: none` under reduced motion.
- Original-size inspection found no clipping or geometric overlap.

## Error Ownership Follow-up

The locally owned reset action now calls the channel command with `errorOwner: "caller"`. The exact recapture run
(`ui2-channel-protocol-reset-dialog.spec.ts` plus Saved View) passed `5/5`; the Dialog retains the actionable failure
and `.inline-error` is absent. The new Dark PNG confirms one visual failure owner.
