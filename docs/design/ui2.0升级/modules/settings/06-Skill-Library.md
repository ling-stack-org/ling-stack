# Skill Library

> P7B.2 design contract. Current status: seven reachable Function IDs `verified`; official source updates remain `inventory`.

## 1. 页面目标

Settings > 技能库是 workspace 级技能管理工作台。用户在同一 surface 中完成：

- 查看、搜索和筛选自己、AI 生成以及内置技能；
- 导入技能，或用结构化编辑器创建、修订技能；
- 审核 AI 发现的技能、重复方法和频道流程；
- 查看技能要求、审批策略、队友绑定、来源快照和优化预览；
- 归档或永久删除允许删除的技能。

它不是技能市场、营销页或 raw SKILL.md 编辑器。默认层只显示对象身份、简短用途、绑定、状态和主行动。

## 2. 入口、Shell 与真实 IA

- 入口：Settings > 工作区 > 技能库。
- Shell owner：`SettingsShell`，页面不重复 Settings 标题或返回按钮。
- 当前生产一级导航固定为：`My skills / AI evolution / Built-in skills`。
- AI evolution 的真实二级视图为：`Needs review / Generated / Ignored`。
- Import、Editor、Inspector、来源快照、审核详情均是上述入口下的可达状态，不新增路由或 `ViewId`。
- 页面与 Electron Desktop renderer 共用 Web 实现；移动端不在本轮范围。

设计早期使用过 `Skills / Review Queue / Source Sync` 的抽象说法。P7B.2 以当前生产 IA 为准，不直接把这些
词改成新的顶层 Tab。`Review Queue` 映射到 AI evolution；每个技能的 source snapshot/history 映射到 Inspector。

## 3. 官方来源更新决策门禁

当前 API 已支持官方技能来源的 check/preview/apply，但当前生产 UI 没有入口，现有 E2E 还明确断言
`Official skill updates` 不可见。因此 `SETTINGS-SKILL-SYNC-001` 暂不被伪造为已完成：

- 方案 A：保持当前 IA，官方来源更新继续 `inventory`；本轮只迁移可达的 snapshot/history/rollback。
- 方案 B：增加“来源更新”入口并接入现有 API；这属于 IA 扩展，必须得到用户明确确认。

其余 P7B.2 surface 不依赖该决定，可以先实施并验证。

## 4. 当前代码与问题

| Owner | Current baseline | UI 2.0 issue |
|---|---:|---|
| `SkillLibrarySettingsPanel.tsx` | 604 lines | load、mutation、feedback、overlay 和 composition 混合 |
| `SkillEditorDialog.tsx` | 549 lines | 手写 Dialog、raw controls、advanced、authority 和 discard 混合 |
| `SkillReviewQueuePanels.tsx` | 543 lines | list projection、filters 和三类 cards 混合 |
| `SkillLibraryWidgets.tsx` | 432 lines | 可达 Inspector 与未接线 health/sync widgets 混合 |
| `skill-library-utils.ts` | 426 lines | 多个 domain projection family 聚合 |
| `settings.css` | 2,521 lines | 约 1,400 行 Skill selector 混在聚合 Settings owner |
| `settings-skill-editor.css` | 351 lines | 重建 Dialog chrome 和 control visuals |
| `settings-interactions.css` | 220 lines | Skill 与 Diagnostics selector 交叉 |

当前页面已有较好的 ownership、搜索、排序、内联编辑和冲突行为，但仍使用手写 button/input/details/Dialog、
常驻成功 tip、browser confirm、跨领域 RightDrawer 和大量 legacy CSS。

## 5. Function Points

| Function ID | 当前真实入口 | Required states | Target primitive | Current status |
|---|---|---|---|---|
| `SETTINGS-SKILL-NAV-001` | My / Evolution / Built-in；Evolution 三视图 | selected, counts, keyboard, long label | `Tabs`, `Select` | verified |
| `SETTINGS-SKILL-LIST-001` | 三类列表、搜索、排序、绑定筛选 | loading, empty, no-result, loaded, long, selected, scrolling | `Input`, `Select`, `Table`, `Skeleton`, `EmptyState` | verified |
| `SETTINGS-SKILL-INSPECT-001` | 右侧技能 Inspector | closed, open, read-only, source-backed, metadata-only, loading, error, long | `IconButton`, `InspectorSection`, `StatusIndicator`, `Badge`, `InlineFeedback` | verified |
| `SETTINGS-SKILL-IMPORT-001` | Import skill Dialog | open, reading, invalid-file, blocked-preview, publishing, failed, success | `Dialog`, `Field`, `Button`, `InlineFeedback` | verified |
| `SETTINGS-SKILL-EDITOR-001` | Create / candidate / revision Dialog | clean, dirty, discard, checking, authority-change, conflict, reload, saving, failed, success | `Dialog`, `Field`, `Input`, `Textarea`, `Select`, `SegmentedControl`, `InspectorSection` | verified |
| `SETTINGS-SKILL-REVIEW-001` | AI evolution queue | pending, generated, ignored, filter, search, empty, action-busy, failed | `Tabs`, `Input`, `Select`, `DataRow`, `InspectorSection`, `Button` | verified |
| `SETTINGS-SKILL-SYNC-001` | official source update | currently unreachable; A/B decision pending | no primitive until decision | inventory |
| `SETTINGS-SKILL-ARCHIVE-001` | row archive、hard delete | archiving, confirm, cancel, deleting, failed, success, protected | `IconButton`, `Dialog`, `InlineFeedback` | verified |

## 6. 页面结构

```text
SettingsShell
  SkillLibraryPage
    SettingsSubnav
      My skills
      AI evolution
      Built-in skills
    scoped load/action feedback
    current view
      Toolbar
        Search
        View-specific filter/sort
        Import / Create when applicable
      loading / compact empty / bounded list
      optional inline Inspector
    Import Dialog
    Editor Dialog
    Delete confirmation Dialog
```

页面只有 Settings content scroll owner；长技能列表、Inspector body 和 Dialog body 各自有明确内部滚动边界。

## 7. My Skills 与 Built-in

### My Skills

- 默认显示用户创建、导入或 workspace-owned 的 active/draft 技能；归档对象不留在默认列表。
- 搜索匹配名称、summary 和必要 tool token；排序只提供 Updated / Name。
- 每行显示名称、summary、绑定队友、更新时间、唯一状态和可用操作。
- Import 与 Create 是工具栏主任务；没有技能时进入紧凑 EmptyState，并保留这两个行动。
- 自定义、skill-directory、agents-md 来源允许永久删除；其他来源只显示真实允许的 archive/edit。

### Built-in

- 内置技能只读，不出现 Import、Create、Archive、Delete 或 Edit。
- 允许按绑定状态筛选，并在 Inspector 查看队友绑定和 policy。
- 内置来源的 raw source、checksum 和技术 metadata 默认折叠。

## 8. AI Evolution

- `Needs review` 汇总待处理 Skill Candidate、Procedure Cluster 和 Channel Playbook。
- `Generated` 显示已发布 AI 技能和 active channel flows。
- `Ignored` 保留被拒绝、blocked、routed elsewhere、cancelled 和 stale 历史。
- 搜索、排序和类型筛选不改变当前二级视图。
- 每个对象只有一个主状态和一个真实主行动；raw id、source refs、gate labels、route blockers 和 procedure
  steps 进入 Details。
- Adopt 打开结构化 Editor；Ignore/Enable/Create protocol/playbook 保留现有 API 与状态转换。
- action failure 留在 queue owner；轻量成功使用 Toast 并刷新权威列表。

## 9. Inspector

- Inspector 是页面内右侧 panel，不是 modal Drawer；默认不打开，不遮住完整列表。
- Header 显示技能身份和 Close IconButton，Esc 只关闭 Inspector 并恢复当前行焦点。
- 默认摘要只显示 summary、唯一状态、来源、required tool 数和绑定数。
- `Requirements and policy`、`Prompt fragments`、`Source and raw details` 使用共享 `InspectorSection`。
- source snapshot id、checksum、path、raw Markdown、warnings、artifacts 和 optimization risk 默认折叠。
- source artifact load/preview/rollback/archive failure 留在 Inspector；read-only 内置技能不显示 mutation。

## 10. Import Dialog

- 使用共享 `Dialog`，初始焦点在文件选择；Close/Cancel 恢复 Import trigger。
- 默认只显示一个文件选择器，支持 Markdown、JSON 和 text。
- reading/publishing 期间禁止 Esc、outside click 和 Close。
- invalid extension、blocking warning、preview/publish failure 留在 Dialog，不创建 draft 或清空用户选择。
- 成功只在 publish 和权威 refresh 完成后关闭，并显示 3000ms shared Toast。

## 11. Structured Editor

- Create、candidate adoption 和 revision 复用同一 Dialog shell。
- 默认层：Name、Description、Execution instructions。
- Advanced configuration 默认折叠：required tools、provider capabilities、approval policy。
- 字段使用 `Field + Input/Textarea/Select`；instruction order/remove 使用 `IconButton`。
- Authority diff 必须要求显式 Confirm and save；现有 bindings 不被 UI 改写。
- Revision conflict 保留用户 draft，允许 Reload latest version；未保存关闭显示 inline discard decision。
- checking/saving 期间不可关闭；error/authority/discard 不得同时叠成多块互相遮挡的反馈。

## 12. Archive 与永久删除

- Archive 保持非破坏性，成功后对象从当前列表移除并 Toast。
- Hard delete 使用共享确认 Dialog，不再调用 `window.confirm`。
- 确认文案保留“先解除 teammate bindings 和 active work references”的真实约束。
- 初始焦点在 Cancel；一次 Esc 关闭且不发送请求；deleting 期间不可关闭。
- 失败留 Dialog，成功只在 API 返回和权威 refresh 后关闭。

## 13. Feedback

- initial/load failure：section `InlineFeedback`，保留最后权威数据。
- import/editor/delete failure：留所属 Dialog。
- review failure：留 AI evolution queue。
- source failure：留 Inspector source section。
- archive/list mutation failure：留当前 registry section。
- success：shared Toast，scope 为 `skill:<id>:<action>`；3000ms 自动消失。
- 删除 `.settings-inline-tip/.settings-inline-success`，不保留页面常驻绿色消息。

## 14. 主题、尺寸、键盘与文案

- 验收 viewport：`1440x960`、`1280x800`；`ling-light`、`ling-dark`。
- 搜索、Select、buttons 保持 32px 稳定高度；IconButton hit area 不小于 32px。
- 1280 宽度下列表/Inspector 不产生 document 横向滚动；长名称、summary、tool、path 和 checksum 可截断，
  Inspector 中可完整阅读。
- Tabs、Select、Dialog、InspectorSection、Menu 由 shared/Radix 合同提供 keyboard、Esc、focus return。
- reduced motion 下 transition 为 0ms，state 与 geometry 不变。
- 中英文不得混排；默认层不显示 raw provider/technical English。

## 15. CSS 与模块所有权

- `SkillLibrarySettingsPanel.tsx` 只保留 composition。
- load/data state 进入 focused data controller；mutation/feedback/delete ownership 进入 focused action controller。
- Editor 拆为 shell、basic/instruction、advanced/authority 小组件；Review queue 拆 projection 与 cards。
- Settings 不再依赖 conversation `RightDrawer`；技能 Inspector 使用本领域 inline panel。
- focused owner 为 `styles/settings-skill-library/`；每个 CSS 文件不超过 400 行。
- `settings.css`、`settings-interactions.css`、`settings-skill-editor.css` 的 Skill selector 同切片迁出并删除。
- shared control/Dialog/Table/Inspector visual 不在 Feature CSS 重建。
- Feature 不直接 import Radix 或 `@ling-stack/ui-react`，统一通过 `apps/web/src/shared/ui`。

## 16. 验收

- focused E2E 覆盖所有当前可达 Function ID 和 changed states。
- 现有 `skill-library-ownership.spec.ts` 与 `skill-import-productization.spec.ts` 行为不得回退。
- 真实 Vite 证据覆盖两个 viewport、Light/Dark、列表、Inspector、Editor、Import、Review 和 Delete failure。
- 检查 console、document overflow、内部滚动、focus restore、Esc、busy dismissal、rapid switch 和 reduced motion。
- 证据、SHA-256 和已知限制写入 `evidence/settings/skill-library/metadata.md`。

## 17. 非目标

- 不改 daemon/API/contracts/database、Skill authority、review/publish 状态机或 delete semantics。
- 不改 Settings IA、路由、`ViewId`、`SettingsSectionId` 或 AI teammate skill binding surface。
- 未得到用户确认前，不新增 Official Source Updates 顶层入口。
- 不修改 Logo。

## 18. P7B.2 Closeout

- 604 行聚合 Panel 已拆为 172 行 composition、208 行 data controller 和 322 行 action controller；
  source Inspector、Review Queue/cards/model、Toolbar、Table、Dialog 和 editor fields 均为 focused owner，
  本切片触达的 production owner 全部低于 400 行。
- 旧 `SkillLibraryWidgets.tsx`、`SkillReviewQueuePanels.tsx`、`settings-skill-editor.css` 和无 owner Skill
  selector 已删除；focused Skill CSS 共 975 行、六个文件，每个低于 400 行且没有颜色字面量、`!important`、
  Theme/Profile selector、`transition: all`、private keyframe 或 package-private selector。
- 搜索 native input 被约束在 32px shared shell 内；55 行列表使用内部纵向滚动且无水平溢出；删除失败后
  Esc 恢复真实触发 IconButton，成功删除不聚焦已卸载节点。
- 验证：shared package `41/41`、focused `4/4`、existing Skill `7/7`、selected Settings/Dark/shared controls
  `27/27`，Web typecheck、i18n、lint 和 diff check 通过。
- 六张 `1440x960 ling-light` / `1280x800 ling-dark` changed-state 截图已原尺寸检查，证据和限制见
  [`evidence/settings/skill-library/metadata.md`](../../evidence/settings/skill-library/metadata.md)。
- `SETTINGS-SKILL-SYNC-001` 不随本切片关闭；现有 API 没有生产入口，继续等待 A/B 产品决定。
