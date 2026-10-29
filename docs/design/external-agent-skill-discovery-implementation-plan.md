# 共享 `.agents/skills` 方案 A 实施计划

状态：实现中（2026-10-27）。核心根解析、边界守卫、daemon preview/publish、contracts
warning 码、API client、daemon API 测试与 Skill Library 组件（未提交）已在工作树；
UI 测试/浏览器验收与发布证据分级仍待补。全部改动未提交、未创建 PR。
Owner: Skill source sync and Skill Library maintainers
Date: 2026-10-27
Last verified: 2026-10-27 against Main `77a2a859` plus the uncommitted shared-source slice
行为契约（单一事实来源）：
[External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md)
代码锚点：`packages/core/src/skill-source-sync.ts`、`packages/core/src/skill-types.ts`、
`packages/daemon/src/features/skills/routes.ts`、`packages/daemon/src/features/skills/schemas.ts`、
`packages/contracts/src/skills.ts`、`packages/api-client/src/endpoints/skills.ts`、
`apps/web/src/features/settings/skill-library-view-models.ts`

## 0. 目标与完成定义

交付方案 A：自动发现 `<workspace>/.agents/skills` 与 `~/.agents/skills`，只生成可审阅候选；
用户在 Skill Library 中显式选择并确认后才发布；发布物为用户自有技能与 source snapshot；
发布本身不绑定 teammate、不改变工具/审批、不自动进入 runtime。官方 P16/gstack 链路保持独立。

完成定义（全部满足才算交付）：

- 设计契约中的验收标准全部通过，或有明确记录的非阻塞例外；
- `node scripts/check-markdown-links.mjs` 通过；
- 核心、daemon、API client、web 的 focused tests 与 typecheck/build 由实现 owner 执行并留证；
- 现有 DSH Web GUI 上完成候选、确认、已发布三态截图验收；
- P16 官方源回归通过：官方 status/apply 行为不变，shared 操作不影响官方订阅与快照；
- 本地 dirty worktree 上的截图/测试只登记为探索性证据，不冒充候选或正式发布证据（见 §10）。

## 1. 当前实现基线（已存在，未提交）

| 层 | 位置 | 行为 | 测试 |
|---|---|---|---|
| 核心根解析 | `packages/core/src/skill-source-sync.ts:54-58,155-185` | `SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS`；`resolveSharedAgentsSkillSourceRoots()` 只从 workspace cwd 与 `os.homedir()` 派生，只保留存在目录，project 优先、同目录去重 | `packages/core/test/skill-source-shared-roots.test.mjs`（5 个用例） |
| 核心预览守卫 | `packages/core/src/skill-source-sync.ts:64-70,235-296,1003-1006` | `snapshotSourceRoots` 只比较 root 内快照；`allowManagedSkillIdMatching:false` 把 builtin/gstack/workspace 目标判为 `blocked` 并追加 error 级 `skill_id_conflict`；无 definitionPreview | 由 daemon API 测试与后续 core 用例覆盖 |
| 警告码 | `packages/core/src/skill-types.ts:61-65` | 新增 `skill_id_conflict` 警告码 | — |
| daemon 路由 | `packages/daemon/src/features/skills/routes.ts:302-345` | `POST /skills/sync/shared/preview`、`POST /skills/sync/shared/publish`；publish 传 `enforceAutoSafePolicy:false` 与 pack `shared-skill-source-sync` | `packages/daemon/test/shared-skill-source-scan-api.test.mjs`（3 个用例） |
| daemon 预览构造 | `packages/daemon/src/features/skills/routes.ts:1464-1490` | 固定 roots；传入 `snapshotSourceRoots: roots` 与 `allowManagedSkillIdMatching:false` | 同上 |
| 发布参数化 | `packages/daemon/src/features/skills/routes.ts:1490-1570` | 抽取 `pack`（source/packId/name/description）与 `enforceAutoSafePolicy`；gstack 调用保持默认值 | 官方同步既有测试 |
| 请求解析 | `packages/daemon/src/features/skills/schemas.ts:74-90,836-870` | `parseSharedSkillSourceScanRequest` / `parseSharedSkillSourcePublishRequest`；未知字段忽略，`selectedSkillIds` 非空，`allowNewSkills` 默认 false，`publishArtifacts` 默认 true | daemon API 测试 |
| 路由准入 | `packages/daemon/src/server/router.ts:1339-1340` | 两个路径加入 skill 路由白名单 | — |
| 契约 | `packages/contracts/src/skills.ts:131-134,1318-1347` | `SharedSkillSourceScan/PublishRequest/Response`；`skill_id_conflict` 已与 core 对齐 | — |
| API client | `packages/api-client/src/endpoints/skills.ts:174-189` | `previewSharedSkillSources` / `publishSharedSkillSources` | — |
| Web 接线 | `apps/web/src/api/skills.ts:122-127`；`apps/web/src/features/settings/skill-library-view-models.ts:3`；`SkillLibraryNavigation.tsx`；`SkillLibrarySettingsPanel.tsx` | API 包装、`"local"` 分区、导航与面板挂载（未提交） | 待补 |
| UI 组件 | `apps/web/src/features/settings/SharedSkillSourcesSection.tsx`、`shared-skill-sources-model.ts`、`apps/web/e2e/shared-skill-sources.spec.ts` | 第 4 分区、候选表、详情/确认、ignore、路径脱敏（未提交） | 待补（组件测试/e2e） |

已由 `packages/daemon/test/shared-skill-source-scan-api.test.mjs` 覆盖的关键行为：

- 新候选 `new` → 无 `allowNewSkills` 时 409 → 显式确认后发布；
- 发布产物的 `sourceKind`、`upstreamName`、pack、artifacts（`SKILL.md`、`references/*`）；
- 重新扫描 `unchanged`，修改源文件后 `drifted` 且 diff 含 `sourceChecksum`；
- `includeProjectRoot:false` / `includeUserRoot:false` 与 user root 探测；
- 请求中注入 `skillRoots`/`gstackRepoRoots`/`codexSkillRoots`/`roots` 不会扩大扫描范围；
- 无共享目录时返回空预览而非报错；
- shared 发布后官方 `/skills/sync/gstack/status` 仍为 `ready` 且无 revision。

## 2. 对外契约（按当前实现）

### 2.1 端点

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/skills/sync/shared/preview?cwd=` | `includeProjectRoot?`、`includeUserRoot?`、`includeSkillIds?`、`excludeSkillIds?`、`maxSourceBytes?` | `{ cwd, scannedAt, preview: SkillSourceSyncPreviewReport }` |
| POST | `/skills/sync/shared/publish?cwd=` | 上述字段 + `selectedSkillIds`（必填非空）、`allowNewSkills?`（默认 false）、`publishArtifacts?`（默认 true） | `{ cwd, publishedAt, preview, skills, snapshots, artifacts }` |

两个端点都不接受 source root、路径、仓库或连接配置；roots 永远由 daemon 从 `cwd` 与运行时
home 派生。`cwd` 查询参数必填；非 POST 返回 405；非 skill 路由不进入此 handler。

### 2.2 发布校验顺序与错误

1. 选中 id 必须存在于当前预览：`400 skill_source_sync_selection_not_found`；
2. `missing`/`orphaned`/`blocked`（含 `skill_id_conflict`）不可发布：
   `409 skill_source_sync_not_publishable`；
3. 语义 diff 有 error：`409 skill_source_sync_semantic_error`；
4. 选中集含 `new` 且 `allowNewSkills !== true`：
   `409 skill_source_sync_new_skills_require_confirmation`；
5. 缺少 definition preview：`409 skill_source_sync_missing_definition`；
6. `enforceAutoSafePolicy:false`：shared 显式发布不受 `auto-safe` 白名单拒绝。该模式仍属于官方
   自动化语义，shared 没有自动化入口，因此显式人工发布不应被它挡住；
7. 发布在单一事务中完成；失败回滚，不产生部分写入。

`skill_id_conflict` 是 error 级 warning（`packages/core/src/skill-source-sync.ts:285-296`），
出现在记录的 `warnings` 中，而不是单独的 blocked reason 字段；UI 必须把它显示为阻塞原因。

### 2.3 数据与 provenance

- 不新增数据库表；ignore 是客户端 workspace 级状态（见 §4.3）。
- 新发布技能：`source: "skill-directory"`、`packId: "shared-skill-source-sync"`、pack 名
  **Shared .agents skills**；定义来自预览的 `definitionPreview`。
- 快照：`sourceKind: "workspace-skill-directory"`，`upstreamName`/`upstreamSkillPath` 来自
  shared root；raw `SKILL.md` 受现有快照字节上限约束；artifacts 只把 `references/` 与
  `agents/openai.yaml` 纳入 runtime，脚本/资产只做审阅证据、不执行。
- 更新：只归档旧 published snapshot 并写入新 snapshot；不覆盖用户编辑过的
  `SkillDefinition`（与 [Skill Editing And Revision](skill-editing-and-revision.md) 一致）。
- 官方隔离：shared 预览只比较 shared roots 内快照；shared 发布不写官方订阅、不刷新官方缓存、
  不写 `gstack` registry 条目。

## 3. 剩余工作（按优先级）

### P0-A 契约类型对齐（已完成 2026-10-27）

- `packages/contracts/src/skills.ts:133` 已包含 `skill_id_conflict`，与
  `packages/core/src/skill-types.ts:65` 对齐。
- 仍建议补一条类型/序列化断言测试，防止后续 warning 码再次漂移；`SkillSourceSyncRecordState`、
  `SkillSourceScanRoot`、`SkillSourceSyncPreviewReport` 无需新增字段。

完成标准：core/daemon 测试通过，web 能对 blocked 记录给出专门文案（UI 验收仍归 P0-B）。

### P0-B Skill Library 界面（skills-ui owner）

- 第 4 分区 **Local skill folders**：`SkillLibrarySectionId` 已含 `"local"`；导航顺序
  My skills → Local skill folders → AI evolution → Built-in skills；进入 Skill Library 仍默认
  My skills，不写 localStorage 记住分区。
- 数据控制器：进入分区或点击 **Refresh** 时调用 `previewSharedSkillSources(cwd,{})`；
  请求失败显示可重试错误；发布成功后刷新 shared 预览与 `/skills` registry。
- 候选表：按 root 分组（Workspace / Home + `.agents/skills` 标签）；列 `Skill / State /
  Source / Updated / Actions`；选择框只对可发布记录启用；状态映射见设计文档。
- 详情：状态原因、warnings（含 `skill_id_conflict`）、front matter/agent metadata、drift diff、
  引用文件清单（path/kind/size）、有界源码预览。禁止渲染 `roots[].rootPath` 或
  `record.sourcePath` 绝对路径；用 `sourceRootId` + `upstreamSkillPath` 生成相对展示。
- 发布确认：点击 **Publish selected** 弹确认框，列出将新建/更新的技能名；仅当选择含 `new`
  时把 `allowNewSkills` 置 true；`publishArtifacts` 传 true；blocked/unchanged 不可选。
  409 错误按 code 映射产品文案（尤其 `skill_source_sync_new_skills_require_confirmation` 与
  `skill_source_sync_not_publishable`）。
- 发布后的用户认知：toast 说明“已发布到 My skills；绑定 teammate 仍需单独操作”，不自动跳转，
  不自动绑定。
- 空态：两个目录都不存在时显示已检查的安全位置与创建方法；不显示绝对路径。
- badge：只能来自本会话最近一次预览的可操作数（new + drifted，排除 ignored/blocked/
  unchanged）；没有预览时不显示数字，不引入后台扫描。

完成标准：UI 在主流程中可完成 scan → inspect → confirm → publish → 在 My skills 看到条目；
无绝对路径泄漏；无自动发布路径。

### P0-C ignore / restore（客户端）

- 存储：workspace 级 localStorage，建议 key
  `ling-stack.skill-library.shared-ignored.v1:<cwd>`，值为 `"<rootId>:<skillId>"` 数组；
  切换 workspace 不串数据；隐私模式/配额失败时退化为本次会话内存态，不阻塞主流程。
- 语义：只允许忽略非已采纳记录；ignored 默认隐藏、不计入 badge、不可选择发布；
  **Show ignored** 可查看并 Restore；刷新/重开仍生效；不删除 skill/snapshot。
- 安全边界：ignore 不是服务端治理字段；清空站点数据即恢复，daemon 不读取该状态。

完成标准：忽略/恢复正常且跨刷新保留；已采纳技能只能通过 My skills 归档/删除；
blocked 记录可忽略。

### P0-D daemon 测试补齐

当前 daemon 测试覆盖主路径，尚需补：

1. `skill_id_conflict`：在 registry 里放一个 builtin/gstack 同名技能，shared 预览该记录为
   `blocked` 且 warnings 含 error 级 `skill_id_conflict`；publish 选中时 409。
2. 官方快照隔离：预置一个官方 gstack source snapshot（或模拟 snapshot），shared 预览不得把它
   标为 `missing`/`drifted`。
3. `missing`：发布后删除共享目录，重扫为 `missing`，registry 与快照仍在。
4. auto-safe：workspace policy 设为 `auto-safe` 时，显式 shared publish 仍可成功（验证
   `enforceAutoSafePolicy:false`），并且不经过 `approvedRootIds` 白名单。
5. 路径不可注入：已有测试覆盖 roots 注入，可加一条 `sourcePath` 伪造 body 字段被忽略。
6. 审计：发布产生 `source_publish` control-plane 事件（可断言事件计数/类型）。
7. 原子性：批量中一个记录 blocked 时整批 409 且无任何写入。

完成标准：新增测试全绿；官方 gstack 既有测试不回归。

### P0-E i18n 与文案

- en-US 与 zh-CN 的 `apps/web/src/i18n/locales/*.ts` 新增 key：`Local skill folders`、
  `Local skill folder`、`This folder belongs to another agent tool. Ling only reads it.`、
  `Nothing here is available to teammates until you publish it.`、`Publish selected`、
  `Update available`、`Up to date`、`Source missing`、`Ignore`、`Restore`、`Show ignored`、
  `Blocked`、`This skill uses an id reserved by a built-in or official skill.` 等。
- 若仓库要求同步 `packages/localization/catalogs/en-US.json` / `zh-CN.json`，按现有 i18n
  流程补目录并跑 `corepack pnpm check:i18n`；其他 locale 走既有翻译/回退流程，不手改生成物。
- 深链/长文案避免暴露 “shared source sync” 等内部术语；产品名统一为 **Local skill folders**。

### P0-F 文档与索引（本次 docs 变更）

- 新设计文档：`docs/design/external-agent-skill-discovery.md`（行为契约）。
- 本实施计划：`docs/design/external-agent-skill-discovery-implementation-plan.md`。
- 旧契约同步：P16、gstack skill source sync、Skill Library ownership、Skill Capability
  Model、Skill Editing、P15、GStack upgrade lifecycle、AI Teammates and Skills。
- 索引：`docs/design/README.md` 增加两条；
  `docs/design/implementation-status.md` 增加待决/推进项。
- 校验：`node scripts/check-markdown-links.mjs` 通过。

### P0-G 实现验收命令（实现 owner 执行，文档 owner 不跑到构建）

```bash
corepack pnpm --filter @ling-stack/core build
node --test packages/core/test/skill-source-shared-roots.test.mjs
corepack pnpm --filter @ling-stack/daemon build
node --test packages/daemon/test/shared-skill-source-scan-api.test.mjs
corepack pnpm --filter @ling-stack/web typecheck
node scripts/check-markdown-links.mjs
```

浏览器验收：现有 DSH Web GUI 打开 Settings → Skill Library → Local skill folders，
截取候选、确认框、发布后 My skills 三张图；确认无绝对路径、无自动发布。

## 4. UI 详细契约（供 skills-ui 实现与测试）

### 4.1 状态与动作映射

| 代码状态 | UI 文案 | 可选择发布 | 其他动作 |
|---|---|---|---|
| `new` | New | 是（确认后 `allowNewSkills:true`） | 查看详情、忽略 |
| `attachable`（本流程已采纳、缺活动快照） | Adopt source | 是 | 查看详情、忽略 |
| `attachable`（其他 owner，含 managed 与其他用户自有） | Blocked | 否 | 查看原因（`skill_id_conflict`）、忽略 |
| `drifted` | Update available | 是 | 查看 diff、忽略 |
| `unchanged` | Up to date | 否 | 查看详情 |
| `blocked` | Blocked | 否 | 查看原因、忽略 |
| `missing` | Source missing | 否 | 去 My skills 管理 |
| `orphaned` | 不展示（诊断） | 否 | — |
| ignored（客户端） | Ignored | 否 | Restore |

### 4.2 路径展示

`preview.roots[].rootPath` 与 `record.sourcePath` 是绝对路径，仅用于本地逻辑；UI 只显示：

- root 标签：`Workspace · .agents/skills` / `Home · .agents/skills`；
- 相对来源：优先 `record.upstreamSkillPath`，否则用现有 `record.sourcePath` 相对化后的
  `.agents/skills/<dir>/SKILL.md`；
- 详情里的引用文件只显示相对 path、kind、size。

建议加一个纯函数 `sharedSkillSourceDisplayLabel(record, roots)` 并单测，禁止组件内拼接绝对路径。

### 4.3 ignore 存储键

```ts
const key = `ling-stack.skill-library.shared-ignored.v1:${cwd}`;
// value: string[]，元素 `${record.sourceRootId}:${record.skillId}`
```

- 读取失败（隐私模式、坏 JSON）→ 空集合 + 会话内存回退；
- 写入失败 → 不阻塞操作，toast 可提示“本次会话内忽略”；
- workspace 切换重新读取；不清除已发布技能的任何服务端状态。

### 4.4 发布确认交互

- 选择集为空或只含不可发布记录 → 按钮禁用；
- 确认框按 `new` / `drifted` 分组计数，列出名称；文案明确“发布不会授予工具或绑定 teammate”；
- 确认后才调用 `publishSharedSkillSources`，`allowNewSkills = selection.hasNew`；
- 成功后：toast + 刷新 shared 预览 + 刷新 registry；失败：保留选择，按错误码给可操作提示。

## 5. 测试矩阵（目标态）

| 用例 | 层 | 预期 | 现状 |
|---|---|---|---|
| project/user root 探测、去重、include 开关、无目录 | core | 见现有 5 用例 | 已有 |
| 任意路径/未知字段注入不扩大范围 | daemon | 只扫固定 roots | 已有 |
| new 无确认 409，确认后发布 | daemon | 200 + registry/snapshot/artifacts | 已有 |
| unchanged/drifted 与 checksum diff | daemon | 状态与 diff 正确 | 已有 |
| 官方 status 不受 shared 发布影响 | daemon | ready 且无 revision | 已有（基础） |
| managed id → blocked + `skill_id_conflict` + publish 409 | daemon/core | 不可发布 | 待补 |
| 官方快照不被 shared 预览判 missing/drifted | daemon | 预览不含官方记录 | 待补 |
| 删除源目录 → missing，条目保留 | daemon | missing | 待补 |
| auto-safe 策略下显式 shared publish 仍成功 | daemon | 200；官方 auto-safe 语义不变 | 待补 |
| 批量含 blocked → 409 且零写入 | daemon | 原子性 | 待补 |
| contracts 含 `skill_id_conflict` | contracts | 类型检查 | 待补 |
| 第 4 分区、状态、确认、ignore、路径脱敏 | web/view-model | 见 §4 | 待补 |
| 浏览器三态截图 | e2e/人工 | 候选/确认/已发布 | 待做 |

## 6. 顺序与完成标准

1. **P0-A contracts 对齐**：类型补齐 + 测试。完成标准：core/daemon 编译与 focused tests 绿。
2. **P0-B/C UI**：数据控制器 → 列表/详情 → 确认 → ignore → badge。完成标准：主流程可走通，
   无自动发布，无绝对路径。
3. **P0-D daemon 测试**：补齐上表。完成标准：新增测试与既有测试全绿。
4. **P0-E i18n**：文案 + parity。完成标准：`check:i18n` 通过或记录既有例外。
5. **P0-F docs**：本文档、设计文档、旧契约与索引。完成标准：docs check 通过。
6. **P0-G 验收**：类型/构建/focused tests/截图。完成标准：§0 全部满足。

依赖关系：P0-A 与 P0-B 可并行（UI 先按 contracts 现状开发，warning 码跟进）；
P0-D 依赖 P0-A；P0-G 最后执行。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| contracts warning 码未同步 | UI/类型消费者丢失 `skill_id_conflict`，blocked 文案不专用 | P0-A 优先补齐并加断言 |
| 绝对路径进入 UI | 隐私与 P16 口径不一致 | §4.2 纯函数 + 测试；后续 daemon 公共投影另立契约 |
| localStorage 不可用/被清 | ignore 丢失或多端不一致 | 会话内存回退；文档声明非安全控制；服务端持久化列为未决 |
| 自然名与 builtin/official 冲突 | 用户误以为可覆盖内置技能 | managed 目标 blocked + `skill_id_conflict`，UI 明确“保留内置技能” |
| 两 root 同名 | 结果不确定 | project 优先；低优先级 blocked；测试覆盖 |
| 大文件/截断源 | 发布被拒或快照受限 | 现有 256KB 快照上限与 truncated 拒绝；UI 显示 blocked 原因 |
| 预览到发布之间源文件变化 | 发布陈旧内容 | publish 重新扫描并校验 checksum；变化时 409 |
| auto-safe 语义混淆 | 误以为 shared 也自动更新 | shared 无自动入口；`enforceAutoSafePolicy:false` 只影响“显式发布被误挡”，不产生自动发布 |
| 官方/共享快照串扰 | 官方技能被标 missing 或错误 drift | `snapshotSourceRoots` 过滤 + 隔离测试 |

## 8. 验收清单

- [ ] `/skills/sync/shared/preview` 只扫固定 roots，未知字段不扩大范围；
- [ ] 预览包含 root/候选/状态/diff/warnings，且不写 registry/snapshot；
- [ ] managed 目标 blocked（`skill_id_conflict`），发布拒绝；
- [ ] shared 预览不引用官方快照，`missing` 只针对 shared 源；
- [ ] new 必须 `allowNewSkills` 确认；blocked/missing 不可发布；
- [ ] 发布产物 `source=skill-directory`、pack `shared-skill-source-sync`，定义不被后续更新覆盖；
- [ ] 官方 status/apply 行为不变，shared 不写官方缓存/订阅；
- [ ] UI 第 4 分区、状态、详情、确认、ignore/restore、badge 符合 §4；
- [ ] UI 不显示绝对路径；无自动发布/自动绑定入口；
- [ ] i18n 与 docs check 通过；三态截图归档为验收证据；
- [ ] 证据记录按 §10 分级：本地 dirty worktree 截图/构建只标为探索性，不写成 candidate/release；
- [ ] 未创建 PR、未提交（按当前团队约定）。

## 9. 未决问题

- 是否将 ignore 决策服务端持久化（多客户端/桌面与 Web 同步）。
- 是否为 shared 采纳引入独立 id 命名空间（当前复用自然名；managed 冲突以 blocked 处理）。
- daemon 是否提供公共投影以彻底去除绝对路径字段。
- 是否扩展 `~/.codex/skills` 或其他共享位置（需单独信任契约）。
- badge 是否需要在无预览时显示上次会话计数（当前只允许会话内预览驱动）。
- `scripts/release/desktop-prerequisites.mjs` 是否也应感知
  `LING_PACKAGED_RELEASE_REVIEW_REQUIRED`：当前它无条件要求 selection，导致本地放宽档执行
  `require` 也会失败；需 release owner 决定是本地跳过还是按严格开关分支。

## 10. 本地 dirty worktree、Office 打包与正式发布 provenance

本节是跨领域补充：方案 A 的验收证据来自本地工作树，而 Desktop/Office 打包有自己的发布
入口。这里明确“本地探索性证据”与“严格正式发布”的界线，避免把 dirty worktree 上的构建或
截图写成 candidate/release 证据。权威发布规则仍在 `docs/release/`。

### 10.1 证据分级

| 级别 | 产生方式 | 可声称的范围 | 不可声称 |
|---|---|---|---|
| L0 本地 dirty worktree | 当前工作树直接运行 `package:mac`/`package:win`、dev 运行、focused tests、UI 截图（本方案 P0-G 的截图属于此类） | “本地工程观察/探索性证据”，可附 `git rev-parse HEAD` 与完整 `git status --porcelain` 说明改动 | candidate、release、安装包验收、Office/发布 provenance |
| L1 未签名候选 | `.github/workflows/desktop-prerelease.yml` 固定 `source_sha` 构建；或本地在干净 checkout 上按同一组 `DESKTOP_SOURCE_SHA`/`DESKTOP_RELEASE_TAG` 命令运行 | `unsigned_dev` + `development` + `releaseReady:false` 的 Actions artifact 或 Draft prerelease；安装/模型/Office 验收仍须另做 | 正式发布、签名/公证、clean-machine 验收 |
| L2 正式发布 | 满足 `docs/release/desktop.md` 的 Developer ID/notarization、Authenticode/SmartScreen、clean-machine、分发材料等门禁 | 面向用户的受支持发行版 | —（不可由 L0/L1 推导） |

本方案（共享 `.agents/skills`）不产生 Desktop 发布物，因此 §0 的三态截图只能是 L0；若要把
某项验证变成可归属证据，需在干净 checkout 上重跑并记录 commit SHA 与完整 `git status` 输出。

### 10.2 正式发布入口的实际执行点

| 执行点 | 位置 | 强制内容 |
|---|---|---|
| 候选校验 | `scripts/release/desktop-release.mjs:37-49` | 完整 40 位 SHA；`HEAD` 必须等于该 SHA；`VERSION`/根 `package.json`/Desktop `package.json` 版本与 tag 一致；`git status --porcelain --untracked-files=no` 必须为空；`requireMain` 时校验 `origin/main` 祖先关系与 tag 不存在 |
| candidate 命令 | `scripts/release/desktop-release.mjs:189-206` | `candidate`/`collect`/`assemble` 三个入口都先走 `readCandidate`；candidate 输出 `signingTier:"unsigned_dev"`、`distributionChannel:"development"`、`releaseReady:false`（`:29-30`） |
| 前置检查 | `scripts/release/desktop-prerequisites.mjs:14` | 原生打包前再次执行同一候选校验；`require` 失败即阻断 |
| 包体验证 | `scripts/release/verify-desktop-package.mjs:76` | 归档验证前再次候选校验；只证明归档结构与未签名开发包，不证明安装/运行时/发布就绪 |
| 汇总/草稿 | `.github/workflows/desktop-prerelease.yml:37-330` | 只在手动 `create_draft` 且双平台成功后进入 `draft`；`assemble` 校验两平台 manifest/checksums；`create-desktop-draft.mjs:73-80` 重新 `readCandidate({requireMain:true})` 并校验 Draft/资产摘要，不覆盖已有 tag/Release |
| 本地打包旁路 | `apps/desktop/package.json:50-51` | `package:mac`/`package:win` 是本地开发命令，不调用 `readCandidate`，因此不检查 SHA/tag/cleanliness；产物不可当作 L1/L2 证据 |
| Office 固定通道 | `apps/desktop/scripts/package-macos-with-office.mjs:20-90`；`.github/workflows/desktop-prerelease.yml:252` | 固定 `darwin+arm64+unsigned_dev`、默认 ad-hoc signer、拒绝 Cua provider；要求 Office 审查文件存在，但不做 git clean/SHA 校验。工作流在 `package:mac` 前设置 `LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1`；本地 `package:mac` 不设置，走放宽档 |
| gstack selection 依赖 | `apps/desktop/scripts/packaged-gstack-resources.mjs:12`；`apps/desktop/scripts/build-packaged-daemon.mjs:179` | selection 缺失时：严格档（`LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1`）→ 失败；本地放宽档 → `required:false`，可无 bundled gstack 继续打包。`scripts/release/desktop-prerequisites.mjs:77` 仍无条件要求 selection |

### 10.3 Office 打包的 provenance 现状与缺口

**Office 审查与 release 是两套绑定。** `native/office-local/reviewed-packaged-source-v1.json`
是机器绑定的源码/工具链审查记录，审查说明绑定 reviewed source
`37bbdf6de05c691fa6949543657d04e84dd17342`（`native/office-local/reviewed-packaged-source-v1-review.md:4`）。
`apps/desktop/scripts/packaged-office-native-review.mjs:11,59` 在缺失时直接报
`packaged_office_native_source_review_missing`；`native/office-local` 下 15 个原生输入和
1,211 个打包输入由摘要清单约束。

**严格/本地两档由 `LING_PACKAGED_RELEASE_REVIEW_REQUIRED` 控制：**

- `packaged-office-native-review.mjs:86`：仅当该变量为 `1` 时校验编译工具链 profile 与审查记录
  完全匹配；否则接受“当前主机观察到的工具链”。
- `packaged-office-daemon-source-inputs.mjs:66`：仅当为 `1` 时用 `review.packagingSha256`
  作为允许清单与期望摘要；否则允许清单中的所有路径只做“当前字节自校验”，不绑定审查摘要。

**缺口（需要发布 owner 决定是否本轮修）：**

1. **严格开关已由 workflow 设置，但本地与 prerequisites 仍有缺口。**
   `.github/workflows/desktop-prerelease.yml:252` 已在 `package:mac` 前设置
   `LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1`，因此 L1 候选的 Office 打包会走严格档
   （工具链 profile 与 `review.packagingSha256` 都绑定 review）。
   本地 `package:mac`/`package:win` 不设置该变量，按设计走放宽档；但
   `scripts/release/desktop-prerequisites.mjs:77` 在本地也**无条件**要求
   `.ling-stack/build/gstack-desktop-selection.json`，即使放宽档允许无 bundled gstack。
   因此本地若要可选化，必须避免执行该 prerequisites 命令，或由 owner 将 selection 检查
   改为受严格开关/显式 bundled-gstack 需求控制。
2. **clean 检查忽略 untracked。** `desktop-release.mjs:44` 使用
   `--untracked-files=no`：未跟踪文件不会阻断发布，而 Electron Builder 的文件匹配可能把未跟踪
   输入打进包。正式发布评审必须另行检查完整 `git status --porcelain`（含 untracked），或由
   入口收紧；文档不能替代该检查。
3. **Office 审查不等于 git provenance。** 摘要闭包只覆盖固定清单；闭包之外的 dirty/untracked
   改动不会被 Office 审查发现，只能靠 clean-tracked 发布入口与人工审查拦截。
4. **本地材料清单明确不可发布。** `apps/desktop/scripts/distribution/materials.mjs:137-141,277`
   用 `git rev-parse HEAD` 记录 `sourceSha`，但 manifest 固定 `releaseEligible:false`；不要把本地
   `distribution/` 与正式发布材料混用。
5. **macOS 正式证据的 commit 绑定更强。** `docs/release/evidence/README.md:186-190` 说明 macOS
   producer 同时记录工作文件 SHA-256 与 Git blob ID，并在采集时用 `git hash-object --path`
   对齐 `<commit>:<path>`；“clean git status 只是额外守卫”。因此 dirty worktree 上生成的
   harness/报告不能作为正式证据。

### 10.4 建议的权威文档更新（本轮未改，需 release owner 授权）

- `docs/release/development-packages.md`：在 macOS/Windows 两节前加统一的 **Provenance** 小节，
  明确 L0/L1/L2、`git status --porcelain`（含 untracked）、Office 严格开关与本地候选不可发布。
- `docs/release/desktop.md`：在“当前 worktree 本地矩阵”附近补“本地 dirty 证据 ≠ candidate/release
  closure”的显式定义，并链接 Office 审查与严格开关。
- `docs/design/office-documents-native-plugin.md` 的 **Release Gates**：补“Office source review、
  strict flag、clean commit 三者缺一不可；本地 dirty 包不能作为 live Excel 验收”。
- `docs/release/github-actions.md`：记录 L1 已在 `package:mac` 前设置
  `LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1`（`.github/workflows/desktop-prerelease.yml:252`）；
  本地放宽档不要设置该变量。
- `docs/release/README.md`：在 Release Classes 中给“Local Desktop development candidate”补
  dirty-worktree 的不可声称范围。

### 10.5 本方案证据记录规则

- 任何本地截图/构建记录都标注：`local dirty worktree`、`git rev-parse HEAD`、完整
  `git status --porcelain`（含 untracked）摘要、命令、时间；不得写“candidate verified”或
  “release ready”。
- 若需要可归属证据，在干净 checkout 上重跑并把 SHA 写入记录；仍不能替代 L2 的签名/公证/
  clean-machine 门禁。

### 10.6 `.ling-stack/build/gstack-desktop-selection.json` 缺失的恢复路径

**错误来源。** 该文件不是提交物，也没有独立生成脚本；它由
`scripts/gstack/prepare-desktop-candidate.mjs` 在 `--stop-after complete` 时用
`--selection <absolute path>` 写出 `{ root, identity }`（`prepare-desktop-candidate.mjs:38,137-143`）。
消费方是 `apps/desktop/scripts/packaged-gstack-resources.mjs:12` 与
`scripts/release/desktop-prerequisites.mjs:77`；缺失时严格档失败，本地放宽档若
`required:false` 可继续（`build-packaged-daemon.mjs:179`）。若报错来自
`desktop-prerequisites.mjs` 的 `bundled-gstack-resources`，则即使本地放宽档也会失败，因为该检查
当前无条件要求 selection。

**最快恢复（复用现有已验证 bundle，仅本地）。** 如果本机已有完整的 managed gstack bundle
（例如 `${GSTACK_BUNDLE_ROOT}` 指向的本地 bundle），
不需要重跑数 GiB 的 native/resource 构建：`readExecutableBundle` 会按当前 `upstream-lock.json`
重新验证 manifest、target、browser 与 receipt，然后可直接写出 selection。

```bash
node --input-type=module -e '
import { readExecutableBundle } from "./scripts/gstack/executable-bundle.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
const root = process.env.GSTACK_BUNDLE_ROOT;
if (!root) throw new Error("Set GSTACK_BUNDLE_ROOT to the local bundle directory");
const bundle = await readExecutableBundle(root);
mkdirSync(".ling-stack/build", { recursive: true });
writeFileSync(".ling-stack/build/gstack-desktop-selection.json",
  JSON.stringify({ root: bundle.root, identity: bundle.identity }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
console.log(bundle.identity.target, bundle.identity.manifestChecksum);
'
```

自检（会按严格模式验证 selection 指向的 bundle）：

```bash
node --input-type=module -e '
import { preparePackagedGstackBuild } from "./apps/desktop/scripts/packaged-gstack-resources.mjs";
const identity = await preparePackagedGstackBuild({
  required: true,
  selectionPath: process.cwd() + "/.ling-stack/build/gstack-desktop-selection.json" });
console.log(identity.target, identity.manifestChecksum);
'
```

注意：这条快捷路径复用 **本机既有 bundle**，只适用于本地工程打包；bundle 的
`executable-build.json` 仍是 `scope:"isolated-local-client"`、`releaseEligible:false`，不能作为
L1/L2 发布证据。正式发布必须在 workflow 中从锁定上游重新生成 selection
（`.github/workflows/desktop-prerelease.yml:203-214`）。

**从锁定上游重建（CI/正式路径）。** 若没有可复用的 bundle，使用完整构建：

**生成前提（本地主机）：**

- 原生 macOS arm64 / Windows x64 目标主机，已安装 `bun`、`bash`、`go`（shell parser）、
  Xcode CLT（macOS）或 MSVC/.NET（Windows）。
- **外部挂载卷**：本地 `initResourceWorkspace` 要求 `--mount` 指向与 home 不同设备的真实目录
  （`scripts/gstack/resource-workspace.mjs:7,38-52,71`）；`--ci-ephemeral` 只接受
  GitHub-hosted 身份（`hostedRunnerStorage`），本地不能用。
- 预算：workspace 逻辑上限 12 GiB、剩余空间至少 20 GiB（`RESOURCE_LIMITS`）。
- `--workspace` 必须是新目录；`--selection` 必须是绝对路径且文件尚不存在（写入用 `flag:"wx"`、
  mode 0600），父目录会被创建。

**可执行命令（在仓库根目录，替换 `<EXTERNAL_VOLUME>`）：**

```bash
export MOUNT="${EXTERNAL_VOLUME:?Set EXTERNAL_VOLUME to an external mount path}"
export WS="$MOUNT/ling-gstack-candidate-$(date +%Y%m%d%H%M%S)"
mkdir -p .ling-stack/build

node scripts/gstack/prepare-desktop-candidate.mjs \
  --workspace "$WS" \
  --mount "$MOUNT" \
  --bun "$(command -v bun)" \
  --shell "$(command -v bash)" \
  --go "$(command -v go)" \
  --selection "$PWD/.ling-stack/build/gstack-desktop-selection.json"
```

等价 workflow 步骤：`.github/workflows/desktop-prerelease.yml:203-214`（CI 用
`--ci-ephemeral` 与 `$RUNNER_TEMP` workspace，不需要外部卷）。该命令默认执行
source → native → resource → archives → inspection → model（跳过，运行时下载）→ assembly，
耗时和磁盘占用都很大；中断会留下 `desktop-candidate-failure.json`，不得当作候选。

**生成后自检：**

```bash
node -e 'const s=require("./.ling-stack/build/gstack-desktop-selection.json"); console.log(s.root, s.identity.manifestChecksum)'
test -d "$(node -p 'require("./.ling-stack/build/gstack-desktop-selection.json").root')"
```

**随后两条路径：**

1. **正式/严格（保持现状）**：保留
   `LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1`，执行 `package:mac`。selection 必须存在且
   `identity` 与打包目标一致；缺失即失败，这是 release 正确行为。
2. **本地放宽（可选 bundled gstack）**：不设置严格变量，直接运行
   `corepack pnpm --filter @ling-stack/desktop package:mac`；`build-packaged-daemon.mjs:179`
   会以 `required:false` 跳过 selection，产物不含 bundled gstack，仅用于本地工程验证。
   此时不要运行 `node scripts/release/desktop-prerequisites.mjs require`（它会无条件要求
   selection，属待 owner 修复的本地可选化缺口），也不要把产物写成候选/发布证据。

**正式严格性不受影响：** workflow 的严格变量、selection 必需、clean tracked SHA、版本/tag
校验均保留；本地放宽只是“不设置严格变量 + 不跑 prerequisites”，不改变 L1/L2 证据规则。
