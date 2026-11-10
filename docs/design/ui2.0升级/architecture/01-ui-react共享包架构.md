# @ling-stack/ui-react 共享包架构

## Package Shape

```text
packages/ui-react/
  src/
    controls/
    overlays/
    navigation/
    feedback/
    data-display/
    desktop/
      capability-control/
      compact-window/
    theme/
      built-ins/
      presentation/
      compiler/
      generation/
      theme-registry.ts
      validate-theme.ts
      token-map.ts
    styles/
    index.ts
  scripts/copy-styles.mjs
  package.json
  tsconfig.json
```

Exports：

```text
@ling-stack/ui-react
@ling-stack/ui-react/styles.css
@ling-stack/ui-react/theme
```

## Dependency Direction

- peer：React、React DOM。
- direct：Lucide 和批准的 Radix packages。
- 禁止：API Client、Core、contracts、Web feature、i18n、router、localStorage、IndexedDB、Electron API。
- `conversation-ui-react -> ui-react` 允许；反向禁止。

## Component Rules

- Presentational props 和 callbacks，不读取业务 store。
- 使用 `forwardRef` 支持焦点和 Radix trigger。
- variant、size、tone 使用联合类型并映射到 `data-*`。
- `className` 只用于布局接入，不提供 unstyled 或绕过主题的 API。
- 可见文案由 props 提供。
- Theme 子模块拥有 Schema、内置 Theme Pack、registry、validation、semantic variable 映射与
  Presentation Profile registry，不拥有 Web/Desktop 持久化或 provider 调用。
  历史 Compiler 和 generation contracts 保留实现/安全测试，不作为当前产品入口。
- Theme Pack 不是 unstyled API；主题只能改变允许的 semantic tokens 与应用批准的组件外观参数。
- 新共享组件必须提供可由主题消费的外观参数和完整默认值，按[组件主题合同](../../component-theme-presentation.md)使用唯一外观入口。Feature 的 className 不能覆盖组件背景、边界、圆角、阴影或焦点。
- `desktop/` 只包含 browser-safe React 展示组件。它不能导入 Electron、preload API、IPC channel、
  Computer Use contracts、MediaStream controller 或 OS platform 判断。
- `CurrentSessionCapabilityControl`、`CompactDesktopWindow`、`CompactWindowHeader`、
  `CompactWindowStatusOverlay` 和 `CompactWindowActionMenu` 接收 view model 与 callback，不读取
  Desktop capability object。
- compact components 使用同一 Button、IconButton、Menu、Tooltip、Spinner、StatusIndicator 和
  InlineFeedback 实现，不建立 private primitive family。

## Build

TypeScript 输出 declaration 和 ESM；构建脚本复制 focused CSS 到 dist。Web 的 build、
typecheck 和 E2E 在编译 Web 前先构建 package。

## Test

- SSR 测试标签、ARIA、variant 和 loading 输出。
- Playwright fixture 测试 Radix 交互、焦点、键盘、全部内置主题与 reduced motion；
  历史自定义 Theme Pack fixture 只证明兼容/安全边界，不开放产品入口。
- Theme validator 测试缺失 token、非法 CSS value、reserved ID、未知 schema 和对比度 blocker。
- Theme Compiler 测试图片分析、token derivation、Profile allowlist、稳定输出和生成内容 guard。
- import guard 验证 package 不反向依赖应用。
- compact-window fixture 覆盖 `320x200`、长标题、所有 action state、keyboard、forced colors、
  reduced motion 和 custom Theme Pack。
- import guard 额外拒绝 `electron`、Desktop preload、Computer Use 和浏览器媒体生命周期依赖。
