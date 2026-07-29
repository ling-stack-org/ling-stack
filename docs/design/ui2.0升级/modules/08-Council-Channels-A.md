# Council Channels A Product Contract

> Slice: `P8.2c`
> Function ID: `COUNCIL-CHANNELS-001`
> Product decision: Council A
> Status: `Web verified`

## 1. Goal

Council Channels A 将 Council 与频道的配置关系收敛为一个安静、紧凑、可验证的 UI 2.0 surface。用户可以：

- 选择一个真实频道；
- 查看该频道当前接入的 Council；
- 接入当前选中的 Council；
- 设定首选 Council；
- 解除 Council 与频道的关系；
- 从 Settings 嵌入态返回真实频道工作区。

本切片只展示 `ChannelCouncilPolicy`、频道 lifecycle 和当前 Council 配置能够证明的关系事实。页面不得声称
某次 Run、消息、任务或成员执行来自某个 Council。`COUNCIL-RUNTIME-001` 继续保持 blocker。

## 2. Authority And Product Boundary

| Capability | Authority | UI 2.0 decision |
|---|---|---|
| Current channels | AppShell 非归档频道快照 | active / paused 频道基础目录 |
| Archived channels | `GET /channels?archived=true&limit=100` | 只用于展示和解除已有关系；不改变 AppShell IA |
| Channel policy | `GET /channels/:channelId/council-policy` | 所选频道关系的唯一权威来源 |
| Attach / detach / prefer | `PUT /channels/:channelId/council-policy` | 继续发送完整 `attachedCouncilIds` 和 `preferredCouncilId` |
| Council catalog | 现有 active/paused Council 列表 | 显示 identity/source/status；不加载或猜测 runtime |
| Missing Council | policy 中存在 ID、当前目录无对象 | 显示 `Unavailable`，保留可解除关系；不显示 raw ID |
| Open channel | 现有 `onOpenChannel(channelId)` | active/paused 可导航；archived 禁用，避免打开不存在的主壳层对象 |

不新增 API、contract、Core store、数据库字段、migration、路由、`ViewId`、Settings IA 或运行来源字段。

## 3. Page Structure

```text
Council detail
  Shared Tabs
    Members
    Channels
      CouncilChannelsPanel
        Header
          attached count / refresh
        Channel selector
          selected lifecycle / Open channel
        Lifecycle restriction feedback (paused / archived)
        Load or retained-stale feedback
        Attach selected Council surface
        Bounded attached-Council list
          Council relationship DataRow
            identity / Council lifecycle / one relationship state / actions
    Settings
```

`CouncilChannelsPanel` 是唯一垂直滚动边界 owner。Header、频道选择、错误反馈和接入操作固定在列表上方；
100 条已接入 Council 只滚动列表，不推动 document/root。

## 4. Selected Channel Rules

- 频道目录合并 AppShell 当前快照与 archived 只读请求，按 ID 去重，最多服从现有 endpoint 的 `100` 条边界。
- 当前选择仍存在时保持选择；删除、归档发现变化或 workspace 切换后，回退到目录第一项。
- 切换频道不会等待旧 policy 请求完成；旧 GET 结果不得写入新频道。
- 下拉显示频道名称；paused/archived 追加本地化 lifecycle，active 不重复说明。
- active：允许接入、设首选、解除关系和打开频道。
- paused：现有关系只允许解除；禁止接入和设首选；仍可打开频道查看。
- archived：现有关系只允许解除；禁止接入、设首选和打开主应用频道。
- archived discovery 失败时，active/paused 目录继续可用；不得把归档目录失败冒充为 policy 失败。

## 5. Relationship Row Contract

每个已接入 ID 只渲染一行、一个关系状态：

```text
preferred > attached
```

| State | Visible label | Tone | Actions |
|---|---|---|---|
| preferred | `Preferred` | info | Detach |
| attached | `Attached councils` | neutral | Prefer + Detach |
| unavailable attached | `Attached councils` | neutral | Detach only |
| unavailable preferred | `Preferred` | info | Detach only |

- 主标题显示 Council `displayName`；副标题显示 `Built-in / Template / Custom`。
- Council lifecycle 是配置摘要，不与关系状态合并。
- raw `councilId`、workspace ID、route、hash、policy timestamps 不进入默认层。
- built-in/template Council 的 Settings 保持只读，但频道关系仍按现有 API 可接入/首选/解除；页面不得伪装成
  修改 managed Council 内容。
- `Unlink` 是解除关系图标，不使用永久删除语义，不打开删除确认。
- 行内 `Prefer` 与 `Detach` 保持真实可用性；paused/archived 禁用 `Prefer` 并提供限制 title。

## 6. Exact Mutation Semantics

### Attach selected Council

```ts
{
  attachedCouncilIds: current.includes(selectedCouncilId)
    ? current
    : [...current, selectedCouncilId],
  preferredCouncilId: currentPreferred ?? selectedCouncilId,
}
```

仅 active 频道、已加载且非 stale policy、当前 Council 尚未接入时可用。成功响应是新 authority；失败不增加
伪关系行，错误留在接入 surface。

### Prefer attached Council

```ts
{
  attachedCouncilIds: current.includes(councilId)
    ? current
    : [...current, councilId],
  preferredCouncilId: councilId,
}
```

沿用现有 API 的“prefer 时保证已接入”语义。UI 正常只对已接入且可用的 Council 显示该行动。

### Detach Council

```ts
const nextIds = current.filter((id) => id !== councilId);
{
  attachedCouncilIds: nextIds,
  preferredCouncilId: currentPreferred === councilId
    ? (nextIds[0] ?? null)
    : (currentPreferred ?? null),
}
```

解除首选 Council 时，首个剩余关系成为首选；无剩余项时显式发送 `null`。本操作不是删除 Council，不删除频道、
成员、消息、Run 或历史记录，因此不新增永久删除确认。

## 7. Loading, Failure And Stale Ownership

| Reachable state | Presentation | Mutations | Repair |
|---|---|---|---|
| no channels | compact EmptyState | none | 创建频道（现有入口） |
| selected channel loading | stable Skeleton rows | disabled | wait / switch channel |
| initial policy failure | danger InlineFeedback, no relationship rows | disabled | Retry |
| loaded no attachments | attach surface + compact EmptyState | attach if active | Attach selected Council |
| loaded relationships | bounded DataRows | state-derived | normal actions |
| refresh failure with snapshot | retained rows + warning InlineFeedback | disabled | Retry |
| attach failure | attach surface error, old policy retained | retry attach | repeat |
| prefer/detach failure | initiating row error only | other rows remain usable | repeat row action |
| row mutation busy | only initiating action loading | queued actions use latest response | wait |
| selected Council changed | attach identity changes, old row feedback hidden | policy unchanged | normal action |
| selected channel changed | old rows cleared, new Skeleton/load | new identity only | wait / switch again |
| policy references missing Council | `Unavailable` relationship row | detach only | detach or refresh catalog |
| paused/archived channel | warning restriction + removal-only controls | detach only | resume or restore elsewhere |

Success is visible as a relationship-row/state change, so本切片不额外制造 success Toast。失败持续显示到 Retry、成功或
频道 identity 变化；不得用自动消失 Toast 隐藏修复信息。

## 8. Concurrency And Identity

- Controller identity 固定为 `cwd::selectedChannelId`。
- 每次 GET 使用递增 sequence；只有 identity 和最新 sequence 同时匹配才能写入。
- policy 快照同时保存在 state 与同步 ref，mutation payload 在真正执行时从最新 ref 派生。
- mutation 按队列串行，避免两个完整数组 PUT 互相覆盖；busy/error 仍按 `councilId` 归属。
- mutation 开始时使在途 policy GET 失效，防止旧 GET 在 PUT 后覆盖新响应。
- 切换频道后，旧 GET/PUT 可以在服务器完成，但不得改变当前 panel、busy、error 或 relationship rows。
- API 没有 revision/ETag，多个独立客户端仍可能最后写入覆盖；UI 不得宣称已具备服务端冲突保护。

## 9. Components, Accessibility And Motion

- Tabs 使用共享 `Tabs/TabsList/TabsTrigger`，支持 ArrowLeft/ArrowRight 和标准焦点语义。
- 频道选择使用共享 `Field + Select`；focus owner 是外部 Select shell，native 控件不得超出边框。
- 行使用共享 `DataRow + StatusIndicator`；关系文字可见，不退化为纯色点。
- action 使用共享 `Button/IconButton`，icon-only 具备 Tooltip、title、ARIA 和不小于 32px hit area。
- Loading、Empty、InlineFeedback、Skeleton 均来自共享 UI package。
- 不使用 Feature keyframe、`transition: all` 或硬编码 duration/easing；reduced motion 由共享 primitive 和 focused
  scroll behavior 接管。
- 颜色只来自 Ling token；关系状态不是颜色唯一表达。
- 长名称使用 ellipsis + title；按钮和状态列固定，不覆盖 identity。

## 10. Module And CSS Ownership

- `council-channels-view-model.ts`：目录合并、关系行、限制和 exact payload 纯函数。
- `useCouncilChannelsController.ts`：archive discovery、selection、load/stale、mutation queue 和 identity guards。
- `CouncilChannelsPanel.tsx`：Field/Select、反馈、attach surface、DataRow 和导航展示。
- `council-channels.css`：唯一 Channels focused selector owner。
- `CouncilWorkspacePage.tsx`：只实例化 controller；不再拥有 policy state/effect/mutation。
- `CouncilWorkspacePanels.tsx`：只接入共享 Tabs 和 focused panel；不再内嵌 Channels JSX。

所有新 production owner `<400` 行；Page/Panels 必须净减少。`councils.css` 只保留跨 tab/Settings 通用 selector，
旧 `.council-channel-*` owner 必须删除。

## 11. Verification Contract

- Focused：`ui2-council-channels.spec.ts` 覆盖 exact payload、managed relationship、loading、empty、initial/retained
  failure、row failure、paused/archived、GET/PUT race、100 rows、keyboard、focus geometry、navigation 和 overflow。
- Regression：`ui2-council-list-health.spec.ts`、`ui2-council-members.spec.ts`、
  `ui2-council-create-clone.spec.ts`、`councils.spec.ts`、`ui2-settings-workspace-tools.spec.ts`、`dark-mode.spec.ts`。
- Static：Web typecheck、check:i18n、lint、touched diff check、focused CSS forbidden scan。
- Browser：真实 Vite source server，`1440x960` / `1280x800`，Light/Dark、zh-CN/en-US、reduced motion。
- Evidence：`evidence/features/council-channels/metadata.md` 记录原图尺寸、SHA-256、fixture、console、overflow、
  request payload、focus、keyboard、scroll owner 和禁止 runtime-provenance 审查。

## 12. Hard Stops And Non-goals

- 不新增 Council runtime、task、activity、success rate、last run 或 execution order 展示。
- 不从消息、Run、更新时间、preferred 状态或成员 enabled 数量推断运行来源。
- 不修改频道成员、Council members、AI 队友、权限、模型、skills、MCP 或 governance。
- 不修改 API、contracts、Core、DB、routes、AppShell、Settings IA 或 locale 文件。
- 不为 detach 新增永久删除确认，也不把 archived Channel 伪装成可打开对象。
- 不关闭 `COUNCIL-RUNTIME-001`、完整 `COUNCIL-SETTINGS-001` 或任何 Desktop packaged gate。
- focused worker 不回写 UI2 全局矩阵、README 或状态看板；由集成 owner在证据通过后统一更新。

## 13. Verified Closeout

- Focused capture and final main-agent rerun both passed `7/7`; selected Council/Settings/Dark regression passed
  `40/40`.
- Web typecheck, i18n, lint, touched-path diff, focused CSS guard and document links passed.
- Six original-size Light/Dark, `1440x960`/`1280x800`, en-US/zh-CN images were reviewed and their current SHA-256
  values are recorded in [Council Channels evidence](../evidence/features/council-channels/metadata.md).
- `COUNCIL-CHANNELS-001` is Web `verified`. This does not close Council runtime provenance, complete Settings/Archive,
  imported Theme or packaged macOS/Windows evidence.
