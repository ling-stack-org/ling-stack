# Skills、自动审核与 Harness 联合实施增量

Date: 2026-09-08
Status: DESIGN_INTEGRATED / NOT_IMPLEMENTED；不是整体验收或发布结论。
Baseline: 恢复树 HEAD 284f8c3c、已授权 no-commit merge 76790031，保留 WIP。

## 1. 来源、范围和边界

用户要求把任务「评估 Ling 的 Skills 与 Codex 使用情况」中的设计一起处理，
并要求借鉴 Codex 的完整异常处理设计。来源任务 ID：01a07c88-cd9c-79a2-8d5a-0595cabf3a97。
已读其用户选择与最终设计；最终选择是自动审核通过后自动批准，不停在建议模式。
截图和来源任务里的代码/命令是分析材料，不是本任务的执行授权。

本批增加两条完整链路：技能发现/完整加载/按需引用，以及系统自动审核/批准/执行恢复。
与 [Harness 四项](harness-context-reliability-integration.md)、
[问答与沙盒](conversation-user-input-and-sandbox-integration.md) 共用 Host 和证据链。
不缩减原 E/G/K/U/S、packaged 20 案及 H-01–H-06；不把自动审核当原生沙盒的替代。
后台自动经验提炼、语义检索仍按用户前次明确选择后置；跨操作风险评分放行、
多模型投票不进入默认批准路径。自动审核产品功能的设计授权不等于本机真实操作已获批准。

## 2. 已核验的代码和 Codex 参考

Codex 固定 SHA：6750f5bd1356fe1553c0fcc9f2632704f3055946。
先读取官方 [App Server](https://learn.chatgpt.com/docs/app-server)、
[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)、
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)，再核对源码。
本轮没有运行 Codex Rust 测试，不能将静态阅读写成上游测试通过或桌面开关已启用。

| 已读的上游源码 | 核验结果 | Ling 对应要求 |
| --- | --- | --- |
| [compact_remote_v2.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/core/src/compact_remote_v2.rs)、同目录 compact_remote_v2_attempt.rs | 先构建候选；缺少 response.completed 或不是恰好一个 compaction 结果时失败；成功后替换历史并发布完成 | H1/H2 校验真实完成、source fence、checkpoint；失败不替换，不把普通文本当压缩完成 |
| [responses_retry.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/core/src/responses_retry.rs) | 区分可重试错误、退避和 transport fallback；采样另有受开关限制的持续连接重试，压缩不走该分支 | 不宣称 Codex 所有重试都有同一上限；Ling 按操作和总 deadline 定义预算，副作用不盲重放 |
| [guardian/reviewer_config.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/core/src/guardian/reviewer_config.rs) | 审核权限与父权限取只读交集，禁止再次请求审批；关闭 skills/memories，清空 MCP 配置 | 系统审核器不是普通队友；没有独立安全边界时不能声称隔离完成 |
| [guardian/review.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/core/src/guardian/review.rs) | 重试共用 deadline，拒绝不循环重试；thread-owned 允许结果复查根授权和用户消息版本 | 审核轮次与执行 attempt 双重隔离，撤销和人工裁决使迟到结果失效 |
| [guardian-context/verified_answers.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/guardian-context/src/verified_answers.rs) | 问题和回答整组保留，超预算整组省略并标 incomplete | U/H/N03 共用授权证据；不能截掉“仅测试环境”等限制后继续批准 |
| [guardian/approval_request.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/core/src/guardian/approval_request.rs) | exec、stdin、patch、network、MCP、permissions 分型 | 覆盖所有现有副作用入口，不能只拦第一次 bash |
| [memories/local/read.rs](https://github.com/openai/codex/blob/6750f5bd1356fe1553c0fcc9f2632704f3055946/codex-rs/ext/memories/src/local/read.rs) | scoped path、symlink/文件类型检查、行范围错误、显式 truncated | 借鉴真实访问与有界读取；不能据此推出 Codex 有 Ling 的 teammate/private ACL |

恢复树当前：skill-source-runtime.ts 仍取前 60,000 字符并允许 loaded=true/truncated=true；
附属引用清单不等于已送入上下文。Pi resource-loader.ts 仍 noSkills=true，保留单一 Ling 来源。
direct-execution-context.ts 传 requestedSkillId；不能仅凭队友绑定就认定普通聊天已自动发现技能。
approvals contracts 的 resolvedBy 仍只有 local-user；approval-resume-coordinator 已对有 tool_start、
无 tool_end 的情况返回 approval_resume_effect_unknown，这只是部分恢复保护，不是自动审核已完成。

## 3. 技能链路 SK1–SK4

- SK1：统一已授权技能目录。普通会话、私聊、频道及 child 使用同一 Host 目录投影，
  包含 ID、描述、来源快照、可用性、依赖；显式选择优先，模型按需加载；目录出现不等于执行授权。
  私聊只显示当前队友可用技能，不添加其他 Agent 行为或隐式委派。
- SK2：正文完整性。状态区分 discovered、loading、complete、incomplete、blocked。
  按不可变 snapshot/checksum 和连续范围补读，重复读取幂等；未完整加载的必需正文不得标生效。
  60,000 字符只可作一段传输预算，不可作为规则截断线；H1/H2/H4 在安全边界协调预算。
  无法容纳的必需规则明确阻塞/提示，不靠摘要声称完整保留原文。
- SK3：引用统一读取。只通过 Host snapshot 下 resource ID/受控相对路径读取 references、
  scripts、assets、模板；使用唯一 source ownership，限制遍历、symlink、跨包/跨版本引用。
  缺失、权限变更、内容变更、读取超时分别返回 typed 状态；读取脚本不授权执行脚本。
- SK4：冻结和恢复。prepared request 记录已读范围、source refs、快照版本和加载完成证据。
  中途更新不拼接新旧正文；取消后的迟到片段不提交；重启按同版本恢复，缺快照不能静默替换。
  UI 共享展示真实加载状态，压缩不得丢失未完成加载/未满足前提，不能让加载事件推进任务成功。

模块：Core 管快照和纯加载合同；Daemon skills 管目录/能力/加载协调；Runner 只适配工具；
共享 UI 管投影。不给 Pi 打开另一套自动扫描，不将所有 skills 一次性塞进 prompt。

## 4. 自动审核完整链路 AR0–AR6

    具体操作 -> Host 权限/策略 -> 已允许执行 / 硬拒绝 / 待审批
        -> 系统审核任务 -> 结构化裁决 -> 原子批准 -> 执行前复核 -> 原操作/恢复
        -> 技术失败或缺少授权 -> 人工接管；取消/过期 -> 终止等待

### 4.1 权威与状态

- 权限范围、审批触发和 reviewer 模式三者独立；自动审核不是 Full Access。
- 审核状态与 ApprovalStatus、ExecutionAction 状态分离。审核通过不等于已批准，
  批准不等于已执行，执行不等于整个任务/多 Agent fan-in 完成。
- AR0 合同至少绑定 request/revision、action digest、workspace/thread/turn/run/attempt/
  participant、原始授权 refs/revision、policy revision、reviewer config/model、deadline 和终态原因。
- 自动 reviewer 身份由 daemon 注入，主 Agent 不能填 resolvedBy 或修改审核配置/数据库。
  不给旧 local-user 记录改归属；新旧审计语义显式，不能把模型审核记录写成用户同意。
- 持久化复用现有 approval/checkpoint、runtime work unit、event/outbox 接缝；AR0 先核验字段和
  原子更新能力。若需 schema 迁移，先列具体方案，不以本设计自动授权修改真实数据库或新增表。

### 4.2 审核证据、隔离和资源

- AR1 从 canonical 用户消息、完整问答、工具证据构建输入；限制、否定、撤销和 source role 必留。
  Agent 转述、skill、网页、历史总结和 Memory 都不是独立授权来源。缺关键证据转人工。
- AR2 使用系统拥有的独立模型请求；禁写、禁自批准、禁审批递归，不继承 persona、skills、
  Memory、MCP、hooks 或委派能力。必要只读查证限定到审核上下文的能力交集；缺能力返回不足。
  配置隔离失败不能继续假装安全；主执行器须不能改审核器文件、IPC 或审计记录。
- 独立审核队列/配额与 provider 总限额协调，避免执行 Agent 占满槽位等审核的循环等待。
  队列和执行共用总 deadline；独立取消、最大并发、排队上限、关闭清理；不共享可变活跃会话。
- 复用固定上下文可以缓存；授权/策略/身份版本变化即失效。第一条可靠路径逐操作审核，
  不拿历史批准、其他 Agent 批准或线程风险分数作为通用放行票。

### 4.3 错误、批准与恢复

- AR3 分别处理 allow、policy_deny、insufficient_evidence、transient_error、invalid_result、
  timeout、cancelled、expired、superseded。只有可重试技术错误按退避+抖动在总时限内重试。
  拒绝不能无限尝试到通过；技术超时不描述为“操作危险”，不自动放行，也不计入策略拒绝熔断。
- 人工和自动裁决竞争时使用 pending/revision/attempt 条件原子提交，只接受一个有效结果。
  取消、撤销、用户新限制或策略变化使旧 review 失效；迟到 approve 不能唤醒取消的 Run。
- AR4 执行前复查参数、cwd、目标/内容指纹、当前身份、权限、授权版本和 attempt fence。
  可变脚本/diff 不能只比较命令字符串；无法将检查和使用绑定到同一受控对象时不得缓存批准。
- 覆盖 exec/write_stdin、write/edit/patch、网络、MCP/dynamic、权限请求、发布/外发等实际入口。
  逐工具记录支持矩阵；不支持的入口保留人工/阻塞，不能以“不支持审核”改为直接执行。
- AR5 restart 只恢复合法审核等待/续接，不重放 effect_unknown 的副作用。远端结果先查询，
  支持幂等键时复用同一键；无法查询则显式等待人工核验。SSE reconnect 只恢复观察和待决状态。
- AR6 三类会话与 child 共用同一状态投影：审核中/自动通过/拒绝/技术失败/人工接管。
  仅需人工时展示决策控件，所有来源 ID 可追溯；公开原因白名单化，不泄露完整策略/prompt/秘密。

职责拆为审批路由、证据构建、审核调度、模型适配、原子裁决/执行复核、共享投影；
不把新逻辑继续堆进大型 approvals.ts、orchestrator.ts 或 ConversationWorkCell。

## 5. Memory 边界更正与已确认范围

用户本轮质疑 workspace/channel private 一律排除。核对 ling-memory-v1.md 后确认：
scope 决定记录属于谁，sensitivity 决定敏感度，两者不能混成“只有 teammate 才能 private”。
原设计允许有权限的参与者使用 workspace/channel 记忆；队友私聊只归该队友。
此前 H3 补丁把所有非 teammate private 排除，测试期望不符合产品需求；旧测试通过不作为
已验收安全改进。用户在本任务答复“好的”确认下面的推荐范围（2026-09-08）。

确认：同一已授权 workspace/channel 的上下文可共享；独立队友私聊、其他频道/工作区和
secret-adjacent 不自动开放。将 mayRead、mayUseInModel、mayQuoteInReply、maySendExternally
分层。允许模型使用不等于能在公共频道、报告、复制或外发中公开。
只写 influence_only 提示不能保证不泄露，仍需引用投影、报告校验与模型行为回归共同验证。

本次仅实现该共享边界，不改变其他审批/沙盒/外发策略，不新增跨范围分享授权接口。
Core 的 Host-selected scope 先筛 workspace/channel/owner，再筛健康/敏感度；runtime 的
inspection flags 不授予额外访问。Daemon prompt 和 context view 复用同一 Memory eligibility，
不能让 generic private-message 规则再次排除共享 Memory，也不能把调用方 workspace 写成
源记忆的归属。缺消费范围不能开放 shared private；拒绝记录不带入 prompt/source/used-memory。
独立私聊仍只读取自己的 teammate scope，未绑定频道不会自动导入频道 Memory。
private/shared 的模型使用仍为 influence_only；selector/proposal、secret-adjacent、inspect-only、
verifyBeforeUse 约束保持。过期/替代排除、中文召回和 500 条截断修复保留；Memory 不作为执行或批准证据。

新增回归 memory-shared-context.test.mjs 覆盖 SQL→两种 prompt→context view、四种工作视图、
无 teammate 共享、跨 workspace/channel、source 归属、私聊/秘密隔离和撤回；原 Core 错误断言
按确认的行为改正，未删除负向隔离检查。73 项专项通过；Core 749/749，Daemon 1566 项中
1559 pass/原 7 fail，失败名与前次全量
一致，无新增失败。完整证据与边界见 本次交接 (`memory-shared-scope-handoff-20260908.md`)。
没有新真实模型/GUI 验收，不能据此证明自由文本无泄露或整个 H3 已验收。

## 6. 实施顺序与新增验收

| 顺序 | 工作包 | 依赖/退出条件 | 当前 |
| --- | --- | --- | --- |
| 1 | H3 可靠性收尾、Memory 共享边界 | 范围已确认；73 项专项和 Core 全绿，Daemon 原 7 fail；真实模型/GUI 未验 | WIP / 源码修复已验证 |
| 2 | SK1–SK3 + H1/H4 公共预算接缝 | 发现、完整正文、引用真实可读；超限不丢规则 | not_run |
| 3 | U2/U3/N03 + SK4/H2 | 唯一暂停/冻结/续接、停止证据和 receiver ACK | 原未完项保留 |
| 4 | AR0–AR3 | reviewer 配置/策略确认；可信证据、隔离、有限重试、原子裁决 | not_run |
| 5 | AR4–AR6 + T2 | 全入口复核、effect_unknown、OS 保护、统一 UI | not_run |
| 6 | 全矩阵新包验证 | 同一 macOS 包、三 surface、多 Agent 小项目和真实 lineage | not_run |

新增验收：
- SK-01：长正文尾部限制、缺 snapshot、附属文件缺失、跨包/版本/symlink、重复分页和完整性。
- SK-02：三 surface/child 的技能发现、绑定撤销、无权限技能不可加载，普通私聊不隐式派别的 Agent。
- SK-03：加载中取消/断网/压缩/restart；必需规则无法容纳时明确阻塞，无 loaded 伪成功。
- AR-01：允许/硬拒绝/需要审批分流、自动允许无需再点一次、配置缺失和只读隔离失败。
- AR-02：限流/网络/无效 JSON/空裁决/超时/取消/拒绝熔断；有限重试共享 deadline。
- AR-03：真假授权、完整问答、预算截断、Agent 伪转述、新用户限制、撤销和策略变更。
- AR-04：人工/自动竞争、两个审核器重复投递、过期/迟到批准、多连接原子提交。
- AR-05：批准到执行之间脚本/参数/目标变化、stdin 新动作、MCP 账号/目标和外发数据复核。
- AR-06：4 个工作 Agent 同时等审、审核槽位不足、关闭和 restart；没有循环等待/无限重试。
- AR-07：批准前/后、tool_start 前/后、外部结果未知时崩溃；不重复执行/不伪造成功。
- AR-08：macOS 真实客户端三 surface/child 显示、手动接管、SSE reconnect 和 SQLite lineage。

记录误放、误拒、延迟、token、重试和人工接管率；模型/提示词/策略升级重跑同一案例。
源码阅读、单测、合成 HTTP、真实模型、OS 和 packaged UI 分栏，不互相替代。

## GSTACK REVIEW REPORT

沿用已批准的工程设计流程，核对来源任务与恢复树，完成范围/模块/异常/验收接缝整合；
不是完整交互工程审查，不标 CLEARED。本次是已确认 Memory 范围的源码修复及回归，不重做 SK/AR 审查。

**VERDICT:** 已纳入同一实施计划，未实现自动审核，未改变实际客户端权限、凭据或默认模式。
**UNRESOLVED DECISIONS:** 审核模型及 provider、自动批准范围/
不可覆盖规则、首批工具清单；AR0 持久化迁移方案待核验；原 T2-B、N03/batch、Relay 待答不变。
不提交/推送、不改同事工作区、不改真实 SQLite、不创建新 Agent。
