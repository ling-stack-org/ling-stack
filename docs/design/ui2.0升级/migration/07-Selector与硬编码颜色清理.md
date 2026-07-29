# Selector 与硬编码颜色清理

## Baseline Metrics

| Metric | Current |
|---|---:|
| CSS lines | 49,205 |
| CSS files | 42 |
| class selector occurrences | 14,016 |
| unique class-like selectors | 2,898 |
| color literal occurrences | 1,929 |
| `!important` occurrences | 18 |

数值是迁移健康指标，不替代视觉验收。禁止通过压缩文件、合并一行或删除必要状态来达标。

## Selector Families

| Family | Examples | Target | Deadline |
|---|---|---|---|
| Buttons | primary/secondary/compact/icon | ui Button/IconButton | U3 |
| Forms | raw input/select/field grids | ui Field controls | U3 |
| Legacy input focus leakage | aggregate `input/textarea:not([data-ling-control-native])` | ui Input outer `focus-within` + explicit native owner | T12.1d verified; aggregate exact branches `0` |
| Dialog/Drawer | create-dialog, sheet, modal | ui Dialog/Drawer | U2-U8 |
| Menu/Popover | row-menu, action-menu, tooltip | ui Menu/Popover/Tooltip | U2-U10 |
| Status | badge, pill, health, inline-error | ui Status/Feedback | U3-U12 |
| Loading/Empty | spinner, loading row, empty card | ui Spinner/Skeleton/EmptyState | U3-U12 |
| Data rows | ad-hoc list/table rows | ui DataRow/Table | U4-U12 |
| Inspector | details cards/disclosures | ui InspectorSection | U5-U12 |
| Conversation | feed/composer/dock/terminal | conversation package | U5-U6 |
| Theme overrides | `[data-theme]` / specific Theme Pack component selectors | Theme Pack semantic tokens only | U1-U13 |
| Strict console | global restyling overrides | tokens/focused feature CSS | U13 |

## Line Budgets

| Milestone | Maximum total CSS lines | Intent |
|---|---:|---|
| U0 baseline | 49,205 | current state |
| U1 package dual-run | 52,500 | temporary package addition cap |
| U2 overlays | 50,000 | remove duplicate overlay CSS |
| U3 controls/forms | 47,000 | remove legacy controls |
| U4 shell/sidebar | 43,000 | split global layout |
| U5-U6 conversations | 38,000 | remove channel/chat duplication |
| U7-U8 Settings | 34,000 | split Settings wall |
| U9-U10 management | 32,000 | list/detail consistency |
| U11-U12 work/media | 31,000 | final feature migration |
| U13 cleanup | 30,000 | final first-party target |

最终旧文件 `components.css`、`teammates.css`、`settings.css`、`providers.css`、`layout.css`、
`sidebar.css`、`strict-console.css` 必须删除，而不是仅降到预算内。任何新的单文件不得超过
800 行。

## Color Budget

| Milestone | Maximum color literals |
|---|---:|
| U0 | 1,929 |
| U3 | 1,200 |
| U6 | 700 |
| U8 | 350 |
| U10 | 180 |
| U13 | 120 |

U13 时所有允许的颜色字面量必须集中在 built-in Theme Pack manifest/token source
或有明确注释的第三方内容边界；Feature CSS 中颜色字面量目标为 `0`。
Logo、PNG/WebP 像素颜色不计入 CSS 指标。

## Specificity And Important

- 第一方生产 CSS 的 `!important` 最终目标为 `0`；第三方 override 若无法避免，最多 2 处并
  在本文件登记。
- 禁止超过三级 class descendant selector。
- 禁止通过重复父选择器提高 specificity。
- 禁止 Feature 命中 `.ling-ui-*` 内部节点。
- 状态通过 `data-variant/data-size/data-tone/data-state`，不拼接多层视觉 class。
- Feature CSS 中 `[data-theme]`、`[data-ui-theme]`、具体 Theme Pack ID 和主题专用 selector 目标为 `0`。
- 需要外观差异时新增 semantic token，不通过 specificity 或加载顺序修补。

## Compatibility Lifetime

Legacy class 只能存在于迁移 wrapper，并必须登记 removal slice。超过两个切片仍未删除即标记
`blocked`，不得继续让新页面使用。

## PR Report

每个 UI PR 必须报告：迁移 family、CSS 前后行数、color literal 变化、删除 selectors、保留
compatibility、涉及 Theme Pack/semantic tokens、`ling-light` / `ling-dark` E2E 和截图路径。

## P4.1 Progress

- 删除 `.sidebar-hover-tooltip` 及手写 fixed-position/颜色/阴影 selector；
- Sidebar section menu 不再使用 `.sidebar-section-menu-popover` 作为运行时 owner，新实现使用
  package `.ling-ui-menu-*` 与 focused 内容 class；旧 CSS selector 尚待引用清零后删除；
- full-access Dialog 不再复用 `provider-sheet-*` JSX，旧 provider selector 仍由模型工作台拥有；
- 新 focused CSS 只使用 semantic token，没有新增颜色字面量或 `!important`。

## P4.2 Progress

- 三类 Sidebar 对象行收敛到 `SidebarObjectRow`，共享 Button slot 使用公开 data attribute 和
  CSS variables；
- Feature CSS 对 `.ling-ui-button-leading/label/trailing` 的 selector 为 `0`；
- `sidebar.css` 删除 3 条迁移后无所有者的宽泛 span display selector；
- `sidebar-ui2.css` 没有新增颜色字面量、`!important` 或 Theme Pack ID selector；
- 旧 `.sidebar-row-shell/.sidebar-row-main/.sidebar-row-tools` 暂保留为布局/E2E compatibility，
  removal slice 为 U4 disclosure/status 完成后的 Sidebar CSS 拆分。

## P4.3 Progress

- section header/disclosure 状态迁入 `SidebarSection`、shared Collapsible 和 focused CSS；
- loading/stale/unread/count 分别由 Spinner/Skeleton、StatusIndicator 和 Badge 表达；
- 删除旧 unread/mention 硬编码绿色，以及 rail unstack/restack/item keyframes 和对应引用；
- 新 package/Web focused CSS 没有新增颜色字面量、`!important` 或 Theme Pack ID selector；
- P4.4 将状态列迁入 focused `app/sidebar-ui2.css`，未新增颜色字面量、`!important` 或 Theme Pack ID selector；
- `.sidebar-row-shell/.sidebar-row-main/.sidebar-row-tools` 仍是当前真实 layout/E2E compatibility owner，
  不在状态切片盲删；剩余 drawer/list keyframes 与 compatibility selector 进入 U13 逐引用清理。

## P4.5 Progress

- `.sidebar-section-menu-popover`、`.sidebar-section-menu.open`、`.sidebar-section-menu-copy` 和
  `.sidebar-section-menu-rich-*` 在 production CSS/JSX 中归零；
- `ActionMenuItem` 删除误导性的 Sidebar rich class，只保留模型工作台仍有 owner 的
  `.action-menu-item-*`；
- section trigger 的 active state 改用 Radix `data-state=open`，不再依赖手写 `.open` wrapper；
- compact rail 用 focused selector 隐藏 menu action，disclosure、rail preview 和 Tooltip 保持可达；
- 旧 menu selector family 删除后，`layout/components/sidebar/action-menus.css` 合计减少 332 行；
- 仍有 owner 的 row、rail、drawer selector 与 keyframe 留给 U13，不以行数目标替代可达状态证据。

## P6A.1 Progress

- Channel Header/Search layout 从 `layout.css` 和 `components.css` 迁入 128 行 focused
  `channel-header.css`，源 selector 同步删除；
- Search 使用共享 Input/IconButton 和 package-owned Conversation Toolbar，不新增 Feature Button/Tooltip 视觉；
- focused CSS 颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- Header 只依赖 semantic token，`ling-light` / `ling-dark` 两张原尺寸证据没有主题补丁；
- `components.css` 当前为 16,386 行，`layout.css` 为 1,920 行；后续只允许继续迁出和删除。

## P6A.2 Progress

- Channel conversation column、Feed scroll/virtual row、Jump to latest 和 feature feedback 迁入 focused
  `channel-feed-composer.css`；Composer shell、tokenized input 和 permission Menu 迁入 conversation package；
- `components.css` 从 16,386 行降至 15,801 行，没有复制后保留同一视觉 owner；
- `ChannelFeedChrome` 与 `ChannelComposerFeedback` 只使用共享 Spinner、IconButton、Button 和
  InlineFeedback，不新增 Feature 级 primitive 视觉；
- 权限弹层由共享 Radix Menu Portal 所有，不再依赖 document-level listener 或 Feature position owner；
- focused/package CSS 的颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- `.conversation-work-cell-active-stream/.conversation-work-cell-agent-stream` 暂保留为 WorkCell 真实状态
  owner；P6A.3 已确认仍有生产引用，后续只允许在 U13 按引用和截图证据收敛，不作为 legacy 无条件删除。

## P6A.3 Progress

- `.client-task-card`、`.task-run-link`、旧 `.task-status`、`.session-permission-control`、
  `.permission-preset-option` 和 `.channel-environment-section` production owner 已归零；
- `ChannelTaskWorkspace.tsx` 没有生产调用，组件和对应 `runs.css` selector family 一并删除；
- Commit preview 与 workflow preview 都已使用共享 Dialog，旧 `.environment-commit-dialog-backdrop`、
  `.environment-commit-dialog-head` 和 `.environment-commit-actions` production owner 归零；
- workflow preview 领域布局迁入 `channel-workflow-preview.css`，没有继续扩大 `components.css`；
- Task/Environment focused CSS 只使用 semantic token，颜色字面量、`!important`、Theme Pack ID selector
  和 `transition: all` 均为 `0`；
- `.task-detail-panel` 保留为可达 Right Dock scroll owner，不按字符串命中误判为 legacy；
- `components.css` 当前 14,998 行、`layout.css` 1,894 行、`runs.css` 709 行、`workspace.css` 1,120 行；
  下个切片不得把 Settings/Overlay/Dock 深层样式重新堆回这些聚合文件。

## P6A.4 Progress

- Channel Settings 五 Tab 使用 focused `channel-settings.css`；Dock 通用 shell/launcher/list 归
  conversation package，plans/review/workspace changes 归 `channel-right-dock/` 三个 focused 文件；
- `.channel-settings-header-line/.channel-settings-header-title/.channel-settings-top-back` 从
  `components.css` 迁入 `channel-header.css`，成为 Settings/Environment utility header 的唯一 owner；
- `.task-workbench-main.channel-settings-main` 从 `components.css` 迁入 `channel-settings.css`；
- 删除 `components.css` 重复的 `.workspace-change-file-badges > small` 窄屏规则，focused
  `channel-right-dock/workspace-changes.css` 成为唯一 breakpoint owner；
- `components.css` `11,457 -> 11,388`，Web CSS `46,020 -> 46,017`；focused 文件颜色字面量、
  `!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- UI2 lint 通过，legacy z-index 为 `92/97`，高位数字 z-index 为 `24/25`；这些剩余声明继续只减不增，
  不因 P6A.4 完成而假装清零；
- package `40/40 + 10/10`、P6A.4 focused `7/7`、typecheck、i18n、lint 和 diff check 通过。

## P6B.1 Progress

- Normal Header/page/Feed/Composer geometry 从 835 行 `conversation-home.css` 迁入 224 行 focused
  `normal-conversation.css`，源文件降至 559 行；共享 Header Search 留在 202 行
  `conversation-toolbar.css`；
- `NormalConversationHeader` 只使用 package-owned Toolbar/Input/IconButton，不新增 Feature Button、Tooltip
  或 active-state 视觉；
- Toolbar frame 新增公开 `data-conversation-toolbar-frame`，`strict-console.css` 只按该语义边界排除，
  不命中 package 内部 `.ling-ui-*` 或 span 顺序；
- focused/package CSS 的颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均未新增；
- `strict-console.css` 在 P6B.1 检查点为 1,402 行，只增加一条兼容排除，仍必须在 U13 删除，不能成为新视觉 owner；
- `ConversationHome.tsx` 在 P6B.1 检查点为 1,598 行，P6B.2 必须先抽 Feed/message/Composer projection 与 component，
  禁止继续在聚合文件追加主要行为；
- conversation package `10/10`、focused `2/2`、Panel/Desktop `26/26`、selected regression `41/41`、
  typecheck/i18n/lint/diff check 和两张原尺寸证据通过。

## P6B.2 Progress

- Normal Feed/message/Composer/model Menu/thinking Menu 领域样式进入 374 行 focused
  `normal-conversation-feed-composer.css`；`conversation-home.css` `559 -> 83`，
  `normal-conversation.css` `224 -> 124`；
- `ConversationHome.tsx` `1,598 -> 998`，Feed、Composer、view-model、options 和 types 已抽为 focused owner；
  P6B.3 必须继续抽 Dock projections/page shell，使聚合文件降到 800 行以内；
- model/thinking 手写 listbox、document outside click 和 Escape listener 已删除，改用 package-owned Radix
  Menu；Feature 不拥有 Menu、Input、Button、Spinner 或 focus-ring 视觉；
- strict-console 对普通对话 Composer 的 Dark blanket repaint 已移除；semantic Feed/Composer、Portal Menu
  和 tokenised Input 不再被兼容层覆盖；
- focused CSS 新增颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- Web CSS 当前 62 文件、45,820 行；`components.css` 11,388 行、`strict-console.css` 1,412 行，
  两个聚合 owner 继续只减不增；
- conversation package `10/10`、focused `4/4`、selected regression `71/71`、typecheck、i18n、lint、
  diff check 和三张原尺寸证据通过。

## P6B.3 Progress

- Normal Dock/page-shell/domain detail selector 进入 218 行 focused `normal-conversation-dock.css`；
  `normal-conversation.css` `124 -> 87`，`conversation-home.css` 保持 83 行，`components.css` 保持 11,388 行；
- `ConversationHome.tsx` `998 -> 800`；Dock projection、page composition、workspace panel composition 和
  page shell 已有 focused owner，store/fetch/mutation/terminal session 未下沉纯展示组件；
- Context/Review/Plans/Files/Activity/Browser/Terminal 使用语义 role/name 和稳定 domain selector；focused spec
  不依赖 package 内部 span 顺序，也不为普通对话复制 Channel selector；
- focused CSS 新增颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- Web CSS 当前 63 文件、46,002 行；新增 focused owner 218 行和 import 1 行，同时从旧 Normal owner 删除
  37 行。`components.css`、`strict-console.css` 继续只减不增；
- conversation package `10/10`、focused `3/3`、selected regression `81/81`、typecheck、i18n、lint、
  diff check 和四张原尺寸证据通过。

## P6C.1 Progress

- Teammate private Header/Search/Status/Summary selector family 进入 203 行 focused
  `teammate-private-header.css`；`teammates.css` `5,305 -> 5,032`，旧手写 Search 三列 grid 和 input/button
  control owner 已删除；
- Channel/Normal/Teammate 共用 `useConversationHeaderController`；Normal 旧 hook 降为 compatibility alias，
  不保留第二套 open/focus/Esc/Refresh state；
- `TeammateChatHeader` 使用 package-owned Toolbar/Input/IconButton 和共享 Search，Feature 不拥有 control visual；
- `strict-console.css` 只增加一个 public semantic Header 排除，`1,412 -> 1,413`，后续仍由 U13 删除；
- focused CSS 新增颜色字面量、`!important`、Theme Pack ID selector 和 `transition: all` 均为 `0`；
- Web CSS 当前 64 文件、45,934 行；focused owner 和 import 新增 204 行，同时从 `teammates.css` 删除 273 行；
- focused `2/2`、selected regression `55/55`、typecheck、i18n、lint、diff check 和两张原尺寸证据通过。

## P6C.2 Progress

- Teammate private root/Feed/Composer/message attachment selector family 进入 208 行 focused
  `teammate-private-feed-composer.css`；`teammates.css` `5,032 -> 4,800`，旧重复白色 Feed、Composer Dark
  repaint、direct-child Dock grid 和 attachment chip 颜色 owner 已删除；
- `strict-console.css` `1,413 -> 1,411`，不再直接拥有 `.teammate-private-chat` 或
  `.teammate-direct-composer` surface repaint；最终 blanket selector 仍由 U13 删除；
- `TeammatePrivateChatSurface.tsx` `1,091 -> 181`，新增 Feed、Composer、types、controllers 和 view-model
  均低于 400 行；该检查点的 `TeammateWorkspace.tsx` 为 2,502 行，后续 P6C.3 已继续抽出 Dock 边界；
- focused CSS 新增颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和私聊 keyframe 均为 `0`；
- Web CSS 当前 65 文件、45,909 行；增加一个 focused 文件后总行数继续减少 25 行；
- focused `4/4`、selected regression `64/64`、typecheck、i18n、lint、diff check 和五张原尺寸证据通过。

## P6C.3 Progress

- Teammate private Context/Activity/Dock domain selector family 进入 247 行 focused
  `teammate-private-dock.css`；`teammates.css` `4,800 -> 4,735`、`sidebar.css` `1,850 -> 1,849`；
- 旧 `TeammateChatContextPanel` 与 legacy Context/Dock selector 已删除，Context 和 Activity 不再共用节点；
- focused CSS 新增颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和私聊 keyframe
  均为 `0`；共享 Dock Presence/resize selector 没有复制到 Feature；
- `TeammateWorkspace.tsx` `2,502 -> 2,489`，仍是超过 1,200 行的 orchestration 架构债；新增/扩展的
  projection、page 和共享 Dock 文件均低于 800 行；
- Web CSS 当前 66 文件、46,091 行；focused `2/2`、selected regression `78/78`、typecheck、i18n、lint、
  diff check 和七张原尺寸证据通过。

## P7A.1 Progress

- Settings fullscreen/navigation/content selector family 进入 211 行 focused `settings-shell.css`；
  `settings.css` `3,137 -> 2,914`、`sidebar.css` `1,849 -> 1,816`，两个 legacy owner 不再拥有 Shell；
- shared Button 只通过公开 `data-ling-button-slot` 和 CSS variables 适配，命中
  `.ling-ui-button-leading/label/trailing` package-private class 的 selector 为 `0`；
- focused CSS 颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和 private keyframe 均为 `0`；
- `strict-console.css` `1,411 -> 1,416`，只增加 semantic Settings exclusions；该 blanket 文件仍由 U13 删除；
- Web CSS 当前 67 文件、46,052 行；focused `2/2`、Settings/会话合同 `23/23`、selected regression
  `65/65`、typecheck、i18n、lint、diff check 和四张原尺寸证据通过。

## P7A.3 Progress

- `.settings-global-approval-card/.settings-decision-*`、`.ling-tone-*` 和仅由 Personalization 使用的
  governance selector 已从 `settings.css` 迁出并删除源 owner；
- `RichChoiceSelect.tsx`、barrel export 和 `.rich-choice-*` selector family 已删除，native Select adapter
  仍保留 10 行兼容入口；
- `.settings-inline-tip/.settings-inline-success` 仍有 Skill Library 等真实调用方，本切片没有越权整组删除；
- focused `settings-default-authorization.css` / `settings-personalization.css` 命中颜色字面量、`!important`、
  Theme/Profile selector、`transition: all`、private keyframe 和 package-private selector 均为 `0`；
- `settings.css` `2,899 -> 2,656`，focused `5/5`、selected `33/33`、typecheck、i18n、lint、diff check 和
  六张原尺寸证据通过。

## P7A.4 Progress

- 删除单一调用方 `ThemeSwitcher`、`LanguageSwitcher` 及 `.theme-switcher/.language-switcher` selector family；
- `.interface-settings-panel/.settings-interface-*` 只由 focused `settings-interface-preferences.css` 所有，
  `settings.css` 不再拥有 Interface section layout；
- ThemePicker 的 option/swatch/selected/applying/reduced-motion selector 只在 package CSS，Feature CSS 不命中
  `.ling-ui-theme-*` package-private nodes；
- focused CSS 和 ThemePicker CSS 的颜色字面量、`!important`、Theme/Profile ID selector、
  `transition: all` 和 private keyframe均为 `0`；
- `settings.css` `2,656 -> 2,611`，Web CSS 当前 71 文件、46,076 行；focused `5/5`、selected `51/51`、
  typecheck、i18n、lint、diff check 和五张原尺寸证据通过。

## P7A.5 Progress

- `.external-work-settings-panel`、External Work legacy action box/count/form/detail alias 和
  `SettingsMetaLine` 调用已删除；稳定测试入口改为 `[data-ui2-external-work]`；
- External Work 的 section/form/detail/summary selector family 只由 206 行 focused
  `settings-external-work.css` 所有，`settings.css` 不再拥有该 section；
- focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`；
- `settings.css` `2,611 -> 2,557`，Web CSS 当前 72 文件、46,225 行；focused `5/5`、selected `132/132`、
  typecheck、i18n、lint、diff check 和五张原尺寸证据通过。

## P7B.1 Progress

- 491 行 `mcp.css` 已删除；MCP page/sheet/card/tool/details selector family 收敛到 387 行 focused
  `settings-mcp-tools.css`，共享 primitive chrome 没有在 Feature 重建；
- `settings.css` 删除遗留 MCP section selector，`2,557 -> 2,521`；`.settings-inline-tip` 和
  `.settings-inline-success` 仍由下一切片 Skill Library 使用，本切片没有越权删除；
- focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`；
- Web CSS 当前 72 文件、46,085 行；Feature direct package imports `0`、SelectControl `35/43`、legacy
  z-index `87/97`、high literal z-index `22/25`；
- package `41/41`、focused `5/5`、selected `34/34`、broader `139/139`、typecheck、i18n、lint、diff check
  和六张原尺寸证据通过。

## P7B.2 Progress

- `.settings-skill-*` selector family 已从 `settings.css` 和 `settings-interactions.css` 迁出；旧
  `SkillLibraryWidgets.tsx`、`SkillReviewQueuePanels.tsx` 与 `settings-skill-editor.css` 已删除。
- focused owner 为 `settings-skill-library.css` 和五个 subfiles；六个文件都低于 400 行，且颜色字面量、
  `!important`、Theme/Profile selector、`transition: all`、private keyframe 和 package-private
  `.ling-ui-*` selector 命中均为 `0`。
- `.settings-inline-tip/.settings-inline-success` 已从 Skill Library 生产面移除；成功统一进入 shared Toast，
  失败留 Registry、Evolution、Inspector 或所属 Dialog。
- `settings.css` `2,521 -> 972`、`settings-interactions.css` `220 -> 190`；Web CSS 当前 76 文件、45,098 行。
- package `41/41`、focused `4/4`、ownership/import `7/7`、selected `27/27`、typecheck、i18n、lint、
  diff check 和六张原尺寸证据通过。

## P7B.3 Progress

- Archived toolbar/search/list/row/empty/error selector family 已从 `settings.css` 迁入 173 行 focused
  `settings-archived-items.css`，源 selector 同步删除；`settings.css` `972 -> 823`。
- raw Input/Button、`Loader2.spin`、四个 browser confirm 和 legacy Empty/Error 已由 shared primitives 取代；
  Feature 没有重建 Button、Dialog、Spinner 或 Feedback chrome。
- shared IconButton 原零宽 label flex item 会因 gap 导致图标偏移 3px；已在 package `button.css`
  隐藏 icon-only label slot 并将 gap 归零，package test 锁定该合同，没有写 Archived 特例补丁。
- focused CSS 颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`。
- Web CSS 当前 77 个文件、45,123 行；package `41/41`、focused `5/5`、existing `19/19`、selected
  `29/29`、typecheck、i18n、lint、diff check 和六张原尺寸证据通过。

## P7B.4 Progress

- Startup header/issues/technical details 与 Run Diagnostics toolbar/list/detail selector family 已分别从
  `settings.css` 和 `settings-interactions.css` 迁入 398 行 focused `settings-startup-diagnostics.css`；
  `settings.css` `823 -> 662`，`settings-interactions.css` `190 -> 60`。
- 旧 `.startup-readiness-card/.startup-phase-row/.settings-run-diagnostics-summary`、raw button 和 legacy
  MetaRow/StatusBadge/EmptyState owner 已删除；测试改用 semantic region、role/name 和稳定 domain selector，
  没有恢复旧 class 迁就 locator。
- focused CSS 颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`。
- Web CSS 当前 78 个文件、45,231 行；package `41/41`、focused `5/5`、Settings `17/17`、Runtime `19/19`、
  selected `25/25`、typecheck、i18n、lint、diff check 和六张原尺寸证据通过。

## P7B.5 Verified Migration

- `SettingsWorkspaceToolSurface` 的公开 selector 只用于 embedded boundary、view identity、min-size、scroll 和
  overflow；不命中 package-private `.ling-ui-*`，没有按 Model/Teammate/Council 子节点写后代选择器。
- 已删除无生产 import 的 `SettingsWorkspaceToolsPanel.tsx`，并在同一 patch 删除
  `.settings-workspace-tools`、`.settings-configuration-*`、`.settings-tool-row-*` 及其 responsive selector family；
  不保留 compatibility alias。
- `settings-workspace-tools.css` 为 27 行，颜色字面量、`!important`、Theme/Profile selector、
  `transition: all`、private keyframe 和 package-private selector 均为 `0`。
- `settings.css` `662 -> 436`；Provider/Teammate/Council 旧 selector 保留给 P8/P9，
  P7B.5 不通过 Settings wrapper 重新定义它们的按钮、表格、Tab、Dialog 或状态色。
- dead selector 命中归零；1440/1280/980 overflow、六张原尺寸证据、metadata 和四个 verified ID 已闭环。

## P7C.1 Verified Web Theme Package Migration

- 新增公开领域 selector 只覆盖 `.settings-theme-package-*`、Import/Preview Dialog 内容布局和 1280
  containment；共享 Dialog、Menu、Button、ThemePicker、Toast 和 InlineFeedback chrome 未在 Feature 重建。
- `settings.css`、`components.css`、`base.css` 和 `layout.css` 中 theme-package legacy selector 命中为 `0`，
  不需要 compatibility alias。
- 193 行 `settings-theme-packages.css` 的颜色字面量、`!important`、Theme/Profile ID selector、
  `transition: all`、private keyframe 和 package-private `.ling-ui-*` selector 命中均为 `0`。
- ThemeOption 的 More action 通过 package sibling slot 注入，不在 radio 内嵌第二个 interactive owner。
- 当前工作树 Web CSS 快照为 66 文件、42,866 行；package `45/45`、focused `5/5`、selected `83/83`、
  typecheck、i18n、lint、diff check 和六张原尺寸证据通过。
- Desktop 原生持久化没有 selector 或平台例外补丁；后续 `DESKTOP-THEME-PACK-PERSISTENCE-001` 必须复用
  相同 token/component owner。

## P7C.2 Quick Theme Studio Preview Substrate

- 新增 package owner `theme-studio-preview.css`，424 行，唯一 selector family 为
  `.ling-ui-theme-studio-preview-*`；不向 `components.css`、`settings.css` 或 Theme Pack Feature CSS
  复制共享 preview chrome。
- 颜色字面量、`!important`、Theme/Profile ID selector、`transition: all` 和 private keyframe 命中均为 `0`。
- 候选颜色只通过 `LingThemeCssVariable` allowlist 注入 fixture viewport；Settings/Dialog 的 artwork-off
  保护在组件 policy normalization 中完成，不通过主题专属 CSS selector 补丁实现。
- production owner 为 371 行 TSX 与 424 行 CSS，均低于模块预算；Web harness 仅在 E2E support 中存在。
- package `50/50`、focused browser `4/4`、Theme 联合 `15/15` 和 typecheck/i18n/lint/diff check 通过。
- 这只关闭 shared Preview substrate；生产 Theme Studio 页面 CSS 仍等待 D3 后的 focused owner，不能
  借此把 `UI-THEME-STUDIO-PREVIEW-001` 标为 verified。

## P8.1a AI Teammate Management List

- `.teammate-draft-*`、`.teammate-model-pill`、`.teammate-channel-pill`、`.teammate-updated-time`、
  `.teammate-row-*` 和 list council-entry selector family 已从 `teammates.css` 迁入 283 行 focused
  `teammate-management-list.css`；`teammates.css` `4,735 -> 4,344`。
- 手写 `hover-action-menu`/document pointerdown-keydown owner 已删除，Menu chrome、Portal、Esc 和 focus
  归共享 Radix primitive；`components.css` / `strict-console.css` 的 list compatibility selectors 同步删除。
- focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和 package-private
  `.ling-ui-*` selector 命中均为 `0`；已迁 selector 在三个 legacy owner 中的剩余命中为 `0`。
- `contain: layout paint` 只放在唯一列表滚动 owner，阻止 14 行内部滚动内容污染 root overflow；不作为
  全局或共享组件补丁。
- package `50/50`、focused `4/4`、selected `30/30`、静态检查和四张实页证据通过。

## P8.1b AI Teammate Default Roles And Create

- Default role card/grid、create sheet/wizard、preview、advanced summary、setup steps/progress 和旧 avatar create
  selector family 已从 `teammates.css` / `strict-console.css` / `components.css` 删除；剩余命中为 `0`。
- 唯一 Feature owners 是 `teammate-management-role-catalog.css`、`teammate-management-create.css` 和
  `teammate-management-create-progress.css`；共享 Dialog/Form/Button/Status/Spinner chrome 不在 Feature 复制。
- 三个 focused owner 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private
  keyframe 和 package-private `.ling-ui-*` selector 命中均为 `0`。
- `teammates.css` `4,344 -> 2,864`，不通过 Settings/Dark/Profile 特例修补角色与创建流程。
- package `50/50`、focused `5/5`、selected `35/35`、静态检查和五张实页证据通过。

## P8.1c AI Teammate Settings Shell And Profile/Avatar

- Settings-mode grid/Header/navigation/summary 与 Profile identity/avatar/lifecycle/persona selector family 进入
  `teammate-management-settings-shell.css` 和 `teammate-management-profile.css` 两个唯一 owner。
- `.teammate-profile-form/.teammate-avatar-preview/.teammate-avatar-settings/.teammate-avatar-actions/
  .teammate-settings-panel` 及旧 shell/nav/summary selector 已从 `teammates.css` / `strict-console.css` 删除；
  迁移 selector 在 legacy owner 中剩余命中为 `0`。
- 两个 focused owner 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe
  和 package-private `.ling-ui-*` selector 命中均为 `0`。
- compact `StatusIndicator` 的隐藏 accessible label 在 package owner 建立 relative positioning context；不以
  Profile selector 或 overflow hack 修补根高度。
- `teammates.css` `2,864 -> 2,648`，Web CSS 当前 85 文件、44,165 行；package `50/50`、focused `6/6`、
  Teammates `21/21`、selected `16/16`、静态检查和五张实页证据通过。

## P8.1d AI Teammate Model Assignment

- `.teammate-settings-grid/.teammate-config-card` 及 Model 对旧 raw Button/Select/MetaRow/StatusBadge 的调用已删除；
  `TeammateModelTab` 只使用 shared Field/Select/Button/DataRow/StatusIndicator/InlineFeedback/EmptyState。
- Model 领域 selector 只存在于 113 行 `teammate-management-model.css`；Settings shell 只登记 content scroll
  owner，不重写 shared control chrome。
- focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`。
- `teammates.css` `2,648 -> 2,628`，Web CSS 当前 87 文件、44,340 行；package `50/50`、focused `6/6`、
  selected `36/36`、静态检查和五张实页证据通过。

## P8.1e AI Teammate Management Skills

- 旧 Skills workbench、七列表格、默认压屏 Inspector、binding/import/archive selector family 已从
  `teammates.css` 删除；role template preview 改用 role-catalog owner 的独立 `teammate-role-skill-*` family，
  不再借用管理页 selector。
- Skills 领域 selector 只存在于 390 行 `teammate-management-skills.css`；Input/Select/Button/IconButton/DataRow/
  StatusIndicator/InlineFeedback/EmptyState/Menu/Dialog/Drawer/InspectorSection chrome 和 overlay motion 继续由共享
  owner 管理，不在 focused CSS 重写。
- focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`。
- `TeammateWorkspace.tsx` `2,348 -> 2,098`；controller 399、Tab 354、Import Dialog 161、Inspector Drawer 198、
  view-model 226 行。`teammates.css` `2,628 -> 2,105`，当前 Web CSS 为 88 文件、44,161 行；ui-react `50/50`、
  conversation UI `10/10`、focused `13/13`、selected `52/52`、静态检查和五张实页证据通过。

## P8.1j AI Teammate Permissions

- Permissions 不再借用 `.teammate-config-card/.settings-meta-row/.status-badge` 或 package-private
  `.ling-ui-data-row` selector；Feature 只拥有 `.teammate-permissions-*` 几何与内容 slot。
- 217 行 focused CSS 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe
  和 `.ling-ui-*` selector 命中均为 `0`。
- shared DataRow/StatusIndicator/Badge/InspectorSection/InlineFeedback/Skeleton/Button 继续拥有 control chrome；
  Dark 修复不得通过 broad `[class*=row/card/section]` 或更高 specificity 回写。
- focused `5/5`、selected `60/60` 和六张原尺寸证据通过；`teammates.css` 不再接收 Permissions 新 selector。

## Shared Input Focus Containment

- `workspace.css` 的 `36px` 裸 input 高度、`components.css` 的 legacy 裸 `input:focus` 和
  `strict-console.css` 的 Dark input blanket 会覆盖 `.ling-ui-input-native`，造成共享 Input 聚焦时出现
  native 高度或第二层 inner shadow 超出固定 shell 的视觉错误。
- package `form-controls.css` 现在显式清除 native input 的 border/outline/box-shadow/background；焦点只由
  `.ling-ui-input:focus-within` 持有，并使用 shell 内描边，不再产生 shell 外部 halo。
- shared Input 与 Checkbox 的 native 节点使用公开 `data-ling-control-native` marker；文本 Input 继续保留
  `data-ling-input-native` 供现有业务定位。`workspace.css`、`components.css`、`layout.css` 和
  `strict-console.css` 的迁移期 blanket selector 均排除通用 marker，placeholder/disabled 也不得重新覆盖
  package owner；隐藏 Checkbox input 不得参与 Feature Grid 宽度计算。
- `ui2-form-controls.spec.ts` 锁定 focus 前后 shell 高度、native 零 border/shadow、native box 位于 shell
  边界内且 shell computed shadow 包含 `inset`；第三条真实 Channel Create 用例同时锁定迁移期裸 Input 的
  稳定高度、零外轮廓和内描边。
- U13 仍必须删除或作用域化上述裸 input/textarea selector；package shield 和 compatibility marker 都不是
  保留旧全局 selector 的理由。

## T13-D Work Board Owner Closeout

- Work Board 与 Channel Work Board 的 computed selector owner 已收敛到五个 focused CSS 文件；真实 Light、
  Dark 和 Channel 根的 `strictConsoleMatches=[]`。
- 21 个 legacy Dark blanket groups 只增加零 specificity public-root exclusion，`strict-console.css` 只减不增；
  后续 aggregate owner 仍负责彻底删除 blanket，而不是把 Work Board 特例永久化。
- E2E helper 从已删除的 `article` 语义迁到公开 DataRow/action，不恢复旧 class 或旧 DOM。
- focused/legacy `12/12`、两条原阻塞用例 repeat `6/6`、selected `147/147`；增强 156 项组合中的两个无关
  Channel timing cases 隔离 repeat `6/6`，不计为 Work Board selector failure。

## P10.1 Media Jobs Progress

- `media.css`、`media-job-detail.css`、`media-create-dialog.css` 共 `985` 行已删除；唯一 Media Jobs owner 是
  `styles/features/media-jobs/` 六个 focused 文件，共 `521` 行。
- `components.css`、`strict-console.css`、`media-production.css` 的 `.media-job-*`、`.media-jobs-*`、
  `.media-create-*` 和 `.media-artifact-preview` 旧 selector 命中为 `0`。
- focused owner 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和
  package-private `.ling-ui-*` selector 命中均为 `0`。
- Media Workflow Library 属于 P10.2；P10.1 只为从 repair 路径可达的 overlay 增加 scoped Theme Pack token
  bridge，不在 `strict-console.css` 恢复 Dark 特例。
- focused `11/11`、legacy `5/5`、Media combined `24/24` 和 12 张原尺寸证据通过；U13 仍负责全局非 Media
  selector 和总行数预算，不能据此宣布全局 CSS cleanup 完成。

## P8.2e Council Settings / Archive Selector Closeout

- `.council-settings-*`、`.council-low-frequency-*` 和旧 Settings action family 已从 `councils.css` 删除，
  无生产引用、无第二视觉 owner。
- 314 行 `council-settings-archive.css` 只拥有 Settings/Lifecycle/Archive/Danger domain geometry；共享
  Field/Input/Textarea/Switch/Button/Dialog/InspectorSection/Feedback chrome 保持 package-owned。
- focused forbidden scan 为 0；`councils.css` 当前 45 行只保留仍有生产引用的 Council detail skeleton，不能
  为追求归零而在 U13 前盲删。
- focused `7/7`、selected `66/66`、双 viewport/双主题原图和 console/overflow 通过。

## P10.2 Media Production Selector Closeout

- `media-production.css`、`media-production-inspector.css`、`media-production-canvas-first.css`、
  `media-workflows.css` 和 `media-production-priority-refinement.css` 已删除；S0 脏树快照为 `2,432` 行，
  相对 HEAD 的 tracked baseline 为 `2,438` 行。
- Media Production domain geometry 只存在于 `styles/features/media-production/` 八个 focused owner，合计
  `1,597` 行；`styles.css` 只加载 `index.css`，不保留第二套优先级 patch layer。Dock 已从 Canvas owner 拆出。
- focused owner 的颜色字面量、`!important`、Theme selector、`transition: all` 和 package-private
  `.ling-ui-*` 命中均为 `0`；Input/Select/Button/Dialog/Inspector/Feedback chrome 继续 package-owned。
- focused `27/27`、legacy `8/8`、Media Jobs `16/16`、Dark `2/2` 和 evidence `36/36` 通过；U13 仍负责
  非 Media 的 aggregate selector，不能据此宣称全局 CSS cleanup 或 packaged Desktop 已完成。
- closeout 后 owner refinement 另以独立端口重跑 focused + legacy `35/35`，保持 Web ID closed。

## T13-H Dead Action Menu And Model Facade Closeout

- `ActionMenuItem` 已无生产调用，组件、shared export 和 `.action-menu-item*` selector family 一次性删除；
  E2E 的 `expectActionMenuItemAligned` 只是 Radix Menu 几何 helper，不构成旧组件引用。
- `providers.css` 空 marker 与 `model-workbench.css` 单行 facade 已删除；focused Model index 在原加载位置直接导入，
  cascade 顺序不变。
- 无 selector 的单行 `forms.css` 占位文件和 root import 已删除；真实 form controls 继续由 package/focused owner 管理。
- production 引用扫描为 `0`；typecheck、UI2 boundary lint 和独立 Playwright 端口 App/Model/Dark `46/46`
  通过。首次复用 `4174` 的运行在 16 项后服务退出，后续仅为 `ERR_CONNECTION_REFUSED`，不计为产品失败。

## T13-I Workspace And Conversation Aggregate Cleanup

- `T13-I.1` 首先处理 `workspace.css` 的 hard-dead family：`.content-grid`、`.workspace-task-grid`、
  `.task-workspace`、`.field-row`、`.tool-grid/.tool-toggle` 和全部 `.run-recording-*` 在生产 TS/TSX 中引用为 `0`，
  不迁入 focused owner，已直接删除 160 行；`workspace.css` 从 870 行降至 710 行。
- T13-I.1 的 typecheck、lint、i18n、diff check 与 Shared Input focus geometry `2/2` 通过。已完成任务按合同
  从全局 Work Board `History` 打开；导航控制器在 Task 列表尚未加载时使用 durable item 的 `channelId`，
  刷新频道 Task 后重新选择目标，关闭 durable-first race。最终 selected 回归 `63/63`。
- 仍有真实调用的 `.workspace-readiness/.first-run-*`、`.panel/.field`、legacy input blanket 与
  `.ci-triage-*` 不属于 I.1，不因相邻位置被顺手删除。
- `T13-I.2` 已由单一 aggregate owner 将 `components.css` 的 Terminal panel family 迁入既有
  `conversation-panels.css`；源 owner 命中归零，focused owner 355 行且没有 `!important`、`transition: all`
  或私有 keyframe。拖动、运行、关闭、reduced motion 和三类会话通过 panels `6/6`、Summary repeat `3/3`
  与 Channel Terminal `1/1` 验证。
- P13 Web 发布预检可与后续 U13 只读准备并行，但最终截图必须在 aggregate cleanup 稳定后重采，全局
  `designed/implemented` Function ID 不因预检通过提前变为 `verified`。

## T13-L Council Aggregate Facade Closeout

- `councils.css` 的 detail Tabs/body/section skeleton 经生产引用审计确认全部仍可达，不做 hard-delete；保持
  原声明值迁入 `council-list-health.css`，该文件成为 Council workspace/list/detail shell 的 focused owner。
- `council-members.css` 与 `council-channels.css` 从根 `styles.css` 在原 facade 位置直接导入；删除 45 行
  `councils.css` 和单点 facade import，不复制 selector、不改变业务 class、层级或 theme token。
- List/Create/Members/Channels/Settings-Archive focused `36/36` 通过；Web CSS `139/40,319 -> 138/40,311`。
  本切片不提升 Function ID，也不替代 packaged Desktop 证据。

## T13-M Zero-Reference Council And Runtime Runner Cleanup

- `T13-M.1` 从 `components.css` 删除 70 行零生产引用的旧 Teammate Council action/create/summary family；
  不迁移、不改 `teammates.css` 同名前缀，不与当前 `teammate-council-inline-entry` owner 混合。Council
  Create/Clone + legacy focused `9/9` 和 lint 通过，`components.css 10,710 -> 10,640`。
- `T13-M.2` 从 `settings.css` 删除 37 行零生产/CSS引用的 Runtime Runner panel/row/readiness/status-dot
  family；两个既有 E2E 继续断言旧面板不可达。Settings + Dark `19/19` 和 lint 通过，
  `settings.css 436 -> 399`。
- 两个切片文件互斥、均无新 owner、无主题/业务/API 变化；Web CSS `138/40,311 -> 138/40,204`。
  大聚合文件仍是架构债，不能把本次 hard-dead 清理写成全局 CSS 完成。

## T13-N Four-Owner Zero-Reference Cleanup

- `T13-N.1` 删除 `components.css` 的 50 行 Activity disclosure/panel 根 family；主线程发现并独立删除另一处
  4 行 dead descendant override。production/test/CSS refs 全部归零，Activity + Channel 完整复跑
  `111/111`，`components.css 10,640 -> 10,586`。
- `T13-N.2` 删除 `teammates.css` 22 行旧 Council summary，保留仍需独立审计的 status family；当前 List/
  Health focused owners 不变，相关回归 `17/17`，`teammates.css 1,785 -> 1,763`。
- `T13-N.3` 删除 `settings.css` 28 行 compact details；External Work 已由 focused section + shared Inspector
  所有，回归 `24/24`，`settings.css 399 -> 371`。
- `T13-N.4` 删除 `layout.css` 57 行 file/run-artifact legacy family；相邻 Channel/Session file owners不变，
  Runs/Runtime `26/26`，`layout.css 1,892 -> 1,835`。
- 四个文件无交叉写入、无新 owner，target refs 与 lint 均通过；Web CSS `138/40,204 -> 138/40,043`。
  旧 aggregate 总量仍高于 30,000 目标，不能标记 U13 或 UI 2.0 完成。

## T13-O.1 Settings Aggregate Removal

- 371 行 `settings.css` 的 live/dead ownership 已逐 family 审计：Plugin Manager 使用既有 focused shell；
  SettingsSubnav shell/description 已由 `settings-shell.css` 唯一拥有；Archived panel 几何归入
  `settings-archived-items.css`；其余零引用 controls/status/action/policy families 直接删除。
- 唯一跨 embedded surface 的 `settings-content-stack .panel-title/.meta-row` 规则进入 50 行
  `settings-content-chrome.css`，root import 原位替换以保持 cascade；新 owner 使用 Ling semantic tokens，
  禁止再吸收 section 或 plugin 领域样式。
- 71 项真实 Vite 联合回归覆盖 App、Settings、Plugin、Archived、Workspace Tools、Dark 和 Input；静态门禁
  全绿。Web CSS `138/40,043 -> 138/39,727`，旧 `settings.css` 文件与 import 均归零。

## T13-O.2 Teammate MCP Focused Owner

- `teammates.css` 的 `.teammate-mcp-*` selector family 已归零；唯一视觉 owner 是 328 行
  `teammate-management-mcp.css`。
- `teammate-management-settings-shell.css` 只保留 Settings 嵌入态 content-column/min-size/overflow 几何，
  不重复 MCP row、selection、details 或 semantic state visual。
- focused owner 的 43 个规范化 selector 在其他 production CSS 中精确重复数为 `0`；hex/rgb、green/white、
  `!important`、Theme selector 和 `transition: all` 命中均为 `0`。
- AI Teammate MCP 与 Settings MCP 组合 `7/7`；Light 1440、Dark 1280 的 panel/list/tool-list 均无横向溢出，
  console/pageerror 为零。

## T13-O.3 Package Message Body Owner

- Markdown、GFM table/task-list、code/highlight、Mermaid、KaTeX 和 rich-content presentation 只由
  `packages/conversation-ui-react/src/styles/blocks/message-body.css` 持有，并从 package `styles/index.css`
  进入 `ling.conversation` layer。
- `components.css` 不再持有迁移 root selector；Web Feature 只保留明确 consumer override，不能复制 package
  body chrome。
- focused 文件颜色字面量为 `0`；package build/test `10/10`、三类正文 `3/3`、三类 Feed/Composer
  `11/11`，覆盖 Mermaid expand/Esc、Light/Dark 重渲染、KaTeX、表格、任务清单、长无空格内容、代码和
  非法 Mermaid 回退；console/pageerror/document overflow 为零。

## T13-O.4 Channel Execution Proposal Owner

- 24 个 Channel proposal/requirement-shaping class family 只存在于 511 行
  `channel-execution-proposal.css`；`layout.css` 与 `components.css` 的目标 selector 均为 `0`。
- import 位于 `components.css` 之后、conversation toolbar 之前，复现迁移前最终 cascade；基础、状态、权限、
  criteria、actions、collaboration、shaping 和 edit form 不再由两个聚合文件互相覆盖。
- 新 owner 的 `!important`、Theme selector、`transition: all`、private keyframe 和 hex 命中为 `0`；一个
  `rgba(0,0,0,.05)` hover shadow 因现有主题 shadow token 无等价参数而保留为显式例外，后续 Theme token
  扩展时再替换，不能为追求扫描零值改变当前视觉。
- Proposal/workflow/shaping `5/5`、Dark `2/2`，覆盖 collaboration 展开、edit、accepted/blocked、Dark
  surface、console/pageerror 和 document overflow；T12.1a inset focus 规则未回退。

## T13-O.5 Channel Workflow Context Owner

- `.context-source-detail-*`、`.context-packet`、`.workflow-context-*` 的 52 个 rule block、69 个 selector
  branch、65 个 unique selector 已从 `components.css` 迁入 372 行 `channel-workflow-context.css`；旧 owner
  目标命中为 `0`。
- `channel-overlays.css` 与 `channel-settings.css` 只保留明确的 consumer containment，不复制 context visual
  owner；新文件的颜色字面量、`!important`、Theme selector、`transition: all` 和 private keyframe 命中为 `0`。
- 加强场景 `2/2`、Channel recent-context/Dark 组合 `5/5`、Web static/build/diff 全绿；panel、work-cell、document
  overflow 与 console/pageerror 为零。T12.1a inset focus 和现有业务状态未回退。
- T13-DX.1 将 `RunArtifactSection` 与 `TeammatePrivateChatFeed` 的 barrel 消费改为 focused direct import，生产
  build 不再出现对应循环 re-export warning；package public export 保留，不能把本项写成 API 删除。

## T13-O.6 Shared Terminal Report Owner

- 22 个 `.terminal-report-*` class root、37 个 rule block、46 个 selector branch 只存在于 271 行
  `styles/shared/conversation-terminal-report.css`；`components.css` 的目标 selector 命中为 `0`。
- import 紧随 `components.css` 并位于 Channel proposal/context owners 之前，保持原 unlayered cascade；
  `.terminal-report-file-type-icon` 继续允许 Workspace Changes review 独立复用，不能错误限定在 block 内。
- 新 owner 的 `!important`、Theme selector、`transition: all` 和 private keyframe 命中为 `0`。5 个历史 fallback
  hex occurrence 与 1 个 tooltip `rgba` shadow 是视觉等价迁移例外；建立等价 Theme token 前不得擅自换色。
- 普通对话、频道、暗色私聊组合 `3/3`，覆盖 summary、rows、participants、file tooltip/local resolver、scroll、
  report/document overflow 和 console/pageerror；typecheck/lint/i18n/build/diff 全绿，业务语义与 T12.1a focus
  containment 未回退。

## T13-O.7 Shared Conversation Message Frame Owner

- `.message-feed/.message-group/.message-bubble*`、`.message-content/.message-meta*`、`.message-reply-button`、
  `.message-mention-token` 与 `.message-action` 的 298 行共享 baseline 已从 `layout.css` 迁入
  `conversation-message-frame.css`；旧 owner 目标 selector 命中为 `0`。
- focused owner 保持原 import/cascade，不吸收普通对话、频道、私聊各自的列宽、virtualizer 或 final chrome。
  `components.css/strict-console.css` 的 14 个规范化精确 selector override 是已登记的后加载视觉层，不得在未逐项
  迁移前误删。
- focused owner 有 9 个历史 `rgba()`；当前 semantic/Theme token 无严格等价计算值，因此作为显式例外保留。
  文件内 `!important`、Theme selector、`transition: all` 和 private keyframe 命中为 `0`。
- 三类 Feed/Composer `11/11` 与频道/私聊语义场景 `4/5 + 1/1` 通过，覆盖 own/peer chat、system、protocol、
  work、approval、runtime、mention、reply tooltip hover/focus、rich-body/document overflow 和局部 containment；
  typecheck/lint/i18n/build/diff 全绿，Function ID 与 packaged Desktop 状态不变。

## T13-O.8 Shared Artifact Preview Owner

- `.artifact-preview-*` 与 `.image-compare-*` 的唯一视觉 owner 是 319 行
  `styles/shared/conversation-artifact-preview.css`；`components.css` 和其他 production CSS 的目标 selector
  命中为 `0`。
- owner import 紧随原 `components.css` 生效位置，文本/图片、drawer/lightbox、loading/empty/error、actions、
  single/side-by-side/slider/diff-overlay 和 range control 不通过更高 specificity 补偿错误 cascade。
- focused owner 的硬编码颜色、`!important`、Theme selector、`transition: all` 和私有 keyframe 命中均为 `0`；
  状态颜色、遮罩、阴影和 focus 全部使用现有 semantic/conversation token。
- focused `2/2`、既有 Channel/Runtime `2/2`、Web typecheck/lint/i18n/build/diff 全绿；覆盖焦点恢复、Dark、
  reduced motion、panel/body/image containment、document overflow、console/pageerror。T12.1a inset focus 与业务行为
  均未回退，Function ID 和 packaged Desktop 状态不变。

## T13-O.9 Shared Runtime Feedback Owner

- `.conversation-status-*` 与 `.conversation-guidance-*` baseline 的唯一 Web visual owner 是 240 行
  `styles/shared/conversation-runtime-feedback.css`；`components.css` 的目标 baseline 命中为 `0`。Channel
  `.channel-active-status-strip` final chrome 归 `channel-feed-composer.css`，Teammate compact override 继续归
  `teammate-private-header.css`。
- production component owner 是 `packages/conversation-ui-react/src/feedback/*`；Web 下两个零消费者同名副本已删除。
  Status/Guidance 不再出现 legacy `secondary/compact/ghost/icon-button`、手写 `useState` Menu、absolute placement
  或 literal `z-index`。
- focused owner 的颜色字面量、`!important`、Theme selector、`transition: all`、私有 keyframe 和 literal z-index
  命中均为 `0`；原 `#000/#fff` 混色改用 semantic Ling tokens，32px hit area 由 shared IconButton 持有。
- package `12/12`、focused `2/2`、完整 Channel + Teammates `126/126` 与 Web static/build/diff 全绿；覆盖
  queue/edit/close/delete/promote/stop、Arrow/Enter/Esc/outside/focus-return、Light/Dark/reduced motion、长文本和
  document overflow。Function ID 与 packaged Desktop 状态不变。

## T13-O.10 Teammate Role Detail Owner

- `.teammate-role-detail-dialog` 是 Portal 角色详情的唯一公开 scope；Role Body、Advanced、Meta、Prompt、Workflow、
  step cards 与 footer containment 由 308 行 `teammate-management-role-detail.css` 持有，不能再依赖
  `.workspace-teammates-surface` 祖先或 package-private Dialog class。
- `.teammate-sheet-*`、`.teammate-detail-hero*`、`.teammate-section.compact`、`.phase-token*` 和仅用于不存在断言的
  `.teammate-detail-panel` 已从 production CSS 归零；mixed aggregate selector 只删除对应 branch，未误删
  `.teammate-add-panel` 等 live consumer。
- Channel `.workflow-step-card.compact` 和 action row 进入 `channel-execution-proposal.css`；私聊
  `.teammate-pack-label` 进入 `teammate-private-header.css`。角色 owner 不接管 Channel 或私聊。
- focused owner 的颜色字面量、`!important`、Theme selector、`transition: all`、private keyframe 和
  package-private selector 命中为 `0`；`teammates.css 1,435 -> 946`、`components.css 8,289 -> 8,259`、
  `strict-console.css 1,055 -> 1,024`。
- focused `3/3`、Create `5/5`、Settings/Teammates/Dark `40/40`、Channel + Web release `117/117` 与 Web
  static/build/diff 全绿；Light/Dark、1440/1280、reduced motion、Esc/focus、唯一 Body scroll、长中英文、
  Dialog/child/document overflow 和 console/pageerror 由三张原尺寸证据关闭。T12.1a Input containment 未回退。

## T13-O.11 Shared Conversation Evidence Owner

- `.conversation-evidence*`、`.message-evidence*` 与 `.source-icon-stack-item` 由 309 行
  `shared/conversation-evidence.css` 唯一持有；owner 不接管消息 row、Dock shell 或 Runs Inspector 布局。
- `components.css` 中 Evidence source family 与零消费者 `.teammate-avatar-stack*` CSS 均归零；Web/package
  avatar component 和 export 未借 CSS cleanup 删除，API 边界保持。
- 原 `#eef1ef/#65716c/#2f8076/#fff/#176f5d` 映射为 Ling semantic tokens；focused owner 的颜色字面量、
  `!important`、Theme selector、`transition: all`、private keyframe、literal z-index 和 `.ling-ui-*` selector
  命中为 `0`。
- raw disclosure button 改用 shared Button，保留 `aria-expanded`、默认折叠和本地状态；Enter/Space 与 32px
  点击高度由 package 合同持有，不新增 Feature 动效。
- focused `3/3`、Runs `7/7`、Teammate `4/4`、Channel `1/1` 与 Web static/build/diff 全绿；Light/Dark、
  reduced motion、diagnostics separation、长 source/code/link/status containment、console/pageerror/document
  overflow 由三张原尺寸证据关闭。Function ID 与 packaged Desktop 状态不变。

## T13-O.12 Shared Conversation File Diff Owner

- `.file-change-*`、`.diff-file-*`、`.diff-stat`、`.message-diff-file-*`、`.diff-viewer`、`.diff-line*`、
  `.diff-gutter` 与 `.diff-fold*` 的 shared baseline 由 256 行 `shared/conversation-file-diff.css` 唯一持有；
  package message body shell、expand/copy controls 不迁入。
- 43 个目标 selector 全部 live，dead `0`；`.add/.delete/.hunk/.meta` 是动态 parser 状态。`components.css`
  shared baseline 命中归零，WorkCell 两条与 Artifact hover 一条 adapter 仍登记保留，Workspace Review 第四条
  override 继续由 right-dock owner 持有。
- focused owner 的颜色字面量、`!important`、Theme selector、`transition: all`、private keyframe、literal z-index
  和 `.ling-ui-*` selector 命中为 `0`；`components.css 7,842 -> 7,584`。
- `FileChangeEvidencePanel` 的 load state 不再触发自身 effect cleanup；identity 隔离旧结果，同一 open attempt
  只请求一次，失败稳定显示，关闭再打开允许显式重试。
- 截图门禁发现 shared `artifact-row.css` 缺少原 legacy layout；已在既有 owner 恢复 grid/padding/truncation/
  action wrap，不改 JSX，并以 Runs failure no-overlap 与 selected `49/49` 回归关闭。
- focused `4/4`、selected `49/49` 与 Web static/build/diff 全绿；Light/Dark、reduced motion、keyboard、长内容、
  internal/document overflow、console/pageerror 由四张原尺寸证据关闭。Function ID 与 packaged Desktop 不变。

## T13-O.13 Shared Conversation Summary Owner

- `.conversation-summary-*`、`.channel-progress-popover` 与 live `.attention-environment/context/progress-*`
  baseline 由 279 行 `shared/conversation-summary.css` 持有；`components.css` 中目标 source 命中归零。
- `.attention-queue-head/pill/summary/counts/list/item/item-open/item-main/item-meta/empty` 与
  `.attention-empty-state` 无生产 TS/TSX 消费者，约 200 行直接删除；历史测试/文档字符串不作为 live owner。
- Channel/Normal/Teammate 的 Dock offset、placement、header clipping、rapid reversal 与 reduced-motion adapter
  继续在后加载 focused surface CSS 中，不通过 specificity 搬入 shared baseline。
- 新 owner 的颜色字面量、`!important`、Theme selector、`transition: all`、private keyframe、literal z-index 与
  package-private selector 命中为 `0`；`components.css 7,584 -> 7,085`。
- focused Summary/Evidence `9/9`、selected `152/153`，唯一 scroll timing failure 精确 repeat `2/2`；15 张
  原尺寸 Summary/Runs evidence、typecheck/lint/i18n/build/diff、console/pageerror/overflow 全绿。

## T13-O.14 Shared Conversation Work Cell Activity Owner

- `.conversation-work-cell-active/agent-stream`、Details/group、row/toggle/copy、CommandBatch、shell command、
  inline change preview 与 evidence links 由 720 行 `shared/conversation-work-cell-activity.css` 持有；
  `components.css` 中这些 source selector 命中归零。
- `.conversation-work-cell-final-report`、`.conversation-work-cell-empty`、旧 shell-card/main/topline/label/state/
  title/status/output 和 `.conversation-work-cell-agent-span-detail > small` 无生产消费者，共 `15 rules / 16
  branches` 直接删除；E2E 的 shell-card `toHaveCount(0)` 负断言不作为 live consumer。
- Artifact Strip 的 completed/reduced-motion branches 和跨 artifact/transcript 使用的 `conversation-settle-in`
  留在原 owner；`conversation-active-shimmer`、`conversation-locate-pulse` 随 WorkCell owner 迁移。
- 新 owner 的颜色字面量、`!important`、Theme selector、`transition: all`、literal z-index 和 package-private
  selector 命中为 `0`；`components.css 7,085 -> 6,259`。
- focused `5/5`、selected consumer `6/6`、完整 File Diff `4/4`；六张原尺寸截图、typecheck、keyboard、
  reduced-motion、console/pageerror 和 owner/document overflow 全绿。

## T13-O.15 Shared Conversation Work Cell Shell/Artifacts Owner

- `.conversation-work-cell` root、Operation Shell、Artifact/Reference、changed group、hover preview 与 Channel turn
  adapter 由 690 行 `shared/conversation-work-cell-shell-artifacts.css` 持有；`components.css` 中目标 source 命中归零。
- WorkCell rail、旧 head/kicker/summary、不可达 OperationBubble kind/copy/source/actions/action/section 与 artifact-row
  direct SVG 共 `25 rules / 30 branches` 删除；定义但无调用的旧组件不作为可达产品消费者。
- shared `conversation-settle-in`、通用 `.workspace-file-open-menu/popover`、O.14 Activity/Details 和 File Diff
  contextual adapter 原位保留；Reference Strip 的 Channel/Teammate 独立消费者纳入 focused/broad gate。
- 截图发现 `.workspace-file-open-trigger` 原 owner 已在旧迁移中断链；32px Artifact Row adapter 在新 owner 恢复，
  不新增全局 button patch，也不改 WorkspaceFileOpenMenu 行为。
- 新 owner 的颜色字面量、`!important`、Theme selector、`transition: all`、private keyframe、literal z-index 和
  package-private selector 命中为 `0`；`components.css 6,259 -> 5,434`。
- focused `3/3`、O.14/File Diff 组合 `12/12`、App/Channel/Teammates/Dark `147/147`；五张截图、
  typecheck/lint/i18n/build/diff、keyboard/hover/reduced-motion、console/pageerror/document overflow 全绿。

## T13-O.16 Channel Activity / Work Thread Owner

- `.activity-shell`、`.activity-filter-*`、`.activity-drilldown-*`、`.activity-triage-*` 与
  `.channel-work-thread-*` 由 556 行 `channel-activity-work-thread.css` 持有；`components.css` 与
  `strict-console.css` 的目标 visual selector 命中归零。
- `.channel-branch-empty` 两条、`.activity-saved-view-actions.compact`、`.activity-filter-chip.saved-view` 和错误的
  `.activity-view-select strong` branch 无生产消费者，删除；真实节点为 `span`。
- 跨模块 `.compact-icon-button`、`.activity-shell .message-feed`、`.activity-action-row`、
  `.activity-confirmation`、Conversation Block Action、Thread Reply 和 Runtime/Work History 原位保留。
- 白色/橙色字面量改为 surface/warning token，Drilldown 使用 `--ling-z-popover`；新 owner 的颜色字面量、
  `!important`、Theme selector、`transition: all`、private keyframe、literal z-index 和 package-private selector
  命中为 `0`，`components.css 5,434 -> 4,867`。
- 19 行 `channel-activity-controls.css` 未修改；focused 与既有 Input gate 直接量测 34px shell、focus 前后稳定和
  native top/bottom containment。Work Thread chrome 当前关闭，相关 selector 只以 CSS specimen 证明未来视觉状态。

## T13-O.17 Sidebar Foundation / Layout Owner

- expanded `.channel-left-drawer`、`.primary-nav/.nav-item`、`.sidebar-section-*`、`.sidebar-row-*`、
  `.sidebar-branch-*`、recent copy、channel avatar 和 Settings footer 由 737 行 `app/sidebar-layout.css` 持有；
  `navigation/layout/components/sidebar` 的对应 expanded source 不再共同参与 cascade。
- 旧 `.brand/.brand-mark`、`.sidebar-brand-button/mark/copy`、`.channel-sidebar-toolbar`、
  `.sidebar-inbox-alert`、drawer-scoped `.sidebar-hash/.status-dot/.channel-mention`、direct
  `.sidebar-row.selected` 与 unreachable `.sidebar-config/.config-grid` 在迁移 source set 中归零。
- generic bare `nav` 保留在 4 行 `navigation.css`；compact rail stack/preview、motion、`<=900px` duplication 和
  `app/sidebar-ui2.css` 明确保留给 O.18，不为追求 selector 归零破坏现有可达行为。
- 新 owner 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe、literal
  z-index 和 package-private selector 命中为 `0`；`components.css 4,867 -> 4,384`、`sidebar.css 1,816 -> 1,148`。
- focused + existing Sidebar `12/12`、broad `149/149`；十张截图、typecheck/lint/i18n/build/diff、keyboard、
  focus/reduced-motion、console/pageerror/document overflow 全绿。

## T13-O.18 Sidebar Compact Rail / Sections Owner

- 48px collapsed drawer、fixed top、primary navigation、three section rail bodies/previews/stacks、compact
  identity/action visibility、Settings footer 和 local hover/focus 由 396 行 `app/sidebar-rail-sections.css` 持有。
- `sidebar.css` 只保留 variables/keyframes、shell transition、expanded compatibility reset 与非 rail responsive
  layout；`<=900px` 内 broad `.channel-drawer-shell` compact family 和重复 command hover/first/last branches 已删除。
- 900px 初始 collapsed、Show navigation 后 240px expanded、再次 collapse 和 901px round trip 由 AppShell state
  决定；focused owner 不复制 expanded declarations，也不修改产品断点或 viewport hook。
- 新 owner 的颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe、literal
  z-index 和 package-private selector 命中为 `0`；`sidebar.css 1,148 -> 192`，Web CSS 为
  `155 files / 36,988 lines`。
- focused + existing Sidebar `16/16`、broad `149/149`；九张截图、typecheck/lint/i18n/build/diff、keyboard、
  rapid reversal/reduced motion、single Tooltip portal、console/pageerror/document overflow 全绿。

## T13-O.19 Model Workbench Legacy Writer Release

- `components.css` 与 `strict-console.css` 不再持有 Model Workbench 专属 repaint；Model 视觉由 632 行
  `features/model-workbench/*` focused cluster 和 shared Button/Input/Dialog/Menu/Table/Status/Feedback 持有。
- 18 个 dead Provider roots、旧 `td:nth-child(7)` 七列表格、旧 `.provider-sheet-header.panel-title`、
  `.provider-row-menu.open` 和 primitive 前 class branches 命中归零；75 个 focused Provider/Model roots均有生产消费者。
- `.provider-run-notice` 的五个 Channel/Runtime/Inspector 消费者和通用 `.status-badge.provider` 保留；
  `strict-console.css` 只通过最窄 `.provider-workbench-surface` exclusion 释放剩余 blanket，不复制旧视觉。
- focused cluster 的颜色字面量、`!important`、Theme selector、`transition: all`、literal z-index 和 dead roots
  命中均为 `0`；`strict-console.css 1,008 -> 682`、`components.css 4,384 -> 4,323`，Web CSS 净减 369 行至
  `155 files / 36,619 lines`。
- Model `25/25`、Settings/Dark `26/26`、broad `149/149`、八张截图与 static/build/diff/overflow gate 全绿；
  Function ID 与 packaged Desktop 状态不变。

## T13-O.20 Automations Legacy Writer Release

- `strict-console.css` 不再持有 Automations-specific repaint；现有 `automations/*` focused CSS 与 shared
  DataRow/Input/Button/Dialog/Inspector/Feedback 是真实视觉 owner。
- Eleven dead roots under the former `automation-*` legacy family were removed, including inbox/history/modal,
  create menu, row action/status and modal header branches; three live semantic
  DOM roots保留产品定位，但不再由 strict layer 正向着色。
- generic workspace/Dark 聚合规则只保留 `:where(:not(.workspace-automations-surface))` negative exclusion。
  `:where()` 将 exclusion specificity 归零，避免 plain `:not()` 强化非 Automations 页面 selector 并改变既有 cascade。
- focused owner 未新增 Theme Pack ID、颜色字面量、`!important`、`transition: all`、literal z-index 或
  package-private selector；`automations/page.css 111 -> 113` 仅补 root geometry，`strict-console.css 682 -> 584`，
  Web CSS 净减 96 行至 `155 files / 36,523 lines`。
- focused `6/6`、legacy `2/2`、正式联合 `8/8`、existing combined `68/68`、broad `149/149`、八张
  Light/Dark/imported Quiet Ocean 证据与 lint/i18n/typecheck/build/diff、dead/source/forbidden/overflow gate 全绿。
  Function ID 与 packaged Desktop 状态不变；完成后进入 T13-O.21 Teammates 候选，不得据此宣布 U13 或 UI 2.0 完成。

## T13-O.21 Teammates Legacy Writer Release

- 946 行 `teammates.css` 及其 import 已删除；legacy file/import 和 positive writer 引用为 `0`。旧 chip、toggle、
  composer、data-row、workspace hero/meta/tabs 与不可达 Council family 不再占据 cascade。
- `strict-console.css 584 -> 462`，positive strict Teammates repaint 为 `0`；`components.css 4,323 -> 4,313`，
  只移除 Teammates legacy branches，不改其他 aggregate owner。
- authoritative owners 为 `teammate-management-shell.css=59`、`shared/teammate-avatar.css=19`、
  `teammate-private-feed-composer.css=235`（`208 -> 235`）和 `conversation-message-frame.css=299`
  （`298 -> 299`）。shared Avatar 是唯一 base writer；54px default、34px compact、circle、`object-fit:cover`、
  border 和 fallback 在 Sidebar/Channel/Council/Profile/management/private 消费面保持一致。
- 新声明的颜色字面量、Theme/Profile selector、`!important`、`transition: all`、literal z-index 和
  package-private selector 命中均为 `0`。`conversation-message-frame.css` 既有十项 accepted exception 不由
  O.21 引入，也不在本切片扩大或重新分类。
- 新专项 `8/8`、focused selected `19/19`、全部 `ui2-teammate-management-*` `74/74`、跨模块 App/Channel/
  Teammates/Archive/Dark/Councils/Profile/Settings/Theme/Sidebar `171/171`；lint/i18n/typecheck/build/diff 全绿，
  build 仅保留既有 large-chunk warning。
- 八张 Light/Dark/Quiet Ocean 证据关闭 Input focus containment、Avatar cross-domain、Theme Pack、console/
  pageerror、document overflow 与 reduced motion。Web CSS 为 `156 files / 35,552 lines`。
- 本切片只关闭 CSS ownership，不提升 Function ID、不替代 packaged Desktop，也不关闭 U13/UI 2.0；下一步
  仅为 T13-O.22 aggregate candidate 只读审计。

## T13-O.22 Legacy Channel Tabs / Task Strip Writer Release

- `channel-tabs`、`channel-tab`、`channel-utility-tabs`、`channel-utility-tab`、`channel-tabs-row`、
  `channel-tabs-refresh`、`task-strip`、`client-task-main`、`composer-head` 和 `dock-card-head` 十个生产/E2E
  零引用 family 已从 `layout.css`、`components.css` 与 `strict-console.css` 删除，全仓正向 selector 命中为 `0`。
- `task-strip-head` 的 10 个生产消费者保持不变，唯一 CSS owner 迁入
  `channel-activity-work-thread.css 556 -> 575`；flex、alignment、10px gap、semantic text token 与长文案
  containment 均由 focused owner 持有，不新增 compatibility alias。
- `layout.css 1,063 -> 919`、`components.css 4,313 -> 4,269`、`strict-console.css 462 -> 457`；Web CSS
  为 `156 files / 35,378 lines`，净减 174 行。新声明的颜色字面量、Theme/Profile selector、`!important`、
  `transition: all`、literal z-index 和 package-private selector 命中均为 `0`。
- focused `3/3`、selected Runtime/Workspace/Dark/Theme/Input `43/43`、lint/i18n/typecheck/build/diff 与三张
  Light/Dark/Quiet Ocean 证据通过；共享 Input 专项另重跑 `4/4`，聚焦前后高度和 native containment 不回退。
- Channel full `104/105` 的唯一失败是既有 Tokenized Composer 连续 fill 偶发残留，独立 repeat `2/3`；本切片
  不改 Composer 或测试，已登记为独立行为稳定性候选。O.22 只关闭 CSS ownership，不提升 Function ID、
  不替代 packaged Desktop，也不关闭 U13/UI 2.0。

## T13-O.23 Run Guidance Legacy Writer Release

- `run-guidance-actions`、`run-guidance-submit-row`、`run-guidance-row-meta`、`run-guidance-input`、
  `run-guidance-list`、`run-guidance-row`、`run-lineage-banner`、`run-guidance-row-main` 八个生产零引用
  family 已从 `components.css` 删除；生产引用与 CSS writer 为 `0`，新 focused spec 各保留 1 个负向 absence guard。
- `.run-guidance-panel` 保持 `1` 个生产、`2` 个既有 E2E 消费者和唯一 CSS owner；4 行 owner 位于
  `styles/runs/guidance.css`，只持有 `display:grid` 与 10px gap，不复制 shared Inspector/Textarea/DataRow/Button。
- `components.css 4,269 -> 4,195`、`runs.css 8 -> 9`、新 owner 4 行；Web CSS 为
  `157 files / 35,309 lines`，净减 69 行。新声明的颜色字面量、Theme/Profile selector、`!important`、
  `transition: all`、literal z-index、package-private selector 和 compatibility alias 命中均为 `0`。
- focused ordinary/capture 各 `3/3`、Runs/Runtime `26/26`、selected `41/42`、broad `157/158`；selected 的
  Menu outside-click 独立 `1/3`，broad 的 Teammate membership 独立 `3/3`，均与 O.23 selector 无交集。
- 三张 Light/Dark/Quiet Ocean 证据证明 shared Textarea 聚焦前后几何稳定、长文本和 panel/document 无横向
  overflow；同时暴露既有 Runs intervention DataRow 身份/状态过密，已登记为后续内容布局候选。
- O.23 只关闭 CSS ownership，不提升 Function ID、不替代 packaged Desktop，也不关闭 U13/UI 2.0。

## T13-O.24 Media Workspace Root / Dark Repaint Ownership Release

- `.workspace.workspace-generation-surface` 只有一个 focused positive writer，位于
  `features/media-production/shell.css`；`strict-console.css` 的 Media positive writer 为 `0`。
- `workspace.css` 1 处、`layout.css` 3 处、`components.css` 1 处、Dark root 1 处、24 个 Dark descendant
  blanket 和 `app-shell-overlay-size.css` 1 处，共 31 个 selector branch 排除 Media。最后一项由首次 focused
  `0/3` 的 computed overflow 证据补出，不能继续沿用冻结阶段的 30 项估算。
- focused root 只声明 geometry 与 `--ling-bg-app` / `--ling-text-default`；未新增颜色字面量、Theme/Profile ID、
  `!important`、`transition: all`、literal z-index、package-private selector 或 shared control repaint。
- `strict-console.css 457 -> 439`、`media-production/shell.css 95 -> 104`，Web CSS 净减 9 行至
  `157 files / 35,300 lines`。Studio/Generation Tasks 有意移除 20px aggregate padding、root border/background/
  blur，成为 P10 canvas-first 定义的全幅工作区。
- focused ordinary/capture 各 `3/3`、selected `31/31`、broad final `64/64`；三张原尺寸证据覆盖非空 Canvas、
  Docks、Dark shared Textarea focus containment、Quiet Ocean Dialog、console/pageerror 和 overflow。
- O.24 只关闭 Web CSS ownership，不提升 Function ID、不替代 packaged Desktop，也不代表全部 raw input 已迁移
  或 U13/UI 2.0 已完成。

## T12.1b Legacy Nested Input Focus Follow-up

- Shared Input 仍由 package shell `focus-within` 持有，未发现全局组件 bug；raw-control 审计定位到 Activity 与
  Work Thread 的 `34px shell / 36px native input` 既有冲突。
- 19 行 `channel-activity-controls.css` 在 `strict-console.css` 后加载，固定 native `height:100%`、`min-height:0`
  并清除内部 border/outline/shadow；同一 selector 同时覆盖 Activity 与 Work Thread。
- MCP 与 Channel Create 的嵌套 raw search 只在其 focused owner 中补高度/native focus reset；Dark blanket
  排除这些局部 owner，不新增全局 `input:focus` 补丁。
- focused Input `4/4`、MCP `2/2`；Dark 1280 原图和 bounding-box 断言证明聚焦前后高度不变、native top/bottom
  位于 shell 内。T12.1b 当时未关闭其余 raw input；后续 T12.1c 已独立完成页面级迁移。

## T13-O.25 Channel Right Dock Aggregate Ownership Release

- `.task-workbench-main`、`.channel-side-panel-frame`、`.channel-side-panel` 和 resize handle 的正向布局/动效
  owner 迁入 `channel-right-dock/shell.css`；`components.css` 不再写入这些根 selector。
- package `.right-dock`、Header、Body、Launcher、Rows 和 icon controls 没有复制进 focused Web CSS，继续由
  `@ling-stack/conversation-ui-react` 持有 token background、border、排版和状态。
- `channel-side-panel-head/title/actions/nav/nav-item/body`、`channel-review-*`、Dock 内 management adapter 与
  `channel-files` 的生产引用和 CSS writer 为 0；最终 static scan 定位并删除 `layout.css` 中最后 12 行
  `.channel-files` writer，同时补入 focused absence guard，不保留 compatibility alias。
- focused owner 的颜色字面量、Theme/Profile selector、`transition: all`、literal z-index 和 shared repaint 为 0；
  resize cursor 的既有 `!important` 只保留在当前局部 selector。
- focused ordinary/capture `3/3`、selected `26/26`、broad `125/125`、Form `4/4` 和三张原尺寸证据通过。
  Shared Input 继续证明无全局 focus bug；当时剩余 raw input 后由 T12.1c 迁移，未使用全局 `input:focus` 覆盖。

## T13-O.26 Runs Intervention Row Productization

- `.runs-intervention-row` 从 `runs/run-detail.css` 的 generic grouped writer 迁到唯一
  `runs/intervention-row.css` owner；新增 Header/identity/state/instruction/disclosure/details/footer/actions family。
- selector 只命中 O.26 自有 public class/data attribute；没有 `.ling-ui-*` package-private selector、颜色字面量、
  `!important`、Theme/Profile ID、`transition: all`、keyframe 或全局 `input:focus`。
- Run Guidance 为 actionable consumer，Thread Evidence 为 read-only consumer；后者不再输出 `queue_followup` 等
  raw mode enum，也不接收 mutation callback。
- 六种状态通过纯 view-model 映射为 visible label + tone；长 instruction collapsed/expanded 使用 data attribute，
  expanded 内容最多 240px 内部滚动，document/row 横向 overflow 为 0。
- focused ordinary/capture `3/3`、selected `36/36`、broad `48/48` 和三张原图通过；Function ID、API、
  global DataRow/Input 与 packaged Desktop 状态不变。

## T13-O.27 Shared Message / Transcript Ownership Release

- package 通过 `[data-conversation-message-row]` 与 `data-has-avatar` 持有通用 Message frame；ActionBar 使用
  `.message-action-bar-*` 与真实 Radix Tooltip，不再写 `data-tooltip` 或伪元素 Tooltip。
- Channel live row/Turn/Transcript selector 迁入 `channel-message-transcript.css`；Normal 生产代码中的
  `channel-message-row` 引用为 0，Teammate 只保留 private surface adapter。
- `.conversation-message-tag`、`.channel-message-row-actions`、`.conversation-turn-segment` 在生产和 CSS 中为 0；
  `components.css`/`strict-console.css` 不再定义 generic Message/Action/Transcript visuals。
- strict Dark blanket 同时排除 message/Transcript root 与 subtree；focused owners 中颜色字面量、Theme/Profile
  selector、`!important`、`transition: all`、literal z-index、`.ling-ui-*` 和全局 `input:focus` 为 0。
- package `17/17`、focused ordinary/capture 各 `3/3`、三张原图与 static/build 通过。legacy E2E 仍有四条
  pseudo-tooltip/transparent-hover 合同和一条独立 Guidance Menu outside-click，生产代码不得为通过旧断言恢复 selector。

## T13-O.29 Legacy Workspace Prototype Hard-Dead CSS

- 28 个冻结 dead token 在 production/package/E2E/CSS writer 中为 0；没有 compatibility alias。
- `layout.css 907 -> 531`、`components.css 2,890 -> 2,856`、`strict-console.css 434 -> 421`；保留
  `pending-assets`、`mention-picker-popover`、`mention-suggestion`、`channel-option-actions` live branch。
- Web CSS 净减 423 行至 `160 files / 34,015 lines`；focused ordinary/capture `4/4`、broad `165/165`、
  三张原图、lint/i18n/typecheck/build/diff 全绿。
- 不新增颜色字面量、Theme/Profile selector、`transition: all`、z-index 或全局 `input:focus`。

## T13-O.30 Conversation Package Boundary Completion

- 删除 11 个无消费者 Web duplicate；barrel 继续从 package re-export，生产 direct stale import 为 0。
- Web `MessageBubble` 为 renderer adapter；Web `CopyActionButton` 为 15 行 i18n adapter。package 持有 copied
  state 和 Radix Tooltip，Channel Reply 同样使用 shared Tooltip；生产不再为这些 action 写 `data-tooltip/title`。
- package `18/18`、focused ordinary/capture `4/4`、broad `165/165`、三张原图和 static/build 全绿。
- Function ID、API、状态、Desktop 与 Logo 不变；O.30 时的剩余 raw input 后由 T12.1c 页面级迁移关闭。

## T13-O.31 Shared Conversation Composer Slot Ownership

- Package root 只输出 `.conversation-composer*` 与 `data-conversation-composer/data-surface/data-density`；
  `composer-panel`、`composer-drop-zone`、`composer-primary-actions`、`composer-tool-row` 在 production/package/CSS 为 0。
- `composer-options-panel`、`composer-preview-mention`、`pending-asset`、`composer-status-list`、
  `thread-resume-composer` 等 dead writer 为 0；Activity confirmation、Thread Reply、inspect/attachment、
  `ComposerFileReferenceToken`、pointer coarse 和 reduced motion live branch 保留。
- `conversation-composer-slots.css` 是 preview/picker/drop hint/attachment/file-reference selector family 的唯一
  Web owner。Teammate 只在 canonical root 设置公开的 preview-remove size variable，不再选择 shared child class。
- Channel、Normal、Teammate adapter 全部锚定 canonical data/class；strict generic Dark root/descendant/input/button/
  status blanket 排除 canonical Composer subtree。
- native input 清除 border、outline 与 shadow；package 和三个 focused root 的 focus ring 均为 inset，focus 前后
  shell/input-zone 高度不变。没有新增全局 `input:focus`、颜色字面量、Theme/Profile selector、`!important` 或
  `transition: all`。
- package `20/20`、focused ordinary/capture `4/4`、existing `18/18`、broad `165/165` 与三张原尺寸证据通过。

## T13-O.32 Plugin Manager Dark Blanket Ownership Release

- `.workspace.workspace-plugins-surface` 的 exact CSS owner 只有 `plugins/plugin-manager-shell.css`；final strict
  的 1 个 generic root 与 21 个 descendant selector 均包含 `.workspace-plugins-surface` exclusion。
- `plugin-cua-health.css`、其 global import 与 `.settings-plugin-token` 的生产/测试引用为 0；不保留 facade alias。
- InlineFeedback detail 暴露 `data-ling-inline-feedback-slot="detail"`；Plugin focused CSS 恰有两个 public slot
  selector，Feature CSS 对 `.ling-ui-inline-feedback-detail` 的命中为 0。
- Plugin focused CSS 不新增颜色字面量、Theme/Profile selector、`!important`、`transition: all`、private keyframe
  或 shared control chrome；strict 除 exclusion/dead token 外不改 selector payload。
- package `51/51`、focused ordinary/capture `4/4`、Plugin `17/17`、App/Dark/Theme `26/26`、Web release
  `12/12` 与三张原尺寸证据通过；Function ID 与 packaged Desktop/CUA 状态不变。

## T13-O.33 Channel Route Explanation Hard-Dead Selectors

- `channel-route-pill`、`channel-route-explanation`、`channel-route-explanation-toggle`、
  `channel-route-explanation-popover` 在 production/package/ordinary E2E/CSS writer 中为 0；focused spec 只保留
  exact negative guard，不建立 compatibility alias。
- `.channel-route-inspect-grid` 与 `.channel-route-inspect-section` 继续由 `components.css` 持有，并由
  `ChannelInspectorPanels` 真实消费；`.file-ref-chip`、`.channel-message-row-footer-stack` 与
  `.activity-shell .message-feed` adjacent live branch 未被误删。
- O.33 不新增颜色字面量、Theme/Profile selector、`!important`、`transition: all`、private keyframe、z-index
  或全局 `input:focus`；focused ordinary/capture `3/3`、selected `18/18` 和 static/build gate 全绿。

## T12.1c Page-Level Raw Text Control Cleanup

- 38 个可达 raw text controls 已迁入 shared Input/Textarea/Field；`components.css` 的 legacy input selector 仍只
  匹配 `:not([data-ling-control-native])`，没有新增全局 focus patch。
- `ChannelBriefEditor` 与 `ChannelExecutionProposalEditor` 从 978/1,639 行父文件中抽出；Feature CSS 只持有
  layout，不命中 `.ling-ui-*`，也不重绘 shared control chrome。
- `check-ui2-text-controls.mjs` 已进入 Web lint，当前固定为 `reachable=0, decision-gated=1/1`；关闭中的 Work
  Thread Search 是唯一显式例外，缺失或新增其他例外都会失败。
- focused/Form `22/22`、Header `8/8`、业务回归 `142/142` 和 16 张证据通过。该结果关闭文本标签与 focus
  双 owner，不代表 aggregate CSS、非文本 native controls 或 packaged Desktop 已完成。

## T12.1d Aggregate Native-Control Selector Closeout

- `components.css`、`workspace.css`、`layout.css` 和 package CSS 中 aggregate
  `input/textarea:not([data-ling-control-native])` exact selector branch 为 `0`；禁止恢复全局 `input:focus`。
- `check-ui2-text-controls.mjs` 同时阻止可达 raw text control 和未标记的 checkbox/file/range，当前输出
  `text reachable=0, decision-gated=1/1, native-owned=18`。
- scoped `.channel-path-field input`、MCP checkbox、Council checkbox、Avatar crop range、Image Compare range、
  hidden file picker 等真实 feature owners继续保留，不因 aggregate 删除而改造成错误的文本 primitive。
- 1280 Dark MCP 原图审查发现同一 server header 的 identity/action 碰撞；focused owner 增加 720px container
  stack，E2E 锁定 row 分离、tree containment 与 header rectangle collision 为零。
- package `70/70 + 23/23`、static ownership `2/2`、代表性浏览器 `38/38`、formal recapture `13/13`、
  lint/typecheck/i18n/diff 全绿；证据回写到既有 Form、Council 与 Raw Text Controls metadata。

## T13-P.2 Bounded Owner Cleanup

- `components.css 2,117 -> 1,963`：删除 23 个四象限零引用 root 和 154 行；相邻 live branch、
  `.channel-option-actions`、raw Input blanket 与 `.proposed-plan-*` 均由 focused absence/presence contract 保护。
- `strict-console.css 385 -> 335`：删除已失去消费者的文本输入/placeholder/disabled Dark repaint 以及
  `.settings-toggle/.policy-tool-row/.check-result*/.capability-list/.settings-page` 死叶子；Shared Input 的
  `focus-within`、inset ring、native marker 和 focused owner 未修改，背景/按钮/active/status blanket 保留。
- Sidebar `sidebar.css 192 -> 130`、rail `396 -> 350`、UI2 `209 -> 199`：只删除重复 transition、死 keyframe、
  无正向 owner reset、无法命中的 Collapsible fallback 和 write-only rail variables；240/48、900/901、滚动、
  hit area、Logo 与 Desktop chrome 保持。
- Council 唯一 `OperationEmptyState` consumer 直连 shared `EmptyState`，adapter/export/专属 selector 和 guard
  budget 归零。首次 1280 Dark 截图发现 action 文本裁切，最终由 public root class 的两列/窄屏单列布局修复，
  focused spec 新增 visible label non-clipping 断言。
- 组合 focused `15/15`、Sidebar `16/16`、Channel 390px 定点 `1/1`、App/Channel/Teammates/Archive/Dark/Release
  `161/161`，typecheck/i18n/lint/build/diff 全绿；Normal/Teammate Search、Sidebar 和 Council Light/Dark 原图重采。
  当前 Web CSS 为 `161 files / 33,364 lines`。本项不提升 Function ID，不替代 packaged macOS/Windows evidence。

## T13-P.3 Current Closeout

P.2 的 `161 files / 33,364 lines` 和本文件此前 O.25-O.33 的阶段数字继续作为历史证据保留；以下仅记录
当前共享工作树的 canonical mechanical snapshot：

- Web CSS 为 `163 files / 33,427 lines`；`components.css=1,881`、`workspace.css=713`、
  `layout.css=490`、`strict-console.css=335`、`sidebar.css=138`；
- `.proposed-plan-*` 已由 `channel-proposed-plan.css=80` 持有；Workflow、Step 与 linked Workflow/Run 的
  status placement 由 `channel-workflow-status.css=13` 持有；Runtime Diagnostics 与窄 Dock MetaRow containment
  由 `channel-runtime-diagnostics.css=128` 持有；Teammate MCP focused owner 当前为
  `teammate-management-mcp.css=313`；
- `SelectControl=0/0`、`CreateDialogShell=0/0`、`OperationEmptyState=0/0`；对应 component/export/生产调用
  均归零，`select-controls.css` 保持 deleted。`StatusBadge=1/1`，唯一 AppShell caller、adapter 与现有 CSS
  在 P3-Y 产品决策前保留，不得在 selector cleanup 中抢先删除；
- P.3 A-X 范围内已分配的 `A-H`、`J-L`、`N-X` 已完成；`M` 未分配，P3-I 负责主控整合，P3-Y 继续
  保持产品决策门。P3 foundation 的 `43/7/6/26`、P3-B 的 `16 calls / 4 roots`、既有测试结果、PNG、
  SHA-256 和 metadata 均不得按当前数字倒写；
- focused evidence 见
  [Channel Proposed Plan](../evidence/conversations/channel-proposed-plan/metadata.md)、
  [AppShell Geometry](../evidence/shell/app-shell-geometry-p3/metadata.md)、
  [Channel Workflow Status](../evidence/conversations/channel-workflow-status/metadata.md) 与
  [Runtime Diagnostics Status](../evidence/features/runtime-diagnostics-status/metadata.md)。

## T13-P.4 Legacy Readiness / Runtime Dead Families

- `workspace-readiness`、六个 `readiness-*`、`runtime-state-panel/list/list-row`、`check-result*`、
  `policy-tool-row`、`settings-toggle`、`tool-event-meta` 和 generic `capability-list` 共 16 个 exact class
  已从 production emitter 与 Web/package CSS writer 同时归零。
- Mixed selector 只摘除 dead branch；`first-run-flow/step`、`event-count`、`runtime-kpi-grid`、
  `runtime-policy-summary`、`runtime-audit-block`、`meta-list/row`、`tool-row`、`provider-run-notice`、
  `status-badge`、`plugin-capability-list` 均由新 presence gate 保护。
- `components.css 1,881 -> 1,802`、`workspace.css 713 -> 608`、`layout.css 490 -> 457`，Web CSS
  `33,427 -> 33,210`，净减 217 行；无新颜色字面量、global focus、z-index、keyframe 或 compatibility alias。
- 新旧 static `4/4`、selected `28/28`、capture `4/4`、lint/typecheck/i18n/build/diff 全绿；P3-Y 和
  First Run 可达性决策保持独立。
