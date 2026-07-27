# Icon 系统与功能映射

## Component Contract

```ts
type IconSize = "xs" | "sm" | "md" | "lg" | "xl";
type IconTone = "default" | "muted" | "success" | "warning" | "danger" | "info";

interface IconProps {
  icon: LucideIcon;
  size?: IconSize;
  tone?: IconTone;
  label?: string;
  decorative?: boolean;
}

interface IconButtonProps {
  icon: LucideIcon | ReactNode;
  label: string;
  tooltip?: string;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "secondary" | "danger";
  pressed?: boolean;
  loading?: boolean;
  disabled?: boolean;
}
```

`Icon` 统一 size、stroke 和 tone。`IconButton` 的目标输入是 `LucideIcon` component，例如
`icon={Search}`；组件内部统一渲染 `Icon`。`ReactNode` 只作为迁移兼容输入继续存在，禁止新代码使用
`icon={<Search size={16} />}`。IconButton 自动提供 `aria-label`、Tooltip、稳定 hit area 和 loading。
Feature 不直接渲染 Lucide 后再传 `size/color/strokeWidth`。

## Standard Action Map

| Product action | Lucide icon |
|---|---|
| Search | `Search` |
| Refresh / retry data | `RefreshCw` |
| Retry failed action | `RotateCw` |
| Add / create | `Plus` |
| Edit | `Pencil` |
| Save | `Save` |
| Delete permanently | `Trash2` |
| Archive | `Archive` |
| Restore | `ArchiveRestore` |
| Settings | `Settings` |
| More actions | `MoreHorizontal` |
| Close / dismiss | `X` |
| Back | `ArrowLeft` |
| Expand disclosure | `ChevronRight` |
| Collapse disclosure | `ChevronDown` |
| Open details panel | `PanelRightOpen` |
| Close details panel | `PanelRightClose` |
| Open bottom panel | `PanelBottom` |
| Close bottom panel | `PanelBottomClose` |
| Terminal | `SquareTerminal` |
| Run / generate | `Play` |
| Stop | `Square` |
| Pause | `Pause` |
| Upload | `Upload` |
| Download | `Download` |
| Copy | `Copy`，完成态临时 `Check` |
| External open | `ExternalLink` |
| Preview | `Eye` |
| Hidden | `EyeOff` |
| Success | `CheckCircle2` |
| Warning/error | `CircleAlert` |
| Information | `Info` |
| Loading | `Loader2` 或 CSS Spinner |
| User / teammate | `Bot` 或 Avatar，不混用普通 User 图标 |
| Council | `Brain` |
| Model/provider | `Box` |
| Plugin | `PlugZap` |
| Automation | `Timer` |
| Work Board | `Kanban` |
| File | `FileText` |
| Image | `Image` |

同一行动需要不同含义时，先修改产品文案，不通过随机换图标制造差异。

## States

- hover/focus 由 IconButton 改变 currentColor，不移动图标。
- active/pressed 使用 `aria-pressed` 和 selected surface。
- disabled 保持可辨识，不能仅设置极低 opacity。
- danger 仅 Delete 等真实危险操作使用。
- loading 保留按钮宽度和 label，图标替换为统一 spinner。
- success feedback 可短暂替换为 Check，结束后恢复原图标。

## Exceptions

语言、文件类型和品牌图标可以通过 `BrandIcon`/domain renderer 接入，不进入标准行动映射。
`LingStackLogo` 不通过 Icon 组件包装，也不受 stroke normalization。

## Test Contract

- SSR：ARIA、decorative、size、tone、loading。
- E2E：Tooltip hover/focus、32px hit area、disabled reason、`ling-light` / `ling-dark`、按钮基线。
- Guard：Feature 新增直接 `size/color/strokeWidth` 的 Lucide 使用时需迁移说明或领域例外。

## Current Implementation

T13-P.7-B 已建立共享 `Icon` foundation，当前 owner 为：

- `packages/ui-react/src/controls/Icon.tsx`：只接收 `LucideIcon`、五档 `size`、六种 `tone` 和
  accessibility mode；默认 `size="sm"`、`tone="default"`、decorative。
- `packages/ui-react/src/styles/controls/icon.css`：通过 `.ling-ui-icon`、`data-ling-icon`、
  `data-size` 和 `data-tone` 映射尺寸、stroke 与语义色。
- `packages/ui-react/src/index.ts` 与 `styles/index.css`：分别提供 package export 和
  `ling.primitives` layer import。

语义图标提供 `label`，可省略 `decorative` 或显式设置 `decorative=false`；渲染结果为
`role="img"` 和 `aria-label`。装饰图标不提供 `label`，默认输出 `aria-hidden=true`。组件在类型层和
运行时拒绝 `label + decorative=true`，也拒绝 `decorative=false` 但缺少非空 label。

`default` 保持 `currentColor`，由 Button、Menu、文本或其他 owner 决定实际颜色；其余 tone 只映射
Ling semantic tokens。尺寸和 stroke 固定为 `14/2`、`16/2`、`18/1.75`、`20/1.75`、
`24/1.75`，Feature 没有任意 px、color 或 strokeWidth API。

### T13-P.7-C IconButton typed compatibility

T13-P.7-C 已完成 package 边界内的 typed compatibility：

- `IconButton.icon` 接受 `LucideIcon | ReactNode`。官方 Lucide `forwardRef` component 走 typed path，
  内部通过共享 `Icon` normalization；React element、Portal 和普通 ReactNode 不会被误判成 component。
- typed path 输出 `data-ling-icon-button-contract="typed-lucide"`；compatibility path 输出
  `data-ling-icon-button-contract="legacy-react-node"`，可由测试、浏览器或迁移脚本机械统计。
- typed 与 legacy 两条路径共享原有 Button owner，因此 `aria-label`、Tooltip、loading、pressed、disabled
  和至少 32px hit area 行为不分叉。
- package-owned standard action 已迁移为 component prop：Dialog Close、Compact Desktop More、Theme
  Studio Preview toolbar、Dock Back/Collapse/Close 和 Conversation Guidance 行动作。
- 动态 Dock Collapse/Expand 先派生 `CollapseIcon` component，再传入 `IconButton`；不在 JSX 分支中创建
  带任意 `size/strokeWidth` 的 Lucide element。

Compatibility budget 冻结如下：

| Owner | Budget | Rule |
|---|---:|---|
| package-owned concrete `icon={<Lucide />}` call sites | 0 | 不允许回增 |
| `CurrentSessionCapabilityControl.actions[].icon: ReactNode` | 1 public seam | 按本切片约束保留；后续由独立 API 迁移关闭 |
| `IconButton` 及其纯透传 wrapper 的 legacy input | compatibility only | 只服务现有调用方；每次渲染必须带 legacy marker |

T13-P.7-D 继续负责 Web feature 标准行动迁移。Logo、favicon、Desktop icon 和品牌资产仍排除在 `Icon`
foundation 之外。

## Current Verification

- `corepack pnpm --filter @ling-stack/ui-react test`：`69/69` 通过，包含 typed/legacy SSR marker、Portal 与
  React element 隔离、loading/pressed/Tooltip/ARIA、package consumer guard，以及 Icon foundation 的
  accessibility、尺寸、tone 和样式合同。
- `corepack pnpm --filter @ling-stack/ui-react typecheck`：通过。
- `corepack pnpm --filter @ling-stack/ui-react build`：通过，声明、JavaScript 和 focused CSS 产物已生成。
- `corepack pnpm --filter @ling-stack/conversation-ui-react test`：`23/23` 通过，包含 Dock 动态图标与
  package consumer 无任意 icon geometry 断言。

### T13-P.7-D Web typed action status

- Channel、Normal Conversation、AI Teammate Chat 顶栏的 Search / Refresh / Summary / Terminal / Details，
  以及 Sidebar Toggle / More / Create / Archive 已传入 typed Lucide component。
- 三类会话 Feed、Composer、Channel Settings/Panel 和 Right Dock 的 22 个 IconButton 也已迁入 typed path；
  动态 Send/Stop、Collapse/Expand 先派生 component，不在 JSX 中生成任意尺寸图标。
- D3 又迁移 17 个页面级 owner 的 20 个标准 action：Media Jobs、Approvals、Runs/Threads、Work Board、
  Automations、Startup/Diagnostics、External Work、Personalization、Skill Governance、MCP、Model、Plugin、
  Teammate Management 和 Council List/Health。原 `label/loading/disabled/variant/onClick` 与 DOM owner 不变。
- D4 继续迁移 Provider/Model、MCP row、Automations row、Skill Library 与 Archived Items 共 14 个 owner、
  27 个标准 action。动态 MCP Details 直接传递派生的 Lucide component；受控 Menu -> Delete Dialog 顺序不回退。
- D5 关闭 Teammate、Council、Media Production、Plugin/Profile/Theme Package、Work Board 与 Workspace
  剩余 26 个 owner；Storyboard 的实心 `Play` 通过 focused CSS 保持 `fill: currentColor` 后也进入 typed path。
- D5 后独立审计又发现 3 个条件 JSX legacy action：Media Production 左右 Dock 和 CUA Copy/Check；
  现已先派生 Lucide component 再传入 IconButton。守卫改用 TypeScript AST 扫描实际 consumer，条件 JSX
  不再逃过检查，并自动对账 owner 集合。
- `apps/web/scripts/check-ui2-icons.mjs` 现冻结 78 个 Web IconButton owner，加 1 个 Profile Avatar identity
  ReactNode 预算；全 Web 标准 IconButton legacy 为 `0`。浏览器测试对顶栏、Sidebar 与上述页面入口断言
  `data-ling-icon-button-contract="typed-lucide"`，同时保留 32px、Tooltip、ARIA 和共享 Spinner 合同。
- D3 页面 Header selected regression `44/44`、Settings/management selected regression `51/51` 通过；MCP
  Menu -> Delete Dialog 的快速 Esc 顺序缺陷在集成运行中被复现并修复，修复后 exact repeat `5/5`。
- D4 integrated regression `27/27` 通过；D5 首轮跨模块组合 `123/125`，两个失败分别是已删除 strict
  selector 的陈旧精确计数和 Skills 权威 Registry 行加载时序。测试合同修正后相关 `20/20`、
  Composer/Input/Dark 补充 `13/13` 通过；进一步确认 Skills 根因是 mock state 复用共享 Skill definition，
  深拷贝隔离后最终跨模块联合 `129/129`。P.7-D Web 迁移已完成。
- P.7-F 又将中断后的 17 个 touched specs 修正并统一串行回归到 `122/122`；专用
  `ui2-icon-cross-module-evidence.spec.ts` 在 1440 Light 与 1280 Dark 覆盖 AI Teammate/Profile、Council、
  Plugin、Work Board、Channel 与 Media Production，ordinary/capture 均为 `6/6`，14 张原尺寸 PNG、SHA-256
  和 metadata 已目检完成。
- `UI-ICON-FOUNDATION-001` 与 `UI-ICON-MAP-001` 现为 `implemented` 且 Web evidence verified。P.7-E 与
  packaged macOS/Windows evidence 未关闭前，不把两个全局 ID 或整个 P.7 标记为 globally verified。
- 本切片没有替换或修改 Ling Logo、favicon、Desktop packaged icon、队友头像或产品/模型图片。
- `corepack pnpm --filter @ling-stack/conversation-ui-react typecheck` 与 `build`：通过。
- `git diff --check` 与允许文件边界复核：通过。
