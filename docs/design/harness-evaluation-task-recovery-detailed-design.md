# H09 独立评估任务与恢复：内部基础合同

日期：2026-10-10。基线 `fcc47e26`；唯一实施树为 `ling-e6-continuation/ling-stack`。
此文档补充既有 Harness T9/H09，**不是 H09 完成声明**。

## 已接受边界

用户已授权连续完成内部链路、必要回归和设计，允许新增表。
保留现有 rule scheduler、137 grade 唯一约束、append-only grade、完成的 Run、
promotion report 数学和未认证来源的 `not_assessed`。不触碰独立 writer 设计 WIP。
本切片不启用真实 Provider/人工、默认 all-Run enrollment、普通 Run quota 或 enforcement。
Provider D1 A 不回答 H09 人工身份/模型/预算，也不回答 H10 根预算。

## 模块边界与身份

- Contracts：只读 task/attempt/result DTO，不含 secret、prompt 正文或人类认证旗标。
- Core domain：窄输入/结果/端口、canonical identity 与状态合同。
- SQLite：独立158 sidecar migration 和 focused store；不修改历史137。
- Daemon：独立 task-worker adapter，不替换 deterministic rule callback。
- UI/报告：本步不接新 renderer、不改变样本计数或 promotion authority。

本基础切片只接收 `model` task；human 不进入自动 dispatch queue，rule 保持原 worker。
Task 精确绑定 evaluation idempotency identity、graderType、冻结 grader config、
config artifact byte SHA、repeatOrdinal。同身份重放不增加任务；retry 不改变 ordinal。
冻结七字段与现报告一致：`graderId/graderVersion/promptDigest/modelId/modelVersion/
samplingDigest/rubricDigest`。canonical config digest 与 sealed artifact byte SHA 分开。
本步不向旧报告身份偷偷添加 Provider，也不改 graderVersion 冒充独立 repeat。
语义 unique 另锁住 `(evaluationId, frozenGraderDigest, repeatOrdinal)`。
同七字段配置复制成不同 artifactId，或 JSON 键顺序变化而 canonical digest 相同，
都不能获得同 ordinal 的第二个 task。完整物理 pins 保留历史；不同 pins 的请求拒绝
identity conflict，不替换原 pin，不把复制配置计成新独立调用。

## 状态与调用事实分层

```text
explicit enqueue -> queued -> claim(new Attempt, token, lease, revision)
                               |
                no admission --+--> expiry: same task may be reclaimed
                               |
              validate frozen artifacts + exact current fence
                               |
                    durable dispatch admission
                               |
                       local executor call
                      /                   \
       valid bounded result        error/abort/expired/crash
                |                         |
   atomic result + Attempt/task     unknown; NEVER auto resend
          settlement
```

Admission 是 Host 获准开始的 durable 记录，不证明 HTTP 已发送。
记录后发送前崩溃也保守 unknown。普通 Runtime `runner_started`、调用者声明的
invocationId/authenticated、sealed digest 都不是实际模型/人工 producer 认证。

所有准入/完成 SQL 同时校验 exact task/attempt、revision、owner/token、未过期 lease、
冻结身份与允许状态。旧 worker 不可凭同 owner 恢复权限。独立 task Attempt 不借
terminal source Run/Attempt/semaphore。未知请求不计成功/失败独立样本，也不计零费用。
首次 durable admission 返回 `mayDispatch=true`；exact replay 只返回历史记录和
`mayDispatch=false`，不能因为重放成功再次调用。invocationId 由 Core 首次 mint。
enqueue 本切片接收既有 completed evaluation，先按原 H08 rule 合同完成后再创建
独立 repeats；这不延长原 Run，也不占用其额度。

## 原子持久化

158 新 task、attempt、result sidecars 独立于旧 grade。结果只保存 bounded sealed
artifact refs 和可选成本/耗时声明；缺值仍 unknown。result、Attempt 和 task 终态在
同一 own `BEGIN IMMEDIATE` transaction 提交，任何失败完整 rollback。
事务 BEGIN 失败不得 rollback 调用者事务。exact result replay no-op，冲突 replay 拒绝。
每个 task result 绑定当前 Attempt/admission/config；不增加旧 grade 或 qualifying observation。

公开输入仅接收 bounded own-data/plain records；禁止 getter/custom prototype。
artifact 存储当前会先 parse JSON，本步不宣称具有 preparse 内存上界。
list/recovery 均 bounded，索引覆盖状态/到期扫描；不读取全历史后固定 overfetch。
claimable 的 expression index 与 `COALESCE(next_attempt_at,created_at),created_at,id`
实际排序相匹配，并用精确 schema/index metadata 与 EXPLAIN 回归确认不做临时全队列排序。
这不等于承诺 SQLite 对任意数据分布都只 examine `limit` 条；返回行上界与内部扫描成本分别说明。

## Worker 与 shutdown

Executor 默认为 absent：不 claim、不派发。生产暂不注入 executor或注册此 worker。
适配器只获得冻结 task/Attempt/artifact refs 和 AbortSignal，不获得广义 mutation Store、
secret resolver、普通 Runtime或Provider额度。
worker 独立低优先级本地并发不冒充 batch/day/Provider 预算。
generic error after admission -> unknown，不自动 retry。
shutdown 同步关闭后续 admission，再 abort owned active adapter；真实 drain 完成才允许
关闭 Store。挂起 callback 不可通过 timeout 伪造 idle；取消不证明未发生请求。
在调用任何 clock/Store callback 之前，Registry 必须先登记 lifetime 和 AbortController，
避免同步重入 shutdown 漏掉正在准入的任务。configured worker 每次 wake 先处理一页最多100条
过期 Attempt；缺 executor 或已中止时零读取、零 claim、零 recovery mutation。
只读 DTO 复制使用私有全树计数：最多2048 nodes、65536字符（含key）、depth12、
每record64 own enumerable data fields、每字符串2048字符、每key100字符。
不能通过对外 depth 参数重置预算；getters、toJSON 和自定义 prototype 不执行。
预算约束复制遍历和输出，不冒充对调用者已构造的巨对象、descriptor 枚举或已有 JSON parse
提供前置内存硬界；相应更强隔离不是本内部 DTO 切片的已验证能力。

首次准入和 active completion 要求 exact task/Attempt revision。只有已经存在的
matching admission 的 `mayDispatch=false` no-op，或完成结果的 matching historical no-op，
可以接受紧邻的历史 revision；续租的旧 fence 不得借 replay 获得新 mutation 权限。

## 验收与保护现有行为

临时真实 SQLite/reopen、两连接竞争、同owner ABA、replay/conflict、config/artifact drift、
四个 crash cuts、unknown 不复活、旧worker晚到、原子 settlement故障 rollback。
worker验证 absent executor零claim、准入失败零调用、shutdown-before零调用、during signal+
unknown、hanging drain不冒完成；source terminal Run/Attempt、rule grades、normal quota不变。
历史 latest->153/latest->136 fixtures先精确移除158overlay，再保留旧SQL/rows/marker严格断言。
新增 Office reachable leaves需进入 fixed authored required inventory，不伪造正式approvedrow。
focused Node22/24 -> Core/Daemon full -> workspace types -> 独审 -> source manifest/local save。
这些都不替代真实模型、macOS新包或正式Office native approval。

## 本切片开始时的四项生产启用门槛

1. 可信 adjudicator source/identity/scope与纠正撤回政策。
2. Provider/model/prompt/sampling/rubric及允许数据。
3. batch/day预算与独立Provider quota。
4. explicit suite/case/corpus enrollment和terminal原子enqueue来源。

本步内部 task/claim/recovery 无新增未决选择。开始时上述选择未答；以下后续决定覆盖政策输入，
不把政策授权误记为 producer 已接通或可以省掉验收。

### 2026-10-10 用户后续决定与下一切片

用户实际答复（不是推荐自动提交）：仅专用 QA 案例与脱敏产物；人工来源为 Host 验证的
本地用户显式提交，保留纠正/撤回历史；Provider/模型和每批/每日预算委托实施者决定。
这覆盖了数据与人工政策选择，不等于 producer、quota、enrollment 已实现或已验收。

初始小批量政策：一批最多3个真实 transport request attempt，任意连续24小时最多12个。
使用滚动窗口而非自然日，避免跨午夜短时连续派发两倍额度；Host clock回退不能提前释放消耗。
初版限一个固定隔离 QA workspace 的稳定 budget namespace，不宣称 machine-global 多库配额；
配置、Provider、密钥 rotation 与重启不能重置同一 namespace/day 的额度。初版 SDK/Host/transport
隐式 retry 全关；未来重试每个真实请求都必须另领 slot，不能按 logical invocation 幂等复用。
现有 Pi invocation receipt 只观察 logical stream，不证明 HTTP dispatch，也不作为新配额准入。
须在 dispatch 前原子预留，独立于普通 Run 配额；retry/SDK自动请求不能绕过调用预算。
每次 input 先按包含 system/rubric/schema/artifact 的完整 prepared/wire body 估算不超过8k，
另设最终 JSON UTF-8 serialized bytes 最大32768的硬界；没有可信 tokenizer 时必须标 estimated，
不宣称 token 硬上限，不仅限制 rubric/candidate 某一段而遗漏协议开销。
output1k要真实 wire `max_tokens/max_output_tokens` 固定且验证 Provider 支持，不能被SDK override。
Pi sampling params 在最后阶段能覆盖上限，所以校验必须发生于最终 onPayload/wire body，
包括所用 Provider 对 reasoning/output 的参数语义。当前 SDK 缺 usage 时默认0；只有原始
Provider usage 字段确实存在且有效才能记为测得用量，不能把 SDK 默认0当真实零耗费。
admission 后 crash/abort 的未知调用不得作为未调用返还额度；费用缺可信计价保留 unknown，
不能把 token/call 上界冒充金额上界。后续实现先验证 Provider 真实价源与模型能力；
不虚构费用数字，不静默切 Provider 或把 secret 写进 task/config/report。
独立 lane 初版仅本地 Host-managed inflight=1；真实 callback drain 前不释放。admitted crash/
unknown 先 quarantine 该 QA lane，由 Host 显式核销；TTL不能证明远端请求已经结束。
人工纠正/撤回不返还已发生请求消耗，quota与taskadmission必须同一own事务，结果/用量/terminal
结算同样原子；多个worker的余额读取不是权限。初版不支持多workspace分散额度或跨库伪原子。

Provider/model 先核对现有专用 QA 的有效配置，再冻结一次批次快照；变化必须新 config/revision，
旧任务不能借新密钥/模型的观察或额度。新手工/模型 producer 仍需真实调用来源、取消与恢复、
已冻结报告身份，以及将当前 unverified 声明与可信 producer facts 分开。
仅管理 capability/CSRF、teammate ID、用户名或请求 `authenticated=true` 都不是人类身份。
Host 要验证本地用户的显式提交来源、作用域、请求绑定与时效，纠正/撤回追加而非覆盖旧事实。

只读核实：现有 IPC sender、management token/CSRF/Origin、remote P256 都不能证明自然人；
macOS `deviceOwnerAuthentication` helper 有源码，但当前 composition 未注入 native bridge，
而且旧 locked-control intent 绑定 active Run/CU，不适用于 terminal evaluation。不可当现成能力。
完整新链路须包含 human 专用 Main ingress、一次性 payload-bound Host intent、OS 用户确认及
append-only adjudication/correction/revoke；OS不可用/取消/超时不能 fallback成令牌认证。
intent 消费、head revision CAS、事件与持久 audit 同一事务；SSE只commit后通知。
仅单个显式登记 QA case、脱敏 pins 和当前 desktop/daemon epoch；不开放 Agent/MCP/Mobile/
通用HTTP/跨workspace/批量人工提交。锁屏、重启、用户/epoch变更使未消费意图失效。
只读反馈可保存为 `local_owner_explicit_submission`，但不能冒 `humanEvidenceAuthenticated=true`；
已认证人工样本必须真实 OS确认与同一最终 payload 绑定，不能只实现表面提交按钮。

QA enrollment 必须明确 suite/case/artifact scope 且原子准入，不默认 all-Run、不读取日常私有
workspace/channel 内容；完成事件与显式 enrollment 需共同满足才创建独立任务。
模型与人工 producer 还未启用，四项旧 pending 以本后续决定为政策输入继续实现，不重复问已答项。

### 160 内部接线后的当前边界

人工Main/native/privateDaemon/原子Core审计已经实现，读回与失响应恢复也已接通。
详见[160实施检查点](harness-human-evaluation-checkpoint-2026-10-10.md)；它不等于可见QA表单、
真实OS认证或整个H09完成。只对明确enrollment和脱敏pins开放，H10根预算仍独立未答。
已COMMIT事实不因Main锁屏/owner失效回滚；失效回复不给成功或快照，只读exact intent核对，
不借HTTP abort宣称服务端未提交、不自动再次请求认证或提交。
