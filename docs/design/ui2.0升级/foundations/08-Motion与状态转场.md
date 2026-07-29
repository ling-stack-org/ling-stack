# Motion 与状态转场

## Purpose

Motion 用于解释状态变化、保持空间连续性和确认用户操作，不用于装饰。UI 2.0 的点击、展开、
隐藏、切换、拖动和异步反馈必须使用统一 tokens，并允许用户快速反向操作。

## Baseline

当前 Web CSS 约有 103 处 transition、56 处 animation、22 组 keyframes、174 处 transform，
只有 9 个 reduced-motion 区块。Toast/Profile、Sidebar、Provider/Teammate sheets、Conversation
和 loading spinner 存在重复时长与 keyframes。

## Motion Tokens

```css
:root {
  --ling-motion-instant: 0ms;
  --ling-motion-fast: 120ms;
  --ling-motion-standard: 180ms;
  --ling-motion-slow: 240ms;
  --ling-motion-attention: 600ms;

  --ling-motion-continuous-spin: 900ms;
  --ling-motion-continuous-spin-reduced: 1800ms;
  --ling-motion-continuous-shimmer: 1400ms;

  --ling-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ling-ease-enter: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ling-ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --ling-ease-linear: linear;
}
```

Feature CSS 不得新增自定义 duration/easing。超过 `240ms` 的位移动画需要独立设计理由；
Toast 生命周期、异步超时和轮询间隔不是 motion duration。

`--ling-motion-attention` 只允许一次性的 Locate/Attention 高亮使用，不得用于 Drawer、Sidebar、
页面入场或持续 loading。高亮必须在 `animationend/animationcancel` 后清理 class；不得在业务组件里
复制同一毫秒数的 `setTimeout`。

三个 `continuous` token 只由共享 Spinner、Toast loading 和 Skeleton 消费，Feature 不得读取或重新声明。
它们是持续状态节奏，不适用于 enter/exit；reduced motion 下 Skeleton/shimmer 直接停止，Spinner 只能使用
统一的低频旋转。裸 `900ms/1800ms/1400ms` 只允许出现在 foundation token 声明中。

## Property Rules

- hover/focus：只动画 `color`、`background-color`、`border-color`、`box-shadow`、`opacity`。
- Overlay：优先 `opacity` 和 `transform`。
- Drawer/Sidebar/Bottom Panel：允许 grid track、width 或 height，但必须设置明确 min/max。
- 拖动过程中禁用 transition，直接跟随 pointer；pointer up 后才允许短 snap。
- 禁止 `transition: all`。
- 禁止动画大面积 blur、filter 和复杂 box-shadow。
- `will-change` 只在动画期间使用，不常驻列表项。

## Component Transition Matrix

| Component/state | Enter | Exit | Properties |
|---|---|---|---|
| Button hover/press | 120ms standard | 120ms standard | color/background/border/shadow |
| Tooltip | 120ms enter | 80-120ms exit | opacity + translateY 2px |
| Menu/Popover | 120ms enter | 120ms exit | opacity + translateY 4px |
| Dialog overlay | 180ms standard | 120ms exit | opacity |
| Dialog content | 180ms enter | 120ms exit | opacity + translateY 8px + scale .98 |
| Drawer | 240ms enter | 180ms exit | translateX |
| Tabs indicator | 180ms standard | same | transform/width |
| Tab content | direct or 120ms fade | direct | opacity only, no lateral slide |
| Disclosure | 180ms standard | 180ms standard | grid-template-rows + opacity |
| Toast | 180ms enter | 160ms exit | opacity + translateY 8px |
| Sidebar expand/collapse | 240ms standard | 240ms standard | grid track/width + label opacity |
| Right Dock | 240ms standard | 180ms exit | width/translateX |
| Bottom Panel | 240ms standard | 180ms exit | grid track/height |
| Summary reposition | 240ms standard | same | transform using dock width token |
| New message/work block | 120-180ms enter | none | opacity + translateY 2px |
| Locate pulse | 600ms once | none | outline/background opacity |
| Spinner/progress | continuous linear | stop immediately | rotation/progress only |

## Click And Async Feedback

- pointer down 使用 pressed state，不缩放按钮或造成布局移动。
- mutation 开始后只让触发控件进入 loading；防止重复提交，但保留 label 和宽度。
- 成功通过 Toast、状态或短暂 Check 反馈，不使用弹跳。
- 失败立即结束 loading，恢复可操作状态并显示 InlineFeedback。
- 新 loading 状态不能重播整个页面入场动画。

## Expand, Hide And Switch

- 可反向的 open/close 使用 CSS transition + Radix Presence，不用只支持单方向的 keyframe。
- 动画未结束时再次点击，以最新状态为准，从当前 computed position 反向，不先跳到终点。
- 不兼容 overlay 切换时先关闭当前，再打开目标；两个 Dialog 不重叠。
- Tabs 切换保留 TabList、焦点和容器尺寸，内容不横向飞入。
- 动态高度 disclosure 使用 grid wrapper；内容过长或异步变化时允许直接打开，不测量动画。

## Conversation Panels

Summary、Right Dock 和 Bottom Terminal 是独立状态。打开 Dock 时 Summary 继续挂载并通过
共享宽度 token 平滑位移；关闭 Dock 时反向移动。不得先隐藏 Summary 再从新位置出现。

拖动 Dock/Terminal 时设置 `data-resizing=true`，禁用 width/height transition。释放后保存
当前尺寸；超出 min/max 时最多使用 `120ms` snap。Resize 不应改变消息 scroll position。

## Lists And Streaming

- 列表加载不使用逐项 stagger，避免长列表延迟和性能问题。
- 流式 token 不逐字动画 opacity/transform。
- 新完成的 message/work block 可以单次 settle-in；状态更新不重复入场。
- 无限 shimmer 只允许 Skeleton 或唯一活动运行提示，离屏/完成后停止。

## Reduced Motion

`prefers-reduced-motion: reduce` 时：

- Dialog、Drawer、Popover、Tabs、Disclosure、Sidebar 和 panel 立即切换或只做不超过 `80ms`
  的 opacity。
- 禁止 translate、scale、smooth scroll、pulse、shimmer 和自动 reposition 动画。
- Spinner 改为静态进度图标 + loading 文案，或降为低频旋转。
- 拖动仍直接跟随 pointer，因为它是用户控制的空间反馈。

共享 package 提供统一 reduced-motion 规则；Feature 只补领域例外，不重复整套 media query。

## Cross-Platform

macOS 与 Windows 使用相同 motion tokens，不为 macOS 增加弹性/弹跳，也不让 Windows 使用
不同页面动画。窗口最小化、系统 transition 和 title bar 动画由 Electron/OS 管理。

## Performance And Acceptance

- 目标 60fps；动画过程中避免 layout thrashing。
- Playwright 验证 computed duration/easing、最终状态、rapid toggle 和 reduced motion。
- Drawer/Dock/Sidebar 记录开始、中间、结束或 bounding box。
- Browser console 无 ResizeObserver loop、React state update 或 focus warning。
- `transition: all` 保持为 0；最终第一方 keyframes 不超过 6 组。
