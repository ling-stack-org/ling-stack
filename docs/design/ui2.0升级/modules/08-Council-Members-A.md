# Council Members A Product Contract

> Slice: `P8.2b`
> Function ID: `COUNCIL-MEMBERS-001`
> Product decision: Council Members A
> Status: `implemented / integration-gated`

## 1. Goal

Council Members A 将 Council 的成员配置收敛为一个安静、紧凑、可验证的 UI 2.0 surface。用户可以在
自定义 Council 中添加、移除、启停和调整成员顺序，并看到当前数据能够证明的 readiness。成员管理只改变
Council 的引用集合，不复制 AI 队友、不改变队友权限，也不直接改写频道成员关系。

本切片只陈述以下事实：

- `AiCouncilMember` 的成员身份、`enabled` 和 `position` 配置；
- 当前 AI 队友快照可以证明的身份与配置状态；
- `AiCouncilHealthReport` 可以证明的成员 readiness finding；
- Council 是否暂停，以及成员变更会影响所有引用该 Council 的频道投影。

`COUNCIL-RUNTIME-001` 继续保持 blocker。页面不得显示或推断成员正在运行、最近运行、执行顺序、成功率、
当前任务、并发槽位或运行来源。

## 2. Existing Capability Boundary

| Capability | Current truth | UI 2.0 decision |
|---|---|---|
| Load members | `GET /ai-councils/:id/members` 返回完整成员数组 | 作为成员列表唯一权威来源 |
| Add | 将新增成员与现有成员一起发送完整数组 | 自定义 Council 可用；新成员追加到末尾 |
| Remove | 从完整数组中删除目标成员后整体提交 | 仅自定义 Council 可用；提交前确认影响 |
| Enable / disable | 修改目标成员 `enabled` 后整体提交 | 自定义 Council 使用 `Switch`；关闭不会删除成员 |
| Reorder | 修改数组顺序并发送连续 `position` | 自定义 Council 使用上移/下移；它不是运行优先级 |
| Save | `PUT /ai-councils/:id/members` 原子删除并重写整组成员 | 每次只允许一个 mutation flight；响应替换本地列表 |
| Readiness | Health report 提供 member finding | 只显示可证明状态；不完整报告不能显示 Ready |
| Concurrency | API 没有 revision、ETag 或 conditional write | 提交前重读并比较 fingerprint；仍保留 GET-to-PUT 残余竞态 |
| Permissions | member payload 不接受 tools、approval 或 credential | Members surface 不出现权限、工具、模型或凭据控件 |
| Channel effect | effective Council 按引用实时读取 enabled members | 说明会影响引用该 Council 的频道；直接频道成员关系不变 |

### Managed Council boundary

- `source=user`：开放添加、移除、启停和排序。
- `source=builtin` 或 `source=template`：成员列表与 readiness 只读，显示 `Clone to customize`。
- 当前成员 API 没有 source 写保护，但内置 Development Council 会在 store bootstrap 时补回缺失的基线成员。
  因此 UI 不得向用户承诺内置成员可被永久移除，也不得继续暴露看似成功但重启后可能反转的编辑操作。
- 本切片不修改 API 或 bootstrap 语义；完整编辑通过现有 Clone 流程进入自定义 Council。

## 3. Page Structure

```text
Council detail
  Existing detail header and Health summary
  Existing Tabs
    Members
      CouncilMembersPanel
        MembersSummary
          enabled count / readiness evidence state
          Manage teammates or Clone to customize
        PersistentFeedback
          load / save / conflict / readiness refresh
        AddMemberRow (custom Council only)
          Select + Add member
        BoundedMemberList
          CouncilMemberRow
            avatar / identity / role
            one readiness StatusIndicator
            Move up / Move down / Enabled Switch / Remove
        RemoveMemberDialog
```

Members Tab 自己拥有垂直滚动边界。标题、反馈和 Add row 固定在列表上方；成员列表滚动时不带走这些区域。
页面不能用成员卡片墙，也不能把 readiness finding 展开成常驻说明墙。

## 4. Member Identity And Candidate Rules

### Row identity

- 主标题显示 AI 队友 `displayName`。
- 副标题只显示有区分价值的 role label；不得重复主标题。
- 头像复用真实 Teammate avatar；不得为 Council 生成第二套头像。
- 队友快照缺失时优先使用成员已有 `label` 或 `slotKey`，否则显示 `Unavailable teammate`。
- raw `teammateId` 不常驻默认层，只能进入 Tooltip、ARIA 或诊断详情。

### Add candidates

- 候选来自当前 workspace teammate 快照。
- 排除已在当前 Council 的成员、`hidden=true`、`status=disabled` 和 Ling Agent/system teammate。
- `status=active` 与 `status=paused` 均可选择；paused 候选在 Select label 中显示 `Paused`，添加后不会被误报为 Ready。
- Select 采用共享原生 `Select`，按 `displayName` 排序；首版不新增 Combobox 或自定义虚拟列表。
- 新成员发送 `slotKey=teammate.roleKey`、`enabled=true`、`position=current length`，不写入本地化 `label`。
  已有成员的 `label` 和 `slotKey` 在替换时原样保留。
- 没有候选时隐藏 Select，显示一行 compact EmptyState 和 `Manage teammates` 行动。

## 5. Readiness Evidence Model

### 5.1 Report completeness

只有同时满足以下条件，未命中 finding 的成员才能显示为 `Ready`：

1. report 存在且 `workspaceId` 与 Council 一致；
2. `generatedAt` 是有效时间；
3. `generatedAt` 不早于 `council.updatedAt` 和当前成员中最大的 `updatedAt`；
4. `report.findings.length` 不小于 summary 中三种 severity 的总和；
5. 当前 controller 不处于 mutation 后等待新 Health generation 的状态。

成员 PUT 不会更新 `council.updatedAt`，移除最后一个成员后也没有 member timestamp 可比较。因此每次 PUT
成功后 controller 必须显式标记 `readiness pending`，直到观察到晚于 mutation baseline 的新
`healthReport.generatedAt`。不能只依赖 Council timestamp 判断新报告是否覆盖成员变更。

### 5.2 Single member state

每行只显示一个主状态，优先级固定为：

```text
membership disabled
> explicit member finding
> readiness unknown / partial
> council paused
> ready
```

| State | Evidence | Tone | User copy |
|---|---|---|---|
| `disabled` | `member.enabled=false` | neutral | Disabled / 已停用 |
| `missing` | `teammate_missing` | danger | Teammate unavailable / 队友不可用 |
| `hidden` | `teammate_hidden` | warning | Teammate hidden / 队友已隐藏 |
| `inactive` | `teammate_not_active` | warning | Teammate not active / 队友未启用 |
| `excluded` | `system_teammate_excluded` | warning | System teammate excluded / 系统队友已排除 |
| `unknown` | report missing, stale, invalid, truncated or mutation pending | neutral | Readiness pending / 就绪状态待确认 |
| `ready_when_resumed` | complete evidence, no finding, Council paused | info | Ready after resume / 恢复后可用 |
| `ready` | complete fresh evidence and no member finding | success | Ready / 可用 |

若 partial report 已返回目标成员的明确 finding，该 finding 仍可显示；没有 finding 的其他成员保持
`unknown`。Panel 同时显示 `Readiness information is incomplete`，不能用局部 finding 证明其余成员 Ready。

### 5.3 Panel summary

- 完整证据：`{ready} ready · {enabled}/{total} enabled`。
- 不完整证据：`Readiness incomplete · {enabled}/{total} enabled`。
- Council paused：显示一条 neutral/info InlineFeedback，说明成员不会投影到频道；行仍显示底层成员问题。
- 空 Council：显示 `No council members`，Health 只在新报告明确返回 `council_empty` 后显示对应 finding。

## 6. Interaction Contract

### Add

- 选择候选后 `Add member` 才可用。
- 点击后锁定 Members mutation actions，Add 按钮原位 loading；Select 不改变尺寸。
- 保存成功后使用 PUT 响应替换列表、清空 Select，并恢复焦点到 Select。
- 保存失败保留选择与权威旧列表，显示 persistent InlineFeedback；不显示伪成员行。
- preflight 发现候选已被其他窗口添加时，不发送 PUT；更新列表、清空已存在候选并要求用户复核。

### Enable / disable

- 使用共享 `Switch`，label 为 `Enable {name} in council`；整行或控件 hit area 不小于 `32px`。
- 关闭只停止 Council projection，保留成员身份、顺序、label 和 slotKey。
- 开启只恢复 membership 配置；若队友 paused、disabled、hidden 或缺失，readiness 仍显示对应阻塞。
- mutation 期间只显示该行 saving，但所有成员 mutation controls 暂时 disabled，避免整组 PUT 相互覆盖。

### Reorder

- 使用 `ArrowUp` / `ArrowDown` 的 icon-only `IconButton`；首行上移、末行下移 disabled。
- 首版不提供 drag-and-drop，不新增私有 sortable interaction。
- 成功 payload 将数组归一化为连续 `0..n-1` position；服务器响应决定最终顺序。
- 用户可用键盘聚焦按钮完成相同行为；Tooltip、title、ARIA 中英文一致。
- 文案统一使用 `order`，禁止使用 `priority`、`execution order` 或暗示实际调度顺序的语言。

### Remove

- 只在自定义 Council 行尾显示 `Trash2` icon-only action，与 Switch 和排序操作保持视觉间隔。
- 点击打开 `Dialog size=sm`，明确：移除会停止该成员通过此 Council 参与所有已接入频道；不会删除 AI 队友，
  也不会改变直接频道成员关系。
- 移除最后一个 enabled member 时增加 `Council will have no enabled members` 警告。
- Cancel、Esc 和关闭恢复焦点；提交中禁止关闭、Esc、backdrop 和重复提交。
- 成功使用 PUT 响应更新列表并关闭；失败保留 Dialog 和成员列表，错误显示在 Dialog 内。

### Manage / clone

- 自定义 Council 显示次级 `Manage teammates`，显式离开当前 Settings tool surface。
- builtin/template Council 显示主要修复行动 `Clone to customize`，调用已验证的 Clone Dialog。
- 打开 Clone、切换 Council 或离开页面会关闭 Remove Dialog，并清除仅属于旧 Council 的 pending selection/error。

## 7. Authority, Races And Failure Ownership

所有 mutation 使用相同流程：

1. 记录当前 Council ID、权威 members fingerprint 和用户 intent；
2. `GET /members` 预检；
3. fingerprint 不同则更新到最新列表，显示 conflict InlineFeedback，不发送 PUT；
4. fingerprint 相同才应用 intent 并发送一个完整数组 PUT；
5. 使用 PUT 响应替换列表；
6. 触发现有 Council/Health refresh，并等待新 Health generation；
7. Health refresh 失败只将 readiness 标为 stale，不回滚已经成功的成员配置。

fingerprint 固定包含按 position 排序后的 `teammateId / slotKey / label / position / enabled`。API 没有
conditional write，因此步骤 2 与 4 之间仍存在残余竞态；文档和 UI 不得声称已经具备服务端冲突保护。

切换 Council 时，旧 GET/PUT 结果不能写入新 Council surface。Controller 使用 request sequence、Council
identity guard 和 mounted guard；同一 Council refresh 可保留权威旧行，跨 Council load 必须清空旧行并显示
稳定 Skeleton。

## 8. Reachable State Matrix

| State | Surface | Mutations | Repair |
|---|---|---|---|
| no Council selected | Parent empty state | none | Select Council |
| initial member load | 4 stable Skeleton rows | disabled | wait |
| Council switch loading | no previous Council rows | disabled | wait |
| loaded empty custom | compact empty + Add row | add enabled | Add member |
| loaded empty managed | compact empty + Clone action | read-only | Clone to customize |
| ready members | one readiness indicator per row | enabled for custom | normal actions |
| mixed disabled/blocked | truthful row states, one each | enabled for custom | Enable, Manage teammates or Remove |
| Council paused | panel InlineFeedback + row evidence | custom edits allowed | Resume in Settings |
| no add candidates | compact candidate empty state | existing row actions remain | Manage teammates |
| load failed, no snapshot | danger InlineFeedback + empty body | disabled | Retry members |
| refresh failed, rows retained | rows + stale marker | disabled to avoid stale replace | Retry members |
| add/save failed | old authoritative rows retained | retry available | Retry initiating action |
| preflight conflict | latest rows replace old snapshot | disabled until acknowledged/reviewed | Review and repeat action |
| post-save Health pending | saved rows + neutral pending status | member edits allowed after PUT settles | wait / Retry readiness |
| post-save Health failed | saved rows + warning stale feedback | member config remains saved | Retry readiness |
| report missing/stale/truncated | no false Ready | member config actions remain | Refresh readiness |
| remove confirmation | Dialog with impact copy | only confirm/cancel | Confirm or cancel |
| remove saving | Dialog locked, initiating action loading | all mutation controls disabled | wait / failure retry |
| long list / long zh-CN | internal scroll, ellipsis + title | actions fixed-width | keyboard and scroll |
| Dark / reduced motion | tokens and shared transitions | unchanged | no private animation |

## 9. Feedback, Motion And Accessibility

- 加载、保存、冲突和 readiness refresh 失败由 Members panel 或 Remove Dialog 的 `InlineFeedback` 拥有。
- 成功后的列表变化已提供明确结果，不额外显示 success Toast；不得同时出现 page success 和 Toast。
- 管理成员不创建新的 Toast viewport 或 Feature timer。
- DataRow hover/selected 使用共享 `120ms` transition；成员增删和排序不做逐行 stagger 或 FLIP 动画。
- Remove Dialog 使用共享 `180ms/120ms` enter/exit；reduced motion 由共享 package 归零。
- Tab 进入后焦点顺序为 Add Select、Add、列表行 actions；read-only Council 从 Clone action 开始。
- `Switch` 有状态语义，IconButton 有 Tooltip/title/ARIA；状态不能只靠颜色表达。
- `1280x800` 下动作区不折行、不覆盖 identity；文本列使用 `minmax(0, 1fr)`。

## 10. Module And CSS Ownership

- `council-members-view-model.ts`：candidate、fingerprint、intent payload、readiness evidence 和 row view。
- `useCouncilMembersController.ts`：load、identity guard、single-flight、preflight、conflict、PUT 和 Health pending。
- `CouncilMembersPanel.tsx`：summary、Add row、feedback、bounded list composition。
- `CouncilMemberRow.tsx`：identity、单一 readiness、Switch、排序和 Remove trigger。
- `CouncilMemberRemoveDialog.tsx`：影响说明、last-enabled warning、busy/error/focus。
- `council-members.css`：唯一 focused owner；旧 member selector 从 `councils.css` 删除。
- `CouncilWorkspacePage.tsx` 和 `CouncilWorkspacePanels.tsx` 只保留薄接线，不继续拥有成员请求和 mutation 逻辑。

新 production owner 必须少于 `400` 行；目标 controller 少于 `360` 行，单个 component 少于 `260` 行。
`CouncilWorkspacePage.tsx` 当前约 `538` 行、`CouncilWorkspacePanels.tsx` 约 `520` 行，本切片完成后两者都必须
净减少，不得以“接线”为名重新堆回成员行为。

Focused CSS 只使用 `.council-members-*` family 和公开 Feature root；禁止硬编码颜色、`!important`、
`transition: all`、私有 keyframe、raw duration/easing 或 package-private `.ling-ui-*` selector。

## 11. Verification Contract

- Static：Web typecheck、i18n、lint、UI2 import/overlay gate、touched-path diff check。
- Focused E2E：新增 `ui2-council-members.spec.ts`，覆盖本合同全部状态和 request payload。
- Regression：`councils.spec.ts`、`ui2-council-list-health.spec.ts`、
  `ui2-council-create-clone.spec.ts`、`ui2-settings-workspace-tools.spec.ts`、`dark-mode.spec.ts`。
- Browser：真实 Vite source server，`1440x960` 与 `1280x800`，Light/Dark、zh-CN/en-US，至少六张
  changed-state 原尺寸截图。
- Evidence：`docs/design/ui2.0升级/evidence/features/council-members/metadata.md` 记录 fixture、viewport、
  Theme、locale、PNG 尺寸、SHA-256、console、document/root overflow、list scroll owner、focus、reduced motion
  和 runtime-provenance 禁止项扫描。

## 12. Hard Stops And Non-goals

- 不新增或修改 API、contracts、Core store、数据库字段、migration、revision 或 provenance。
- 不改 Create/Clone、List/Health、Channels、完整 Settings、Archive/Restore 的业务语义。
- 不编辑成员的 label、slotKey、模型、skills、MCP、permissions、tools、approval 或 credentials。
- 不把成员排序描述为运行顺序，不显示 run、task、activity、success rate 或 last active。
- 不从一般 Runs、频道消息、更新时间或 enabled count 猜测 Council runtime。
- 不关闭 `COUNCIL-RUNTIME-001`；没有稳定 Council run provenance 前它继续是 blocker。
- 不回写 UI2 总控、覆盖矩阵、状态看板或其他模块文档；这些由集成 owner 在真实证据通过后处理。

## 13. Implementation Closeout

Council Members A 已按本合同完成生产实现、focused E2E 与真实 Vite 截图，证据见
[`../evidence/features/council-members/metadata.md`](../evidence/features/council-members/metadata.md)。

已完成：

- 自定义 Council 的 Add / Remove / Enable / Disable / Reorder 全部使用 GET preflight、fingerprint 比较与单一完整 PUT；
- PUT 响应成为成员 authority，Health 新 generation 单独决定 readiness；
- builtin/template 只读并进入既有 Clone 流程；
- missing/stale/truncated/post-mutation Health 不再误报 Ready；
- identity race、single-flight、Dialog close lock、Esc 与 focus return 已有自动化证据；
- `CouncilWorkspacePage.tsx` 和 `CouncilWorkspacePanels.tsx` 均净减少，新 production owner 全部低于 400 行；
- 六张 Light/Dark、双桌面尺寸 changed-state 原图已目检，console、overflow 和禁止 runtime provenance 审查通过。

当前不能标记 `verified`，只剩两个主集成门槛：

1. 本切片禁止修改共享 locale，`zh-CN` 尚缺六个合同文案 key，完整清单记录在 evidence metadata；
2. `councils.spec.ts` 与 `ui2-settings-workspace-tools.spec.ts` 仍要求 builtin Council 显示旧 Add/Manage/mutation surface，
   与本合同的 managed read-only 决策冲突，需由集成 owner 更新历史断言。

`COUNCIL-RUNTIME-001` 继续保持 blocker；本实现没有新增 runtime、task、activity、success rate 或执行顺序推断。
