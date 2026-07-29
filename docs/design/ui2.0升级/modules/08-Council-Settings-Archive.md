# Council Settings / Archive Product Contract

> Slice: `P8.2e`
> Function ID: `COUNCIL-SETTINGS-001`
> Product decision: reuse the current Council PATCH capability only
> Status: `verified`

## 1. Goal

Council Settings / Archive 将自定义 Council 的名称、描述、置顶和 lifecycle 设置收敛为一个紧凑、可恢复、
可验证的 UI 2.0 surface。Archive 是当前唯一真实的 destructive Council capability；Danger 区不得出现
不存在的 Delete，也不得借 UI 新增 restore、runtime、permission 或治理能力。

本切片完成后，用户可以：

- 查看自定义或 managed Council 的真实设置边界；
- 修改自定义 Council 的名称、描述和置顶状态；
- 在脏草稿、保存、失败和 reset 之间保持可预测状态；
- 暂停或恢复自定义 Council；
- 在共享 Dialog 中确认归档，并看到 busy、failure 和 focus restore；
- 克隆 builtin/template Council 进入既有自定义流程。

## 2. Authority And Capability Boundary

| Capability | Current authority | UI decision |
|---|---|---|
| Name / description / pinned | `PATCH /ai-councils/:id` | `source=user` 可编辑，响应成为新 authority |
| Pause / resume | 同一 PATCH 的 `status` | 仅在 `active` / `paused` 间切换 |
| Archive | 同一 PATCH 的 `status=archived` | 共享确认 Dialog；成功后从 active list 移除 |
| Channel cleanup | Core 在 archive 时解除全部 channel policy 引用 | 不在前端伪造第二次 cleanup，也不猜测引用数量 |
| Managed boundary | `source=builtin/template` 的 Core 写保护 | 只读摘要 + 既有 Clone；零 PATCH |
| Delete | 无 API、contract 或 Core capability | Danger 区不渲染 Delete |
| Restore archived Council | PATCH technically accepts lifecycle, but no current reachable IA/list | 不新增入口，不伪造 Archived Items 支持 |
| Runtime | 当前无稳定 Council run provenance | `COUNCIL-RUNTIME-001` 继续 blocker |

不新增 API、contract、数据库、migration、route、`ViewId`、Settings IA、状态字段或 runtime 来源。

## 3. Surface Structure

```text
Council detail / Settings tab
  CouncilSettingsPanel
    Header: source boundary
    Managed feedback OR editable settings form
      Field + Input name
      Field + Textarea description
      Switch pinned
      Save + Reset
      persistent mutation failure
    Lifecycle action
      one visible lifecycle state
      Pause OR Resume
    Council boundaries InspectorSection (collapsed by default)
    Clone action
    Danger zone
      managed read-only feedback OR Archive trigger
  CouncilArchiveDialog (Portal)
    selected Council identity
    Archive confirmation
    failure feedback
    Cancel + Archive
```

Settings tab 自己拥有一个内部纵向滚动边界；1280px 下表单改为单列，按钮保持横向且不覆盖长文本。
Dialog body 是 overlay 内唯一滚动 owner。

## 4. Settings Draft Contract

Controller 同时持有当前 authority 与 draft。脏状态只比较：

```text
displayName.trim / description.trim / pinned
```

- 默认：draft 来自选中 Council，Save/Reset disabled。
- dirty：任一字段变化后 Save/Reset enabled；名称 trim 后为空时 Save disabled，draft 仍保留。
- saving：只让 Save 进入 loading；Reset、lifecycle、Archive 和其他 Council mutation 暂时 disabled。
- success：PATCH 响应同时更新 authority、draft 和当前 Council projection；全局 success Toast 使用既有 `Saved` key。
- failure：authority 不变，dirty draft 完整保留，错误在表单内持续显示。
- reset：恢复 controller 当前 authority，并清除 settings failure；不发请求。
- 同 ID 外部刷新：若 draft clean，跟随新 authority；若 dirty，保留用户 draft，并以新 authority 重新计算 dirty。
- Council identity 变化：清空旧 busy/error/Dialog，draft 切换到新 Council。
- 旧 identity 的延迟响应不得写入当前 surface。

PATCH 成功后的列表 refresh 是 projection repair，不得把 refresh failure 冒充为保存失败。已保存响应继续作为当前
projection；Health/List 仍按现有 snapshot 完整度呈现，不为本切片新增第二套 refresh 状态。

## 5. Lifecycle Contract

- 自定义 active Council 只显示 `Pause council`；自定义 paused Council 只显示 `Resume council`。
- lifecycle mutation 使用独立 busy，不借用 Save loading 文案。
- 成功响应更新当前 projection；Health 随既有 refresh 重新取得，不推断运行事实。
- 失败保留现有 lifecycle 和 settings draft，错误持续显示在 lifecycle action 内。
- managed Council 不显示可点击 lifecycle action，只显示 read-only boundary 和 Clone。
- archived 响应不继续保留在 active list，也不显示伪造的 restore action。

每个 action surface 只有一个主状态；Health、lifecycle 和 mutation failure 不合并成多枚互相竞争的状态徽章。

## 6. Archive And Danger Contract

Archive trigger 只对 `source=user` 且 `status=active|paused` 的 Council 可用。

- 点击 trigger 打开共享 `Dialog size=sm`，默认 focus 在 Cancel。
- Cancel、Close、overlay click 和 Esc 关闭 Dialog，并恢复 trigger focus。
- 确认期间 Dialog `busy=true`：关闭按钮、Esc、overlay、Cancel 和重复提交均被锁定。
- archive failure 保留 Dialog、选中 Council、settings draft 和 channel policy，错误显示在 Dialog 内。
- archive success 使用 PATCH 响应投影 `archived`，关闭 Dialog，active list 选择下一项并触发现有 refresh。
- trigger 因成功归档卸载时，focus 回退到 Council 搜索输入；不得落到 body。
- Core 负责解除频道引用；focused fixture 必须证明 policy 被清理且 direct teammate channel membership 不变。
- builtin/template 显示 managed read-only Danger 边界与 Clone，不发送 PATCH。
- Danger 区不渲染 Delete 按钮、删除文案或不可逆删除警告。Archive 不是永久删除。

当前 locale 没有 Council archive consequence 专属句子。本切片不修改 locale，也不硬编码中英文；Dialog 只使用
现有 `Archive council`、Council identity、`Archived`、`Cancel` 等真实 key，不声称不可逆或可恢复。

## 7. Diagnostics, Feedback And Accessibility

- `Council boundaries` 使用共享 `InspectorSection`，默认闭合；source、routing、capacity 和 governance notes
  不进入默认主层。
- raw ID、workspace ID、timestamp、request body、runtime guess 不常驻页面。
- Settings/Status/Archive failure 分别靠近发起 owner 使用 `InlineFeedback`，不会被 success Toast 掩盖。
- Save success 使用全局单一 Toast；lifecycle 与 archive success 由可见状态/list change 表达。
- Form 使用共享 `Field/Input/Textarea/Switch`；placeholder 不替代 label。
- 按钮使用共享 `Button`；Archive 使用 `Archive` icon，不使用 Trash/Delete icon。
- Dialog 由共享 Portal/focus trap/Esc/presence owner 提供；Feature 不直接导入 Radix。
- reduced motion 不新增 Feature animation、keyframe 或 duration。

## 8. Managed, Protected And Archived Boundaries

Council schema 没有独立 `protected` boolean；真实 protected/managed 边界就是 `source=builtin|template`。UI 必须
把它显示为只读治理边界，且零 mutation。不得把前端 disabled 误写成服务端授权证明，真实拒绝仍由 Core 保底。

`status=archived` 是 lifecycle 事实，不是 delete。当前 active list 不加载 archived Council，所以成功归档后的真实
结果是从当前 surface 消失；本切片不新增 archived catalog、restore tab 或 Settings Archived Items 类型。

## 9. Module And CSS Ownership

- `council-settings-archive-view-model.ts`：draft、dirty、managed、可用性和状态纯函数。
- `useCouncilSettingsArchiveController.ts`：authority/draft、identity guard、PATCH、Toast、Dialog 和 focus。
- `CouncilSettingsPanel.tsx`：Settings、Lifecycle、Inspector、Clone 和 Danger composition。
- `CouncilArchiveDialog.tsx`：Portal confirmation、busy/failure 和 focus restore。
- `council-settings-archive.css`：唯一 Settings/Archive/Danger domain selector owner。
- `CouncilWorkspacePage.tsx`：只实例化 controller、维护 response projection 并传递薄 props。
- `CouncilWorkspacePanels.tsx`：Settings tab 只渲染 focused panel/dialog，不再内联表单逻辑。

全部新增 production owner `<400` 行。`CouncilWorkspacePage.tsx`、`CouncilWorkspacePanels.tsx` 保持低于 400 行；
`councils.css` 删除 Settings/Archive legacy selector，不复制 owner。

## 10. Verification Contract

- Focused：`ui2-council-settings-archive.spec.ts` 覆盖 default/dirty/reset/save/saving/failure/retained、lifecycle、
  managed/template、archive Esc/focus/busy/failure/success、policy cleanup、no Delete、raw folded、100-row/long text、
  Chinese、Light/Dark、1280 overflow、keyboard 和 reduced motion。
- Regression：`councils.spec.ts`、`channel-archive.spec.ts`、`ui2-settings-workspace-tools.spec.ts`、
  `settings.spec.ts`、`dark-mode.spec.ts`，以及已 verified Council focused specs 只做回归。
- Static：Web typecheck、check:i18n、lint、touched diff check 和 focused CSS forbidden scan。
- Evidence：真实 Vite source server；1440x960 / 1280x800，Light/Dark，en-US/zh-CN changed states；原尺寸
  RGB PNG、逐张原图检查、SHA-256 和 metadata。

## 11. Hard Stops And Non-goals

- 不新增 Delete、Restore、Archived catalog、bulk action 或新 IA。
- 不修改 API、contracts、Core、DB、route、`ViewId`、AppShell 或 locale。
- 不改变 Create/List/Members/Channels verified owner、业务语义、测试和证据。
- 不从 Council/member/channel/update time 推断 run、task、approval、success rate 或 runtime provenance。
- 不关闭 `COUNCIL-RUNTIME-001`。
- 不更新总控、全局覆盖矩阵、E2E 矩阵、状态看板或全局 README；主线程在 verified 后统一登记。

## 12. Implementation Closeout

- Focused view-model/controller/presentation/Dialog owners have been implemented without API、contract、database、route、
  `ViewId` or locale changes.
- Save、lifecycle and archive treat the mutation response as authority; projection repair cannot turn a successful
  mutation into a false mutation failure.
- `council-settings-archive.css` is the sole Settings/Lifecycle/Archive/Danger owner at 314 lines；`councils.css`
  retains only the 45-line shared detail skeleton.
- Focused `7/7`、selected Council/Settings/Dark regression `66/66`、UI package `51/51` and all Web static gates passed.
- Six original-size Light/Dark、1440x960/1280x800、en-US/zh-CN changed-state screenshots and SHA-256 hashes are
  recorded in [`../evidence/features/council-settings-archive/metadata.md`](../evidence/features/council-settings-archive/metadata.md).
- `COUNCIL-SETTINGS-001` is `verified`. `COUNCIL-RUNTIME-001`、Council Delete/Restore IA and packaged Desktop remain
  explicitly outside this closeout.
