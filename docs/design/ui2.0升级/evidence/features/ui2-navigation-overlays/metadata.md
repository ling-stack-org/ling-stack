# P1B Navigation And Lightweight Overlay Evidence

## Capture Context

- Date: `2026-07-18`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Commit: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use、P1A、P1B 和 UI 2.0 文档尚未形成 checkpoint commit
- Served artifact: real Vite dev server, not `dist`
- Server command: `corepack pnpm exec vite --host 127.0.0.1 --port 4174`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixture plus focused Automation and Control Plane read fixtures
- Test command: `corepack pnpm --filter @ling-stack/web test:e2e -- ui2-navigation-overlays.spec.ts`
- Result: `3/3` passed

## Screenshots

| File | Viewport | Theme | Locale | State |
|---|---|---|---|---|
| `1440x960-ling-light-settings-tabs.png` | `1440x960` | `ling-light` | `en-US` | Settings > Archived items，AI Teammates tab selected after keyboard navigation |
| `1440x960-ling-light-media-segmented.png` | `1440x960` | `ling-light` | `en-US` | Media Production，Production studio selected in shared SegmentedControl |
| `1280x800-ling-dark-automation-popover.png` | `1280x800` | `ling-dark` | `zh-CN` | Automation manual create，model Popover open above its trigger |

SHA-256:

```text
c57ab9e361478475581f47c338df6436afb333b651225712246be82e6ab5c8d8  1280x800-ling-dark-automation-popover.png
3cd5ca801bc0e90853dbd28db2f5f6975eb73bae479586af3ddfed37b007ee12  1440x960-ling-light-media-segmented.png
33d98d405d1ca4c4c495938648173143ede2c8a4e9edc4cfdc2ddb96cc7f17db  1440x960-ling-light-settings-tabs.png
```

## Interaction Evidence

- Settings Tabs：左右方向键切换 selection，active tab 重复点击不取消，切换前后高度稳定。
- Media SegmentedControl：方向键移动会同步选择视图，active item 重复点击不清空选择，切换前后宽高稳定。
- Automation Popover：Portal + collision positioning，内容位于旧弹窗之上，Esc 只关闭 Popover 并恢复 trigger 焦点。
- 打开另一个 Automation Popover 时，上一浮层关闭，页面只保留一个 `.automation-popover-panel`。
- reduced motion 下 Popover 的 `animation-duration` 为 `0s`。
- 三个状态均无文档级横向溢出，changed state 操作期间 console error 和 page error 为 `0`。

## Scope And Limitations

- 截图证明 Web P1B 的三个代表面，不代表全部 Settings tab、全部 Popover 或 Desktop surface 已迁移。
- 数据来自 mock daemon；布局、主题、键盘、Portal、focus、collision 和 console 证据是真实浏览器结果，业务数据不是生产数据。
- 三类会话 Summary popover 未在本切片迁移，继续归 P5/P6 会话共享控制器切片。
