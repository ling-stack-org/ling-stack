# Office V2 原始 Host composition 与目录窗口

本切片建立 Core bridge 到 Daemon 原始私有 custody 的固定接线。
Host composition 本身不发行 Core-safe receipt，不改变 native-only API 或生产 MCP 协议选择。
固定 actor manifest、默认 enrollment 与原始 Core close claim 已接线；独立 certificate / 原子
pair 的 Core 接点见文末。保护 lease 的固定释放接缝已实施；生产 MCP/Tracker 接线与 packaged 验收仍需完成。
源入口注册不是完整执行隔离证书。

## 固定来源与退休

`createOriginalOfficeDirectoryStoreFactory` 只接受原始、未退休的 Supervisor；
它自行构造 exact `SqliteRunStore`、私藏 channel setup，seal 后才返回 Store。
不接受 caller endpoint、provider、Store factory，也不 retrofit 普通注入 Store。

Core 捕获 actual Store constructor owner。Daemon 由自己的 WeakMap 查找 exact
composition、cached NativeRuntime 与 constructor-captured `#scopes` reader。
serialized scopeRef、相同字段、Proxy 或 public no-op 都不是权威。
可信 Host JS 的恶意自建孤立 channel 不属于该能力边界；隐藏 export 本身不作来源证明。

Supervisor 私有 lifecycle enrollment 只保留 Core 验过的 sealed setup / exact owner，
不接受可替换 callback。`releaseAll` 先令原 root inactive，再撤销全部 enrolled bridge，
最后关闭 native binary identity。关闭异常不能保留已绑定票据的 Core effect admission。
cache ownership 仍可用于原始资源 cleanup，不可用于恢复 forward admission。

## 窗口职责

共享 stage 与 destination 的原始只读链由两层负责：

- `protected-host-office-directory-window.ts`：完整原始 FD 链、dev/inode/mode
  与 first identity 校验、双组 one-close 和无 I/O 的历史 closure facts。
  本模块本身不提供 Registry/Run/Core 权威。
- Registry constructor 私藏的固定 reader：真实 inventory/source/history/backend
  校验、窗口成员关系、actor domain exclusion 和 protection lease。
  public inventory/stage 方法被替换不会影响此 reader。

destination 是普通 workspace 目录，可以是 workspace 本身；不套用 stage 的 0700 要求。
stage 与 destination 的完整祖先链分别对齐 owning Core row，各自持有原始 FD；
共享 pathname 不意味着共享 FD，关闭不可按路径去重。
目录 publication 可改变 size/timestamps，不能替换原 dev/inode/mode，
也不能用后来读到的 inode/mode 给最初 identity 补票。
准备快照到第一次原始 native fstat 之间也可能有无关目录增删；三处准入
（Daemon slot ledger、Core observation、Core replay）共享稳定目录身份比较，
只允许 size/mtime/ctime 差异，仍固定原 device/inode/mode/type。
第一次 fstat 的完整 identity 原样保留，后续历史副本必须精确一致；
文件 readback 的完整 before/after 身份校验不变。不能以串行测试规避此并发边界。

已有与新 actor 的保守 domain 都检查两组链。编译 deny roots 同时包含 stage 与
destination；binding 期间、unknown 和 pending 状态拒绝新的 actor admission。
这里不扩展受控进程边界：Full Access 或其他不受限同 UID 进程仍不保证隔离。

## 关闭与后续结算

窗口关闭先进入不可逆 `close_entered`，再尝试关闭两组全部原始只读 FD。
所有 close 返回后才是 `closed_pending`；任意返回不明永久 `unknown`。
重复 close 不重试整数，不 reopen 路径；closed/pending 历史读取不执行 fstat/lstat。

资源关闭不释放 protection lease：Registry 的 stage map 保留 pending/unknown 成员，
普通 `closeStage` 不得删除 window-bound stage。没有 caller DTO/boolean 的 release API。
Registry 的固定释放接缝仅消费原 Runtime 在 Core settlement 后同步发行的 opaque permit，
不能凭 Core 返回 DTO 或 window 字段提前关闭生产窗口。

失败 binding 的 destination 清理先进入 `cleanup_entered`，拒绝重入普通 stage close。
清理完成或返回不明后都保留保护成员；即使原 stage FD 已知关闭，也只进入
`closed_pending`，不能在缺少原始 invalid-cleanup claim 时隐式释放租约。
native-only 未进入 Office binding 的普通关闭语义保持不变。

window-bound 原始资源关闭只要求 exact 私有成员关系、epoch、bound 和 active lifetime。
run 终态、策略撤销或路径替换不会阻止这一次原始 FD 清理；它们仍会阻止后续
safe proof 与保护释放，不能借 cleanup 恢复前向授权。

后续必须严格串行接通：完整 child roster ready → Core latch parent/producer admission
→ 原始 Host readonly FD close、保护 lease 保留 → 同一 Core 事务 certificate / atomic pair
→ original committed pair read-back → genuine committed claim 释放 lease。
不能在 pending child 仍需 launch 时先 close，不能用 native-only graph 或 JSON receipt 替代 claim。

## 当前验证范围

新增机制测试使用真实临时目录、原始只读 FD 与 SQLite，覆盖身份变更、关闭返回丢失、
foreign FD reuse、public no-op、borrowed scope、root retirement 与 cleanup 异常。
native conformance 的负例使用显式本机构建 manifest 和真实 cached runtime，
不把 bootstrap fixture 的 inventory bypass 当成 genuine 正例。

固定 reader 现在保留 20 个源模块 exact export，默认 Supervisor enroll 同一份名单。
独立冷导入、counterfeit/clone、显式空/同名 fixture 与 sticky history 的测试只证明
来源与注册合同，不证明原 native profile、kernel 或所有 descendants 隔离。

`closeCoreWindow(scope)` / `readCoreWindowClosure(scope)` 是 constructor-bound 原始
runtime 接点，只有该 runtime 的私有 bound scope 可读取其 opaque window。
关闭前 latch，成功只到 `closed_pending`；读取已关闭 FD 的历史不重新 fstat/reopen，
不跑前向授权，也不发行 closeclaim、释放 Registry lease 或结算 Core。
native session 未结束时拒绝关闭窗口；撤销/root retirement 不阻止原始资源 cleanup。
原始 Store factory → Core row/ticket → 私有 scope/authority → Registry window 的
owning 正例已进入专属测试，连同 scope 伪造、关闭 reply-loss/reentry 和撤销路径。
它没有运行 OOXML/native writer graph，因此不是缺目录产品任务的成功证据。

Core safe、生产 MCP/Tracker、同一次真实 OOXML 和 GUI 仍未验收。
这些缺口必须在后续 close-claim、独立 certificate 和原子 pair 接通时验证，
不能用只读 owning 测试替代。

## Core close claim 的实施合同

原始 Core ticket / bound authority 经原 owning journal 进入关闭 gate，先在同一
SQLite 快照读取 raw 完整 descendant roster。producer 自身是待结算角色，不按 safe
child 校验，但其 descendants 仍必须遍历；其它 required child 的独立 safe 证据缺失
时不能封口或调用 Host。已进入 native 的执行还必须有完整原生关闭/terminal 事实。

ready 后先关闭原 realm 中 parent/producer 与所有 descendant 的新增 admission/effect
入口，再调用固定 Host 接点。该关闭不是 no-start、不改变既有 V1 cleanup 合同。
当前 close claim 是原始 owning Store 的 opaque 内存能力，不宣称已实现跨 Store 的
durable admission 封口；另一连接插入的 pending child 必须被后续原子 certificate /
pair 的 raw roster 重读拒绝，不能以旧 roster 或只有本地 latch 的事实放行 safe。

固定 composition 的三个同步 void 接点为 `assertBinding`、`closeBoundWindow`、
`assertClosedBoundWindow`。它们只消费私有 custody 和 owning Core execution；没有
caller closure DTO、FD integer、callback 注入或成功 boolean。
runtime 的 constructor-private reader 核验 exact bound scope/window、保留的 protection
lease、当前 source/policy/owner/backend/domain，以及原始 closed/returned 槽位。
pending 检查不 fstat/reopen 原窗口；域检查与 epoch 尾检不依赖公开可替换方法。

资源 phase 与证明资格分开：`proofAdmissionClosed` 在撤销/取消/原生结果不明/真正
source 或保护校验失败后永久关闭。cleanup 可以令资源变为 closed_pending，却不能
把已撤销的证明重新打开；关闭中 retirement 或失效也必须在端点返回后拒绝 claim。
已原始 closed_pending 的窗口可以一次核验认领，不重新物理 close；真正 unknown
close 不修复、不重试 FD。outer COMMIT 返回不明与 Host 已知关闭事实分别保留，
reconciliation 只能核验原 claim，不能重新关闭窗口或执行 native graph。

本合同已接通原始 Core/Daemon 链路，并有 owning-window 与故障回归；这不是
Core-safe receipt、证书、lease release 或 packaged 产品验收。后续独立 certificate
和原子 pair 仍必须完整实现，不能靠该 claim 替代。native/source 读取后的同步重入
必须重新核验 Registry、原始 identity lifetime、runtime snapshot 和 factory；
inspect 的原生调用异常也永久关闭证明资格，恢复来源不能复活旧证明。

## 原始来源清单的下一接点

Docker 默认 backend 探测通过源模块唯一 `DOCKER_PROBE_ACTOR_ENTRY` 进入已捕获的
`execFileAsync`，保持原 argv、超时、输出预算与结果格式。私有一次性记录在 gate 前
消费，producer 再删除该记录；调用方 argv、clone 或 flags 不能发行原始记录。
真实 gate refusal 保留原 Error，不降成普通 Docker readiness diagnostic；真正探测
进程的普通失败仍使用原来的诊断。注入的 `commandRunner` 不获得默认源身份。

固定 import 的 20 个 exact exports 在 reader 首读时缓存冻结，避免 native/staging
初始化环；原始 Supervisor startup 使用同一清单，显式 custom/empty 列表不自动升级。
两个 Core bridge 复用已安装 guard 的单例，不能在每次读取或 Supervisor 构造时重建。
先前 unbound native entry 的 sticky history 不因完整名单、重注册或 root retirement 清除。

## 多 Registry 的来源域与历史合同

默认全面 enrollment 会使同一个 source wrapper 附着于多个 Supervisor Registry。
actor 仍只属于自己的私有 Registry；其他 Registry 不获得其 Run/source、launch 或
安全结算权威，也不能直接把 foreign actor 当作自己 `#actors` 的成员来验证。

原始 native entry 必须先从固定私有 reader 取得当前 actor 的原始 launcher domain，
对所有 attached Registry 执行只读预检：identity/backend、有限 roots 预算、每个
active stage/destination 的 exclusion 与 pending/unknown lifetime。
所有预检允许后才传播进入事实；任一后置 Registry 拒绝不能污染前一 Registry。
真实 source 的 one-shot launch record 在预检前消费并校验 exact actor/prepared binding；
错误 prepared 不能先提交 owner domain 再由物理 producer 拒绝。

全局 source history 与各 Registry domain 分别保留私有 epoch。Store/原始 FS 的同步
重入若在预检期间提交了新域，外层旧快照在进入前拒绝；若发生在 commit preview，
写入前的 Registry epoch 校验保留内层新域，部分 fan-out 失败永久关闭 coverage。
不能只保护全局 aggregate 而允许某个 Registry 的旧域覆盖较新权限历史。

source 保留有限 backend/staticReadRoots aggregate，而不是每个命令一个永久 token 集。
后绑定 Registry 继承实际已进入的 aggregate domain 或 sticky unknown；不能通过
新 Supervisor 或弱引用 GC 清空全进程 source history。
unknown domain 只在无保护成员时允许 ordinary execution，随后关闭未来 Office admission；
有 active/pending/unknown member 时必须拒绝，不能给 actor 额外启动权限。

独立 native 场景使用独立进程避免有意 unknown-history 场景污染其他用例；
但真实跨 Registry 的归属与历史测试必须在同一进程完成，不能靠进程隔离掩盖回归。
本合同不扩大 Full Access/其他同 UID 程序的隔离承诺，也不提供 Core-safe。

专属跨 Registry 回归在每个场景内部使用同一进程的多个默认 Supervisor 与真实
Seatbelt launcher，覆盖两种构造顺序、后绑定、错误 prepared、两阶段重入及 sticky
unknown。场景之间隔离 source lifetime，不重置产品内部历史，不替换安全 gate。

## 独立 certificate 与原始 pair 的 Core 结算合同

本段描述 Core 结算接点，不代表生产 MCP、真实 OOXML 或 packaged 验收通过。
`settleHostOfficeLocalDirectoryExecutionV2(originalTicket)` 只消费原 Store 私藏的 V2
ticket、绑定 authority 和原 close claim；V1 结算入口不得采用这个 ticket。
prepared、terminal、完整 effect/observation 集、native replay 和 raw 全 descendant
roster 都在同一个 `BEGIN IMMEDIATE` 写事务中重新验证，不沿用关闭时的 roster 缓存。

独立 append-only certificate 表保留原 prepared request/policy digest、execution/source、
原 parent/producer domain identity、terminal/effect 集、完整 roster digest、replay 与首个
settledAt。这里保存的是原封存摘要，不宣称 Core 已独立还原或校验原 MCP 输入；真实请求
与 prepared 的对应仍由后续固定生产 route 负责。首次结算的 live owner/source/policy
当前性必须由原闭合窗口 reader 和 owning gate 验证。

constructor-private SQLite issuance latch 只允许写入本次已验证的 exact certificate。
裸 SQL INSERT、UPDATE、DELETE、OR REPLACE 不构成发行入口；另一个连接只能读历史，
不能认领原始内存 ticket。它不是防御同 UID 不受限程序或恶意可信 Host JS 的隔离措施。

certificate 插入、producer safe 和 parent safe 必须同事务提交。producer 先成为
candidate，parent 再成为 candidate，最终两角色独立复验后才能提交；任一步失败均回滚，
不能露出 half-safe 或把 callback 返回值当事实。泛用 safe 读取按 V2 协议分派到独立
certificate verifier，并继续递归校验 required children；不能退回 V1 receipt 校验。

原结算时间和 exact first certificate 意图跨 rollback/COMMIT 回包丢失保留。真正 rollback
后只允许重试同一意图；COMMIT 已成功但回包丢失时，原 ticket 只通过私有 SQL 回读认领
同一 certificate / 双 safe pair，不重新要求 Host 的当前资格、不关闭 FD、不执行 native。
half-safe、损坏的证据或不同意图必须拒绝，不能吞错后采用 caller DTO。

事务返回后，constructor-private reader 再以 committed snapshot 复验原 pair，才 mint 空冻结
`HostOfficeLocalDirectoryCommittedPairV2` handle。内部固定 subpath 提供
`readOriginalOfficeDirectoryCommittedPairV2` 与 `assertOriginalOfficeDirectoryCommittedPairV2`：
它们核 exact Store、opaque handle、same original close claim 和 execution/source/pair 身份，
直接读取私有数据库，不调用 public Store getter、不调用 Host 或原窗口 FD。
返回的 deep-frozen `{parent, producer}` 是事实 DTO，不是另一个授权能力；clone、foreign
Store/claim、相同字段或重开连接都不能重建原 grant。

供 lease consumer 使用的固定 `assertOriginalOfficeDirectoryCommittedPairAuthorityV2` 额外
比较原 Core authority 的对象 identity。grant 私藏的 authority 只能从原 ticket 的原 close
history 导出，不能由 caller 登记；same bridge 新 authority 或同字段 window 不匹配。
此 matcher 仍只读 Core committed 历史、不调用 Host/current/FD；Daemon 必须再从固定
composition 私有 map 找到对应的 same runtimeCustody，不能省略这一步。

Daemon 沿原 Runtime custody 验证首次 release 的持续 closed proof，再只解除 Registry
的 exact original lease。Core committed handle 本身不能直接删除 Registry member，也不能
关闭 Tracker barriers。释放后的重试只核 same member/handle/claim 的私有历史和 Core
committed 事实；不得把已删除成员伪装成仍持有原窗口。Tracker 的 V2 proof 仍待接线，
必须来自固定读回，不能由可替换 public getter、native-only flags 或工具文本制造。

## 原始 lease 的同步释放与历史幂等

固定入口为 `releaseOriginalOfficeDirectoryLeaseV2(originalAuthority, committedGrant, closeClaim)`。
composition 在原 authority mint 时私藏 authority → exact Store/runtime/runtimeCustody；
该 lookup **不导出**。公开 raw runtimeCustody 会使 caller 绕过 Core ready/roster gate，
提前调用原关闭接点，因而禁止用公开 reader 或 caller callback 暴露这个映射。

Runtime 先进入 constructor-private release gate，拒同步重入；再以 Core 固定 matcher 核
same original authority/grant/claim 和 private execution。首次释放继续核原 closed_pending /
all-returned 事实、current source/Supervisor/cache/factory/identity 和 sticky proof。
proof 失败保留保护成员，不能靠恢复来源把旧 proof 重新打开。

通过后，只在同一同步调用栈发行空冻结 opaque permit。Registry fixed reader 自查原
window/stage/registration/full execution，consumer 对照 Runtime 私有 permit，再做纯
member/epoch/coverage/closed-returned 尾检，精确删除一个成员并保存同 permit 私有历史。
尾部没有 native/current/FD I/O、listener、await、路径清理或 public no-op 方法。
原 window 仍保留 closed_pending 历史，但旧 live membership 断言在删除后必然失败。

permit 在 finally 失效，外部即使取得同对象也不能晚用或借给别的 Registry。实际删除和
私有 history 已完成但返回丢失时，Runtime 从固定 Registry 历史认领，而非重做 live proof。
同 authority/grant/claim 的历史重试仅 Core SQL readback + 双层私有历史；可以在 Host
退休后完成，不重关、重开或检查原窗口 FD，不恢复前向资格，不释放其他 member。

专属真实-addon fixture 使用默认 20-source startup、原 Store factory、真实 DOCX bytes、
原同步 effect gates、原 native packets/resource facts 和 terminal seal；有限 writer helper
只用于机制验收，不是生产 MCP route、SDK transport 或 packaged App 的替代证据。
生产 adapter 的 bound close 顺序、Tracker local barriers 以及完整 packaged 验收仍须完成。
