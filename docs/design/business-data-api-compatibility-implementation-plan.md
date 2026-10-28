# 业务数据与 API 历史兼容收口实施计划

本文是 `business-data-api-compatibility-cutover.md` 的执行计划。每个工作包都包含源码边界、测试、退出条件和停止条件。实施顺序固定为先数据合同，再 API 写入，再运行时协议，最后 DTO 清理。

## 分支与范围

- 分支：`gansx/business-data-api-compatibility`
- 基线：最新 `origin/main`
- 允许修改：`packages/core`、`packages/contracts`、`packages/api-client`、`packages/daemon`、`apps/web/src/api`、必要的 Web domain 类型、迁移测试和本计划对应的设计文档。
- 禁止修改：主题图片、主题 token、主题 CSS、主题验收截图和主题设计文档。
- 交付：一个独立 PR，目标分支 `main`。PR 合并前不得把主题分支内容带入。

## WP0：基线和盘点

### 工作

1. 记录 `origin/main` SHA、Node/pnpm 版本和现有迁移头。
2. 检查 `workspace_settings`、runner 相关表、媒体 evidence 表的 schema。
3. 扫描 production source 中的旧权限字段、旧 runner alias、legacy media protocol 和 `apps/web/src/types.ts` imports。
4. 保存旧形状 fixture：旧权限 JSON、旧 runner 行、旧 ComfyUI evidence、旧 Web DTO response。

### 验收

- 盘点脚本只读且可重复。
- 旧形状 fixture 不含真实密钥、绝对用户路径或媒体正文。
- 未发现主题文件出现在分支 diff。

## WP1：权限设置 SQLite migration 177

### 文件边界

- 新增 `packages/core/src/storage/sqlite/workspace-permission-migration.ts`。
- 接入 `packages/core/src/storage/sqlite-run-store.ts` 的迁移启动链。
- 只读/写入逻辑集中在 `packages/core/src/storage/sqlite/workspace-settings-store.ts`。
- 新增 `packages/core/test/workspace-permission-migration.test.mjs`。

### 实施

1. 定义 `WORKSPACE_PERMISSION_MIGRATION_VERSION = 177` 和稳定名称。
2. 对每个 workspace settings JSON 做规范化：规范字段优先，旧字段只用于缺失值推导。
3. 使用事务和 postcondition 检查，确保 JSON 可解析、规范字段合法、`schema_migrations` 只记录一次。
4. 新写入先保留旧字段镜像，直到 WP2 API cutover 完成；镜像只能由集中 projection helper 产生，不能散落在业务调用点。

### 测试

- old-only、canonical-only、both-with-conflict、malformed JSON、重复迁移、record marker 失败、postcondition 失败和事务回滚。

### 停止条件

发现规范字段和旧字段含义无法无损映射时，不猜测默认值；保留原数据并返回迁移诊断。

## WP2：API v2 和旧写入拒绝

### 文件边界

- `packages/contracts/src/settings.ts`：增加请求合同版本和迁移错误类型。
- `packages/daemon/src/features/settings/effective-config.ts`：解析 v2，拒绝旧字段。
- `packages/daemon/src/server/router.ts`：统一错误响应。
- `apps/web/src/api/run-request-builders.ts`、workspace settings controller 和 conversation request builders：只发规范字段。
- `packages/api-client`：透传稳定错误并提供类型。

### 实施

1. v2 请求明确声明 `schemaVersion: 2`。
2. v2 请求出现 `defaultPermissionMode`、`defaultPermissionPreset`、`permissionMode` 或 `permissionPreset` 时返回 `legacy_permission_fields_removed`。
3. v1 读取结果继续提供历史投影，避免旧运行记录和旧客户端读取失败。
4. 规范字段缺失时不得从任意旧字段静默猜测；仅在明确的 v1 decoder 中转换。

### 测试

- v2 canonical PATCH 成功并持久化。
- v2 legacy write 返回 400 和稳定错误码。
- v1 historical read round-trip。
- canonical/legacy 冲突不会扩大权限。
- API client 请求体和错误映射。

## WP3：Runner alias 一次性迁移

### 文件边界

- `packages/core/src/storage/sqlite/runner-id-migration.ts`。
- `packages/core/src/storage/sqlite/runtime-work-mappers.ts`、`runtime-work-unit-store.ts`。
- `packages/daemon/src/runtime/runners.ts`、runner settings。
- teammate/workflow mappers 和对应 Core/Daemon tests。

### 实施

1. 统计并迁移 `work_units`、`work_unit_attempts`、队友 runner id、工作流 JSON、prepared input 和历史请求快照中的 `pi-coding-agent`。
2. 新记录统一写 `pi`。
3. 迁移完成前保留只读 `normalizeStoredRunnerId`，但不在 runner selector 中展示 alias。
4. 迁移后增加零旧 id 写入断言。

### 测试

- 旧记录读取、continuation/replay、并发重试、未知 runner 保持阻止、重复迁移。

## WP4：Media protocol 只读兼容

状态：已完成。

### 文件边界

- `packages/contracts/src/media-execution-evidence.ts`。
- `packages/daemon/src/features/media/native-receipt-observations.ts`、workflow adapter。
- `packages/core/src/storage/sqlite/host-media-*` evidence validation。

### 实施

1. 新任务固定当前协议选择。
2. legacy protocol 只能由已有持久化 evidence 解码。
3. 新建记录若尝试写 legacy protocol，返回稳定错误。
4. 旧 evidence 的恢复、导出和审计字段保持不变。

### 测试

- legacy evidence decode、current protocol create、legacy create reject、未知 protocol reject、历史任务重启恢复。

## WP5：Contracts/API client 收口

状态：已完成本轮 API 边界收口。`apps/web/src/api/**` 的 daemon DTO 已直接从 `@ling-stack/contracts` 引入；表单状态仍保留在 Web-only `types.ts`，避免把 UI 表单模型伪装成业务合同。`apps/web/src/types.ts` 的全量转出口暂不删除，待其余非 API production caller 迁移完再删除。

### 文件边界

- `apps/web/src/api/**` imports。
- `apps/web/src/types.ts` compatibility export。
- `packages/contracts` 和 `packages/api-client` 的缺失 DTO/请求类型。

### 实施

1. 按域迁移 API 模块到 shared contracts/client。
2. 保留 Web-only form state 和 view model。
3. source audit 直到 production caller 不再从兼容转出口获取 daemon DTO。
4. 删除兼容转出口前，先运行全量 typecheck 和 Web build。

### 测试

- contracts build、api-client tests、Web typecheck/build、API adapter E2E。

## WP6：主题存储版本化（独立客户端切片）

状态：不纳入本 PR。主题存储拥有独立的浏览器迁移版本、失败重试和删除边界，必须在单独的客户端切片完成；本分支不修改主题资源、主题 token、主题 CSS 或主题设计文档。

此工作包只处理业务分支中仍被 API/业务调用依赖的主题存储兼容，不改变主题视觉资源。

### 实施

1. 给 IndexedDB record 增加记录版本和升级器。
2. 将旧 localStorage preference 迁移到 canonical selection 后再清理旧键。
3. 只有 manifest 没有 package metadata 的历史主题进入显式修复状态，不能伪造 package checksum。
4. 提供迁移失败重试和用户可见的修复动作。

### 测试

- old key migration、IndexedDB v1/v2/v3/v4 upgrade、missing metadata、corrupt record、retry 和 delete。

## WP7：联合验证、提交和 PR

状态：本地联合验证已完成，准备提交、推送和创建独立 PR。主题分支与主题资源仍未纳入本分支。

### 自动检查

```bash
corepack pnpm --filter @ling-stack/core build
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

本轮已完成的本地证据：

- Core build；96 个 Core 定向迁移/运行时测试全部通过。
- Daemon typecheck/build；权限、媒体兼容和媒体 HTTP 测试全部通过（媒体公共 HTTP 测试 16/16）。
- Contracts build；API client 测试 107/107 通过；Web typecheck/build 通过。
- Web API adapter Playwright 定向测试 5/5 通过。
- 全仓 `corepack pnpm typecheck` 通过。
- Web build 曾因与 Web typecheck 并行写同一份 UI dist 触发一次文件竞态，改为串行后通过；该失败属于构建编排环境，不是代码错误。
- 主题文件审计通过：业务分支 diff 不包含主题图片、主题 CSS、主题设计文档或主题资源目录。

### 交付闸门

- `git diff --name-only origin/main...HEAD` 不包含主题资源、主题 CSS 或主题设计文档。
- 旧形状 fixture、迁移日志和测试均绑定当前提交。
- 失败测试按代码失败、依赖/构建环境失败、未运行分别记录。
- PR 描述写明迁移顺序、旧读边界、回滚方式和验证命令。
- PR 创建成功后等待 CI，修复本分支失败项，再合并到 `main`。

## 回滚

- 代码回滚不会删除历史数据。
- migration 177 和 runner migration 必须事务化；失败自动回滚，成功后保留迁移 marker。
- API v2 若出现兼容性问题，只能暂时恢复 v1 读取，不恢复旧字段的新写入。
- ComfyUI legacy decoder 和历史 DTO reader 在数据保留期内不能随代码回滚删除。
