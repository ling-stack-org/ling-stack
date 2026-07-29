# Plugin Manager UI 2.0 零决策合同

## 1. Status And Authority

本文档是 Plugin Manager 的 UI 2.0 实施级合同，状态为 `Web verified / packaged Desktop partial`。它覆盖全局
`Engineering > Plugin Manager` 页面及其所有 Dialog、Drawer、Menu、details 和失败修复状态。

视觉、组件、反馈、动效与 Desktop 表面以 UI 2.0 文档为准；插件生命周期、信任、授权、运行时
注入和 CUA provider health 的业务语义继续以现有代码及下列历史文档为准：

- [Plugin Manager](../../plugin-manager.md)
- [Plugin Manager Implementation Plan](../../plugin-manager-implementation-plan.md)
- [插件管理表格与详情抽屉](../../plugin-manager-table-layout.md)
- [插件管理新增本地插件](../../plugin-manager-add-local-plugin.md)
- [Primary Navigation Tool Promotion](../../primary-navigation-tool-promotion.md)

发生冲突时遵守以下优先级：

1. 现有 daemon API、contracts、数据库和权限边界不变。
2. Plugin Manager 是全局工具页，不重新放回 Settings，也不复制 Settings 左侧导航。
3. UI 2.0 负责布局、组件、状态表达、反馈生命周期、键盘和 Desktop 表面。
4. 无权威数据时显示未知、待检查或不可用，不从前端推断成功。

## 2. Product Goal

Plugin Manager 是能力控制面，不是插件市场、技术日志页或 MCP 配置副本。默认层必须让用户在一屏内
回答四个问题：

- 这是什么插件；
- 它来自哪里；
- 当前是否可用或需要处理；
- 下一步应该做什么。

默认层只显示插件名称、一行用途、来源、单一主状态和必要行动。Plugin ID、package hash、cache ref、
transport、contribution token、provider tool/schema、policy overlay target、原始 blocker 和 ISO 时间进入
Inspector 的折叠技术详情。

## 3. Preserved Business Boundary

本轮只改变 Web 展示和交互组织，不改变以下真实边界：

| Boundary | Contract |
|---|---|
| Entry | 全局 Sidebar 的 `Plugin Manager`，保持 AppShell Sidebar 可见 |
| Workspace | 所有读取和 mutation 继续要求当前 `cwd` |
| Source kinds | `built-in`、`bundled`、`trusted-local-preset` |
| Plugin status | `available`、`enabled`、`disabled`、`blocked` |
| Health | `unknown`、`ready`、`failed`、`disabled`、`expired` |
| Package | `installed`、`uninstalled` |
| Runtime preview | `injectable`、`blocked`、`disabled` |
| Setup | `detected`、`missing`、`unsupported`、`connected`、`ready` |
| Create | 只创建受信任本地 MCP 插件；支持 stdio 和 streamable HTTP；默认停用 |
| Install | 只安装 daemon 已暴露的 bundled package，不下载任意 npm、Git 或远程 zip |
| Enable | 不等于工具授权，不绕过 MCP、teammate binding、approval 或 run snapshot |
| Disable | 阻止未来使用，不删除历史运行和审计 |
| Uninstall | 仅卸载 bundled package、停用贡献并保留 catalog 与历史，不永久删除插件记录 |
| CUA | Plugin Manager 只呈现 provider/setup health，不重写 permission、capture 或运行状态机 |

不存在永久删除 managed plugin 的 API。UI 中的危险确认必须使用“卸载插件包”，不得写成“永久删除
插件”。`trusted-local-preset` 当前没有删除能力，不显示假的 Delete/Uninstall 行动。

## 4. Function Points

| Function ID | Scope | Target primitive | Current posture |
|---|---|---|---|
| `PLUGIN-LIST-001` | 页面壳层、列表、来源、状态、选择 | Table、StatusIndicator | implemented / Web verified |
| `PLUGIN-SEARCH-FILTER-001` | 本地搜索、来源筛选、状态筛选、无结果 | Input、Select、EmptyState | implemented / Web verified |
| `PLUGIN-PRESET-001` | 应用受信任预设及关联资源结果 | Button、Toast、InlineFeedback | preserved / legacy verified |
| `PLUGIN-INSTALL-001` | bundled install、refresh、validate | Button、Menu、InlineFeedback | preserved / legacy verified |
| `PLUGIN-STATE-ACTION-001` | enable、disable 和局部 busy | Button、Menu、StatusIndicator | implemented / Web verified |
| `PLUGIN-CHECK-001` | check、recheck、stale 和失败修复 | IconButton、InlineFeedback | implemented / Web verified |
| `PLUGIN-CREATE-001` | stdio/HTTP 本地插件创建 | Dialog、Field、Input、Select | implemented / Web verified |
| `PLUGIN-DETAIL-001` | summary-first Inspector | Drawer、InspectorSection | implemented / Web verified |
| `PLUGIN-RUNTIME-001` | Runtime Preview、blocker、capability/policy 摘要 | InspectorSection、DataRow | implemented / Web verified |
| `PLUGIN-UNINSTALL-001` | bundled package 卸载确认 | Dialog、Button | implemented / Web verified |
| `PLUGIN-CUA-001` | macOS 安装引导、自定义路径、重检 | Drawer、Field、Toast | implemented / Web fixture verified |
| `PLUGIN-CUA-PROVIDER-HEALTH-001` | Windows provider/tool/schema/capability health | StatusIndicator、InlineFeedback | implemented / packaged Windows unverified |

`PLUGIN-CUA-PROVIDER-HEALTH-001` 已有产品化单一状态和技术详情折叠，但真实 Windows interactive
session、DPI、high contrast 和 packaged Desktop 证据仍未完成，不能标记 `verified`。

## 5. Pre-implementation Baseline And Known Gaps

实施前真实入口和文件：

```text
AppShell.tsx
  -> PluginManagerPage.tsx
    -> PluginManagerSettingsPanel.tsx
      -> PluginManagerTable.tsx
      -> PluginDetailDrawer.tsx
      -> PluginCreateDrawer.tsx
      -> CuaDriverInstallDrawer.tsx

use-plugins-domain.ts
  -> apps/web/src/api/plugins.ts
    -> existing daemon plugin routes
```

现状已具备三列表格、局部 busy、create、preset、install、check、enable/disable、详情、Runtime
Preview action、CUA 安装引导和全局 Toast。UI 2.0 尚未闭环的部分：

- 无搜索和来源/状态筛选；
- `PluginManagerSettingsPanel` 仍位于 Settings feature，名称和 CSS owner 与全局页面归属冲突；
- Table、Button、Field、Drawer 仍大量使用旧 class 和手写 overlay；
- Detail 只显示少量字段，Runtime Preview 的 capability、policy 和 blocker 没有完整产品化 Inspector；
- `Uninstall` 直接执行，没有危险确认；
- generic health `expired`、`expiresAt` 已过期和 retained refresh failure 没有统一 stale 表达；
- `plugins.css` 601 行，`plugin-cua-health.css` 25 行，`settings.css` 仍持有重复 plugin selector；
- `plugin-manager-view-models.ts` 347 行，继续加入筛选、详情和 Runtime projection 会混合职责；
- `plugins.spec.ts` 418 行，新增 UI2 状态应进入 focused spec，不继续无限增长。

## 6. Shell And Page Geometry

Plugin Manager 使用全局标准 Page grammar：

```text
PluginManagerPage
  PageHeader        64px
    title
    Add plugin
  PageToolbar       52px
    search
    source filter
    status filter
    refresh
  TableHeader       36px
  TableBody         minmax(0, 1fr), internal scroll
  Overlay layer
```

固定规则：

- 页面填满 AppShell workspace，`height: 100%`、`min-height: 0`、页面自身不滚动。
- Header 左侧只显示 `插件管理 / Plugin Manager`，不添加用途说明段落或统计卡。
- Header 标题使用 `20px / 28px`、font-weight 700；Header 左右 padding `20px`，不使用 24px hero 标题。
- Header 右侧只有 `添加插件 / Add plugin` primary Button，尺寸 `md`、高度 `36px`。
- Toolbar 使用单行布局，高度 `52px`，左右 padding `20px`；控件统一 `32px` compact height。
- Search 使用剩余空间，宽度 `minmax(220px, 420px)`；来源 Select `136px`；状态 Select `152px`；
  Refresh 为 `32x32px` IconButton。
- `1280x800` 下 Toolbar 不折行；标题、筛选和行动不得相互挤压。
- `1440x960` 及更宽窗口不放大字体、控件或行高；列表使用可用宽度，不套居中卡片。
- 页面、Table 和 Drawer 都不得产生 document-level horizontal scroll。

## 7. Search And Filter Contract

筛选完全是当前响应的前端投影，不新增 API、分页或数据库字段。

### 7.1 Search

- label：`搜索插件 / Search plugins`。
- query 先 `trim`，再按当前 locale 做 case-insensitive compare。
- 只匹配 `displayName` 和 `description`；不因 raw plugin ID、cache path 或 hash 命中而暴露技术字段。
- 输入即时更新当前内存投影，不 debounce、不发网络请求；100 行产品边界内不得为搜索新增 timer。
- `Escape` 在输入有值时清空 query；输入为空时保持页面焦点，不关闭页面。
- 清空按钮使用 Input suffix IconButton，具有独立 accessible label。

### 7.2 Source Filter

选项固定为：

```text
All sources
Built-in
Bundled
Trusted local
```

映射分别为 `undefined / built-in / bundled / trusted-local-preset`。显示文案本地化，值不进入 locale。

### 7.3 Status Filter

选项固定为：

```text
All statuses
Needs action
Enabled
Disabled
Unavailable
```

- `Needs action`：primary state 为 setup missing、package missing、needs check、stale、failed、
  provider unavailable/incompatible 或 restart required。
- `Enabled`：primary state 为 ready。
- `Disabled`：primary state 为 disabled。
- `Unavailable`：primary state 为 platform blocked。
- busy 期间使用 mutation 开始前的 settled group，避免行动过程中行突然从当前筛选消失；connecting 和
  unknown 只在 `All statuses` 中出现。

### 7.4 Projection Rules

- 筛选顺序为 query -> source -> status，最终保持 daemon 返回顺序，不增加前端排序。
- 任何筛选变化都不重新请求 daemon、不关闭已打开 Drawer。
- 当前 Drawer 对象被筛掉时 Drawer 保持打开；关闭后焦点回到 Search，而不是不可见行。
- Refresh 成功后对象消失时关闭其 Drawer/Menu，并把焦点恢复到页面标题后的第一个可用控件。
- 无匹配结果显示 compact no-result，不复用全空态；提供 `Clear filters` secondary Button。

## 8. Table Contract

使用 shared semantic `Table` family，不继续维护 `div role=table` 私有实现。

列固定为：

```text
Plugin    minmax(260px, 1fr)
Source    120px
Status    152px
Actions   272px
```

- Header 高 `36px`，sticky；Body 是唯一列表滚动 owner。
- Row 固定高 `64px`，不得因失败信息、busy、Menu 或 Drawer 打开而增长。
- Plugin cell：16px Lucide `Plug`、名称、单行描述。名称和描述 ellipsis，完整内容在 title 和 Drawer。
- Source cell：中性文字，不使用彩色 Badge；只显示 `Built-in / Bundled / Trusted local`。
- Status cell：一个 `StatusIndicator`，文字加 6px 状态点；不能堆 package、health、runtime 多枚 badge。
- Actions 右对齐，固定 gap `4px`；Button loading 不改变列宽。
- 行本身不承担导航 click，用户使用明确 Details IconButton；因此 Table Row 不设置虚假 selectable role。
- 100 行以内使用内部滚动，不做虚拟列表；后续超过该产品边界必须另立性能合同。

## 9. Primary State Derivation

所有状态优先级在纯 view-model 中派生，JSX 和 locale 文件不得判断业务枚举。`now` 由调用方传入，
同一 render 使用同一时间快照。

从高到低只取第一个匹配项：

| Priority | Primary state | Condition | Label | Tone |
|---:|---|---|---|---|
| 1 | `platform-blocked` | setup unsupported、`plugin_platform_blocked` 或 descriptor blocked | Unavailable | warning |
| 2 | `provider-incompatible` | CUA `plugin_provider_incompatible` | Update required | warning |
| 3 | `restart-required` | CUA `plugin_restart_required` | Restart required | warning |
| 4 | `provider-unavailable` | CUA `plugin_provider_unavailable` | Unable to connect | danger |
| 5 | `failed` | 当前 action failure、health failed、非前述 blocked、真实 runtime blocker | Needs attention | danger |
| 6 | `setup-missing` | CUA setup missing | Not installed | neutral |
| 7 | `package-missing` | bundled canInstall 或 package uninstalled | Not installed | neutral |
| 8 | `busy` | 当前行正在 connect/install/apply/check/enable/disable/validate/refresh/preview/uninstall | action-specific label | info |
| 9 | `connecting` | setup detected | Connecting | info |
| 10 | `stale` | health status expired 或 `expiresAt <= now` | Needs check | warning |
| 11 | `needs-check` | 已启用且 health unknown，并且 canCheck | Needs check | neutral |
| 12 | `disabled` | status available/disabled 或 setup connected | Disabled | neutral |
| 13 | `ready` | status enabled，且无更高优先级问题 | Available | success |
| 14 | `unknown` | 其他未覆盖组合 | Unknown | neutral |

补充规则：

- runtime blocker `Plugin is disabled` 和 `Plugin package is not installed` 分别映射为 disabled/package missing，
  不升级成 danger。
- `health.message`、`runtimePreview.blockers` 和 `health.details` 不直接作为 row 文案。
- busy 是临时视觉状态，mutation settle 后立即由最新权威对象重新派生。
- action failure 是 Web 展示层按 `pluginId + action` 保留的失败结果；retry、成功 mutation、对象权威状态
  改变或 cwd 切换时清除，不写入 daemon 或 localStorage。
- stale 不是失败，不使用 danger；失败恢复后不得留下旧红色状态。

## 10. Action Hierarchy

每行最多一个带文字主行动、两个常用 IconButton 和一个可选 More Menu。

### 10.1 Primary Action Matrix

| Primary state / capability | Text primary action |
|---|---|
| setup missing | Installation guide |
| package missing | Install |
| preset available 且 linked resource 不存在 | Apply preset |
| provider unavailable | Recheck |
| incompatible / restart / failed / platform blocked | View repair steps |
| stale / needs-check | Check |
| disabled 且 canEnable | Enable |
| busy | 保留 initiating action 的原 slot、label 和宽度，仅替换为 loading presentation |
| connecting / ready / unknown | none |

主行动由 view-model 返回，不允许组件再次拼接优先级。

### 10.2 Direct Secondary Actions

- `Check` IconButton：仅 `canCheck` 且 Check 未成为文字主行动时显示。
- `Details` IconButton：所有行始终显示，图标固定 `ChevronRight`。
- IconButton 为 `32x32px`，Lucide `16px`，必须有 Tooltip、title 和 ARIA label。

### 10.3 More Menu

只有存在低频操作时显示 `MoreHorizontal` IconButton。菜单顺序固定：

```text
Disable                    when canDisable
Validate package           bundled
Refresh package            when canRefreshPackage
separator
Uninstall plugin package   when canUninstall, danger
```

- Runtime Preview 不塞进 row More；它属于 Detail Drawer 的 Runtime Preview section。
- Enable 不在 Menu 重复；Disable 不作为 row 红色 icon。
- Menu 使用 shared Radix wrapper，Arrow keys 移动，Enter/Space 执行，Esc 关闭并恢复 trigger。
- `Uninstall` 必须先打开 confirmation Dialog，Menu item 不直接 mutation。

## 11. Refresh, Loading And Retained Stale

### First Load

- 无已知数据时显示 6 行稳定 Skeleton，保留 Header、Toolbar 和 TableHeader 尺寸。
- first-load failure 使用 TableBody 内 persistent InlineFeedback + Retry，不显示空白页。
- workspace cwd 不可用时显示 `Workspace is not ready` EmptyState，Add、Refresh 和 mutation disabled，
  disabled reason 可聚焦获取。

### Refresh

- Refresh 只让 Toolbar Refresh IconButton loading；现有行保持可见和可操作，除非 domain 明确禁止。
- refresh 成功原位替换数据，不重置 query/filter、scrollTop 或打开的 Drawer。
- refresh 失败且已有数据时保留旧行，在 Toolbar 下显示 persistent compact InlineFeedback：
  `Could not refresh plugins. Showing the last loaded result.`，并提供 Retry。
- retained rows 设置页面级 `data-stale=true`，状态列仍表达对象自身状态，不把每行都染成 warning。
- 后续成功 refresh 或 cwd 变化清除 retained stale。
- detected CUA 的自动 connect 继续 single-flight；用户 Refresh 不得创建第二个并发 connect。

## 12. Mutation And Feedback Lifecycle

| Action | Busy owner | Success | Failure | Clear rule |
|---|---|---|---|---|
| create | Dialog submit | Toast 3000ms；关闭 Dialog | Dialog InlineFeedback | edit/retry/close |
| apply preset | row primary | Toast 3000ms | row failure state + Detail InlineFeedback | retry/object changes |
| install | row primary | Toast 3000ms | row failure state + Detail InlineFeedback | retry/object changes |
| check/recheck | triggering control | Toast 3000ms + authority state | row failure state + Drawer InlineFeedback | next check/object changes |
| enable/disable | triggering control | Toast 3000ms | row failure state + Detail InlineFeedback | retry/object changes |
| validate package | Menu-origin action in Detail | success Toast 3000ms | Detail InlineFeedback | retry/close |
| refresh package | Detail action | Toast 3000ms | Detail InlineFeedback | retry/close |
| runtime preview | Runtime section action | ready Toast 3000ms | Runtime section InlineFeedback | next preview/object changes |
| uninstall | Confirm Dialog | Toast 3000ms；Dialog closes | Dialog InlineFeedback | retry/cancel |
| copy command | CUA Drawer | Toast 3000ms | Drawer InlineFeedback | retry/close |

规则：

- loading 只出现在触发控件；触发控件保留原 slot 和宽度。同一行不兼容行动可 disabled，但不能都显示
  spinner，也不能因 busy 让触发控件消失。
- failure 不能只存在会自动消失的 Toast；阻塞原因必须留在所属 row、Dialog、Drawer 或 Inspector。
- 同一 `plugin:<id>:<action>` feedback scope 替换，不重复堆叠。
- daemon raw message 只作为技术详情；默认失败文案必须说明结果、影响和下一步。
- mutation 成功不渲染页面常驻 success 条或绿色大块。

## 13. Create Dialog Contract

`PLUGIN-CREATE-001` 使用 shared `Dialog size="md"`，宽 `520px`，不再使用右侧 Drawer。标题为
`Add plugin`，不放介绍段落。

字段顺序固定：

1. `Plugin name`：Input，required，maxLength 80，autoFocus。
2. `Plugin description`：Textarea，required，maxLength 180，最小 88px。
3. `Connection type`：Select，`Local command / HTTP endpoint`。
4. stdio：`Command` Input、`Arguments (one per line)` Textarea。
5. HTTP：`Endpoint URL` Input。

交互规则：

- transport 切换时保留该次 Dialog session 内两套未提交值，payload 只包含当前选择。
- name、description、command/url 的现有 required 语义不变；参数按行 trim 并移除空行。
- Field error 紧贴字段并设置 `aria-invalid`；submit 时 focus 第一个无效字段。
- 不增加 secret、Header、approval、tool binding、Git/npm/zip 或任意脚本下载字段。
- Footer 左侧 `Cancel` secondary，右侧 `Add plugin` primary；busy 时宽度不变并阻止 Esc/outside/close。
- 创建成功后关闭 Dialog、Toast、保留筛选；若新插件被当前筛选隐藏，Toast 说明已创建但不强行改筛选。
- 创建结果保持 disabled，不能由前端自动调用 enable。

## 14. Preset, Install, Check And Enable Contract

### Apply Preset

- 只在 daemon `canApplyPreset` 且无 present linked resource 时显示。
- 点击直接调用现有 apply API；该操作幂等，不增加确认 Dialog。
- 成功更新插件与关联 MCP 投影，不自动授权队友工具。
- 失败使用产品化文案；raw MCP/provider error 进入 Details。

### Install Package

- 只在 `canInstall` 时显示。
- 现有 API 没有进度事件，UI 只显示 indeterminate `Installing...`，不得伪造百分比或步骤。
- install 成功不自动 enable；状态重新派生为 Disabled 或 Needs check。
- package validate、refresh 是低频动作，进入 Detail/More，不占 row 主层。

### Check

- Check 读取真实 daemon/plugin/MCP/CUA health，不用前端 metadata 假成功。
- stale/unknown 的 Check 是文字主行动；ready 行使用 icon-only。
- 检查期间旧状态保留，按钮 loading；settle 后一次性替换为权威状态。
- 成功 Toast 短暂，失败 InlineFeedback 持续。

### Enable And Disable

- Enable 是 disabled 行的文字主行动；不在 More 重复。
- Disable 放 More，属于可逆行动，不使用 danger tone、不要求确认。
- enable/disable 都不改变历史 run snapshot，不表示授权或撤销所有历史审计。

## 15. Detail Drawer Contract

`PLUGIN-DETAIL-001` 使用 shared `Drawer size="lg"`，宽 `480px`。Header、Body、Footer 固定 owner，
Body 是唯一滚动区。Drawer 打开/关闭不改变 Table row 高度或 scroll position。

### 15.1 Header

- 16px Plug icon、displayName、一个 StatusIndicator。
- 可选副行只显示本地化 source + version，例如 `Bundled · 1.2.0`。
- Close 为 shared IconButton；不显示 plugin ID、hash 或路径。

### 15.2 Default Body

默认展开内容顺序：

1. 仅在失败/stale 时显示 InlineFeedback：原因、影响、下一步。
2. 一行用途描述；description 为空则不占位。
3. compact facts：Source、Version、Linked resources summary、Package state、Runtime state。
4. `Open MCP connection` 仅在 present linked MCP 时显示，明确离开 Plugin Manager 进入 Settings。

默认层不显示 Plugin ID、detected command、cacheRef、package hash、health ISO 时间、贡献 ID、
policy target、raw blocker 或 events。

### 15.3 Inspector Sections

顺序和默认 open 状态固定：

| Section | Default | Summary | Body |
|---|---|---|---|
| Capabilities | closed | contribution counts | human label、kind、enabled/present；raw id folded deeper |
| Runtime Preview | closed; user runs preview 后 open | ready/blocked/disabled + counts | product blockers、resources、policy summary |
| Trust and permissions | closed | approval/secret counts | trust summary、secret requirement name、required/optional、default approvals |
| Technical details | closed | `IDs, package and provider data` | raw fields and exact timestamps |

只有用户当前任务必需的失败修复区可自动展开；Technical details 永不自动展开。
当前 response 不提供 secret 是否已配置的权威状态，因此 Inspector 不显示或推断 configured/missing；所有
secret value 在默认层和 Technical details 都禁止出现。

### 15.4 Footer

- 最多一个 context primary action，使用与 row 相同派生结果。
- Runtime Preview action位于对应 InspectorSection 内，不放一排 footer buttons。
- Footer 可包含 More Menu；Uninstall 仍需 Confirm Dialog。
- Drawer busy 时仅 mutation owner loading；其他不兼容 action disabled。

## 16. Runtime Preview Contract

点击 `Run preview / Refresh preview` 调用现有 `GET /plugins/:id/runtime-preview`。打开 Detail 本身不
自动发请求，避免把检查和浏览混为一体。

### Product Summary

- `injectable`：`Ready for new runs`，success tone；显示 MCP servers、skill packs、apps、hooks 数量。
- `disabled`：`Enable this plugin before it can be used in new runs`，neutral；若 canEnable，提供 Enable。
- `blocked`：`Not ready for new runs`，danger/warning 取决于主状态；显示一个产品化首要原因和修复行动。

### Resource Rows

- MCP、Skill、App、Hook 分组只在 count > 0 时显示。
- 每项显示 human displayName/label、present/enabled 状态；缺失资源提供 `Open MCP connection` 或
  Details 修复路径。
- raw contribution/resource ID 只进 Technical details。

### Policy Summary

- 默认只显示 `N policy rules · highest risk: Ask/Deny`。
- targetKind、targetId、contributionId、sideEffectLevel 和 reason 进入 Technical details。
- Preview 不能改变 policy、enable、binding 或 run snapshot，只是只读投影。

### Blocker Mapping

已知 blocker 映射为产品文案：disabled、package not installed、cache missing、health stale/failed、
linked MCP missing、CUA health not verified。未知 blocker 默认显示 `Runtime is not ready.`，原始字符串
只在 Technical details 展示，不能把内部路径或 secret 带回默认层。

## 17. CUA Contract

### 17.1 macOS Setup Drawer

仅当权威对象为 CUA、setup missing 且存在 guide 时显示 `Installation guide`：

- shared Drawer `lg`，标题 `Install Cua Driver`；
- 默认区显示官方文档链接、只读 install command 和 Copy IconButton；
- 自定义 executable path 放 `InspectorSection`/Collapsible，默认关闭；
- path 必须为 absolute；validation 留在 Field；
- Ling 只检测并连接本地 driver，不执行安装命令；
- Recheck 是单一 primary；成功后 Drawer 关闭，回到同一行；
- copy success 使用 Toast，不保留空白 status 占位。

### 17.2 Windows Provider Health

Windows 不显示 macOS install command 或 Mac-specific Drawer。默认层只显示以下一个状态：

| Provider result | Default label | Primary action | Details |
|---|---|---|---|
| unavailable/non-interactive session | Unable to connect | Recheck | 要求 interactive desktop session |
| tool/schema/version incompatible | Update required | View repair steps | current/supported version、missing tools |
| restart required | Restart required | View repair steps | why restart is required |
| UIA/screen capture/permission failed | Needs attention | View repair steps | failed capability rows |
| ready | Available | none | last verified、provider evidence |

`health_report`、UIA、DXGI、tool name、schema JSON 和 provider raw response 只在 Technical details。
UI 不新增假的 `Open system settings` 或 `Restart driver` mutation；没有现有 bridge/action 时只提供修复说明
和 Recheck。

### 17.3 Cross-Platform Truth

- macOS 与 Windows 共用状态、Button、Drawer、InlineFeedback 和 motion；平台差异只在内容和可用行动。
- Web fixture 只能验证投影，不能替代 packaged Desktop provider attach、interactive session、DPI 或权限证据。
- high contrast、reduced transparency 和 reduced motion 下仍必须看见唯一修复行动。

## 18. Uninstall Confirmation

`PLUGIN-UNINSTALL-001` 只在 `canUninstall` 时出现，使用 shared `Dialog size="sm"`，宽 `360px`。

固定文案结构：

- Title：`Uninstall <plugin name>?`
- Consequence：`This removes the installed package and disables its linked capabilities.`
- Retained：`Plugin history and past run evidence are kept.`
- Cancel：secondary。
- Confirm：danger `Uninstall package`。

行为：

- 打开 Dialog 不立即执行；Cancel、Esc、outside 均关闭并恢复 More trigger。
- confirm busy 时阻止重复提交、Esc、outside 和 close。
- 成功后 Dialog 关闭，插件仍在 catalog 中，状态变为 Not installed；焦点回到该行 Install action。
- 失败留在 Dialog InlineFeedback，可重试；不关闭、不只发 Toast。
- 不提供“永久删除”、输入名称确认或缓存文件路径说明，因为现有 API 不具备对应语义。

## 19. Empty, No-Result, Error And Long Data

| State | Surface | Contract |
|---|---|---|
| empty catalog | TableBody | compact EmptyState，`No plugins available` + Add plugin |
| no result | TableBody | compact EmptyState，`No plugins match these filters` + Clear filters |
| first loading | TableBody | 6 stable Skeleton rows |
| retained refresh | Toolbar owner | persistent compact InlineFeedback + Retry，旧 rows 保留 |
| first-load error | TableBody | InlineFeedback/EmptyState + Retry |
| row mutation failure | row/Detail | persistent InlineFeedback，不增高 row；row 显示 repair indicator，详情承载正文 |
| overlay validation | Field/Dialog/Drawer | field error 或 submit InlineFeedback |
| stale health | status + Detail | `Needs check`，warning，不冒充 failure |
| long plugin name | row | ellipsis + title；Drawer wrap |
| long description | row | 单行 ellipsis；Drawer 最多普通换行，不固定高度 |
| long raw ID/path/hash | Technical details | `overflow-wrap:anywhere`；command/code 可横向内部滚动 |
| 100 rows | TableBody | internal scroll，Header/Toolbar 不移动 |

Row 永不承载多行 error body。失败行可以显示一个 6px danger/warning state 和 `View repair steps`，正文只在
Drawer，保证 64px 行高稳定。

## 20. Keyboard, ARIA And Focus

- 页面标题关联 workspace landmark；Table 使用原生 table semantics 和 column headers。
- Search、Source、Status 均有可见 label 或 visually-hidden label，不依赖 placeholder。
- Tab 顺序：Add -> Search -> Source -> Status -> Refresh -> 每行 actions。
- IconButton 必须有本地化 label、Tooltip 和 title；装饰 Plug 图标 `aria-hidden`。
- StatusIndicator 同时有文字，颜色不是唯一信号；loading 使用 `aria-busy`。
- Drawer/Dialog 使用 Radix focus trap；关闭后恢复原 trigger，trigger 消失时使用前述 fallback。
- Esc 关闭 Menu、非 busy Dialog/Drawer；busy mutation 期间阻止关闭并保持 live loading label。
- InspectorSection summary 可由 Enter/Space 切换；Technical details 默认 closed。
- failure 使用 `role=alert`，普通 stale/retained refresh 使用 `role=status`，避免同一消息重复播报。
- disabled 原因必须通过相邻说明或可聚焦 wrapper 获取，不能只依赖 disabled button Tooltip。

## 21. Motion

- row hover、Button、status color：`120ms` fast token。
- Menu：`120ms` opacity + translateY 4px。
- Dialog：`180ms` enter / `120ms` exit。
- Drawer：`240ms` enter / `180ms` exit，translateX；不动画 width 以外的布局属性。
- InspectorSection：`180ms` disclosure；长异步 Runtime 内容允许直接展开。
- 打开新不兼容 overlay 前先关闭当前 overlay。从 Detail Drawer 发起卸载时先记录返回意图、关闭 Drawer，
  再打开 Confirm Dialog；Cancel 后重新打开 Drawer 并恢复 More trigger，成功后回到列表行 Install action。
- 快速 open/close 从当前 computed position 反向，不闪回起点。
- `prefers-reduced-motion` 下取消 translate/scale，只保留不超过 `80ms` opacity 或直接切换。
- 禁止 `transition: all`、摇晃、弹跳、逐行 stagger 和页面重新入场。

## 22. i18n And Product Copy

- 所有 UI label、Tooltip、ARIA、status、empty、error、confirm 文案同时提供 `zh-CN` 和 `en-US`。
- locale 只存文案，不存 status priority、action visibility 或 filter predicate。
- 产品文案优先“结果 + 下一步”，不显示 transport、adapter、provider schema 或 error code。
- `Built-in / Bundled / Trusted local` 是来源；`Available / Disabled / Needs check / Needs attention` 是状态，
  不互相替代。
- `Uninstall plugin package` 与 `Disable plugin` 必须区分，不能都翻译成“删除”。
- CUA、MCP、Plugin ID、model/tool 名等产品或技术专名可以保留英文；页面不出现非必要中英文混排。
- 长英文按钮按规定保持单行；若 locale 文案超出 272px actions 列，优先缩短产品文案，不缩小字号。

## 23. Theme And Desktop Surface

- Feature 只使用 `--ling-*` semantic token，不读取 `data-ui-theme`、`data-color-scheme` 或 Theme Pack ID。
- `ling-light`、`ling-dark`、导入主题共用同一 geometry；状态色由 tone 决定，不硬编码绿/黄/红。
- Desktop Main BrowserWindow 复用同一 Plugin Manager feature，不复制 Electron 私有页面。
- `[data-client="desktop"]` 只能由 client surface token 改变窗口材质；Table、Dialog、Drawer 和 Button 样式
  不能按 macOS/Windows 分叉。
- macOS/Windows 使用同一 32/36px control、64px row、480px Drawer 和 360/520px Dialog。
- 验收覆盖 Windows 100/125/150/200% scale、high contrast，以及 macOS reduced transparency；不支持材质时
  回退不透明 surface。
- Theme 切换不能关闭 Drawer/Dialog、清空筛选、重置 Table scroll 或重新发 mutation。

## 24. Target Component Mapping

| Current | UI 2.0 target |
|---|---|
| native/legacy buttons | `Button`、`IconButton` |
| raw input/textarea/SelectControl | `Field` + `Input`/`Textarea`/`Select` |
| div role table | semantic `Table` family |
| private status dot | `StatusIndicator` |
| private empty/loading | `EmptyState`、`Skeleton`、`Spinner` |
| hand-written drawer overlay | shared `Drawer` |
| create Drawer | shared `Dialog md` |
| raw `<details>` | `InspectorSection` |
| low-frequency row actions | `Menu` |
| local validation/error boxes | `InlineFeedback` / Field error |
| domain notifications | shared Ling Toast adapter |
| direct Lucide row button | Lucide icon through `IconButton` |

Feature 页面不得直接 import Radix，也不得覆盖 `.ling-ui-*` 内部 selector。

## 25. CSS Ownership And Deletion Contract

目标文件树：

```text
apps/web/src/styles/plugins.css                         <= 8 lines, imports only
apps/web/src/styles/plugins/plugin-manager-shell.css   <= 90 lines
apps/web/src/styles/plugins/plugin-manager-table.css   <= 180 lines
apps/web/src/styles/plugins/plugin-detail-runtime.css  <= 150 lines
apps/web/src/styles/plugins/plugin-cua-install.css     <= 150 lines
```

feature CSS 总预算 `<= 500` 行。共享 Button、Field、Table、Dialog、Drawer、Menu、Tooltip、Toast、
StatusIndicator、EmptyState、Skeleton 和 motion 不得在 plugin CSS 重写。

迁移时删除：

- `plugin-cua-health.css`；
- `settings.css` 中全部 `.settings-plugin-manager*` selector；
- `.plugin-detail-drawer/.plugin-detail-panel` 私有 overlay chrome；
- `.plugin-table-status-dot` 私有状态实现；
- `.plugin-table-icon-action`、`.plugin-drawer-action` 私有 Button geometry；
- `.plugin-create-validation` 能被 Field/InlineFeedback 替代的规则；
- raw color、radius、shadow、duration 和重复 scrollbar skin。

允许保留的 feature CSS 只包括 Page grid、Table columns、cell truncation、Drawer 内领域布局、Runtime
resource grid、CUA command/path 布局和内部 scroll ownership。

## 26. Test And Screenshot Contract

### Static And Regression

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- plugins.spec.ts ui2-plugin-manager.spec.ts app.spec.ts dark-mode.spec.ts
corepack pnpm --filter @ling-stack/daemon test
```

### Required Browser States

- default list、100 rows、search、source/status filter、no-result；
- first loading、first-load error、retained refresh stale、refresh recovery；
- built-in/bundled/trusted local、enabled/disabled/blocked/stale；
- apply preset、install、validate、refresh package、enable、disable、check；
- create stdio/HTTP、validation、busy、success、failure；
- Detail default、Capabilities、Trust、Technical details；
- Runtime injectable/disabled/blocked、unknown blocker、long raw data；
- uninstall cancel/busy/success/failure；
- macOS CUA missing/custom path/copy/recheck；
- Windows provider unavailable/incompatible/restart/capability failure/ready；
- keyboard、focus restore、rapid Drawer toggle、reduced motion；
- `ling-light`、`ling-dark`、一个 imported Theme fixture；
- `1280x800`、`1440x960`，document/table/Drawer horizontal overflow <= 1px。

### Original-Size Evidence

证据目录固定为：

```text
docs/design/ui2.0升级/evidence/features/plugin-manager/
```

至少保存以下原尺寸 PNG，不 resize、不压缩后替换原图：

```text
1440x960-ling-light-list-ready.png
1280x800-ling-dark-list-needs-action.png
1440x960-ling-light-search-no-result.png
1440x960-ling-light-retained-refresh-failure.png
1440x960-ling-light-create-validation.png
1280x800-ling-dark-detail-runtime-blocked.png
1440x960-ling-light-uninstall-confirm.png
1280x800-ling-dark-cua-repair.png
```

`metadata.md` 必须记录 branch、commit、Vite URL、fixture、viewport、Theme Pack、locale、原图尺寸、
SHA-256、console errors、horizontal overflow、测试命令和通过数量。Web CUA fixture 与真实 Windows
Desktop smoke 必须分开标注，不能互相代替。

## 27. Completion Gate

只有同时满足以下条件，Plugin Manager UI 2.0 才可标记 `verified`：

- Function Points 的所有可达状态均有代码、E2E 和证据；
- 列表默认层无 raw id/hash/path/provider schema；
- 每行只有一个主状态和最多一个文字主行动；
- Search/filter、empty/no-result/loading/stale 均可达；
- create、Detail、Runtime、CUA、uninstall confirm 全部使用 shared overlay primitive；
- failure 在 Toast 消失后仍有对象级修复路径；
- `plugins.css` 完成拆分，旧 Settings/plugin overlay selector 删除；
- 1280/1440 Light/Dark 原图、console 和 overflow 检查通过；
- packaged Windows CUA provider health 有真实 interactive session 与 DPI/high-contrast 证据；
- API、contracts、数据库、权限、run snapshot 和 Plugin trust 语义未变化。

## 28. Hard Stops

- 不新增或修改 daemon API、contracts、数据库表、plugin state machine 或 ViewId。
- 不把 Plugin Manager 放回 Settings，不增加第二个入口。
- 不实现 marketplace、Git/npm/zip 安装、自动更新或第三方任意代码加载。
- 不把 enable 解释为授权，不自动给 AI 队友绑定工具。
- 不伪造 install percentage、provider success、permission success 或 Runtime provenance。
- 不显示永久 Delete，因为当前只有 bundled package Uninstall。
- 不把 macOS 安装命令显示在 Windows，也不为 Windows 发明未接线系统操作。
- 不向 3128 行 `AppShell.tsx` 增加 plugin UI、筛选或状态派生逻辑。
- 不继续扩大 347 行旧 view-model、601 行 `plugins.css` 或 Settings plugin selector。
- 不直接 import Radix，不覆盖 `.ling-ui-*`，不新增 hard-coded theme color 或 raw motion duration。
- 不只验收默认列表；Dialog、Drawer、Menu、details、failure、stale、no-result 和 Desktop 都属于完成面。

## 29. P9 Closeout - 2026-07-22

### Implemented

- Plugin Manager 展示 owner 已迁入 `apps/web/src/features/plugins/`，旧 Settings panel 和 347 行 combined
  view-model 已删除；所有新 production owner 均低于 400 行。
- Header、搜索、来源/状态筛选、语义 Table、单一主状态、动作矩阵、Create Dialog、Detail/CUA Drawer、
  Runtime Preview、技术详情折叠和 bundled package Uninstall 确认均已接入。
- `plugins.css` 已变成 6 行 imports-only；shell、toolbar、table、detail、runtime 和 CUA 各有 focused
  owner，单文件最大 160 行。focused CSS 无硬编码颜色、`!important`、
  `transition: all`、private keyframe 或 `.ling-ui-*` descendant override。
- Uninstall 仍只卸载 bundled package，并保留 catalog、历史和运行证据；enable、permission、CUA 和
  Runtime Preview 的既有业务语义未改变。

### Verified

- Web typecheck、UI2 lint、i18n audit、`git diff --check` 均通过。
- `ui2-plugin-manager.spec.ts` 与 legacy `plugins.spec.ts` 在真实 Vite 联合运行 `17/17` 通过；新增覆盖
  retained refresh Retry、row-scoped Check failure 和 Drawer-scoped generic mutation failure。
- 9 张 Light/Dark、`1440x960`/`1280x800` 原尺寸证据已生成；每次截图前均检查 console/page error
  为 0，document 横纵向 overflow 不超过 1px。详见
  [evidence metadata](../evidence/features/plugin-manager/metadata.md)。

### Partial And Deferred

- retained refresh failure/recovery 已通过 domain error revision 接入，失败时保留上一批 rows，Retry 成功后
  清除 stale；通用 mutation failure 由触发行或 Detail Drawer 持久拥有，不再是活动缺口。
- imported Theme fixture 已由 T13-O.32 的 Quiet Ocean CUA/Create focused state 补齐；不再是 Web 缺口。
- Windows Web provider-health fixture 已通过 legacy 回归，但没有 packaged Windows interactive session、
  DPI 或 high-contrast 证据，状态保持 `partial / unverified`。
- 15 条新增产品文案已由集成 owner 写入共享 `en-US` / `zh-CN` locale；`plugin-manager-copy.ts` 仅通过
  共享 `t()` 派生文案，不再维护 feature-local locale 分支。
- `plugin-cua-health.css` 与全局 import 已在 T13-O.32 的独立 ownership 切片删除。
- `.settings-plugin-manager*` class 仅作为不可修改 legacy spec 的查询兼容钩子保留；对应
  `settings.css` selector 不在本切片写集，视觉由后加载的 Plugin focused CSS 接管。
- 行内 Check/Details/More 已迁入 shared `IconButton`，旧 30px/no-wrapper 测试合同和
  `plugin-action-compat.css` 已删除；focused 与 legacy 回归统一断言至少 32px 点击区域。

## 30. T13-O.32 Dark Blanket Ownership Release - 2026-07-24

- Plugin root 已从 final `strict-console.css` 的 1 个 generic Dark root repaint 与 21 个 descendant blanket
  全部释放；Plugin focused CSS 和 shared package 是当前唯一视觉 owner。
- `plugin-cua-health.css` 空 facade 与全局 import 已删除，真实 CUA owner 继续是
  `plugins/plugin-cua-install.css`；无消费者 `.settings-plugin-token` 也已删除。
- shared InlineFeedback detail 暴露 `data-ling-inline-feedback-slot="detail"`；Plugin retained refresh 与 Detail
  failure 使用公开 slot，不再选择 package 私有 `.ling-ui-inline-feedback-detail`。
- 新 focused spec 覆盖 Light retained list、Dark row failure、Quiet Ocean CUA/Create、keyboard、reduced motion、
  console/pageerror 和 overflow；ordinary/capture 各 `4/4`。既有 Plugin `17/17`、App/Dark/Theme `26/26`、
  representative release gate `12/12` 通过。
- Web CSS 为 `160 files / 33,861 lines`；Plugin focused CSS 仍为 7 files / 549 lines，不复制 shared chrome。
- imported Theme Web fixture 缺口已关闭；packaged Windows CUA interactive、DPI/high-contrast 与 macOS packaged
  证据仍保持独立 pending，不因本切片继承 Web 结果。
- 证据见 [Plugin Manager Legacy Writer Release](../evidence/features/plugin-manager-legacy-writer/metadata.md)。
