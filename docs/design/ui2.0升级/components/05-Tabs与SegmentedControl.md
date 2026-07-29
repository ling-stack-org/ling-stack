# Tabs 与 SegmentedControl

## Implementation Status

`implemented`（foundation，2026-07-18）：

- `@ling-stack/ui-react` 已实现 `Tabs/List/Trigger/Content`，支持 `line/contained`、`sm/md`、
  controlled/uncontrolled、ARIA、方向键和水平 overflow；
- 已实现 required-single `SegmentedControl/Item`，active item 不能被重复点击清空；
- SegmentedControl 的方向键移动会同步选择，符合其 `radiogroup/radio` 语义；
- Settings Archived Items / Skill Library 已通过 `SettingsSubnav` adapter 使用共享 Tabs；
- Media Production 的 Production studio / Generation tasks 已迁共享 SegmentedControl；
- Settings 和 Media 旧按钮视觉 selector 已删除，legacy class 只保留短期 E2E/布局兼容；
- package suite `20/20`，P1B 专项 E2E `3/3`，目标回归 `34/34`。

证据：[P1B Navigation And Lightweight Overlay Evidence](../evidence/features/ui2-navigation-overlays/metadata.md)。

本组尚未标记 `verified`：当前只完成两个代表性业务 adapter；其余 Tabs、SegmentedControl、
长标签、自定义 Theme Pack 和 Desktop 证据随对应模块迁移。

## Usage

- Tabs 切换同一对象的独立任务页面，如 Profile/Model/Skills。
- SegmentedControl 切换同一任务的模式或视图，如 List/Canvas、Simple/Advanced。
- Theme Pack 选择不使用 SegmentedControl，使用 ThemePicker 和 Follow System Toggle。
- 不用按钮组模拟 Tabs，也不把页面导航伪装成 SegmentedControl。

## Dimensions

控件高度 `32/36px`。Tab label 可带 count，但 count 更新不得改变行高。窄空间优先水平
滚动或折叠次级 Tabs，不压缩文字为竖排。

## Behavior

支持 controlled/uncontrolled。Tabs 使用左右方向键，active state 同时有位置、文字和
ARIA，不只依赖颜色。切换时保留合理滚动位置，异步内容使用稳定 Skeleton。

SegmentedControl 使用 required-single 语义：已有选中项时重复点击不能清空；方向键移动焦点时
同时切换选择。业务页面不得把 `""` 当作第三种隐藏状态。

Indicator 使用 `180ms` transform/width。内容默认直接切换；需要视觉连续性时只允许 `120ms`
opacity，不使用横向飞入。快速切换以最后 value 为准，不等待前一动画完成。

## Deep-State Rule

每个 Tab 都是独立验收面，必须登记 empty、loading、error、details 和 Dialog。默认 Tab
通过不代表整个页面通过。
