# A31：跨进程 Runtime singleton 所有权

状态：最终完整入口与相邻回归 42/42 实际通过；最终独立窄审无确认残留，approved=false。
后继 A32 修改 shutdown drain 需单独增量审阅；不是 Office/packaged App 或正式发布批准。
原始证据：`output/e6-20260928/a31-red-20261016.log`；新增 Registry 两项首跑 0 pass / 2 fail、
release 故障一项首跑 0 pass / 1 fail，分别见 `a31-registry-red-20261016.log` 与
`a31-release-red-20261016.log`，均 actual exit 1。不是对真实用户 Daemon 的双写断言。

## 确认根因

旧 RuntimeSupervisor 在读取 dead PID 后无条件 unlink runtime.lock，再 wx 创建。
真实 A/B 同读旧锁后，B 能删除 A 已发布的新锁，进入 reconcile 并影响 A 的真实 Attempt。
同 PID/host/port 的不同 Supervisor 也被误当相同 owner；reconcile 抛错时仅有 probe，
releaseAll 只清理已缓存 RuntimeInstance，导致锁泄漏。

独审进一步确认：RunStoreRegistry 在 Supervisor 准入前即执行 recoverStaleRuns 和
recoverStaleChannelWorkflows；合法第二 Daemon 仅构造就能改写第一 owner 的真实准备中 Step、
对应 lease 与非 Harness Run。另一次自身投影 unlink EACCES 后，旧实现虽抛错却仍释放 SQLite，
因此“清理已结束前不放开 owner”并未落实。

## 所有权原语

复用仓库已用于 migration / browser descriptor 的固定 SQLite sidecar 协调模式：

- 每个 workspace state root 使用固定 `runtime.lock.coordination.sqlite`，从不为恢复竞争删除它。
- 独立于业务 DB 的 `DatabaseSync` 连接持有 `BEGIN IMMEDIATE`，贯穿获得 owner、startup reconcile、
  Runtime 生命周期、诊断投影更新与最终清理。`busy_timeout=0`，竞争方明确 409，不无限等待。
- OS/SQLite 在进程崩溃关闭连接后释放事务。不能以 read-check-unlink 竞争实现 owner 接管。
  这是合法协作进程互斥，不承诺隔离任意不受控同 UID 程序 / Full Access。
- 每个 Supervisor 是独立 owner。PID/port 仅为诊断字段，不授权第二实例共享 lease。
- `runtime.lock` 降为诊断投影；只有仍持原连接的 owner 可以写与清理。
  读到仍活跃的旧投影不凭缺 sidecar lease 强行覆盖；只有 ESRCH 表示已退出，EPERM/未知不能视为 dead。
- 旧 owner release 必须在 metadata 清理结束后才释放 SQLite，重复 release 不影响后继 owner。
  没有 RuntimeInstance 的启动失败也要清理自己的 probe 与连接，不能清理他人投影。
- metadata 删除或归属核对失败时保留原 SQLite 写事务及 owner 对象，不 ROLLBACK/close；
  Supervisor 已退休，不允许继续执行，但同对象 releaseAll 可重试自己的精确投影清理。
  完全释放后不再读取或删除任何后继投影。
- reconcile 只能在实际取得 owner 后执行；失败不永久缓存 reconciled 状态。
  它不放宽每 Attempt 的 source fence 或独立工具的停止证明。
- RunStoreRegistry 的同步 beforeRecovery 入口先取得原 Supervisor runtime，再执行两种 Store
  recovery 与 initialized 回调；生产组装无论默认或注入 factory 均强制接线。注入 factory
  不因此取得原 Office custody，也不承诺约束不受控 factory 自身任意副作用。

## 模块与错误生命周期

新增小的 `runtime/workspace-runtime-owner.ts` 管 lease/诊断文件，Supervisor 只管应用生命周期。
acquire、publish、reconcile、release 任何阶段失败，保留原始错误和 cleanup 错误，
不将残余未知写成成功；只清本对象拥有的投影，不删除 sidecar。
新源码加入 Desktop 冻结输入清单并由后继 reviewer 审阅，不复用 Office approved。

未缓存 Store 的 ownership admission、两种同步 recovery 或 initialized 回调任一抛错，
Registry 移除该 Store 的精确缓存与已记忆 aliases，关闭本次 Store；关闭再失败时保留
AggregateError 的原始 cause 与 cleanup error，不 cache 或伪报已恢复。异步 initialized
后台任务仍沿原生命周期，不把同步初始化成功当其已全部完成。

准入前移可使 createDaemonServer 在构造期就以 409 拒绝同 workspace owner，不需要等 start。
这不证明构造期已建立的所有其他服务都已完整回滚；本次保证不在未持 owner 时执行 Registry
recovery，并关闭本次失败 Store。完整构造器资源回滚仍需独立核验，不以没有 HTTP listen
替代定时器/连接/其他资源证据。Office identity 关闭错误仍不是 native stage 或工具停止证明。

## 验证与未决事项

同 PID 隔离、两个真实进程在旧 read 后屏障交错、live owner 拒绝 contender、
release 与后继 acquire、SIGKILL 自有测试进程后接管、reconcile 失败清理均必须 GREEN。
新增默认/自定义 factory 的真实 Registry 准入、未缓存 Store close/retry、metadata unlink
故障后独立 SQLite writer 仍 BUSY、精确重试释放及旧 release 不碰后继三项均必须 GREEN。
继续原 runtime-supervisor / daemon startup cleanup 与恢复相关完整文件、类型检查、Desktop 输入测试。
不操作真实 Daemon，不起真实模型或 HTTP 服务；此处没有新增用户设计决策。
