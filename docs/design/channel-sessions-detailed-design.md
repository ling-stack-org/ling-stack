# 频道下多会话详细设计

Status: product and architecture contract; isolated packaged persistence verified on 0.1.3; final repair candidate and landing pending
Owner: repository maintainers
Last verified: 2026-10-30 (real packaged migration, independent history/drafts, archive/restore and normal quit/restart on isolated 0.1.3; final repairs pending)
Document type: explanation and contract reference
Canonical replacement: 本文拥有频道下多会话的产品入口、独立会话语义与兼容方案；补充
Conversation Surface Taxonomy 和 Continuity v2，不替代 timeline、执行或审批协议。
Code and test anchors: 见“实现前基线与交付入口”和“实现边界与验收”。

Related docs:

- [实现计划](channel-sessions-implementation-plan.md)
- [界面线框与导航](#45-界面线框与导航)
- [交互状态与反馈](#47-交互状态与反馈)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [会话级完全访问确认](conversation-session-full-access-confirmation.md)
- [Multi-Channel Concurrency](multi-channel-concurrency.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Managed Worktree Lifecycle](managed-worktree-lifecycle.md)

## 1. 目标与范围

频道作为长期项目或工作场景的容器，用户在频道下新建多个会话，分别推进具体事项。
频道管理共享配置，会话管理对话连续性。用户可以回到任一会话继续工作。

采用用户提出的“类似 Codex 项目下多个会话”的层级关系：频道是容器，会话是日常工作的
入口。产品名称继续使用“频道”；界面沿用 Ling 现有侧栏、对话区和右侧工作面板。

本文定义交付目标。实现进度由[实现计划](channel-sessions-implementation-plan.md)追踪；设计本身不代表功能已通过运行或发布验收。

首版包括：

- 频道下的默认会话和多个具名会话；创建、重命名、切换、归档及恢复。
- 独立的历史、上下文压缩、草稿、流式回复、未读标记与运行状态归属。
- 共享频道配置与资料的明确边界，以及审批、任务和产物的来源定位。
- 现有频道主聊天、频道分支、链接和 API 的兼容。

首版保持现有普通对话和队友私聊入口。跨频道移动会话、自动合并会话、按会话配置队友阵容、
为每个会话自动创建 worktree、全新分叉 UI 和跨会话引用选择器留在后续范围。
已有分叉能力继续遵循原契约。

## 2. 实现前基线与交付入口

以下记录设计时已有基础；实现状态与验证结果以实现计划为准。

| 证据 | 设计时已有基础 | 本次实现落点 |
| --- | --- | --- |
| [ChannelBranch 类型](../../packages/core/src/workspace-types.ts) | 保存 `channelId`、名称、生命周期和 `rootThreadId` | 保留兼容目录，产品入口使用“会话”语义 |
| [频道路由](../../packages/daemon/src/features/channels/routes.ts) | 创建分支时创建 `LingThread`；支持列表、重命名、归档和恢复 | 创建与配套元数据修改需统一事务、幂等和来源规则 |
| [线程解析](../../packages/daemon/src/features/channels/conversation-thread-resolution.ts) | 可按显式 thread 选择频道对话 | 新会话需要明确的独立 surface 分类 |
| [侧栏](../../apps/web/src/features/navigation/SidebarNavigation.tsx) | 有创建分支、子列表、切换和归档入口 | 需要频道容器行、默认会话行及会话状态 |
| [上下文来源](../../packages/daemon/src/features/channels/context-processing/sources.ts) | 已按 root、branch、topic 等类别选取对话来源 | 所有 projector、摘要和检索路径需覆盖独立会话 |
| [线程存储](../../packages/core/src/storage/sqlite/ling-thread-store.ts) | `LingThread` 保存标题、状态、归档与连续性；未显式指定时，`channel_discussion` 默认归为 `work` | 不能把现有创建路径直接视为新会话语义已完成 |
| [Continuity 迁移](../../packages/core/src/storage/sqlite/continuity-v2-legacy-import.ts) | 历史频道分支可归为 `branch` 并保留导入 lineage | 必须区分历史兼容记录与真正从某轮分叉 |
| [侧栏状态投影](../../apps/web/src/app/sidebar-status-projections.ts) | 当前主要按频道聚合运行、审批和未读 | 需增加 thread 粒度，不能读取频道即全部已读 |
| [完全访问 scope](../../apps/web/src/app/full-access-confirmation-scopes.ts) | 当前频道身份使用 channel/root 或 channel/branch | 目标统一为 channel + canonical thread 身份 |

已阅读 [channel workspace 测试](../../packages/daemon/test/channel-workspace.test.mjs) 中的
分支生命周期与历史筛选案例。实现以隔离的 `origin/main` 工作区为基线，原工作区 WIP 保留。
源码行为、自动化验证、真实界面和发布包验收分别记录，不互相替代。

## 3. 产品模型与命名

```text
工作区
├── 普通对话
└── 频道：Ling 开发              共享设置、目录、队友与资料
    ├── 默认会话               原频道主聊天，保留历史
    ├── 登录问题排查           独立对话
    ├── 频道界面优化           独立对话
    └── 发布准备               独立对话
```

| 概念 | 用户看到的名称 | 职责 |
| --- | --- | --- |
| `Channel` | 频道 | 长期协作容器、共享配置和频道级汇总 |
| 频道主线程 | 默认会话 | 原有主聊天的持续入口 |
| `ChannelBranch` 兼容记录 + `LingThread` | 会话 | 频道中的具名对话；`LingThread` 是会话身份 |
| 带真实 fork lineage 的线程 | 会话，可显示分叉来源 | 保留来源轮次和快照的对话延续 |
| `Topic` | 话题回复 | 消息下的局部讨论，留在所属会话内 |
| Git branch / worktree | Git 分支 / 工作树 | 代码版本与文件隔离，独立于会话命名 |

侧栏和频道设置中的相关“频道分支”改称“会话”；Git 分支、运行分支、队友并行分支和真正的
分叉操作保留各自名称，不做全局字符串替换。

### 共享与独立边界

| 内容 | 频道共享 | 会话独立或来源关联 |
| --- | --- | --- |
| 工作目录、worktree 绑定 | 由频道持有 | 首版不另存执行目录 |
| 默认模型、队友、工具与运行策略 | 由频道持有 | 每次执行仍保存实际生效快照；不复制配置 |
| brief、protocol、正式 decisions、已批准共享记忆 | 按原有权限与预算共享 | 私聊和其他会话原始历史不随配置进入 |
| 消息、Turn、上下文 segment、滚动摘要 | 不汇成全频道历史 | 按 canonical `threadId` 保存与检索 |
| 草稿、附件待发送队列、滚动位置、分页游标 | 不共享 | 以 workspace/channel/thread 为 key |
| Task、Run、Approval、Artifact、MediaJob | 频道可汇总查看 | 沿真实 `threadId` / `turnId` / `runId` 关联定位 |
| 完全访问确认、运行时审批 | 保留原策略 | 确认与决策仅作用于原会话及真实执行对象 |
| 已读位置与执行提示 | 频道可显示汇总 | 每个会话单独计算 |

多个会话仍可能修改同一目录。会话隔离不产生文件隔离；继续遵循频道并发预算、路径锁、
审批和 managed-worktree 生命周期。切换会话不会绕过写锁，也不会自动清理或切换 Git 分支。

## 4. 核心交互

### 4.1 频道与侧栏

频道行负责展开/收起会话列表，提供“新建会话”和“频道设置”。“新建会话”是常显、可键盘聚焦的核心动作，不能依赖鼠标悬停才可点击。点击频道名称进入上次访问的
可用会话；首次进入默认会话。展开按钮只展开，不改变当前选中会话。
上次会话已归档、丢失或不属于该频道时，回退默认会话，并给出轻量提示。

列表将默认会话固定在顶部，其余按最近真实对话/执行活动降序排列，以 ID 稳定打破同时间排序。
更改名称、读取、状态恢复和维护写入不应把无新活动的会话推到顶部。
流式 token 不逐字重排侧栏；会话首次新增消息或产生新的工作活动后再刷新排序。
频道折叠后仍显示聚合的待处理和未读提示。

默认展示最近 10 个具名会话，其余通过“查看全部会话”在频道内展示可搜索、可分页列表。
列表状态明确区分加载中、空、失败、已归档；失败时保留现有内容并支持重试。

### 4.2 新建空白会话

1. 点击频道旁“新建会话”，打开该频道的新会话草稿，默认名“新会话”。此时尚无 Run 或付费请求。
2. 用户可输入名称；留空则在首条消息成功后用用户文本首行生成标题，折叠空白、最多 40 个字符，
   无可用文本时保留“新会话”。手动命名后不再自动覆盖；标题生成不调用模型。
3. 首次发送前，先幂等创建持久会话，再通过现有 Turn API 发送。响应丢失时重试同一个创建 key。
4. 创建成功但发送失败：保留会话、草稿、附件与错误，重试同一首条消息 key，不重复创建会话。
5. 未发送即离开：作为按频道保存的一个本地新会话草稿，下次“新建会话”可恢复；不制造空数据库记录。

标题来源保存为线程元数据中的 `placeholder`、`first_message` 或 `manual`。自动标题只允许将
`placeholder` 原子更新一次；与手动重命名竞态时保留手动结果。已有历史名称迁移为 `manual`。
草稿沿用现有本地存储策略；附件保存可恢复的上传引用。尚未上传的本地文件在会话切换期间保持
内存引用，刷新后无法恢复时提示重新选择，不能把失效附件当作已发送材料。

持久会话的首条消息成功前，默认权限仍需按有效 scope 确认；本地草稿身份升级到线程身份时，
只允许同一创建请求的一次性确认迁移，不允许复制其他会话确认。
新建空白会话没有 parent turn、fork snapshot 或其他会话的历史。

### 4.3 切换与后台运行

- 标题区显示“频道名 / 会话名”，频道设置与会话菜单分开。
- 切换前按身份保存草稿和附件；切换后加载目标会话，保持各自滚动位置与分页边界。
- 切换不会停止后台 Run；运行提示留在原会话，完成后向原会话写入结果与未读提示。
- 流式事件按源 workspace/channel/thread/turn/run 定位。A 切到 B 后，A 的延迟响应不得投影到 B；
  后端继续保存 A 的结果，返回 A 时重新读取历史。相同 channel/thread ID 也不能跨工作区投影。
- 发送、停止、追问、重试、编辑与审批操作捕获点击时的目标身份，不能在异步结束时重新读取当前选中项。
- “停止”只停止所选会话已明确匹配的运行；多个运行时沿用现有选择/队列规则。
- 会话内保留现有队友协作、typed transcript、工具过程、审批和产物展示能力。

### 4.4 重命名、归档和恢复

新 sessions 接口的名称去除首尾空白后要求 1–120 个 Unicode 字符，可重名，以 thread ID 区分。
旧记录与旧 branches 接口沿用原名称限制，不截断历史名称；新界面缩略显示长标题时可查看全文。
手动重命名同步更新标题来源与兼容记录，不改变消息、上下文或最近真实活动时间。

具名会话归档后从活跃列表隐藏，在该频道“已归档会话”中查看及恢复；恢复沿用原 ID 和历史。
归档前若存在 queued/running dispatch、未终结执行或待决审批，返回明确冲突，用户处理后再归档。
归档与发送并发时在同一状态检查边界裁决，不能归档后仍接受新 Turn；已有终态 dispatch
也不得通过重试重新进入队列，恢复原会话后才允许重新准入。

默认会话首版不提供单独归档和删除，避免旧 root 调用自动重建出第二个默认历史入口。
其名称可修改，“默认”标识保持不变。归档整个频道继续沿用频道现有生命周期规则；恢复频道
不能把原本单独归档的子会话全部恢复。

首版会话菜单提供重命名，以及按状态显示的归档或恢复。历史分支永久删除 API 保留既有兼容行为，不新增会话永久删除
入口，也不把永久删除包装为归档。后续若开放删除，需另定引用保留与审计语义。

### 4.5 界面线框与导航

下图为结构线框，表示目标交互，不是已运行界面截图；按钮和状态图形使用现有共享组件。

```text
侧栏                             主工作区
┌──────────────────────────┐    ┌────────────────────────────────────────────┐
│ 频道                     │    │ Ling 开发 / 登录问题排查      [会话菜单] │
│                          │    ├────────────────────────────────────────────┤
│ [展开] Ling 开发  [+] [⋯] │    │ 当前会话的消息、工具过程、审批与产物      │
│   默认会话        默认   │    │                                            │
│ > 登录问题排查    运行中 │    │                                            │
│   频道界面优化    未读   │    │                                            │
│   发布准备       待审批 1│    ├────────────────────────────────────────────┤
│   查看全部会话           │    │ 当前会话的输入与附件                [发送] │
│                          │    └────────────────────────────────────────────┘
│ [收起] 客户支持  [+] [⋯] │
└──────────────────────────┘
```

频道行保持容器层级：展开控件、频道名称、新建会话按钮、频道菜单各自独立命中，不互相
触发。频道菜单拥有频道设置、频道改名与频道归档；会话菜单拥有当前会话的操作。
展开按钮使用 `aria-expanded`，新建按钮名称为“在 {channelName} 中新建会话”。

会话行缩进一级，显示会话名称、可选“默认”标识和紧凑状态；只给当前会话完整选中样式。
其所属频道可保留弱层级提示。标题区显示频道与会话两个层级，长名称缩略且可获取全文。
运行状态与未读可同时显示；空闲不显示状态徽标，常态行不叠加时间戳、模型和工作目录。
重命名、归档等次要动作放在会话菜单，键盘聚焦时同样可访问。

10 条具名会话预览之外，若当前会话不在预览内，则在默认会话之后保留一个当前会话行，
与预览按 ID 去重。它不挤掉最近 10 条，也不修改服务端排序；避免从全部列表打开旧会话后
侧栏丢失选中项。临时新会话草稿也仅保留一行，并显示“草稿”，不计入持久会话数量。

新会话主区使用现有 composer，不先弹出必填名称对话框：

```text
Ling 开发 / 新会话

开始一个新会话
此会话使用频道的设置和资料，拥有独立的聊天记录。

会话名称（可选）  [输入名称；留空时按首条消息命名]

[ 输入要处理的事项，或添加附件……              ]
[附件]                                      [发送]
```

尚未持久化的草稿不显示归档或恢复菜单，名称在主区直接编辑；持久化后标题区和侧栏均显示
同一组会话操作。频道级菜单独立提供频道设置、频道改名与频道归档，不能把这些操作作用于
某个子会话。

名称输入使用固定 label，placeholder 只提示填写方法。名称超过 120 个 Unicode 字符时在
字段旁提示并阻止发送；空名称继续允许首条消息自动命名。主区是草稿名称的编辑入口；侧栏只
显示同步后的名称。创建期间显示“正在创建会话…”，发送期间显示现有发送状态，阻止重复
提交但允许切换会话。创建成功后，同一次提交的临时选中态、输入、附件与确认身份一次升级。
确认、审批仍按第 7 节处理。创建请求发出前持久化原创建 key；请求结果未知时锁定名称，
保留原请求内容并以同一 key 重试，避免更改名称后产生幂等冲突。明确的校验失败允许修正
名称；恢复应用后仍能识别尚未确认的创建请求。

### 4.6 全部会话、归档与返回路径

“查看全部会话”打开当前频道的共享 Dialog，保留背后的会话、滚动和草稿。该入口只管理
该频道的会话，不打开全工作区搜索，也不改变频道配置。布局固定为：

```text
Ling 开发 / 会话                                 [关闭]
[按会话名称搜索                               ]
[活跃] [已归档]                              [新建会话]
------------------------------------------------------
默认会话        默认                         [会话菜单]
登录问题排查             运行中               [会话菜单]
频道界面优化             未读                 [会话菜单]
------------------------------------------------------
                       [加载更多]
```

对话框使用现有尺寸 token；搜索与筛选固定，结果区域独立滚动。默认每页请求 50 条具名
会话，通过“加载更多”追加，不增加无限滚动。切换搜索或活跃/归档筛选回到第一页；关闭后
再次打开默认显示活跃、空搜索。刷新或翻页失败保留已加载列表，在列表内提供重试。

默认会话只在活跃列表且匹配标题搜索时显示，不占具名分页位置；归档列表不重复默认会话。
打开会话后关闭 Dialog 并导航到该会话。没有选中项变化时，关闭返回触发按钮；选中会话后
焦点落在目标会话标题。点“新建会话”关闭 Dialog 并进入同频道草稿。

归档会话允许从列表打开并只读查看，标题区显示“已归档”及“恢复会话”，composer 替换为
“恢复后可继续此会话”。运行、重试和新发送均不可用；恢复成功后继续同一 ID 和历史。
从列表恢复只更新列表，不自动导航；从只读会话恢复则保留当前位置并重新启用 composer。

归档为可恢复操作，不增加二次确认。归档当前会话成功后导航到默认会话，显示可撤销的
“会话已归档”提示；撤销调用同一恢复操作，失败时提供“查看已归档会话”入口。
归档非当前会话保持当前选中项。请求失败保留原列表与原会话，活动冲突时提供“查看待处理
事项”，不自动停止或批准工作。归档不会清除该会话本地未发送草稿。

### 4.7 交互状态与反馈

运行、未读和生命周期是三种独立信息。侧栏只显示最需要处理的运行状态；详情仍保留真实
领域状态。状态优先级沿用第 7.2 节，“待处理”只有存在具体审批时才显示为“待审批”。

| 状态或情形 | 界面表现 | 可执行操作与恢复 |
| --- | --- | --- |
| 仅有默认会话 | 直接显示默认会话，不放大空态 | 新建会话；默认会话正常发送 |
| 无匹配结果 | “没有匹配的会话” | 清空搜索；不替换为频道历史 |
| 无归档记录 | “暂无已归档会话” | 切回活跃列表 |
| 首次加载 | 保留频道行，子列表显示骨架与“正在加载会话…” | 加载失败后重试；不假造默认会话 |
| 刷新或加载更多失败 | 已有内容保留，失败处显示重试 | 重试相同页；旧响应不覆盖新筛选 |
| 创建结果未知 | “尚未确认会话是否创建成功” | 以原创建 key 重试；保留名称和输入 |
| 已创建但首条发送失败 | 显示持久会话和消息发送错误 | 原会话重试，不创建第二个会话 |
| queued / running | “排队中” / “运行中”，必要时并列未读 | 可切换；停止只针对本会话真实运行 |
| waiting 且有待决审批 | “待审批 {count}” | 打开带来源的审批 |
| waiting 且无审批 | “等待继续” | 查看已有等待原因和续接操作，不制造审批按钮 |
| blocked / failed | “受阻” / “失败”，原因在会话内 | 按原领域提供的操作处理；不等同于已取消 |
| 新结果到达后台会话 | 原会话显示未读，所属频道汇总提示 | 打开原会话查看；不挪到当前会话 |
| 当前会话被其他客户端归档 | 保留历史，变为只读，未发输入保留 | 明确恢复后再发送；不把发送目标换成默认会话 |
| 目录待修复 | “部分历史会话需要修复”，诊断折叠 | 健康会话继续使用；有歧义目标禁止新工作 |
| 频道已归档 | 原频道生命周期提示，会话只读 | 先恢复频道；保留单独归档会话的状态 |

字段校验放在名称输入旁；创建、发送和归档失败放在对应对象旁，重试时不清空内容。
短暂成功反馈使用共享 Toast，阻断信息使用 InlineFeedback。未确认成功前不先移除会话行。
后台切换完成不弹打断输入的对话框；审批始终显示所属频道和会话。
错误码、branch ID 和迁移细节放在诊断展开区，默认文案说明影响及可用动作。

### 4.8 键盘、布局与视觉约束

沿用 [Ling Design System](ling-design-system.md) 和 UI 2.0 的颜色、字号、间距、菜单、Dialog、
选中态与动效。使用现有 Lucide 图标；线框中的文字符号不作为成品图标。频道、会话保持紧凑
行布局，不增加卡片层级；操作命中区域至少遵守现有 32px 规则，触摸使用现有更大命中 token。

- 使用原生按钮和列表导航；Tab 按“展开、频道、新建、菜单、子会话”访问，Enter/Space 激活。
  不声明 tree 角色后遗漏方向键协议。当前会话使用 `aria-current=page`，图标动作有对象名称。
- 重命名在原行展开单一输入：Enter 保存，Escape 放弃本次编辑，失败保留输入；关闭菜单与
  Dialog 后恢复合理焦点。状态更新使用非打断式宣读，不逐 token 宣读运行提示。
- 键盘焦点、重命名或菜单打开时保持该行位置，关闭后再应用最新排序，避免焦点目标跳动。
- 复用现有侧栏收起和抽屉断点。窄桌面选择会话后关闭导航抽屉；主区优先保留会话标题，
  频道名可缩略。200% 缩放和长中英文标题不得遮挡新建、状态与菜单。
- 全部会话列表、对话正文、右侧面板各自保持现有滚动边界；打开目录不滚动背后的 transcript。
  亮/暗主题和 reduced-motion 继续使用共享规则。本次验收覆盖 Web/desktop，原生移动端另行接入。

## 5. 数据模型与权威来源

### 5.1 复用现有连续性模型

`sessionId` 永远等于 canonical `LingThread.id`。沿用现有 `ChannelBranch` / `channel_branches`
作为具名会话的频道目录兼容记录；不新增第二张消息表、第二套连续性或独立可变 Session 聚合。
默认会话直接投影频道 root，不额外创建一条 branch 来复制它。默认入口、旧 root API、发送回退、远程入口与提交回执都使用同一个 canonical default 解析器；历史已归档 root 不能因更新时间较新而替换活跃默认会话。

目标新增 `surfaceKind = "channel_session"`，仅表示从空白开始的独立频道会话：

| 对象 | surfaceKind | relationKind | lineage |
| --- | --- | --- | --- |
| 默认会话 | `channel_root` | `root` | 无父线程 |
| 新建独立会话 | `channel_session` | `root` | 无 parent、anchor 或 fork snapshot |
| 真正分叉会话 | `branch` | `branch` | 原始 parent thread/turn 和 fork snapshot |
| 历史具名分支 | 保留导入后的真实类别 | 保留原值 | 不把导入占位关系宣称为真实分叉 |
| 话题回复 | `topic` | `topic` | 原会话内的消息锚点 |

新增 surface 会影响 Contracts、Core、API Client、Daemon、Web 和严格枚举消费者，必须在同一交付
中更新；旧客户端遇到无法识别的类型应明确升级提示，不能静默退回 root。
保留每频道一个 active `channel_root` 的唯一约束，不用增加多个 root 来表达多个独立会话。

`LingThread` 为标题、归档、消息与执行关联的权威；兼容 `ChannelBranch.name/status` 是同事务镜像。
新旧路由都必须经过统一会话服务，不允许分别写两套名称/归档状态。
投影只纳入 root 与明确登记的具名会话；不把该频道所有 `work`、任务和 workflow 线程都列成会话。

只读摘要由 [contracts](../../packages/contracts/src/channel-sessions.ts) 导出：

```ts
interface ChannelSessionSummary {
  readonly id: string; // canonical LingThread.id
  readonly channelId: string;
  readonly legacyBranchId?: string;
  readonly title: string;
  readonly isDefault: boolean;
  readonly surfaceKind: "channel_root" | "channel_session" | "branch";
  readonly createdAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly latestNotificationRevision: number;
  readonly pendingApprovalCount: number;
  readonly activeRunIds: readonly string[];
  readonly pendingApprovalIds: readonly string[];
  readonly runtimeState: "idle" | "queued" | "running" | "waiting" | "blocked" | "failed";
}
```

历史 `work` 记录只有经过第 9 节确定性归类后才进入该摘要；无法确定的记录报诊断，不猜测来源。
摘要与频道汇总都是读模型，不能承载执行状态机或审批决策。`activeRunIds` 和 `pendingApprovalIds` 由服务端沿持久化来源全量计算并去重，供 UI 定位运行/审批；不依赖当前已加载的消息页。`activeRunIds` 只包含仍有物理执行的活跃 Run，yielded 的等待状态通过 workflow/thread/work unit 表示，不冒充可停止 Run。实际停止与审批仍由原领域接口复核对象状态和权限。
`unread` 由客户端把摘要的通知水位与本地已读水位比较后生成，不由服务端假定所有客户端已读。

运行指标按持久化来源归属到所选会话；命名会话与真实 fork 独立统计，topic/workflow 沿合法来源关联。
损坏、冲突或循环来源不猜测归属。默认 root 保留未登记 legacy work 的兼容聚合；枚举达到
500 条时保留所选会话并明确返回 partial，不将截断值当作完整统计。

### 5.2 原子性与幂等

创建会话在一次事务中完成频道状态复核、创建请求幂等记录、线程及兼容目录记录。
创建 key 按 workspace/channel/operation 唯一，同 key 相同输入返回原会话，不同输入返回冲突。
幂等记录只保存请求摘要与结果 ID，不保存一套 Session 状态；不挪用消息级幂等表。
频道归档与会话创建必须经过同一事务检查边界。

名称与归档同步、归档前活动检查也通过统一服务事务执行。generic thread PATCH、兼容 branch
PATCH 与恢复路径均调用同一操作，避免从其他入口绕过镜像与生命周期规则。
永久删除旧目录记录时保留删除语义和已有归档线程；摘要不能把遗留线程重新发现为活跃会话。

默认会话在频道创建/迁移时准备好。列表 GET 不创建线程，不执行静默修复；历史缺失映射由
迁移或显式修复命令处理，失败时给出可诊断状态，不能在读取时制造新历史。
标题来源、通知水位和真实活动时间保存在 `ling_threads.session_title_source`、
`session_notification_revision`、`session_activity_at`；这些是线程投影字段，不是第二套会话状态。

## 6. 上下文、记忆与执行归属

会话的默认模型输入为：有效 workspace/channel 指令 + 已授权频道共享资料 + 当前 thread 的
thread core、活动 segment、消息与明确关联的工作证据。保留现有预算、敏感度、来源和可见性过滤。

必须按 thread 限制消息、摘要、压缩、任务续接、上下文 inspect/correction 与错误恢复：

- 其他会话的原始消息、压缩摘要、私人队友记忆不会因同频道而自动进入。
- 频道正式 brief、decisions、已批准共享 memory 按既有治理共享；会话内容不会因归档或完成
  自动晋升成共享知识。明确区分共享资料与原始历史，来源引用可追溯。
- topic 随所属会话归属，不独立出现在频道会话列表。
- 使用既有引用能力时依旧检查原文访问资格；首版不增加跨会话引用选择器或全量历史搜索注入。
- 真正 fork 才读取边界快照；新建空白会话不能走 fork helper。

Task、Run、Approval、Workflow、Artifact 和 MediaJob 继续归各自领域存储管理。新产生对象
通过当前 Turn/Run 保存来源关联；会话页沿持久化引用筛选，频道页才聚合。
Run 的执行线程可能是独立的 work thread，归属判断需沿 `sourceTurnId` / `sourceMessageId` 回到原会话，不能只比较 `run.threadId`。Workflow 在创建 Run 之前，已通过 metadata 中的来源 Turn/Message 归属原会话；其 preflight 审批、排队与未完成步骤同样计入会话状态和归档阻断。来源损坏、跨频道或互相冲突时拒绝执行，不能退回最近会话。

无法定位 thread 的历史对象留在频道级工作视图，不凭“最近选中会话”补归属。只有明确兼容的无来源旧入口才解析默认 root。Plan Mode 检查也沿同一来源选择会话，不读取该频道最近更新的任意 thread。
一个工作对象涉及多会话时，仍只有一个对象 ID，其他会话通过显式引用展示，计数按 ID 去重。

创建新会话不启动 agent 进程。运行沿用现有 coordinator、Attempt fence、并发限制与锁。
恢复 Run、延迟回调和 TerminalReport 必须回到最初 thread，不受当前 UI 导航影响。

## 7. 审批、未读与客户端身份

### 7.1 确认与审批

目标 full-access scope 使用 workspace + 实际执行路径 + channel ID + canonical thread ID +
现有 policy revision。新会话单独确认；回到已确认的同一会话，在路径和策略均有效时复用。
频道默认值只提供预设，不授予跨会话确认；首版不扩大“主动选择即确认”的既有适用 surface。

旧 branch/root scope 不批量转成线程 scope；升级后首次需要时重新确认。内存中新建 draft 向已创建
thread 的同次确认移交，必须绑定创建 key 和目标，持久化失败则重新确认。
待决审批按真实来源对象处理；切到 B 后打开 A 的审批，应显示来源并导航 A 或在带来源标签的
Dialog 决策，不能把 A 的审批和确认写进 B。

### 7.2 未读和聚合状态

首版沿用 Web/desktop 本地已读存储方式，把 key 扩展为 workspace/channel/thread；不在此功能中
引入跨设备已读同步。现有 remote-access read-state 存储不视为已支持本产品的 thread 已读协议。
服务端维护每线程单调的 `latestNotificationRevision` 作为通知投影水位，客户端保存
`readThroughNotificationRevision`。新的可见助手回复及其终态结果推进水位，工具 token 增量、
重放同一状态和维护写入不推进。该投影必须可幂等更新，不是第二份会话历史。
通知投影仅纳入请求者可见的频道回复，operator/agent_private 内容不进入普通频道未读。
canonical Item sequence 继续负责历史顺序；不能仅凭最大 Item sequence 判断未读，因为已存在的
streaming Item 可能在用户切走后才完成。通知水位覆盖这种同一 Item 后续状态变化。

topic 可见结果同时更新 topic 与所属会话的活动时间和通知水位；只沿同 workspace/channel 的
topic 父边上溯，遇到真实 fork 即停止。迁移 `181` 为已安装 `179/180` 的库替换通知触发器，
不重放旧消息或清空水位；私有、已被替代和跨域来源继续排除。

仅在会话可见、窗口聚焦且内容确实展示到对应位置时推进已读；打开 A 不清除 B，收起频道不清除
子会话。仅有工具流式增量时不逐 token 产生未读；新的可见助手回复或结果触发未读。
原频道级 seen 时间不扩散到每个子会话；切换版本首次加载以服务端已有历史水位建立本地基线，
随后新增活动按 thread 计数，避免把全部旧历史变成新消息。

频道汇总按对象 ID 去重：待审批数量求并集，未读为任一活跃会话未读。可操作状态优先级为
waiting > failed/blocked > running/queued > idle；paused/archived 为频道单独生命周期标识。
一个会话结束不能覆盖另一个仍在运行或等待的状态。
服务端的运行/审批汇总覆盖全部登记会话，不依赖当前侧栏的 10 条预览；客户端以服务端变化提示
拉取对应会话通知水位，不能把未加载页当作全部已读。服务端有来源的审批按可访问对象计数。
重连用持久事件游标补齐变化；游标失效时分页对账摘要水位，不能只依赖在线通知。

### 7.3 导航、缓存与事件

导航目标使用 `(workspace, channelId, threadId)`；branch ID 仅用于旧链接解析和兼容目录操作。
草稿、pending send、分页、stream store、错误和请求取消各自按该身份分区。
权威刷新替换服务器返回的原始序号窗口，只保留窗口外已加载的旧页；被 supersession 隐藏的
消息、工具过程和关联媒体不得因缓存合并重新出现。
加载响应还需匹配请求 generation；晚到 A 响应不得覆盖 B。

保留现有 URL/navigation 序列化形式，仅新增显式 thread 目标，不在设计中虚构现有路径格式。
旧 channel 链接解析到默认会话，旧 branch 链接经兼容映射解析到同一历史 thread；无效目标给出
明确错误或带提示回退，不静默把发送目标换成默认会话。
新 draft 是临时身份；绑定 thread 后迁移一次本地状态，不能复用其他 draft 的 key。

## 8. API 与兼容

下表定义 sessions facade 的目标契约；对应源码已进入实现，完成情况以实现计划为准。
所有请求继续要求现有 `cwd` workspace 定位与访问检查。

| 操作 | 目标接口 | 语义 |
| --- | --- | --- |
| 列表 | `GET /channels/:channelId/sessions` | 返回默认会话与已登记具名会话摘要；具名部分按 activityAt/ID 稳定分页 |
| 创建 | `POST /channels/:channelId/sessions` | `{ title?, idempotencyKey }` 创建空白独立会话，不 fork、不运行 |
| 详情 | `GET /channels/:channelId/sessions/:threadId` | 校验频道归属；返回同一摘要身份 |
| 重命名 | `PATCH /channels/:channelId/sessions/:threadId` | `{ title }`；更新 canonical 标题及兼容镜像 |
| 归档/恢复 | 同一 PATCH | `{ archived: true/false }`；遵守生命周期和活动冲突规则 |
| 显式修复空历史目录 | `POST /channels/:channelId/branches/:branchId/repair` | 仅修复无歧义空目录，保留目录 ID；不在 GET 执行 |

列表响应包含 `defaultSession`、具名 `sessions`、全量活跃会话的轻量 `notificationWatermarks`
及可选 `nextCursor`。水位集合不受当前分页和标题筛选影响，用于本地未读对账；不包含消息正文。
`archived=true` 只筛选具名
归档会话；default 单独返回、不重复占分页位置。cursor 绑定筛选条件和排序边界，按 thread ID
去重；期间新活动可显式刷新回第一页，不追求跨多页的事务快照。
`unread` 是客户端派生字段，列表提供通知 revision；频道运行/审批总数由覆盖全量会话的聚合提供。
首版搜索仅按标题，在频道内筛选后分页；查询错误不得回退返回全频道消息。
创建返回 201，幂等重放返回 200；归属不符或不存在返回 404，输入非法返回 400；归档冲突、
频道不可写或幂等 key 输入不匹配返回 409，并带可区分的原因。

消息分页和发送复用现有 `/channels/:id/items`、`/turns`、`/turns/stream`，统一显式传
`surface: { kind: "thread", threadId }`；不增加第二套消息或 Run API。
以返回的 thread ID 为准。默认会话也用显式 thread；旧 `channel_root` surface 保留兼容解析。

旧 `/branches` 接口在首版保留：新旧写路径调用同一服务；旧 branch ID 与 rootThreadId 不变。
旧 POST 创建的是新语义的空白具名会话，响应继续保留 branch 结构；新客户端使用 sessions API。
旧 POST 无创建 key 时仅保证事务一致性，有 key 时执行幂等语义，不声称旧无 key 重试可去重。
删除兼容行为和严格枚举客户端的升级边界均需回归验证。

## 9. 历史数据与升级

设计补充不运行迁移、不编辑用户数据库。迁移实现在临时测试库验证，并需完成以下联合验收：

1. 原 `channel_root` ID、Item、Turn、Run 和顺序原样保留，只投影为默认会话。
2. 有有效 rootThreadId 的历史具名分支保留目录 ID、线程 ID、名称、归档与 lineage；首次将现有
   branch 名称同步为 canonical title，解决旧重命名路径可能留下的两个标题。
3. `surfaceKind=branch` 的导入记录保留原 lineage，只有具备可验证源 Turn 与 snapshot 才展示
   “从某轮分叉”；不重写导入关系来伪装空白创建或真实 fork。
4. 旧目录明确指向的 `work` 类型线程，若无 parent/anchor/fork lineage、无任务等其他 owner，
   确定性归类为 `channel_session`；有有效 fork 证据则归类为 branch。混合 owner、跨频道
   rootThreadId、缺失目标或一线程被多个目录占用的记录列为诊断并阻止受影响会话写入。
5. 缺 rootThreadId 且无可关联历史的空目录可在显式修复事务中分配空会话；有历史但无法唯一
   关联时保留原数据并要求修复，不猜测、不自动合并或丢弃历史。
6. 每个具名会话的目录到 thread 关联唯一；默认 root 不得登记成具名会话。新增检查/索引前
   先检测坏数据；迁移幂等重开，异常回滚。
7. 不把普通对话、私聊、自动化和无目录登记的工作线程迁入频道会话列表。
8. 升级后历史消息数量、身份、引用和归档范围不变；修复只调整可证明的目录映射与分类。

迁移保持可重复和原子，升级失败继续使用原数据库备份。旧二进制不保证能读取新的 surface
枚举；降级必须关闭新版本并恢复升级前备份，不能让旧版直接写升级后的库。
若按 feature gate 分批交付，未开启前不写入新 surface，不能只隐藏 UI 就声称可安全降级。

当前 Core 实现分配迁移号 `179`，历史库写入前使用 SQLite 一致性备份到
`<databasePath>.pre-channel-sessions-v179.backup`，不覆盖已有备份。已整合主分支的 `177` 权限迁移
及 `178` Runner ID 迁移；迁移号是分支分配值，合并前
必须核对最新主分支是否占用；如冲突，在发布前统一调整代码、测试及备份命名。
已有备份不自动代表当前升级点，回退时需核实备份来源与适用版本。恢复备份会回到备份时刻，
升级后新增内容需另行保存，不能承诺直接降级无损。
显式修复使用 `repairChannelSessionDirectory(channelId, branchId, now)`，只自动修复可证明
没有历史关联的安全空目录；其他异常保留诊断，不能通过 GET 或新建会话替代历史修复。

## 10. 实现边界与验收

Web 沿用统一的频道 transcript/composer；新增会话导航和生命周期 domain，避免把所有逻辑继续
堆进 `AppShell` 或 `WorkspaceClientView`。Daemon 增加薄 facade，统一服务拥有事务、目录映射和
权限校验；底层 timeline、context projector、调度与审批仍由现有模块负责。

| 验收场景 | 通过条件 |
| --- | --- |
| 同频道 A/B 新会话 | 两个 canonical thread；历史、摘要、上下文检查和输入互不混入 |
| 空白创建与 fork | 空白无父轮次/快照；真实 fork 保留来源；历史导入不假报分叉 |
| 创建响应丢失、双击及发送失败 | 复用创建 key 和首条 Turn key；只创建一个会话，不丢草稿 |
| 流式过程中 A 切 B | A 继续后台运行，B 无 A 消息、错误、停止目标或审批确认 |
| 会话生命周期 | 重命名两入口一致；归档活动冲突明确；恢复同 ID；默认会话保持可达 |
| 历史数据与旧 API | 原 root/branch ID、历史数量、引用及归档不变；GET 无隐式修复写入 |
| 任务/审批/产物 | 来源可定位；独立 work thread 的 Run 和尚无 Run 的 workflow 审批仍回到原会话；跨会话引用不重复计数 |
| 权限与并发 | 新会话未继承另一会话确认；同目录写入受原锁约束；策略变化使确认失效 |
| 未读与频道汇总 | 读 A 不清 B；A 完成不覆盖 B 运行；重开不将全量旧历史标为新消息 |
| UI 与恢复 | 键盘可展开/切换/命名；列表可分页；刷新、断线重连及重启保持身份 |
| 侧栏与全部会话 | 当前会话在预览外仍可定位；搜索/归档筛选稳定；翻页失败保留内容与焦点 |
| 草稿和只读归档 | 草稿不制造空记录；归档保留本地输入；只读查看、恢复、归档当前项与撤销均有返回路径 |
| 状态和视觉 | 运行与未读并列可辨；waiting 有无审批文案明确；亮/暗、长标题、200% 缩放与键盘流程通过 |

代码测试、真实 Web/desktop 流程和 packaged acceptance 分别记录，不能相互替代。
分阶段工作与退出条件见 [实现计划](channel-sessions-implementation-plan.md)。

## 11. 已确定的取舍

- 增加一个独立会话 surface，换取“空白创建”与 fork 的明确区别；交付时需同时更新严格枚举消费者。
- 保留 `ChannelBranch` 存储兼容，减少历史搬迁；代价是内部旧名称暂存，通过单一服务约束镜像。
- 默认会话首版常驻，保留旧 root 访问约定；其他具名会话提供独立归档。
- 首版共享频道配置与目录，保持现有调度边界；按会话独立 worktree 不在本次扩展中实现。
- 已读首版仅 Web/desktop 本地持久化；跨设备同步需后续单独协议设计。

本设计没有阻塞实施的待决产品项。本文定义目标行为，不授予执行权限；核心会话链路已有
源码与相关回归，补充交互的实现差异和未验收项由实现计划记录。源码、自动化、真实桌面运行、PR、合并与正式发布分别按真实进度记录。
