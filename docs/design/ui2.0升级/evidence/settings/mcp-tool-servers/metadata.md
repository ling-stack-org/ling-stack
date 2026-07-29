# P7B.1 MCP Tool Servers Evidence

Captured on 2026-07-20 and recaptured for P8 feedback ownership on 2026-07-27 from the real Playwright-managed Vite server at
`http://127.0.0.1:4174/`.

## Source And Scope

- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`
- Focused owner: `apps/web/e2e/ui2-settings-mcp-tools.spec.ts`
- Web owners: `McpToolsPage.tsx`, the focused server list/row/editor/delete/details components,
  `mcp-settings-view-models.ts`, and `use-mcp-domain.ts`
- CSS owner: `apps/web/src/styles/settings-mcp-tools.css`
- Shared owners: `@ling-stack/ui-react` Button/IconButton/Field/Input/Select/Switch/Dialog/Menu/DataRow/
  StatusIndicator/InlineFeedback/Collapsible/InspectorSection/EmptyState/Skeleton
- Browser: Playwright Chromium, one isolated context per test
- Mobile is not an acceptance target.

This is Web renderer evidence. It proves the MCP Settings UI contract against the browser-injected mock daemon.
It does not claim packaged macOS/Windows secret-store persistence or change AI teammate MCP authorization.

## Screenshot Matrix

| File | Viewport | Theme / locale | Reachable state | SHA-256 |
|---|---|---|---|---|
| `1440x960-ling-light-ready-list.png` | 1440x960 | `ling-light`, en-US | loaded server list, compact readiness summary and tool count | `c64017f946cf60ada880c86d90d97d3b2d7103fdf4a936dd086e3cf25dbe42d9` |
| `1440x960-ling-light-http-editor.png` | 1440x960 | `ling-light`, en-US | HTTP editor, Authentication expanded and secret reference only | `9db0263956e1ec09a0eb175461e82aa75d56a668a7163e82f9b45f2f6d891705` |
| `1280x800-ling-dark-tool-details.png` | 1280x800 | `ling-dark`, en-US, reduced motion | server details, long tool description and folded technical metadata | `4a75cad1ac83005de76346d4f9661d3d2ad3fa2474e55d36d0861f7f5921bd40` |
| `1280x800-ling-dark-check-failure.png` | 1280x800 | `ling-dark`, en-US | connection check failure retained with its server row | `78aa208a00bcdc1460ca811a747ac8f95a25afff74489b7a568c02d2a215f69a` |
| `1280x800-ling-dark-delete-failure-zh-CN.png` | 1280x800 | `ling-dark`, zh-CN | destructive confirmation with failed delete retained inside Dialog | `7853e0991928b1e8be7a03fa2ad7bba8c8ec5964637cba9d4cc8756ba3c892d6` |
| `1280x800-ling-dark-empty.png` | 1280x800 | `ling-dark`, en-US | compact empty state and single Add MCP server action | `e7c7a082c5f10878b0ae6820a121a574b3cba5ec62e3b935febbd99365e611a6` |

All PNG files were checked at their original dimensions. The Settings navigation and content retain independent
scroll owners; long commands, URLs, descriptions, details and Dialog content remain contained without document
horizontal overflow. Dark surfaces use semantic tokens without hard-coded light blocks. Synthetic HTTP failures
produce product feedback without JavaScript, React or page errors.

## Interaction Evidence

- Initial loading uses Skeleton; empty data uses one compact EmptyState. Refresh loading remains scoped to Refresh,
  and the last authoritative list remains visible after a refresh failure.
- Each server row exposes one primary status. Raw health, endpoint, command, args, environment, secret references and
  tool schemas remain inside details or advanced settings.
- HTTP and stdio editor states use progressive fields. Authentication and Advanced settings are folded by default;
  the UI never renders, accepts or reads a raw stored secret value.
- Validation stays beside the relevant field. Save preserves entered values on failure; busy editor state ignores
  Esc and only closes after the domain action and authoritative refresh complete.
- Check and Sync use separate action-scoped busy states. Lightweight success uses one global scoped Toast; failure
  remains with the affected server until retry or configuration identity change. Runtime status/timestamp refresh does
  not clear the failure, while deletion or a real configuration replacement suppresses stale completion.
- Delete is available only from the More menu. Cancel and one Esc send no request and restore trigger focus; busy
  deletion cannot be dismissed; failure stays in the Dialog; success closes after a `true` domain result.
- AI teammate MCP authorization continues to use its own management surface and regression spec.
- Reduced motion removes transition duration without changing state, focus or geometry.

## Verification

```text
@ling-stack/ui-react test                                      41/41
ui2-settings-mcp-tools.spec.ts                                  5/5
mcp.spec.ts                                                      2/2
selected Settings/UI/Dark regression                           34/34
Channel + Settings + MCP regression                           139/139
Web typecheck                                                  passed
Web check:i18n                                                 passed
Web lint                                                       passed
git diff --check                                               passed
```

Lint checkpoint:

```text
Feature direct package imports                                  0
SelectControl compatibility                                  35/43
legacy z-index budget                                        87/97
high literal z-index budget                                  22/25
```

CSS and module checkpoint:

```text
McpToolsPage.tsx                                        590 -> 241
McpServerEditorDialog.tsx                                      365
McpServerRow.tsx                                               201
mcp-settings-view-models.ts                                    297
mcp.css                                                  491 -> deleted
settings.css                                           2557 -> 2521
settings-mcp-tools.css                                         387
current Web CSS                                      72 files / 46085 lines
focused CSS color/important/theme-id/all/keyframe/private hits   0
```

All newly extracted production modules remain below 400 lines. `AppShell.tsx` remains an approximately 3,069-line
composition debt surface and received wiring only; future slices must continue extracting feature owners rather than
adding major behavior there.

## Status Decision

- `SETTINGS-MCP-LIST-001`: `verified`
- `SETTINGS-MCP-CREATE-001`: `verified`
- `SETTINGS-MCP-EDIT-001`: `verified`
- `SETTINGS-MCP-CHECK-001`: `verified`
- `SETTINGS-MCP-SYNC-001`: `verified`
- `SETTINGS-MCP-TOOLS-001`: `verified`
- `SETTINGS-MCP-DELETE-001`: `verified`

P7B.1 is closed for the currently reachable Web surface. The next executable slice is P7B.2 Skill Library.
