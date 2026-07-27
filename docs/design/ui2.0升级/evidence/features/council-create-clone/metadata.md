# Council Create / Clone A Evidence

## Snapshot

- Date: 2026-07-27 T12.1d recapture (Asia/Shanghai)
- Workspace: `/Volumes/qinshan/openclawworkspace/main/workspace/repos/ling-stack`
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`
- Worktree: shared and dirty before this slice; no reset, clean, stash, checkout, commit or push was run
- Browser: Playwright Chromium, reduced motion
- Served artifact: Vite source server at `http://127.0.0.1:4174`
- Fixture: mock daemon with Council-only create/clone delay, next failure and next list-refresh failure controls

## Screenshots

| File | State | SHA-256 |
|---|---|---|
| `1440x960-ling-light-create-members-routing.png` | en-US, Ling Light, Create draft with two selected active teammates and `parallel_review` | `de43c6303a7d83085a2f60f7152702c679e98f059d4682b9e0acdbd0d5e68187` |
| `1280x800-ling-dark-zh-clone-review.png` | zh-CN, Ling Dark, Clone review with members/routing/channel-copy semantics | `63a7d2660a546c5fcd3ba9328fc21d744b2928a13e4b72c311122a427f6d61c3` |

Both files were checked as original-size RGB PNGs (`1440x960` and `1280x800`) and inspected at original resolution.

## Behavior Evidence

- Create double-click produced one `POST /ai-councils`; payload contained the selected teammate ids, positions,
  enabled flags and selected routing mode.
- `paused`, `disabled`, hidden and Ling Agent records were absent from the eligible Create choices.
- Zero members required a second explicit action; failure stayed in the Dialog and retained name, description,
  routing and confirmation state for retry.
- Create and Clone busy states blocked header close, Cancel, Escape and overlay dismissal.
- Clone failure retained editable name, description and pinned draft; retry sent one supported clone request and
  server-side state confirmed copied members/routing, `user`, `active`, selected pinned state and unchanged channels.
- Mutation success Toast was independent from projection refresh. A failed list refresh did not add the POST response
  to the UI; stale feedback remained until Repair loaded the real list and selected the new Council.
- Create/Clone now confirm the saved object through the existing `GET /ai-councils/:id` endpoint. A created Council
  omitted from the first 100 pinned/name-sorted list rows is still selected from authoritative detail data and is
  released from the temporary projection when the normal list later contains it.
- Clone re-reads the source Council and member set before POST. When routing or membership changed after the Dialog
  opened, the review updated in place, retained name/description/pinned fields and required a second confirmation;
  no clone request was sent from the stale review.
- A health filter excluding the created object reset to `all` only after the new id appeared in the authoritative list.
- Dark zh-CN Dialog bounds, document overflow, Escape focus restore and runtime console/page errors were asserted.
- T12.1d recapture additionally confirms the member checkboxes keep their focused native owner after aggregate
  `input/textarea` selectors were removed; no checkbox, label or Dialog geometry regressed.

## Verification

- Web complete typecheck: passed; dependency package builds and final `tsc -p tsconfig.json --noEmit` exited 0.
- `check:i18n`: passed (`en-US=3630`, `zh-CN=5303`, `literalKeys=3313`, `dynamicCalls=340`).
- Web UI2 lint: passed.
- Focused Create/Clone: `7/7`; Council + Settings workspace-tools integration: `16/16`.
- Tasks + Teammates + Work Board + Council + Settings workspace-tools + Dark selected regression: `49/49`.
- Tracked touched-file `git diff --check`: passed; new files were checked individually with `--no-index --check`.
- Console: no unexpected `console.error` or `pageerror` in focused tests.

## Council A Boundary

The UI reports only persisted Council configuration and deterministic membership readiness. It does not claim provider,
model or skill runtime readiness, execution provenance, source-Council provenance, or cross-channel aggregate usage.
No API, contract field, database field or migration was added.

The existing clone endpoint has no revision/conditional-submit field. The client re-check materially narrows stale
review risk, but a source can still change in the small interval between the final GET and clone POST. Closing that
last interval requires a separate API/contract decision and is not claimed by Council A.
