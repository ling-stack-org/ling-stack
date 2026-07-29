# P6C.3 AI Teammate Context And Dock Evidence

## Scope

- Function IDs: `CONV-TEAMMATE-CONTEXT-001`, `CONV-TEAMMATE-DOCK-001`.
- Surface: AI teammate private Context, Review, Files, Activity, Browser and Terminal Dock pages.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty integrated Desktop/Computer Use and UI 2.0 worktree.
- Date: 2026-07-20.

## Implemented Contract

- `TeammatePrivateChatDockPages` is the focused presentation owner for private Context and Activity. Context
  projects teammate identity, private workspace, latest AI reply, attachments, recent Memory and technical details;
  Activity projects real private execution, message and run events. The two pages no longer share one JSX node.
- `teammate-private-dock.ts` is the pure projection boundary for private Review, Files, Activity, Browser and
  Terminal data. It filters runs by linked private thread ownership and merges duplicate evidence groups without
  duplicating item IDs.
- Review, Files, Browser and Terminal use the complete private history, attachments, file references, execution
  actions and terminal reports. Search-filtered messages cannot remove Dock evidence.
- Private chat explicitly disables Plans because no private proposed-plan source exists. Generic Evidence is also
  absent; Browser and Terminal are the concrete evidence pages currently backed by real data.
- The Toolbar Terminal still controls the bottom panel. Dock Terminal is a workspace-tool page for linked shell
  evidence and session state; one does not replace the other.
- Recent Memory remains visible in the default Context layer. Only IDs, branch, execution path and other technical
  metadata default to a folded Inspector.
- `WorkspaceRightDock` gained domain-neutral `includePlans` and `activityDescription` props. It does not import
  teammate data or contain private-chat state priority logic.
- Existing shared `240ms` enter, `180ms` exit, rapid reversal, reduced-motion, pointer capture and resize clamp
  behavior remains the only Dock motion owner.
- No API, contract, database, route, permission, run state machine, teammate-management behavior or IA changed.

## Automated Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3172`, `zh-CN=4878`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; Feature direct package imports remain `0`, legacy z-index
  budget is `91/97`, and high literal z-index budget is `24/25`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `@ling-stack/ui-react`: `40/40`.
- `@ling-stack/conversation-ui-react`: `10/10`.
- `ui2-teammate-conversation-dock.spec.ts`: `2/2`.
- Complete Channel, Normal Conversation and AI teammate selected regression: `78/78`.

The focused spec verifies launcher capability filtering, Context/Activity separation, loaded/loading/empty/error,
Review and Browser detail, Back/Close, Terminal session, horizontal resize, theme containment, console cleanliness and
document overflow. The selected regression also includes all three P6C focused specs, Channel and Normal baselines,
Teammates, Composer tokens, shared Toolbar/Panels, Dark mode and the Desktop Computer Use bridge.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite development server, not `dist`.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-teammate-conversation-dock.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixtures: one loaded private thread with linked run, execution action, terminal report, workspace
  changes, attachments, file references, Memory and browser evidence; one sparse private thread with unavailable
  workspace binding and failed Review request.
- Screenshots use deterministic product fixtures rendered through the real Web React/CSS path. They do not prove a
  packaged Desktop host, real provider execution or daemon persistence.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-teammate-dock-launcher.png` | `ling-light`, 1440x960 | `82c42f1d959d5a849481904c276226d23947db8c130178025517bcc00c821795` | Context, Review, Files, Activity, Browser and Terminal form one compact launcher list; Plans, generic Evidence and Channel-only actions are absent. |
| `1440x960-ling-light-teammate-context-loaded.png` | `ling-light`, 1440x960 | `d7dfed8c87b582f3ae5b7bd2c042d7c4318a1c1f2a050a8e99173a7c5d577210` | Private workspace, latest reply, attachment and recent Memory remain readable in two-row DataRows without a compressed third column. |
| `1440x960-ling-light-teammate-activity-loaded.png` | `ling-light`, 1440x960 | `91a2b246eeef499e27d85e8b52a86bb044da85b3ba2a8e741976a1cd2b717b57` | Activity shows the real AI reply and execution action, while Context-only Memory does not leak into the page. |
| `1440x960-ling-light-teammate-browser-detail.png` | `ling-light`, 1440x960 | `946339222ec7071b8eb74d18fe09e2d411900c4fc1d3e5c634ba81db7b6c1361` | Browser evidence opens a bounded detail view with the source URL and a stable Back path. |
| `1280x800-ling-dark-teammate-context-error.png` | `ling-dark`, 1280x800 | `82287f3a5bf77282acd5e6ca6f621225ed3eb5320e65933c76edbaffad2bb72d` | The unavailable workspace binding and missing reply remain object-scoped; dark surfaces do not fall back to hard-coded light colors. |
| `1280x800-ling-dark-teammate-activity-empty.png` | `ling-dark`, 1280x800 | `3386305b4d0ec8a03fd38139b1175acd8e7019f19917a1f17df11cac16441f22` | Empty Activity uses the shared compact EmptyState and preserves launcher/header geometry. |
| `1280x800-ling-dark-teammate-dock-empty-error-resized.png` | `ling-dark`, 1280x800 | `e1e04f83de4b583a41661dffe50c00157bdf187df52ced25575d0be387ea1e52` | The widened Dock remains clamped inside the viewport after an error/empty traversal; Feed and Composer do not overlap or create horizontal overflow. |

All seven PNG dimensions match their filenames and were inspected at original resolution. No compressed identity
column, overlap, document-level horizontal overflow, theme leakage or intermediate motion frame remains.

## CSS And Module Ownership Proof

- `teammates.css`: `4,800 -> 4,735` lines; legacy private Context/Dock selectors were deleted.
- `sidebar.css`: `1,850 -> 1,849` lines; the stale private Context compatibility selector was deleted.
- `teammate-private-dock.css`: new focused owner, `247` lines; its color literals, `!important`, Theme/Profile
  selectors, `transition: all` and private keyframes are all `0`.
- Total Web CSS: `65 files / 45,909 lines -> 66 files / 46,091 lines`. The temporary increase is the focused Dock
  owner plus import; aggregate management/Dock cleanup remains U9/U13 work.
- `TeammateWorkspace.tsx`: `2,502 -> 2,489` lines and remains orchestration-only architecture debt.
- `TeammatePrivateChatSurface.tsx`: `181 -> 173` lines.
- `TeammatePrivateChatDockPages.tsx`: `217` lines; `teammate-private-dock.ts`: `428` lines;
  `WorkspaceRightDock.tsx`: `727` lines. All new/focused production files remain below the 800-line guardrail.
- Legacy `TeammateChatContextPanel.tsx` was removed after its Context responsibility moved to the focused page.

## Status Decision

- P6C.3 AI Teammate Context/Dock: `verified`.
- `CONV-TEAMMATE-CONTEXT-001`: `verified`.
- `CONV-TEAMMATE-DOCK-001`: `verified`.
- All AI teammate private-conversation Function IDs are now closed. Teammate management remains a separate U9
  surface and is not claimed by this evidence.
