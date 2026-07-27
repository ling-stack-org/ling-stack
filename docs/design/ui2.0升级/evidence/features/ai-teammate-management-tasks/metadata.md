# P8.1i AI Teammate Tasks Evidence

## Scope

- Captured: 2026-07-21, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, checkout, commit, push,
  rebase or merge was run.
- Surface: real Vite application with Playwright daemon fixtures, not static component HTML.
- Function ID: `TEAMMATE-TASKS-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

The selected teammate owns one scoped `Recent tasks` Settings Tab. Work Board remains the complete task-management
owner. Tasks can also be created from an individual private-chat message, but creation is limited to active channels
that already contain the teammate and never starts a Run automatically. A row with `currentRunId` opens Runs; all
other rows open and focus the existing Work Board item. The verified custom teammate setup, avatar, model selection
and seven-step creation flow remain unchanged.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-mixed-states.png` | 1440x960 / `ling-light` | all eight stored task states and Runs/Work Board row actions | `6fdf2c72c0479fdc89def3c4cadc3155a3989747b1a3fcebcb7f55f07c3fa8c7` |
| `1440x960-ling-dark-create-success-toast.png` | 1440x960 / `ling-dark` | explicit create success, no auto-run and global `View task` Toast | `52b086434743e1ea463b3eb96abcd0fb9af5810ab50b46f2c8147418f4b0a3f2` |
| `1280x800-ling-dark-dense-scroll.png` | 1280x800 / `ling-dark`, reduced motion | exact 100-row recent boundary, attention filter and internal scroll | `26664ba3816ac675a52ae118f5630c53c26cfa882be5a9e3a6e20365121c7ad5` |
| `1280x800-ling-dark-no-active-channel.png` | 1280x800 / `ling-dark` | paused membership and unrelated active channel excluded; repair action visible | `90fbc3e301c247133fa94513c885261cd9e573e721ae849145967d3b566d9077` |
| `1280x800-ling-light-create-failure.png` | 1280x800 / `ling-light` | form failure remains local and preserves title/prompt | `9bc697fc2b85b25ff46a4f6d095587272660d6250416e7cb766dec0a1b45f5db` |
| `1280x800-ling-dark-message-failure.png` | 1280x800 / `ling-dark`, reduced motion | per-message busy, success Toast and row-local failure | `751ff5052402db9e30478b15c8e1090bf285978b6ea87e09fdff42332cf9c839` |

All six RGB PNGs match the viewport encoded in their filenames and were inspected at original resolution. The final
1280 dense capture uses a fixed-width status filter and icon-only row action, so long identities truncate without
clipping an action label or creating document overflow. Light/Dark status, warning, failure and Toast surfaces use
theme tokens. The list, create panel, shell navigation and right configuration summary remain separate scroll/layout
owners.

## Reachable State Evidence

- initial loading uses stable Skeleton rows; delayed or failed refresh retains authoritative task rows and exposes a
  local retryable error;
- the eight task states project through one status owner and never expose direct state editing or a fake Retry;
- the existing API boundary remains exactly 100 recent rows, with internal scrolling and no fake total or pagination;
- only active teammate-member channels are selectable; paused, archived and unrelated channels cannot be submitted;
- explicit creation validates the active channel and prompt, retains draft on failure and creates no Run;
- private-message creation scopes `aria-busy`, disabled state and failure to the triggering message; another message
  remains actionable;
- success uses one deduplicated global Toast with `View task`; it is not hidden in the Tasks Tab;
- a `currentRunId` routes to Runs, while another row opens the exact `task:<id>` in Work Board;
- an older list response cannot overwrite a just-created task, cross a teammate switch or repopulate the wrong
  identity;
- every focused scenario checks browser errors and document overflow; reduced motion adds no Feature animation.

## Verification

- Focused `ui2-teammate-management-tasks.spec.ts`: `9/9`, including final evidence capture.
- Tasks + Teammates + Work Board + Council + Settings workspace-tools + Dark selected regression: `49/49`.
- Wider Profile/Model/Skills/Settings regression: `104/105`; the sole Skills search timeout did not reproduce in
  three isolated repeats (`3/3`) and did not affect the `49/49` Tasks/Council integration gate.
- Web `typecheck`, `check:i18n`, UI 2.0 lint and `git diff --check`: passed.
- Focused CSS scan: zero hard-coded colors, `!important`, private keyframes, `transition: all`, package-private
  `.ling-ui-*` selectors or direct Radix imports.

## Structure And Residual Risk

- Focused owners: 148-line pure view-model, 291-line controller, 274-line Tab, 240-line CSS and 604-line E2E.
- `TeammateWorkspace.tsx` remains above 2,000 lines and `AppShell.tsx` remains above 3,000 lines. This slice adds only
  composition/adaptation there; future Activity, Memory, Channels, MCP and Danger work must continue extracting
  focused owners.
- No daemon API, contract, database, task state machine, task transition or Run-preflight behavior changed.
