# Office V2 原始 Host composition 与目录窗口

本切片建立 Core bridge 到 Daemon 原始私有 custody 的固定接线，
不发行 Core-safe receipt，不改变 native-only API 或生产 MCP 协议选择。
完整 actor manifest、Core close claim、独立 certificate、原子 pair 和 packaged 验收仍待完成。

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

已有与新 actor 的保守 domain 都检查两组链。编译 deny roots 同时包含 stage 与
destination；binding 期间、unknown 和 pending 状态拒绝新的 actor admission。
这里不扩展受控进程边界：Full Access 或其他不受限同 UID 进程仍不保证隔离。

## 关闭与后续结算

窗口关闭先进入不可逆 `close_entered`，再尝试关闭两组全部原始只读 FD。
所有 close 返回后才是 `closed_pending`；任意返回不明永久 `unknown`。
重复 close 不重试整数，不 reopen 路径；closed/pending 历史读取不执行 fstat/lstat。

资源关闭不释放 protection lease：Registry 的 stage map 保留 pending/unknown 成员，
普通 `closeStage` 不得删除 window-bound stage。没有 caller DTO/boolean 的 release API。
当前 Registry 原语尚未接入 Core settlement，不用于提前关闭生产窗口。

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

原始 actor source manifest 当前仍是空集合。因此固定 reader 的 genuine bind/window
正例、Registry pending 分支的完整 owning 运行、Core safe、生产 MCP 和 GUI 均未验收。
这些缺口必须在后续原始来源与 close-claim 接通时验证，不能用机制测试替代。

## 原始来源清单的下一接点

Docker 默认 backend 探测通过源模块唯一 `DOCKER_PROBE_ACTOR_ENTRY` 进入已捕获的
`execFileAsync`，保持原 argv、超时、输出预算与结果格式。私有一次性记录在 gate 前
消费，producer 再删除该记录；调用方 argv、clone 或 flags 不能发行原始记录。
真实 gate refusal 保留原 Error，不降成普通 Docker readiness diagnostic；真正探测
进程的普通失败仍使用原来的诊断。注入的 `commandRunner` 不获得默认源身份。

这补齐来源对象，不等于完成 manifest：还需固定导入全部 exact exports、处理
native/staging 初始化环，并在原始 Supervisor startup enroll 同一份清单。
不能重建 Core bridge 单例，不能清除先前 unbound native entry 的 sticky history。
这些接线与 owning window 正例完成前，不开放 Core-safe 或产品成功路径。
