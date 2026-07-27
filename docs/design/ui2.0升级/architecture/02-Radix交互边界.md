# Radix 交互边界

## Approved Packages

- `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`
- `@radix-ui/react-popover`
- `@radix-ui/react-tooltip`
- `@radix-ui/react-tabs`
- `@radix-ui/react-toggle-group`
- `@radix-ui/react-toast`
- `@radix-ui/react-slot`

首版 Input、Textarea、Select 使用原生控件，不引入 Radix Select。

## Ownership

Radix 只负责 focus、keyboard、portal、dismiss 和 ARIA primitive。Ling 组件负责 Props、
视觉、文案、尺寸、动效和状态语义。Feature 页面只能使用 Ling wrapper。

## Overlay Rules

- 所有 Portal 使用统一 z-index tokens。
- Dialog/Drawer 支持 controlled open，关闭原因必须回到调用方。
- Dropdown Menu 不承载复杂表单；复杂配置使用 Popover 或 Dialog。
- Tooltip 只用于补充标签，不承载阻塞原因或危险后果。
- busy/destructive 状态通过 wrapper 控制 outside/Esc dismissal。

## Guard

新增脚本扫描 `apps/web/src`、Desktop renderer 和其他 packages。除 `ui-react` 外出现
`@radix-ui/` import 即失败。
