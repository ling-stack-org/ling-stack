# 旧组件与 CSS 清单

完整 42 文件目标归属见 [CSS 逐文件拆分矩阵](06-CSS逐文件拆分矩阵.md)，selector、颜色和
行数预算见 [Selector 与硬编码颜色清理](07-Selector与硬编码颜色清理.md)。

## Shared Components

| Current component | Decision | Target / reason |
|---|---|---|
| ActionMenuItem | deleted | 调用已迁 shared Radix `Menu.Item`；T13-H 删除无引用 component/export/CSS |
| CreateDialogShell | deleted T13-P.3-R | 历史决策 `wrap then delete` 已关闭；调用方直接使用 shared `Dialog` |
| DialogSection | move | `InspectorSection` 或 Dialog body section |
| OperationEmptyState | deleted T13-P.2-D / reconciled T13-P.3-R | 最后一个 Council consumer 直连 shared `EmptyState`；最终 `0/0`，不保留同义 wrapper |
| SelectControl | deleted T13-P.3-R | 历史决策 `wrap then delete` 已关闭；调用方直接使用原生型 shared `Select`，最终 `0/0` |
| RichChoiceSelect | wrap | `Popover` + choice rows；稳定后再决定 package API |
| StatusBadge | wrap then delete | `Badge` / `StatusIndicator`，由调用方选择语义 |
| PageActionHeader | refactor | `PageHeader`，移除重复描述槽位 |
| StatusActionRow | refactor | `DataRow` + `StatusIndicator` |
| MessageComposer | domain | 迁入/复用 conversation UI，不作为通用表单 |
| ArtifactRow | domain | 保留在 Web/conversation，基础按钮使用 ui-react |
| AvatarInitial | move candidate | 通用 Avatar primitive 后再迁移 |
| LingStackLogo | app identity | 保留 Web/AppShell |
| MetaRow | refactor | `DataRow` 或 Inspector facts |
| RunRepairHintBanner | domain | 保留业务 copy，使用 InlineFeedback |
| UsedMemorySummary | domain | 保留 teammate/conversation 领域组件 |
| UserProfileAvatar | domain wrapper | 复用 Avatar/IconButton |
| Composer tokens | conversation | 留在 conversation packages |

## CSS Baseline

| File | Current lines | UI 2.0 decision |
|---|---:|---|
| `components.css` | 16695 | 冻结，只允许删除；基础组件迁出 |
| `teammates.css` | 5330 | 拆 chat、management、memory focused CSS |
| `settings.css` | 3189 | 只留 shell/layout，子页面迁 focused CSS |
| `providers.css` | 2354 -> deleted | 模型领域布局迁 focused owner；空 marker 由 T13-H 删除 |
| `layout.css` | 2123 | 拆 AppShell 与 legacy menu/tooltip |
| `sidebar.css` | 2086 | 只留 Sidebar layout，控件迁 package |
| `automations.css` | 1466 | 保留领域 layout，删除 popover/form 重复 |
| `strict-console.css` | 1394 | 审核必要性，不能覆盖共享组件内部 |
| `workspace.css` | 1171 | 保留 workspace layout |
| `runs.css` | 1050 | 保留 timeline/inspector 领域规则 |
| 其他 focused CSS | 1024 以下 | 按模块逐项审核 |

基线补充：42 个 CSS 文件、49,205 行、14,016 个 class selector occurrences、2,898 个
unique class-like selector、1,929 处颜色字面量、18 个 `!important`。

## Legacy Class Families

以下 class 不得在新代码中新增：

```text
primary-button
secondary-button
compact-button
icon-button
compact-icon-button
create-dialog-*
sidebar-section-menu-popover
provider-row-menu-popover
teammate-row-menu-popover
automation-popover-*
inline-error
status-badge 的新变体
```

迁移时先查引用，再由 wrapper 保留短期 selector。删除必须与 E2E selector 更新同一切片完成。

## Dialog And Drawer Inventory

| Source | Function ID / target |
|---|---|
| `app/AppShell.tsx` | `SHELL-PERMISSION-001` / Dialog confirm |
| `automations/AutomationCreateDialogs.tsx` | `AUTO-CREATE-001` / Dialog |
| `mcp/McpToolsPage.tsx` | `SETTINGS-MCP-CREATE-001` / Dialog |
| `media-production/workflows/MediaWorkflowLibraryOverlay.tsx` | `PROD-WORKFLOW-001` / Dialog large |
| `plugins/CuaDriverInstallDrawer.tsx` | `PLUGIN-CUA-001` / Drawer |
| `plugins/PluginCreateDrawer.tsx` | `PLUGIN-INSTALL-001` / Dialog or Drawer create |
| `plugins/PluginDetailDrawer.tsx` | `PLUGIN-DETAIL-001` / Drawer |
| `profile/AvatarCropDialog.tsx` | `PROFILE-AVATAR-001` / Dialog |
| `providers/ProviderEditorPanel.tsx` | `MODEL-EDITOR-001` / Drawer large |
| `runs/SkillRecordingReviewSheet.tsx` | `RUN-RECORDING-001` / Drawer/Dialog |
| `settings/SkillEditorDialog.tsx` | `SETTINGS-SKILL-EDITOR-001` / Dialog large |
| `settings/SkillImportDialog.tsx` | `SETTINGS-SKILL-IMPORT-001` / Dialog |
| `teammates/AiTeammatesPage.tsx` | `TEAMMATE-LIST-001` / Drawer detail |
| `workspace/ChannelEnvironmentPage.tsx` | `CHANNEL-ENV-001` / Dialog |
| `workspace/ChannelGovernanceNotificationsPopover.tsx` | `CHANNEL-SETTINGS-001` / Popover, not modal dialog |
| `workspace/ChannelRenameDialog.tsx` | `CHANNEL-OVERLAY-001` / Dialog |
| `workspace/WorkflowConversionPreviewDialog.tsx` | `CHANNEL-ENV-001` / Drawer/Dialog preview |
| `shared/components/CreateDialogShell.tsx` | historical inventory；T13-P.3-R 已删除，最终 `0/0` |

P3 历史阶段的 CreateDialogShell consumers 包括 Channel Create、Teammate Create、Council Create、
Media Job Create、Project Run Review、Scene Result Preview 和 Scene Delete，均由对应模块 Function ID
验收。当前 facade 已删除；Channel Create 直接组合 shared `Dialog` 与 `Select`，其余调用也不得重新引入
同名 compatibility wrapper。

## Menu And Popover Inventory

| Source group | Function ID / target |
|---|---|
| SidebarNavigation | `SIDEBAR-MENU-001` / Menu + Tooltip |
| ProviderRouteList | `MODEL-LIST-001` / Menu |
| AiTeammatesPage | `TEAMMATE-LIST-001` / Menu |
| Automation create/schedule | `AUTO-SCHEDULE-001` / Popover/Field |
| TeammateChatHeader/PrivateChat | `CONV-TEAMMATE-*` / shared toolbar and Popover |
| ChannelComposer/AuthorizationMenu | `CHANNEL-COMPOSER-001` / Menu/Popover |
| ChannelEnvironment/Page/Summary | `CHANNEL-ENV-001` / Popover/Menu |
| ChannelGovernanceNotifications | `CHANNEL-SETTINGS-001` / Popover |
| ChannelProgressPanels | `CHANNEL-SUMMARY-001` / Popover |
| ConversationHome/SummaryPopover | `CONV-NORMAL-SUMMARY-001` / Popover |
| WorkspaceClientView | `CHANNEL-*` / shared overlays |
| WorkspaceFileOpenMenu | `CHANNEL-FEED-001` / Menu |
| ComposerPermissionMenu | `CONV-*-COMPOSER-001` / Menu |
| ActionMenuItem | removed；shared Menu.Item is authoritative |
| RichChoiceSelect | Popover-based compatibility component |

## Large-File Guard

`WorkspaceClientView.tsx`、`TeammateWorkspace.tsx`、`ConversationHome.tsx`、
`ConversationWorkCell.tsx`、`AppShell.tsx` 等大文件只接入抽出的组件，不追加新的主要 UI。
