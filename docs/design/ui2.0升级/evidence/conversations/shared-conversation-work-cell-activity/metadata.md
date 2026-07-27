# T13-O.14 Shared Conversation Work Cell Activity Evidence

## Environment

- Date: `2026-07-24`
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`
- Working tree: dirty integrated UI 2.0, Desktop and Computer Use work; no reset, stash, merge, commit or push performed
- Served artifact: Vite development server started by Playwright at `http://127.0.0.1:4174`
- Browser: Playwright Chromium, desktop Web surface
- Data: `mockDaemon` plus the existing development WorkCell demo fixture; no live daemon, packaged Desktop or remote provider claim
- Locale: `en-US`; the existing Channel demo intentionally retains its fixture's Chinese activity copy

## Scenarios

| File | Viewport / theme | Reachable state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-activity-active.png` | `1440x960` / `ling-light` | Channel multi-agent Activity, independent row expanded, CommandBatch expanded by keyboard | `1e23b300c68f72454dc75ede36f810753f0ddd8f98a40dd72c9d1d9caa55926b` |
| `1440x960-ling-light-channel-details-loaded.png` | `1440x960` / `ling-light` | Durable Channel WorkCell Details loaded, groups and evidence links visible | `c08c1babea08d7d9de7cbb64d86ab2fbfe85be2c5328de39443b66210a666aeb` |
| `1280x800-ling-dark-channel-details-error.png` | `1280x800` / `ling-dark` | Details request failure with keyboard-focusable Retry | `1b3c44571ee10e7ff78f3e3e7d2356dcfbd627ee856922898b96bf1ecf446729` |
| `1280x800-ling-dark-channel-command-batch-expanded.png` | `1280x800` / `ling-dark` | Retry recovered, reduced motion, CommandBatch and evidence expanded | `2fec24f45258e45d8a6d17dcade077b8c5f34d6d321c1d680f977233b7f28e2b` |
| `1440x960-ling-light-normal-work-cell.png` | `1440x960` / `ling-light` | Normal conversation completed WorkCell, nested command result expanded | `3e7a0b6f9d798e353d387eeba7ee2f8d1f927b8d1ade745936158a6dccce62b5` |
| `1280x800-ling-dark-teammate-work-cell.png` | `1280x800` / `ling-dark` | AI teammate private chat completed WorkCell, reduced motion, nested command result expanded | `08e277cef8cf5b409eee05046e8bbbca437f8afa23f6fc69c259dc8a02514840` |

All PNG dimensions were verified with `sips`, and all six images were inspected at original size. The changed surfaces are nonblank; WorkCell rows, details, command batches, feed, composer and document remain horizontally contained with no incoherent overlap.

## Interaction And Runtime Checks

- `ui2-conversation-work-cell-activity.spec.ts`: `5/5`.
- Selected existing consumers: `6/6` across Channel local demo, durable thread, active command, Normal, Teammate and durable File Diff.
- Complete `ui2-conversation-file-diff.spec.ts`: `4/4`.
- Broad App/Channel/Teammates/Dark regression: `146/147`. The only failure was the unrelated Channel composer mention
  draft assertion at `channel.spec.ts:3112`; isolated `--repeat-each=3` produced `2/3`, confirming an intermittent
  composer input-state race outside the migrated WorkCell selector and consumer set. It remains explicitly recorded,
  not counted as an O.14 pass and not hidden by deleting the assertion.
- Activity row, evidence disclosure, Retry, CommandBatch and nested command rows are exercised with Enter or Space and verify `aria-expanded`.
- Details covers `loading -> loaded`, cached close/reopen, `error -> retry -> loaded`, and single-attempt request counts.
- Dark reduced-motion checks confirm WorkCell, row, CommandBatch and agent span animations are disabled.
- Every focused scenario asserts console/pageerror and document/owner horizontal overflow.

## Ownership Result

- New owner: `apps/web/src/styles/shared/conversation-work-cell-activity.css`, `720` lines.
- `components.css`: `7,085 -> 6,259` lines.
- Web CSS: `151 files / 38,457 lines`.
- Deleted: `15` dead rules / `16` dead branches for old final report, shell card and empty families plus the structurally unreachable direct-child detail branch.
- Preserved externally owned branches: Artifact Strip completed/reduced-motion, shared `conversation-settle-in`, transcript/message approval reduced-motion.
- No API, contracts, daemon, state machine, WorkCell projector, `ConversationWorkCell.tsx`, Desktop or Function ID change.
