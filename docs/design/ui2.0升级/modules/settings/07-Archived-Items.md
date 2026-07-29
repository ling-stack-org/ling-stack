# Archived Items

> P7B.3 design contract. Current status: `verified`; code, automated regression, six real-browser screenshots and metadata closed on 2026-07-20.

## 1. 页面目标

Settings > 已归档项目是 workspace 对象的恢复与最终保留面。用户只在这里完成两件事：

- 将已归档会话、AI 队友、频道或分支恢复到正常列表；
- 在理解后果后永久删除允许删除的归档对象。

它不是活动日志、回收站营销页或诊断面。默认层只显示分类、搜索、对象身份、归档时间、Restore 和 Delete。

## 2. 入口、Shell 与真实 IA

- 入口：Settings > 维护 > 已归档项目。
- Shell owner：`SettingsShell`；页面不重复标题、返回按钮或手动 Refresh。
- 一级分类固定为 `Conversations / AI Teammates / Channels / Branches`，使用现有 `SettingsSubnav` shared Tabs。
- 默认进入 Conversations；最后分类保存在 local presentation preference，切换分类或 Escape 清空搜索。
- 每次只渲染一个列表；不增加 All、批量恢复、批量删除、二级路由或 `ViewId`。
- Web 与 Electron Desktop 主窗口复用同一 surface；移动端不在本轮范围。

## 3. 已确认的业务边界

P14/P14.2 已经完成后端和产品语义，本切片不得重写：

- Restore 只恢复归档状态；Sidebar archive 继续是非破坏操作。
- Conversation delete 清理消息、附件、目标和计划；历史 runs/events/artifacts 保留并解除 thread 关联。
- AI teammate delete 清理私聊、附件、头像、记忆和私有绑定；频道/运行历史保留 deleted teammate reference。
- Channel/Branch 沿用现有永久删除路径；恢复归档分支时，如父频道也已归档则显示 `Restore both` 并先恢复父频道。
- 非归档、非 conversation、活动工作、活动 turn、启用自动化目标和受保护 Ling Agent 继续由真实 API 拒绝。
- 本切片不改 contracts、API、数据库、retention tombstone、状态机、路由或删除原因。

## 4. 当前实施检查点

| Owner | Baseline | Current | Result |
|---|---:|---:|---|
| `ArchivedSettingsPanel.tsx` | 378 lines | 132 lines | 只保留 composition/local UI state |
| `ArchivedItemsToolbar.tsx` | absent | 76 lines | shared Tabs/Input/IconButton |
| `ArchivedItemList.tsx` | inline | 107 lines | shared Skeleton/EmptyState/DataRow/Button/IconButton |
| `ArchivedDeleteDialog.tsx` | browser confirm | 125 lines | shared Dialog、busy、error 和 focus lifecycle |
| `ArchivedErrorFeedback.tsx` | inline legacy error | 27 lines | scoped persistent feedback |
| `archived-items-view-models.ts` | absent | 184 lines | locale-neutral typed projections |
| `useArchivedSettingsController.ts` | 246 lines | 296 lines | load/action error 分离，API 时序保持 |
| `settings-archived-items.css` | absent | 173 lines | Archived domain geometry 唯一 owner |
| `settings.css` | 972 lines | 823 lines | Archived selector family 已迁出 |

raw controls、`Loader2.spin`、四个 `window.confirm`、legacy Empty/Error 和聚合 Archived CSS 已迁移。
`ui2-settings-archived-items.spec.ts` 五个 focused scenarios、既有 Settings/Archive 回归和 selected UI 回归均已通过。
六张实页证据、原尺寸目检和 SHA-256 见
[`evidence/settings/archived-items/metadata.md`](../../evidence/settings/archived-items/metadata.md)。

## 5. Function Points

| Function ID | Surface | Required states | Target primitive | Status |
|---|---|---|---|---|
| `SETTINGS-ARCHIVE-NAV-001` | 四分类 Tabs 与记忆 | selected, counts, keyboard, persisted, long-label | `Tabs`, `Badge` | verified |
| `SETTINGS-ARCHIVE-LIST-001` | 搜索、单列表与滚动 | loading, loaded, empty, no-result, long, 55-row scrolling | `Input`, `IconButton`, `DataRow`, `Skeleton`, `EmptyState` | verified |
| `SETTINGS-ARCHIVE-CONV-001` | 会话 Restore / Delete | restoring, deleting, cancel, failed, success, active-work, automation blocker | `Button`, `IconButton`, `Dialog`, `InlineFeedback` | verified |
| `SETTINGS-ARCHIVE-TEAM-001` | 队友 Restore / Delete | restoring, deleting, cancel, failed, success, protected | `Button`, `IconButton`, `Dialog`, `InlineFeedback` | verified |
| `SETTINGS-ARCHIVE-CHANNEL-001` | 频道 Restore / Delete | restoring, deleting, cancel, failed, success | `Button`, `IconButton`, `Dialog`, `InlineFeedback` | verified |
| `SETTINGS-ARCHIVE-BRANCH-001` | 分支 Restore / Delete | restore, restore-both, deleting, cancel, failed, success | `Button`, `IconButton`, `Dialog`, `InlineFeedback` | verified |
| `SETTINGS-ARCHIVE-CONFIRM-001` | 类型化永久删除确认 | open, initial-focus, Esc, trigger-return, busy, failure, success-target-removed | `Dialog`, `InlineFeedback` | verified |

## 6. 页面结构

```text
SettingsShell
  ArchivedItemsPage
    Category Tabs + Search
    optional load/restore InlineFeedback
    one bounded active list
      Skeleton / EmptyState / DataRows
    one controlled Delete Dialog
```

页面不显示规则说明墙。删除后果只放在确认 Dialog；Restore/Delete 的结果可由对象消失和 count 更新直接表达。

## 7. Toolbar 与分类

- `SettingsSubnav` 继续提供 shared Tabs 语义，每个 Tab 显示计数，零值仍可选择。
- 搜索使用 shared `Input size=sm`、Search prefix 和条件式 Clear `IconButton`。
- Search shell 固定 32px；focus 不增加高度、不产生 native input 第二层 shadow。
- 搜索只匹配当前分类可见名称；Branch 同时匹配 parent channel 和 branch name。
- 切换分类清空查询但不移动 Toolbar；Reload 恢复最后分类，非法 storage value 回退 Conversations。

## 8. 列表与行

- 只存在一个 `role=tabpanel` 列表；`max-height: min(520px, calc(100vh - 310px))` 并独立纵向滚动。
- 初次加载使用 4 个稳定 Skeleton row；refresh 时保留最后权威数据，不闪回空态。
- true empty 与 no-result 使用 compact `EmptyState`，不显示说明卡。
- 行使用 compact `DataRow`：Identity、archived time、actions；长名称单行省略，完整值可通过 title/accessible name 读取。
- Restore 是可见文字次级 Button，因为它是该页的主任务；Delete 是 danger IconButton，带 Tooltip 和 ARIA。
- action 命中区至少 32px。只发起者显示 Spinner；串行 controller 可以暂时禁用其他 mutation action，但不得让其他行旋转。

## 9. 删除确认 Dialog

- 四类 Delete 共用一个 controlled shared Dialog；target view-model 提供 kind、id、display name 和后果文案。
- 标题必须命名对象；Conversation/Teammate 使用 P14 的删除/保留说明，Channel/Branch 保留真实不可恢复边界，
  不推测未由 API 保证的额外删除内容。
- 初始焦点在 Cancel；一次 Esc 或 Cancel 不发送请求并恢复真实 Delete trigger。
- deleting 时 Dialog 不能 Esc、outside 或 Close；只显示发起 action busy。
- delete failure 留 Dialog，target 和 trigger 均保留；成功在 API + authoritative refresh 后关闭。
- 成功后 trigger row 已卸载时不得聚焦 stale node；焦点回到当前 category Tab 或 Search fallback。

## 10. Feedback Ownership

- load failure：列表上方 section `InlineFeedback`，保留最后权威对象。
- restore failure：当前列表 `InlineFeedback`，内容命名失败对象并在重试/分类切换/刷新时清除。
- delete failure：确认 Dialog 内 `InlineFeedback`，不同时复制到页面顶部。
- restore/delete success：静默 authoritative refresh；row 消失和 count 更新已经给出充分结果，不新增 Toast。
- backend blocker 文案继续产品化映射；未知错误可在折叠 Error details 中显示，不吞掉原始错误。

## 11. Theme、尺寸、键盘与文案

- 验收：`1440x960`、`1280x800`；`ling-light`、`ling-dark`；中文、英文。
- 四 Tab、Search、DataRow 和 actions 在 1280 下不得换行或产生 document 横向滚动。
- Tabs 支持方向键；Search Escape 清空；Dialog Escape/focus return 遵守 shared contract。
- reduced motion 下 shared transition 为 0ms，列表/Dialog geometry 不变。
- 默认层不显示 raw id、retention tombstone、thread kind、automation id 或技术英文。

## 12. Module And CSS Ownership

```text
ArchivedSettingsPanel.tsx              composition/local view state, target <220
  ArchivedItemsToolbar.tsx             Tabs + Search, target <150
  ArchivedItemList.tsx                 Skeleton/Empty/DataRow, target <240
  ArchivedDeleteDialog.tsx             controlled confirmation, target <180
  archived-items-view-models.ts         category/filter/target projections, target <220
useArchivedSettingsController.ts        API load/mutations/scoped errors, target <320
styles/settings-archived-items.css      domain layout only, target <360
```

- Feature imports primitives only through `apps/web/src/shared/ui`。
- Controller 不持有 DOM ref；Panel/Toolbar/Dialog 的展示层持有 trigger/fallback focus ref。
- 旧 Archived selector 从 `settings.css` 同步删除，不复制 shared control/Dialog/DataRow visuals。
- 新 CSS 不允许颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 或
  package-private `.ling-ui-*` selector。

## 13. E2E And Evidence

新增 `ui2-settings-archived-items.spec.ts`，既有 `settings.spec.ts` 与 `channel-archive.spec.ts` 只更新共享
Dialog/primitive 的旧断言，不继续塞入新视觉场景。

最低覆盖：

1. loading、empty、no-result、last-data-on-refresh-failure、55-row internal scroll；
2. 四 Tabs counts、keyboard、category persistence、search clear/category switch；
3. 四类 Restore、Branch Restore both、action-scoped busy 和 failure；
4. 四类 Delete open/cancel/Esc/busy/failure/success、trigger/fallback focus；
5. Conversation automation/active blocker、protected teammate 和 unknown error details；
6. zh-CN/en-US、Light/Dark、normal/reduced motion、long names、console 和 overflow。

目标证据：

- `1440x960-ling-light-conversations-loaded.png`
- `1440x960-ling-light-conversation-delete.png`
- `1280x800-ling-dark-teammate-delete-failure-zh-CN.png`
- `1280x800-ling-dark-branch-restore-both.png`
- `1280x800-ling-dark-no-result.png`
- `1280x800-ling-dark-dense-scroll.png`

## 14. Non-Goals And Stops

- 不改 daemon/API/contracts/database、retention、restore/delete semantics、Settings IA 或 Sidebar archive。
- 不新增 All、bulk action、cross-category search、规则说明卡、Refresh 按钮或移动布局。
- 如果 UI 正确性要求删除历史 runs、绕过保护、改变 Branch Restore both 或新增后端状态，立即停止并向用户提交独立方案。
- 不修改 Logo。
