# 业务数据与 API 历史兼容边界加固设计

## 目标

本切片处理 `main` 中仍然分散在业务入口、SQLite mapper 和运行时恢复路径的历史兼容逻辑。目标是让新请求和新写入只使用规范合同，同时让旧数据、旧会话和旧媒体证据继续可读、可恢复、可审计。

本切片独立于主题图片、主题 token、主题 CSS 和主题设计文档。它从 `origin/main` 的业务兼容收口（迁移头 178）开始，不修改真实用户数据库，不删除历史表或历史证据。

## 规范合同

- Runner 的规范 ID 是 `pi`；`pi-coding-agent` 只在历史输入和只读投影边界识别。
- 权限的新合同是 `authorizationMode` 与 `workspaceAccessMode`。v2 写入只接受这两个轴；`permissionMode` 与 `permissionPreset` 只由明确的 v1 decoder 和旧响应投影处理。
- Media 新任务只创建 `jobs_v1`；`prompt_legacy`/`comfy_prompt_legacy_v1` 只用于既有证据解码、轮询、恢复和审计。
- 历史 JSON 快照、运行事件和 control-plane evidence 的原始字节及 fingerprint 是审计证据，不能为了展示规范 ID 而重写。读取 mapper 返回规范投影，存储层保留原始值。
- Web API 模块只能向 daemon 发送规范请求；Web-only 表单状态可以保留，但不能把兼容字段直接当作 daemon DTO 的新来源。

## 现状问题

1. Runner alias 的规范化已分布在 daemon 多个 parser，Core mapper 对 JSON 快照、运行事件和 control-plane data 仍有缺口，容易出现同一历史记录在不同页面得到不同 ID。
2. 迁移 178 只负责 runner identity 的可变运行绑定；delegation instruction receipt schema 使用迁移 193。历史 JSON evidence 仍按原始字节保留，避免破坏 audit/replay fingerprint 不变量。
3. 用户输入 continuation 读取时如果直接用规范化后的对象计算 fingerprint，会把历史证据投影误当成持久化来源，导致恢复校验不一致。
4. 旧权限字段和 legacy media protocol 的兼容逻辑没有统一的“新写入禁止、旧读取允许”边界，新增入口容易再次写入旧形状。

## 加固方案

### A. 单一 runner 身份模块

新增 `@ling-stack/core` 的 runner identity 模块，集中提供：

- `normalizeRunnerId`：请求、可变绑定和新写入使用；
- `normalizeRunnerIdsInSnapshot`：只读投影使用，只遍历身份字段，不改用户文本；
- canonical/legacy 常量，供 daemon、Core 和测试共同使用。

Daemon parser、runner registry 和 Core mapper 统一调用该模块，移除局部字符串比较。

### B. 可变数据迁移与不可变证据投影分离

现有 runner 迁移只规范化可变 operational binding（队友、工作单元、attempt、continuation 的 scalar runner 列）。历史 JSON snapshot、runtime event、control-plane data 和 context snapshot 不在迁移中改写；读取时由 mapper 投影规范 ID。

迁移保持事务、幂等和失败回滚。已存在的 migration marker 不重复执行；未知 runner ID 不被猜测或改写。

### C. continuation fingerprint 保持原文校验

Continuation 读取同时保留 `storedValue` 和 `projectedValue`：

- 用 `storedValue` 校验数据库 fingerprint；
- 用 `projectedValue` 做当前 schema 的关联检查和返回；
- 任何 runner alias 变化都不能改变原始 prepared input 的 hash，也不能成为第二次 continuation 的新权限来源。

### D. 权限与媒体兼容边界

保留已有 v1 读取和历史 DTO 投影，但把 v2 的旧字段拒绝、media legacy create 拒绝和历史 evidence decoder 测试固定在统一回归套件中。新业务入口必须通过规范 builder/parser，不得自行拼接旧字段。

### E. Web DTO 收口

本切片只修复业务入口依赖：新 API client 请求使用 contracts 的 v2 类型；`apps/web/src/types.ts` 的 Web-only 表单类型继续保留。删除完整兼容转出口属于后续独立 cutover，必须等 production caller 为零并完成版本化 API 发布。

## 文件边界

允许修改：

- `packages/core/src/runner-ids.ts`、SQLite mapper/migration/store 及对应测试；
- `packages/daemon` 的 runner/parser/continuation 边界及对应测试；
- 必要的 `packages/contracts`、`packages/api-client`、`apps/web/src/api` 请求类型；
- 本设计和实施计划文档。

禁止修改：

- `apps/web/public/themes/**`、主题 CSS/token、主题图片、主题验收截图；
- 主题设计文档和主题分支业务；
- 真实用户数据库、用户认证配置和本地服务状态。

## 验收不变量

- 新写入中不存在 `pi-coding-agent`、v2 权限旧字段或 legacy media protocol。
- 历史 JSON 的存储字节和 fingerprint 不变；读取 API 能得到规范 runner ID。
- 迁移成功、重复执行和任一行更新失败都可验证；失败不写 marker。
- v1 历史读取仍成功；v2 旧字段得到稳定错误码；历史 media evidence 仍可解码。
- 业务分支 diff 不包含主题资源或主题设计文件。
