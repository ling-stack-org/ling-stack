# Settings Shell

## Goal

Settings 是独立管理工作区。左侧 Settings navigation 和右侧任务内容共同构成 shell；除
`Back to app` 和显式 `Open ... in app` 外，Settings 内操作不得切回主应用 Sidebar。

## Function Points

- `SETTINGS-SHELL-001`：12 个入口、分组和 active state。
- `SETTINGS-CONTENT-001`：内容宽度、滚动和错误。
- `SETTINGS-BACK-001`：返回应用。
- `SETTINGS-SUBNAV-001`：Skill Library 与 Archived Items 的页面内部 Subnav。
- `SETTINGS-OVERLAY-001`：当前可达 Dialog/Menu 留在 Settings context；未来 Drawer/Popover 必须重新登记。
- Run Diagnostics 的细粒度行为由 `modules/settings/08-Startup与Diagnostics.md` 中
  `SETTINGS-DIAG-OPEN/LIST/DETAIL/EXTERNAL-001` 负责；旧粗粒度 `SETTINGS-DIAG-001` 已删除，避免重复计数。

## Layout

左侧固定宽导航，右侧 `minmax(0,1fr)`。导航和内容各自滚动，不出现主应用 `Ling Stack
navigation`。页面不重复导航 label 为大标题；内容从当前任务开始。

## States

initial section、deep link、loading、page error、embedded tool、run diagnostics、return、long
list。当前 modal 打开时 section navigation 不可达；关闭 overlay 后切 section 不得无提示清除未保存表单。

## Components And Tests

PageShell、DataRow、Tabs、InlineFeedback、Dialog、Menu。`settings.spec.ts` 必须遍历 12 个入口并
断言 shell boundary；`dark-mode.spec.ts` 验证滚动、灰字和主题。

## P7A.1 Shell Foundation

Status：`verified`（2026-07-20）。

Function IDs：`SETTINGS-SHELL-001`、`SETTINGS-CONTENT-001`、`SETTINGS-BACK-001`、
`SETTINGS-BOUNDARY-001`。

当前基线：

- `SettingsPage.tsx` 470 行，同时拥有 section registry、导航 JSX、active mapping 和 12 个领域面接线；
- `settings.css` 3,137 行，Shell、section、Skill、Archived、Diagnostics 混在同一文件；
- Settings fullscreen ownership 仍有 32 行留在 `sidebar.css`，形成跨模块 CSS owner；
- Return 与 section item 仍是手写 button，尚未使用共享 Button 的尺寸、focus 和 reduced-motion 合同；
- `settings.spec.ts` 已超过 1,000 行，P7A.1 新状态进入 focused spec，不继续扩张旧文件。

目标边界：

```text
SettingsPage
  section/domain state and callbacks
  -> SettingsShell
       independent navigation scroll owner
       shared Button section actions
       independent content scroll owner
       Back to app boundary
       children / embedded tool / diagnostics slot
```

- 新增纯展示 `SettingsShell.tsx`，不得 import API、domain、AppShell、Settings section 实现或 i18n store；
- section ID、item/group 类型和静态 registry 进入 focused model，`SettingsPage` 只派生 active section 并接线；
- 保留 `.settings-layout/.settings-section-nav/.settings-content-stack` compatibility class，同时增加稳定
  `data-ui2-settings-shell`、`data-settings-section` 和 `data-settings-content-state`；
- Return 与 12 个 section action 使用共享 `Button variant=ghost size=sm`；Feature CSS 只能使用公开
  `data-ling-button-slot`/CSS variables，不命中 `.ling-ui-button-*` 内部 class；
- navigation 与 content 必须各自滚动，document 不滚动；`1440x960`、`1280x800` 和 `980x680` resize
  不产生横向溢出或丢失 active item；
- embedded Model/Teammate/Council 和 Run Diagnostics 继续留在同一 Settings Shell，主应用 Sidebar 不出现；
- 切 section 继续关闭不兼容 workspace tool/diagnostics；本切片不改变未保存表单的业务策略；
- 新增 `settings-shell.css`，迁一组删一组；不得复制 selector、硬编码颜色、Theme Pack ID、
  `transition: all`、`!important` 或私有 keyframe。

P7A.1 不新增 package `PageShell`。当前共享 primitives 已足以组合 Settings feature shell；只有至少两个
非会话页面出现完全相同的壳层合同后，才评估 package 抽象。

专项测试：`ui2-settings-shell.spec.ts` 覆盖 12 个入口、唯一 active、Back exact return、embedded tool、
run diagnostics、代表性 page error、Light/Dark、三种 viewport、双滚动 owner、共享 Button、console 和 overflow。
真实证据进入 `evidence/settings/settings-shell/`。

### P7A.1 Closeout

- `SettingsPage.tsx` `470 -> 329`，Shell 展示责任进入 `SettingsShell.tsx` 和
  `settings-shell-model.ts`；领域 panel、active/embedded/diagnostics 派生仍留在页面 adapter。
- 12 个 section action 与 Back 使用共享 Button，并具有稳定 `data-settings-*` 语义、唯一
  `aria-current=page` 和不小于 32px 的 hit area。
- `settings-shell.css` 211 行，是 fullscreen、navigation 和 content scroll 的唯一 focused owner；
  `settings.css` `3,137 -> 2,914`，`sidebar.css` `1,849 -> 1,816`。
- focused `2/2`、Settings/会话合同 `23/23`、完整 selected regression `65/65` 通过；四张真实 Vite
  截图覆盖 1440 Light、1280 Dark 和动态 980x680 resize。
- 证据：[P7A.1 Settings Shell Evidence](../../evidence/settings/settings-shell/metadata.md)。

本 closeout 只验证 `SETTINGS-SHELL-001`、`SETTINGS-CONTENT-001`、`SETTINGS-BACK-001`、
`SETTINGS-BOUNDARY-001`。Subnav、overlay、运行诊断深层状态和各 section 继续保持 open。

## P5 Subnav / Overlay Reachability Closeout

Status：`verified`（2026-07-26）。本节是 P7A.1 之后的证据对账，不改 production。

- `SettingsSubnav` 真实消费者只有 Skill Library 与 Archived Items；default、badge、keyboard、category
  memory、overflow、Light/Dark、reduced motion 和 i18n 已由两个 focused spec 及 Navigation Overlay
  regression 覆盖。无生产 consumer 的 `description` prop、类型、selector、locale 和旧 negative 断言已删除，
  后续不得重新用灰色说明补回默认层。
- Settings context 机械审计为 19 组 Dialog、4 组 Menu、0 Drawer、0 Popover。现有 Settings focused specs
  覆盖 open/Esc/focus restore/busy dismissal/retained error/nested/overflow/Dark/reduced motion/i18n。
- modal 打开时 section switch 不可达；details/Inspector 是 inline disclosure，不重复计入 overlay 生命周期。
- `SETTINGS-SUBNAV-001` 与 `SETTINGS-OVERLAY-001` 按真实可达合同进入 verified。未来新增 Settings
  Drawer/Popover 或非模态 section switch 时，必须新增 Function state 与 changed-state evidence。
