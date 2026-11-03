# A32：Recoverable Seedance 单次 poll operation deadline

状态：单次 deadline、本地 generation abort 与完整 Daemon bounded drain 已接通；
真实业务恢复反例已复现，正在验证修复。本文及定向测试均不是 packaged App 验收。

## 已确认根因

`pollSeedanceVideoTask` 原先未消费 `LiveMediaVendorTransportOptions.timeoutMs`，
GET 未传 signal。Daemon 的 guarded/native transport 会在完整响应 body 到 EOF 后才
交出 Response 与 completed exchange；低速、小体积、永不 EOF 的响应可一直占据实际 poll。
轮次上限和 response byte cap 都不是单次 operation 总期限。

Root 的 `a32-red-20261016.log` 首跑为 3 fail / 1 pass、actual exit 1：
deadline/shutdown/cancel 三个慢 body 例均未 settle，native settlement=0 且没有 signal；
完整 pending/terminal 响应正例通过。该结果不是所有请求必挂、远端取消失败或 OOM 的证明。

## 本次最小产品合同

1. Provider deadline 仅修改 recoverable `pollSeedanceVideoTask`；不重写 submit/collect/nonrecoverable execute。
2. namespace/handle 验证完成后，每次 poll 创建自己的 AbortController 与 timer。
   使用现有 `timeoutMs`，未配置时沿用 live media 默认 180 秒。
3. 将 signal 送入实际 GET。timer 从发请求前开始，覆盖 headers、成功 JSON、失败 body
   读取及 guarded/native 的完整 body EOF 生命周期，不在收到 headers 后提前清除。
4. timer 到期发出真实 abort；始终 await 原 HTTP/body Promise，不用 Promise.race
   冒充物理停止。所有退出路径在 finally 清 timer。
5. 每次 await 后检查本 controller 的 abort，避免遵循较弱 signal 合同的客户端晚返回
   pending/terminal JSON 时在已经超时后发出业务成功。若客户端完全忽略 abort 且不 settle，
   本函数仍保留未 settle，不伪造已经物理停止。
6. 仅本 timer 到期映射 `errorCode=timeout`，不把其他 transport/JSON 错误一律冒称本次期限。
   保持现有 secret redaction；超时固定安全文案，不提供 terminalObservation。
7. Registry 的 active writer 必须保持到原 native Promise/body 真实 settle。
   drain timeout 不改变 membership、writer、lease、receipt 或远端状态。

## 验证门槛

冻结测试：`packages/daemon/test/seedance-poll-operation-deadline.test.mjs`。

- 实际 native loopback HTTP 低速 whitespace body，不 EOF、累计远小于 byte cap。
- 验证实际 signal abort、原 native Promise reject/settle、真实 upstream body close
  均发生在 fixture cleanup 前；无 completed response/exchange 或 remote terminal 伪证。
- cancel/Registry局部shutdown仍同步发出local abort；完整Daemon shutdown按统一阶段执行：
  所有domain及ActiveRuns准入同栈关闭（此时active=1、后继poll/forward拒绝），随后真实
  abort阶段向原native sender发信号。信号必须先于物理settle/Store close，但不要求它在
  `daemon.stop()`返回Promise前发生；不能为了旧同栈断言跳过全域准入关闭阶段。
  只有原 operation/body 真正 settle 后才能 idle。
  忽略 signal 的真实 sender 另测有限 drain 拒绝，不能用调用 abort 代替 settlement。
- 正常完整 pending/terminal 不退化；后继跑现有 Seedance/transport/registry 邻近回归与类型构建。
- 测试观察使用有限 race 只用来报告未 settle，不能以观察 timer 获胜作为产品通过。

## 本地生命周期与业务恢复

- Registry 为每个 opaque generation 私有创建 AbortController。cancelJob、shutdown 与
  source obsolete 只停止本 generation，不影响其他 job 或新 generation；旧 handle 不能停止后继。
- guarded/native transport 将 Host signal 与原 Provider/调用方 signal 做 any 组合，
  不改变实际 public-HTTP pin 的原 input/init 绑定。Provider timer 与 Host abort 各保留独立事实。
- Registry active、reservation 与 completion 仍只随原 callback 和 cleanup settlement；
  发出 abort 本身不清 membership、不释放 writer/lease，不生成 remote terminal 或 no-start receipt。
- 真实 Daemon.stop 使用固定五秒 media drain；超时为 `media_local_drain_timeout`，details
  只含 activeExecutions、activeCallbacks、pendingReservations 整数计数，不含路径/原始异常。
  超时分支在 releaseAll/closeAll 前退出，准入保持关闭；原尾部真正结束后同 daemon 可以重试 stop。
  五秒仅限公开调用对media的观察，不是全部domain总关机期限；它与同一内部真实drain并行，
  不在晚于父执行器等待的settle阶段才启动。超时不写入内部永久failure、不取消/替换drain，
  EOF后原drain可以自然完成；retry复用原work。其他domain真实失败继续保留，先观察到的
  media超时不代表它是唯一故障。内部media barrier无timer，始终要求真实completion。
- Adapter 可能把原生 abort 翻译成 network_error/failed，这不是远端失败。guarded native
  仅在原 fetch/body 失败且 Host signal 已 abort 时，独立捕获 `media_local_aborted`。
  两执行器现有 captured-failure 检查必须拒绝 business terminalization，保原 durable handle、
  child Attempt 与 job 恢复状态；不得将本地 shutdown 投影为远端 failed/cancelled。
- 正常完整 EOF 不走该失败分支，已观察的真实 terminal 和 late genuine submit ACK 仍可落盘。
  ACK 后不得再次调度 poll；已经进入的真实 terminal/持久化尾部仍可合法完成。
  本次不修改 Core 的原生 receipt真实性或 remote-safe 判定；无法证明的远端结果保持 unknown。
- 非 captured manual job 需以 fresh Registry/Supervisor 重开原 SQLite 验证恢复，沿原 external
  operation ID 继续 observation/collect，不重复 submit。Captured 跨重启恢复仍遵守原 Host authority，
  不因 durable job 存在就制造新的 opaque capability。

模块边界：Provider 管单次 operation timer；Registry 管 generation lifetime 与 drain；native
transport 管原请求/body settlement；guarded transport 管 Host 失效事实传递；执行器负责持久化业务状态。
不新增表，不把这些状态机塞入 index.ts；生产组装只增加有限等待。

首个真实 Daemon.stop 回归为 1 pass/1 fail：不合作 sender 在 6.5 秒仍未 settle；
加有限等待后原 deadline4/local6/完整stop2 联合12/12，actual exit0。
业务恢复有效首跑两例均因真实状态错误写为 failed 而失败，actual exit1；原失败日志保留。
首轮测试 fixture 的 null child读取错误及其自有进程清理单列，不冒称为业务反例。
最终 producer restart、captured receipt、相邻回归和独立审阅尚待收口，不能以本组窄通过关闭总目标。

## 未决判定

本次 A32 内部链路没有新增用户决策。Seedance 没有经验证的 remote cancel 映射，不能承诺
远端已取消或不计费；未知响应保恢复/审计事实。真实 packaged macOS 与总验收仍单独完成。
