# Office local directory native v2：固定图与接线契约

日期：2026-10-05。

状态：**事实图和纯 replay 已实现并定向验证；生产接线、完整 canonical/settlement 与 packaged 验收未完成，不是安全凭证。** 本文基于当前 Core v1
binary facts / terminal / replay 与 frozen `native/office-local` protocol 2 的只读核对。
独立 Core v2 types/parsers、migration152、历史存储、Daemon facts/graph、typed runtime、
fixed adapter 和事实终态已落。native protocol 2不等于完整 Core binary protocol v2
安全能力；逐项证据见接续入口及本轮 checkpoint。

**2026-10-06 实际进度**：fixed adapter 和完整事实图 replay 已
接通，但只返回 `published_native_only / graph_verified_only / coreSafe:false`。
新增精确初始 mkdirat/exclusive-open 失败 guard 的 Core43/43、相邻 Core196/196 与
Daemon29/29、真实 addon adapter12/12 均通过；真实 nested DOCX/XLSX/PPTX、原
mkdirat EEXIST、cancel/COMMIT/ACK/安装后投影丢失已验。全 original launcher coverage、
live scope、absolute canonical/window、原 pair safe settlement、six routes 与 packaged
验收仍未闭环，不能由上述事实通过推导产品成功。证据见
`output/e6-20260928/OFFICE-CREATE-FAILURE-ACCEPTANCE-20261006.md`。

当前 native primitive 的 `scopeBinding=unbound`、`protectedStageVerified=false`、
`coreSafe=false`；本机构建证据不等于 packaged binary / 最终 app identity。当前受控
typed actor 的保护域仍未完成全 actor coverage，不能由某一条 denied actor 测试推断
所有受控入口都已隔离。真实 Full Access / manual external / 其他不受限同 UID actor 不在隔离承诺内；legacy/raw 是 transport，不自动取得这个豁免。
目前没有 native/Core 安全放行；本文的全 actor coverage 缺项是后续 bound issuer 接入
所必需的 gate，不是将本次尚未接入产品的切片标成产品 RED。

本文不授权更改 native freeze、放宽旧 verifier、改写历史 receipt、重试未知 native
效果、安装服务、调整 ACL/权限、或将新的 native API 直接暴露给不可信 caller。

## 1. 目标与明确不支持的范围

目标是给 **missing-subtree-no-replace** 分支建立完整的 Core / Host 闭环：在真实
受保护私域中创建整棵缺失目录 subtree、写入完整 OOXML、用原 FD 验证内容、一次
no-replace 安装到原 existing destination parent，最后核验 publication 可见性、全部
原资源 closure 与原 journal pair。

首个固定图仅支持：

- 一个完整的新建 OOXML 文件，输出大于 0 且不超过 50 MiB。
- 目标 absent，且目标父路径至少存在一层缺失目录。
- existing destination parent 之下的 first missing component 整体安装一次。
- 不覆盖、不 merge、不 copy、不使用普通 rename fallback。

例：`workspace/existing/new-a/new-b/report.docx` 中 `existing` 已存在、`new-a` 首先缺失，
则 destination parent 是 `existing`，安装名称是 `new-a`，私域 subtree 内部包含
`new-b/report.docx`。实际 staging top basename 可以不同于 canonical 的 `new-a`。

以下是独立分支，不由这个图顺带支持：

- existing parent 下仅新增一个 leaf 文件。
- overwrite、edit、recovery/backup。
- 任意目录树、任意 effect sequence、跨设备 copy 或 merge。
- Full Access actor 的同 UID 隔离。

不能只以 `input.state === "absent"` 选此分支。native `installTree` 当前安装的是
created-directory root，不是 existing parent 下的新 leaf 文件。旧 v1 的 existing-parent
链与历史验证应独立保留；不得把 genuine nested 正例改成预期 blocked 来宣称支持完成。

## 2. 已核实的 v1 阻断点

以下路径均相对仓库根目录，行号用于定位本次核对基线，后续应以函数名为准。

| 文件 / 函数 | 当前约束 | v2 不能省略的改变 |
| --- | --- | --- |
| `packages/core/src/host-office-local-types.ts` | schema1 / `ling-office-local-binary-v1`；mkdir 无 resource lifetime；NativeResult 无 success/errno | 独立 v2 discriminated types，不 cast v1 |
| `storage/sqlite/host-office-local-records.ts:120` / `validateOfficeLocalEffect` | exact effect keys；资源效果仅 temporary/recovery | capture、directory creator、原 read、tree install、batch close 专用 validator |
| `storage/sqlite/host-office-local-observations.ts:66` / `validateOfficeLocalObservationPayload` | first original fstat 的 observedAt 在 outer native returnedAt 之后 | 接纳真实 native 内部 monotonic 窗口，不用返回后 Date() 假造 first fstat 时间 |
| `storage/sqlite/host-office-local-terminal-payload.ts:70` / `validateOfficeLocalTerminalPayload` | 明确拒 directory resource | 包含两条祖先链、stage/destination parents、created directories/files 的完整 roster |
| `storage/sqlite/host-office-local-terminal-records.ts` / `validateOfficeLocalTerminalSeal` | open/close effect 与 v1 file/member roster 绑定 | 批量 capture/close 内部每一真实 syscall 的精确 callRef 与集合检查 |
| `storage/sqlite/host-office-local-replay.ts:47` / `assertWriterMembers` | 固定 tmp→link/rename→unlink 图；initial-absent directory 被拒 | 独立 directory/install replay，不放宽 v1 图 |
| `storage/sqlite/host-office-local-replay-resources.ts:56` / `OfficeReplayResources` | effect inode blanket uniqueness；read 用 path-reopen member_read roster | 区分 logical slot / physical lifetime / node；合法重复 existing ancestor inode；same-original-FD read 图 |
| `storage/sqlite/host-office-local-migration.ts` / terminal migration | SQL CHECK 仅 schema1/protocol-v1 | 新版本 append-only 存储与 dispatcher，不能只扩大 TS union |
| `packages/daemon/src/features/office-documents/office-local-writer.ts:259` / `nativeResult` | 任何正常 return 都转成简单 v1 result | 不得复用；native normal return 也可能 success=false |

表内 `storage/sqlite/` 路径均位于 `packages/core/src/` 下。

## 3. 最小固定图

每次 native API invocation 在一个真实同步 Core effect gate 中执行。一次 API 内部的
多个 syscall 是该 effect 的 **内部 call batch**，不是事后拼出的多个独立 admission。

| 顺序 | Core 图阶段 | 必须保留的实际事实 / 状态 |
| --- | --- | --- |
| 0 | 原 pair/source/permission/scope admission | 原 tracker/store/reservation/ticket/factory 与真实保护 scope；首次 native 进入前闭合绑定 |
| 1 | capture parents | `openSession` 的 stage、destination 两条完整 root→parent open/openat/fstat 链；每个 acquired lifetime |
| 2 | create missing directories | 每层一次 mkdirat→openat→first original fstat；父 lifetime、basename、creator effect/callRef |
| 3 | create final file | 原 parent FD 的 O_RDWR/O_CREAT/O_EXCL/O_NOFOLLOW/O_CLOEXEC open 与 first fstat；initial size=0 |
| 4 | bounded write | 原 FD 的连续 offset、请求量、实际返回量、有限 attempts；累计 output.sizeBytes |
| 5 | file fsync | 原 file lifetime 的实际 fsync return 0 |
| 6 | original FD readback | 50 MiB 上限、预算恰为 expected+1、实际 EOF、before/after full identity 与 Host 本次 bytes hash |
| 7 | original file close | 单次 explicit close return 0；close entry 前 tombstone；无整数重试 |
| 8 | bottom-up directory fsync | 所有 created directories 在最后一次修改之后 fsync，install 时仍 retained |
| 9 | install once | 原 stage parent / source basename → 原 destination parent / first missing name；一次 RENAME_EXCL |
| 10 | parent durability | 原 stage parent 与 destination parent 的 post-install fsync 实际 return 0 |
| 11 | canonical visibility | 下文第 6 节的充分证据，不能用 pre-install read 代替 |
| 12 | explicit close batch | 所有原 acquired lifetime 的完整、精确、实际 closure；未知状态保持 blocker |
| 13 | terminal / pair settlement | 完整 immutable terminal、原 live pair 原子 settlement、独立 public history verification |

图不含 link/unlink/rmdir/path cleanup。失败图只允许保留真实失败/partial facts，并释放
同一原 session 的 still-retained 资源。unknown、未获得 cap、残留或缺失原返回事实
不能通过 reopen/path observation 恢复执行或安全判定。

`openSession` 和 `closeSession` 当前 native `operationId` 为空，且包含多个 syscall。
adapter 必须用原 invocation envelope 将整个返回 batch 绑定到该 Core effect；不能
把 batch close 包装成一个 v1 file close，也不能假称每条内部 call 单独经过 Core gate。

## 4. v2 数据与资源契约

### 4.1 Prepared：逻辑图不是资源权限

建议新协议常量 `ling-office-local-binary-v2`，schemaVersion=2，固定 graph discriminator
例如 `missing_subtree_no_replace_v1`。这些名称是拟议契约，不是现有 API。

Prepared 至少固定：

- original source 五元组、executionId、parentOperationId、producerOperationId、toolCallId。
- workspace / 已存在 destination chain 的历史 identity，不能验证历史时再查今天磁盘。
- tool/format、requestDigest、policyDigest、output bytesSha256/sizeBytes。
- existing destination parent、first missing component、canonical directory/file member 链。
- 实际 stage root / top basename / relative creator chain 与 canonical path 的显式对应。
- 由真实 Host 原 scope 发行路径绑定的 scope 引用；仅 digest/serialized payload 不授予 live authority。

目标目录 members 与 namespace / ancestor resources 分开：祖先可能位于 workspace
之外，不能硬塞入 v1 的“所有 member 都 inside workspace”约束。

### 4.2 Logical slot、native lifetime、callRef 三层分开

native 真实 lifetime ID 在 capture/create 返回后才知道。因此：

1. prepared 使用预定的 `resourceSlotId` 表达逻辑图。
2. actual observation 记录真实 `nativeLifetimeId` 与 acquisition callRef。
3. adapter 私有 WeakMap 绑定 slot→原 opaque cap；后续 effect 精确引用已获得的 slot/lifetime。

不能由 caller 指定 native nonce/lifetime 来取得资源，不能从 sealed roster、matching
inode、数字 FD、结构 clone 或 persisted row 恢复 cap。

每个 resource 至少记录：kind、basename、parent lifetime、slot、native lifetime、
acquisition effect/callRef、first original identity/window、状态及对应原 explicit close。
状态保留 `not_acquired | retained | closed | unknown`。真实 fstat EBADF 所致 unknown
须与 close-entered unknown 分开表达，不能为它制造并未发生的 close effect。

两条祖先链可能以不同 lifetime 合法持有同一 existing inode，例如各自打开 `/`。
必须拒 duplicate lifetime / duplicate acquisition callRef，但不能 blanket 拒同 inode。
新 created nodes 的所有权检查与 existing ancestor alias 是不同规则；安装前后同一
created node 的 logical location 变化也不是新 lifetime。

### 4.3 Native invocation 与 syscall facts

外层 Host invocation 保存 wall-clock called/returned/completed 与原 Core effect/source
绑定；内部每条 call 保存 effectId、ordinal、native lifetime、parent lifetime、syscall、
actual return state/value、success、errno、native monotonic window，以及 I/O offset/request。

- outer `nativeOutcome=returned` 不代表 aggregate success。
- call success 仅表示 syscall 非负返回。例如 write return 0 不证明进度；fstat return 0
  也可能随后出现 size/node mismatch，aggregate packet 仍失败。
- 允许有限 EINTR/short-I/O call traces，但累计 bytes、offset、预算及最后结果必须一致。
- fstat/fsync/close/install 的失败 errno 不得抹除或转换成成功。
- `fsyncReturned`、`closed` snapshot 必须与具体原 trace 相符，不能单独授予安全。
- 非 read API 的 Result.calls 当前不是 Session 中可恢复的完整历史。marshalling
  异常后缺失原 trace 时只能表达 unknown，不能从 phase/synced 补造返回事实。

native monotonic 不是 epoch。v2 必须验证内部顺序，并将整个 batch 绑定到实际 Host
invocation；不能把 monotonic 数字转换成虚构 wall-clock，也不能用 N-API 返回之后
的 Date() 充当早已发生的 first fstat 观察窗口。

### 4.4 Readback 的内容证明

必须是同一 still-retained 原 created-file FD，发生于 file fsync 之后、原 close之前。
expected≤50 MiB、budget=expected+1；连续 bounded pread 后有真正一字节 EOF probe
且返回 0，before/after full identity 相等，节点仍匹配 acquired initial dev/inode/type。

Host 对该次实际返回 Buffer 计算 hash，并将 hash/bytes count 绑定到原 read effect、
expected output、native session/lifetime、完整 call roster。不接受 caller digest 自证。
read snapshot 不缓存/重发 payload，不恢复原票或重做 read/write。

file 必须有实际 explicit close return 0 才能进入 install。EBADF/unknown tombstone
保留为 blocker，不伪装为成功 close；析构永远不是 explicit close proof。

## 5. Host 保护与原 authority

adapter 应持一个不可替换的私有 frame：原 tracker/store/reservation/Office ticket、
original source/pair、原 registered factory、owned permission authority/signal、真实
protected scope、原 native session/caps。外部只可得到非权限性的历史事实。

每次 forward 的实际同步 callback 内重新检查 current source/fencing、owner、
permission、signal、factory 与保护 scope。cleanup 仅释放同一原 session 的原 retained
资源，不用当前继任 source、reopened store 或相同字段借权。

保护必须覆盖 stage root、每个可改名祖先、继承 FD/IPC/debug 等影响 namespace 的
边界，并持续覆盖所有依赖它的 native 创建、原节点观察及安装窗口。0700、nonce、
opaque cap、一次 fstat、manifest hash 均不能替代 kernel 隔离。

当前受控 typed actor coverage 尚未闭环。Host 必须根据实际发行/注册的执行入口给出
coverage roster 与证据，逐项核对那些入口及其继承/子进程路径；不能从一个示例 actor
或一个 helper 成功推断全域。本文不猜测尚未核实的具体入口已接通。

### 5.1 已核实的 all-actor coverage 接缝

- `packages/daemon/src/runtime/sandbox/platform-native.ts` 的
  `buildMacosSandboxProfile` 当前允许 `/tmp` 与 `/private/tmp` 的 file-write；不能把
  该旧通用 profile 与 Host staging 排除策略等同。
- 同文件的 readiness 使用配置 `policyVerified === true`，这不是原 issuer 观察到的
  kernel stage 保护事实；不能把该配置字段借给 v2 `protectedStageVerified`。
- `packages/daemon/src/features/runs/orchestrator.ts` 的
  `maybePreparePlatformNativeSandboxBinding` 检查 capability/readiness 后返回给 runner
  profile/manifest/sessionRef。该返回本身不证明 runner 的每个实际执行入口已采用保护。
- 当前 `packages/runner-pi/src` 的 sandbox 检索仅落在 `types.ts` 的绑定类型处；不能由
  runner label、capability 或类型存在宣称 Office stage 的实际 actor 覆盖已接通。
- 当前 `ProtectedHostStageRegistry` 接线位于固定 typed
  `NativeRestrictedCommandRuntime`；这不是所有 Ling 受控执行域的覆盖证明。

未来 bound issuer 必须由 Supervisor 持有全相关受控 actor 的真实覆盖关系与原发行
证据，或对未覆盖/未知 actor fail closed。stage注册成功、旧config policyVerified、
runner label与某个typed helper成功都不足以跳过这项gate。扩大实际接线前必须核对
所有相关actor是否能写stage或可改名祖先，以及继承资源/子进程是否沿用同一保护。

真实 Full Access / manual external / 其他不受限同 UID actor 始终明确排除；普通受控会话的
legacy/raw transport 仍属于受控入口，不能用启动方式代替持久化 Full Access 授权。
不得在 UI、文档或 receipt 中表述为隔离不受限进程。scope 证据必须绑定实际 backend/policy、原发行对象、
作用窗口、stage namespace 与最终 native/app identity，不接受 caller `verified:true`。

## 6. Publication canonical 可见性是独立门槛

当前原 FD readback 在 close/install 前，仅证明原 created inode 的内容。原 directory
fstat 仅证明所持节点，不能证明该节点仍位于 logical canonical workspace 路径。
同理 `installationEntered` 是原进入 latch，不是成功或 Host ACK。

canonical proof 必须有充分事实之一：

- 原 destination-parent-relative 的 post-install 只读 canonical chain/entry 观察，
  核对安装后的目录链与最终 file original node，并提供需要的完整 final read/identity
  窗口。新观察只用于验证，不提供 creator adoption、replay 或 cleanup authority。
- 实际连续保护 destination entry、全部可改名祖先及内容所需窗口，证明在原 parent
  的 kernel RENAME_EXCL 成功结果持续对应 canonical namespace；必须有真实 scope
  issuance/coverage/window 证据，而不是 adapter 填写的布尔值。

只保护 stage 不满足第二种形式；仅原 FD identity 相同、digest 相同或当前 canonical
文件“看起来正确”也不满足。实现须明确提供所采用形式的完整事实与反例测试；该项
尚未实现/发行时，Core 不得把 pre-install read 升格成 terminal canonical success。

once install 的 envelope 必须固定 source parent/lifetime/basename、destination
parent/lifetime/name、RENAME_EXCL flags 与 actual callRef。当前 native install trace
不单独输出完整 destination/name tuple，adapter 必须从原私有 invocation frame 记录
其真实参数绑定，不能事后从 logical target path 猜测。

## 7. Native outcome 与 Host ACK 分层

| 情况 | 保留的真相 | 允许 / 禁止 |
| --- | --- | --- |
| 正常 packet，success=false | native 已返回的实际失败、errno、partial facts | callback 正常返回并保留 facts，随后停止 forward、关闭原 retained 资源；不能默认成功或改为 native threw |
| native 返回后 SQL COMMIT ACK 丢失 | 原物理结果不被改写，Host 为 unconfirmed | 原 ticket 对同一 artifact/claim 做许可范围内的持久化 reconciliation；禁止重做 syscall |
| syscall/N-API reply异常，完整返回未知 | 真实进入 latch与尚存事实；缺项保持 unknown | 不从 inspect phase/synced 补造成功；不从 nonce/path 恢复 session/cap |
| close 已进入、返回失败或未知 | original slot unknown/-1，整数不再使用 | 不 retry/check/adopt后来复用该整数的 foreign FD |
| terminal/settlement ACK 未知 | immutable published/native facts与原 retained intent | 不把 published改failed来掩盖 ACK；不制造新 terminal或替换 claim |

原 Core `uncertainLaunch`、tracker unknown-outcome 禁止升级与双 role atomic settlement
规则应保留。读到 persisted rows 不意味着可以清掉未知 launch 或重获执行权。
原 pair同一 settlement intent的 reconciliation不等于 syscall retry。

no-start 不由 failed manifest、空 effects、success=false 或不存在日志推断。最小 v2
图将 capture作为真实 gated阶段；capture实际进入后不能按“没有写文件”冒称未启动。
若需要 readonly-capture 后的独立 closure/no-start 分支，应另行完整定义，不能借用
v1 member_read receipt或忽略祖先资源。

## 8. 版本化存储与最小模块路由

建议新增 v2 append-only execution/effect/terminal tables，保留 migration148/149 的
v1表、CHECK及历史语义。统一 reader根据实际 schema/protocol dispatch；execution ID
跨版本碰撞必须拒绝，原 pair不得在另一个版本再次绑定。只新增 union不解决 SQL
约束、FK、immutable triggers、domain identity与历史 reader的问题。

拟议模块边界：

1. **Core types**：新增 `packages/core/src/host-office-local-directory-v2-types.ts`，
   定义 prepared graph、slot/lifetime/call、scope、visibility、native与terminal unions。
   `index.ts`、`run-types.ts`、`storage/sqlite-run-store.ts` 只加薄接口/转发。
2. **Core persistence/validation**：新增 v2 migration、records、observations、terminal
   模块，exact keys与原 source/effect/immutable seal绑定；terminal重新比对完整 effects、
   内部calls与所有资源集合，不仅比较count。
3. **Core replay**：新增独立 `verifyOfficeLocalDirectoryReplayV2` 与资源状态机；
   `host-office-local-journal-evidence.ts` 的 `verifyHostOfficeReceipt` 按协议 dispatch。
   原 v1 `verifyOfficeLocalReplay` 与 `OfficeReplayResources` 不扩大为任意图执行器。
4. **Core original gate**：原 `HostOfficeLocalJournalGate` 的 owner/pair/atomic fan-in
   机制可复用，但类型、reader、domain digest、表查询与版本路由必须精确升级。
5. **Daemon adapter**：新增 `office-local-native-adapter.ts`，负责私有 frame/caps、
   固定 API调用、即时 raw packet latch、checked类型转换、失败停止及原 cleanup。
6. **Daemon preparation/terminal**：`office-local-authority.ts` 加显式v2 preparation
   分支及独立 terminal assembler；不改变旧 v1 member语义或复用 `nativeResult()`。
7. **Tracker**：`attempt-host-operation-tracker.ts` 加 typed v2路由，沿用原 source/
   owner/pair与同步 gate，不暴露可替换的 caller callback来绕过 fixed adapter。

原 identity中的size为number、native2的size/纳秒为decimal string。v2 parser须精确
验证范围与转换；不能静默Number大整数、删掉mode/type或伪造时间。大文件/非法identity
及不符合固定图的packet失败，不靠cast让编译通过。

## 9. 实施顺序与每步 exit gate

### A. 完成原 Host scope / actor coverage

先闭合实际 source/factory/scope issuance与受控actor矩阵，列明Full Access排除边界。
exit：原 live对象绑定、revocation/stale source、namespace祖先变化及逃逸边界有实际
证据；Supervisor持有全相关受控actor覆盖关系，或对未覆盖/未知actor fail closed；
typed actor覆盖域不再以局部例子、policyVerified配置或runner label推断。未完成时
native仍为unbound primitive，不发行Core安全放行。

### B. 定义 v2 schema 与 append-only persistence

先落实上述固定prepared图、slot/lifetime/call-batch、独立clock domain、return/ACK
unions及版本dispatch，再实现存储validator。
exit：非法/额外字段、跨版本ID/原pair复用、错误source/effect/hash、缺/额外call/resource
被拒；原v1历史verifier、旧receipt与迁移数据未改义。

### C. 接专用 fixed adapter，先只发行 facts

在原同步gate中调用native2，保留raw packet与实际cap关系，不借v1 writer路径读写。
exit：normal-return-false、first-fstat-before-NAPI-return、batchcapture/batchclose、
marshalling/COMMIT unknown、cancel/revocation及原resource closure可准确表达；不能重发。

### D. 实现固定 directory/install replay

逐slot消耗真实原事实，验证 creator chain、bounded write/read、explicitclose、目录与
parent fsync、一次no-replace provenance。
exit：完整missing-subtree正例通过；错parent/name/order/identity、EEXIST/EXDEV/ENOTSUP、
缺祖先/close、unknown、fake cap/packet不能赚取safe；无fallback或pathcleanup。

### E. 补 publication canonical proof 与原 terminal/pair

落实第6节的充分证明与真实保护窗口；terminal消耗完整原roster。再经原pair原子settle，
公开getter独立reverify。不得以raw native success或terminal文本代替safe receipt。
exit：stage-only保护不能伪通过canonical终态；leaf/ancestor ABA、protected-window gap、
lostACK、额外/未settled children及unknown不能被隐藏；原pair同intent持久化reconcile
不重做native效果。

### F. Packaged runtime 与完整产品验收

最后接显式build-time native资源、最终app/binary identity、目标arch与Electron N-API，
不runtime首次编译。验证完整产品nested写入与实际受控actor，保留fresh输入/输出证据。
exit：真实packaged能力、保护scope、Core graph与产品routing是同一实现；局部primitive
测试、本机Node build或unsigned输出不能替代这一门槛。

## 10. 必须保留的反例与最终 verdict

契约测试至少覆盖：returned success=false与errno；缺/额外ancestor/open/fsync/close；
同existing inode的合法不同lifetime；伪slot/cap/source/pair；read预算与真实EOF；
protected-window gap；install wrongparent/name；EEXIST等失败无fallback；原read不等于
canonical final；lostACK不重发syscall；unknown不能safe；v1历史与genuine nested正例
意图不被重写。具体fresh结果由各实现切片记录，本文不预先宣称这些测试通过。

最终完成条件是：受控actor范围与原Host authority → v2历史事实 → fixedgraph → canonical
visibility → 全部原closure → 原pair settlement → packaged产品能力完整闭合。

当前未完成实现前提为：真实Host coverage/window、publication absolute canonical
证明、原 pair safe settlement、生产接线与 packaged runtime。v2存储与clock/call绑定已有
独立定向证据，不再把它们重复列为未实现。剩余前提不是可省略的taste选择；任何一项延后，都必须保持该分支
未达产品safe，不发行完成声明。本文无需新增用户决策gate，也不授予跨出既定边界的权限。
