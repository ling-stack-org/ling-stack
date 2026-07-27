# P7B.1 MCP Tool Servers Implementation Plan

## 1. Slice Contract

P7B.1 将 Settings > MCP 工具服务迁移到 UI 2.0 shared primitives，并关闭以下 Function ID：

- `SETTINGS-MCP-LIST-001`
- `SETTINGS-MCP-CREATE-001`
- `SETTINGS-MCP-EDIT-001`
- `SETTINGS-MCP-CHECK-001`
- `SETTINGS-MCP-SYNC-001`
- `SETTINGS-MCP-TOOLS-001`
- `SETTINGS-MCP-DELETE-001`

该切片不改变后端 MCP 行为。AI 队友 MCP 授权只做回归，不进入本切片实现范围。

## 2. Authoritative Baseline

实施前核对值：

| Owner | Baseline |
|---|---:|
| `McpToolsPage.tsx` | 590 lines |
| `use-mcp-domain.ts` | 231 lines |
| `mcp.css` | 491 lines |
| `mcp.spec.ts` | 277 lines / 2 tests |
| `AppShell.tsx` | 3,067 lines, composition only |
| `SettingsPage.tsx` | 328 lines, composition only |

现有 API 已支持 list/create/update/check/sync/delete。数据库删除 `mcp_servers` 时级联删除 tools、status、
legacy secret rows 和 teammate bindings。Secret API 明确禁止 raw value 回读；UI 只能管理 refs。

## 3. Module Boundaries

```text
McpToolsPage.tsx
  page state, editor/delete open state, transient row feedback
  -> McpServerToolbar.tsx
  -> McpServerList.tsx
       -> McpServerRow.tsx
            -> McpServerDetails.tsx
  -> McpServerEditorDialog.tsx
  -> McpServerDeleteDialog.tsx

mcp-settings-view-models.ts
  pure status/action/transport/detail/tool projections

use-mcp-domain.ts
  authoritative async state and API actions
```

Rules:

- new production files remain under 400 lines;
- `McpToolsPage.tsx` target under 260 lines;
- `AppShell.tsx` and `SettingsPage.tsx` receive wiring-only edits;
- no Feature direct Radix/package import;
- no API/client/domain logic in JSX view-model branches.

## 4. Implementation Steps

### Step A: Pure presentation model

Create `mcp-settings-view-models.ts` with:

- `McpServerPrimaryState` and tone;
- primary state priority from disabled, migration, auth, checking, failed, expired, ready, unknown;
- `McpServerPrimaryAction` derivation;
- transport summary and technical detail rows;
- grouped tools by server;
- tool side-effect labels and technical metadata;
- `mcpServerToForm`, default form and form validation.

No translated strings are stored in types. Functions return stable translation keys and raw values.

### Step B: Domain action results

- Keep create/update throwing so Dialog can retain failures.
- Change delete action to `Promise<boolean>` so confirmation closes only after success.
- Continue setting DomainError and legacy global error for compatibility.
- Expose the scoped MCP DomainError through `AppShell -> SettingsPage -> McpToolsPage`.
- Check/sync continue returning boolean; no new API call or state machine.

### Step C: Page and list

- Replace duplicate page header with compact summary toolbar.
- Refresh becomes shared icon-only control; Add server remains primary text action.
- Use `Skeleton` for initial loading and `EmptyState` for no servers.
- Render shared `DataRow` server rows with one primary status and one derived primary action.
- Use shared `IconButton`, `Menu`, `Collapsible`, `StatusIndicator`, `Badge`, `InlineFeedback`.
- Preserve stable `.mcp-server-row` and `.mcp-tool-row` compatibility classes for existing E2E during this slice.

### Step D: Editor Dialog

- Replace hand-written sheet with shared `Dialog`.
- Use `Field`, `Input`, `Select`, `Switch`, `Button`.
- Essential transport fields remain visible; Authentication and Advanced settings use `InspectorSection`.
- Keep secret refs only; add `autoComplete="off"` and never create a secret value field.
- Validate per field and preserve input on save failure.
- Busy Dialog cannot close; success closes after domain action and refresh resolve.

### Step E: Delete Dialog

- Move Delete into shared More menu.
- Shared confirmation Dialog with Cancel initial focus.
- Cancel/Esc do not send DELETE; deleting blocks dismissal.
- Error remains inside Dialog; success closes only on `true` result.

### Step F: Focused CSS

- Add `apps/web/src/styles/settings-mcp-tools.css` after other Settings focused owners.
- Move only MCP Settings layout selectors.
- Delete `mcp.css` import and file after all selectors have a single owner.
- No literal color, `!important`, theme ID selector, private package selector, high z-index or `transition: all`.
- Record line counts and selector deletion in CSS/selector matrices.

### Step G: Focused E2E

Add `ui2-settings-mcp-tools.spec.ts`; keep AI teammate authorization in `mcp.spec.ts`.

Required cases:

1. loading, empty, refresh failure retaining authoritative data;
2. HTTP create validation, secret-ref safety and successful create;
3. stdio create/edit, transport switch and advanced settings;
4. ready/unknown/failed/disabled/missing credential/migration status priority;
5. check and sync scoped busy, success, failure and zero tools;
6. details animation, long command/URL/description, technical metadata folded;
7. delete cancel, one Esc, initial focus, busy safety, failure and success;
8. zh-CN / en-US, Light/Dark, 1440x960 / 1280x800, reduced motion;
9. no document horizontal overflow, bounded list/Dialog scroll and no console errors.

## 5. Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-mcp-tools.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- mcp.spec.ts settings.spec.ts dark-mode.spec.ts ui2-settings-shell.spec.ts ui2-dialog-controls.spec.ts ui2-form-controls.spec.ts ui2-feedback-data-display.spec.ts
```

Run a broader Channel regression only if shared overlay, global CSS or shared primitive behavior changes.

## 6. Browser Evidence

Evidence directory:

```text
docs/design/ui2.0升级/evidence/settings/mcp-tool-servers/
```

Minimum screenshots:

- `1440x960-ling-light-ready-list.png`
- `1440x960-ling-light-http-editor.png`
- `1280x800-ling-dark-empty.png`
- `1280x800-ling-dark-check-failure.png`
- `1280x800-ling-dark-tool-details.png`
- `1280x800-ling-dark-delete-failure-zh-CN.png`

`metadata.md` records branch, HEAD, dirty state, Vite URL, fixture, viewport, Theme Pack, locale, operation,
console, overflow, keyboard, reduced motion and SHA-256. Browser-injected mock daemon proves renderer behavior only;
it does not prove packaged macOS/Windows secret-store persistence.

## 7. Documentation Closeout

After evidence passes, update:

- `README.md` and temporary control guide pointer;
- `01-全产品覆盖矩阵.md`;
- `migration/03-页面迁移切片.md`;
- `migration/04-E2E与截图矩阵.md`;
- `migration/05-完成状态看板.md`;
- `migration/06-CSS逐文件拆分矩阵.md`;
- `migration/07-Selector与硬编码颜色清理.md`;
- `migration/09-旧动效与交互行为迁移矩阵.md`;
- `migration/10-全局反馈消息迁移矩阵.md`.

Only mark Function IDs `verified` after code, focused tests, selected regressions, real browser changed-state evidence
and metadata are all present. Otherwise use `implemented`.

## 8. Stop Conditions

Stop and ask the user before changing any of the following:

- adding a new transport or OAuth flow;
- accepting/storing raw secret values;
- changing delete cascade or teammate authorization semantics;
- changing Settings IA, routes, identifiers or workspace ownership;
- modifying daemon/contracts/database to satisfy a visual requirement;
- resolving a remote/local behavior conflict by removing either side.

No current stop condition is active at the start of P7B.1.

## 9. Closeout Result

- Status: `verified` on 2026-07-20 for all seven currently reachable Web Function IDs.
- Structure: `McpToolsPage.tsx` `590 -> 241`; list、row、details、editor、delete、toolbar and pure view-model
  owners were extracted, all new production files remain below 400 lines.
- CSS: 491-line `mcp.css` deleted; `settings.css` `2,557 -> 2,521`; focused
  `settings-mcp-tools.css` is 387 lines and has zero color literal、`!important`、Theme/Profile selector、
  `transition: all`、private keyframe or package-private selector hits.
- Verification: package `41/41`; focused `5/5`; existing MCP `2/2`; selected Settings/UI/Dark `34/34`;
  broader Channel + Settings + MCP `139/139`; typecheck、i18n、lint and diff check passed.
- Evidence: six original-size screenshots and SHA-256 metadata are stored in
  `evidence/settings/mcp-tool-servers/metadata.md`.
- No daemon API、contracts、database、transport、secret-store or teammate authorization behavior changed.

P7B.1 must not be reopened for general cleanup. The next executable slice is P7B.2 Skill Library; MCP changes from
that slice are limited to regression fixes caused by shared primitives or Settings ownership changes.
