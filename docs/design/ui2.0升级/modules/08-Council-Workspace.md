# Council Workspace

## Product Boundary

Council 是可管理的协作配置，不是另一个运行引擎。当前 UI 只投影 Core/daemon 已有的 list、health、
create、clone、members、channel policy、settings、pause/resume 和 archive 能力。

- `source=user` 的 Council 可编辑；`builtin/template` 只读并通过 Clone 产生自定义副本。
- Health 是带 `generatedAt` 和完整度的权威报告；缺失、过期、截断或 mutation 后尚未刷新时不得显示 Ready。
- 当前没有稳定 Council runtime provenance，不能从成员、频道、时间戳或 Health 推断运行、成功率或调度。
- 不新增 Delete、Restore、Archived catalog、审批引擎、权限状态机或数据库/API 字段。

## List And Selection

- 搜索匹配用户可见名称和说明；筛选只使用真实 source/lifecycle/readiness。
- 一行只显示一个主状态。partial Health 可以显示明确 finding，但不能证明其他对象正常。
- initial loading 使用 Skeleton；refresh 保留旧列表并标 stale；切换 Council 时旧请求不得写入新对象。
- 长列表内部滚动，操作列固定；选择行打开 Workspace，不增加重复“详情”按钮。

## Create And Clone

- Create 只收集当前 API 支持的名称、说明和成员配置；提交前校验必填与重复。
- Clone 明确复制哪些配置，不复制 runtime、Health、审批或历史；响应是新对象的权威来源。
- 保存失败保留用户输入；成功后选择新 Council。managed Council 的编辑行动始终指向 Clone。

## Members

- 成员顺序仅表达管理顺序，不暗示调度优先级。首版使用上下箭头，不增加拖拽语义。
- Add、enable/disable、reorder、remove 都通过完整成员数组 PUT；提交前读取最新 fingerprint，检测到
  冲突时不覆盖远端。
- PUT 成功后等待更新的 Health generation；Health 刷新失败不回滚已保存成员配置。
- 移除只解除 Council membership，不删除队友，也不改变直接频道成员关系。
- builtin/template 成员只读；状态优先显示缺失、隐藏、未启用等明确 finding，再显示 pending/ready。

## Channels

- Channel policy 只管理 Council 与频道的现有引用，不覆盖频道直接成员或各队友模型。
- 保存以服务端响应为权威；切换频道、Council 或旧请求返回时使用 identity guard。
- Council paused/archived 或 readiness 不完整时，UI 明确说明影响，不伪造可运行状态。

## Settings And Archive

- 自定义 Council 可编辑名称、说明、置顶和 active/paused；dirty draft 与 authority 分离。
- 保存失败保留草稿，reset 回到最新 authority。生命周期 action 使用独立 busy。
- Archive 使用共享 Dialog；提交中阻止重复提交，失败保留 Dialog，成功后从 active list 移除。
- Archive 不是永久删除。Core 负责清理频道引用，前端不发送第二次伪 cleanup。
- managed Council 不发送 PATCH，只展示只读边界和 Clone。

## Presentation

- 页面使用列表 + 按需 Workspace/Inspector；默认层不展示 raw ID、workspace ID、payload、route 或时间戳。
- 失败靠近所属 panel；明显的列表变化不再追加成功 Toast。
- `1280x800` 下表单单列、动作不遮挡身份；Dialog、列表和 Inspector 各自拥有唯一滚动 owner。
