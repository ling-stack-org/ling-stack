# MCP Tool Servers

## 1. 页面目标

Settings > MCP 工具服务以 workspace 级 Server 为管理对象。用户需要在同一页面完成：

- 查看 Server 是否可用、是否需要凭据或迁移；
- 添加和编辑 HTTP / stdio Server；
- 检查连接并同步工具；
- 查看已同步工具和必要技术详情；
- 永久删除不再使用的 Server。

本页不负责 AI 队友的工具授权。队友 MCP 授权继续属于 AI Teammate Management，只消费这里已同步的
Server 和 Tool。

## 2. 入口与 Shell

- 入口：Settings > 配置 > MCP 工具服务。
- Shell owner：`SettingsShell`。
- 页面不得重复 Settings 标题、返回按钮或 section 说明。
- 页面内容只有一个内部纵向滚动 owner；Dialog body 拥有自己的滚动边界。
- Web 与 Desktop renderer 共用同一页面和 shared primitives。

## 3. 当前代码与问题

实施前基线：

- `McpToolsPage.tsx`：590 行，列表、编辑器、校验、状态投影、工具详情和反馈全部混在一个文件；
- `mcp.css`：491 行，包含手写 Dialog、Switch、按钮、表单和反馈样式；
- `use-mcp-domain.ts`：拥有真实 load/create/update/check/sync/delete 状态；
- `mcp.spec.ts`：Settings 管理和 AI 队友授权混在同一个 spec，只覆盖主 happy path；
- 页面重复渲染标题和说明，Server 行同时堆叠状态、密钥、工具数和五个文字按钮；
- raw status message 常驻默认层；删除没有确认；成功/失败反馈没有统一生命周期；
- 手写 overlay、Switch 和输入框绕过 UI 2.0 的 focus、busy、Dark 和 reduced-motion 合同。

## 4. Function Points

| Function ID | 用户行为 | 可达状态 | 目标 primitive |
|---|---|---|---|
| `SETTINGS-MCP-LIST-001` | 查看 Server 列表和刷新 | loading, empty, loaded, load-error, long-content | `DataRow`, `Skeleton`, `EmptyState`, `IconButton` |
| `SETTINGS-MCP-CREATE-001` | 添加 HTTP / stdio Server | open, validation, saving, failed, success | `Dialog`, `Field`, `Input`, `Select`, `Switch`, `Button` |
| `SETTINGS-MCP-EDIT-001` | 编辑 transport/config | open, dirty, saving, failed, success, plugin-reserved failure | 同上 |
| `SETTINGS-MCP-CHECK-001` | 检查连接 | idle, checking, ready, failed, disabled, auth-blocked | `Button`, `IconButton`, `StatusIndicator`, `InlineFeedback` |
| `SETTINGS-MCP-SYNC-001` | 同步 tools | idle, syncing, success, failed, no-tools | `Button`, `IconButton`, `InlineFeedback` |
| `SETTINGS-MCP-TOOLS-001` | 展开工具和技术详情 | closed, open, empty, long-description, metadata-folded | `Collapsible`, `DataRow`, `InspectorSection`, `Badge` |
| `SETTINGS-MCP-DELETE-001` | 永久删除 Server | confirm, cancel, deleting, failed, success | `Dialog`, `Button`, `InlineFeedback` |

## 5. 页面结构

```text
SettingsShell
  Settings content header
  MCP page
    Compact toolbar
      neutral summary
      Refresh icon
      Add server
    scoped load error
    loading skeleton / empty state / server list
      Server row
        identity + product transport summary
        one primary status
        tool count
        derived primary action + compact icon actions + More
      animated details
        tools
        connection and runtime inspector
    Add/Edit Dialog
    Delete confirmation Dialog
```

页面默认层不再使用面板套卡片，也不重复 `MCP servers` 标题。

## 6. Server 默认层

每行只显示：

- display name；
- `Remote HTTP` 或 `Local process` 产品化 transport 摘要；
- 一个主状态；
- 已同步工具数量；
- 一个按状态派生的文字主行动；
- Show details、Check、Sync、Edit 和 More 中必要的 compact actions。

以下内容默认折叠：

- Server ID、完整 URL、command、args、cwd；
- env/header/bearer secret ref；
- startup/tool timeout、required；
- checkedAt、expiresAt、latency、protocol、provider message、error code；
- tool raw name、callable name、input schema、时间戳和 approval metadata。

密钥值永不显示；只允许显示 storage reference 和配置状态。

## 7. 主状态规则

每行只能有一个主状态，优先级为：

1. Disabled；
2. Legacy credential migration required；
3. Missing / invalid / inaccessible credential；
4. Checking；
5. Check failed / unavailable；
6. Check expired / needs check；
7. Ready；
8. Not checked。

颜色只用于状态点：Ready 为 success，凭据或过期为 warning，真实失败为 danger，未检查/停用为 neutral。
raw backend message 不直接替代产品状态，进入 `InspectorSection`。

## 8. 行动规则

- 未检查或失败：主行动为 Check。
- Ready：主行动为 Sync tools。
- Disabled、凭据缺失或迁移：主行动为 Edit。
- 主行动已经显示的操作不再重复显示同名 icon。
- 常用 Check、Sync、Edit 可以作为 icon-only action，均有 Tooltip、`title` 和 ARIA name。
- Show details 固定在 actions 最前；无工具时仍可打开 Server details。
- Delete 只在 More 菜单中，打开共享确认 Dialog。
- action-scoped busy 只影响当前 Server；Refresh 只影响 Refresh。

## 9. Add / Edit Dialog

### 默认字段

- Server name；
- Server ID，仅创建时可编辑；
- Transport；
- HTTP：Server URL；
- stdio：Command、Arguments、可选 Working directory；
- Enabled。

### 渐进详情

- Authentication 默认折叠；已有引用或该处校验失败时展开。
- Advanced settings 默认折叠，包含 startup timeout、tool timeout 和 critical dependency。
- secret ref 字段使用普通文本输入，但禁止浏览器自动完成；不提供 reveal secret value。
- 切换 transport 时清空另一 transport 的不可达字段，避免提交隐藏旧配置。

### 行为

- 创建按钮为 `Add server`，编辑按钮为 `Save changes`。
- 校验错误连接到具体 `Field`；Dialog 顶部只显示紧凑摘要。
- saving 时 Dialog 不允许 Esc、outside click 或 Close。
- 保存失败保留 Dialog、输入和错误；成功只在权威刷新后关闭。
- Esc / Cancel 关闭后恢复触发按钮焦点。

## 10. 工具与详情

- 展开/收起使用共享 `Collapsible`，采用 UI 2.0 motion token，并支持 reduced motion。
- 工具列表保持紧凑，默认显示 display name、短 description 和 side-effect label。
- 长 description、raw/callable name、approval、enabled、schema 和时间戳进入每个 Tool details。
- 工具列表有固定 max-height 和自己的滚动边界；展开不能令 Settings document 横向滚动。
- 同步成功但返回 0 tools 时显示紧凑空态，不伪造工具。

## 11. 删除

- Delete confirmation 必须说明：Server、同步工具和队友绑定会被永久移除。
- 初始焦点在 Cancel；一次 Esc 关闭且不发送请求。
- deleting 时不可关闭；只显示删除按钮 loading。
- 删除失败保留 Dialog 和错误详情；成功在权威本地状态更新后关闭。
- plugin reserved Server 的 409 作为产品化失败显示，不改变 daemon 保护。

## 12. 反馈

- 页面 load error：持久 `InlineFeedback`，保留最后权威列表。
- create/update/delete failure：留在所属 Dialog。
- check/sync failure：留在对应 Server row，直到重试或状态改变。
- check/sync success：短时行内确认，随后自动消失；主状态和工具数是权威结果。
- 不使用 browser alert、页面顶部全局 success banner 或常驻绿色胶囊。

## 13. 主题、尺寸与可访问性

- 目标 viewport：`1440x960`、`1280x800`。
- Light/Dark 只使用 semantic tokens，不出现硬编码白块、黑块或绿色 Switch。
- icon hit area 不小于 32px；文字主按钮高度不小于 32px。
- Dialog 在 1280x800 下不超出 viewport，header/footer 固定，body 内滚动。
- 支持 Tab、Shift+Tab、Enter、Space、Esc；Menu、Dialog 和 Collapsible 使用 Radix/shared contracts。
- 中文、英文长文案不能挤压状态和 actions；Server name、command 和 URL 必须可截断并在详情完整显示。

## 14. CSS 与模块所有权

- `McpToolsPage.tsx` 只负责页面状态组合和 overlay ownership。
- `McpServerList` / `McpServerRow` 负责纯展示与 action callbacks。
- `McpServerEditorDialog` / `McpServerDeleteDialog` 独立。
- `mcp-settings-view-models.ts` 负责状态、主行动、transport、工具和 detail 投影。
- focused owner：`settings-mcp-tools.css`。
- 旧 `mcp.css` 的 Settings selector 同切片删除，不复制；不得写入 `settings.css`、`components.css`。
- Feature 不直接 import Radix 或 `@ling-stack/ui-react`，统一通过 `shared/ui`。

## 15. 验收

- focused E2E 覆盖七个 Function ID 的全部可达状态。
- 原 `mcp.spec.ts` Settings 管理和 AI 队友授权行为不得回退。
- 真实 Vite 页面在两个 viewport、Light/Dark、中英文完成 changed-state 截图。
- 检查 console、document overflow、内部滚动、focus restore、Esc、busy dismissal 和 reduced motion。
- 证据写入 `evidence/settings/mcp-tool-servers/metadata.md`，并回写覆盖、E2E、CSS、selector、motion、feedback 和状态看板。

## 16. 非目标

- 不改 MCP daemon API、contracts、数据库、transport、secret resolver 或 tool execution。
- 不新增 OAuth flow 或 secret value 写入/回读能力。
- 不把 AI 队友 MCP 授权迁入 Settings Server 页面。
- 不改 Settings IA、路由、`ViewId` 或 `SettingsSectionId`。
- 不修改 Logo。
