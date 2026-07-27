# P6A.3 Channel Task And Environment Evidence

Captured from the real Vite application on 2026-07-19. The Playwright fixture uses the mock daemon only for
deterministic domain state; all screenshots render the production React/CSS path.

## Function IDs

- `CHANNEL-TASK-001`
- `CHANNEL-ENV-001`

## Screenshots

| File | Viewport / theme | Reachable state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-task-detail.png` | 1440x960 / `ling-light` | failed task, repair action, context folded, four permission choices visible | `60ab431fc77045677754e3670fd4fe1fa650d3d211f892cd31b5c2455de7ff51` |
| `1280x800-ling-dark-channel-new-task.png` | 1280x800 / `ling-dark` | task fields, expanded execution context, generation-only model notice | `e9db9c4678b0478ff4d74963289d2b3c042184d67bdb44b7125968e5292afe0b` |
| `1440x960-ling-light-channel-workflow-preview.png` | 1440x960 / `ling-light` | proposed workflow, owner rows, source plan and shared Dialog actions | `1718f88d254dde2b5a90acbc407e3cde6430b37488b9d7d61454d7c1532f2c5d` |
| `1440x960-ling-light-channel-environment-conflict.png` | 1440x960 / `ling-light` | five-row environment, dirty/conflicted Git state, diff stats | `292dcdaf1a87e9cc8e9de2a5ec06bf0e1900ad77b99efa69e42d6f53b74ba7fc` |
| `1440x960-ling-light-channel-environment-commit-preview.png` | 1440x960 / `ling-light` | read-only shared Dialog, warning, Switch, complete 2x2 actions | `e8af55dbc3c635e3c7e568223784285e2f57ba58666c6dda85722b47cf01e097` |
| `1280x800-ling-dark-channel-environment-unavailable.png` | 1280x800 / `ling-dark` | persistent Git transport failure without fake clean state | `f11d12ccf36701662b6492f108486611825e1205575ebc0e8fbaa7d3fb2a1094` |

All files match the viewport encoded in their filename. Task screenshots wait until the live dock layout variable
reaches 304px, so the evidence does not capture the 240ms entrance transition halfway through.

## Verification

- Web typecheck, i18n audit and UI 2.0 lint passed.
- `ui2-channel-task-environment.spec.ts`: `5/5`.
- Workspace/Dark/P5/P6A combined regression: `30/30`.
- Channel full regression: `104/105`; the sole failure was a stale Environment selector, and its corrected target
  rerun passed `1/1`. The workflow conversion targets passed `2/2` after the Dialog migration. The other 104
  scenarios passed unchanged.
- Original-size visual inspection confirmed no document overflow, clipped action labels, hidden permission choices,
  theme leakage, overlapping rows or mid-transition dock capture.

## Ownership

- Focused presentation: `ChannelNewTaskPanel.tsx`, `ChannelTaskDetailPanel.tsx`,
  `ChannelEnvironmentPage.tsx`, `ChannelEnvironmentCommitDialog.tsx`.
- State projection: `channel-task-view-models.ts`.
- Focused CSS: `channel-task-environment.css`, `channel-workflow-preview.css`.
- `WorkspaceClientView.tsx` remains the domain adapter; no task, Git, approval or permission state machine moved into
  the shared package.
