# T13-P.9D Channel Error Ownership Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-27` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Engineering send and rename each return one intentional synthetic `503`; Research remains clean |

The focused P9-D spec passed `3/3` in capture mode. The full Channel regression passed `105/105`, the selected
Channel ownership regression passed `35/35`, and `@ling-stack/conversation-ui-react` passed `23/23`. The capture
must continue to use the Playwright-managed Vite source rather than a built or container-served artifact.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-research-clean-after-late-failure.png` | `1440x960`, `ling-light`, `en-US` | A delayed Engineering send failure is absent after switching to Research | `90fca2417d3f7e7e9313b9fe82542164e57f6a26188291a41916e5efcff98eb8` |
| `1440x960-ling-light-engineering-composer-failure.png` | `1440x960`, `ling-light`, `en-US` | Returning to Engineering restores its draft, persistent failure and Retry action | `7502611e48a7a5da16a53ba4f374acfb2ebf50b551c6796ba1e94f8209aa31f7` |
| `1280x800-ling-dark-rename-dialog-failure.png` | `1280x800`, `ling-dark`, `en-US` | Rename failure remains inside the owning Dialog and its Input remains contained | `6ad00dc67d918080e7268cd38b9b971185d8f222d0c1708c8f0546e6c24aeb91` |

## Runtime And Geometry

- Page errors: `0`; unexpected console errors: `0`. Each failure scene allows exactly one Chromium resource error for
  its intentional `503` response.
- Document horizontal overflow is numerically asserted at `<= 1px` in the failure, Dialog and post-switch states.
- The delayed Engineering failure cannot overwrite Research, and unrelated navigation cannot clear Engineering's
  saved composer draft or Retry state.
- Create, rename, composer, task, workflow, protocol, dock and sidebar failures render in their owning surface instead
  of the AppShell page-level generic error slot.
- Shared Input containment remains owned by T12.1b/c/d. Package `70/70`, Form `4/4`, reachable raw text controls `0`,
  and the Dark rename Dialog original-size inspection show no focus-height regression.
- No API, contract, database, route, request-count, state-machine, approval or retry behavior changed.
