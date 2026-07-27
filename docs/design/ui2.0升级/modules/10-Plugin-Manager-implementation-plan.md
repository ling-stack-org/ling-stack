# P9.2 Plugin Manager UI 2.0 Implementation Plan

> Execution status (2026-07-22): `Web verified / packaged Desktop partial`. Web focused and legacy regression are green;
> imported Theme and packaged Windows evidence remain open for the reasons recorded in
> [Implementation Closeout](#25-implementation-closeout---2026-07-22).

## 1. Slice Contract

本计划实施 [Plugin Manager UI 2.0 零决策合同](10-Plugin-Manager.md)。目标是把现有真实插件能力迁移到
共享 UI primitives，并完成搜索筛选、产品化 Inspector、Runtime Preview、CUA health、危险确认、
反馈生命周期、CSS 拆分和原尺寸证据。

本切片不修改业务能力。所有 API 调用继续使用：

```text
listManagedPlugins
createManagedPlugin
applyManagedPluginPreset
connectManagedPlugin
checkManagedPlugin
validatePluginPackage
installManagedPlugin
uninstallManagedPlugin
refreshManagedPluginPackage
getManagedPluginRuntimePreview
enableManagedPlugin
disableManagedPlugin
```

## 2. Authoritative Baseline

实施前必须重新核对以下文件，不能依据本文档猜测最新代码：

```text
apps/web/src/features/plugins/PluginManagerPage.tsx
apps/web/src/features/plugins/PluginManagerTable.tsx
apps/web/src/features/plugins/PluginActionButton.tsx
apps/web/src/features/plugins/PluginDetailDrawer.tsx
apps/web/src/features/plugins/PluginCreateDrawer.tsx
apps/web/src/features/plugins/CuaDriverInstallDrawer.tsx
apps/web/src/features/settings/PluginManagerSettingsPanel.tsx
apps/web/src/features/settings/plugin-manager-view-models.ts
apps/web/src/domains/plugins/use-plugins-domain.ts
apps/web/src/api/plugins.ts
apps/web/src/styles/plugins.css
apps/web/src/styles/plugin-cua-health.css
apps/web/src/styles/settings.css
apps/web/e2e/plugins.spec.ts
packages/core/src/plugin-manager-types.ts
packages/contracts/src/plugins.ts
packages/daemon/src/features/plugins/catalog.ts
packages/daemon/src/features/plugins/provider-health.ts
packages/daemon/src/features/plugins/runtime-injection.ts
packages/daemon/src/features/plugins/install.ts
packages/daemon/src/features/plugins/routes.ts
```

当前大文件风险：

| File | Current lines | Rule |
|---|---:|---|
| `AppShell.tsx` | 3128 | 只允许 props/callback 薄接线，不增加状态派生或 UI |
| `packages/daemon/.../routes.ts` | 729 | 本切片不改 |
| `plugins.css` | 601 | 先拆 owner，再迁移；完成后旧文件只保留 imports |
| `plugins.spec.ts` | 418 | 保留 legacy regression；新状态放 focused spec |
| `use-plugins-domain.ts` | 363 | 只保留 server state/mutation，不加 search/overlay state |
| `plugin-manager-view-models.ts` | 347 | 拆分后删除，不继续追加 |
| `PluginManagerSettingsPanel.tsx` | 121 | 迁出 Settings owner，完成后删除 |

## 3. Write Boundary

允许修改或新增：

- `apps/web/src/features/plugins/*` 的展示组件、controller、view-model 和类型；
- `apps/web/src/styles/plugins.css` 及新的 `styles/plugins/*` focused CSS；
- `apps/web/src/styles/settings.css` 仅删除 `.settings-plugin-manager*` selector；
- Web locale 中本切片需要的产品文案；
- `apps/web/e2e/ui2-plugin-manager.spec.ts`、现有 `plugins.spec.ts` 的必要兼容断言；
- Plugin Manager evidence PNG 和 metadata；
- `PluginManagerPage` 到 AppShell 的现有薄 props 连接。

禁止修改：

- daemon routes、core/contracts、数据库、API client 方法和返回类型；
- Plugin trust、approval、MCP、run snapshot、CUA permission/capture 状态机；
- ViewId、Sidebar IA、Settings section；
- 与插件无关的脏工作树文件；
- Logo、Theme Pack schema、Desktop bridge。

## 4. Target Module Boundary

目标目录：

```text
apps/web/src/features/plugins/
  PluginManagerPage.tsx                 page composition only, <= 140 lines
  PluginManagerHeader.tsx               header + toolbar, <= 120 lines
  PluginManagerTable.tsx                semantic table composition, <= 140 lines
  PluginManagerRow.tsx                  one row, <= 140 lines
  PluginRowActions.tsx                  primary/icon/menu actions, <= 180 lines
  PluginDetailDrawer.tsx                shared Drawer composition, <= 220 lines
  PluginDetailOverview.tsx              summary + repair, <= 140 lines
  PluginCapabilitiesSection.tsx         contribution projection, <= 160 lines
  PluginRuntimePreviewSection.tsx       runtime projection/actions, <= 220 lines
  PluginTechnicalDetails.tsx            raw folded fields, <= 180 lines
  PluginCreateDialog.tsx                shared Dialog + form, <= 240 lines
  PluginUninstallDialog.tsx             confirm + failure, <= 140 lines
  CuaDriverInstallDrawer.tsx            shared Drawer, <= 240 lines
  usePluginManagerController.ts         presentation state only, <= 240 lines
  plugin-manager-types.ts               feature view types, <= 180 lines
  plugin-manager-filter.ts              pure query/filter, <= 140 lines
  plugin-manager-row-view-model.ts      state/action derivation, <= 240 lines
  plugin-manager-detail-view-model.ts   Inspector projection, <= 240 lines
  plugin-manager-cua-view-model.ts      CUA health mapping, <= 200 lines
  plugin-manager-feedback.ts            product error mapping/scope, <= 160 lines
```

所有新 production owner 目标低于 240 行，硬上限 400 行。一个文件同时承担 server mutation、筛选、
overlay、view projection 和 JSX 属于失败拆分。

分层责任：

| Layer | Owner | Allowed responsibility |
|---|---|---|
| UI | `features/plugins/*.tsx` | shared primitive composition、events、ARIA |
| Presentation state | `usePluginManagerController.ts` | query/filter、selection、overlay、focus fallback、retained stale |
| Pure projection | `plugin-manager-*-view-model.ts` | primary state/action、details、Runtime/CUA copy model |
| Domain state | `use-plugins-domain.ts` | authoritative list、loading、busy、mutation、DomainError |
| API client | `apps/web/src/api/plugins.ts` | existing typed daemon calls only |
| Contracts/domain | core/contracts/daemon | unchanged |
| Tests | focused E2E + existing backend regression | reachable behavior and evidence |

## 5. Feature Types

在 `plugin-manager-types.ts` 定义展示类型，不导出到 contracts：

```ts
type PluginSourceFilter = "all" | ManagedPluginSourceKind;
type PluginStatusFilter = "all" | "needs-action" | "enabled" | "disabled" | "unavailable";

interface PluginManagerFilters {
  readonly query: string;
  readonly source: PluginSourceFilter;
  readonly status: PluginStatusFilter;
}

interface PluginActionFailure {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
  readonly message: string;
}

interface PluginProjectionContext {
  readonly busyPluginId: string;
  readonly busyAction?: PluginBusyAction;
  readonly failures: ReadonlyMap<string, PluginActionFailure>;
  readonly now: string;
}

type PluginPrimaryStateId =
  | "platform-blocked"
  | "provider-incompatible"
  | "restart-required"
  | "provider-unavailable"
  | "failed"
  | "setup-missing"
  | "package-missing"
  | "busy"
  | "connecting"
  | "stale"
  | "needs-check"
  | "disabled"
  | "ready"
  | "unknown";

type PluginPrimaryActionId = "guide" | "install" | "apply" | "check" | "enable" | "details";
type PluginSecondaryActionId =
  | "check"
  | "details"
  | "disable"
  | "validate"
  | "refresh-package"
  | "runtime-preview"
  | "uninstall";

interface PluginRowView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly sourceLabel: string;
  readonly settledPrimaryState: PluginPrimaryStateView;
  readonly primaryState: PluginPrimaryStateView;
  readonly filterGroup: Exclude<PluginStatusFilter, "all"> | "other";
  readonly primaryAction?: PluginActionView;
  readonly showCheckAction: boolean;
  readonly menuActions: readonly PluginActionView[];
  readonly busyAction?: PluginBusyAction;
}
```

`PluginDetailView`、`PluginRuntimePreviewView`、`PluginCuaView` 必须是只读产品投影。raw 字段以
`technicalFields` 单独返回，不能混入 overview fields。

## 6. Pure Projection Implementation

### 6.1 Filter

先构建完整 row projection，再执行纯筛选：

```ts
buildPluginRowViews(
  plugins: readonly ManagedPluginView[],
  context: PluginProjectionContext,
  t: Translator,
): readonly PluginRowView[]

filterPluginRows(
  rows: readonly PluginRowView[],
  filters: PluginManagerFilters,
): readonly PluginRowView[]
```

- query 只匹配 row name/description，并即时更新，不使用 debounce timer；
- source/status predicate 按合同固定；
- 不 mutate 或 sort 输入；
- 保持 daemon 顺序；
- 空 query 不分配无意义中间数组时可在实现中优化，但不得改变结果。

### 6.2 Primary State

先派生不含 busy 的稳定状态，再叠加瞬时 presentation：

```ts
derivePluginSettledPrimaryState(
  plugin: ManagedPluginView,
  actionFailure: PluginActionFailure | undefined,
  now: string,
  t: Translator,
): PluginPrimaryStateView

derivePluginPrimaryState(
  settledState: PluginPrimaryStateView,
  busyAction: PluginBusyAction | undefined,
  t: Translator,
): PluginPrimaryStateView
```

`filterGroup` 只由 settled state 派生，busy 期间不改变筛选归属。两个函数按主合同第 9 节顺序短路。
CUA error code 的读取和产品文案委托
`plugin-manager-cua-view-model.ts`。禁止在 `PluginManagerRow.tsx` 使用 `plugin.status === ...` 再判断一次。

### 6.3 Action Projection

`derivePluginRowActions` 只消费 `primaryState` 和 daemon `plugin.actions`：

- 主行动按合同矩阵至多一个；
- busy 时保留 initiating action 的原 slot、label 和宽度，只切换 loading/disabled；
- Check 未作为 primary 时才显示 icon；
- Details 始终显示；
- More 只包含 Disable/Validate/Refresh/Uninstall；
- Runtime Preview 在 Detail section；
- Uninstall 返回 `opensConfirm: true`，不能直接绑定 domain mutation。

### 6.4 Detail And Runtime

- overview 不含 ID/path/hash/raw dates；
- capabilities 按 kind 分组并使用 label/displayName；
- Runtime status 和已知 blocker 映射为产品文案；未知 raw blocker 只进入 technicalFields；
- policy 默认只返回 count/highest posture；target/side effect/reason 进入 technicalFields；
- CUA technical details 延续 errorCode/platform/version/missingTools/checks，但默认 closed。
- requiredSecrets 只投影 requirement name 和 required/optional；不存在权威配置状态时不推断，任何 secret
  value 都不得进入 view model。

## 7. Presentation Controller

`usePluginManagerController` 接收当前 plugins/domain flags/callbacks，拥有：

```text
query
sourceFilter
statusFilter
selectedPluginId
createDialogOpen
cuaInstallPluginId
uninstallPluginId
openInspectorSectionsByPlugin
retainedRefreshError
lastRefreshRevision
focusReturnIntent
failureByPluginAction
```

规则：

- overlay 状态互斥：create、CUA guide、uninstall confirm 和 Detail Drawer 同时最多一个 modal owner；
  从 Detail 发起 uninstall 时先保存 return intent、关闭 Drawer，再打开 confirm。
- filter 不改变 selected plugin；刷新后对象消失才关闭 Drawer。
- refresh 开始时不清空 rows；失败时根据 domain error revision 记录 retained stale；成功清除。
- cwd 变化重置 filters、selection、overlay 和 retained stale，但不修改 domain reset 语义。
- Runtime Preview 完成后自动打开 Runtime section；失败同样打开并保留 InlineFeedback。
- controller 不 fetch、不 format raw error、不 import API client；所有 mutation 委托现有 callbacks。

为避免失败只存在 Toast，Web domain action 返回展示层 outcome，但不改变 HTTP/API contract：

```ts
type PluginActionOutcome =
  | { readonly ok: true; readonly plugin?: ManagedPluginView }
  | { readonly ok: false; readonly message: string };
```

`refreshPlugins`、create/connect 和所有 mutation callback 都返回该 outcome。domain 仍负责 fetch/upsert/busy/
DomainError/Toast notice；controller 只据 outcome 写入或清除 `failureByPluginAction`。这属于 Web domain interface，
不导出到 `@ling-stack/contracts` 或 API client。

## 8. Page And Table Migration

### 8.1 Move Out Of Settings Ownership

1. 在 `features/plugins` 建立 `PluginManagerHeader` 和新的 page composition。
2. 将 `PluginManagerSettingsPanel` 的组合职责迁入 `PluginManagerPage`。
3. 确认没有其他 consumer 后删除 `features/settings/PluginManagerSettingsPanel.tsx`。
4. 将 `plugin-manager-view-models.ts` 拆入 plugin feature 后删除旧文件。
5. `AppShell.tsx` 仍只传 domain state/actions 和 `onOpenMcpSettings`。

不得保留同一 UI 的 Settings adapter；Plugin Manager 已是全局工具页。

### 8.2 Header And Toolbar

- Header 使用 `Button primary md` Add plugin。
- Refresh 使用 `IconButton sm` + `RefreshCw`；loading 属性交给 primitive。
- Search 使用 `Field` visually-hidden label + `Input sm`，Search prefix、X suffix。
- Source/Status 使用 `Field` visually-hidden label + `Select sm`。
- retained refresh error 在 Toolbar 后、Table 前，不能挤压 Header。

### 8.3 Semantic Table

- 使用 `TableContainer/Table/TableHead/TableBody/TableRow/TableCell`。
- 不保留 `role=table/row/cell` 手写语义。
- TableHeader sticky，TableBody scroll owner 由 focused wrapper 提供。
- Row component 接收完整 `PluginRowView`，不 import domain hook。
- busy Spinner 仅由触发 Button/IconButton 的 `loading` prop呈现。

## 9. Action Components

`PluginRowActions` 的稳定顺序：

```text
primary text button -> Check icon -> Details icon -> More icon
```

- icon 使用 Lucide fixed map：Check `RefreshCw`、Details `ChevronRight`、More `MoreHorizontal`、
  Enable `Power`、Install `Download`、Preset `Wrench`。
- 不在 feature CSS 调整 SVG translate、stroke 或颜色。
- More Menu item 使用 icon + text；Uninstall 为 danger，并与普通动作由 separator 分隔。
- row action 的 disabled、loading、label 由 view model/action state给出，不在组件里猜。

删除 `PluginActionButton.tsx` 前先完成所有调用迁移；不保留 row/drawer 两套 presentation 分支。

## 10. Create Dialog Migration

1. 将 `PluginCreateDrawer.tsx` 替换为 `PluginCreateDialog.tsx`。
2. 使用 shared `Dialog/DialogContent/DialogHeader/DialogBody/DialogFooter`。
3. 使用 `Field/Input/Textarea/Select`，删除 raw `.field` 和 `SelectControl` 依赖。
4. 保留 name 80、description 180、stdio command/args、HTTP URL 和 payload shape。
5. 每个字段维护独立 error；submit focus first invalid。
6. onCreate 返回 plugin 时关闭；undefined 时保留输入和 Dialog。
7. busy 传入 Dialog root，禁止 duplicate submit 和 dismiss。

创建流程不新增 advanced secret/header、自动检查或自动 enable。

## 11. Detail Drawer Migration

1. 使用 shared `Drawer` 替换手写 overlay、window keydown 和 backdrop mouse handler。
2. Header 使用 title/status/source-version；Body 使用 overview + InspectorSections；Footer 只放 context primary/More。
3. `PluginDetailOverview` 渲染 failure/stale InlineFeedback 和 compact facts。
4. `PluginCapabilitiesSection` 渲染 human contribution rows；无 contribution 显示一句 compact empty。
5. `PluginRuntimePreviewSection` 拥有 Preview action、busy、result、blocker 和资源分组。
6. `PluginTechnicalDetails` 统一渲染 ID/path/hash/date/provider checks，默认 closed。
7. linked MCP 按钮先关闭 Drawer，再调用现有 Settings navigation callback。

Drawer close/focus/busy 使用 shared contract，不保留全局 `window.addEventListener("keydown")`。

## 12. Runtime Preview Implementation

- `Run preview` 只在 `canRuntimePreview` 显示；点击现有 callback。
- 现有 domain 会把 response plugin upsert 回列表，section 从最新 object 投影，不创建第二份权威 preview state。
- controller 只记录“本次 action owner”和 section open intent，不缓存 preview payload。
- `injectable` 显示 counts；`disabled` 提供 Enable；`blocked` 显示产品 blocker 和可用修复行动。
- unknown blocker 的 raw 字符串放 technical details。
- Runtime section failure persistent；success Toast 由 shared adapter 管理。

## 13. CUA Migration

### macOS Install

- 将 `CuaDriverInstallDrawer` 切到 shared Drawer。
- 官方链接用 `Button asChild secondary`；copy 使用 IconButton。
- command container 只负责 code overflow，不重写 Button。
- custom path 使用 InspectorSection + Field/Input；absolute path validation 保留。
- copy local state 只保留 clipboard promise；反馈改为全局 Toast/Drawer InlineFeedback，不设 1800ms timer。
- connect/recheck 成功按权威 setup 状态关闭 Drawer。

### Windows Health

- 保留已实现的 error code mapping；移入 `plugin-manager-cua-view-model.ts`。
- provider unavailable/incompatible/platform blocked/restart/default capability failure 均有单一 state。
- raw tools/schema/checks 只在 Technical details。
- 不调用 macOS guide，不新增 Desktop bridge action。

## 14. Uninstall Confirmation

新增 `PluginUninstallDialog.tsx`：

- 仅由 `canUninstall` action 打开；
- 使用 `Dialog sm`，展示卸载后果与保留历史；
- Cancel secondary、Uninstall danger；
- confirm 调用现有 `onUninstall(pluginId)`；
- domain callback 返回前述 `PluginActionOutcome`；
- 成功关闭并 focus Install；失败保留 Dialog InlineFeedback。

## 15. Feedback Ownership

实现前为每个 action 建立 scope：

```text
plugin:<id>:create
plugin:<id>:apply
plugin:<id>:install
plugin:<id>:check
plugin:<id>:enable
plugin:<id>:disable
plugin:<id>:validate
plugin:<id>:refresh-package
plugin:<id>:runtime-preview
plugin:<id>:uninstall
plugin:cua:<id>:copy
plugin:list:refresh
```

- success 使用共享 Toast 3000ms；
- error Toast 可用于全局确认，但必须同时投影为 row failure state，并在 Detail/overlay 提供持续
  InlineFeedback；不得把多行 error body 塞进固定高 row；
- retained refresh、row failure、Runtime blocker、Dialog validation、CUA repair 持续到 resolved/retry/close；
- 删除 Feature timer、空 status 占位和 page-global generic error；
- raw domain error 经 `plugin-manager-feedback.ts` 映射，未识别内容进入 Technical details。

## 16. CSS Migration

### 16.1 Create Target Files First

```text
styles/plugins.css
styles/plugins/plugin-manager-shell.css
styles/plugins/plugin-manager-table.css
styles/plugins/plugin-detail-runtime.css
styles/plugins/plugin-cua-install.css
```

`plugins.css` import 顺序固定为 shell -> table -> detail-runtime -> cua-install。

### 16.2 Selector Ownership

| Target file | Owns | Must not own |
|---|---|---|
| shell | page rows、header/toolbar placement、retained feedback slot | Button/Input/Select visual |
| table | columns、row height、cell truncation、body scroll | StatusIndicator/Button internals |
| detail-runtime | detail facts、resource grouping、raw code overflow | Drawer/Inspector chrome |
| cua-install | command/path/guide layout | Drawer/Button/Field chrome |

### 16.3 Delete In Same Slice

- 删除 `plugin-cua-health.css` import 和文件；
- 删除 `settings.css` 全部 `.settings-plugin-manager*`；
- 删除 private overlay/status/button/form selectors；
- 删除不再引用的 className 和 locale key；
- 运行 `rg` 确认无 orphan selectors。

### 16.4 Budget And Guards

- aggregator <= 8 行；shell <= 90；table <= 180；detail <= 150；CUA <= 150；总计 <= 500。
- Feature CSS hard-coded color = 0；`transition: all` = 0；new keyframes = 0。
- Feature 不命中 `.ling-ui-*` descendants，不读取 Theme Pack/Presentation selector。

## 17. Focused E2E Plan

新增 `apps/web/e2e/ui2-plugin-manager.spec.ts`，现有 `plugins.spec.ts` 保留真实业务回归。focused spec
按以下场景拆分，单 test 不覆盖多个无关流程：

1. list uses four columns, one state and stable row actions；
2. search/source/status filters and clear no-result；
3. first loading, first error, retained refresh stale and recovery；
4. primary action matrix for preset/install/check/enable/failed/ready；
5. local stdio/HTTP create Dialog, field validation, busy and failure retention；
6. Detail overview/capabilities/trust/technical raw folding；
7. Runtime injectable/disabled/blocked/unknown blocker and long data；
8. uninstall cancel, busy dismiss guard, success and failure；
9. macOS CUA guide/custom path/copy/recheck；
10. Windows unavailable/incompatible/restart/capability failure/ready；
11. keyboard Menu/Inspector/Dialog/Drawer and focus restore；
12. 100 rows, 1280/1440 overflow, Light/Dark/imported theme and reduced motion。

测试夹具不得直接写最终 DOM；必须通过 mock daemon 返回真实 `ManagedPluginView` shape 和现有 endpoint mutation。

## 18. Backend Regression

虽然不改后端，仍需运行现有回归证明 UI 重组没有要求后端漂移：

- plugin list/detail 不暴露 secrets；
- local create 默认 disabled，stdio/HTTP MCP 关联正确；
- apply preset 幂等且不授权 teammate；
- install/uninstall/refresh package 状态和历史保留；
- runtime preview disabled/blocked/injectable；
- CUA setup、provider health、tool/schema/version fail closed；
- enable/disable/check route 语义不变。

不为通过 UI 测试修改 daemon response 或数据库。

## 19. Browser And Screenshot Execution

### 19.1 Real Server

使用仓库 dev script 启动真实 Vite，记录实际 URL。截图必须来自该 URL，不使用静态 HTML、组件 story
或只读 DOM fixture。验证页面实际加载的是当前 source/HMR artifact。

### 19.2 Viewports And Themes

逐状态使用：

```text
1440x960 / ling-light / zh-CN or en-US as named
1280x800  / ling-dark  / complementary locale
```

额外运行 imported Theme fixture；Desktop packaged smoke 按 macOS/Windows 各自记录，不用 Web 截图替代。

### 19.3 Required Files

写入：

```text
docs/design/ui2.0升级/evidence/features/plugin-manager/
  1440x960-ling-light-list-ready.png
  1280x800-ling-dark-list-needs-action.png
  1440x960-ling-light-search-no-result.png
  1280x800-ling-dark-retained-stale.png
  1440x960-ling-light-create-validation.png
  1280x800-ling-dark-detail-runtime-blocked.png
  1440x960-ling-light-uninstall-confirm.png
  1280x800-ling-dark-cua-repair.png
  metadata.md
```

所有 PNG 必须由 Playwright screenshot 直接保存原尺寸。用 `sips`、ImageMagick 或脚本复核 dimensions 和
SHA-256，但不得重采样后覆盖原图。

### 19.4 Visual Checks

- PageHeader/Toolbar/TableHeader 固定，只有 TableBody 滚动；
- row 64px、actions 不换行、primary 不重复；
- search focus 不增高或溢出；
- Drawer 480px、Dialog 360/520px，body 内滚动；
- raw long data 不撑宽 overlay；
- failure、stale 和 status 不依赖颜色；
- Dark/imported theme 无硬编码白块或低对比文字；
- document/table/overlay horizontal overflow <= 1px；
- console error/warning、React key/focus、ResizeObserver loop = 0。

## 20. Verification Commands

实施过程中按层运行：

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/ui-react typecheck
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-plugin-manager.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- plugins.spec.ts app.spec.ts dark-mode.spec.ts
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/plugin-sdk test
corepack pnpm --filter @ling-stack/daemon test
```

CSS/source guards：

```bash
rg -n 'settings-plugin-manager|plugin-detail-drawer|plugin-table-status-dot|plugin-table-icon-action' apps/web/src
rg -n 'transition:\s*all|#[0-9a-fA-F]{3,8}|rgba?\(' apps/web/src/styles/plugins*
rg -n '@radix-ui' apps/web/src/features/plugins
wc -l apps/web/src/features/plugins/* apps/web/src/styles/plugins/*
```

第一条 orphan selector 检查期望仅命中允许的 E2E 迁移兼容断言；关闭切片前期望 production source 为 0。

## 21. Implementation Order

严格按以下顺序，避免旧 UI 与新状态派生同时失控：

1. 新建 focused E2E，先锁定现有真实 mutation 和目标失败状态。
2. 新建 feature types、filter、row/detail/runtime/CUA pure projections。
3. 新建 presentation controller，接入 query/filter/overlay/retained stale。
4. 迁移 PageHeader/Toolbar 和 semantic Table。
5. 迁移 row actions 和 shared Menu。
6. 迁移 Create Dialog。
7. 迁移 Detail Drawer、Capabilities、Runtime、Technical details。
8. 迁移 CUA Drawer 和 feedback。
9. 增加 Uninstall Confirm Dialog。
10. 拆 CSS、删除 Settings/private overlay/status/button selector。
11. 清 locale/orphan class，跑 static + focused + regression。
12. 启动真实 Vite，完成 1280/1440 Light/Dark changed-state QA 和原尺寸截图。
13. 完成 packaged Windows/macOS Desktop smoke 后才允许 cross-platform verified。

每一阶段删除其替代的旧实现，不在最终状态保留新旧两套组件或 selector。

## 22. Exit Gate

实现 PR 在满足全部条件前不得标记完成：

- `PluginManagerSettingsPanel` 和旧 combined view-model 已删除或只剩有明确期限的零逻辑 adapter；本合同目标为删除；
- 搜索、来源/状态筛选、no-result 和 retained stale 已实现；
- 表格使用 shared semantic Table，row 64px，单一状态/主行动；
- create 使用 Dialog；detail/CUA 使用 Drawer；uninstall 使用 Confirm Dialog；
- Runtime Preview 有产品 summary、repair 和 raw details；
- 技术字段默认折叠，默认层没有 id/hash/path/schema wall；
- feedback 生命周期符合合同，Feature timer 和常驻 success 条为 0；
- `plugins.css` 拆分、`plugin-cua-health.css` 和 Settings plugin selector 删除；
- static、focused、legacy、daemon regression 全部通过；
- 8 张原尺寸 PNG、metadata、console/overflow 证据齐全；
- Windows packaged provider health 证据未完成时明确标为 partial，不用 Web fixture 冒充。

## 23. Rollback And Failure Handling

- shared primitive 迁移发生回归时按单个 overlay/table slice 回退，不修改 daemon/API 规避 UI 问题。
- Runtime unknown blocker 映射不完整时显示产品 fallback + raw technical details，不直接暴露 raw 默认文案。
- Windows provider attach 无法复现时保留 implemented/partial，记录环境、driver version、session type 和失败点。
- screenshot 或 E2E 只在一尺寸通过时不降低验收范围，不用缩小字体或隐藏行动解决溢出。
- 发现 unrelated dirty changes 时与其共存；不 reset、clean、stash、switch、rebase 或覆盖。

## 24. Hard Stops

- 不新增 API、contracts、DB、plugin status、transport、ViewId 或 Settings entry。
- 不向 `AppShell.tsx` 添加 search/filter/overlay/runtime projection。
- 不把全部逻辑继续塞进 347 行 view-model、363 行 domain hook 或单个 400+ 行新组件。
- 不把 Search/filter 状态放 localStorage 或 daemon。
- 不自动 install/enable/authorize，不伪造 install progress 或 provider health。
- 不把 Uninstall 改写成永久 Delete，不给 trusted-local 显示无 API 行动。
- 不让 Runtime Preview 修改 runtime snapshot 或 policy。
- 不直接 import Radix，不复制 shared component CSS，不新增 Feature Toast provider/timer。
- 不只跑 typecheck/E2E；真实 Vite、changed-state、原尺寸截图、console 和 overflow 都是退出条件。

## 25. Implementation Closeout - 2026-07-22

### Completed Slices

1. 拆除旧 Settings owner 和 combined view-model，建立 `features/plugins` 页面、controller 与纯投影边界。
2. 完成 Header、搜索/筛选、四列表格、64px 行、单一状态和稳定动作矩阵。
3. 完成 shared Create Dialog、Detail Drawer、CUA Drawer 与 Uninstall confirm。
4. 完成 capability、trust、Runtime Preview 和 technical details 的渐进披露。
5. 将 `plugins.css` 收敛为 imports-only，并拆为 shell/toolbar/table/detail/runtime/CUA
   focused CSS；单 owner 最大 160 行。
6. 新增 focused E2E，保留并通过 legacy plugin lifecycle 回归，生成真实 Vite 截图证据。

### Final Verification

```text
corepack pnpm --filter @ling-stack/web typecheck                         PASS
corepack pnpm --filter @ling-stack/web lint                              PASS
corepack pnpm --filter @ling-stack/web check:i18n                        PASS
... ui2-plugin-manager.spec.ts plugins.spec.ts                          17/17 PASS
git diff --check                                                         PASS
```

每张 evidence PNG 在截图前都经过 console/page error 和 document overflow 断言。Overlay 初始焦点已从
Close IconButton 移到 Cancel 或 Drawer 容器，重新截图确认没有自动出现 Close Tooltip。

### Not Closed In This Write Boundary

| Item | Status | Reason / next owner |
|---|---|---|
| retained refresh stale + recovery | completed | domain error revision 保留旧 rows，Retry recovery 已通过 focused E2E |
| generic row mutation persistent failure | completed | failure 归属触发行或 Detail Drawer，Toast 消失后仍可修复 |
| imported Theme fixture | unverified | focused fixture 当前只有 Ling Light/Dark |
| Windows packaged Desktop | unverified | 无真实 Windows interactive、DPI、high-contrast 环境 |
| shared locale migration | completed | 15 条产品文案进入共享 en-US/zh-CN；copy 只调用 `t()` |
| `plugin-cua-health.css` 删除 | deferred | `styles.css` 全局 import 不在本切片写集 |
| Settings compatibility selectors | deferred | legacy spec 仍查询 `.settings-plugin-manager*`，`settings.css` 不在写集 |
| shared IconButton row migration | completed | legacy 30px/no-wrapper 断言已迁为共享 IconButton 与至少 32px hit area |

因此 Plugin Manager 的 Web 功能面可标记为 `verified`；CUA 的 packaged macOS/Windows 功能点继续保持
`implemented`，不可把 Web fixture 误标为跨平台 `verified`。
