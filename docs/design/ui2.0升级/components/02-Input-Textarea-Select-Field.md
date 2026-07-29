# Input、Textarea、Select、Switch 与 Field

## Structure

Field 统一渲染 label、required、control、description 和 error。生成稳定 id，并通过
`aria-describedby` 关联 description/error。错误出现时 description 可保留，但不得重复。

## Controls

- Input/Select 高度 `36px`，compact `32px`。
- Textarea 最小 `88px`，允许垂直 resize；Dialog 中受 body 高度约束。
- padding `8px 10px`，字号 `13px`；compact 单行控件使用 `20px` 文本 line-height，不能把 line-height
  拉高到接近 `32px` shell，否则原生 caret 会在视觉上贴住或穿过边框。
- Select 首版使用原生 select 和统一 chevron，不模拟复杂 listbox。
- 支持 prefix/suffix slot，但不能让装饰图标抢占输入空间。

### Switch

- 二元偏好使用 `Switch`，不使用带 `On / Off` 文本的自定义 checkbox，也不使用两个按钮模拟。
- Switch 由 `@ling-stack/ui-react` 封装 Radix Switch；Feature 只传 `checked`、`disabled`、
  `loading`、`aria-label` 和 `onCheckedChange`。
- track 建议 `32x18px`，thumb `14px`，但整行或独立控件 hit area 不小于 `32px`。
- label 位于 Switch 左侧并作为主要点击目标；必要说明只写限制或后果，不重复标题。
- 即时生效设置成功后静默；保存失败回滚到权威值，并在当前 Field/row 显示 InlineFeedback。
- Desktop-only Switch 在 capability bridge 不存在时整行不渲染，不能在 Web 中显示无效控件。

## States

default、hover、focus、filled、placeholder、checked、disabled、read-only、invalid、loading。Focus
不能增加外部尺寸；搜索输入聚焦后不得溢出 header。普通视觉模式使用 shell 内描边，禁止用向外扩张的
`outline-offset` 或 `0 0 0 2/3px` 外阴影伪造焦点环；系统 `forced-colors` 可保留平台高对比度轮廓。
除 bounding-box containment 外，还必须检查原生 caret 的视觉高度；compact Input 的文本 line-height 至少比
shell 高度小 `8px`，不能用满高 line-height 伪造垂直居中。

## Copy

Placeholder 不能替代 label。description 只解释格式、限制或后果。用户名等不可编辑值使用
只读文本，不伪装成 disabled 输入框。

## Validation

字段错误贴近字段，提交级错误使用 InlineFeedback。中英文最长标签下不挤压控件，
1280px 下多列表单按文档断点改为单列。

## Current Implementation

Status：primitive `implemented`，全产品迁移进行中。

```text
packages/ui-react/src/controls/Input.tsx
packages/ui-react/src/controls/Textarea.tsx
packages/ui-react/src/controls/Select.tsx
packages/ui-react/src/controls/Field.tsx
packages/ui-react/src/styles/controls/form-controls.css
```

- Input 支持 prefix/suffix、invalid、read-only、loading 和 `32/36px` 尺寸；
- Input 的焦点只由外层 `focus-within` 持有；内部 native input 显式清除 border/outline/box-shadow，防止
  旧裸 `input`、`input:focus` 和 Dark blanket selector 形成第二层焦点框或超出固定高度；
- shell 的普通 focus ring 使用 `inset` 内描边，边框、阴影和背景像素均不得超出 shell bounding box；
  迁移期裸 Input/Textarea 的全局 focus 规则与仍存的 feature focus owner 必须遵守同一约束；
- shared Input、Textarea、Select 与 Checkbox 的原生节点共同使用公开的 `data-ling-control-native`
  兼容边界；文本 Input 额外保留 `data-ling-input-native` 供业务查询。迁移期内 `workspace.css`、`components.css`、
  `layout.css` 和 `strict-console.css` 必须排除通用 marker，U13 再删除旧全局 owner；
- Textarea 使用 `88px` 默认最小高度和垂直 resize；
- Select 保持原生 `<select>`，共享 chevron/loading、完整点击高度和 focus owner；
- Field 用稳定 id 连接 label、description、error、required 和调用方已有 `aria-describedby`；
- P3 foundation 的历史基线是 `SelectControl` 作为 Web compatibility adapter，让 43 个既有调用点先消费
  共享 Select；该数字只记录阶段证据，不代表当前调用量；
- T13-P.3-R canonical closeout：`SelectControl` component、barrel export、生产引用和专属 CSS 已全部删除，
  guard 最终为 `0/0`。所有原调用方直接使用 shared `Select`；Channel Create 的两个下拉框直接使用
  `Select size="md"`，不再经过 Web facade；
- Settings Skill Governance 与 External Work 已迁移为真实 Field/Input/Select 用例。

Evidence：`ui-react` 51/51，`settings.spec.ts` 17/17，`ui2-form-controls.spec.ts` 4/4；focused Input/Select
几何断言覆盖 focus 前后高度不变、native border/shadow 为零、边界位于 shell 内且 shell shadow 为
`inset`。T12.1b 额外覆盖 Activity/Work Thread `34px shell / 36px native input` 的 legacy 嵌套冲突：
局部 focused owner 必须在最终 strict cascade 后清除内部 border/outline/shadow，不能再用全局 input patch。
2026-07-24 截图复核又发现三类会话 Header Search 虽通过几何断言，但 feature CSS 曾把 native line-height
设为 `30px`，造成 caret 视觉贴边；现已恢复 `--ling-line-sm` (`20px`)，并由 Normal/Teammate 双主题
focused spec 锁定 `line-height <= shell height - 8px`。这不是 shared Input 的全局尺寸缺陷。
T13-O.31 又以三类会话 Composer 的真实长文本、附件、slash/mention 和三主题状态验证同一合同：native
border/outline/shadow 为 0，focus 前后 shell/input-zone 高度不变，focused ring 为 inset。该证据只覆盖
Composer subtree 在 O.31 时不能替代页面级迁移；T12.1c 现已将审计确认的 38 个 reachable raw text controls
全部迁入共享组件。AST lint 当前锁定 `reachable=0, decision-gated=1/1`；唯一 Work Thread Search 因功能关闭
继续保留在显式 inventory，不能据此恢复功能或把非文本 file/checkbox/range 改成伪文本组件。
Textarea/Checkbox
通过同一 native-control marker 与 package contract 防止旧全局 input/textarea selector 重新接管视觉，
见 [UI Form Foundation Evidence](../evidence/settings/ui-form-foundation/metadata.md)。Input/Textarea 的
旧 `.field` selector、非文本原生控件和 feature form CSS 仍按 U13 owner 清理；T12.1c 只关闭可达文本标签与
focus 双 owner，不据此标记全产品 forms 或 packaged Desktop `verified`。证据见
[T12.1c raw text controls](../evidence/features/raw-text-controls/metadata.md)。
