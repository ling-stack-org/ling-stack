# P7B.3 Archived Items Implementation Plan

## 1. Slice Contract

本切片迁移 Settings > Archived Items 的七个可达 Function ID：

- `SETTINGS-ARCHIVE-NAV-001`
- `SETTINGS-ARCHIVE-LIST-001`
- `SETTINGS-ARCHIVE-CONV-001`
- `SETTINGS-ARCHIVE-TEAM-001`
- `SETTINGS-ARCHIVE-CHANNEL-001`
- `SETTINGS-ARCHIVE-BRANCH-001`
- `SETTINGS-ARCHIVE-CONFIRM-001`

P14 的真实 restore/permanent-delete API 和保护语义已完成。本切片只迁展示、交互、反馈、CSS 和证据。

### Final Closeout - 2026-07-20

实施步骤 A-G 已完成：

- Panel 已由 378 行降至 132 行，Toolbar/List/Delete Dialog/Error/view-model 已拆分；
- controller 已完成 scoped error 和 boolean mutation result，保留 API/refresh 时序；
- shared primitives 已取代 raw controls、legacy loading/empty/error 和四个 browser confirm；
- focused CSS 为 173 行，Archived family 已从 `settings.css` 删除；
- shared IconButton 的零宽 label + gap 曾导致图标水平偏移 3px；已在 package Button CSS 统一修复并增加样式回归。
- focused `5/5`、Settings/Archive `19/19`、selected App/Dark/Settings controls `29/29` 和 shared package
  `41/41` 已通过。
- `git diff --check`、Web `check:i18n`、`typecheck` 和 `lint` 已通过。
- 六张真实 Vite 截图已原尺寸目检；无效日期 fixture 在最终采集前修正为有效 ISO 时间。
- metadata 和 SHA-256 见 [`evidence/settings/archived-items/metadata.md`](../../evidence/settings/archived-items/metadata.md)。
- 七个 Function ID 已由 `designed` 进入 `verified`；后续只做业务回归，不重开本切片。

## 2. Authoritative Baseline

| Owner | Baseline |
|---|---:|
| `ArchivedSettingsPanel.tsx` | 378 lines |
| `useArchivedSettingsController.ts` | 246 lines |
| Archived selector in `settings.css` | about 130 lines |
| Settings Archived E2E | category/scroll/delete in `settings.spec.ts`; branch/channel in `channel-archive.spec.ts` |
| Confirmation | four `window.confirm` call sites |
| Controls | raw search input、legacy buttons、`Loader2.spin`、legacy empty/error |

## 3. Module Boundaries

1. `archived-items-view-models.ts`：category definitions、visible name、filter、delete target projection；pure and locale-neutral。
2. `ArchivedItemsToolbar.tsx`：shared Tabs adapter、Input、Clear IconButton；无 API/state mutation。
3. `ArchivedItemList.tsx`：shared Skeleton/EmptyState/DataRow/Button/IconButton；四类只提供 view-model 和 callback。
4. `ArchivedDeleteDialog.tsx`：shared Dialog、Cancel initial focus、busy guard、failure、return/fallback focus。
5. `ArchivedSettingsPanel.tsx`：active category/search/delete target/trigger refs and composition；target `<220` lines。
6. `useArchivedSettingsController.ts`：保留 API 调用；分离 `loadError` 与 scoped `actionError`，mutation 返回 success boolean。
7. `settings-archived-items.css`：只拥有 Toolbar/List/Row/Dialog domain geometry；target `<360` lines。

DOM ref 不进入 controller；业务数据与翻译字符串不进入 CSS 或 locale-dependent view-model branch。

## 4. Implementation Steps

### Step A: Coverage And Projections

- 将粗粒度 `SETTINGS-ARCHIVE-001` 替换为七个 Function ID。
- 建立 category/row/delete-target view-model，保持 Conversation/Teammate/Channel/Branch 真实类型。
- 保留 storage preference、Branch parent lookup、搜索规则和 Restore both 投影。

### Step B: Controller Feedback Boundary

- 将 initial/refresh error 与 mutation error 分离；refresh 失败保留最后权威数据。
- `runAction` 返回 boolean，仍使用单一 action id 串行 mutation；只发起 action显示 loading。
- Restore failure 暴露给 active list；Delete failure 由 active Dialog 消费。
- 增加 clear action error，不改变任何 API 请求、reason、refresh 或 `onChanged` 时序。

### Step C: Panel Split And Shared Primitives

- Panel 先拆分再增加 Dialog，保持所有 production owner `<400` lines。
- Toolbar 迁 shared Input/IconButton，保留 SettingsSubnav shared Tabs。
- 四套 row 合并为 typed DataRow view；Restore 使用文字 Button，Delete 使用 danger IconButton。
- loading 使用 Skeleton，empty/no-result 使用 compact EmptyState；移除 `Loader2.spin` 和 legacy classes。

### Step D: Controlled Delete Dialog

- 删除四个 `window.confirm`，使用一个 target-driven shared Dialog。
- Panel 记录触发 Delete IconButton；Dialog Cancel/Esc/failure 恢复 trigger。
- 成功刷新后 row 卸载，Dialog 使用 Search/active Tab fallback，绝不聚焦 detached element。
- busy 时阻止 Esc/outside/close；error 留 Dialog，未知错误可折叠查看。

### Step E: Focused CSS

- 新增 `styles/settings-archived-items.css` 并从 `styles.css` 按 Settings focused owner 顺序导入。
- 同步删除 `settings.css` 中 Archived toolbar/search/list/row/empty family。
- shared control/DataRow/Dialog/Feedback visual 保持 package-owned。
- 记录迁移前后行数和静态零命中 guard。

### Step F: Focused E2E And Existing Regression

- 新增 `ui2-settings-archived-items.spec.ts`，覆盖设计合同第 13 节全部 changed states。
- 更新 `settings.spec.ts` / `channel-archive.spec.ts` 的 browser dialog 断言为 shared Dialog；不删除业务后果断言。
- 运行 `app.spec.ts`、`dark-mode.spec.ts`、Settings Shell/Dialog/Form/Feedback selected regression。

### Step G: Browser Evidence And Closeout

- 使用真实 Vite server 在 `1440x960 ling-light`、`1280x800 ling-dark` 采集六张证据。
- 原尺寸检查 Toolbar、长名称、内部 scroll、Dialog、focus、error、zh-CN、reduced motion、console 和 overflow。
- 写 `evidence/settings/archived-items/metadata.md` 和 SHA-256。
- 回写 README、临时总控、覆盖/E2E/CSS/selector/motion/feedback 矩阵和状态看板。

## 5. Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-archived-items.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts channel-archive.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts dark-mode.spec.ts ui2-settings-shell.spec.ts ui2-dialog-controls.spec.ts ui2-form-controls.spec.ts ui2-feedback-data-display.spec.ts
```

顺序运行，不与 build/typecheck 并发。只有代码、自动化、真实截图和 metadata 全部完成才升级为 `verified`。

## 6. Stop Conditions

遇到以下情况立即询问用户：

- 需要改变 Conversation run retention、Teammate private-data cleanup、Channel/Branch delete 或 Restore both 语义；
- 需要新增 API/contracts/database/route/Settings IA；
- 正确 UI 只能通过伪造对象、吞掉 blocker、删除业务断言或在 Sidebar 暴露 hard delete 实现；
- 远端与当前 UI 2.0 对同一删除/恢复行为无法同时保留。

其余组件拆分、focused CSS、Dialog、测试和证据问题由本切片自行完成，不上抛普通实现选择。
