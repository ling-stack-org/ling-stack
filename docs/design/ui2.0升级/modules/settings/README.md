# Settings UI 2.0 合同

Status: active UI2 product contract
Owner: Settings shell and feature owners
Last verified: 2026-10-28
Code anchors: `apps/web/src/features/settings/`, `apps/web/src/styles/settings-skill-library/`
Test anchors: `apps/web/e2e/ui2-settings-shell.spec.ts`, `apps/web/e2e/settings.spec.ts`

## Shell

Settings 是全屏管理边界，隐藏主 Sidebar，保留自身导航、返回、标题和唯一内容滚动 owner。页面只展示
用户可改变或必须处理的信息；正常健康状态、重复标题、刷新按钮和解释性灰色小字默认删除。

- 表单 header/footer 固定，body 超限后内部滚动；页面本身不产生横向滚动。
- Light/Dark 使用同一信息层级。Dark 采用分层深灰，不在 panel、表格或输入区加入大面积纯黑补丁。
- 失败靠近发起对象，成功短暂提示；raw ID、路径、checksum 和 provider metadata 仅在确有诊断价值时折叠。

## Current Sections

### 默认权限

设置工作区默认策略，不伪装成当前队友可编辑权限。正常状态不重复提供“打开默认权限设置”跳转；
只有权限被限制且需要处理时出现行动。安全、审批和完全访问语义由权限合同和 daemon enforcement 管理。

### 个性化与界面

只保留真实可编辑的治理下拉、主题、语言和界面偏好。移除只读“高级治理”、来源/存储路径、刷新按钮和
整块模式说明；候选发布和绑定仍需人工审核的安全说明可以保留一句。

主题区只展示官方内置主题，场景主题提供完整氛围缩略图。Theme Studio / Quick Theme 生成入口已停用；自定义背景通过独立背景区上传本地图片或 MP4/WebM，不属于 Theme Pack。

界面偏好当前采用独立卡片：外观、背景、可用的 Desktop 偏好和语言共用 `settings-interface-preferences.css` 的唯一布局定义。卡片四周内边距为 `--ling-space-8`（24px），卡片间距为 `--ling-space-6`（16px），每张卡片保留完整边框。主题只改变材质、色彩和批准的组件参数，不能改变上述布局。连续分区的零间距、相邻区块内部补偿及末区删底边规则已废弃，必须在原定义处删除，不能用后置主题覆盖保留两套实现。

背景保存/恢复默认成功由唯一全局 Toast 显示，使用稳定 scope 去重并沿用共享成功通知默认 3 秒的生命周期（悬停/焦点时按共享组件规则暂停）；不在背景编辑器另存成功布尔状态、常驻成功文案或增加独立反馈计时器。页面内保留媒体来源、处理/草稿状态以及需要处理的错误；失败不能误报成功。历史导入主题数据保留存储，但不得重新出现在选择器或恢复导入/管理入口。

### 外部工作与 MCP

External Work 和 MCP 只展示已配置能力、连接状态和必要修复。没有 MCP Server、授权或异常时不制造空的
队友页面；服务器 ID、transport、raw health 和工具 schema 默认折叠。启停、检查、授权和删除各自拥有
scoped busy/error。

### 技能库

- 分区为“我的技能 / AI 进化 / 内置技能”，来源归属按技能合同决定。
- 列表默认展示技能、说明、绑定和必要动作；来源、ID、checksum、路径进入详情。
- 无阶段概念；正常技能不显示健康标签。归档技能不出现在队友可用技能列表。
- 我的技能与 AI 已生成技能可按来源边界编辑；内置、gstack、workspace 只读。
- 三个分区使用内容自然高度和统一 `max-height`，溢出后显示透明轨道悬浮滚动条，不保留永久 gutter。

### 已归档

按真实可恢复对象分类展示。Restore/Delete 使用服务端能力和共享确认 Dialog；没有对应能力的类型不显示
动作。刷新失败保留已有列表并标记 stale。

## Intentionally Hidden Or Pending

- “启动与诊断”当前从主 Settings 导航隐藏，重新开放前按
  [实施计划](08-Startup与Diagnostics-implementation-plan.md)完成产品化。
- Workspace Tools 嵌入态尚未完成，按
  [实施计划](09-Workspace-Tools嵌入态-implementation-plan.md)推进，不恢复旧 iframe/跳转体验。
- 历史 Desktop Theme Pack 原生存储计划已停用；当前主题只使用官方内置主题，用户背景按
  [官方场景主题与自定义媒体背景验收矩阵](../../../full-window-theme-background-acceptance-matrix.md)验收。
- 工作看板和 Inbox 不是 Settings 已发布入口，不通过 Settings 文案暗示已可用。

## Acceptance

Settings 回归覆盖导航恢复、dirty draft、保存冲突、Dialog/Drawer、内部滚动、空态、长列表、中文/英文、
Light/Dark、`1440x960`、`1280x800`、键盘、Esc、焦点恢复和 console/pageerror。
