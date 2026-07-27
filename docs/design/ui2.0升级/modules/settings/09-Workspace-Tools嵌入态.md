# Workspace Tools 嵌入态

> P7B.5 design contract. Current status: `verified` on 2026-07-20. 现有 API、Settings IA、domain page 和显式离开动作足够；
> 共享嵌入边界、滚动/overlay/return 合同、死代码清理和真实浏览器证据已闭环。

## 1. 页面目标

Settings 中的 Model Workbench、Teammate Management 和 Council Workspace 是三个真实业务工具，不是入口卡片、
快捷方式墙或业务页面复制品。用户在 Settings 内应当能够：

- 查看和配置模型、队友与 Council；
- 在三个工具之间切换，同时保留 Settings 左侧导航和唯一 active section；
- 打开编辑/创建 Dialog，关闭后回到原工具和原触发点；
- 只有点击明确写着 Open chat/channel/run in app 或 Back to app 的动作时离开 Settings；
- 在 `1440x960`、`1280x800`、Light/Dark 下保持一个内容边界、一个滚动体系和一个 overlay root。

本切片不重新设计三个业务模块的表格、行、Tabs、创建流程或状态优先级；它只升级 Settings 与业务工具之间
的共享展示边界。Model、Teammate、Council 的完整 UI 迁移仍分别属于 P9/P8。

## 2. 入口、Shell 与真实 IA

- 入口：Settings > Workspace tools > Model Workbench / Teammate Management / Council Workspace。
- Shell owner：`SettingsShell`。Settings navigation 始终可见；主应用 `Ling Stack navigation` 必须 absent。
- 内容 owner：`SettingsWorkspaceToolSurface`。它只接收 `view` 和 `children`，不 import provider、teammate、
  council、API、domain、route 或 i18n。
- 业务 owner：现有 `ProviderSettings`、`AiTeammatesPage`、`CouncilWorkspacePage`，继续由 AppShell 传入真实数据
  和 callback；Settings 不复制 domain state。
- active section 由 `workspaceToolViewToSectionId` 派生；工具内部 list/detail/tab 选择不改变 Settings section。
- Back to app 使用 P7A.1 已验证的 exact return target；不建立工具自己的通用返回栏。
- Desktop 主窗口复用同一 Web surface；移动端不在本轮范围。

## 3. 已确认的当前实现

| Owner | Current | Fact / debt |
|---|---:|---|
| `SettingsPage.tsx` | 362 lines | 只在有效 view/detail 同时存在时接入稳定 shared surface，仍低于 400 行 |
| `SettingsWorkspaceToolSurface.tsx` | 24 lines | 纯展示 boundary；不 import domain/API/route/i18n |
| `ProviderSettings.tsx` | 705 lines | `settingsToolMode` 已隐藏 H1/说明，保留真实 toolbar/list/editor |
| `AiTeammatesPage.tsx` | 648 lines | `settingsToolMode` 已隐藏独立 H1；Role detail 使用共享 Dialog，Open teammate chat 显式命名 |
| `CouncilWorkspacePage.tsx` | 584 lines | `settingsToolMode` 已隐藏独立 H1；内部 Manage teammates 与 Open channel 语义已分离 |
| `CouncilWorkspacePanels.tsx` | 698 lines | 当前仍低于 800 行；业务 Tabs/成员/频道/设置留 P8 |
| `SettingsWorkspaceToolsPanel.tsx` | deleted | 无生产 import 的旧快捷方式页已删除，没有第四个入口 |
| `settings.css` | 436 lines | 约 226 行死 workspace-tool selector 已净删除；focused boundary 为 27 行 |
| Feature CSS | Provider 2,354 + Model 617；Teammates 4,735；Councils 859 | 完整视觉清理留 P8/P9；P7B.5 只修 right-sheet containment 和长列表 header overlap |

现有 `openSettingsWorkspaceTool` 已复用各 domain refresh；`returnFromSettingsView` 已保存精确应用状态；三类页面
已有 Settings 模式。正确实现不需要新增 API、route、`ViewId`、Settings section、持久化或状态机。

## 4. Function Points

| Function ID | Surface | Required states | Target owner | Status |
|---|---|---|---|---|
| `SETTINGS-EMBED-MODEL-001` | Model Workbench embedded | loading, empty, loaded, search/filter, editor-open, error, long | `SettingsWorkspaceToolSurface` + existing Provider owners | verified |
| `SETTINGS-EMBED-TEAM-001` | Teammate Management embedded | loading, empty, loaded, create-open, role-detail, internal-switch, open-chat | shared surface + existing Teammate owners | verified |
| `SETTINGS-EMBED-COUNCIL-001` | Council Workspace embedded | loading, empty, loaded, tabs, create-open, member/channel error, internal-switch, open-channel | shared surface + existing Council owners | verified |
| `SETTINGS-OPEN-APP-001` | explicit exit from an embedded tool | back, open-chat, open-channel, open-run, focus/return | existing AppShell adapters | verified |
| `SETTINGS-BOUNDARY-001` | Settings Shell dependency | internal, explicit-external, exact-return | `SettingsShell` / AppShell | verified in P7A.1; dependency only |

四个 P7B.5 ID 已完成代码、联合回归和六张实页证据并进入 `verified`。`SETTINGS-BOUNDARY-001` 不重复计数，
也不因本切片重新打开。证据见 [`evidence/settings/workspace-tools-embedded/metadata.md`](../../evidence/settings/workspace-tools-embedded/metadata.md)。

## 5. 页面结构

```text
SettingsShell
  Settings navigation
    Back to app
    Model Workbench (active when providers)
    Teammate Management (active when teammates)
    Council Workspace (active when councils)
  Settings content [state=workspace-tool]
    SettingsWorkspaceToolSurface [view=model|teammates|councils]
      existing domain page [settingsToolMode]
        toolbar/list/detail
        optional shared Dialog/Popover/Menu through app overlay root
```

禁止重新加入：

- Configuration shortcuts 卡片页；
- `.settings-tool-return-row`；
- 嵌入页 H1/大段说明；
- 第二套 Settings navigation、page header、error store 或 fetch controller。

## 6. Shared Surface Contract

`SettingsWorkspaceToolSurface`：

- props 只有 `view: providers | teammates | councils`、`label`、`children`；label 由 Settings adapter 翻译后传入；
- 输出稳定 `data-ui2-settings-workspace-tool` 和 `data-settings-workspace-tool=<view>`；
- 默认使用普通 `div`，避免在已有业务 `section/aria-label` 外再造重复 region；
- `display:grid; min-width/min-height:0; height:100%; overflow:hidden`；不拥有颜色、按钮、表格或 Dialog visuals；
- 直接 child 必须占满可用边界并保留自身 domain scroll；wrapper 不读取或改变业务状态；
- 不使用 `cloneElement`、DOM query、portal relocation 或 child class 推断 view。

`SettingsPage`：

- workspace tool 打开时 content class 固定包含 `settings-content-stack--workspace-tool`；
- 只有 `workspaceToolView` 与 detail 同时存在时渲染 shared surface；未知/空 view 不伪造工具；
- section click 先关闭 Run Diagnostics，再按真实 tool adapter 切换；普通 section 关闭当前 tool；
- 不增加 Model/Teammate/Council props，不把 AppShell callback 复制到 Settings component。

## 7. Model Workbench Embedded Rules

- 默认层保留现有 readiness summary、Search、filter、Add model、Check all、Refresh 和四列表格。
- Settings mode 不显示独立 H1、营销说明、Provider workbench meta 或内部返回栏。
- Add/Edit 使用现有 Provider editor overlay；Esc/outside/focus/busy 继续由当前 shared overlay contract 管理。
- Open failed run 使用现有 Settings Run Diagnostics adapter，属于 Settings 内部切换；不伪造成主应用离开。
- loading、empty、no-result、error 均留 Provider owner；Settings wrapper 不重复显示 EmptyState/InlineFeedback。
- P7B.5 不迁 Provider row/menu/button visuals，P9 负责完整 Model Workbench UI 2.0。

## 8. Teammate Management Embedded Rules

- 默认层保留 Workspace teammates、Default roles、真实创建入口和 Council 内部入口。
- Settings mode 不显示独立 `AI Teammates` H1、说明或内部返回栏。
- Open Council Workspace 与 Configure model 是 Settings 内部切换，必须只改变 active section，不出现主导航。
- Open teammate chat 是显式离开动作；按钮的可访问名称/title 必须包含 `Open chat in app` 语义。
- Create/Role detail 使用现有 Dialog；Esc/Cancel 关闭后回到原触发点，active section 仍是 Teammate Management。
- skill pack 缺失、无模板、无队友、model unavailable 和 create failure 都由 Teammate owner显示；shared wrapper
  仍必须存在，避免空态脱离 Settings geometry。
- P7B.5 不迁手写 row menu、创建流程或管理视觉，P8 负责完整 Teammate Management UI 2.0。

## 9. Council Workspace Embedded Rules

- 默认层保留 compact summary、Council list、selected detail、Members/Channels/Settings Tabs、Create 和 Refresh。
- Settings mode 不显示独立 H1、说明或内部通用返回栏。
- Manage teammates 是 Settings 内部切换；Open channel 是显式离开动作，并恢复真实 Channel selection。
- Create Dialog、member/channel mutations、loading/error 保持 Council owner；切换 Tab 不改变 Settings active section。
- no councils、health filter no-result、members/channel error 和 long names 均必须在 wrapper 内可滚动、无横向溢出。
- P7B.5 不迁 Council row/buttons/Tabs 或业务状态，P8 负责完整 Council UI 2.0。

## 10. Navigation And Return Rules

| Trigger | Result | Settings remains? | Return/active rule |
|---|---|---:|---|
| Settings nav: another workspace tool | switch existing child | yes | one matching `aria-current=page` |
| Configure model from Teammates | Model Workbench | yes | Model active; no app nav |
| Manage teammates from Council | Teammate Management | yes | Teammate active; no app nav |
| Open Run Diagnostics from Model repair | Run Diagnostics | yes | Startup and diagnostics active |
| Open teammate chat | real teammate conversation | no | main navigation returns; selected teammate preserved |
| Open channel | real channel workspace | no | selected channel preserved |
| Back to app | exact pre-Settings target | no | P7A.1 return target contract |

工具内部切换不得覆盖原 Settings return target。只有首次从应用进入 Settings 时记录 target；返回后清空。

## 11. Scroll, Overflow And Resize

- Settings navigation 是一个纵向 scroll owner；workspace-tool content boundary 本身 `overflow:hidden`。
- shared surface 占满 Settings content；Provider table、Teammate lists、Council list/detail 使用现有 domain scroll。
- 禁止 document 横向/纵向滚动；禁止 Settings content 与 child 同时出现两个可见纵向 scrollbar。
- `1440x960` 与 `1280x800` 为完成门槛；`980x680` 做 containment 回归，但不是移动端重排设计。
- 长 model ID、teammate name、Council name、provider error 和中英文 action 不得顶出 content 或挤成竖排。
- overlay 打开时 background surface 不改变宽度；关闭后原列表滚动位置和 active section 保留。

## 12. Overlay, Focus And Accessibility

- Web root 继续只有一个 app-owned Portal root、Tooltip Provider 和 Toast viewport。
- 三个工具不得在 Settings wrapper 内建立第二个 overlay root；Dialog/Popover/Menu 使用现有 shared owner。
- Dialog Esc 只关闭最上层 overlay，焦点返回真实 trigger；busy destructive action 遵守既有不可关闭合同。
- Settings nav 用 Button/`aria-current`；embedded root 有稳定 data owner，业务 section 保留自己的 label。
- icon-only action 至少 32px，必须有 `aria-label`、title/Tooltip；P7B.5 不新增图标映射。
- zh-CN/en-US、keyboard、focus、reduced motion 和 high-contrast 风险按共享 contract 回归。

## 13. Theme And CSS Ownership

```text
styles/settings-shell.css                    Settings navigation/content shell
styles/settings-workspace-tools.css          embedded boundary geometry only, target <= 140
styles/model-workbench.css/providers.css      Model domain visuals, P9 owner
styles/teammates.css                          Teammate management visuals, P8 owner
styles/councils.css                           Council visuals, P8 owner
```

- 新 focused CSS 只允许 semantic tokens，且目标可以做到颜色声明为 0；不命中 package-private `.ling-ui-*`。
- 删除无引用 `SettingsWorkspaceToolsPanel.tsx` 和 `.settings-workspace-tools/.settings-configuration-*` /
  `.settings-tool-row-*` selector family；不保留 compatibility。
- `settings.css` 只减不增；feature CSS 不因本切片新增 selector。
- 不用 Settings wrapper 修补 Model/Teammate/Council 的具体按钮、卡片和状态色；完整主题迁移留对应业务切片。
- Light/Dark evidence 必须证明边界没有硬编码浅色兜底；不以 strict-console 遮盖的视觉假通过替代后续业务迁移。

## 14. Module Boundaries

```text
SettingsPage.tsx                            composition/adapters, keep <400
  SettingsWorkspaceToolSurface.tsx          pure presentation, target <100
  settings-shell-model.ts                   stable view -> section mapping

AppShell.tsx                                existing domain data/callback wiring only
ProviderSettings / AiTeammatesPage /
CouncilWorkspacePage                       existing business owners; no new Settings state
```

AppShell 已超过 3,000 行，本切片禁止追加业务逻辑；只允许复用现有 callback。任何需要新增 route、domain fetch、
cross-tool persistence 或业务 state 的发现都必须停止并向用户提交方案。

## 15. E2E And Evidence

新增 `ui2-settings-workspace-tools.spec.ts`，最低覆盖：

1. 三个 Settings entry、唯一 active、主导航 absent、shared surface/view attribute 和工具间切换；
2. Model loading/empty/loaded/search/filter/editor-open/error、无 H1/返回栏、overlay Esc/focus；
3. Teammate empty/loaded/create/role detail、Configure model/Council 内部切换、Open chat 显式离开；
4. Council loading/empty/loaded/Tabs/create/member-channel failure、Manage teammates 内部切换、Open channel 离开；
5. Back exact return、overlay root count、Settings/child scroll owner、1440/1280/980 containment；
6. Light/Dark、zh-CN/en-US、long content、reduced motion、console 和 document overflow。

目标证据：

- `1440x960-ling-light-model-loaded.png`
- `1280x800-ling-dark-model-editor.png`
- `1440x960-ling-light-teammates-loaded.png`
- `1280x800-ling-dark-teammate-create.png`
- `1440x960-ling-light-council-loaded.png`
- `1280x800-ling-dark-council-create.png`

联合回归：`settings.spec.ts`、`model-workbench.spec.ts`、`model-workbench-productization.spec.ts`、
`teammates.spec.ts`、`councils.spec.ts`、`app.spec.ts`、`dark-mode.spec.ts` 和 `ui2-settings-shell.spec.ts`。

## 16. Non-Goals And Stops

- 不改 daemon/API/contracts/database、route、`ViewId`、Settings IA、权限、模型/队友/Council 状态机。
- 不新增第四个 Workspace Tools overview，不把 Work Board/Plugin Manager 放回 Settings。
- 不重做 Model row/editor、Teammate create/menu、Council Tabs/member/channel/settings 业务 UI。
- 不修改 Logo，不引入 Tailwind，不增加 Feature Radix import。
- 若发现显式 Open chat/channel 无法恢复真实应用目标、overlay 必须跨新安全边界、或正确滚动需要业务页面
  状态重构，立即停止并向用户列出代码证据、选项和推荐方案。

## 17. Verified Closeout

- Shared package `41/41`；selected browser regression `88/88`；final focused evidence run `7/7`。
- Web typecheck、i18n、lint 与 `git diff --check` 通过。
- 六张 `1440x960 ling-light` / `1280x800 ling-dark` 图片已原尺寸检查并记录 SHA-256。
- Provider editor 的旧 slide transform 与 shared Dialog positioning 冲突、长列表 header flex shrink 两项均已修复并锁入断言。
- P7B.5 只关闭 Settings embedded boundary；完整 Model/Teammate/Council 业务视觉仍分别归 P9/P8。
