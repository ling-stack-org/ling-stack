# H09 专用 QA 评估：准入、真实请求与人工提交

日期：2026-10-10。承接已提交的 task/claim/recovery foundation `7e6fb06f`。
本文是完整后续链路的实施合同，不能作为 producer 已启用或 macOS 验收完成的证据。

## 政策与实际来源

用户已选择：仅专用 QA 案例与脱敏产物；本地用户显式提交、Host 验证身份并留纠正/撤回审计；
Provider、模型和预算委托实施者决定。这些选择不再重复询问。

初始预算为每批最多3次请求准入、滚动24小时最多12次，固定一个隔离 QA workspace。
unknown 不退款，人工纠正/撤回也不返还已消耗请求；不沿用普通聊天额度。
本地 owned inflight 为1，SDK/Host/transport 隐式 retry 为0，自动 redirect 禁用。
输入完整请求估算不超过8k，并另有最终 JSON UTF-8 32768 bytes 硬界；估算不是 tokenizer 保证。
输出 wire cap 为1024，必须明确所选 API 的 reasoning/visible token 语义。
没有可信计价就保持 amount unknown，不宣称货币硬限额。

已授权 credential reference 的模型目录实际返回200、36项；不存在旧 GPT4 小模型候选。
当前技术候选 `gpt-5.6-luna`，仅目录可见，不证明价格、实际响应或 output cap 支持。
Provider/model 的真实配置、最终 wire 能力与价源仍需独立受额度约束的 QA 请求核验。
本文、SQLite、task DTO、receipt 和报告均不得保存密钥或原始鉴权 header。

## 模块与事实分层

```text
owned QA workspace + Host reviewed artifact pins
                     |
             immutable batch/enrollment
                     |
       frozen private prepared wire request
                     |
       own transaction: exact fence + budget + lane + task admission
                     |
       Host single-use transport capability -> exactly one fetch attempt
                     |
       bounded full response + private Host receipt + raw usage validation
                     |
       own transaction: request receipt + unverified result + terminal task
                     |
       proven local drain / unresolved quarantine
```

- Contracts/Core 负责数据、身份、状态与原子持久化，不包含 credential 或网络调用。
- Daemon preparation 负责限定 QA 输入、完整请求冻结与预算，不读取普通 history/Memory。
- Daemon transport 负责真实发送及响应；模型返回的 ID、认证旗标、费用不是 transport 来源。
- Worker 保留既有 claim、exact recovery、shutdown/drain；仅增加窄 Host adapter hook。
- Desktop human ingress 为单独后续 vertical，不复用普通聊天或 Agent/MCP 工具入口。
- UI/报告仍 report-only；旧 result `authority=unverified`，不写旧 grade 或提升 promotion 样本。

本轮不重写 task foundation、Provider D1、Pi/Expo、报告数学、R03 或时长。

## 159：专用 QA sidecars 与原子 coordinator

新增四个 sidecars：固定 QA scope、immutable batch、explicit enrollment、request ledger。
scope namespace 绑定 Store 的 canonical workspace，不接受调用者通过新 namespace 逃避额度；
跨 Provider/config/credential rotation、batch 与进程重启持续保留。
初版只支持一个 owned Host/固定 QA 数据库，不宣称多 workspace 或多数据库全局 quota。

enrollment 固定 completed evaluation identity、suite/case/baseline/candidate/frozen config 五个
artifact byte pins，以及 Host 的显式 QA/脱敏审阅记录。审阅记录不是自动脱敏证明。
只有明确的 owned QA 注册流程可接入；Core 端口不开放通用 HTTP、Agent、MCP 或 Mobile。
没有 enrollment 的普通 Run 不被自动采集；terminal source Run/Attempt 保持不变。
同一 config identity 的 repeats 继续使用158语义 unique，不制造 graderVersion 来绕过它。

新请求的 quota、lane、158 task admission 在同一个 own `BEGIN IMMEDIATE` transaction：

1. 重验 enrollment、sealed bytes、batch/config 和 exact task/attempt 双 revision/live lease。
2. 检查未知/孤儿 ledger、跨 boot owner、既有 task unknown；必要时隔离，不放新请求。
3. 使用持久 Host clock 高水位检查滚动24h12次和本 batch3次；回拨不提前退额。
4. 写入不可退款 charge、唯一 task/attempt/invocation/request/payload pins 和 lane owner。
5. 更新158 admission，全部成功后才给 `mayDispatch=true`。

重放是历史 no-op 且 `mayDispatch=false`，不是第二个 fetch 权限；失败不留半个额度/准入。
BEGIN 失败不 rollback 调用者事务。既有158直接 admit/complete 不能绕过已登记 QA task 的新链路。
普通 Run semaphore、137 grade、已完成来源和旧 rule scheduler 不改变。

worker 的 QA candidate 由窄的 indexed Store 查询选择，先 JOIN enrollment 并筛选 owned batch/
config，再排序和 LIMIT；不能先取普通队列前100项后用 JavaScript 筛选，否则旧任务会使当前
batch永久饥饿。选择不授予执行权限，仍须原158 revision/claim CAS和159准入；普通executor
保留原来的limit1。回归覆盖100项以上普通/旧batch前缀，且只读取当前QA的五个固定artifact。

receipt、raw usage disposition、结果与158 terminal settlement 同事务；费用未测得是 unknown。
完整响应成功并且真实本地 callback drained 后才释放正常 lane。
abort、timeout、断网、解析失败、结果提交失败、崩溃及已准入未知保持 quarantine，
即使本地 callback 已 drain 也不证明远端已经停止；须 Host 显式核销并审计，仍不退款或自动重发。
私有 process boot epoch 用于保守恢复；跨 boot 不假装旧本地进程仍持有认证能力。

## Daemon：冻结请求与 Host transport 来源

初版采用 OpenAI-compatible `openai-completions` 的独立非流式 JSON 请求，不建立 AgentSession，
不启动工具、压缩或普通执行。不是所有 Provider/API 适配完成声明，不静默换模型/API。

preparation 持有封闭请求 handle。仅读取 enrollment 固定的 reviewed artifact 内容，包含完整
system/rubric/schema/protocol 开销；拒绝 accessor、custom prototype、未知字段和全树超预算。
所有异步准备后和准入/发送前检查取消。artifact、config 与 payload hash 都进入 admission pins。
公开 DTO 只有 digest/refs/预算，不含 materialized credential、header 或待发送正文。

批次激活由 async Host factory 显式首次 resolve有效Provider/auth tuple、创建新Core batch并mint私有
owned-batch handle；Host adapter仅接收原handle并只处理对应batchId，不能用旧batch DTO冒重新授权。
每次prepare开始及准入前再次resolve并比较实际apiKey、完整headers/authFlag与公开connection；
鉴权变化拒绝旧批次，不自动更换密钥继续发送。私有证明消失的重启不能silent rebind旧batch，
新显式激活创建新batch但同stable namespace/window额度继续保留，不重置已发生请求。
有效值仅在Host私有内存中保留，不持久化secret或secret-hash。外部env/Keychain只保证采样时
当前值相同，未观察到的A→B→A不保证历史；准入前异步采样后重验signal/scope/fence，发送前再验
owned generation/取消/current admission。这不是对外部凭据的持续锁定或防同用户Full Access能力。

D1 currentness builder同时绑定原始Provider的API providerId、baseUrl、api、model与configuration，
不能仅比较presetId/revision。避免为A地址生成的凭据证明守护实际B地址；不匹配在mint checker
之前拒绝，不创建batch、准入或发送HTTP。生产接线必须从同一originalProvider派生materialized tuple。
这是受信Host composition边界，不声称public connection检查能认证任意手工拼出的apiKey/headers；
checker本身仍是Host可信closure，不能开放给Renderer/Agent来提供，也不能让两个独立Provider拼接。

最后一次同步 generation/credential callback 必须先完成，再读取当前 Host clock 并重验 live
lease、request和lane，最后检查abort并执行唯一fetch。callback可能重入Store使lane quarantine
或推进时钟；不能使用callback之前的准入读回。回归要求这两种重入都产生0次HTTP请求。

最终 payload 从白名单重建，不允许 sampling 覆盖 output cap。能力分开：

- `max_tokens_non_reasoning`：已验证非 reasoning 模型的 visible output cap。
- `max_completion_tokens_total`：该 API 明确支持的 reasoning + visible completion 总 cap。

能力未知拒绝发送，不用 catalog 名字推断；真实请求还要核对 Provider 接受和原始 usage 语义。
wire parameter 是本地请求保证，不是对任意不可信远端实现的资源消耗证明。

transport 复用 Host materialized auth/header 与连接超时语义，但不复用可能自动重试的 Agent SDK。
一次私有 prepared handle 仅可有一次 POST/fetch attempt；禁止隐式 retry 和自动 redirect。
私有 WeakMap receipt 只能由这次 Host-owned transport 产生，JSON 中同名字段不授予认证。
完整响应有 byte/depth/node 上界；HTTP非成功、body partial、finish非stop、工具调用或输出不符合
grader schema 都不能成为完成事实。grader output 与真实 usage/transport facts 分开。
仅原始 usage 字段存在、有限、非负且自洽时计 measured tokens；SDK 缺值默认0不能变成真实0。
没有可信 provider pricing 则金额不填。取消必须关闭 owned body并等实际 callback drain，
不能通过 timeout 假装 idle、退额或关闭仍被 callback 使用的 Store。

取消与同步终态提交的胜负：发送前/准备期间取消不发送；准入后未确定结果取消记unknown。
当完整HTTP响应已验证并进入同一个同步 terminal transaction，事务内重入取消只标记/中止owned
controller，不嵌套另一 `BEGIN`；若原子提交成功，已确定completed事实胜过该重入取消并正常drain。
提交拒绝/抛错则退出settling区后记unknown/quarantine。此规则不扩展到异步prepare、尚未完整
收到响应或任何有副作用工具取消；测试必须触发真实Core事务内callback，不仅mock返回成功。

## 人工后续 vertical：Main intent → OS → Daemon 原子审计

不得直接复用 locked-control 的 `AsyncSingleFlight` 身份 verifier：不同 requestId/payload
会共享一次 native 成功。其 active Run/CU session 条件也不适用于 terminal evaluation。
旧 locked-control 继续 off，不为了评估开启锁屏电脑控制。

新增 focused Desktop human-evaluation IPC/coordinator/client，接入 preload/capabilities/Main composition。
主入口验证 exact owner webContents、mainFrame 和已知 app URL，不只比较 sender ID；
Renderer 只能提出单个 QA 的 adjudicate/correct/revoke，不能传 authenticated/adjudicator 或密钥。

Main 从 Host 读冻结事实、创建单个 intent：workspace/enrollment/evaluation/head revision、全部脱敏
pins、rubric、最终标签/severity/rationale、action、Desktop/Daemon epoch 和 expiry。
用原生独立确认界面显示这一个最终 payload，再要求 `deviceOwnerAuthentication`；
before/after 重验 session、lock/user/epoch、expiry、pins/head，任何变化 fail closed。
不同 payload 不合并、不共享成功；busy 拒绝或 exact 串行，取消/不可用/超时不回退成 token 认证。
helper 可复用底层 verifyIdentity/readSession，但要有实际 packaged helper 来源与可执行性验证，
不能只凭 absolute path 或现有源码认定已经 production 注入。

Daemon160独立 human intents/adjudication events sidecar：一次性 intent消费、head CAS、追加事件
和 durable audit 在同 own transaction；审计失败全部回滚，SSE只能 commit 后发。
纠正新增 supersedes，撤回新增 revoke，不覆盖旧 grade/原文；报告固定事件/链revision，
被纠正/撤回后显示 stale，不悄悄重写。重启/锁屏/用户切换/epoch rotation 使未消费 intent 失效。
只允许专用 Main Host ingress，不接普通 HTTP/Agent/MCP/Mobile/跨 workspace/批量授权。

transport token 只证明请求来自 Main，不证明人；本地显式反馈与真实 OS-confirmed provenance
分开。未完成整条认证/持久审计链前，不将反馈提升为已认证人工样本。

### 160 实施前的现有接线映射（历史只读核对）

- `apps/desktop/main/locked-computer-control/native-helper-bridge.ts`已有`readSession/verifyIdentity`；
  只能复用底层协议，现有absolute-path检查不是packaged来源证明，取消后还须等真实child close。
- `apps/desktop/scripts/native/locked-control-darwin.swift`已有`deviceOwnerAuthentication`，但现协议
  忽略requestId、只返回status，不能据此宣称确认了某个最终payload。新协议必须逐intent绑定。
- Main sender校验参考`theme-packages/theme-package-ipc.ts`的exact owner/mainFrame/URL，
  新入口另校验已知app URL；Daemon client复用私有bridge transport模式，不复用CU业务路由。
- 新增focused `main/human-evaluation/{ipc,coordinator,daemon-client}.ts`，接入Main composition、
  preload、shared IPC/capabilities；不向Renderer暴露`authenticated`、adjudicator或secret。
- 新helper需固定resources路径、真实build/packaging和可执行性验证。现helper只生成到
  `build/native/darwin-arm64`，并未进入package resources，不能借“源码已有”跳过打包。
- human authority独立于Computer Use gate/active Run/session；借用bridge epoch fencing原则，
  不依赖其CU authority tuple是否曾持久化。
- 160窄Store端口为create intent、commit confirmed intent、get head、bounded list events；
  create读回QA enrollment/pins/rubric/head，commit原子消费+headCAS+事件+审计。
  同事务审计复用`appendControlPlaneEventWithinTransaction`，SSE只在commit后publish。

该映射没有新用户政策待选。上述是160实施前的定位，不计入159已通过测试或源码manifest。

### 160 当前实现读回与返回权限

Main/native/private Daemon/Core intent→atomic audit完整内部链已实现；
实际范围、真实RED与最终收据见[160检查点](harness-human-evaluation-checkpoint-2026-10-10.md)。
仅已登记QA和Host审阅的脱敏pins；不采集日常会话或开放通用Agent/MCP/Mobile入口。

成功回复须在连接清理完成后再次检查Main generation/session/owner，并在IPC返回前复验exact
owner。锁屏或navigation不保证已进入服务端的事务回滚；已经COMMIT的事实保留，失效回复
不发成功/快照，提交处记submission_unknown并保留exact intent用于只读核对，绝不自动重发。
snapshot每页至多100event与实际最新headEvent，wire限4MiB（包含合法JSON最坏转义），
mutation保持65,536bytes。未知提交私有缓存至多32个；不向Renderer暴露intent authority/key。
报告ref固定task/event/revision，纠正撤回只改变currentness，不悄悄改写旧报告。

当前可见QA表单和独立human报告producer仍未接线；inspect current/stale不等于报告生成完成。
下一实施顺序为enrolled-only只读分页→专用Main列表/报告capability→设置QA panel/controller→
immutable report-only producer→真实macOS/人工OS/受预算模型验证。不把160event伪造为137grade，
不绕过source pins或提前加入promotion统计。

## 验证矩阵与实施顺序

1. 159 Core：临时真实 SQLite、two connections、reopen、批次/24h/午夜/回拨、config/key轮换、
   双worker竞态、replay/冲突、pins漂移、旧158绕过、BEGIN/marker/commit故障及无退款。
2. Daemon：真实 owned loopback HTTP、最终body/header/1024参数、单fetch/无redirect/无retry、
   boundedpartial/usage/finish/schema错误、pre/post admission abort、同步重入、unknown和真drain。
3. 联合：真实 Store + worker + coordinator + HTTP，enrollment→admission→receipt/result→drain；
   断网/崩溃cut与late response不变成第二任务/调用；ordinary source/grade/quota全部不变。
4. 新可达 leaves 进入 Office fixed authored inventory，验证源码 SHA 和 source-only build；
   不伪造正式 approval row 或把 synthetic native 当实际 native/GUI。
5. Core/Daemon build严格串行，focused Node22/24、必要联合回归、独立源码review、文档与scoped保存。
6. 完整人工160/Main/OS vertical及payload/correction/revoke/audit回归，然后真实OS确认。
7. 最后用新的 owned QA profile、冻结 Provider/model和真正额度约束做真实模型与macOS案例；
   不覆盖旧案例或日常数据，不靠fixture截图宣称实际客户端通过。

未答用户政策：本切片无。待实施核验：实际 Provider output能力/价源、packaged OS helper和真实
人工入口、正式Office source approval、Mobile native、macOS12类验收。H10根预算仍为独立未答选择，
本预算和D1 A都不能代答，dynamic children仍不启用。整体目标保持 active。
