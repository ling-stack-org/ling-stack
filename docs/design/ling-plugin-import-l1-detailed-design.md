# Ling 插件 L1 导入详细设计（MCP / 技能 / 命令）

## Status

Implementation status: L1 source/API/Web acceptance completed on 2026-11-10. The source readers, secret redaction, preview/apply routes, idempotency, uninstall cleanup, skill-source discovery, Claude command import, and import dialog are implemented and covered by daemon fixtures, core regression tests, and a Web E2E wizard flow. Real user-owned external files, live MCP connectivity, and packaged Desktop acceptance remain separate release checks; they are not prerequisites for this source/API L1 gate.

范围收敛到 L1（能力兼容）：**任何 MCP server 都能接 + 用户在 dsh / Claude / Codex 攒下的数据资产（MCP 配置、技能、命令）一键导入 Ling**。本设计是 [Ling 产品待做清单](ling-product-backlog.md) 条目 ③④ 的 L1 部分，输入为外部对比系列方案（`05-ling-import-and-adapter-plan.md`），并按当前仓库实况修正了其中与代码不符的两处（见 §2.3、§6.3）。

**明确不在本设计内（L2/L3）**：PluginRuntimeAdapter 抽象、dsh 代码插件运行时、第三方 SDK/插件市场、`dsh-client-ui-*` 渲染插件、插件自动更新。

## Related Docs

- [Plugin Manager](plugin-manager.md) — 插件三层来源模型与审批边界
- [插件管理新增本地插件](plugin-manager-add-local-plugin.md) — 现有"添加插件"流程（本设计的直接上游）
- [Ling 产品待做清单](ling-product-backlog.md) — 条目 ③（插件市场）④（MCP 一键连接）
- [Secrets and Keychain](secrets-keychain.md) — 密钥存储体系
- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md) — MCP 状态快照边界

## 1. 现状基线（复用，不重建）

导入只做"数据搬运 + 包装"，以下能力全部已实现，import 一行内核代码都不改：

| 已有能力 | 位置 |
| --- | --- |
| 本地插件创建（MCP server + 插件记录 + contribution 一次串好，默认停用） | `packages/daemon/src/features/plugins/create-local-plugin.ts:11` `createTrustedLocalMcpPlugin` |
| MCP transport 类型（含 `secretEnvRefs` / `secretHeaderRefs` / `bearerTokenRef`） | `packages/core/src/mcp-types.ts:8-37` |
| 插件启用/停用/检查/审计 | `managed_plugins` 等 4 表 + `routes.ts` 的 `enable`/`disable`/`check` action |
| 技能源扫描（已自动探测 `~/.codex/skills`、`~/.agents/skills`） | `packages/core/src/skill-source-sync.ts`（约 150-160 行） |
| 技能 frontmatter 解析（YAML `name`/`description`，与 Claude/dsh 的 `SKILL.md` 同格式） | `packages/core/src/skill-source-definition.ts:1`（`yaml` 的 `parseDocument`） |
| `SkillSourceKind` 4 值可扩展联合 | `packages/core/src/skill-types.ts:10-14`、`packages/contracts/src/skills.ts:65` |
| 技能源白名单校验 | `packages/daemon/src/features/skills/schemas.ts:1074` |
| 密钥复合解析（env + macOS Keychain） | `packages/core/src/secrets.ts:50-141`（`@napi-rs/keyring`） |
| 解析依赖 | `smol-toml` 1.9.1（daemon 已有，读 Codex TOML）、`yaml` ^2.9.0（core 已有，读 dsh YAML 与 frontmatter） |

## 2. 模块设计

新增目录 `packages/daemon/src/features/plugins/import/`，五个文件：

```text
import/
├── sources.ts        # 4 个读取器，输出统一候选
├── normalize.ts      # 归一化 + fingerprint + 去重/冲突分类
├── secret-policy.ts  # 密钥判定、剥离、落 secret store
├── apply.ts          # preview / apply 两段逻辑
└── report.ts         # 结构化导入报告
```

### 2.1 读取器层（`sources.ts`）

| reader id | 源 | 形状 |
| --- | --- | --- |
| `codex-config-toml` | `~/.codex/config.toml` | `[mcp_servers.<name>]`：`command`+`args`+`env`+`cwd`（stdio），或 `url` + `[mcp_servers.<name>.http_headers]`（HTTP）；附带 `startup_timeout_sec`、`enabled` |
| `claude-user-json` | `~/.claude.json` | 顶层 `mcpServers`（全局）+ `projects.<path>.mcpServers`（按项目，name 加项目短名区分） |
| `claude-plugin-mcp` | 已装 Claude 插件目录的 `<plugin>/.mcp.json` | `{"mcpServers": {name: {...}}}`，可内嵌 OAuth（`client_id`/`client_secret`/`callback_port`） |
| `dsh-cordis-patch` | `~/.dsh/cordis.patch.yml` | `insert` 列表中 `name: "@deepseek-ai/dsh-mcp-client"` 条目的 `config`（`serverName`/`transport`/`command`/`args`/`env`/`headers`） |

统一输出：

```ts
export interface ImportCandidate {
  readonly source: "codex-config-toml" | "claude-user-json" | "claude-plugin-mcp" | "dsh-cordis-patch";
  readonly name: string;                    // 源里的 server 名
  readonly displayName: string;             // 人类可读名（默认 = name）
  readonly transport: McpServerTransport;   // 密钥已剥离，见 §3
  readonly fingerprint: string;             // sha256(canonical(transport))
  readonly warnings: readonly string[];     // 解析降级说明
}
```

规则：

- 每个读取器独立容错：单条解析失败只跳过该条并记 warning，**不整体失败**。
- `enabled: false` 的 Codex 条目照常导入但保持停用；无该字段的源默认停用（与现有 `createTrustedLocalMcpPlugin` 一致）。
- 读取器不做任何执行，只读文本。

### 2.2 归一化与冲突分类（`normalize.ts`）

fingerprint：`sha256(JSON.stringify(transport, 键排序, 剥离 secret ref 值))`。ref 名参与指纹，ref 指向的密钥值不参与。

| 情况 | 判定 | 行为 |
| --- | --- | --- |
| 同 fingerprint 已存在于任一 MCP server | `unchanged` | 预览标注"已存在"，apply 默认不勾选 |
| 新名字 + 新配置 | `new` | 可导入 |
| 同名但 fingerprint 不同 | `conflict` | 保留双方：新条目 displayName 加来源后缀（如 `stitch（来自 Codex）`），由用户勾选取舍 |
| Ling 侧同名条目是用户手工创建的 | `manual-exists` | import 不覆盖，只在报告提示；与 `plugin-manager-add-local-plugin.md` 的 MANUAL 语义一致 |
| 重复导入同一源 | 幂等 | fingerprint 全部命中 `unchanged` → apply 返回全 `skipped`，不产生重复插件 |

### 2.3 插件 id 与来源追溯（对 05 号方案的一处修正）

05 方案提出 id 采用 `trusted-local:imported:<source>:<name>`。实际代码中 `createTrustedLocalMcpPlugin` 的 id 是 `trusted-local:${mcpServerId}`（daemon 生成），改它会动插件内核。本设计**保持 id 生成现状**，来源追溯放两处：

- descriptor `description` 固定写 `Imported from <source> (<name>)`；
- apply 时向 `managed_plugin_events` 写一条 `type: "import"` 事件，data 含 `{source, name, fingerprint}`。

`createTrustedLocalMcpPlugin` 签名不变。

### 2.4 密钥剥离（`secret-policy.ts`，安全关键）

对 `env` / `headers` 的每个键值：

1. **判定**：键名命中 `key|token|secret|password|bearer`（大小写不敏感）且值长度 ≥ 20，或值呈高熵特征 → 视为密钥。
2. **剥离**：值不写入 transport；写入 Ling secret store，transport 上只留 `secretEnvRefs` / `secretHeaderRefs`（键名 → secret ref）。OAuth 的 `client_secret` 同理，`client_id` 是公开标识可保留。
3. **无法判定但形态可疑** → 保留字段名、值置空，预览标记 `needsInput`，apply 后用户在 MCP 设置页补填。
4. **预览与报告永不回显明文**，只显示尾 4 位（如 `sk-…9vTw`）。
5. 报告统计 `secretsMigrated` / `secretsNeedsInput`；两者均非 0 时禁用"一键全选"。

判定与剥离逻辑必须有独立单测，fixture 用脱敏样本，断言"剥离后的 transport JSON 与报告中不含任何明文密钥值"。

### 2.5 preview / apply（`apply.ts` + 路由 + schema）

`routes.ts` 新增两条（沿用现有 route action 分发模式），`schemas.ts` 新增两个请求体校验：

```http
POST /plugins/import/preview?cwd=...
{ "source": "codex-config-toml" }
→ {
  "candidates": [{
    "name": "stitch", "displayName": "stitch",
    "transport": { "...": "已脱敏" },
    "status": "new" | "unchanged" | "conflict" | "manual-exists",
    "secrets": [{ "field": "X-Goog-Api-Key", "masked": "…9vTw", "needsInput": false }],
    "warnings": []
  }]
}

POST /plugins/import/apply?cwd=...
{ "source": "codex-config-toml", "names": ["stitch", "cua_driver"] }
→ {
  "imported": [{ "name": "stitch", "pluginId": "trusted-local:mcp_xxx", "mcpServerId": "mcp_xxx" }],
  "skipped": [{ "name": "cua_driver", "reason": "unchanged" }],
  "secretsMigrated": 1, "secretsNeedsInput": 0,
  "degradations": []
}
```

语义：

- **import 绝不能是一键覆盖**：只应用用户勾选的 `names`。
- apply 内部调 `createTrustedLocalMcpPlugin`（保持默认停用），随后对该 pluginId 自动执行一次现有 `check` action；连接失败在报告里直接标出，不阻塞其余条目。
- preview 与 apply 均只读源文件、写 Ling 侧数据，不执行源里的任何命令。

### 2.6 技能导入（改 4 处，约 25 行）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `packages/core/src/skill-types.ts:10` | `SkillSourceKind` 联合加 `"claude-skill-directory" \| "dsh-skill-directory"` |
| 2 | `packages/contracts/src/skills.ts:65` | 同步加两值 |
| 3 | `packages/core/src/skill-source-sync.ts` | `includeDetectedRoots` 分支加两组探测：`~/.claude/skills`（claude）、`~/.dsh/skills` 与 `<workspace>/.dsh/skills`（dsh），与现有 codex 分支同形 |
| 4 | `packages/daemon/src/features/skills/schemas.ts:1074` | 白名单数组加两值 |

解析器零改动：三家 `SKILL.md` 都是 YAML frontmatter + Markdown，`parseSkillFrontMatter` 直接可用。frontmatter 缺 `name` 或解析失败的目录按现有无效源规则跳过并在扫描结果标注。

### 2.7 命令导入

| 生态 | 形态 | 处理 |
| --- | --- | --- |
| Claude | `~/.claude/commands/<name>.md`，支持 `$ARGUMENTS` / `$1` / `` !`bash` `` / `@path` | 导入为 `manual-markdown` 技能；`$ARGUMENTS`/`$1`/`@path` 原样保留 |
| dsh | `ctx.commands.register`（代码注册） | **延后**：只能人工整理内置命令提示词，不做自动化读取 |

降级规则：`` !`bash` `` 内联执行语义在 Ling 里**不还原**——转换为"提示模型调用 bash 工具执行等效命令"的文本，并在导入报告 `degradations` 里逐条标注。落点首选技能库（复用 §2.6 的扫描链）；如后续需要 slash 入口，再映射到 `composer-slash-intents.ts`，本期不做。

### 2.8 Web UI（`ImportWizard.tsx`）

`apps/web/src/features/plugins/` 新增导入向导，插件页顶部加"导入"入口（与"添加插件"并列）。四步：

1. **选源**：四个源卡片，自动标注本机检测到的生态（文件存在即显示"已发现"，否则置灰）。
2. **预览**：候选表——名称、transport 摘要（命令或 URL）、状态徽标（新增/已存在/冲突）、密钥列只显示尾 4 位与 `needsInput` 标记、降级标注。`unchanged` 默认不勾选。
3. **应用**：只提交勾选项；进行中禁用重复提交。
4. **报告**：导入成功数、跳过原因、`secretsMigrated`/`secretsNeedsInput`、降级明细、失败的 check 结果与"去 MCP 设置修复"链接。

表格契约沿用 `plugin-manager-add-local-plugin.md` 的行高与对齐约束（58–64px、固定宽列、主操作显示文字）。

## 3. 数据与持久化

- **不新增表**。插件/MCP server/contribution 走现有 `createTrustedLocalMcpPlugin` 落盘链路；导入溯源走 `managed_plugin_events`。
- 技能导入无持久化：claude/dsh 技能源是"目录即源"，与 codex 源同语义，由现有 Effective Skill 读模型按需扫描。
- 源文件内容不落库；报告在响应中返回，不持久化明文。

## 4. 测试计划

| 组 | 断言点 |
| --- | --- |
| 读取器单测 ×4 | 真实形状 fixture（Codex TOML 含 `http_headers`、Claude JSON 含项目级 servers、插件 `.mcp.json` 含 OAuth、dsh YAML 含 insert 列表）；坏行跳过且 warning 正确 |
| fingerprint / 去重 | 同 fingerprint 判 `unchanged`；同名不同配置判 `conflict`；重复 apply 全 `skipped` |
| 密钥剥离 | 键名/熵判定命中；transport 与报告 JSON 全文不含明文值；`secretEnvRefs` 正确生成；`needsInput` 分支 |
| apply 集成 | fake store 上 `createTrustedLocalMcpPlugin` 被以停用状态调用；自动 check 失败不阻塞其余条目 |
| 技能源 | 新增 2 个 sourceKind 白名单通过；`~/.claude/skills`、`~/.dsh/skills` 探测产生候选 root |
| 命令导入 | `` !`bash` `` 降级文本生成且 `degradations` 非空；`$ARGUMENTS` 保留 |
| Web E2E | 向导四步走通；预览页无明文密钥（DOM 断言） |

验证命令：

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm typecheck
git diff --check
```

## 5. 排期

| 周 | 内容 | 交付 |
| --- | --- | --- |
| W1 | 四读取器 + 归一化 + 密钥剥离 + preview 路由 + 单测 | 三家 MCP 配置可预览（CLI/接口层可用） |
| W2 | apply + ImportWizard UI + 技能源扩展 + 命令导入 + E2E | 用户可从插件页完成导入 |

预估规模：新增约 1,100 行（含测试），修改约 5 行。

## 6. 验收清单

- [x] 从 Codex 配置预览出 `[mcp_servers.*]`，勾选导入后生成停用的 trusted-local MCP（daemon API fixture 已覆盖）
- [x] 从 dsh `cordis.patch.yml` 预览出 `dsh-mcp-client` 的 insert 条目（daemon API fixture 已覆盖）
- [x] 从 `~/.claude.json` 预览出全局 + 项目两个层级（daemon API fixture 已覆盖）
- [x] 明文密钥被剥离到 secret store，预览与报告只见尾 4 位（normalize/API fixture 已覆盖）
- [x] 重复导入同一源全部 `skipped`，无重复插件（API fixture 已覆盖）
- [x] 导入后卸载，MCP server / contribution / 事件链路按现有逻辑清理（daemon API fixture 已覆盖）
- [x] `~/.claude/skills/` 与 `~/.dsh/skills/` 已接入可同步技能源探测（core skill-source-sync 回归已覆盖）
- [x] Claude `commands/*.md` 可导入，`` !`bash` `` 正确降级并标注（daemon API fixture 已覆盖）
- [x] 现有插件/技能测试全绿，`createTrustedLocalMcpPlugin` 签名不变

当前证据入口：`packages/daemon/test/plugin-import-api.test.mjs`、`packages/daemon/test/plugin-import-normalize.test.mjs`、`packages/daemon/test/plugin-manager-api.test.mjs`、`packages/daemon/test/skill-import-preview-api.test.mjs`、`packages/core/test/skill-source-sync.test.mjs`、`apps/web/e2e/plugins.spec.ts`。这些证据完成 L1 的源码/API/Web 验收；真实外部配置、运行中的 MCP 会话和 packaged Desktop 仍属于发布验收边界。

### 6.1 验收证据（2026-11-10）

- `corepack pnpm --filter @ling-stack/daemon exec node --test --test-concurrency=1 test/plugin-import-api.test.mjs test/plugin-import-normalize.test.mjs`：16/16 通过。
- `corepack pnpm --filter @ling-stack/daemon exec node --test --test-concurrency=1 test/plugin-manager-api.test.mjs`：13/13 通过。
- `corepack pnpm --filter @ling-stack/daemon exec node --test --test-concurrency=1 test/skill-import-preview-api.test.mjs`：2/2 通过。
- `corepack pnpm --filter @ling-stack/core exec node --test test/skill-source-sync.test.mjs`：16/16 通过。
- `corepack pnpm --filter @ling-stack/web typecheck:e2e`：通过。
- `corepack pnpm --filter @ling-stack/web exec playwright test e2e/plugins.spec.ts --grep 'imports a plugin through the four-step wizard'`：1/1 通过；验证选源、预览、应用、报告四步，且页面不回显密钥尾值。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 源格式随版本漂移（Codex TOML / dsh YAML） | 读取器容错：解析失败仅跳过并报告，不整体失败；fixture 锁住已知形状 |
| 密钥泄漏进日志/DB/报告 | §2.4 五条规则 + 全文断言单测 + 报告不持久化 |
| 导入后 server 起不来（命令不存在、路径失效） | apply 后自动 check，失败在报告与向导中标出，附 MCP 设置链接 |
| 用户误以为导入=启用 | 导入产物默认停用（与现有流程一致），报告与向导明示"需启用并分配工具" |
