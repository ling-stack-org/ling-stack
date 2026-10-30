# 业务数据与 API 历史兼容收口设计

> 维护说明：runner 历史证据和 continuation 指纹的边界由
> [业务兼容边界加固设计](./business-compatibility-boundary-hardening.md)补充约束；该加固文档优先于本文早期的迁移草案。

## 目的

本设计处理 Ling Stack 中仍在生产路径上的历史业务数据和 API 兼容逻辑。目标是让新代码只使用一套规范合同，同时保留足够的历史读取、恢复和审计能力，避免删除旧字段后导致已有工作区、会话、运行记录或媒体证据无法读取。

本设计独立于主题和 UI 样式改动，当前 SQLite 迁移头为 178。本轮不直接修改用户数据库，所有数据变更都通过版本化、事务化迁移完成。

## 规范合同

### 权限设置

规范字段是：

- `authorizationMode`: `ask | smart | always`
- `workspaceAccessMode`: `read_only | workspace_write | full_access`

`permissionMode` 和 `permissionPreset` 是旧合同。迁移期允许读取旧值并转换成规范值；新客户端完成切换后，旧字段不得再写入。

### Runner

规范 Pi runner id 是 `pi`。`pi-coding-agent` 只代表历史别名。新记录只写 `pi`，历史记录在迁移完成前可以通过只读别名解析。

工作单元、attempt、队友和 continuation 的可变 scalar binding 可以在版本化迁移中写成 `pi`；run/runtime/control-plane/channel 的历史 JSON、准备输入和证据快照保留原始字节与 fingerprint，由读取 mapper 投影成 `pi`。迁移不能为了展示规范 ID 重写不可变证据。

### Media evidence

新媒体任务只生成当前协议。`comfy_jobs_v1` 和 `comfy_prompt_legacy_v1` 的差异属于外部执行证据格式，旧协议只保留只读解码和历史任务恢复，不允许新任务选择旧协议。

### Web DTO

Daemon wire types 的唯一归属是 `@ling-stack/contracts`，请求和响应调用的唯一客户端是 `@ling-stack/api-client`。`apps/web/src/types.ts` 只能在迁移期作为转出口，不能继续成为新的业务类型来源。

### Theme storage

浏览器主题 IndexedDB/localStorage 迁移属于独立的客户端存储域。它不能与 SQLite/API 迁移混在同一个 cutover 中，也不能因为清理业务兼容层而删除用户主题记录。

## 兼容边界矩阵

| 领域 | 历史输入 | 当前问题 | 收口动作 | 删除门槛 |
| --- | --- | --- | --- | --- |
| SQLite workspace settings | 旧权限字段和新权限字段并存 | Store 双读双写 | 177 迁移补齐规范字段；随后停止旧字段写入 | 所有受支持客户端完成 API v2 切换 |
| SQLite runner records | `pi-coding-agent`、旧 JSON 快照 | 运行时仍需 alias | 一次性规范化工作单元、尝试、队友和工作流配置 | 历史活动任务归档且零旧 id 写入 |
| API settings | 新旧权限字段均被 parser 接受 | 旧写法仍可进入业务层 | API v2 只接收规范字段，旧写法返回稳定迁移错误 | 客户端矩阵和旧请求拒绝测试全绿 |
| Media evidence | `comfy_prompt_legacy_v1` | 旧协议仍出现在证据类型 | 新任务禁止旧协议，历史证据只读 | 保留期结束且历史导出已完成 |
| Web DTO | `apps/web/src/types.ts` 重导出 | 新代码容易继续依赖兼容层 | 迁移 imports 到 contracts/api-client | production caller 数量为 0 |
| Theme browser storage | legacy localStorage keys、v1 package metadata | 旧记录可能只有 manifest | 记录级升级和显式修复 | 所有历史记录完成升级并有恢复路径 |

## 迁移阶段

### A. 盘点与冻结

先扫描真实 schema、旧字段数量、旧 runner id 数量、旧媒体协议数量和 Web production caller。盘点只读，不自动改库。扫描结果作为迁移输入快照保存到测试 fixture，不保存密钥或媒体正文。

### B. 数据 canonicalization

新增 SQLite migration 177：

1. 在单事务中读取 `workspace_settings.settings_json`。
2. 对缺失的规范权限字段按旧字段推导；规范字段已存在时以规范字段为准。
3. 保留所有无关设置，迁移只改变权限字段。
4. 写入迁移标记，重复启动不得重复改写。
5. 旧字段在这一阶段仍可读，但不作为新值来源。

Runner 记录使用独立迁移切片，不能把 runner alias 的改写和权限设置迁移绑在同一事务中。该迁移只处理可变 scalar binding；不可变 JSON 和 evidence 不在迁移里改写。

### C. API cutover

不改变现有 URL。为 workspace settings 和 run/conversation 权限请求增加明确的合同版本字段（`schemaVersion: 2`），并执行以下规则：

- v2 请求只能写 `authorizationMode`、`workspaceAccessMode`；
- v1 请求在迁移窗口内可以只读返回规范字段和旧投影；
- v2 收到旧字段时返回稳定错误 `legacy_permission_fields_removed`；
- 历史 run snapshot、continuation 和 evidence 仍按旧 schema 解码，不被 API v2 拒绝。

### D. 旧写入路径关闭

Web request builders、settings controller、automation、teammate direct message 和 daemon route parser 全部切到规范字段。通过 source audit 确认没有 production caller 再构造旧字段后，删除旧字段写入分支；旧字段读取只保留在明确命名的历史 decoder 中。

### E. 运行时和证据收口

迁移完成后，runner registry 不再把旧 alias 暴露给新设置列表；历史记录读取器仍能把旧值映射到 `pi`。Media adapter 的新任务入口固定 `comfy_jobs_v1`：连接检查、工作流试运行、会话生成和媒体执行前置检查遇到 `prompt_legacy` 时返回 `legacy_media_protocol_removed`；已持久化的 legacy handle 仍允许轮询、恢复、取消和证据解码。legacy decoder 不承担新任务创建职责。

### F. DTO 和客户端收口

逐域把 Web API 模块迁移到 `@ling-stack/api-client` 和 `@ling-stack/contracts`，保持请求 URL、错误映射和 `cwd` 语义不变。本轮已完成 `apps/web/src/api/**` 的 daemon DTO 直接引入，表单状态仍是 Web-only 类型；`types.ts` 的兼容转出口留到其余 production caller 清零后再删除。

## 不变量

- 历史记录只能被规范化，不能被静默删除或伪造为成功。
- 新写入不能产生旧字段、旧 runner id 或 legacy media protocol。
- 迁移失败必须回滚本次事务，下一次启动可安全重试。
- 旧客户端的读取失败必须是可诊断的迁移错误，不能悄悄套默认值覆盖用户数据。
- 迁移不改变权限含义；无法无损推导的组合必须标记为 `custom` 或阻止迁移，不得猜测为 full access。
- 主题存储、SQLite 业务数据和外部媒体证据分别拥有自己的版本号和回滚边界。

## 验收条件

1. 旧 workspace settings fixture 迁移后只增加规范字段，迁移重复执行无变化。
2. 新 API 请求成功，旧 API 写入请求得到稳定迁移错误。
3. 旧 runner 记录、历史 continuation 和 replay 仍可读取；新的可变 binding 只保存 `pi`，历史 JSON 的原始 fingerprint 不变。
4. legacy ComfyUI evidence 可读，新媒体任务不会生成 legacy protocol。
5. Web API production source 不再直接依赖 DTO 兼容转出口；剩余 Web-only 表单状态不属于 daemon DTO。
6. 主题历史记录升级或进入可操作的修复状态，不能丢失（独立客户端切片，不作为本 PR 的交付项）。
7. Core、Daemon、contracts、api-client、Web typecheck 和相关 E2E 全部通过，且 PR 只包含本分支范围。

## 非目标

- 不删除历史 SQLite 表、run snapshot、continuation 或 media evidence。
- 不重写 daemon 路由，不引入 OpenAPI 生成器。
- 不把主题资源、视觉 token 或设计文档带入本分支。
- 不修改真实用户数据库；真实数据库迁移只在发布启动路径执行并保留备份/回滚策略。
