# T13-P.9C AppShell Error Ownership Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-27` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Provider list returns one synthetic `503`; Channel remains reachable and clean before and after Model Workbench |

The focused P9-C suites cover Provider, Runs, Approvals, MCP, Settings and the AppShell cross-page boundary. The
implementation closeout passed its combined `50/50` regression, the Settings Authorization/Personalization follow-up
passed `5/5`, and this evidence spec passed `3/3` in capture mode. A no-capture rerun must continue to use the same
Playwright-managed Vite source rather than a built or container-served artifact.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-provider-failure.png` | `1440x960`, `ling-light`, `en-US` | Provider load failure is visible only inside Model Workbench | `3779544d8684044bd51970dd7cda329cbfe0400364a2715b039bbddf6be024c1` |
| `1440x960-ling-light-channel-clean.png` | `1440x960`, `ling-light`, `en-US` | Returning to Channel shows no Provider error | `002102113caf06d7b4e1028001fe5305de49521779a426e2af3c3a99bd3dd752` |
| `1280x800-ling-dark-provider-failure.png` | `1280x800`, `ling-dark`, `en-US` | Dark compact Model Workbench keeps the failure in its page owner | `6174e9e9337b870a9827bd094891fba5f2a92d8f2b330563145aecef6dff33fb` |
| `1280x800-ling-dark-channel-clean.png` | `1280x800`, `ling-dark`, `en-US` | Dark compact Channel remains clean after the failed Provider request | `149b66a762b7ae55b49378032080862ef404e6015796ddc17e4a66cc94a80156` |

## Runtime And Geometry

- Page errors: `0`; unexpected console errors: `0`.
- Document horizontal overflow is numerically asserted at `<= 1px` after returning to Channel.
- The Provider failure is absent in Channel, visible once in Model Workbench, and absent again after Back to app.
- Provider, Runs, Approvals, MCP and Settings hooks no longer receive or write the generic AppShell error setter.
- Approval decision failure remains keyed by approval identity; Provider row-check transport failure remains in the row
  feedback owner established by P8.
- Both themes and both desktop viewports were inspected at original size. No clipping, overlap or theme leakage was found.
