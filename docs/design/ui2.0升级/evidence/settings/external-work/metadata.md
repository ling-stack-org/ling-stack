# P7A.5 External Work Evidence

Captured and verified on 2026-07-20 from the real Playwright-managed Vite server at
`http://127.0.0.1:4174/`.

## Source And Scope

- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`
- Focused owner: `apps/web/e2e/ui2-settings-external-work.spec.ts`
- Web owners: `ExternalWorkSettingsPanel.tsx`, `ExternalWorkReadySurface.tsx`, the focused workflow,
  credential, operations and activity sections, `external-work-settings-view-models.ts`, and
  `use-external-work-domain.ts`
- CSS owner: `apps/web/src/styles/settings-external-work.css`
- Shared owners: `@ling-stack/ui-react` Field/Input/Select/Button/IconButton/Dialog/DataRow/
  StatusIndicator/InlineFeedback/InspectorSection/EmptyState/Skeleton
- Browser: Playwright Chromium, one isolated context per test
- Mobile is not an acceptance target.

This is Web renderer evidence. It does not claim packaged macOS/Windows Keychain persistence, native restart
behavior or a workflow-delete capability that the current daemon/API does not provide.

## Screenshot Matrix

| File | Viewport | Theme / locale | Reachable state | SHA-256 |
|---|---|---|---|---|
| `1440x960-ling-light-ready-github.png` | 1440x960 | `ling-light`, en-US | ready GitHub, status rows, operations and truthful count summary | `a0eb26d467515a18f9f0bdffb782971f1f08c78e7a460c3daaec7348007f6084` |
| `1280x800-ling-light-status-refresh-failure.png` | 1280x800 | `ling-light`, en-US | refresh 503, last authoritative state retained, scoped raw detail expanded | `a996f849ffab2bacaa033a1da09d90bafdae6923aa2c53442cac6c156b0d40a7` |
| `1280x800-ling-dark-workflow-missing.png` | 1280x800 | `ling-dark`, en-US, reduced motion | missing workflow, invalid repository, disabled create action, raw parser detail folded | `7a4a5f8b418ac0c996a84db822ba6da19ee16b9f9c54d09597d1b4e186c3b5c0` |
| `1280x800-ling-dark-token-delete-failure.png` | 1280x800 | `ling-dark`, en-US | Keychain delete failure retained inside the confirmation Dialog | `4289717c3130ee5216dd71410b7c6f65aeb2d4dd17feae66280cfe2d0dea6c94` |
| `1280x800-ling-dark-linear-unsupported-zh-CN.png` | 1280x800 | `ling-dark`, zh-CN | Linear ready state, background unsupported, localized compact actions | `0193a068e48496aa237667e6a975ef325304f324acfd0e8d1a00a45912b3e7bd` |

All PNG files were checked at original resolution. Settings navigation/content retain their independent scroll
owners; forms, details, actions and the Dialog remain inside the target viewport with no document horizontal
overflow. Dark surfaces use semantic tokens without hard-coded light blocks. The expected synthetic HTTP 503
requests produced product feedback but no JavaScript, React or page errors.

## Interaction Evidence

- No selected channel renders one compact EmptyState; Refresh and all mutation controls stay absent.
- SettingsShell owns the page title. External Work does not render a duplicate H2, `.panel` shell or card wall.
- Refresh is icon-only and only that control reports loading; the last authoritative state survives refresh failure.
- Missing and invalid workflows expose Create or Repair respectively. Invalid repository input disables submit and
  does not send a request.
- Credential editing remains absent until the workflow is valid. Token input is password-only, is cleared on
  submit and never receives a stored value.
- Only Keychain-backed credentials expose Remove. Cancel and one Esc send no request and restore trigger focus;
  delete failure stays in the Dialog, while success closes only after authoritative refresh.
- Poll, Reconcile and Start/Stop use action-scoped loading. Linear keeps Poll/Reconcile but truthfully omits
  unsupported Start/Stop.
- Settings shows Work items, CI triage and Actions counts only. It does not expose fake record navigation or a
  workflow-delete control.
- Raw path, event, scheduler, provider, secret reference and backend errors remain in Inspector/Dialog detail layers.
- Reduced motion changes transition duration without changing state or geometry.

## Verification

```text
@ling-stack/ui-react test                                      41/41
ui2-settings-external-work.spec.ts                              5/5
selected Settings/UI/Dark/Channel regression                  132/132
Web typecheck                                                  passed
Web check:i18n                                                 passed (en-US=3264, zh-CN=4970)
Web lint                                                       passed
git diff --check                                               passed
```

Lint checkpoint:

```text
Feature direct package imports                                  0
SelectControl compatibility                                  36/43
legacy z-index budget                                        89/97
high literal z-index budget                                  23/25
```

CSS and module checkpoint:

```text
settings.css                                            2611 -> 2557
settings-external-work.css                                      206
ExternalWorkSettingsPanel.tsx                           396 -> 127
ExternalWorkReadySurface.tsx                                    107
focused CSS color/important/theme-id/all/keyframe/private hits    0
current Web CSS                                      72 files / 46225 lines
```

## Status Decision

- `SETTINGS-EXTERNAL-STATUS-001`: `verified`
- `SETTINGS-EXTERNAL-WORKFLOW-001`: `verified`
- `SETTINGS-EXTERNAL-TOKEN-001`: `verified`
- `SETTINGS-EXTERNAL-SECRET-001`: `verified`
- `SETTINGS-EXTERNAL-OPERATIONS-001`: `verified`
- `SETTINGS-EXTERNAL-RECORD-001`: `verified`
- `SETTINGS-EXTERNAL-ERROR-001`: `verified`
- `SETTINGS-EXTERNAL-WORKFLOW-DELETE-001`: remains `inventory` and absent.

P7A.5 is closed for the currently reachable Web surface. The next executable slice is P7B.1 MCP Tool Servers.
